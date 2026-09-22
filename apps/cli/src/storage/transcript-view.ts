import type { ModelMessage } from "ai";
import { compactionHeadMessages, isCompactionSummaryMessage } from "../agent/compaction";

export interface PersistedCompaction {
  firstKeptSeq: number;
  summary: string;
  tokensBefore: number;
  createdAt: Date;
}

export interface LoadedTranscriptState {
  messages: ModelMessage[];
  seqs: Array<number | null>;
  timestamps: Date[];
  compaction: PersistedCompaction | null;
}

const SYSTEM_REMINDER_PATTERN = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>$/;

/**
 * Out-of-band context (a background notification) as the model sees it: a
 * `<system-reminder>` user turn. Never a mid-conversation `role: "system"`
 * message — Anthropic rejects those ("multiple system messages").
 */
export function systemReminderMessage(text: string): ModelMessage {
  return { role: "user", content: `<system-reminder>\n${text}\n</system-reminder>` };
}

/** The text of a message that is nothing but one `<system-reminder>` block, else null. */
export function systemReminderText(message: ModelMessage): string | null {
  if (message.role !== "user" || typeof message.content !== "string") return null;
  return SYSTEM_REMINDER_PATTERN.exec(message.content)?.[1] ?? null;
}

/**
 * Sessions saved before notifications moved to `<system-reminder>` turns hold
 * them as `role: "system"` rows mid-conversation. Loading those verbatim
 * re-sends a history Anthropic rejects on every turn, so they are rewritten
 * on load. A compaction summary is never a stored row, but is left alone
 * should one ever be.
 */
function normalizeLegacySystemRow(message: ModelMessage): ModelMessage {
  if (message.role !== "system" || isCompactionSummaryMessage(message)) return message;
  return systemReminderMessage(typeof message.content === "string" ? message.content : "");
}

export function buildEffectiveTranscript(
  messages: ModelMessage[],
  seqs: number[],
  timestamps: Date[],
  compaction: PersistedCompaction | null,
): LoadedTranscriptState {
  messages = messages.map(normalizeLegacySystemRow);
  if (!compaction) {
    return {
      messages: [...messages],
      seqs: [...seqs],
      timestamps: [...timestamps],
      compaction: null,
    };
  }

  const firstKeptIndex = seqs.findIndex((seq) => seq >= compaction.firstKeptSeq);
  const keptIndex = firstKeptIndex >= 0 ? firstKeptIndex : messages.length;
  const keptMessages = messages.slice(keptIndex);
  const keptSeqs = seqs.slice(keptIndex);
  const keptTimestamps = timestamps.slice(keptIndex);

  // Same head the live compaction installs — the bridge is not a stored row,
  // so reload has to rebuild it or the reopened session leads with an
  // assistant message.
  const head = compactionHeadMessages(compaction.summary, keptMessages);
  return {
    messages: [...head, ...keptMessages],
    seqs: [...head.map(() => null), ...keptSeqs],
    timestamps: [...head.map(() => compaction.createdAt), ...keptTimestamps],
    compaction,
  };
}
