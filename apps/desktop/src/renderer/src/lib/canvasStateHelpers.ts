import type { LockedConnection } from '../../../shared/types'
import { normalizeLocalPathCandidate } from '../utils/links'

export const DEFAULT_CANVAS_GRID = 20

export function snapToCanvasGrid(value: number, grid = DEFAULT_CANVAS_GRID): number {
  return Math.round(value / grid) * grid
}

export function dedupeLockedConnections(connections: LockedConnection[]): LockedConnection[] {
  const seen = new Set<string>()
  const next: LockedConnection[] = []
  for (const connection of connections) {
    const sourceTileId = connection.sourceTileId?.trim()
    const targetTileId = connection.targetTileId?.trim()
    if (!sourceTileId || !targetTileId || sourceTileId === targetTileId) continue
    const [left, right] = sourceTileId < targetTileId
      ? [sourceTileId, targetTileId]
      : [targetTileId, sourceTileId]
    const key = `${left}::${right}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push({ sourceTileId, targetTileId })
  }
  return next
}

export function hrefToLocalPath(href: string): string | null {
  return normalizeLocalPathCandidate(href)
}