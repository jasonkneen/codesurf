import type { TileState } from '../../../shared/types'

export const ALIGN_GUIDE_THRESH = 6

export type AlignmentGuide = { x?: number; y?: number }

export function filterTilesForAlignmentGuides(
  x: number,
  y: number,
  width: number,
  height: number,
  tiles: TileState[],
  margin = ALIGN_GUIDE_THRESH,
): TileState[] {
  const minX = x - margin
  const minY = y - margin
  const maxX = x + width + margin
  const maxY = y + height + margin

  return tiles.filter(tile => (
    tile.x <= maxX
    && tile.x + tile.width >= minX
    && tile.y <= maxY
    && tile.y + tile.height >= minY
  ))
}

export function computeAlignmentGuides(
  newX: number,
  newY: number,
  width: number,
  height: number,
  others: TileState[],
): AlignmentGuide[] {
  const newGuides: AlignmentGuide[] = []
  for (const other of others) {
    const dxChecks: [number, number][] = [
      [newX, other.x],
      [newX, other.x + other.width / 2 - width / 2],
      [newX, other.x + other.width - width],
      [newX + width / 2, other.x + other.width / 2],
      [newX + width, other.x],
      [newX + width, other.x + other.width],
    ]
    for (const [a, b] of dxChecks) {
      if (Math.abs(a - b) < ALIGN_GUIDE_THRESH) newGuides.push({ x: b })
    }

    const dyChecks: [number, number][] = [
      [newY, other.y],
      [newY, other.y + other.height / 2 - height / 2],
      [newY, other.y + other.height - height],
      [newY + height / 2, other.y + other.height / 2],
      [newY + height, other.y],
      [newY + height, other.y + other.height],
    ]
    for (const [a, b] of dyChecks) {
      if (Math.abs(a - b) < ALIGN_GUIDE_THRESH) newGuides.push({ y: b })
    }
  }

  const seen = new Set<string>()
  return newGuides.filter(guide => {
    const key = guide.x !== undefined ? `x:${guide.x}` : `y:${guide.y}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}