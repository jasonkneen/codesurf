export type TileContextChangedPayload = {
  action?: string
  workspaceId: string
  tileId: string
  key: string
  value: unknown
}

export function tileContextChannel(workspaceId: string, tileId: string): string {
  return `ctx:${workspaceId}:${tileId}`
}

export function isTileContextChangeForScope(
  value: unknown,
  workspaceId: string,
  tileId: string,
): value is TileContextChangedPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<TileContextChangedPayload>
  return payload.workspaceId === workspaceId && payload.tileId === tileId
}
