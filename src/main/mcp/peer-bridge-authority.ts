import type { McpPrincipal } from './auth.ts'
import { resolveAuthoritativeCanvasPeers } from '../chat/peer-authority-policy.ts'
import { getTileNodeTools } from '../../shared/nodeTools.ts'
import type { TileType } from '../../shared/types.ts'

function ownData(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function targetTileType(canvas: unknown, targetTileId: string): string | null {
  const tiles = ownData(canvas, 'tiles')
  if (!Array.isArray(tiles)) return null
  for (const tile of tiles.slice(0, 2_048)) {
    if (ownData(tile, 'id') !== targetTileId) continue
    const type = ownData(tile, 'type')
    return typeof type === 'string' && type.trim() ? type.trim() : null
  }
  return null
}

/**
 * Validate peer dispatch against current workspace canvas function state.
 * Canvas state is renderer-replaceable and is not a privileged trust root;
 * this check only prevents a tile credential from reaching an unconnected or
 * type-incompatible sink. The target handler remains the authority for the
 * requested operation and its permission checks.
 */
export function authorizePeerBridgeTarget(options: {
  principal: McpPrincipal
  workspaceId: string
  targetTileId: string
  toolName: string
  canvas: unknown
}): { ok: true; tileType: string } | { ok: false; error: string } {
  const { principal, workspaceId, targetTileId, toolName, canvas } = options
  const tileType = targetTileType(canvas, targetTileId)
  if (!tileType) return { ok: false, error: 'Forbidden: target tile is not present in this workspace' }

  if (principal.kind === 'tile') {
    if (principal.workspaceId !== workspaceId) {
      return { ok: false, error: 'Forbidden: target is outside the authenticated workspace' }
    }
    if (principal.tileId === targetTileId) {
      return { ok: false, error: 'Forbidden: peer tools cannot target the caller tile' }
    }
    const connected = resolveAuthoritativeCanvasPeers(canvas, principal.tileId)
      .some(peer => peer.peerId === targetTileId)
    if (!connected) {
      return { ok: false, error: 'Forbidden: target tile is not a current connected peer' }
    }
  }

  const exposesTool = getTileNodeTools(tileType as TileType).some(tool => tool.name === toolName)
  if (!exposesTool) {
    return { ok: false, error: `Forbidden: ${tileType} tiles do not expose ${toolName}` }
  }
  return { ok: true, tileType }
}

/**
 * The peer-authority half of authorizePeerBridgeTarget, without the
 * node-tool-exposure requirement.
 *
 * For callers that dispatch INTO a tile by a mechanism other than the node-tool
 * bridge — ext_invoke_action and tile_context_set broadcast `tileContext:changed`,
 * which ExtensionTile turns into a `codesurf-action-invoke` postMessage — but
 * which must still obey the same authority: same workspace, never the caller's
 * own tile, and only a currently connected peer. Those handlers previously did
 * an existence check alone, so an agent in any tile could drive any other tile
 * it had no wire to.
 */
export function authorizePeerTileTarget(options: {
  principal: McpPrincipal
  workspaceId: string
  targetTileId: string
  canvas: unknown
  /** Writing your OWN tile's context is the normal case; only cross-tile reach needs a wire. */
  allowSelf?: boolean
}): { ok: true; tileType: string | null } | { ok: false; error: string } {
  const { principal, workspaceId, targetTileId, canvas, allowSelf = false } = options
  const tileType = targetTileType(canvas, targetTileId) ?? null

  // A workspace/global token already passed workspace scoping and has no peer
  // graph to consult — its reach within the workspace is what the token means.
  if (principal.kind !== 'tile') return { ok: true, tileType }

  if (principal.workspaceId !== workspaceId) {
    return { ok: false, error: 'Forbidden: target is outside the authenticated workspace' }
  }

  if (principal.tileId === targetTileId) {
    if (allowSelf) return { ok: true, tileType }
    return { ok: false, error: 'Forbidden: peer tools cannot target the caller tile' }
  }

  // Cross-tile: the caller must have a current wire to the target. If canvas
  // state cannot be read we cannot prove that, so refuse — fail closed.
  const connected = resolveAuthoritativeCanvasPeers(canvas, principal.tileId)
    .some(peer => peer.peerId === targetTileId)
  if (!connected) {
    return { ok: false, error: 'Forbidden: target tile is not a current connected peer' }
  }

  return { ok: true, tileType }
}
