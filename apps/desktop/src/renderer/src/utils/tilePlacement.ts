import type { TileState } from '../../../shared/types'

export const TILE_PLACEMENT_GRID = 20

export function getMinTileWidth(tileOrType: TileState | TileState['type']): number {
  const type = typeof tileOrType === 'string' ? tileOrType : tileOrType.type
  if (type === 'chat') return 450
  if (type === 'files') return 250
  if (type === 'file') return 200
  if (type.startsWith('ext:')) return 150
  return 200
}

export function getMinTileHeight(tileOrType: TileState | TileState['type']): number {
  const type = typeof tileOrType === 'string' ? tileOrType : tileOrType.type
  if (type === 'files') return 300
  if (type === 'file') return 200
  if (type.startsWith('ext:')) return 100
  return 150
}

export function rectsOverlap(
  a: { x: number, y: number, w: number, h: number },
  b: { x: number, y: number, w: number, h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function findClearPosition(
  preferredX: number,
  preferredY: number,
  width: number,
  height: number,
  tiles: TileState[],
  blockedTileIds: Set<string>,
  step: number,
): { x: number, y: number } {
  const overlapsExisting = (x: number, y: number) => {
    const candidate = { x, y, w: width, h: height }
    return tiles.some(tile => !blockedTileIds.has(tile.id) && rectsOverlap(candidate, { x: tile.x, y: tile.y, w: tile.width, h: tile.height }))
  }

  let x = preferredX
  let y = preferredY
  if (!overlapsExisting(x, y)) return { x, y }

  const maxRings = 120
  for (let ring = 1; ring <= maxRings; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      const dy = ring - Math.abs(dx)
      const candidates = dy === 0
        ? [{ dx: dx * step, dy: 0 }]
        : [{ dx: dx * step, dy: dy * step }, { dx: dx * step, dy: -dy * step }]

      for (const cand of candidates) {
        x = preferredX + cand.dx
        y = preferredY + cand.dy
        if (!overlapsExisting(x, y)) {
          return { x, y }
        }
      }
    }
  }

  return { x, y }
}