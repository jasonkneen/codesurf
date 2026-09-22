import type { McpPrincipal } from './auth.ts'
import { isValidAgentRoomId } from '../agent-room/validation.ts'

export type PeerWorkspaceScope =
  | { ok: true, workspaceId: string }
  | { ok: false, error: string }

/**
 * Peer tools may target another connected tile, but never another workspace.
 * Tile tokens carry their authoritative workspace. Global callers must name it.
 */
export function resolvePeerWorkspaceScope(
  principal: McpPrincipal,
  requestedWorkspaceId: unknown,
): PeerWorkspaceScope {
  const requested = typeof requestedWorkspaceId === 'string'
    ? requestedWorkspaceId.trim()
    : ''

  if (requested && !isValidAgentRoomId(requested)) {
    return { ok: false, error: 'Invalid workspace_id' }
  }

  if (principal.kind === 'tile') {
    if (!isValidAgentRoomId(principal.workspaceId)) {
      return { ok: false, error: 'Invalid authenticated workspace scope' }
    }
    if (requested && requested !== principal.workspaceId) {
      return { ok: false, error: 'Forbidden: token scope does not match the requested workspace' }
    }
    return { ok: true, workspaceId: principal.workspaceId }
  }

  if (!requested) return { ok: false, error: 'Missing workspace_id' }
  return { ok: true, workspaceId: requested }
}

export function peerTileChannel(workspaceId: string, tileId: string): string {
  return `tile:${workspaceId}:${tileId}`
}
