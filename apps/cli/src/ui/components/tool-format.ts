// Shared tool-call formatting helpers: map a ToolCall to its headline
// argument and a short human-readable label. Used by the transcript chips
// (message-list) and the status line so both surfaces stay in sync.

import type { ToolCall } from "../../types/index";
import { truncate } from "../../utils/text";

export function toolArgs(tc?: ToolCall): string {
  if (!tc) return "";
  try {
    const a = JSON.parse(tc.function.arguments);
    if (tc.function.name === "bash") return a.command || "";
    if (tc.function.name === "read_file" || tc.function.name === "write_file" || tc.function.name === "edit_file")
      return a.path || "";
    if (tc.function.name === "generate_image" || tc.function.name === "generate_video") return a.prompt || "";
    if (tc.function.name === "task") return a.description || "";
    if (tc.function.name === "lsp") return `${a.operation || "query"} ${a.filePath || ""}`.trim();
    if (tc.function.name === "delegate") return a.description || "";
    if (tc.function.name === "delegation_read") return a.id || "";
    if (tc.function.name === "process_logs" || tc.function.name === "process_stop")
      return a.id != null ? String(a.id) : "";
    return a.query || "";
  } catch {
    return "";
  }
}

export function tryParseArg(tc: ToolCall | undefined, key: string): string {
  if (!tc) return "";
  try {
    return JSON.parse(tc.function.arguments)[key] || "";
  } catch {
    return "";
  }
}

export function toolLabel(tc: ToolCall): string {
  const args = toolArgs(tc);
  if (tc.function.name === "bash") {
    try {
      const parsed = JSON.parse(tc.function.arguments);
      if (parsed.background) return `Background: ${truncate(args || "Starting process...", 70)}`;
    } catch {
      /* */
    }
    return truncate(args || "Running command...", 80);
  }
  if (tc.function.name === "read_file") return `Read ${truncate(args, 60)}`;
  if (tc.function.name === "write_file") return `Write ${truncate(args, 60)}`;
  if (tc.function.name === "edit_file") return `Edit ${truncate(args, 60)}`;
  if (tc.function.name === "search_web") return `Web Search "${truncate(args, 60)}"`;
  if (tc.function.name === "search_x") return `X Search "${truncate(args, 60)}"`;
  if (tc.function.name === "generate_image") return `Generate image "${truncate(args, 60)}"`;
  if (tc.function.name === "generate_video") return `Generate video "${truncate(args, 60)}"`;
  if (tc.function.name === "task") return `Task ${truncate(args, 60)}`;
  if (tc.function.name === "delegate") return `Background ${truncate(args, 60)}`;
  if (tc.function.name === "delegation_read") return `Read delegation ${truncate(args, 60)}`;
  if (tc.function.name === "delegation_list") return "List delegations";
  if (tc.function.name === "process_logs") return `Logs for process ${args}`;
  if (tc.function.name === "process_stop") return `Stop process ${args}`;
  if (tc.function.name === "process_list") return "List processes";
  if (tc.function.name === "generate_plan") return "Generating plan...";
  return truncate(`${tc.function.name} ${args}`, 80);
}
