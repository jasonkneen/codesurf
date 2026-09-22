// Pure helper functions extracted from agent.ts (2026-06-22 review, §1.2).
//
// These are stateless utilities used by the Agent's turn loop and UI-facing
// activity formatting: JSON extraction, tool-activity label formatting,
// recap text shaping, and abort-signal composition. Moving them out keeps
// agent.ts focused on orchestration and state.

import type { ChatEntry } from "../types/index";
import { truncate } from "../utils/text";

// Re-exported for existing importers; canonical implementation lives in utils/text.
export { truncate };

/** Extract the outermost JSON object from a possibly-noisy string. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

/** Coerce a tool-call `args` payload into a `Record<string, string>`. */
export function parseToolArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

/**
 * Format a tool call into a short human-readable activity label (used in the
 * running-subagents roster and delegation drill-down).
 */
export function formatSubagentActivity(toolName: string, args?: unknown): string {
  const parsed = parseToolArgs(args);
  if (toolName === "read_file") return `Read ${parsed.path || "file"}`;
  if (toolName === "lsp") return `LSP ${parsed.operation || "query"} ${parsed.filePath || ""}`.trim();
  if (toolName === "write_file") return `Write ${parsed.path || "file"}`;
  if (toolName === "edit_file") return `Edit ${parsed.path || "file"}`;
  if (toolName === "search_web") return `Web search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "search_x") return `X search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "generate_image") return `Generate image "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "generate_video") return `Generate video "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "computer_snapshot") return `Snapshot ${parsed.app || "desktop"}`;
  if (toolName === "computer_screenshot") return "Capture desktop screenshot";
  if (toolName === "computer_click")
    return parsed.ref ? `Click ${parsed.ref}` : `Click at ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_mouse_move")
    return parsed.ref ? `Hover ${parsed.ref}` : `Move mouse to ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_type") return `Type into ${parsed.ref || "element"}`;
  if (toolName === "computer_press") return `Press ${parsed.key || "key"}`;
  if (toolName === "computer_scroll") return `Scroll ${parsed.ref || "element"} ${parsed.direction || "down"}`;
  if (toolName === "computer_launch") return `Launch ${parsed.app || "app"}`;
  if (toolName === "computer_list_windows") return `List windows${parsed.app ? ` for ${parsed.app}` : ""}`;
  if (toolName === "computer_focus_window")
    return `Focus window ${parsed.window_id || parsed.title || parsed.app || ""}`.trim();
  if (toolName === "computer_wait") return "Wait for desktop state";
  if (toolName === "computer_get") return `Read ${parsed.property || "text"} from ${parsed.ref || "element"}`;
  if (toolName === "bash") return truncate(parsed.command || "Run command", 70);
  return truncate(`${toolName}`, 70);
}

/** First non-empty line of `text`, falling back to a completion default. */
export function firstLine(text: string): string {
  return text.trim().split("\n").find(Boolean)?.trim() || "Task completed.";
}

/** Shape a transcript slice into a compact recap string, newest-first, budgeted. */
export function formatEntriesForRecap(entries: ChatEntry[], maxChars: number): string {
  const lines: string[] = [];
  let remaining = maxChars;

  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    const line = formatRecapEntry(entries[i]!);
    if (!line) {
      continue;
    }

    const bounded = truncate(line, Math.min(remaining, 520));
    if (!bounded.trim()) {
      continue;
    }

    lines.unshift(bounded);
    remaining -= bounded.length + 1;
  }

  return lines.join("\n");
}

function formatRecapEntry(entry: ChatEntry): string | null {
  const content = entry.content.trim();
  if (!content) {
    return null;
  }

  switch (entry.type) {
    case "user":
      return `[User] ${truncate(content, 420)}`;
    case "assistant":
      return `[Assistant] ${truncate(content, 420)}`;
    case "tool_result":
      return `[Tool ${entry.toolResult?.success === false ? "error" : "result"}] ${truncate(content, 260)}`;
    default:
      return null;
  }
}

/**
 * Compose an optional caller signal with a timeout signal. Returns the timeout
 * signal alone when no caller signal is given. No-ops on runtimes without
 * `AbortSignal.timeout` (older Node).
 */
export function withAbortTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") {
    return signal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

/**
 * Compose a caller-supplied signal with the signal the Agent owns for a run.
 * Either source aborts the result, so `Agent.abort()` (the owned side) keeps
 * working when the caller also passed its own signal. Returns the owned
 * signal alone when there is no external one.
 */
export function composeAbortSignals(external: AbortSignal | undefined, owned: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([external, owned]) : owned;
}
