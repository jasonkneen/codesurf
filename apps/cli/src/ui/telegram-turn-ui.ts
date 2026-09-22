import type { ChatEntry, ToolCall, ToolResult } from "../types/index";

export interface EntryDecoration {
  modeColor?: string;
  remoteKey?: string;
  sourceLabel?: string;
  /** Captured reasoning text — passed through to ChatEntry.reasoningText
   *  for assistant entries so MessageView can render the thinking chip. */
  reasoningText?: string;
  /** Reasoning wall-clock for assistant entries (see ChatEntry.reasoningDurationMs). */
  reasoningDurationMs?: number;
  followupSuggestions?: string[];
  /** UI run that produced this optimistic row (see ChatEntry.runId). */
  runId?: number;
  /** Measured call duration for tool_result rows (see ChatEntry.durationMs). */
  durationMs?: number;
}

export function getTelegramSourceLabel(kind: "user" | "assistant", userId: number): string {
  return kind === "user" ? `Telegram user ${userId}` : `Telegram Codesurf • user ${userId}`;
}

export function buildUserEntry(content: string, decoration: EntryDecoration = {}): ChatEntry {
  return {
    type: "user",
    content,
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    sourceLabel: decoration.sourceLabel,
    runId: decoration.runId,
  };
}

export function buildAssistantEntry(content: string, decoration: EntryDecoration = {}): ChatEntry {
  const reasoning = decoration.reasoningText?.trim();
  return {
    type: "assistant",
    content,
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    sourceLabel: decoration.sourceLabel,
    reasoningText: reasoning && reasoning.length > 0 ? decoration.reasoningText : undefined,
    reasoningDurationMs: reasoning && reasoning.length > 0 ? decoration.reasoningDurationMs : undefined,
    followupSuggestions: decoration.followupSuggestions?.length ? decoration.followupSuggestions : undefined,
    runId: decoration.runId,
  };
}

export function buildToolResultEntry(
  toolCall: ToolCall,
  toolResult: ToolResult,
  decoration: EntryDecoration = {},
): ChatEntry {
  return {
    type: "tool_result",
    content: toolResult.success ? toolResult.output || "Success" : toolResult.error || "Error",
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    sourceLabel: decoration.sourceLabel,
    toolCall,
    toolResult,
    runId: decoration.runId,
    durationMs: decoration.durationMs,
  };
}

/** A UI-only notice row: error, turn summary, or informational line. */
export function buildSystemEntry(
  content: string,
  systemKind: NonNullable<ChatEntry["systemKind"]>,
  decoration: EntryDecoration = {},
): ChatEntry {
  return {
    type: "system",
    systemKind,
    content,
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    runId: decoration.runId,
  };
}

export function getUnflushedTelegramAssistantContent(fullContent: string, flushedChars: number): string {
  const safeStart = Math.max(0, Math.min(flushedChars, fullContent.length));
  return fullContent.slice(safeStart);
}

export function replaceTurnEntries(entries: ChatEntry[], turnKey: string, replacements: ChatEntry[]): ChatEntry[] {
  return [...entries.filter((entry) => entry.remoteKey !== turnKey), ...replacements];
}

export function decorateTelegramEntries(entries: ChatEntry[], userId: number, turnKey: string): ChatEntry[] {
  return entries.map((entry) => {
    if (entry.type === "user") {
      return {
        ...entry,
        remoteKey: turnKey,
        sourceLabel: getTelegramSourceLabel("user", userId),
      };
    }

    if (entry.type === "assistant") {
      return {
        ...entry,
        remoteKey: turnKey,
        sourceLabel: getTelegramSourceLabel("assistant", userId),
      };
    }

    return {
      ...entry,
      remoteKey: turnKey,
    };
  });
}

const MAX_STOPPED_TURN_KEYS = 64;

/** Record a stopped Telegram turn (no-op for local turns). Bounded FIFO. */
export function markTelegramTurnStopped(
  stoppedKeysRef: { current: Set<string> },
  turn: { kind?: string; remoteKey?: string } | null | undefined,
): void {
  if (turn?.kind !== "telegram" || !turn.remoteKey) return;
  const keys = stoppedKeysRef.current;
  keys.add(turn.remoteKey);
  while (keys.size > MAX_STOPPED_TURN_KEYS) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) break;
    keys.delete(oldest);
  }
}
