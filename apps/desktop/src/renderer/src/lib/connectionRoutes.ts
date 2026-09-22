import type { TileState } from '../../../shared/types'
import type { AnchorPoint, AnchorSide } from '../workers/discovery-graph-impl'

const DEFAULT_GRID = 20

function snap(v: number, grid = DEFAULT_GRID): number {
  return Math.round(v / grid) * grid
}

function makeAnchor(side: AnchorSide, x: number, y: number, grid: number): AnchorPoint {
  const snappedX = snap(x, grid)
  const snappedY = snap(y, grid)
  return {
    side,
    x: snappedX,
    y: snappedY,
    gridX: Math.round(snappedX / grid),
    gridY: Math.round(snappedY / grid),
  }
}

export function routeToSvgPath(points: { x: number; y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

export function getConnectionHandlePoint(tile: TileState, side: AnchorPoint['side'] = 'right', grid = DEFAULT_GRID): AnchorPoint {
  if (side === 'left') return makeAnchor(side, tile.x - 18, tile.y + tile.height / 2, grid)
  if (side === 'top') return makeAnchor(side, tile.x + tile.width / 2, tile.y - 18, grid)
  if (side === 'bottom') return makeAnchor(side, tile.x + tile.width / 2, tile.y + tile.height + 18, grid)
  return makeAnchor(side, tile.x + tile.width + 18, tile.y + tile.height / 2, grid)
}

export function getNearestTileSide(tile: TileState, point: { x: number; y: number }): AnchorPoint['side'] {
  const distances: Array<{ side: AnchorPoint['side']; distance: number }> = [
    { side: 'left', distance: Math.abs(point.x - tile.x) },
    { side: 'right', distance: Math.abs(point.x - (tile.x + tile.width)) },
    { side: 'top', distance: Math.abs(point.y - tile.y) },
    { side: 'bottom', distance: Math.abs(point.y - (tile.y + tile.height)) },
  ]
  distances.sort((a, b) => a.distance - b.distance)
  return distances[0]?.side ?? 'right'
}

export function getOppositeAnchorSide(side: AnchorPoint['side']): AnchorPoint['side'] {
  if (side === 'left') return 'right'
  if (side === 'right') return 'left'
  if (side === 'top') return 'bottom'
  return 'top'
}

export function getTileCenter(tile: TileState): { x: number; y: number } {
  return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }
}

export function getBezierConnectionPath(source: { x: number; y: number }, target: { x: number; y: number }, sag = 0): string {
  const geometry = getBezierConnectionGeometry(source, target, sag)
  return `M ${source.x} ${source.y} C ${geometry.c1.x} ${geometry.c1.y}, ${geometry.c2.x} ${geometry.c2.y}, ${target.x} ${target.y}`
}

export function getBezierConnectionGeometry(
  source: { x: number; y: number },
  target: { x: number; y: number },
  sag = 0,
): { c1: { x: number; y: number }; c2: { x: number; y: number } } {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const distance = Math.hypot(dx, dy)
  const bend = Math.min(180, Math.max(48, distance * 0.34))
  const direction = dx >= 0 ? 1 : -1
  const gravity = Math.min(120, Math.max(20, distance * 0.16)) + sag
  const c1 = { x: source.x + bend * direction, y: source.y + gravity * 0.35 }
  const c2 = { x: target.x - bend * direction, y: target.y + gravity }
  return { c1, c2 }
}

export function getBezierConnectionMidpoint(source: { x: number; y: number }, target: { x: number; y: number }): { x: number; y: number } {
  const dx = target.x - source.x
  const distance = Math.hypot(dx, target.y - source.y)
  return {
    x: source.x + dx * 0.5,
    y: source.y + (target.y - source.y) * 0.5 + Math.min(72, Math.max(18, distance * 0.10)),
  }
}

export function getRouteSegments(
  points: { x: number; y: number }[],
  thickness = 3,
): Array<{ left: number; top: number; width: number; height: number; horizontal: boolean }> {
  const segments: Array<{ left: number; top: number; width: number; height: number; horizontal: boolean }> = []

  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1]
    const end = points[i]
    const horizontal = start.y === end.y
    if (horizontal) {
      segments.push({
        left: Math.min(start.x, end.x),
        top: start.y - thickness / 2,
        width: Math.max(Math.abs(end.x - start.x), thickness),
        height: thickness,
        horizontal: true,
      })
    } else {
      segments.push({
        left: start.x - thickness / 2,
        top: Math.min(start.y, end.y),
        width: thickness,
        height: Math.max(Math.abs(end.y - start.y), thickness),
        horizontal: false,
      })
    }
  }

  return segments
}

export function getRouteMidpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length <= 1) return points[0] ?? { x: 0, y: 0 }

  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y)
  }

  let remaining = total / 2
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1]
    const end = points[i]
    const segment = Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
    if (remaining <= segment) {
      if (start.x === end.x) {
        const direction = end.y >= start.y ? 1 : -1
        return { x: start.x, y: start.y + remaining * direction }
      }
      const direction = end.x >= start.x ? 1 : -1
      return { x: start.x + remaining * direction, y: start.y }
    }
    remaining -= segment
  }

  return points[points.length - 1]
}

export function getRouteSignature(points: { x: number; y: number }[]): string {
  const forward = points.map(point => `${point.x},${point.y}`).join('|')
  const reverse = [...points].reverse().map(point => `${point.x},${point.y}`).join('|')
  return forward < reverse ? forward : reverse
}

export function getLaneOffsets(count: number): number[] {
  if (count <= 1) return [0]
  const offsets: number[] = []
  if (count % 2 === 1) offsets.push(0)
  let step = count % 2 === 1 ? 1 : 0.5
  while (offsets.length < count) {
    offsets.push(-step, step)
    step += 1
  }
  return offsets.slice(0, count)
}

export function offsetOrthogonalRoute(points: { x: number; y: number }[], offset: number): { x: number; y: number }[] {
  if (!offset || points.length <= 1) return points

  return points.map((point, index) => {
    const prev = index > 0 ? points[index - 1] : null
    const next = index < points.length - 1 ? points[index + 1] : null
    const touchesHorizontal = (prev ? prev.y === point.y : false) || (next ? next.y === point.y : false)
    const touchesVertical = (prev ? prev.x === point.x : false) || (next ? next.x === point.x : false)

    return {
      x: point.x + (touchesVertical ? offset : 0),
      y: point.y + (touchesHorizontal ? offset : 0),
    }
  })
}

export function formatGridBounds(bounds: { left: number; top: number; right: number; bottom: number }): string {
  return `${bounds.left},${bounds.top} → ${bounds.right},${bounds.bottom}`
}