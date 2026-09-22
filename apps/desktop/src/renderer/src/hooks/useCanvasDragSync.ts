import {
  useEffect,
  useRef,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
} from 'react'
import type { TileState, GroupState } from '../../../shared/types'
import { assignTileToGroup } from '../lib/layoutGroupMembership.ts'
import type { CanvasViewport } from './useCanvasEngine.ts'
import {
  computeAlignmentGuides,
  filterTilesForAlignmentGuides,
  type AlignmentGuide,
} from './canvasAlignment.ts'
import { perfFlags } from '../perfFlags.ts'

export type { AlignmentGuide } from './canvasAlignment.ts'
export { ALIGN_GUIDE_THRESH, computeAlignmentGuides, filterTilesForAlignmentGuides } from './canvasAlignment.ts'

// ─── Global canvas drag listeners ─────────────────────────────────────────────

export type CanvasAnchorSide = 'top' | 'right' | 'bottom' | 'left'

export type CanvasAnchorPoint = {
  side: CanvasAnchorSide
  x: number
  y: number
  gridX: number
  gridY: number
}

type CanvasDragEngine = {
  viewport: CanvasViewport
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  /** Live gesture viewport (includes uncommitted zoom from wheel mid-pan). */
  pendingViewportRef: MutableRefObject<CanvasViewport>
  panVelocityRef: MutableRefObject<{ vx: number, vy: number }>
  panLastPos: MutableRefObject<{ x: number, y: number, t: number }>
  startPanInertia: () => void
  screenToWorld: (sx: number, sy: number) => { x: number, y: number }
  saveCanvas: (tileList: TileState[], vp: CanvasViewport, nz: number, grps?: GroupState[], beforeTiles?: TileState[]) => void
  nextZIndex: number
  applyViewportGesture: (next: CanvasViewport) => void
}

export type CanvasDragState =
  | { type: null }
  | { type: 'pan'; startX: number; startY: number; initTx: number; initTy: number }
  | { type: 'tile'; tileId: string; startX: number; startY: number; initX: number; initY: number; groupSnapshots: { id: string; x: number; y: number }[] }
  | { type: 'resize'; tileId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initX: number; initY: number; initW: number; initH: number }
  | { type: 'select'; startWx: number; startWy: number; curWx: number; curWy: number }
  | { type: 'group'; groupId: string; startX: number; startY: number; snapshots: { id: string; x: number; y: number }[]; initLayoutBounds?: { x: number; y: number; w: number; h: number } }
  | { type: 'group-resize'; groupId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initBounds: { x: number; y: number; w: number; h: number }; snapshots: { id: string; x: number; y: number; width: number; height: number }[] }
  | { type: 'connection'; sourceTileId: string; startX: number; startY: number; side: CanvasAnchorSide; anchor: CanvasAnchorPoint; current: { x: number; y: number }; targetTileId: string | null }

export type UseCanvasDragSyncOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  dragState: CanvasDragState
  setDragState: Dispatch<SetStateAction<CanvasDragState>>
  engine: Pick<
    CanvasDragEngine,
    | 'viewport'
    | 'setViewport'
    | 'pendingViewportRef'
    | 'panVelocityRef'
    | 'panLastPos'
    | 'startPanInertia'
    | 'screenToWorld'
    | 'saveCanvas'
    | 'nextZIndex'
    | 'applyViewportGesture'
  >
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  groups: GroupState[]
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  setGuides: Dispatch<SetStateAction<AlignmentGuide[]>>
  setCanvasPointerWorld: Dispatch<SetStateAction<{ x: number; y: number } | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
  suppressedConnectionsRef: MutableRefObject<Set<string>>
  panelTileIdsRef: MutableRefObject<Set<string>>
  groupBoundsRef: MutableRefObject<(id: string) => { x: number; y: number; w: number; h: number } | null>
  snapValue: (value: number) => number
  resolveManualConnectionTarget: (sourceTileId: string, point: { x: number; y: number }) => string | null
  lockConnection: (tileA: string, tileB: string) => void
  triggerDiscoveryPulse: (tileId: string, tileList: TileState[]) => void
  getMinTileWidth: (tileOrType: TileState | TileState['type']) => number
  getMinTileHeight: (tileOrType: TileState | TileState['type']) => number
}

export function computeTileDragPosition(options: {
  dragState: Extract<CanvasDragState, { type: 'tile' }>
  clientX: number
  clientY: number
  zoom: number
  snapValue: (value: number) => number
}): { x: number; y: number; dx: number; dy: number } {
  const { dragState, clientX, clientY, zoom, snapValue } = options
  const x = snapValue(dragState.initX + (clientX - dragState.startX) / zoom)
  const y = snapValue(dragState.initY + (clientY - dragState.startY) / zoom)
  return { x, y, dx: x - dragState.initX, dy: y - dragState.initY }
}

export function applyResizeDragToTile(options: {
  tile: TileState
  dragState: Extract<CanvasDragState, { type: 'resize' }>
  clientX: number
  clientY: number
  zoom: number
  snapValue: (value: number) => number
  minWidth: number
  minHeight: number
}): TileState {
  const { tile, dragState, clientX, clientY, zoom, snapValue, minWidth, minHeight } = options
  const wdx = (clientX - dragState.startX) / zoom
  const wdy = (clientY - dragState.startY) / zoom
  const { dir } = dragState
  let { x, y, width, height } = tile
  if (dir.includes('e')) width = Math.max(minWidth, snapValue(dragState.initW + wdx))
  if (dir.includes('s')) height = Math.max(minHeight, snapValue(dragState.initH + wdy))
  if (dir.includes('w')) {
    width = Math.max(minWidth, snapValue(dragState.initW - wdx))
    x = snapValue(dragState.initX + wdx)
  }
  if (dir.includes('n')) {
    height = Math.max(minHeight, snapValue(dragState.initH - wdy))
    y = snapValue(dragState.initY + wdy)
  }
  return { ...tile, x, y, width, height }
}

type CanvasDragSnapshot = {
  id: string
  x: number
  y: number
  width?: number
  height?: number
}

export function indexCanvasTiles(tiles: readonly TileState[]): Map<string, number> {
  return new Map(tiles.map((tile, index) => [tile.id, index]))
}

export function indexCanvasDragSnapshots(
  dragState: CanvasDragState,
): ReadonlyMap<string, CanvasDragSnapshot> {
  if (dragState.type === 'tile') {
    const indexed = new Map<string, CanvasDragSnapshot>(
      dragState.groupSnapshots.map(snapshot => [snapshot.id, snapshot] as const),
    )
    indexed.set(dragState.tileId, {
      id: dragState.tileId,
      x: dragState.initX,
      y: dragState.initY,
    })
    return indexed
  }
  if (dragState.type === 'group' || dragState.type === 'group-resize') {
    return new Map<string, CanvasDragSnapshot>(
      dragState.snapshots.map(snapshot => [snapshot.id, snapshot] as const),
    )
  }
  return new Map()
}

function resolveIndexedTile(
  tiles: readonly TileState[],
  tileIndex: Map<string, number>,
  tileId: string,
): { index: number; tile: TileState } | null {
  const cachedIndex = tileIndex.get(tileId)
  if (cachedIndex !== undefined && tiles[cachedIndex]?.id === tileId) {
    return { index: cachedIndex, tile: tiles[cachedIndex] }
  }

  // Tile order can change asynchronously while a pointer gesture is active.
  // Validate the cached slot and repair only on that exceptional path.
  const actualIndex = tiles.findIndex(tile => tile.id === tileId)
  if (actualIndex < 0) {
    tileIndex.delete(tileId)
    return null
  }
  tileIndex.set(tileId, actualIndex)
  return { index: actualIndex, tile: tiles[actualIndex] }
}

export function getIndexedCanvasTile(
  tiles: readonly TileState[],
  tileIndex: Map<string, number>,
  tileId: string,
): TileState | null {
  return resolveIndexedTile(tiles, tileIndex, tileId)?.tile ?? null
}

export function updateIndexedCanvasTiles<TSnapshot extends { id: string }>(
  tiles: TileState[],
  tileIndex: Map<string, number>,
  snapshots: Iterable<TSnapshot>,
  update: (tile: TileState, snapshot: TSnapshot) => TileState,
): TileState[] {
  let next: TileState[] | null = null
  for (const snapshot of snapshots) {
    const resolved = resolveIndexedTile(tiles, tileIndex, snapshot.id)
    if (!resolved) continue
    const current = next?.[resolved.index] ?? resolved.tile
    const updated = update(current, snapshot)
    if (updated === current) continue
    if (!next) next = tiles.slice()
    next[resolved.index] = updated
  }
  return next ?? tiles
}

function canvasDragGestureKey(dragState: CanvasDragState): string | null {
  if (dragState.type === null) return null
  if (dragState.type === 'select') {
    return JSON.stringify(['select', dragState.startWx, dragState.startWy])
  }
  if (dragState.type === 'pan') {
    return JSON.stringify(['pan', dragState.startX, dragState.startY])
  }
  if (dragState.type === 'tile' || dragState.type === 'resize') {
    return JSON.stringify([dragState.type, dragState.tileId, dragState.startX, dragState.startY])
  }
  if (dragState.type === 'group' || dragState.type === 'group-resize') {
    return JSON.stringify([dragState.type, dragState.groupId, dragState.startX, dragState.startY])
  }
  return JSON.stringify(['connection', dragState.sourceTileId, dragState.startX, dragState.startY])
}

export function useCanvasDragSync(options: UseCanvasDragSyncOptions): void {
  const latestOptionsRef = useRef(options)
  latestOptionsRef.current = options
  const snapGuideRafRef = useRef<number | null>(null)
  /**
   * RAF coalescing for the non-tile drag branches (resize / group / group-resize
   * / connection / select). Mirrors the pendingTileDragRef pattern below: raw
   * mousemove events can fire far above frame rate, so only the LATEST update
   * closure runs, once per animation frame. Gated on perfFlags.dragRafCoalesce.
   */
  const pendingDragFrameRef = useRef<number | null>(null)
  const pendingDragUpdateRef = useRef<(() => void) | null>(null)
  const pendingTileDragRef = useRef<{
    tileId: string
    snapshots: ReadonlyMap<string, CanvasDragSnapshot>
    newX: number
    newY: number
    ddx: number
    ddy: number
    width: number
    height: number
  } | null>(null)
  /**
   * Snapshot of tile positions captured at drag START, before any setTiles
   * calls have updated tilesRef.  Passed to saveCanvas as `beforeTiles` so
   * the history diff is computed against pre-drag state (H-11 fix).
   */
  const preDragSnapshotRef = useRef<TileState[] | null>(null)
  const tileIndexRef = useRef<Map<string, number> | null>(null)
  const indexedDragSnapshotsRef = useRef<{
    gestureKey: string
    snapshots: ReadonlyMap<string, CanvasDragSnapshot>
  } | null>(null)
  const gestureKey = canvasDragGestureKey(options.dragState)

  useEffect(() => {
    // State updates during select/connection gestures no longer reinstall the
    // global listeners. This per-gesture effect owns only snapshot/index setup
    // and cancellation of a gesture that ends without a mouseup.
    if (snapGuideRafRef.current !== null) {
      cancelAnimationFrame(snapGuideRafRef.current)
      snapGuideRafRef.current = null
    }
    pendingTileDragRef.current = null
    if (pendingDragFrameRef.current !== null) {
      cancelAnimationFrame(pendingDragFrameRef.current)
      pendingDragFrameRef.current = null
    }
    pendingDragUpdateRef.current = null

    if (gestureKey === null) {
      preDragSnapshotRef.current = null
      tileIndexRef.current = null
      indexedDragSnapshotsRef.current = null
      return
    }

    const tiles = options.tilesRef.current
    preDragSnapshotRef.current = tiles.map(tile => ({ ...tile }))
    tileIndexRef.current = indexCanvasTiles(tiles)
    indexedDragSnapshotsRef.current = {
      gestureKey,
      snapshots: indexCanvasDragSnapshots(options.dragState),
    }
  }, [gestureKey, options.tilesRef])

  useEffect(() => {
    const ensureTileIndex = (tiles: readonly TileState[]) => {
      if (!tileIndexRef.current) tileIndexRef.current = indexCanvasTiles(tiles)
      return tileIndexRef.current
    }
    const getDragSnapshots = (dragState: CanvasDragState) => {
      const currentGestureKey = canvasDragGestureKey(dragState)
      const indexed = indexedDragSnapshotsRef.current
      if (currentGestureKey !== null && indexed?.gestureKey === currentGestureKey) {
        return indexed.snapshots
      }
      const snapshots = indexCanvasDragSnapshots(dragState)
      if (currentGestureKey !== null) {
        indexedDragSnapshotsRef.current = { gestureKey: currentGestureKey, snapshots }
      }
      return snapshots
    }

    // Latest-wins, once-per-frame execution for non-tile drag branches.
    // Falls back to immediate execution when the perf flag is off.
    const scheduleDragUpdate = (fn: () => void) => {
      if (!perfFlags.dragRafCoalesce) { fn(); return }
      pendingDragUpdateRef.current = fn
      if (pendingDragFrameRef.current !== null) return
      pendingDragFrameRef.current = requestAnimationFrame(() => {
        pendingDragFrameRef.current = null
        const pending = pendingDragUpdateRef.current
        pendingDragUpdateRef.current = null
        pending?.()
      })
    }
    const flushPendingDragUpdate = () => {
      if (pendingDragFrameRef.current !== null) {
        cancelAnimationFrame(pendingDragFrameRef.current)
        pendingDragFrameRef.current = null
      }
      const pending = pendingDragUpdateRef.current
      pendingDragUpdateRef.current = null
      pending?.()
    }

    const onMove = (e: MouseEvent) => {
      const {
        canvasRef,
        dragState,
        setDragState,
        engine,
        tilesRef,
        groupsRef,
        setTiles,
        setGroups,
        setCanvasPointerWorld,
        snapValue,
        resolveManualConnectionTarget,
        getMinTileWidth,
        getMinTileHeight,
      } = latestOptionsRef.current
      const {
        pendingViewportRef,
        panVelocityRef,
        panLastPos,
        screenToWorld,
        applyViewportGesture,
      } = engine

      if (dragState.type === null) return
      // Live viewport (incl. mid-gesture zoom) — never spread closed-over
      // `viewport` state for pan/zoom math or a wheel zoom mid-pan gets stomped.
      const liveVp = pendingViewportRef.current

      if (dragState.type === 'select') {
        scheduleDragUpdate(() => {
          const rect = canvasRef.current?.getBoundingClientRect()
          if (!rect) return
          const vp = pendingViewportRef.current
          const curWx = (e.clientX - rect.left - vp.tx) / vp.zoom
          const curWy = (e.clientY - rect.top - vp.ty) / vp.zoom
          setDragState(prev => prev.type === 'select' ? { ...prev, curWx, curWy } : prev)
        })
        return
      }
      const dx = e.clientX - dragState.startX
      const dy = e.clientY - dragState.startY

      if (dragState.type === 'pan') {
        const now = performance.now()
        const dt = now - panLastPos.current.t
        if (dt > 0) {
          const decay = 0.4
          panVelocityRef.current = {
            vx: decay * panVelocityRef.current.vx + (1 - decay) * (e.clientX - panLastPos.current.x) / dt * 16,
            vy: decay * panVelocityRef.current.vy + (1 - decay) * (e.clientY - panLastPos.current.y) / dt * 16,
          }
        }
        panLastPos.current = { x: e.clientX, y: e.clientY, t: now }
        // Keep live zoom; only pan translation comes from the drag delta.
        applyViewportGesture({
          ...liveVp,
          tx: dragState.initTx + dx,
          ty: dragState.initTy + dy,
        })
      } else if (dragState.type === 'group-resize') {
        scheduleDragUpdate(() => {
          const vp = pendingViewportRef.current
          const wdx = dx / vp.zoom
          const wdy = dy / vp.zoom
          const { dir, initBounds: ib } = dragState

          let nx = ib.x, ny = ib.y, nw = ib.w, nh = ib.h
          if (dir.includes('e')) nw = Math.max(100, ib.w + wdx)
          if (dir.includes('s')) nh = Math.max(100, ib.h + wdy)
          if (dir.includes('w')) { nw = Math.max(100, ib.w - wdx); nx = ib.x + ib.w - nw }
          if (dir.includes('n')) { nh = Math.max(100, ib.h - wdy); ny = ib.y + ib.h - nh }

          const resizingGroup = groupsRef.current.find(g => g.id === dragState.groupId)
          if (resizingGroup?.layoutMode) {
            setGroups(prev => prev.map(g => g.id === dragState.groupId
              ? { ...g, layoutBounds: { x: snapValue(nx), y: snapValue(ny), w: snapValue(nw), h: snapValue(nh) } }
              : g))
          } else {
            const scaleX = nw / ib.w
            const scaleY = nh / ib.h
            const indexedSnapshots = getDragSnapshots(dragState)
            setTiles(prev => updateIndexedCanvasTiles(
              prev,
              ensureTileIndex(prev),
              indexedSnapshots.values(),
              (t, s) => {
                if (s.width === undefined || s.height === undefined) return t
                const minW = getMinTileWidth(t)
                const minH = getMinTileHeight(t)
                const relX = s.x - ib.x
                const relY = s.y - ib.y
                return {
                  ...t,
                  x: snapValue(nx + relX * scaleX),
                  y: snapValue(ny + relY * scaleY),
                  width: Math.max(minW, snapValue(s.width * scaleX)),
                  height: Math.max(minH, snapValue(s.height * scaleY)),
                }
              },
            ))
          }
        })
      } else if (dragState.type === 'group') {
        scheduleDragUpdate(() => {
          const vp = pendingViewportRef.current
          const wdx = dx / vp.zoom
          const wdy = dy / vp.zoom
          if (dragState.initLayoutBounds) {
            const lb = dragState.initLayoutBounds
            setGroups(prev => prev.map(g => g.id === dragState.groupId ? {
              ...g,
              layoutBounds: { ...lb, x: snapValue(lb.x + wdx), y: snapValue(lb.y + wdy) },
            } : g))
          } else {
            const indexedSnapshots = getDragSnapshots(dragState)
            setTiles(prev => updateIndexedCanvasTiles(
              prev,
              ensureTileIndex(prev),
              indexedSnapshots.values(),
              (t, snapshot) => ({
                ...t,
                x: snapValue(snapshot.x + wdx),
                y: snapValue(snapshot.y + wdy),
              }),
            ))
          }
        })
      } else if (dragState.type === 'connection') {
        scheduleDragUpdate(() => {
          const current = screenToWorld(e.clientX, e.clientY)
          const targetTileId = resolveManualConnectionTarget(dragState.sourceTileId, current)
          setCanvasPointerWorld(current)
          setDragState(prev => prev.type === 'connection' ? { ...prev, current, targetTileId } : prev)
        })
      } else if (dragState.type === 'tile') {
        const { x: newX, y: newY, dx: ddx, dy: ddy } = computeTileDragPosition({
          dragState,
          clientX: e.clientX,
          clientY: e.clientY,
          zoom: liveVp.zoom,
          snapValue,
        })
        const dragging = getIndexedCanvasTile(
          tilesRef.current,
          ensureTileIndex(tilesRef.current),
          dragState.tileId,
        )
        if (!dragging) return

        pendingTileDragRef.current = {
          tileId: dragState.tileId,
          snapshots: getDragSnapshots(dragState),
          newX,
          newY,
          ddx,
          ddy,
          width: dragging.width,
          height: dragging.height,
        }
        if (snapGuideRafRef.current !== null) return
        snapGuideRafRef.current = requestAnimationFrame(() => {
          snapGuideRafRef.current = null
          const pending = pendingTileDragRef.current
          if (!pending) return

          const latest = latestOptionsRef.current
          const candidates = latest.tilesRef.current.filter(
            tile => !pending.snapshots.has(tile.id),
          )
          const others = filterTilesForAlignmentGuides(
            pending.newX,
            pending.newY,
            pending.width,
            pending.height,
            candidates,
          )
          latest.setGuides(computeAlignmentGuides(
            pending.newX,
            pending.newY,
            pending.width,
            pending.height,
            others,
          ))
          latest.setTiles(prev => updateIndexedCanvasTiles(
            prev,
            ensureTileIndex(prev),
            pending.snapshots.values(),
            (t, snapshot) => {
              if (snapshot.id === pending.tileId) {
                return { ...t, x: pending.newX, y: pending.newY }
              }
              return {
                ...t,
                x: latest.snapValue(snapshot.x + pending.ddx),
                y: latest.snapValue(snapshot.y + pending.ddy),
              }
            },
          ))
        })
      } else if (dragState.type === 'resize') {
        scheduleDragUpdate(() => {
          const vp = pendingViewportRef.current
          setTiles(prev => updateIndexedCanvasTiles(
            prev,
            ensureTileIndex(prev),
            [{ id: dragState.tileId }],
            t => applyResizeDragToTile({
              tile: t,
              dragState,
              clientX: e.clientX,
              clientY: e.clientY,
              zoom: vp.zoom,
              snapValue,
              minWidth: getMinTileWidth(t),
              minHeight: getMinTileHeight(t),
            }),
          ))
        })
      }
    }

    const flushPendingTileDrag = () => {
      if (snapGuideRafRef.current !== null) {
        cancelAnimationFrame(snapGuideRafRef.current)
        snapGuideRafRef.current = null
      }
      const pending = pendingTileDragRef.current
      if (!pending) return
      const latest = latestOptionsRef.current
      latest.setTiles(prev => updateIndexedCanvasTiles(
        prev,
        ensureTileIndex(prev),
        pending.snapshots.values(),
        (t, snapshot) => {
          if (snapshot.id === pending.tileId) {
            return { ...t, x: pending.newX, y: pending.newY }
          }
          return {
            ...t,
            x: latest.snapValue(snapshot.x + pending.ddx),
            y: latest.snapValue(snapshot.y + pending.ddy),
          }
        },
      ))
      pendingTileDragRef.current = null
    }

    const onUp = () => {
      const {
        dragState,
        setDragState,
        engine,
        groupsRef,
        groups,
        setTiles,
        setGuides,
        setSelectedTileIds,
        setSuppressedConnections,
        suppressedConnectionsRef,
        panelTileIdsRef,
        groupBoundsRef,
        lockConnection,
        triggerDiscoveryPulse,
      } = latestOptionsRef.current
      const {
        viewport,
        saveCanvas,
        nextZIndex,
        startPanInertia,
      } = engine

      // Grab the pre-drag snapshot before any async state setters fire (H-11 fix).
      const beforeTiles = preDragSnapshotRef.current ?? undefined

      // Land the final coalesced move before the release logic reads state.
      flushPendingDragUpdate()
      if (dragState.type === 'tile') flushPendingTileDrag()
      if (dragState.type === 'connection') {
        if (dragState.targetTileId) {
          lockConnection(dragState.sourceTileId, dragState.targetTileId)
        }
      } else if (dragState.type === 'tile') {
        setTiles(prev => {
          const tile = getIndexedCanvasTile(
            prev,
            ensureTileIndex(prev),
            dragState.tileId,
          )
          if (!tile) { saveCanvas(prev, viewport, nextZIndex, undefined, beforeTiles); return prev }

          const didMove = tile.x !== dragState.initX || tile.y !== dragState.initY
          if (didMove && suppressedConnectionsRef.current.size > 0) {
            setSuppressedConnections(prev => {
              const next = new Set(prev)
              for (const key of prev) {
                if (key.includes(tile.id)) next.delete(key)
              }
              return next.size === prev.size ? prev : next
            })
          }
          if (!didMove) { saveCanvas(prev, viewport, nextZIndex, undefined, beforeTiles); return prev }

          const tileCx = tile.x + tile.width / 2
          const tileCy = tile.y + tile.height / 2

          let newGroupId: string | undefined = tile.groupId
          for (const g of groups) {
            if (g.id === tile.groupId) continue
            const b = groupBoundsRef.current(g.id)
            if (b && tileCx >= b.x && tileCx <= b.x + b.w && tileCy >= b.y && tileCy <= b.y + b.h) {
              newGroupId = g.id
              break
            }
          }

          if (newGroupId !== tile.groupId) {
            const assigned = assignTileToGroup(prev, groupsRef.current, tile.id, newGroupId)
            groupsRef.current = assigned.groups
            latestOptionsRef.current.setGroups(assigned.groups)
            saveCanvas(assigned.tiles, viewport, nextZIndex, assigned.groups, beforeTiles)
            window.setTimeout(() => triggerDiscoveryPulse(tile.id, assigned.tiles), 40)
            return assigned.tiles
          }
          saveCanvas(prev, viewport, nextZIndex, undefined, beforeTiles)
          window.setTimeout(() => triggerDiscoveryPulse(tile.id, prev), 40)
          return prev
        })
      } else if (dragState.type === 'resize' || dragState.type === 'group' || dragState.type === 'group-resize') {
        setTiles(prev => { saveCanvas(prev, viewport, nextZIndex, groupsRef.current, beforeTiles); return prev })
      }
      if (dragState.type === 'select') {
        const minX = Math.min(dragState.startWx, dragState.curWx)
        const maxX = Math.max(dragState.startWx, dragState.curWx)
        const minY = Math.min(dragState.startWy, dragState.curWy)
        const maxY = Math.max(dragState.startWy, dragState.curWy)
        const size = Math.max(maxX - minX, maxY - minY)
        if (size > 10) {
          setTiles(prev => {
            const hit = new Set(
              prev
                .filter(t => !panelTileIdsRef.current.has(t.id))
                .filter(t => t.x < maxX && t.x + t.width > minX && t.y < maxY && t.y + t.height > minY)
                .map(t => t.id),
            )
            setSelectedTileIds(hit)
            return prev
          })
        }
      }
      if (dragState.type === 'pan') startPanInertia()
      setGuides([])
      setDragState({ type: null })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (snapGuideRafRef.current !== null) {
        cancelAnimationFrame(snapGuideRafRef.current)
        snapGuideRafRef.current = null
      }
      pendingTileDragRef.current = null
      if (pendingDragFrameRef.current !== null) {
        cancelAnimationFrame(pendingDragFrameRef.current)
        pendingDragFrameRef.current = null
      }
      pendingDragUpdateRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])
}
