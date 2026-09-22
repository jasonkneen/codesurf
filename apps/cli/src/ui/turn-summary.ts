// Turn-end summary line — "✓ Done in 12.3s · 4 tools · 2 files changed".
//
// Pure helpers: the hooks decide when a turn ended and how, these only
// count and format. Counting is scoped to one run id so a summary never
// picks up rows from an earlier turn that is still in the transcript.

import type { ChatEntry } from "../types/index";

const EDIT_TOOLS = new Set(["write_file", "edit_file", "Write", "Edit", "MultiEdit"]);

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function tokens(n: number): string {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : String(abs);
  return `${n < 0 ? "-" : "+"}${body} tokens`;
}

export type TurnOutcome = "done" | "stopped" | "error";

export function formatTurnSummary(input: {
  outcome: TurnOutcome;
  elapsedMs: number;
  toolCount: number;
  filesChanged: number;
  tokenDelta?: number;
}): string {
  const parts: string[] = [];
  if (input.outcome === "done") parts.push(`✓ Done in ${seconds(input.elapsedMs)}`);
  else if (input.outcome === "stopped") parts.push(`■ Stopped after ${seconds(input.elapsedMs)}`);
  else parts.push(`✗ Failed after ${seconds(input.elapsedMs)}`);
  if (input.toolCount > 0) parts.push(plural(input.toolCount, "tool"));
  if (input.filesChanged > 0) parts.push(`${plural(input.filesChanged, "file")} changed`);
  if (input.tokenDelta !== undefined && input.tokenDelta !== 0) parts.push(tokens(input.tokenDelta));
  return parts.join(" · ");
}

/** Tool count and distinct edited paths among the rows of one run. */
export function collectTurnStats(
  entries: ChatEntry[],
  runId: number | undefined,
): { toolCount: number; filesChanged: number } {
  let toolCount = 0;
  const files = new Set<string>();
  if (runId === undefined) return { toolCount, filesChanged: 0 };
  for (const entry of entries) {
    if (entry.type !== "tool_result" || entry.runId !== runId || !entry.toolCall) continue;
    toolCount++;
    if (!EDIT_TOOLS.has(entry.toolCall.function.name)) continue;
    try {
      const args = JSON.parse(entry.toolCall.function.arguments) as { path?: string; file_path?: string };
      const path = args.path ?? args.file_path;
      if (path) files.add(path);
    } catch {
      // Unparseable arguments still count as a tool call, just not as a file.
    }
  }
  return { toolCount, filesChanged: files.size };
}
