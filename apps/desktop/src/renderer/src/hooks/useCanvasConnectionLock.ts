/**
 * Expanded-group, lock-connection, min-size, and locked-connection helpers.
 * Extracted from useCanvasEngine.
 */
import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { TileState, GroupState } from '../../../shared/types.ts'
import type { CanvasViewport, PersistCanvasStateFn, SaveCanvasFn } from './canvasEngineMath.ts'
import { computeFitViewport } from './canvasEngineMath.ts'

export type LockedConnection = { sourceTileId: string; targetTileId: string }

function normalizedConnectionPair(tileA: string, tileB: string): [string, string] {
  return [tileA, tileB].sort() as [string, string]
}

export function isLockedConnection(
  connections: LockedConnection[],
  tileA: string,
  tileB: string,
): boolean {
  const [a, b] = normalizedConnectionPair(tileA, tileB)
  return connections.some(connection => {
    const [source, target] = normalizedConnectionPair(
      connection.sourceTileId,
      connection.targetTileId,
    )
    return source === a && target === b
  })
}

export function toggleLockedConnection(
  connections: LockedConnection[],
  tileA: string,
  tileB: string,
): LockedConnection[] {
  const [a, b] = normalizedConnectionPair(tileA, tileB)
  const index = connections.findIndex(connection => {
    const [source, target] = normalizedConnectionPair(
      connection.sourceTileId,
      connection.targetTileId,
    )
    return source === a && target === b
  })
  return index >= 0
    ? connections.filter((_, candidateIndex) => candidateIndex !== index)
    : [...connections, { sourceTileId: a, targetTileId: b }]
}

export function deleteLockedConnection(
  connections: LockedConnection[],
  tileA: string,
  tileB: string,
): LockedConnection[] {
  if (!isLockedConnection(connections, tileA, tileB)) return connections
  return toggleLockedConnection(connections, tileA, tileB)
}

export type ExpandedGroupTransitionState = {
  expandedGroupId: string | null
  viewport: CanvasViewport
  priorViewport: CanvasViewport | null
}

export function enterExpandedGroupState(options: {
  group: GroupState | undefined
  bounds: { x: number; y: number; w: number; h: number } | null
  canvasSize: { w: number; h: number } | null
  currentViewport: CanvasViewport
}): ExpandedGroupTransitionState | null {
  const { group, bounds, canvasSize, currentViewport } = options
  if (!group || group.layoutMode || !bounds || !canvasSize) return null
  return {
    expandedGroupId: group.id,
    viewport: computeFitViewport(bounds, canvasSize),
    priorViewport: { ...currentViewport },
  }
}

export function exitExpandedGroupState(
  state: ExpandedGroupTransitionState,
): ExpandedGroupTransitionState {
  return {
    expandedGroupId: null,
    viewport: state.priorViewport ? { ...state.priorViewport } : state.viewport,
    priorViewport: null,
  }
}

export type UseCanvasExpandedGroupOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  viewportRef: MutableRefObject<CanvasViewport>
  expandedCanvasPriorViewportRef: MutableRefObject<CanvasViewport | null>
  expandedCanvasGroupIdRef: MutableRefObject<string | null>
  groupsRef: MutableRefObject<GroupState[]>
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  setExpandedCanvasGroupId: Dispatch<SetStateAction<string | null>>
  setExpandedTileId: Dispatch<SetStateAction<string | null>>
  groupBounds: (groupId: string) => { x: number; y: number; w: number; h: number } | null
}

export function useCanvasExpandedGroup(options: UseCanvasExpandedGroupOptions) {
  const {
    canvasRef,
    viewportRef,
    expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef,
    groupsRef,
    setViewport,
    setExpandedCanvasGroupId,
    setExpandedTileId,
    groupBounds,
  } = options

  const enterCanvasExpanded = useCallback((groupId: string) => {
    const g = groupsRef.current.find(gr => gr.id === groupId)
    const bounds = groupBounds(groupId)
    const rect = canvasRef.current?.getBoundingClientRect()
    const transition = enterExpandedGroupState({
      group: g,
      bounds,
      canvasSize: rect ? { w: rect.width, h: rect.height } : null,
      currentViewport: viewportRef.current,
    })
    if (!transition) return
    expandedCanvasPriorViewportRef.current = transition.priorViewport
    setViewport(transition.viewport)
    viewportRef.current = transition.viewport
    setExpandedCanvasGroupId(transition.expandedGroupId)
    expandedCanvasGroupIdRef.current = transition.expandedGroupId
    setExpandedTileId(null)
  }, [
    canvasRef,
    viewportRef,
    expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef,
    groupsRef,
    setViewport,
    setExpandedCanvasGroupId,
    setExpandedTileId,
    groupBounds,
  ])

  const exitCanvasExpanded = useCallback(() => {
    const transition = exitExpandedGroupState({
      expandedGroupId: expandedCanvasGroupIdRef.current,
      viewport: viewportRef.current,
      priorViewport: expandedCanvasPriorViewportRef.current,
    })
    setExpandedCanvasGroupId(transition.expandedGroupId)
    expandedCanvasGroupIdRef.current = transition.expandedGroupId
    setViewport(transition.viewport)
    viewportRef.current = transition.viewport
    expandedCanvasPriorViewportRef.current = transition.priorViewport
  }, [
    expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef,
    setViewport,
    viewportRef,
    setExpandedCanvasGroupId,
  ])

  return { enterCanvasExpanded, exitCanvasExpanded }
}

export type UseLockConnectionOptions = {
  persistCanvasState: PersistCanvasStateFn
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndexRef: MutableRefObject<number>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  setLockedConnections: Dispatch<SetStateAction<Array<{ sourceTileId: string; targetTileId: string }>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
}

export function useLockConnection(options: UseLockConnectionOptions) {
  const {
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  } = options

  return useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    if (a === b) return
    setSuppressedConnections(prev => {
      const next = new Set(prev)
      next.delete(`${a}::${b}`)
      return next
    })
    setLockedConnections(prev => {
      const alreadyLocked = prev.some(lc => {
        const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
        return la === a && lb === b
      })
      if (alreadyLocked) return prev
      const next = [...prev, { sourceTileId: a, targetTileId: b }]
      lockedConnectionsRef.current = next
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
  }, [
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  ])
}

export type UseEnforceTileMinimumSizesOptions = {
  tiles: TileState[]
  viewport: CanvasViewport
  nextZIndex: number
  saveCanvas: SaveCanvasFn
  setTiles: Dispatch<SetStateAction<TileState[]>>
  getMinTileWidth: (tileOrType: TileState | TileState['type']) => number
  getMinTileHeight: (tileOrType: TileState | TileState['type']) => number
}

export function useEnforceTileMinimumSizes(options: UseEnforceTileMinimumSizesOptions): void {
  const { tiles, viewport, nextZIndex, saveCanvas, setTiles, getMinTileWidth, getMinTileHeight } = options

  useEffect(() => {
    if (!tiles.some(tile => tile.width < getMinTileWidth(tile) || tile.height < getMinTileHeight(tile))) return
    setTiles(prev => {
      let changed = false
      const updated = prev.map(tile => {
        const minW = getMinTileWidth(tile)
        const minH = getMinTileHeight(tile)
        if (tile.width >= minW && tile.height >= minH) return tile
        changed = true
        return {
          ...tile,
          width: Math.max(tile.width, minW),
          height: Math.max(tile.height, minH),
        }
      })
      if (!changed) return prev
      saveCanvas(updated, viewport, nextZIndex)
      return updated
    })
  }, [tiles, viewport, nextZIndex, saveCanvas, setTiles, getMinTileWidth, getMinTileHeight])
}

export type UseLockedConnectionHelpersOptions = {
  lockedConnections: Array<{ sourceTileId: string; targetTileId: string }>
  persistCanvasState: PersistCanvasStateFn
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndexRef: MutableRefObject<number>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  setLockedConnections: Dispatch<SetStateAction<Array<{ sourceTileId: string; targetTileId: string }>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
}

export function useLockedConnectionHelpers(options: UseLockedConnectionHelpersOptions) {
  const {
    lockedConnections,
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  } = options

  const isConnectionLocked = useCallback((tileA: string, tileB: string) => {
    return isLockedConnection(lockedConnections, tileA, tileB)
  }, [lockedConnections])

  const toggleConnectionLock = useCallback((tileA: string, tileB: string) => {
    setLockedConnections(prev => {
      const wasLocked = isLockedConnection(prev, tileA, tileB)
      const next = toggleLockedConnection(prev, tileA, tileB)
      lockedConnectionsRef.current = next
      console.log('[Lock]', wasLocked ? 'Unlocked' : 'Locked', tileA, tileB, 'total:', next.length)
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
  }, [persistCanvasState, tilesRef, groupsRef, viewportRef, nextZIndexRef, lockedConnectionsRef, setLockedConnections])

  const deleteConnection = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    const key = `${a}::${b}`
    setLockedConnections(prev => {
      const next = deleteLockedConnection(prev, tileA, tileB)
      lockedConnectionsRef.current = next
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
    setSuppressedConnections(prev => new Set(prev).add(key))
  }, [persistCanvasState, tilesRef, groupsRef, viewportRef, nextZIndexRef, lockedConnectionsRef, setLockedConnections, setSuppressedConnections])

  return { isConnectionLocked, toggleConnectionLock, deleteConnection }
}
