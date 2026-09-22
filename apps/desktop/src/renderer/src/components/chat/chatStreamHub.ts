/**
 * Single global chat stream demux.
 *
 * Without this, each ChatTile mounts its own `stream.onChunk` listener and
 * every tile filters every event by cardId. With N chat tiles that is N IPC
 * handlers firing per chunk.
 *
 * The hub attaches at most one transport subscription and fans out by the
 * immutable workspace/card identity.
 * Pure / testable: inject `attachTransport` instead of `window.electron`.
 */

export type ChatStreamChunk = {
  workspaceId: string
  cardId: string
  type: string
  text?: string
  toolName?: string
  error?: string
  [key: string]: unknown
}

export type ChatStreamListener = (event: ChatStreamChunk) => void

/** Attach a global transport; return unsubscribe. */
export type ChatStreamTransportAttach = (
  onChunk: (event: ChatStreamChunk) => void,
) => () => void

const listenersByScope = new Map<string, Set<ChatStreamListener>>()
let transportUnsub: (() => void) | null = null
let transportAttach: ChatStreamTransportAttach | null = null
/** Test override — when set, used instead of window.electron.stream.onChunk. */
let transportOverride: ChatStreamTransportAttach | null = null

function defaultTransportAttach(onChunk: (event: ChatStreamChunk) => void): () => void {
  const api = typeof window !== 'undefined' ? window.electron?.stream?.onChunk : undefined
  if (typeof api !== 'function') {
    return () => {}
  }
  return api((event: ChatStreamChunk) => {
    onChunk(event)
  })
}

function dispatch(event: ChatStreamChunk): void {
  const workspaceId = typeof event?.workspaceId === 'string' ? event.workspaceId : ''
  const cardId = typeof event?.cardId === 'string' ? event.cardId : ''
  if (!workspaceId || !cardId) return
  const set = listenersByScope.get(streamScopeKey(workspaceId, cardId))
  if (!set || set.size === 0) return
  for (const listener of set) {
    try {
      listener(event)
    } catch {
      /* ignore listener errors */
    }
  }
}

function ensureTransport(): void {
  if (transportUnsub) return
  const attach = transportOverride ?? transportAttach ?? defaultTransportAttach
  transportUnsub = attach(dispatch)
}

function maybeTeardownTransport(): void {
  if (listenersByScope.size > 0) return
  if (transportUnsub) {
    try { transportUnsub() } catch { /* ignore */ }
    transportUnsub = null
  }
}

/**
 * Subscribe to stream chunks for one workspace/tile identity.
 * Returns unsubscribe. Global transport tears down when the last tile leaves.
 */
export function subscribeChatStream(
  workspaceId: string,
  tileId: string,
  listener: ChatStreamListener,
): () => void {
  if (!workspaceId || !tileId) return () => {}
  const key = streamScopeKey(workspaceId, tileId)
  let set = listenersByScope.get(key)
  if (!set) {
    set = new Set()
    listenersByScope.set(key, set)
  }
  set.add(listener)
  ensureTransport()

  return () => {
    const current = listenersByScope.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByScope.delete(key)
    maybeTeardownTransport()
  }
}

/** How many tiles currently have at least one stream listener. */
export function getChatStreamHubTileCount(): number {
  return listenersByScope.size
}

/** Total listener callbacks registered (may be > tile count). */
export function getChatStreamHubListenerCount(): number {
  let n = 0
  for (const set of listenersByScope.values()) n += set.size
  return n
}

/** True when the hub holds an active transport subscription. */
export function isChatStreamHubTransportActive(): boolean {
  return transportUnsub != null
}

/**
 * Test-only: inject a fake transport. Pass null to restore default.
 * Clears any active transport so the next subscribe re-attaches.
 */
export function setChatStreamHubTransportForTests(
  attach: ChatStreamTransportAttach | null,
): void {
  if (transportUnsub) {
    try { transportUnsub() } catch { /* ignore */ }
    transportUnsub = null
  }
  transportOverride = attach
  if (listenersByScope.size > 0) ensureTransport()
}

/** Test-only: drop all listeners and transport. */
export function resetChatStreamHubForTests(): void {
  listenersByScope.clear()
  if (transportUnsub) {
    try { transportUnsub() } catch { /* ignore */ }
    transportUnsub = null
  }
  transportOverride = null
  transportAttach = null
}

function streamScopeKey(workspaceId: string, cardId: string): string {
  return JSON.stringify([workspaceId, cardId])
}
