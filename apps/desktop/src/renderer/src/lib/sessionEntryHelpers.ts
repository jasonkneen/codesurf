import type { AggregatedSessionEntry, SessionEntryHint } from '../../../shared/session-types'
import type { TileState } from '../../../shared/types'
import { getChatTileRuntimeState } from '../components/chatTileRuntimeState'

export function isRuntimeSessionEntryId(sessionEntryId: string): boolean {
  return sessionEntryId.startsWith('codesurf-runtime:')
    || sessionEntryId.startsWith('codesurf-tile:')
    || sessionEntryId.startsWith('codesurf-job:')
}

export function buildSessionEntryHint(session: AggregatedSessionEntry): SessionEntryHint {
  return {
    id: session.id,
    source: session.source,
    filePath: session.filePath,
    sessionId: session.sessionId,
    provider: session.provider,
    model: session.model,
    messageCount: session.messageCount,
    title: session.title,
    projectPath: session.projectPath ?? null,
  }
}

export type ChatTileSessionMatch = { entryId: string | null; sessionId: string | null }

export function findMatchingChatTileIdForSession(
  workspaceId: string,
  tiles: TileState[],
  session: AggregatedSessionEntry,
  chatTileSessionMatches: Record<string, ChatTileSessionMatch>,
): string | null {
  return tiles.find(tile => {
    if (tile.type !== 'chat') return false
    if (session.tileId && tile.id === session.tileId) return true
    const remembered = chatTileSessionMatches[tile.id]
    const runtimeState = getChatTileRuntimeState<{ linkedSessionEntryId?: string | null }>(
      workspaceId,
      tile.id,
    )
    return remembered?.entryId === session.id || runtimeState?.linkedSessionEntryId === session.id
  })?.id ?? null
}
