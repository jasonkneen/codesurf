/**
 * Electron-free MCP auth primitives: resolve a bearer token to a principal
 * and check that a tile-scoped principal only targets its own tile.
 *
 * Kept separate from mcp-server.ts (which imports `electron`) so it can be
 * unit-tested under plain `node --test`.
 */

export type McpPrincipal =
  | { kind: 'global' }
  | { kind: 'tile', workspaceId: string, tileId: string }

export interface TileTokenRecord {
  workspaceId: string
  tileId: string
  token: string
}

/**
 * Resolve a presented bearer/query token to a principal.
 *
 * `tileTokens` maps an opaque composite registry key to a workspace-bound
 * record. We match on the token VALUE, not the map key — presenting a bare
 * tile or workspace ID as a token must never authenticate. Legacy tile-only
 * string entries deliberately fail closed because they lack workspace scope.
 */
export function resolvePrincipal(
  token: string | null,
  globalToken: string,
  tileTokens: ReadonlyMap<string, TileTokenRecord | string>,
): McpPrincipal | null {
  if (!token) return null
  if (token === globalToken) return { kind: 'global' }
  for (const record of tileTokens.values()) {
    if (
      typeof record !== 'string'
      && record.token === token
      && record.workspaceId
      && record.tileId
    ) {
      return {
        kind: 'tile',
        workspaceId: record.workspaceId,
        tileId: record.tileId,
      }
    }
  }
  return null
}

/**
 * Enforce that a tile-scoped principal only acts on its own tile.
 * Returns an error message string when the check fails, or null when the
 * caller is authorized (global principals are always authorized).
 */
export function assertTileScope(
  principal: McpPrincipal,
  targetWorkspaceId: string | undefined | null,
  targetTileId: string | undefined | null,
): string | null {
  if (principal.kind === 'global') return null
  if (targetWorkspaceId === principal.workspaceId && targetTileId === principal.tileId) return null
  return 'Forbidden: token scope does not match the requested workspace and tile'
}
