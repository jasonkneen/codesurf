/**
 * Pure (worker-safe) implementation of the O(n²) discovery-connection finder.
 *
 * This module is imported by both:
 *   1. `discovery-graph.worker.ts` — runs the heavy compute off the main thread
 *   2. `useDiscoveryGraph.ts` — runs the same code inline as the n<10 fallback
 *      and as the worker-unavailable fallback.
 *
 * Crucially, this file imports NOTHING from React or App.tsx — only types from
 * `shared/`. That keeps it loadable inside a worker context where DOM/React
 * are unavailable.
 *
 * The code below is a copy of the same-named functions in App.tsx, with one
 * difference: `getTileCapabilities` here accepts an explicit
 * `extActionsByTileId` map instead of reading the global mutable
 * `extensionActionRegistry` (which doesn't exist in worker context).
 *
 * If the App.tsx originals diverge from this file, the divergence will surface
 * as a connection-graph mismatch between worker and main-thread fallback.
 * Keep the two in sync until we delete the App.tsx duplicates in a follow-up.
 */
import type { TileState, TileType } from '../../../shared/types'
import { getTileNodeTools, withCapabilityPrefix } from '../../../shared/nodeTools'

// ─── Types (mirrored from App.tsx) ───────────────────────────────────────
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left'

export type TileCapabilitySet = {
  provides: string[]
  accepts: string[]
  tools?: string[]
}

export type AnchorPoint = {
  side: AnchorSide
  x: number
  y: number
  gridX: number
  gridY: number
}

export type TileSpatialReference = {
  tileId: string
  bounds: { left: number; top: number; right: number; bottom: number }
  gridBounds: { left: number; top: number; right: number; bottom: number }
  anchors: AnchorPoint[]
  capabilities: TileCapabilitySet
}

export type DiscoveryCapabilityLink = {
  peerId: string
  peerType: TileType
  distance: number
  route: { x: number; y: number }[]
  capabilities: string[]
  lastSeen: number
}

export type DiscoveryState = {
  connectedTileIds: Set<string>
  byTile: Map<string, DiscoveryCapabilityLink[]>
}

export type ExtActionsByTileId = Map<string, string[]>

const DISCOVERY_MAX_DISTANCE_MULTIPLIER = 2.1

// ─── Utilities ───────────────────────────────────────────────────────────
export function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

export function getDiscoveryMaxDistance(largeGridStep: number): number {
  return Math.max(largeGridStep * DISCOVERY_MAX_DISTANCE_MULTIPLIER, largeGridStep)
}

function snapValue(v: number, grid: number): number {
  return Math.round(v / grid) * grid
}

export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

// ─── Capabilities ────────────────────────────────────────────────────────
export function getTileCapabilities(
  tile: TileState,
  extActionsByTileId: ExtActionsByTileId,
): TileCapabilitySet {
  const base: TileCapabilitySet = (() => {
    if (tile.type === 'terminal') return { provides: ['output', 'task', 'reference'], accepts: ['file', 'task', 'reference'] }
    if (tile.type === 'code' || tile.type === 'note' || tile.type === 'file') return { provides: ['file', 'text', 'reference'], accepts: ['task', 'output', 'reference'] }
    if (tile.type === 'browser') return { provides: ['url', 'web', 'reference'], accepts: ['text', 'task', 'reference'] }
    if (tile.type === 'chat') return { provides: ['task', 'text', 'reference'], accepts: ['file', 'output', 'reference'] }
    if (tile.type === 'files') return { provides: ['file', 'reference'], accepts: ['task', 'reference'] }
    if (tile.type === 'kanban') return { provides: ['task', 'reference'], accepts: ['task', 'text', 'reference'] }
    if (tile.type === 'image') return { provides: ['image', 'reference'], accepts: ['text', 'reference'] }
    if (tile.type.startsWith('ext:')) return { provides: ['task', 'reference'], accepts: ['task', 'text', 'reference'] }
    return { provides: ['reference'], accepts: ['reference'] }
  })()

  const toolNames = getTileNodeTools(tile.type).map(tool => tool.name)
  if (tile.type.startsWith('ext:')) {
    const dynamic = extActionsByTileId.get(tile.id)
    if (dynamic) toolNames.push(...dynamic)
  }
  return { ...base, tools: toolNames.map(withCapabilityPrefix) }
}

export function getCapabilityMatches(source: TileCapabilitySet, target: TileCapabilitySet): string[] {
  return uniq([
    ...source.provides.filter(value => target.accepts.includes(value)),
    ...target.provides.filter(value => source.accepts.includes(value)),
  ])
}

// ─── Spatial reference ───────────────────────────────────────────────────
function makeAnchor(side: AnchorSide, x: number, y: number, grid: number): AnchorPoint {
  const sx = snapValue(x, grid)
  const sy = snapValue(y, grid)
  return { side, x: sx, y: sy, gridX: Math.round(sx / grid), gridY: Math.round(sy / grid) }
}

export function getTileSpatialReference(
  tile: TileState,
  grid: number,
  extActionsByTileId: ExtActionsByTileId,
): TileSpatialReference {
  return {
    tileId: tile.id,
    bounds: { left: tile.x, top: tile.y, right: tile.x + tile.width, bottom: tile.y + tile.height },
    gridBounds: {
      left: Math.round(tile.x / grid),
      top: Math.round(tile.y / grid),
      right: Math.round((tile.x + tile.width) / grid),
      bottom: Math.round((tile.y + tile.height) / grid),
    },
    anchors: [
      makeAnchor('top', tile.x + tile.width / 2, tile.y, grid),
      makeAnchor('right', tile.x + tile.width, tile.y + tile.height / 2, grid),
      makeAnchor('bottom', tile.x + tile.width / 2, tile.y + tile.height, grid),
      makeAnchor('left', tile.x, tile.y + tile.height / 2, grid),
    ],
    capabilities: getTileCapabilities(tile, extActionsByTileId),
  }
}

export function findBestAnchorPair(
  sourceAnchors: AnchorPoint[],
  targetAnchors: AnchorPoint[],
): { source: AnchorPoint; target: AnchorPoint; distance: number } | null {
  let best: { source: AnchorPoint; target: AnchorPoint; distance: number } | null = null
  for (const source of sourceAnchors) {
    for (const target of targetAnchors) {
      const distance = Math.abs(source.x - target.x) + Math.abs(source.y - target.y)
      if (!best || distance < best.distance) best = { source, target, distance }
    }
  }
  return best
}

function stepOutFromAnchor(anchor: AnchorPoint, step: number): { x: number; y: number } {
  if (anchor.side === 'left') return { x: anchor.x - step, y: anchor.y }
  if (anchor.side === 'right') return { x: anchor.x + step, y: anchor.y }
  if (anchor.side === 'top') return { x: anchor.x, y: anchor.y - step }
  return { x: anchor.x, y: anchor.y + step }
}

function simplifyRoute(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const deduped = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  if (deduped.length <= 2) return deduped
  const simplified = [deduped[0]]
  for (let i = 1; i < deduped.length - 1; i += 1) {
    const prev = simplified[simplified.length - 1]
    const current = deduped[i]
    const next = deduped[i + 1]
    const collinear = (prev.x === current.x && current.x === next.x) || (prev.y === current.y && current.y === next.y)
    if (!collinear) simplified.push(current)
  }
  simplified.push(deduped[deduped.length - 1])
  return simplified
}

export function getOrthogonalRoute(source: AnchorPoint, target: AnchorPoint, step: number): { x: number; y: number }[] {
  const sourceLead = stepOutFromAnchor(source, step)
  const targetLead = stepOutFromAnchor(target, step)
  const points: { x: number; y: number }[] = [{ x: source.x, y: source.y }, sourceLead]
  if (sourceLead.x !== targetLead.x && sourceLead.y !== targetLead.y) {
    const horizontalFirst = source.side === 'left' || source.side === 'right'
    points.push(horizontalFirst
      ? { x: targetLead.x, y: sourceLead.y }
      : { x: sourceLead.x, y: targetLead.y })
  }
  points.push(targetLead, { x: target.x, y: target.y })
  return simplifyRoute(points)
}

// ─── The hot path: O(n²) pairwise discovery ──────────────────────────────
export function findDiscoveryConnections(
  tileList: TileState[],
  hiddenTileIds: Set<string>,
  gridStep: number,
  maxDistance: number,
  extActionsByTileId: ExtActionsByTileId,
): DiscoveryState {
  const connectedTileIds = new Set<string>()
  const byTile = new Map<string, DiscoveryCapabilityLink[]>()
  const refs = tileList
    .filter(tile => !hiddenTileIds.has(tile.id))
    .map(tile => ({ tile, ref: getTileSpatialReference(tile, gridStep, extActionsByTileId) }))

  for (let i = 0; i < refs.length; i += 1) {
    const source = refs[i]
    for (let j = i + 1; j < refs.length; j += 1) {
      const target = refs[j]
      if (source.tile.id === target.tile.id) continue

      const sourceRect = { x: source.tile.x, y: source.tile.y, w: source.tile.width, h: source.tile.height }
      const targetRect = { x: target.tile.x, y: target.tile.y, w: target.tile.width, h: target.tile.height }
      if (rectsOverlap(sourceRect, targetRect)) continue

      const anchorPair = findBestAnchorPair(source.ref.anchors, target.ref.anchors)
      if (!anchorPair || anchorPair.distance > maxDistance) continue

      const sharedCaps = getCapabilityMatches(source.ref.capabilities, target.ref.capabilities)
      const route = getOrthogonalRoute(anchorPair.source, anchorPair.target, gridStep)
      const sourceTools = source.ref.capabilities.tools ?? []
      const targetTools = target.ref.capabilities.tools ?? []

      if (sharedCaps.length > 0) {
        const sourceLink: DiscoveryCapabilityLink = {
          peerId: target.tile.id,
          peerType: target.tile.type,
          distance: anchorPair.distance,
          route,
          capabilities: uniq([...targetTools, ...sharedCaps]),
          lastSeen: Date.now(),
        }
        const targetLink: DiscoveryCapabilityLink = {
          peerId: source.tile.id,
          peerType: source.tile.type,
          distance: anchorPair.distance,
          route: route.slice().reverse(),
          capabilities: uniq([...sourceTools, ...sharedCaps]),
          lastSeen: Date.now(),
        }

        const nextSource = byTile.get(source.tile.id) ?? []
        const nextTarget = byTile.get(target.tile.id) ?? []
        nextSource.push(sourceLink)
        nextTarget.push(targetLink)
        byTile.set(source.tile.id, nextSource)
        byTile.set(target.tile.id, nextTarget)
        connectedTileIds.add(source.tile.id)
        connectedTileIds.add(target.tile.id)
      }
    }
  }

  return { connectedTileIds, byTile }
}

// ─── Serialization helpers (Set/Map don't survive postMessage cleanly) ──
export interface DiscoveryWorkerInput {
  tiles: TileState[]
  hiddenTileIds: string[]
  gridStep: number
  maxDistance: number
  extActions: Array<[string, string[]]>
}

export interface DiscoveryWorkerOutput {
  connectedTileIds: string[]
  byTile: Array<[string, DiscoveryCapabilityLink[]]>
}

export function runDiscoveryPipeline(input: DiscoveryWorkerInput): DiscoveryWorkerOutput {
  const extActionsByTileId = new Map(input.extActions)
  const hidden = new Set(input.hiddenTileIds)
  const result = findDiscoveryConnections(input.tiles, hidden, input.gridStep, input.maxDistance, extActionsByTileId)
  return {
    connectedTileIds: Array.from(result.connectedTileIds),
    byTile: Array.from(result.byTile.entries()),
  }
}

export function deserializeDiscoveryOutput(out: DiscoveryWorkerOutput): DiscoveryState {
  return {
    connectedTileIds: new Set(out.connectedTileIds),
    byTile: new Map(out.byTile),
  }
}
