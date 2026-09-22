// Knowledge and productivity builtin extension.
//
// Migrates code-indexed workflows into kernel extension form:
// - `/index refresh` / `/index search` slash commands
// - `index_refresh`, `index_search`, `index_rag_query` model tools
// - `/rag`, `/learn`, and `/self-correct` prompts
//
// This keeps indexing and retrieval as a first-class extension surface so
// users can toggle tools in `/extensions`, and future plugins can depend on
// these capability names without touching app.tsx.

import { readFileSync, statSync } from "node:fs";
import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import {
  SemanticCodeIndex,
  type SemanticRefreshProgress,
  semanticSettingsFrom,
} from "../../../code-index/semantic-index.js";
import type { SemanticSearchHit } from "../../../code-index/types.js";
import { processAtMentionsAsync } from "../../../utils/at-mentions.js";
import { FileIndex } from "../../../utils/file-index.js";

const DEFAULT_MATCH_LIMIT = 12;
const DEFAULT_RAG_FILE_LIMIT = 6;
const MAX_SNIPPET_BYTES = 8_192;
const MAX_SNIPPET_LINES = 220;

const manifest: PluginManifest = {
  id: "builtin.knowledge",
  name: "Knowledge, Indexing, and RAG",
  version: "1.0.0",
  description:
    "Slash commands and tools for workspace file indexing, local retrieval, and guided learning/self-correction prompts.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "tools", "settings", "mentions"],
};

const indexByCwd = new Map<string, FileIndex>();
const semanticIndexByCwd = new Map<string, SemanticCodeIndex>();

/**
 * @internal Test-only window onto the module-level index Maps so the
 * dispose-cycle test can assert they are cleared on disable. Not part of the
 * public extension surface.
 */
export function __knowledgeIndexSizesForTests(): { files: number; semantic: number } {
  return { files: indexByCwd.size, semantic: semanticIndexByCwd.size };
}

function getIndex(cwd: string): FileIndex {
  const existing = indexByCwd.get(cwd);
  if (!existing) {
    const created = new FileIndex(cwd);
    indexByCwd.set(cwd, created);
    return created;
  }
  existing.updateCwd(cwd);
  return existing;
}

function getSemanticIndex(cwd: string): SemanticCodeIndex {
  const existing = semanticIndexByCwd.get(cwd);
  if (existing) return existing;
  const created = new SemanticCodeIndex(cwd);
  semanticIndexByCwd.set(cwd, created);
  return created;
}

/**
 * Controllers for slash-command semantic refreshes in flight. Commands have no
 * turn-scoped signal, so Esc (`api.onUserInterrupt`) aborts these explicitly;
 * the `index_refresh` tool forwards the SDK's per-call `abortSignal` instead.
 */
const inFlightSemanticRefreshes = new Set<AbortController>();

function abortSemanticRefreshes(): void {
  for (const controller of inFlightSemanticRefreshes) controller.abort();
  inFlightSemanticRefreshes.clear();
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Numbered, capped preview of a file. Lines are accumulated until either the
 * line cap or the char budget is hit, so output is consistently numbered and
 * bounded regardless of file size.
 */
export function safeFileSnippet(filePath: string, maxChars = MAX_SNIPPET_BYTES): string | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const raw = readFileSync(filePath, "utf-8");
    const allLines = raw.split("\n");

    const numbered: string[] = [];
    let bodyChars = 0;
    for (let i = 0; i < allLines.length && numbered.length < MAX_SNIPPET_LINES; i++) {
      const line = `${String(i + 1).padStart(4, " ")} | ${allLines[i]}`;
      if (bodyChars + line.length + 1 > maxChars) {
        // Always show something: a first line longer than the whole budget
        // gets hard-sliced rather than producing an empty preview.
        if (numbered.length === 0) numbered.push(`${line.slice(0, maxChars)}…`);
        break;
      }
      numbered.push(line);
      bodyChars += line.length + 1;
    }

    const body = numbered.join("\n");
    const truncated = numbered.length < allLines.length;
    const header = `[${filePath}: first ${numbered.length} of ${allLines.length} lines, ${body.length} chars]`;
    const note = truncated
      ? `\n<!-- truncated: ${allLines.length - numbered.length} more lines (${MAX_SNIPPET_LINES}-line / ${Math.round(maxChars / 1024)}KB cap) -->`
      : "";

    return `${header}\n${body}${note}`;
  } catch {
    return null;
  }
}

function semanticHitSnippet(hit: SemanticSearchHit): string {
  const lines = hit.content.split("\n");
  const numbered = lines
    .map((line, index) => `${String(hit.metadata.startLine + index).padStart(4, " ")} | ${line}`)
    .join("\n");
  return [
    `[${hit.filePath}:${hit.metadata.startLine}-${hit.metadata.endLine}, ${hit.backendId}/${hit.modelId}, ${(hit.similarity * 100).toFixed(0)}%]`,
    numbered,
  ].join("\n");
}

async function buildRagContext(
  index: FileIndex,
  query: string,
  maxFiles: number,
  maxCharsPerFile: number,
): Promise<{
  files: string[];
  context: string;
}> {
  // Prose queries (e.g. "how is authentication initialized?") will never
  // appear verbatim in a file path, so plain substring matching returns
  // nothing. Token-aware match splits the query into content words and
  // unions per-token hits.
  const files = await index.matchTokens(query, maxFiles);
  const chunks: string[] = [];
  const used: string[] = [];

  for (const relPath of files) {
    const absPath = index.resolvePath(relPath);
    const snippet = safeFileSnippet(absPath, maxCharsPerFile);
    if (!snippet) continue;
    used.push(relPath);
    chunks.push(`\n## ${relPath}\n${snippet}`);
  }

  return {
    files: used,
    context: chunks.join("\n"),
  };
}

async function buildHybridRagContext(
  index: FileIndex,
  semanticIndex: SemanticCodeIndex,
  settingsGet: <T = unknown>(key: string, fallback?: T) => T | undefined,
  query: string,
  maxFiles: number,
  maxCharsPerFile: number,
): Promise<{ files: string[]; context: string; semanticCount: number }> {
  const semanticSettings = semanticSettingsFrom(settingsGet);
  const semanticHits = await semanticIndex.search(semanticSettings, query, maxFiles).catch(() => []);
  const chunks: string[] = [];
  const used = new Set<string>();

  for (const hit of semanticHits) {
    used.add(hit.filePath);
    chunks.push(`\n## ${hit.filePath}\n${semanticHitSnippet(hit)}`);
  }

  const fallback = await buildRagContext(index, query, maxFiles, maxCharsPerFile);
  for (const relPath of fallback.files) {
    if (used.has(relPath)) continue;
    used.add(relPath);
    const absPath = index.resolvePath(relPath);
    const snippet = safeFileSnippet(absPath, maxCharsPerFile);
    if (snippet) chunks.push(`\n## ${relPath}\n${snippet}`);
    if (used.size >= maxFiles) break;
  }

  return {
    files: [...used],
    context: chunks.join("\n"),
    semanticCount: semanticHits.length,
  };
}

function indexStatusLine(cwd: string, size: number): string {
  return `Workspace index (${cwd}): ${size} files indexed.`;
}

function formatMatchList(files: string[]): string {
  if (files.length === 0) return "No matches.";
  return files.map((file, index) => `${index + 1}. ${file}`).join("\n");
}

function parseIndexArgs(args: string): { mode: string; rest: string } {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s+/);
  if (firstSpace === -1) return { mode: trimmed.toLowerCase(), rest: "" };

  return {
    mode: trimmed.slice(0, firstSpace).toLowerCase(),
    rest: trimmed.slice(firstSpace + 1).trimStart(),
  };
}

/**
 * Throttled progress reporter for semantic refresh. Posts at most one chat
 * message every `intervalMs` (default 2s) so a long refresh shows liveness
 * without spamming the transcript with 384 bubbles.
 */
function makeRefreshReporter(
  appendAssistant: (message: string) => void,
  intervalMs = 2_000,
): { onProgress: (event: SemanticRefreshProgress) => void; finalize: () => void } {
  let lastEmit = 0;
  let lastLine: string | null = null;
  function emit(force: boolean, line: string): void {
    const now = Date.now();
    if (!force && now - lastEmit < intervalMs) return;
    if (line === lastLine && !force) return;
    lastEmit = now;
    lastLine = line;
    appendAssistant(line);
  }
  return {
    onProgress: (event) => {
      switch (event.phase) {
        case "start":
          emit(true, `Indexing ${event.totalFiles ?? 0} files via ${event.backendId}/${event.modelId}…`);
          break;
        case "file": {
          const i = event.fileIndex ?? 0;
          const total = event.totalFiles ?? 0;
          const pct = total > 0 ? Math.floor((i / total) * 100) : 0;
          emit(
            false,
            `  [${event.backendId}] ${pct}% (${i}/${total}) ${event.filePath ?? ""} — ${event.chunksIndexed ?? 0} chunks`,
          );
          break;
        }
        case "backend-done":
          emit(
            true,
            `Indexed ${event.filesIndexed ?? 0} files / ${event.chunksIndexed ?? 0} chunks via ${event.backendId}/${event.modelId}.`,
          );
          break;
        // skip / delete / done are intentionally silent — captured by the
        // final summary so they don't crowd the transcript.
      }
    },
    finalize: () => {
      lastLine = null;
      lastEmit = 0;
    },
  };
}

function formatSemanticStatus(
  lines: Array<{
    backendId: string;
    modelId: string;
    totalFiles: number;
    totalChunks: number;
    ready: boolean;
    error?: string;
  }>,
): string {
  if (lines.length === 0) return "Semantic index: no active embedding backends.";
  return [
    "Semantic index:",
    ...lines.map((line) => {
      const state = line.error ? `error: ${line.error}` : line.ready ? "ready" : "empty";
      return `- ${line.backendId}/${line.modelId}: ${state}, ${line.totalFiles} files, ${line.totalChunks} chunks`;
    }),
  ].join("\n");
}

export const knowledgePlugin: CodesurfPlugin = {
  name: "codesurf-knowledge",
  manifest,
  inject: ["contributions", "tools", "settings", "chat", "workspace", "lifecycle"],
  apply(ctx: PluginContext) {
    // Cordis services are CLASSES, so a method plucked off `ctx` and passed as
    // a bare function reference loses its receiver and throws on the first
    // `this` read. V1's services were object literals and tolerated it. Wrap
    // the two that travel into helpers rather than passing them naked.
    const settingsGet = <T = unknown>(key: string, fallback?: T): T | undefined => ctx.settings.get<T>(key, fallback);
    const appendAssistant = (text: string): void => ctx.chat.appendAssistant(text);

    // Esc during `/index refresh` cancels the semantic refresh instead of
    // letting it keep embedding after the user stopped the turn.
    ctx.effect(() => ctx.lifecycle.onUserInterrupt(abortSemanticRefreshes));
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "knowledge.semantic.enabled",
        title: "Semantic index enabled",
        description: "Enable content-based semantic retrieval for /rag and index_rag_query.",
        type: "boolean",
        default: true,
        section: "Knowledge",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "knowledge.semantic.backend",
        title: "Semantic embedding backend",
        description: "Auto uses local embeddings and OpenAI when configured; off preserves path-token retrieval only.",
        type: "select",
        default: "auto",
        section: "Knowledge",
        options: [
          { value: "auto", label: "Auto hybrid" },
          { value: "local", label: "Local only" },
          { value: "openai", label: "OpenAI only" },
          { value: "off", label: "Off" },
        ],
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "knowledge.semantic.localModel",
        title: "Local embedding model",
        type: "string",
        default: "Xenova/all-MiniLM-L6-v2",
        section: "Knowledge",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "knowledge.semantic.openaiModel",
        title: "OpenAI embedding model",
        type: "string",
        default: "text-embedding-3-small",
        section: "Knowledge",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "knowledge.openai.apiKey",
        title: "OpenAI embeddings API key",
        description:
          "Optional. OPENAI_API_KEY environment variable takes precedence. For local Ollama/LM Studio, any non-empty value works (e.g. 'ollama').",
        type: "secret",
        default: "",
        section: "Knowledge",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "knowledge.semantic.openaiBaseUrl",
        title: "OpenAI-compatible embeddings base URL",
        description:
          "Optional. Defaults to https://api.openai.com/v1. Point at http://localhost:11434/v1 for Ollama or http://localhost:1234/v1 for LM Studio. OPENAI_BASE_URL env var takes precedence.",
        type: "string",
        default: "",
        section: "Knowledge",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerMentionProvider({
        match: (query, maxResults) => getIndex(ctx.workspace.cwd()).match(query, maxResults),
        resolvePath: (relativePath) => getIndex(ctx.workspace.cwd()).resolvePath(relativePath),
        expand: (text, cwd) => processAtMentionsAsync(text, cwd),
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerTool({
        name: "index_refresh",
        description: "Refresh the local code index used by knowledge commands.",
        group: "knowledge",
        tool: tool({
          description: "Rebuilds the workspace-level code index for local retrieval commands.",
          inputSchema: z.object({}),
          execute: async (_input, options) => {
            const cwd = ctx.workspace.cwd();
            const index = getIndex(cwd);
            await index.refresh();
            const semantic = getSemanticIndex(cwd);
            const reporter = makeRefreshReporter(appendAssistant);
            const semanticResult = await semantic.refresh(index, semanticSettingsFrom(settingsGet), {
              onProgress: reporter.onProgress,
              signal: options?.abortSignal,
            });
            return {
              success: true,
              output: [
                indexStatusLine(cwd, index.size),
                `Semantic refresh: ${semanticResult.filesIndexed} files, ${semanticResult.chunksIndexed} chunks indexed.`,
                formatSemanticStatus(semanticResult.backends),
              ].join("\n"),
            };
          },
        }),
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerTool({
        name: "index_search",
        description: "Search the workspace index for likely file paths.",
        group: "knowledge",
        tool: tool({
          description: "Given a query, returns likely matching file paths from the current workspace file index.",
          inputSchema: z.object({
            query: z.string().describe("Search query (filename/path fragment, plain text is fine)."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(50)
              .default(DEFAULT_MATCH_LIMIT)
              .describe("Number of matches to return (1..50)."),
          }),
          execute: async ({ query, limit }) => {
            const cwd = ctx.workspace.cwd();
            const index = getIndex(cwd);
            const matches = await index.match(query, clamp(limit, DEFAULT_MATCH_LIMIT, 1, 50));
            const semanticMatches = await getSemanticIndex(cwd)
              .search(semanticSettingsFrom(settingsGet), query, clamp(limit, DEFAULT_MATCH_LIMIT, 1, 50))
              .catch(() => []);
            return {
              success: true,
              output: [
                `Index hits (${matches.length}) for ${JSON.stringify(query)} in ${cwd}:`,
                formatMatchList(matches),
                "",
                `Semantic hits (${semanticMatches.length}):`,
                semanticMatches.length === 0
                  ? "No semantic matches."
                  : semanticMatches
                      .map(
                        (hit, i) =>
                          `${i + 1}. ${hit.filePath}:${hit.metadata.startLine} (${hit.backendId}, ${(hit.similarity * 100).toFixed(0)}%)`,
                      )
                      .join("\n"),
              ].join("\n"),
            };
          },
        }),
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerTool({
        name: "index_rag_query",
        description: "Build a short local retrieval payload from indexed files.",
        group: "knowledge",
        tool: tool({
          description:
            "Collects matching indexed files and returns a compact context bundle for retrieval-augmented workflows.",
          inputSchema: z.object({
            query: z.string().describe("What to retrieve from the workspace index."),
            fileLimit: z
              .number()
              .int()
              .min(1)
              .max(24)
              .default(DEFAULT_RAG_FILE_LIMIT)
              .describe("Max number of files to include in the context payload."),
            charsPerFile: z
              .number()
              .int()
              .min(1_024)
              .max(32_768)
              .default(4_096)
              .describe("Per-file snippet cap in bytes."),
          }),
          execute: async ({ query, fileLimit, charsPerFile }) => {
            const cwd = ctx.workspace.cwd();
            const index = getIndex(cwd);
            await index.refresh();
            const result = await buildHybridRagContext(
              index,
              getSemanticIndex(cwd),
              settingsGet,
              query,
              clamp(fileLimit, DEFAULT_RAG_FILE_LIMIT, 1, 24),
              clamp(charsPerFile, 4_096, 1_024, 32_768),
            );
            if (result.files.length === 0) {
              return {
                success: false,
                error: `No indexed files matched ${JSON.stringify(query)} in ${cwd}.`,
              };
            }

            return {
              success: true,
              output: [
                `RAG context for query: ${JSON.stringify(query)}`,
                `Matched files (${result.files.length}):`,
                formatMatchList(result.files),
                `Semantic chunks: ${result.semanticCount}`,
                "",
                result.context || "",
              ].join("\n"),
            };
          },
        }),
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/index",
        description: "Refresh/search the local file index, or show status.",
        argsHint: "refresh | search <query> | status",
        handler: async ({ args }) => {
          const cwd = ctx.workspace.cwd();
          const index = getIndex(cwd);
          const { mode, rest } = parseIndexArgs(args);

          if (!mode || mode === "status") {
            await index.refresh();
            const semanticStatus = await getSemanticIndex(cwd).status(semanticSettingsFrom(settingsGet));
            ctx.chat.appendAssistant(
              [indexStatusLine(cwd, index.size), formatSemanticStatus(semanticStatus)].join("\n"),
            );
            return;
          }

          if (mode === "refresh") {
            await index.refresh();
            const reporter = makeRefreshReporter(appendAssistant);
            const controller = new AbortController();
            inFlightSemanticRefreshes.add(controller);
            try {
              const semanticResult = await getSemanticIndex(cwd).refresh(index, semanticSettingsFrom(settingsGet), {
                onProgress: reporter.onProgress,
                signal: controller.signal,
              });
              ctx.chat.appendAssistant(
                [
                  `Refreshed code index. ${index.size} files indexed for ${cwd}.`,
                  `Semantic refresh: ${semanticResult.filesIndexed} files, ${semanticResult.chunksIndexed} chunks indexed.`,
                  formatSemanticStatus(semanticResult.backends),
                ].join("\n"),
              );
            } finally {
              inFlightSemanticRefreshes.delete(controller);
            }
            return;
          }

          if (mode === "semantic") {
            const semantic = getSemanticIndex(cwd);
            const [submode] = rest.split(/\s+/, 1);
            if (!submode || submode === "status") {
              ctx.chat.appendAssistant(formatSemanticStatus(await semantic.status(semanticSettingsFrom(settingsGet))));
              return;
            }
            if (submode === "refresh") {
              await index.refresh();
              const reporter = makeRefreshReporter(appendAssistant);
              const controller = new AbortController();
              inFlightSemanticRefreshes.add(controller);
              try {
                const result = await semantic.refresh(index, semanticSettingsFrom(settingsGet), {
                  onProgress: reporter.onProgress,
                  signal: controller.signal,
                });
                ctx.chat.appendAssistant(
                  [
                    `Semantic refresh: ${result.filesIndexed} files, ${result.chunksIndexed} chunks indexed.`,
                    formatSemanticStatus(result.backends),
                  ].join("\n"),
                );
              } finally {
                inFlightSemanticRefreshes.delete(controller);
              }
              return;
            }
            if (submode === "clear") {
              semantic.clear();
              ctx.chat.appendAssistant("Cleared semantic index cache for this workspace.");
              return;
            }
            ctx.chat.appendAssistant("Usage: /index semantic [status|refresh|clear]");
            return;
          }

          if (mode === "search" || mode === "find") {
            if (!rest) {
              ctx.chat.appendAssistant("Usage: /index search <query>");
              return;
            }
            const matches = await index.match(rest, DEFAULT_MATCH_LIMIT);
            const semanticMatches = await getSemanticIndex(cwd)
              .search(semanticSettingsFrom(settingsGet), rest, DEFAULT_MATCH_LIMIT)
              .catch(() => []);
            ctx.chat.appendAssistant(
              [
                `Index hits for ${JSON.stringify(rest)}:`,
                formatMatchList(matches),
                "",
                `Semantic hits (${semanticMatches.length}):`,
                semanticMatches.length === 0
                  ? "No semantic matches."
                  : semanticMatches
                      .map(
                        (hit, i) =>
                          `${i + 1}. ${hit.filePath}:${hit.metadata.startLine} (${hit.backendId}, ${(hit.similarity * 100).toFixed(0)}%)`,
                      )
                      .join("\n"),
                matches.length === 0 ? "No matching files in the current index." : "",
              ].join("\n"),
            );
            return;
          }

          ctx.chat.appendAssistant("Usage: /index [status|refresh|search|find|semantic] [query]");
        },
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/rag",
        description: "Ask a retrieval-assisted workspace question from the local code index.",
        argsHint: "<question>",
        handler: async ({ args }) => {
          const question = args.trim();
          if (!question) {
            ctx.chat.appendAssistant("Usage: /rag <question>  (example: /rag how is authentication initialized?)");
            return;
          }

          const cwd = ctx.workspace.cwd();
          const index = getIndex(cwd);
          // Force a refresh so a cold /rag doesn't silently match against an
          // empty file list. ensureFresh's TTL means subsequent calls within
          // 30s are still cheap.
          await index.refresh();
          if (index.size === 0) {
            ctx.chat.appendAssistant(
              `Workspace index is empty for ${cwd}. Try \`/index refresh\` or run \`/rag\` from a git checkout.`,
            );
            return;
          }
          const result = await buildHybridRagContext(
            index,
            getSemanticIndex(cwd),
            settingsGet,
            question,
            DEFAULT_RAG_FILE_LIMIT,
            6_000,
          );
          if (result.files.length === 0) {
            ctx.chat.appendAssistant(
              [
                `No indexed files matched: ${question}`,
                `Workspace: ${cwd} (${index.size} files indexed).`,
                "Try a more specific query that includes a likely filename or symbol fragment.",
              ].join("\n"),
            );
            return;
          }

          ctx.chat.dispatch(
            [
              "Use only the indexed workspace context below and answer the user question.",
              "If the context is insufficient, call out missing evidence and ask for files or commands to inspect.",
              "",
              `Workspace: ${cwd}`,
              `Files: ${result.files.join(", ")}`,
              "",
              result.context,
              "",
              `Question: ${question}`,
            ].join("\n"),
            { displayText: `/rag ${question}` },
          );
        },
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/learn",
        description: "Start a repository learning/reflection pass in-chat.",
        argsHint: "[topic]",
        handler: ({ args }) => {
          const topic = args.trim();
          const scope = topic
            ? `Focus this learning pass on: ${topic}.`
            : "Focus on recurring patterns in this repository.";
          ctx.chat.dispatch(
            [
              "Run a structured learning pass and report concise insights for future reuse.",
              scope,
              "- infer core architecture patterns",
              "- note naming/structure conventions that should be preserved",
              "- identify at least one anti-pattern and its safer alternative",
              "- propose one targeted improvement from the current work.",
              "- do not propose long tutorials.",
            ].join("\n"),
          );
        },
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/self-correct",
        description: "Open a self-correction prompt for a proposed answer or plan.",
        argsHint: "<text>",
        handler: ({ args }) => {
          const text = args.trim();
          if (!text) {
            ctx.chat.appendAssistant("Usage: /self-correct <text>\nExample: /self-correct The model should always... ");
            return;
          }
          ctx.chat.dispatch(
            [
              "Self-correct this proposed output as rigorously as possible.",
              "Identify any factual mistakes, missing assumptions, unsafe commands, and ambiguity.",
              "Then provide:",
              "1) a list of issues (if any), 2) a corrected version, 3) a final confidence score 0-10.",
              "",
              `Proposed text:\n${text}`,
            ].join("\n"),
          );
        },
      }),
    );

    // ── Event subscriptions ─────────────────────────────────────────────
    // SessionStart: warm the FileIndex for the active cwd so the first
    // /index search call doesn't pay the construction cost mid-turn.
    // SessionEnd: dispose semantic indices to release memory; the file-
    // index Map is small enough to keep around for re-entry.
    const disposeSessionStart = ctx.hostEvents.subscribe("SessionStart", () => {
      const cwd = ctx.workspace.cwd();
      try {
        getIndex(cwd);
      } catch {
        // Index warm-up is best-effort; never fail the agent boot for it.
      }
    });
    const disposeSessionEnd = ctx.hostEvents.subscribe("SessionEnd", () => {
      for (const idx of semanticIndexByCwd.values()) {
        try {
          (idx as unknown as { close?: () => void }).close?.();
        } catch {
          // Ignore individual close failures — process exit will clean up.
        }
      }
      semanticIndexByCwd.clear();
    });
    ctx.effect(() => disposeSessionStart);
    ctx.effect(() => disposeSessionEnd);

    // ── Memory hygiene ──────────────────────────────────────────────────
    // The module-level Maps survive extension disable cycles. Clear them
    // on dispose so a re-enable starts clean and tests don't leak state.
    ctx.effect(() => () => {
      indexByCwd.clear();
      semanticIndexByCwd.clear();
    });
  },
};
