import { clearTileMessages } from './chat/chatMessagesStore.ts'

const chatTileRuntimeState = new Map<string, unknown>()
const disposedChatTiles = new Set<string>()
// The tombstone set only needs to reject late async writes that race a recent
// disposal, so bound it — without a cap it grows by one UUID per chat tile ever
// deleted for the whole renderer session.
const DISPOSED_TOMBSTONE_CAP = 256

function getWorkspaceTileKey(workspaceId: string, tileId: string): string {
  return JSON.stringify([workspaceId, tileId])
}

export function getChatTileRuntimeState<T>(
  workspaceId: string,
  tileId: string,
): T | null {
  const key = getWorkspaceTileKey(workspaceId, tileId)
  if (disposedChatTiles.has(key)) return null
  return (chatTileRuntimeState.get(key) as T | undefined) ?? null
}

export function setChatTileRuntimeState<T>(
  workspaceId: string,
  tileId: string,
  state: T,
): void {
  const key = getWorkspaceTileKey(workspaceId, tileId)
  if (disposedChatTiles.has(key)) return
  chatTileRuntimeState.set(key, state)
}

export function disposeChatTileRuntimeState(
  workspaceId: string,
  tileId: string,
): void {
  const key = getWorkspaceTileKey(workspaceId, tileId)
  disposedChatTiles.add(key)
  chatTileRuntimeState.delete(key)
  clearTileMessages(workspaceId, tileId)
  if (disposedChatTiles.size > DISPOSED_TOMBSTONE_CAP) {
    // Sets preserve insertion order; evict the oldest tombstone.
    const oldest = disposedChatTiles.values().next().value
    if (oldest !== undefined) disposedChatTiles.delete(oldest)
  }
}

export function reviveChatTileRuntimeState(
  workspaceId: string,
  tileId: string,
): void {
  disposedChatTiles.delete(getWorkspaceTileKey(workspaceId, tileId))
}

export function isChatTileRuntimeStateDisposed(
  workspaceId: string,
  tileId: string,
): boolean {
  return disposedChatTiles.has(getWorkspaceTileKey(workspaceId, tileId))
}
