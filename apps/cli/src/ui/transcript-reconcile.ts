import type { ChatEntry } from "../types/index.js";
import { preserveStableEntryIdentities } from "./transcript-identity.js";

/**
 * Merge the DB-rebuilt transcript (`fresh`, from `agent.getChatEntries()`)
 * with the previous render (`prev`) after a local turn completes.
 *
 * Two things only exist in memory and must be carried forward: the user's
 * display text (persisted rows hold the expanded prompt, e.g. `@file`
 * mentions inlined) and assistant reasoning/follow-up chips. Both are carried
 * by pairing rows of the same type by ordinal, which is only sound when every
 * previous row corresponds to a persisted row.
 *
 * Rows produced by a cancelled run break that correspondence: the agent
 * discards an aborted turn's user message and never persists its partial
 * output, but the optimistic rows stayed in the previous render. Pairing
 * across them shifted every later row by one, so the next completed turn's
 * user row displayed the cancelled prompt and its assistant row inherited
 * the cancelled reasoning. `cancelledRunIds` names those runs; their rows
 * are excluded from pairing (and, as before, from the rebuilt list).
 *
 * `system` rows (errors, turn summaries, notices) are UI-only and never
 * persisted, so the rebuild does not know them. They are lifted out before
 * pairing and re-inserted after the persisted row that preceded them, so a
 * summary stays under its turn across every later rebuild.
 */
export function reconcileRebuiltTranscript(
  prev: ChatEntry[],
  fresh: ChatEntry[],
  cancelledRunIds: ReadonlySet<number> = new Set(),
): ChatEntry[] {
  const persisted = prev.filter((entry) => entry.runId === undefined || !cancelledRunIds.has(entry.runId));

  // Lift UI-only rows out, remembering how many pairable rows preceded each
  // one so it can be re-anchored in the rebuilt list.
  const pairable: ChatEntry[] = [];
  const systemRows: Array<{ row: ChatEntry; afterPairableIndex: number }> = [];
  for (const entry of persisted) {
    if (entry.type === "system") {
      systemRows.push({ row: entry, afterPairableIndex: pairable.length });
    } else {
      pairable.push(entry);
    }
  }

  // The DB-backed rebuild has no concept of the user's display text: it holds
  // the expanded prompt. Carry the previous render's content forward by user
  // ordinal so mentions/paste tokens keep their compact presentation.
  let prevUserIdx = 0;
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i]!.type !== "user") continue;
    while (prevUserIdx < pairable.length && pairable[prevUserIdx]!.type !== "user") prevUserIdx++;
    if (prevUserIdx < pairable.length) {
      fresh[i] = {
        ...fresh[i]!,
        content: pairable[prevUserIdx]!.content,
      };
      prevUserIdx++;
    }
  }

  // Pair assistant rows by ordinal and carry reasoningText / follow-ups
  // across. Content is not used for matching because the DB rebuild may
  // normalize it slightly; ordinal is sufficient once cancelled rows are out.
  let prevAssistantIdx = 0;
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i]!.type !== "assistant") continue;
    while (prevAssistantIdx < pairable.length && pairable[prevAssistantIdx]!.type !== "assistant") {
      prevAssistantIdx++;
    }
    if (prevAssistantIdx < pairable.length) {
      const carryReasoning = pairable[prevAssistantIdx]!.reasoningText;
      const carryReasoningDuration = pairable[prevAssistantIdx]!.reasoningDurationMs;
      const carryFollowups = pairable[prevAssistantIdx]!.followupSuggestions;
      if (carryReasoning || carryFollowups?.length) {
        fresh[i] = {
          ...fresh[i]!,
          reasoningText: carryReasoning,
          reasoningDurationMs: carryReasoningDuration,
          followupSuggestions: carryFollowups,
        };
      }
      prevAssistantIdx++;
    }
  }

  // Identity preservation: the rebuild gives every row a brand new object,
  // which busts `memo(MessageView)` and forces a full-transcript markdown
  // reparse — the visible turn-end flash. Reuse the previous object for any
  // render-identical text row so only genuinely changed rows re-render.
  const merged = preserveStableEntryIdentities(pairable, fresh);
  if (systemRows.length === 0) return merged;

  // Re-insert the UI-only rows. `afterPairableIndex` counts persisted rows
  // before the system row in the previous render; the same count into the
  // rebuilt list puts it under the same turn.
  const out: ChatEntry[] = [];
  let next = 0;
  for (let i = 0; i <= merged.length; i++) {
    while (next < systemRows.length && systemRows[next]!.afterPairableIndex === i) {
      out.push(systemRows[next]!.row);
      next++;
    }
    if (i < merged.length) out.push(merged[i]!);
  }
  while (next < systemRows.length) out.push(systemRows[next++]!.row);
  return out;
}
