// Tiny observable store of currently-streaming chat tiles/sessions.
// ChatTile publishes here when its isStreaming flag flips; Sidebar
// subscribes via useSyncExternalStore to swap the row icon for a spinner.
//
// Temporary UI affordance — keep this small and side-effect free.

type StreamingEntry = {
  tileId: string
  sessionId: string | null
  entryId: string | null
}

const entries = new Map<string, StreamingEntry>()
const listeners = new Set<() => void>()

// Cached snapshot so useSyncExternalStore returns a stable reference
// while nothing has changed (otherwise React warns about tearing).
let snapshot: {
  tileIds: ReadonlySet<string>
  sessionIds: ReadonlySet<string>
  entryIds: ReadonlySet<string>
} = {
  tileIds: new Set(),
  sessionIds: new Set(),
  entryIds: new Set(),
}

function recomputeSnapshot(): void {
  const tileIds = new Set<string>()
  const sessionIds = new Set<string>()
  const entryIds = new Set<string>()
  for (const e of entries.values()) {
    tileIds.add(e.tileId)
    if (e.sessionId) sessionIds.add(e.sessionId)
    if (e.entryId) entryIds.add(e.entryId)
  }
  snapshot = { tileIds, sessionIds, entryIds }
}

function emit(): void {
  recomputeSnapshot()
  for (const l of listeners) {
    try { l() } catch { /* ignore listener errors */ }
  }
}

export function setChatStreaming(
  tileId: string,
  streaming: boolean,
  meta?: { sessionId?: string | null; entryId?: string | null },
): void {
  if (streaming) {
    const prev = entries.get(tileId)
    const next: StreamingEntry = {
      tileId,
      sessionId: meta?.sessionId ?? prev?.sessionId ?? null,
      entryId: meta?.entryId ?? prev?.entryId ?? null,
    }
    if (prev && prev.sessionId === next.sessionId && prev.entryId === next.entryId) return
    entries.set(tileId, next)
    emit()
  } else {
    if (!entries.has(tileId)) return
    entries.delete(tileId)
    emit()
  }
}

export function subscribeChatStreaming(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getChatStreamingSnapshot(): typeof snapshot {
  return snapshot
}
