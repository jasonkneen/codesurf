// CodeSurf's plugin tools, exposed to SDK-hosted models as an MCP server.
//
// The Claude Agent SDK brings its own tools and its own system prompt, so a
// model running on that adapter never saw CodeSurf's client toolset — a plugin
// could register a tool and the model would genuinely have no idea it existed,
// reaching for its own near-equivalent instead.
//
// The SDK does speak MCP, and `createSdkMcpServer` builds an IN-PROCESS server
// (no subprocess, no port). So rather than teaching the provider to forward
// tools, CodeSurf publishes them as one MCP server the SDK mounts like any
// other: tools arrive as `mcp__codesurf__<name>`.
//
// Deliberately NOT everything. The SDK already has Bash, Read, Write, Edit,
// Grep, Glob and Task; re-exporting those would give the model two of each and
// no way to choose. What it lacks is the plugin-contributed surface — schedules,
// knowledge index, LSP, payments, media, and whatever a third-party plugin
// added — which is precisely what is worth publishing.

import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ZodRawShape } from "zod";
import { getRegistrySnapshot } from "../registry";

/** Server name; tools reach the model as `mcp__codesurf__<tool>`. */
export const CODESURF_MCP_SERVER_ID = "codesurf";
export const CODESURF_MCP_PREFIX = `mcp__${CODESURF_MCP_SERVER_ID}__`;

/**
 * Tool groups the SDK already covers natively.
 *
 * Publishing these would duplicate a built-in the model knows better, and two
 * tools that do the same thing is worse than one.
 */
const SDK_NATIVE_GROUPS = new Set(["bash", "file", "grep", "subagents"]);

interface ExecutableTool {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

/** The zod raw shape behind an AI SDK tool's `inputSchema`, if it has one. */
function rawShapeOf(inputSchema: unknown): ZodRawShape | null {
  const shape = (inputSchema as { shape?: unknown } | undefined)?.shape;
  if (shape && typeof shape === "object") return shape as ZodRawShape;
  // zod v4 keeps the shape behind `_def`.
  const def = (inputSchema as { _def?: { shape?: unknown } } | undefined)?._def?.shape;
  if (typeof def === "function") {
    try {
      const resolved = (def as () => unknown)();
      if (resolved && typeof resolved === "object") return resolved as ZodRawShape;
    } catch {
      return null;
    }
  }
  if (def && typeof def === "object") return def as ZodRawShape;
  return null;
}

/** Whatever a CodeSurf tool returned, as text the model can read. */
function toText(result: unknown): string {
  if (typeof result === "string") return result;
  const record = result as { output?: unknown; error?: unknown; success?: boolean } | null;
  if (record && typeof record === "object") {
    if (typeof record.output === "string") return record.output;
    if (typeof record.error === "string") return `Error: ${record.error}`;
  }
  return JSON.stringify(result ?? null);
}

/** Tools worth publishing: plugin-contributed, not shadowing an SDK native. */
export function publishableTools(): Array<{ name: string; description: string; tool: ExecutableTool }> {
  return getRegistrySnapshot()
    .tools.filter((entry) => !SDK_NATIVE_GROUPS.has(entry.group ?? ""))
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      tool: entry.tool as unknown as ExecutableTool,
    }))
    .filter((entry) => typeof entry.tool?.execute === "function" && rawShapeOf(entry.tool.inputSchema) !== null);
}

/**
 * Build the in-process MCP server, or null when there is nothing to publish.
 *
 * Called per session, so a plugin enabled or disabled between sessions changes
 * what the model sees on the next one.
 */
export function buildCodesurfMcpServer(): { server: unknown; toolNames: string[] } | null {
  const publishable = publishableTools();
  if (publishable.length === 0) return null;

  const tools = publishable.map((entry) =>
    sdkTool(entry.name, entry.description, rawShapeOf(entry.tool.inputSchema) as ZodRawShape, async (args: unknown) => {
      try {
        const result = await entry.tool.execute?.(args);
        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (error) {
        // A throwing tool must come back as a readable failure, not kill the
        // MCP call — the model can react to text, not to a dropped stream.
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    }),
  );

  return {
    server: createSdkMcpServer({ name: CODESURF_MCP_SERVER_ID, version: "1.0.0", tools }),
    toolNames: publishable.map((entry) => entry.name),
  };
}

/**
 * The prompt text telling an SDK-hosted model this server exists.
 *
 * Includes whatever plugins contributed via `registerPromptSection`, so a
 * plugin's own guidance reaches SDK models too and not just the direct-API ones.
 */
export function codesurfMcpPromptSection(toolNames: string[]): string {
  const sections = getRegistrySnapshot().promptSections;
  const contributed = sections.map((section) => `${section.title.toUpperCase()}:\n${section.body}`).join("\n\n");
  return [
    "CODESURF PLUGIN TOOLS:",
    `CodeSurf publishes its plugin tools to you as the \`${CODESURF_MCP_SERVER_ID}\` MCP server.`,
    `They appear as \`${CODESURF_MCP_PREFIX}<name>\` and are real, callable tools:`,
    toolNames.map((name) => `  • ${CODESURF_MCP_PREFIX}${name}`).join("\n"),
    "Prefer these over your own equivalents when the user asks for something a",
    "CodeSurf plugin provides — they are the ones wired into this workspace.",
    contributed ? `\n${contributed}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
