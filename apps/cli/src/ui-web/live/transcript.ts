// Chunk → transcript. The live front does not mount useTurnEngine: that hook
// pulls the Agent, telegram, approvals, and a setImmediate paint loop that
// browsers do not have. The wire protocol is still StreamChunk, so this file
// is the only translation the curated surface needs.

export type TranscriptEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; reasoning: string }
  | { kind: "tool"; id: string; name: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "status"; id: string; text: string };

/** The StreamChunk fields the live front actually reads. */
export interface LiveChunk {
  type: string;
  content?: string;
  status?: string;
  toolCalls?: Array<{ function?: { name?: string } }>;
  toolCall?: { function?: { name?: string } };
}

export function startUserTurn(entries: readonly TranscriptEntry[], text: string, turnId: string): TranscriptEntry[] {
  return [
    ...entries,
    { kind: "user", id: turnId, text },
    { kind: "assistant", id: `${turnId}:a`, text: "", reasoning: "" },
  ];
}

function lastAssistant(
  entries: TranscriptEntry[],
): { index: number; entry: Extract<TranscriptEntry, { kind: "assistant" }> } | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "assistant") return { index: i, entry };
  }
  return null;
}

/**
 * The assistant row a streamed delta belongs to. Text that arrives after tool
 * rows opens a new assistant row below them, so the transcript keeps the order
 * the model produced it in instead of appending post-tool text above the tools.
 */
function openAssistant(
  entries: TranscriptEntry[],
): { index: number; entry: Extract<TranscriptEntry, { kind: "assistant" }> } | null {
  const assistant = lastAssistant(entries);
  if (!assistant) return null;
  const toolAfter = entries.slice(assistant.index + 1).some((entry) => entry.kind === "tool");
  if (!toolAfter) return assistant;
  const entry = {
    kind: "assistant" as const,
    id: `${assistant.entry.id}:${entries.length}`,
    text: "",
    reasoning: "",
  };
  entries.push(entry);
  return { index: entries.length - 1, entry };
}

function replaceAt(entries: TranscriptEntry[], index: number, entry: TranscriptEntry): TranscriptEntry[] {
  const next = entries.slice();
  next[index] = entry;
  return next;
}

export function applyChunk(entries: readonly TranscriptEntry[], chunk: LiveChunk): TranscriptEntry[] {
  const current = entries.slice();
  switch (chunk.type) {
    case "content": {
      const assistant = openAssistant(current);
      const delta = chunk.content ?? "";
      if (!assistant) {
        current.push({ kind: "assistant", id: `orphan-${current.length}`, text: delta, reasoning: "" });
        return current;
      }
      return replaceAt(current, assistant.index, { ...assistant.entry, text: assistant.entry.text + delta });
    }
    case "reasoning": {
      const assistant = openAssistant(current);
      const delta = chunk.content ?? "";
      if (!assistant) {
        current.push({ kind: "assistant", id: `orphan-${current.length}`, text: "", reasoning: delta });
        return current;
      }
      return replaceAt(current, assistant.index, {
        ...assistant.entry,
        reasoning: assistant.entry.reasoning + delta,
      });
    }
    case "tool_calls": {
      const calls = chunk.toolCalls ?? (chunk.toolCall ? [chunk.toolCall] : []);
      for (const call of calls) {
        const name = call.function?.name ?? "tool";
        current.push({ kind: "tool", id: `tool-${current.length}`, name });
      }
      return current;
    }
    case "error":
      current.push({ kind: "error", id: `err-${current.length}`, text: chunk.content ?? "turn failed" });
      return current;
    case "status":
      current.push({
        kind: "status",
        id: `st-${current.length}`,
        text: chunk.status ?? chunk.content ?? "status",
      });
      return current;
    case "done":
    case "warning":
    case "tool_result":
    case "tool_approval_request":
    case "questionnaire":
      return current;
    default:
      return current;
  }
}
