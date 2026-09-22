export const MAX_ROOM_STREAM_SUMMARY_BYTES = 2_000
export const MAX_ACTIVE_ROOM_STREAMS = 256
export const ROOM_STREAM_TTL_MS = 30 * 60 * 1_000

export interface ChatStreamScope {
  readonly workspaceId: string
  readonly cardId: string
}

export type RoomSummaryPublisher = (
  workspaceId: string,
  cardId: string,
  summary: string,
) => void

export type RoomTurnCompletionPublisher = (
  workspaceId: string,
  cardId: string,
  outcome: 'done' | 'error',
) => void

export function createChatStreamScope(
  workspaceId: string | null | undefined,
  cardId: string,
): ChatStreamScope {
  return Object.freeze({
    workspaceId: String(workspaceId ?? '').trim(),
    cardId: String(cardId ?? '').trim(),
  })
}

export function chatStreamScopeKey(scope: ChatStreamScope): string {
  return JSON.stringify([scope.workspaceId, scope.cardId])
}

function utf8Tail(value: string, maxBytes: number): string {
  const characterWindow = value.length > maxBytes * 2
    ? value.slice(-maxBytes * 2)
    : value
  const bytes = Buffer.from(characterWindow, 'utf8')
  if (bytes.length <= maxBytes) return characterWindow
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

/**
 * Keeps same-card streams in different workspaces from sharing summary
 * buffers. Callers must pass the immutable scope captured for the provider
 * invocation; there is deliberately no ambient async context fallback.
 */
export class RoomStreamAccumulator {
  private readonly textByRoomTile = new Map<string, { text: string, updatedAt: number }>()
  private readonly erroredScopes = new Map<string, number>()
  private readonly publish: RoomSummaryPublisher
  private readonly complete: RoomTurnCompletionPublisher

  constructor(
    publish: RoomSummaryPublisher,
    complete: RoomTurnCompletionPublisher = () => {},
  ) {
    this.publish = publish
    this.complete = complete
  }

  private prune(now: number, incomingKey: string): void {
    for (const [key, entry] of this.textByRoomTile) {
      if (now - entry.updatedAt > ROOM_STREAM_TTL_MS) this.textByRoomTile.delete(key)
    }
    for (const [key, updatedAt] of this.erroredScopes) {
      if (now - updatedAt > ROOM_STREAM_TTL_MS) this.erroredScopes.delete(key)
    }
    if (this.textByRoomTile.has(incomingKey) || this.textByRoomTile.size < MAX_ACTIVE_ROOM_STREAMS) {
      return
    }
    let oldestKey = ''
    let oldestUpdatedAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.textByRoomTile) {
      if (entry.updatedAt < oldestUpdatedAt) {
        oldestKey = key
        oldestUpdatedAt = entry.updatedAt
      }
    }
    if (oldestKey) this.textByRoomTile.delete(oldestKey)
  }

  record(scope: ChatStreamScope, event: Record<string, unknown>): void {
    if (!scope.workspaceId || !scope.cardId) return
    const key = chatStreamScopeKey(scope)
    const type = String(event.type ?? '')
    const now = Date.now()
    this.prune(now, key)

    if (type === 'text' || type === 'assistant' || type === 'delta') {
      this.erroredScopes.delete(key)
      const rawChunk = event.text ?? event.delta ?? ''
      const chunk = typeof rawChunk === 'string' ? rawChunk : String(rawChunk)
      if (chunk) {
        const boundedChunk = utf8Tail(chunk, MAX_ROOM_STREAM_SUMMARY_BYTES)
        this.textByRoomTile.set(key, {
          text: utf8Tail(
            `${this.textByRoomTile.get(key)?.text ?? ''}${boundedChunk}`,
            MAX_ROOM_STREAM_SUMMARY_BYTES,
          ),
          updatedAt: now,
        })
      }
      return
    }

    if (type === 'error') {
      this.textByRoomTile.delete(key)
      if (
        !this.erroredScopes.has(key)
        && this.erroredScopes.size >= MAX_ACTIVE_ROOM_STREAMS
      ) {
        const oldestKey = [...this.erroredScopes.entries()]
          .sort((a, b) => a[1] - b[1])[0]?.[0]
        if (oldestKey) this.erroredScopes.delete(oldestKey)
      }
      this.erroredScopes.set(key, now)
      this.complete(scope.workspaceId, scope.cardId, 'error')
      return
    }

    if (type !== 'done') return
    if (this.erroredScopes.delete(key)) return
    const summary = (this.textByRoomTile.get(key)?.text ?? '').trim()
    this.textByRoomTile.delete(key)
    if (summary) this.publish(scope.workspaceId, scope.cardId, summary)
    this.complete(scope.workspaceId, scope.cardId, 'done')
  }
}
