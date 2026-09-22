import type { TileState } from '../../../shared/types'
import { addAssociatedConnectionGroups, cascadeConnectionGraph } from '../../../shared/connectionGraph'
import {
  findBestAnchorPair,
  getCapabilityMatches,
  getDiscoveryMaxDistance,
  getOrthogonalRoute,
  getTileCapabilities as getTileCapabilitiesFromImpl,
  getTileSpatialReference as getTileSpatialReferenceFromImpl,
  rectsOverlap,
  uniq,
  type DiscoveryState,
  type ExtActionsByTileId,
  type TileCapabilitySet,
  type TileSpatialReference,
} from '../workers/discovery-graph-impl'

export type {
  AnchorPoint,
  AnchorSide,
  DiscoveryCapabilityLink,
  DiscoveryState,
  TileCapabilitySet,
  TileSpatialReference,
} from '../workers/discovery-graph-impl'

export { getDiscoveryMaxDistance, uniq }

export type DiscoveryMatch = {
  tile: TileState
  route: { x: number; y: number }[]
  distance: number
  matchLabels: string[]
  targetRef: TileSpatialReference
}

export type DiscoveryPulse = {
  id: string
  sourceTileId: string
  targetTileId: string
  route: { x: number; y: number }[]
  startedAt: number
  durationMs: number
  matchLabels: string[]
  sourceGridLabel: string
  targetGridLabel: string
}

export const DISCOVERY_PULSE_DURATION_MS = 1100

// Extension action registry — extensions register actions at runtime; these become
// tool capabilities so connected peers (especially chat tiles) can discover them.
export const extensionActionRegistry = new Map<string, Array<{ name: string; description: string }>>()

export function buildExtActionsByTileId(): ExtActionsByTileId {
  const map = new Map<string, string[]>()
  for (const [tileId, actions] of extensionActionRegistry) {
    map.set(tileId, actions.map(action => action.name))
  }
  return map
}

export function getTileCapabilities(tile: TileState): TileCapabilitySet {
  return getTileCapabilitiesFromImpl(tile, buildExtActionsByTileId())
}

export function getTileSpatialReference(tile: TileState, grid: number): TileSpatialReference {
  return getTileSpatialReferenceFromImpl(tile, grid, buildExtActionsByTileId())
}

export function cascadeDiscoveryConnections(
  graph: DiscoveryState,
  tileList: TileState[],
  gridStep: number,
): DiscoveryState {
  const capabilitiesByTile = new Map(tileList.map(tile => [tile.id, getTileCapabilities(tile)]))
  const refs = new Map(tileList.map(tile => [tile.id, getTileSpatialReference(tile, gridStep)]))
  return cascadeConnectionGraph(graph, tileList, {
    resolveCapabilities: (sourceTileId, targetTileId) => {
      const sourceCaps = capabilitiesByTile.get(sourceTileId)
      const targetCaps = capabilitiesByTile.get(targetTileId)
      if (!sourceCaps || !targetCaps) return []
      return uniq([...(targetCaps.tools ?? []), ...getCapabilityMatches(sourceCaps, targetCaps)])
    },
    resolveRoute: (sourceTileId, targetTileId) => {
      const sourceRef = refs.get(sourceTileId)
      const targetRef = refs.get(targetTileId)
      const pair = sourceRef && targetRef ? findBestAnchorPair(sourceRef.anchors, targetRef.anchors) : null
      return pair ? { route: getOrthogonalRoute(pair.source, pair.target, gridStep), distance: pair.distance } : null
    },
  })
}

export function addAssociatedDiscoveryConnections(
  graph: DiscoveryState,
  tileList: TileState[],
  associatedTileGroups: string[][],
  gridStep: number,
): DiscoveryState {
  const capabilitiesByTile = new Map(tileList.map(tile => [tile.id, getTileCapabilities(tile)]))
  const refs = new Map(tileList.map(tile => [tile.id, getTileSpatialReference(tile, gridStep)]))
  return addAssociatedConnectionGroups(graph, tileList, associatedTileGroups, {
    resolveCapabilities: (sourceTileId, targetTileId) => {
      const sourceCaps = capabilitiesByTile.get(sourceTileId)
      const targetCaps = capabilitiesByTile.get(targetTileId)
      if (!sourceCaps || !targetCaps) return []
      return uniq([...(targetCaps.tools ?? []), ...getCapabilityMatches(sourceCaps, targetCaps)])
    },
    resolveRoute: (sourceTileId, targetTileId) => {
      const sourceRef = refs.get(sourceTileId)
      const targetRef = refs.get(targetTileId)
      const pair = sourceRef && targetRef ? findBestAnchorPair(sourceRef.anchors, targetRef.anchors) : null
      return pair ? { route: getOrthogonalRoute(pair.source, pair.target, gridStep), distance: pair.distance } : null
    },
  })
}

export function findDiscoveryMatch(
  sourceTileId: string,
  tileList: TileState[],
  hiddenTileIds: Set<string>,
  gridStep: number,
  maxDistance: number,
): { sourceRef: TileSpatialReference; match: DiscoveryMatch | null } | null {
  const sourceTile = tileList.find(tile => tile.id === sourceTileId)
  if (!sourceTile || hiddenTileIds.has(sourceTile.id)) return null

  const sourceRef = getTileSpatialReference(sourceTile, gridStep)
  let bestCompatible: DiscoveryMatch | null = null
  let bestFallback: DiscoveryMatch | null = null

  for (const candidate of tileList) {
    if (candidate.id === sourceTileId || hiddenTileIds.has(candidate.id)) continue
    const sourceRect = { x: sourceTile.x, y: sourceTile.y, w: sourceTile.width, h: sourceTile.height }
    const targetRect = { x: candidate.x, y: candidate.y, w: candidate.width, h: candidate.height }
    if (rectsOverlap(sourceRect, targetRect)) continue

    const targetRef = getTileSpatialReference(candidate, gridStep)
    const anchorPair = findBestAnchorPair(sourceRef.anchors, targetRef.anchors)
    if (!anchorPair || anchorPair.distance > maxDistance) continue

    const candidateMatch: DiscoveryMatch = {
      tile: candidate,
      route: getOrthogonalRoute(anchorPair.source, anchorPair.target, gridStep),
      distance: anchorPair.distance,
      matchLabels: getCapabilityMatches(sourceRef.capabilities, targetRef.capabilities),
      targetRef,
    }

    if (!bestFallback || candidateMatch.distance < bestFallback.distance) {
      bestFallback = candidateMatch
    }

    if (candidateMatch.matchLabels.length && (!bestCompatible || candidateMatch.distance < bestCompatible.distance)) {
      bestCompatible = candidateMatch
    }
  }

  const match = bestCompatible ?? (bestFallback ? {
    ...bestFallback,
    matchLabels: bestFallback.matchLabels.length ? bestFallback.matchLabels : ['nearest'],
  } : null)

  return { sourceRef, match }
}

// Re-export geometry helpers used by negotiated connection injection.
export { findBestAnchorPair, getCapabilityMatches, getOrthogonalRoute }