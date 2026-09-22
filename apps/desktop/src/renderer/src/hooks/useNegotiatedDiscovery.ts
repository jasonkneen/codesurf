import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import type { AppSettings, GroupState, LockedConnection, TileState } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { stripCapabilityPrefix, getAllNodeTools } from '../../../shared/nodeTools'
import { getAllTileIds, type PanelNode } from '../components/panelLayoutTree'
import {
  addAssociatedDiscoveryConnections,
  buildExtActionsByTileId,
  cascadeDiscoveryConnections,
  findDiscoveryMatch,
  findBestAnchorPair,
  getCapabilityMatches,
  getDiscoveryMaxDistance,
  getOrthogonalRoute,
  getTileCapabilities,
  getTileSpatialReference,
  uniq,
  type DiscoveryCapabilityLink,
} from '../lib/discoveryRuntime'
import {
  getBezierConnectionMidpoint,
  getBezierConnectionPath,
  getLaneOffsets,
  getOppositeAnchorSide,
  getRouteSignature,
  offsetOrthogonalRoute,
} from '../lib/connectionRoutes'
import { useDiscoveryGraph } from './useDiscoveryGraph'
import type { CanvasDragState } from './useCanvasEngine'

const GRID = 20

export type NegotiatedDiscoveryState = {
  connectedTileIds: Set<string>
  byTileConnections: Map<string, DiscoveryCapabilityLink[]>
  ambientRoutes: Array<{ key: string, route: { x: number, y: number }[], locked: boolean }>
}

export type ManualConnectionRenderRoute = {
  key: string
  sourceTileId: string
  targetTileId: string
  source: { x: number, y: number, side: string }
  target: { x: number, y: number, side: string }
  path: string
  midpoint: { x: number, y: number }
}

export type AmbientDiscoveryRenderRoute = {
  key: string
  route: { x: number, y: number }[]
  locked: boolean
  baseRoute: { x: number, y: number }[]
  displayRoute: { x: number, y: number }[]
}

export type UseNegotiatedDiscoveryParams = {
  autoConnectionsEnabled: boolean
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode | null
  panelTileIds: Set<string>
  settings: AppSettings
  lockedConnections: LockedConnection[]
  suppressedConnections: Set<string>
  extActionsVersion: number
  dragState: CanvasDragState
  selectedTileId: string | null
  viewportZoom: number
  workspaceId: string | undefined
  workspacePath: string | undefined
  activeChatTileId: string | null
  tileByIdMap: Map<string, TileState>
  preferredBrowserOpenTargetRef: MutableRefObject<string | null>
}

export function useNegotiatedDiscovery(params: UseNegotiatedDiscoveryParams) {
  const {
    autoConnectionsEnabled,
    tiles,
    groups,
    panelLayout,
    panelTileIds,
    settings,
    lockedConnections,
    suppressedConnections,
    extActionsVersion,
    dragState,
    selectedTileId,
    viewportZoom,
    workspaceId,
    workspacePath,
    activeChatTileId,
    tileByIdMap,
    preferredBrowserOpenTargetRef,
  } = params

  const discoveryFocusTileId = useMemo(() => {
    if (dragState.type === 'tile' || dragState.type === 'resize') return dragState.tileId
    return selectedTileId
  }, [dragState, selectedTileId])

  const discoveryPreview = useMemo(() => {
    if (!autoConnectionsEnabled) return null
    if (!discoveryFocusTileId) return null
    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    return findDiscoveryMatch(discoveryFocusTileId, tiles, panelTileIds, gridStep, maxDistance)
  }, [autoConnectionsEnabled, discoveryFocusTileId, panelTileIds, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, tiles])

  const extActionsByTileId = useMemo(() => buildExtActionsByTileId(), [extActionsVersion])

  const discoveryGridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
  const discoveryMaxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
  const hiddenTileIds = useMemo(() => new Set<string>(), [])

  const workerDiscoveryGraph = useDiscoveryGraph({
    tiles,
    hiddenTileIds,
    gridStep: discoveryGridStep,
    maxDistance: discoveryMaxDistance,
    extActionsByTileId,
    enabled: autoConnectionsEnabled,
  })

  const negotiatedDiscoveryState = useMemo<NegotiatedDiscoveryState>(() => {
    const gridStep = discoveryGridStep
    const maxDistance = discoveryMaxDistance
    const routes = new Map<string, { key: string, route: { x: number, y: number }[], distance: number, locked: boolean }>()

    const connectionGraph = autoConnectionsEnabled
      ? {
          connectedTileIds: new Set(workerDiscoveryGraph.connectedTileIds),
          byTile: new Map(Array.from(workerDiscoveryGraph.byTile.entries()).map(([k, v]) => [k, [...v]])),
        }
      : { connectedTileIds: new Set<string>(), byTile: new Map<string, DiscoveryCapabilityLink[]>() }

    for (const key of suppressedConnections) {
      const [a, b] = key.split('::')
      const aLinks = connectionGraph.byTile.get(a)
      if (aLinks) connectionGraph.byTile.set(a, aLinks.filter(l => l.peerId !== b))
      const bLinks = connectionGraph.byTile.get(b)
      if (bLinks) connectionGraph.byTile.set(b, bLinks.filter(l => l.peerId !== a))
      routes.delete(key)
    }

    const tileMap = new Map(tiles.map(t => [t.id, t]))
    for (const lc of lockedConnections) {
      const src = tileMap.get(lc.sourceTileId)
      const tgt = tileMap.get(lc.targetTileId)
      if (!src || !tgt) continue
      const existingLinks = connectionGraph.byTile.get(src.id)
      const alreadyLinkedByProximity = existingLinks?.some(l => l.peerId === tgt.id) ?? false
      const srcCaps = getTileCapabilities(src)
      const tgtCaps = getTileCapabilities(tgt)
      const srcRef = getTileSpatialReference(src, gridStep)
      const tgtRef = getTileSpatialReference(tgt, gridStep)
      const pair = findBestAnchorPair(srcRef.anchors, tgtRef.anchors)
      if (!pair) continue
      const route = getOrthogonalRoute(pair.source, pair.target, gridStep)
      const dist = pair.distance
      const sharedCaps = getCapabilityMatches(srcCaps, tgtCaps)
      const srcTools = srcCaps.tools ?? []
      const tgtTools = tgtCaps.tools ?? []

      if (!alreadyLinkedByProximity) {
        const srcLink: DiscoveryCapabilityLink = {
          peerId: tgt.id,
          peerType: tgt.type,
          distance: dist,
          route,
          capabilities: uniq([...tgtTools, ...sharedCaps]),
          lastSeen: Date.now(),
        }
        const tgtLink: DiscoveryCapabilityLink = {
          peerId: src.id,
          peerType: src.type,
          distance: dist,
          route: [...route].reverse(),
          capabilities: uniq([...srcTools, ...sharedCaps]),
          lastSeen: Date.now(),
        }
        connectionGraph.connectedTileIds.add(src.id)
        connectionGraph.connectedTileIds.add(tgt.id)
        const srcLinks = connectionGraph.byTile.get(src.id) ?? []
        srcLinks.push(srcLink)
        connectionGraph.byTile.set(src.id, srcLinks)
        const tgtLinks = connectionGraph.byTile.get(tgt.id) ?? []
        tgtLinks.push(tgtLink)
        connectionGraph.byTile.set(tgt.id, tgtLinks)
      }

      const key = [src.id, tgt.id].sort().join('::')
      routes.set(key, { key, route, distance: dist, locked: true })
    }

    // Skip O(n²) findDiscoveryMatch during active drags — the discovery
    // graph doesn't need to be recomputed while tiles are moving. This
    // prevents frame drops during drag with many tiles.
    const isActiveDrag = dragState.type === 'tile' || dragState.type === 'group' || dragState.type === 'resize' || dragState.type === 'connection'
    if (autoConnectionsEnabled && !isActiveDrag) {
      for (const tile of tiles) {
        const discovery = findDiscoveryMatch(tile.id, tiles, new Set(), gridStep, maxDistance)
        if (!discovery?.match) continue

        const key = [tile.id, discovery.match.tile.id].sort().join('::')
        if (suppressedConnections.has(key)) continue
        const existing = routes.get(key)
        if (existing?.locked) continue
        if (!existing || discovery.match.distance < existing.distance) {
          routes.set(key, {
            key,
            route: discovery.match.route,
            distance: discovery.match.distance,
            locked: false,
          })
        }
      }
    }

    const associatedTileGroups: string[][] = []
    if (panelLayout) {
      const panelTileGroup = getAllTileIds(panelLayout)
      if (panelTileGroup.length > 1) associatedTileGroups.push(panelTileGroup)
    }
    for (const group of groups) {
      if (!group.layoutMode) continue
      const memberTileIds = tiles.filter(tile => tile.groupId === group.id).map(tile => tile.id)
      if (memberTileIds.length > 1) associatedTileGroups.push(memberTileIds)
    }

    const associatedConnectionGraph = associatedTileGroups.length > 0
      ? addAssociatedDiscoveryConnections(connectionGraph, tiles, associatedTileGroups, gridStep)
      : connectionGraph
    const cascadedConnectionGraph = cascadeDiscoveryConnections(associatedConnectionGraph, tiles, gridStep)

    return {
      connectedTileIds: cascadedConnectionGraph.connectedTileIds,
      byTileConnections: cascadedConnectionGraph.byTile,
      ambientRoutes: Array.from(routes.values()).map(({ key, route, locked }) => ({ key, route, locked })),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnectionsEnabled, panelLayout, panelTileIds, groups, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, tiles, lockedConnections, suppressedConnections, extActionsVersion, workerDiscoveryGraph])

  useEffect(() => {
    const sourceTileIds = [activeChatTileId, selectedTileId].filter((value): value is string => Boolean(value))
    let nextTarget: string | null = null

    for (const sourceTileId of sourceTileIds) {
      const sourceTile = tileByIdMap.get(sourceTileId)
      if (!sourceTile) continue
      if (sourceTile.type === 'browser') {
        nextTarget = sourceTile.id
        break
      }
      const links = negotiatedDiscoveryState.byTileConnections.get(sourceTileId) ?? []
      const browserPeer = links.find(link => tileByIdMap.get(link.peerId)?.type === 'browser')
      if (browserPeer) {
        nextTarget = browserPeer.peerId
        break
      }
    }

    if (!nextTarget) {
      const browserTiles = tiles.filter(tile => tile.type === 'browser')
      if (browserTiles.length === 1) nextTarget = browserTiles[0].id
    }

    preferredBrowserOpenTargetRef.current = nextTarget
  }, [activeChatTileId, selectedTileId, negotiatedDiscoveryState.byTileConnections, tileByIdMap, tiles, preferredBrowserOpenTargetRef])

  const prevPeerLinksRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!workspaceId || !workspacePath) return
    const validTools = new Set(getAllNodeTools().map(t => t.name))
    const newMap = new Map<string, string>()

    for (const tile of tiles) {
      const links = negotiatedDiscoveryState.byTileConnections.get(tile.id)
      const peers = (links ?? []).map(link => {
        const tools: string[] = []
        for (const cap of link.capabilities) {
          if (!cap.startsWith('tool:')) continue
          const name = stripCapabilityPrefix(cap)
          if (name && validTools.has(name)) tools.push(name)
        }
        return { peerId: link.peerId, peerType: link.peerType, tools }
      }).sort((a, b) => a.peerId.localeCompare(b.peerId))
      const key = JSON.stringify(peers)
      const previousKey = prevPeerLinksRef.current.get(tile.id)
      if (peers.length === 0 && previousKey === undefined) continue
      newMap.set(tile.id, key)

      if (previousKey !== key) {
        void window.electron?.terminal?.updatePeers?.(
          tile.id,
          workspaceId,
          workspacePath,
          peers,
        )
      }
    }

    for (const [tileId] of prevPeerLinksRef.current) {
      if (!newMap.has(tileId)) {
        void window.electron?.terminal?.updatePeers?.(
          tileId,
          workspaceId,
          workspacePath,
          [],
        )
      }
    }

    prevPeerLinksRef.current = newMap
  }, [negotiatedDiscoveryState.byTileConnections, tiles, workspaceId, workspacePath])

  const lockedConnectionKeys = useMemo(() => {
    return new Set(lockedConnections.map(lc => [lc.sourceTileId, lc.targetTileId].sort().join('::')))
  }, [lockedConnections])

  const manualConnectionRenderRoutes = useMemo<ManualConnectionRenderRoute[]>(() => {
    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const tileMap = new Map(tiles.map(tile => [tile.id, tile]))
    return lockedConnections.flatMap(connection => {
      const sourceTile = tileMap.get(connection.sourceTileId)
      const targetTile = tileMap.get(connection.targetTileId)
      if (!sourceTile || !targetTile) return []
      if (panelTileIds.has(sourceTile.id) || panelTileIds.has(targetTile.id)) return []
      const sourceAnchors = getTileSpatialReference(sourceTile, gridStep).anchors
      const targetAnchors = getTileSpatialReference(targetTile, gridStep).anchors
      const preferredPair = findBestAnchorPair(
        sourceAnchors.flatMap(sourceAnchor => {
          const matchingTargets = targetAnchors.filter(targetAnchor => targetAnchor.side === getOppositeAnchorSide(sourceAnchor.side))
          return matchingTargets.length ? [sourceAnchor] : []
        }),
        targetAnchors,
      )
      const pair = findBestAnchorPair(
        sourceAnchors,
        targetAnchors,
      )
      const facingPair = preferredPair
        ? {
          source: preferredPair.source,
          target: targetAnchors.filter(targetAnchor => targetAnchor.side === getOppositeAnchorSide(preferredPair.source.side))
            .sort((a, b) => Math.abs(a.x - preferredPair.source.x) + Math.abs(a.y - preferredPair.source.y) - (Math.abs(b.x - preferredPair.source.x) + Math.abs(b.y - preferredPair.source.y)))[0] ?? preferredPair.target,
          distance: preferredPair.distance,
        }
        : pair
      if (!facingPair) return []
      const key = [sourceTile.id, targetTile.id].sort().join('::')
      return [{
        key,
        sourceTileId: sourceTile.id,
        targetTileId: targetTile.id,
        source: facingPair.source,
        target: facingPair.target,
        path: getBezierConnectionPath(facingPair.source, facingPair.target),
        midpoint: getBezierConnectionMidpoint(facingPair.source, facingPair.target),
      }]
    })
  }, [lockedConnections, panelTileIds, settings.gridSize, settings.gridSpacingSmall, tiles])

  const ambientDiscoveryRoutes = useMemo(() => {
    const visibleRoutes = negotiatedDiscoveryState.ambientRoutes.filter(r => {
      const [a, b] = r.key.split('::')
      return !panelTileIds.has(a) && !panelTileIds.has(b)
    })
    if (discoveryFocusTileId) {
      return visibleRoutes.filter(r => !lockedConnectionKeys.has(r.key) && !r.locked)
    }
    return visibleRoutes.filter(route => !lockedConnectionKeys.has(route.key) && !route.locked)
  }, [discoveryFocusTileId, negotiatedDiscoveryState, lockedConnectionKeys, panelTileIds])

  const ambientDiscoveryRenderRoutes = useMemo<AmbientDiscoveryRenderRoute[]>(() => {
    if (ambientDiscoveryRoutes.length === 0) return []

    const worldLaneSpacing = 12 / Math.max(0.25, viewportZoom)
    const grouped = new Map<string, Array<typeof ambientDiscoveryRoutes[number]>>()

    for (const route of ambientDiscoveryRoutes) {
      const signature = getRouteSignature(route.route)
      const group = grouped.get(signature) ?? []
      group.push(route)
      grouped.set(signature, group)
    }

    const offsets = new Map<string, number>()
    for (const routes of grouped.values()) {
      const laneOffsets = getLaneOffsets(routes.length).map(offset => offset * worldLaneSpacing)
      const orderedRoutes = [...routes].sort((a, b) => {
        if (a.locked !== b.locked) return a.locked ? -1 : 1
        return a.key.localeCompare(b.key)
      })
      orderedRoutes.forEach((route, index) => {
        offsets.set(route.key, laneOffsets[index] ?? 0)
      })
    }

    return ambientDiscoveryRoutes.map(route => ({
      ...route,
      baseRoute: route.route,
      displayRoute: offsetOrthogonalRoute(route.route, offsets.get(route.key) ?? 0),
    }))
  }, [ambientDiscoveryRoutes, viewportZoom])

  return {
    discoveryFocusTileId,
    discoveryPreview,
    negotiatedDiscoveryState,
    lockedConnectionKeys,
    manualConnectionRenderRoutes,
    ambientDiscoveryRoutes,
    ambientDiscoveryRenderRoutes,
  }
}
