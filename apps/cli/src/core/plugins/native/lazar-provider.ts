// Builtin Lazar provider.
//
// Wraps the local `lazar` Rust binary (https://github.com/jkneen/lazar) as a
// model provider. Lazar is a self-evolving agent harness with a single tool
// (`execute(command)` → bash) and skills-as-filesystem-entries. It owns its
// own tool runtime, so this provider does NOT forward host tools to it.
//
// Connection model:
//   - Per-turn subprocess. Each `sendTurn` spawns
//     `lazar -p <prompt> --session <id> --output-format stream-json`.
//   - Conversation continuity is server-side via `--session <id>`: lazar
//     prepends prior turns from `logs/sessions/<id>.jsonl` automatically.
//   - One session id is generated per ProviderSession (per conversation) and
//     reused for every turn in that conversation.
//   - On first turn, if the host already has prior `messages` (e.g. /sessions
//     resume rehydrated a transcript with no matching lazar session log on
//     disk), we synthesize a "restored_context" preface and prepend it to the
//     prompt — same trick as claude-agent-provider.
//
// Authentication: lazar reads `ANTHROPIC_API_KEY` from its environment. We
// surface a real credential check (binary exists + executable + key present)
// so the host can guide the user when something is missing.
//
// Tool semantics: lazar streams `tool_use` / `tool_result` JSONL events for
// its own `execute` calls; we translate them to ProviderStreamEvent so the
// transcript surfaces what the agent did. We do NOT pass `input.tools` to
// lazar — its toolset is fixed by the kernel.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { formatHistoryAsPreface } from "../builtin/provider-history-preface";
import { NdjsonFramer } from "../builtin/transports";

// ── IDs & settings keys ──────────────────────────────────────────────────────

const EXTENSION_ID = "builtin.provider-lazar";
const PROVIDER_ID = "lazar";
const ADAPTER_ID = "lazar.cli";

const BIN_PATH_SETTING = `${ADAPTER_ID}.binPath`;
const LAZAR_HOME_SETTING = `${ADAPTER_ID}.lazarHome`;
const VERBOSE_SETTING = `${ADAPTER_ID}.verbose`;
const TOOL_TIMEOUT_SETTING = `${ADAPTER_ID}.toolTimeoutSecs`;
const INHERIT_API_KEY_SETTING = `${ADAPTER_ID}.inheritApiKeyToTools`;

const DEFAULT_LAZAR_HOME = path.join(os.homedir(), "lazar");
const DEFAULT_BIN_PATH = path.join(DEFAULT_LAZAR_HOME, "bin", "lazar");
const DEFAULT_TOOL_TIMEOUT_SECS = 120;

// ── Models ───────────────────────────────────────────────────────────────────
//
// Lazar passes `--model` straight to the Anthropic API (kernel default is
// `claude-sonnet-4-6` per src/main.rs). We surface the same family the
// claude-agent provider exposes so users can pick what they want.

interface LazarModelSpec {
  id: string;
  label: string;
  description: string;
  contextWindow: number;
  aliases?: string[];
}

const LAZAR_MODELS: LazarModelSpec[] = [
  {
    id: "MiniMax-M3",
    label: "MiniMax M3 (Lazar)",
    description: "Lazar default. Balanced flagship Anthropic model via lazar -p.",
    contextWindow: 1_000_000,
    aliases: ["lazar-sonnet", "lazar-opus", "lazar-default"],
  },
];

const DEFAULT_CONTEXT_WINDOW = 200_000;

async function toRegisteredModels(): Promise<ModelSpec[]> {
  const models = await loadModels();
  return models.map((model) => ({
    id: model.id,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: model.label,
    description: model.description,
    contextWindow: model.contextWindow,
    aliases: model.aliases,
    capabilities: { tools: true, reasoning: false, images: false },
  }));
}

type ProxyModel = { id: string; provider: string; free?: boolean; aliases?: string[] };

export async function fetchModelsFromProxy(): Promise<LazarModelSpec[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch("http://localhost:4000/v1/models", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { data: ProxyModel[] };
    if (!json.data || !Array.isArray(json.data) || json.data.length === 0) return null;
    return json.data.map((m) => ({
      id: m.id,
      label: `${m.id}${m.provider ? ` (${m.provider})` : ""}`,
      description: `From proxy: ${m.provider || "unknown"}${m.free ? " — free tier" : ""}`,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      aliases: m.aliases ?? [],
    }));
  } catch {
    return null;
  }
}

let _modelsCache: LazarModelSpec[] | null = null;
export async function loadModels(): Promise<LazarModelSpec[]> {
  if (_modelsCache) return _modelsCache;
  const fetched = await fetchModelsFromProxy();
  _modelsCache = fetched ?? LAZAR_MODELS;
  return _modelsCache;
}

// Resume preface helper lives in `./provider-history-preface` and is shared
// with the claude-agent-provider. When the host rehydrates a conversation
// from disk via /sessions, lazar's own session log likely doesn't exist, so
// the history is serialized into a single preface string and prepended to
// the first prompt of this provider session.

// ── Subprocess helpers ───────────────────────────────────────────────────────

/** Multi-provider key cascade for Lazar subprocess auth.
 *  Lazar primarily drives Anthropic models (and MiniMax via proxy), so
 *  provider-specific keys are checked before the generic product keys.
 *  This order deliberately differs from `getApiKey()` in settings.ts,
 *  which prioritises the product key first. */
function resolveApiKey(): string | undefined {
  return (
    process.env.ANTHROPIC_API_KEY ||
    process.env.MINIMAX_API_KEY ||
    process.env.CODESURF_API_KEY ||
    process.env.OPENROUTER_API_KEY
  );
}

function resolveBinPath(setting: string | undefined): string {
  const fromSetting = setting?.trim();
  if (fromSetting) return fromSetting;
  const fromEnv = process.env.LAZAR_BIN?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_BIN_PATH;
}

function resolveLazarHome(setting: string | undefined): string {
  const fromSetting = setting?.trim();
  if (fromSetting) return fromSetting;
  const fromEnv = process.env.LAZAR_HOME?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_LAZAR_HOME;
}

function isExecutable(p: string): boolean {
  try {
    const stat = statSync(p);
    if (!stat.isFile()) return false;
    // Mode bits 0o111 — any execute bit. Cheap; on macOS the chflags uchg
    // doesn't strip the execute bit, so this is the right check.
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function makeSessionId(conversationId: string): string {
  // Lazar session ids: a-z A-Z 0-9 - _ . (max 64). Sanitize the host's
  // conversation id deterministically so session resumption across restarts
  // maps to the matching kernel session log in logs/sessions/<id>.jsonl.
  let safe = conversationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  safe = safe.replace(/^\.+/, "").replace(/\.\./g, "_");
  if (!safe) return `grok_${Date.now().toString(36)}`;
  return safe.length > 64 ? safe.slice(-64) : safe;
}

// ── Stream-json event shapes ─────────────────────────────────────────────────
//
// Per src/main.rs in the lazar repo, --output-format stream-json emits one
// JSON object per stdout line. Event types we care about:
//   { type: "text_delta",  index, text }
//   { type: "text_done",   index }
//   { type: "tool_use",    index, id, name, input }
//   { type: "tool_result", tool_use_id, content }
//   { type: "invoke_start", ... }   ← model-call boundary, ignored
//   { type: "invoke_end",   stop_reason, duration_ms }
//   { type: "error",       message }
// The kernel exits when the agent loop terminates (stop_reason="end_turn"
// with no further tool calls). We treat process exit as the end of the turn.

interface LazarVerifyClaim {
  claim: string;
  passed: boolean;
  note: string;
}

interface LazarVerifyReport {
  passed_count: number;
  failed_count: number;
  all_passed: boolean;
  any_failed: boolean;
  claims: LazarVerifyClaim[];
}

interface LazarEvent {
  type?: string;
  text?: string;
  index?: number;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  stop_reason?: string;
  message?: string;
  duration_ms?: number;
  /** Emitted by the kernel for [VERIFY] blocks and fabrication-pattern hits. */
  report?: LazarVerifyReport;
}

// ── Session ──────────────────────────────────────────────────────────────────

/**
 * Find a marker like "[VERIFY]" but only when anchored to start-of-line
 * (preceded by a newline or at buffer start). Returns -1 if no anchored
 * occurrence exists. Prevents false positives on inline prose mentions
 * like "the `[VERIFY]` block" inside a markdown bullet.
 */
function findLineAnchored(buf: string, marker: string): number {
  let from = 0;
  while (from <= buf.length) {
    const idx = buf.indexOf(marker, from);
    if (idx === -1) return -1;
    if (idx === 0 || buf[idx - 1] === "\n") return idx;
    from = idx + 1;
  }
  return -1;
}

class LazarSession implements ProviderSession {
  readonly adapterId: string;
  readonly providerId = PROVIDER_ID;
  readonly mode = "stateless" as const;
  readonly strategy = "per-conversation" as const;

  /** Persistent across this provider session (≈ one user conversation). */
  private readonly sessionId: string;
  /** Currently in-flight subprocess. Null between turns. stdin is "ignore"
   *  so the typed shape has a null stdin. */
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  /** Set after first sendTurn so we only inject the resume preface once. */
  private historyReplayed = false;
  private disconnected = false;

  constructor(
    ctx: ProviderConnectionContext,
    private readonly resolvers: {
      binPath: () => string;
      lazarHome: () => string;
      verbose: () => boolean;
      toolTimeoutSecs: () => number;
      inheritApiKeyToTools: () => boolean;
    },
  ) {
    this.adapterId = ctx.adapterId;
    this.sessionId = makeSessionId(ctx.conversationId);
  }

  sendTurn = async (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    if (this.disconnected) {
      throw new Error("Lazar session has been disconnected.");
    }
    if (this.child) {
      throw new Error("Lazar session already has an active turn. Await the previous sendTurn before issuing another.");
    }

    const binPath = this.resolvers.binPath();
    if (!isExecutable(binPath)) {
      const err = new Error(
        `Lazar binary not found or not executable at "${binPath}". ` +
          `Install lazar (https://github.com/jkneen/lazar) or set the lazar.cli.binPath setting / LAZAR_BIN env var.`,
      );
      controller.emit({ type: "error", message: err.message });
      throw err;
    }
    const apiKey = resolveApiKey();
    if (!apiKey) {
      const err = new Error(
        "No provider API key set (ANTHROPIC_API_KEY / MINIMAX_API_KEY / CODESURF_API_KEY). " +
          "Lazar needs an API key to call the model.",
      );
      controller.emit({ type: "error", message: err.message });
      throw err;
    }

    // Resume preface: see formatHistoryAsPreface comment.
    let promptToSend = input.prompt;
    if (!this.historyReplayed) {
      this.historyReplayed = true;
      if (input.messages && input.messages.length > 1) {
        const prior = input.messages.slice(0, -1);
        const preface = formatHistoryAsPreface(prior);
        if (preface) promptToSend = `${preface}\n\n${input.prompt}`;
      }
    }

    const args: string[] = [
      "-p",
      promptToSend,
      "--session",
      this.sessionId,
      "--output-format",
      "stream-json",
      "--model",
      input.modelId,
    ];
    if (this.resolvers.verbose()) args.push("--verbose");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || apiKey,
      LAZAR_HOME: this.resolvers.lazarHome(),
      LAZAR_TOOL_TIMEOUT_SECS: String(this.resolvers.toolTimeoutSecs()),
    };
    if (this.resolvers.inheritApiKeyToTools()) {
      env.LAZAR_TOOL_INHERIT_ANTHROPIC_API_KEY = "1";
    }

    controller.emit({ type: "status", status: "connecting" });

    const child = spawn(binPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a stop reaches the tool subprocesses lazar
      // spawned and not just the kernel itself.
      detached: process.platform !== "win32",
    });
    this.child = child;

    // Wire host AbortSignal → SIGTERM.
    const onAbort = (): void => killLazarChild(child);

    // Set once the Promise below exists. A lazar `error` event ends the turn
    // there and then; the close that follows must not report it a second time.
    let failTurn: ((err: Error) => void) | null = null;
    let failed = false;
    if (input.abortSignal) {
      if (input.abortSignal.aborted) onAbort();
      else input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Per-turn state for stripping [VERIFY]...[/VERIFY] blocks out of
    // streamed assistant text. The kernel parses these blocks itself and
    // emits structured `verify_report` events; we don't want the raw markup
    // to leak into the rendered UI.
    let textBuf = "";
    let inVerifyBlock = false;
    const VERIFY_OPEN = "[VERIFY]";
    const VERIFY_CLOSE = "[/VERIFY]";

    controller.emit({ type: "status", status: "streaming" });

    // Buffer stderr for error reporting; lazar uses stderr for human messages
    // (e.g. "ANTHROPIC_API_KEY is not set" before stream-json initializes).
    let stderrBuf = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      // Keep the buffer bounded so a runaway tool log doesn't OOM us.
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
    });

    // Parse stdout JSONL events line-by-line.
    //
    // Framing comes from the shared NdjsonFramer (transports/ndjson.ts); the
    // switch below stays local because lazar emits its OWN event vocabulary
    // (text_delta / tool_use / invoke_end), not the Anthropic stream-json
    // envelope that amp/grok/claude share. Only the framing is common.
    let stopReason: string | undefined;
    const framer = new NdjsonFramer({
      onValue: (value) => {
        const event = value as LazarEvent;
        switch (event.type) {
          case "text_delta": {
            if (typeof event.text !== "string" || event.text.length === 0) break;
            // Stream the incoming chunk through a [VERIFY]-block stripping
            // state machine. We may receive open/close markers split across
            // delta boundaries, so we hold back the trailing VERIFY_OPEN.length
            // bytes until we know they aren't the start of a block.
            textBuf += event.text;
            // Loop emits as much as possible from textBuf, leaving residue.
            // eslint-disable-next-line no-constant-condition
            while (true) {
              if (inVerifyBlock) {
                const close = findLineAnchored(textBuf, VERIFY_CLOSE);
                if (close === -1) {
                  // Whole buffer is inside the block; drop it. But keep the
                  // last (CLOSE.length - 1) bytes in case the close marker
                  // is split across deltas.
                  const keep = VERIFY_CLOSE.length - 1;
                  if (textBuf.length > keep) textBuf = textBuf.slice(-keep);
                  break;
                }
                textBuf = textBuf.slice(close + VERIFY_CLOSE.length);
                inVerifyBlock = false;
                continue;
              }
              // Only treat [VERIFY] as a marker when it's at start-of-line
              // (or start-of-buffer). Prevents false positives on prose like
              // "the `[VERIFY]` block" that mentions the literal string.
              const open = findLineAnchored(textBuf, VERIFY_OPEN);
              if (open === -1) {
                // No open marker. Emit everything except the trailing
                // (OPEN.length - 1) bytes (which might be the start of one).
                const safeTail = VERIFY_OPEN.length - 1;
                if (textBuf.length > safeTail) {
                  const emit = textBuf.slice(0, textBuf.length - safeTail);
                  controller.emit({ type: "text-delta", delta: emit });
                  textBuf = textBuf.slice(textBuf.length - safeTail);
                }
                break;
              }
              if (open > 0) {
                controller.emit({ type: "text-delta", delta: textBuf.slice(0, open) });
              }
              textBuf = textBuf.slice(open + VERIFY_OPEN.length);
              inVerifyBlock = true;
            }
            break;
          }
          case "tool_use": {
            controller.emit({
              type: "tool-call",
              id: event.id ?? "",
              toolName: event.name ?? "execute",
              args: event.input,
            });
            break;
          }
          case "tool_result": {
            controller.emit({
              type: "tool-result",
              id: event.tool_use_id ?? "",
              result: event.content,
            });
            break;
          }
          case "error": {
            const msg = event.message ?? "lazar reported an error";
            controller.emit({ type: "error", message: msg });
            // The error ends the turn for the host, so the kernel must not keep
            // running (and holding `this.child`) behind it.
            if (!failed) {
              failed = true;
              killLazarChild(child);
              if (this.child === child) this.child = null;
              failTurn?.(new Error(msg));
            }
            break;
          }
          case "verify_report":
          case "fabrication_check": {
            // The kernel runs filesystem/pattern checks on claims the LLM
            // makes in [VERIFY] blocks (or fabrication-pattern hits). We
            // surface those as a synthetic tool-call/tool-result pair so they
            // render with the same affordance as any other tool invocation.
            const r = event.report;
            if (!r) break;
            const synthId = `${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const toolName = event.type === "verify_report" ? "kernel.verify" : "kernel.fabrication_check";
            controller.emit({
              type: "tool-call",
              id: synthId,
              toolName,
              args: { claims: r.claims.map((c) => c.claim) },
            });
            const total = r.passed_count + r.failed_count;
            controller.emit({
              type: "tool-result",
              id: synthId,
              result: {
                summary: `${r.passed_count}/${total} checks passed`,
                all_passed: r.all_passed,
                checks: r.claims.map((c) => ({
                  claim: c.claim,
                  passed: c.passed,
                  note: c.note,
                })),
              },
              isError: r.any_failed,
            });
            break;
          }
          case "invoke_end": {
            // Last invoke_end before exit carries the terminal stop_reason.
            // Intermediate invoke_ends (the agent looping back into another
            // model call after a tool result) get overwritten harmlessly.
            if (typeof event.stop_reason === "string") stopReason = event.stop_reason;
            break;
          }
          case "text_done": {
            // End of an assistant text turn — flush any held tail buffer.
            // (e.g. the model ended with "[VER" — those bytes have been held
            // back in case they were the start of a [VERIFY] block.)
            if (textBuf.length > 0) {
              // Safety net: if we still hold buffered text at end-of-stream,
              // emit it. If we're stuck in a [VERIFY] block (no close marker
              // ever arrived — likely a parsing edge case), flushing as raw
              // text makes the bug VISIBLE rather than silently swallowing
              // the rest of the message.
              const prefix = inVerifyBlock ? "[VERIFY]" : "";
              controller.emit({ type: "text-delta", delta: prefix + textBuf });
            }
            textBuf = "";
            inVerifyBlock = false;
            break;
          }
          default:
            // Ignore — informational (includes "invoke_start" and unknown events).
            break;
        }
      },
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => framer.push(chunk));

    return new Promise<{ usage?: ProviderUsageSnapshot }>((resolve, reject) => {
      failTurn = (err) => {
        if (input.abortSignal) input.abortSignal.removeEventListener("abort", onAbort);
        reject(err);
      };
      child.once("error", (err) => {
        if (input.abortSignal) input.abortSignal.removeEventListener("abort", onAbort);
        if (this.child === child) this.child = null;
        if (failed) return;
        failed = true;
        controller.emit({ type: "error", message: err.message });
        reject(err);
      });
      child.once("close", (code, signal) => {
        if (input.abortSignal) input.abortSignal.removeEventListener("abort", onAbort);
        if (this.child === child) this.child = null;
        if (failed) return;
        // Lazar's final event can arrive without a trailing newline; without
        // this the last text_done/invoke_end (and therefore the stop reason)
        // would be dropped.
        framer.flush();
        if (failed) return;
        if (code === 0) {
          controller.emit({ type: "done", stopReason: stopReason ?? "end_turn" });
          // Lazar doesn't surface usage in stream-json (only in --output-format json).
          resolve({});
          return;
        }
        const reason =
          stderrBuf.trim().split("\n").pop() ||
          (signal ? `terminated by ${signal}` : `lazar exited with code ${code ?? "unknown"}`);
        const err = new Error(`Lazar failed: ${reason}`);
        controller.emit({ type: "error", message: err.message });
        reject(err);
      });
    });
  };

  abortTurn = async (): Promise<void> => {
    if (!this.child) return;
    killLazarChild(this.child);
  };

  disconnect = async (): Promise<void> => {
    if (this.disconnected) return;
    this.disconnected = true;
    await this.abortTurn();
  };
}

/** SIGTERM the lazar kernel's whole process group (it is spawned detached),
 *  falling back to the child alone. Best-effort, never throws. */
function killLazarChild(child: ChildProcessByStdio<null, Readable, Readable>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid !== undefined && process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
  } catch {
    // Group already gone or not ours; fall through to the child.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }
}

// ── Auth check ───────────────────────────────────────────────────────────────

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  const binSetting = ctx.settings.get<string>(BIN_PATH_SETTING);
  const binPath = resolveBinPath(binSetting);
  if (!existsSync(binPath)) {
    return {
      ok: false,
      reason: `Lazar binary not found at "${binPath}". Build/install lazar (~/lazar/scripts/kernel-build.sh) or update the lazar.cli.binPath setting.`,
      needsUserAction: "install-cli",
    };
  }
  if (!isExecutable(binPath)) {
    return {
      ok: false,
      reason: `Lazar binary at "${binPath}" exists but is not executable.`,
      needsUserAction: "install-cli",
    };
  }
  if (!resolveApiKey()) {
    return {
      ok: false,
      reason: "No provider API key set (ANTHROPIC_API_KEY / MINIMAX_API_KEY / CODESURF_API_KEY).",
      needsUserAction: "paste-api-key",
    };
  }
  return { ok: true };
}

// ── Extension module ─────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Lazar Agent SDK",
  version: "1.0.0",
  description:
    "Routes turns through the local lazar Rust kernel — a single-tool (execute/bash) agent harness that owns its own skills and memory. Continuity is via lazar's --session id.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: false,
  capabilities: ["provider-adapters", "models", "settings"],
};

export const lazarProviderPlugin: CodesurfPlugin = {
  name: "codesurf-lazar-provider",
  manifest,
  inject: ["contributions", "settings"],
  async apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BIN_PATH_SETTING,
        title: "Lazar binary path",
        description: `Absolute path to the lazar binary. Falls back to LAZAR_BIN env, then ${DEFAULT_BIN_PATH}.`,
        type: "string",
        default: DEFAULT_BIN_PATH,
        section: "Lazar Agent SDK",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: LAZAR_HOME_SETTING,
        title: "LAZAR_HOME directory",
        description: `Root of the lazar install (skills/, memory/, workspace/, logs/). Falls back to LAZAR_HOME env, then ${DEFAULT_LAZAR_HOME}.`,
        type: "string",
        default: DEFAULT_LAZAR_HOME,
        section: "Lazar Agent SDK",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: VERBOSE_SETTING,
        title: "Verbose lazar output",
        description: "Pass --verbose to lazar so it prints tool calls, depth, and stop_reason to stderr.",
        type: "boolean",
        default: false,
        section: "Lazar Agent SDK",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TOOL_TIMEOUT_SETTING,
        title: "Tool execution timeout (seconds)",
        description: "Wall-clock timeout for each lazar execute(command) tool call. Sets LAZAR_TOOL_TIMEOUT_SECS.",
        type: "number",
        default: DEFAULT_TOOL_TIMEOUT_SECS,
        section: "Lazar Agent SDK",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: INHERIT_API_KEY_SETTING,
        title: "Inherit API key into tool subprocesses",
        description:
          "Off by default for secret isolation. Turn on to let nested `lazar -p` calls inside execute(command) reach the Anthropic API. Sets LAZAR_TOOL_INHERIT_ANTHROPIC_API_KEY=1.",
        type: "boolean",
        default: false,
        section: "Lazar Agent SDK",
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Lazar",
        description:
          "Local lazar Rust kernel. Per-turn `lazar -p` subprocess; conversation continuity via --session id; one tool (execute/bash). Skills live on disk under LAZAR_HOME.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "stdio",
        connectionMode: "stateless",
        sessionStrategy: "per-conversation",
        capabilities: {
          streaming: true,
          tools: true,
          images: false,
          reasoning: false,
        },
        models: await toRegisteredModels(),
        auth: {
          mode: "api-key",
          check: checkCredential,
        },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => {
            return new LazarSession(ctx, {
              binPath: () => resolveBinPath(ctx.settings.get<string>(BIN_PATH_SETTING)),
              lazarHome: () => resolveLazarHome(ctx.settings.get<string>(LAZAR_HOME_SETTING)),
              verbose: () => ctx.settings.get<boolean>(VERBOSE_SETTING, false) === true,
              toolTimeoutSecs: () => {
                const raw = ctx.settings.get<number>(TOOL_TIMEOUT_SETTING, DEFAULT_TOOL_TIMEOUT_SECS);
                return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_TIMEOUT_SECS;
              },
              inheritApiKeyToTools: () => ctx.settings.get<boolean>(INHERIT_API_KEY_SETTING, false) === true,
            });
          },
        },
      }),
    );
  },
};

// Export internals for tests.
export { LazarSession, makeSessionId, resolveBinPath, resolveLazarHome };
