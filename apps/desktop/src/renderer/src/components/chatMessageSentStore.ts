// Dedicated signal for "the user just hit send in a chat tile."
//
// Previously the sidebar inferred "user typed a message" from the streaming
// snapshot, which fires for any stream start — resume, tool continuation,
// auto-continue — not just a user submit. That over-triggered promotion of
// threads to the top of the sidebar.
//
// This store exists purely so ChatTile.sendMessage() can publish an explicit
// event the sidebar watches. Nothing else should read or write it.

export type SentEvent = {
  /** Monotonic counter — every publish increments, so React state diffs fire. */
  seq: number
  tileId: string
  sessionId: string | null
  entryId: string | null
  at: number
}

let seq = 0
let latest: SentEvent | null = null
const listeners = new Set<() => void>()

export function recordChatMessageSent(payload: {
  tileId: string
  sessionId?: string | null
  entryId?: string | null
}): void {
  seq += 1
  latest = {
    seq,
    tileId: payload.tileId,
    sessionId: payload.sessionId ?? null,
    entryId: payload.entryId ?? null,
    at: Date.now(),
  }
  for (const listener of listeners) {
    try { listener() } catch { /* ignore listener errors */ }
  }
}

export function subscribeChatMessageSent(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getChatMessageSentSnapshot(): SentEvent | null {
  return latest
}
