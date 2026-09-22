import type { ChatEntry } from "../types/index.js";

/**
 * True when a freshly-rebuilt text row (user/assistant) is render-identical to
 * the previous render's entry, so the caller can keep the OLD object reference
 * and let `memo(MessageView)` (which compares `entry` by reference) skip
 * re-parsing that row's markdown.
 *
 * Conservative on purpose: only plain text rows qualify. Any row carrying
 * tool/source/artifact payloads returns false and re-renders — those fields are
 * in-memory only and dropped by the `getChatEntries()` rebuild, so reusing
 * could mask a real change. A false "reuse" would show stale content, so when
 * in doubt we re-render.
 */
export function isReusableTextEntry(prev: ChatEntry, next: ChatEntry): boolean {
  if (prev.type !== next.type) return false;
  if (prev.type !== "user" && prev.type !== "assistant") return false;
  if (prev.content !== next.content) return false;
  if (prev.reasoningText !== next.reasoningText) return false;
  if ((prev.followupSuggestions ?? []).join("\n") !== (next.followupSuggestions ?? []).join("\n")) return false;
  if (prev.modeColor !== next.modeColor) return false;
  if (prev.remoteKey !== next.remoteKey) return false;
  if (prev.sourceLabel !== next.sourceLabel) return false;
  if ((prev.queued ?? false) !== (next.queued ?? false)) return false;
  if (prev.terminalSessionId !== next.terminalSessionId) return false;
  if (prev.toolCalls || next.toolCalls) return false;
  if (prev.toolCall || next.toolCall) return false;
  if (prev.toolResult || next.toolResult) return false;
  if (prev.sources || next.sources) return false;
  if (prev.artifacts || next.artifacts) return false;
  return true;
}

/**
 * In-place identity preservation for a rebuilt transcript.
 *
 * `getChatEntries()` returns a fresh array where every row is a new object, even
 * when the conversation is unchanged. `memo(MessageView)` compares its `entry`
 * prop by reference, so a wholesale-new array re-parses every row's markdown at
 * once — the visible turn-end flash. This pairs `fresh` rows with `prev` rows by
 * type ordinal and, where a row is render-identical (see `isReusableTextEntry`),
 * swaps the fresh object for the previous reference so memo skips it. Genuinely
 * changed and payload-bearing rows keep their fresh object and re-render.
 *
 * Mutates and returns `fresh` (callers already mutate it when carrying content
 * and reasoning forward).
 */
export function preserveStableEntryIdentities(prev: ChatEntry[], fresh: ChatEntry[]): ChatEntry[] {
  const cursors: Partial<Record<ChatEntry["type"], number>> = {};
  const prevByType: Partial<Record<ChatEntry["type"], ChatEntry[]>> = {};
  for (const p of prev) {
    const bucket = prevByType[p.type] ?? [];
    bucket.push(p);
    prevByType[p.type] = bucket;
  }
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i]!;
    const bucket = prevByType[f.type];
    if (!bucket) continue;
    const c = cursors[f.type] ?? 0;
    cursors[f.type] = c + 1;
    const p = bucket[c];
    if (p && isReusableTextEntry(p, f)) fresh[i] = p;
  }
  return fresh;
}
