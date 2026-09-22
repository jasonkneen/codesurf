/**
 * useCanvasEngine — viewport, coordinates, persistence, undo/redo, and zoom for the canvas.
 *
 * Extracted from App.tsx (TASK-W4-A). Owns canvas viewport state, world/screen
 * transforms, debounced persistence, and history stacks.
 *
 * Pointer/menu/lock helpers live in sibling modules and are re-exported here
 * so existing App imports keep working.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { TileState, GroupState, CanvasState, Workspace } from '../../../shared/types'
import type { PanelNode } from '../components/panelLayoutTree'
import {
  applyCanvasHistoryRedo,
  applyCanvasHistoryUndo,
  buildCanvasHistoryEntry,
  isEmptyCanvasHistoryEntry,
  type CanvasHistoryEntry,
} from './canvasHistory.ts'
import { perfFlags } from '../perfFlags.ts'
import {
  WorkspaceOrderedPersistence,
  type PersistenceFlushOptions,
  type PersistenceMode,
} from '../lib/orderedCanvasPersistence.ts'
import {
  DEFAULT_CANVAS_VIEWPORT,
  type CanvasViewport,
  clampCanvasZoom,
  connectionSnapPadding,
  zoomAtPoint,
  computeFitViewport,
  computeArrangeFitViewport,
  computePanToTileViewport,
  screenToWorldPoint,
  worldToScreenPoint,
  worldToScreenRect,
  type PersistCanvasStateFn,
  type SaveCanvasFn,
  ZOOM_WHEEL_FACTOR_IN,
  ZOOM_WHEEL_FACTOR_OUT,
  CANVAS_SAVE_DEBOUNCE_MS,
  HISTORY_MAX_ENTRIES,
} from './canvasEngineMath'

export {
  SNAP_THRESHOLD,
  MIN_CANVAS_ZOOM,
  MAX_CANVAS_ZOOM,
  ZOOM_WHEEL_FACTOR_IN,
  ZOOM_WHEEL_FACTOR_OUT,
  CANVAS_SAVE_DEBOUNCE_MS,
  HISTORY_MAX_ENTRIES,
  FIT_VIEWPORT_PAD_PX,
  FIT_VIEWPORT_MAX_ZOOM,
  ARRANGE_FIT_PAD_PX,
  ARRANGE_FIT_ZOOM_SCALE,
  DEFAULT_CANVAS_VIEWPORT,
  shouldSpawnTileOnCanvasDoubleClick,
  clampCanvasZoom,
  connectionSnapPadding,
  zoomAtPoint,
  computeFitViewport,
  computeArrangeFitViewport,
  computePanToTileViewport,
  screenToWorldPoint,
  worldToScreenPoint,
  worldToScreenRect,
  type CanvasViewport,
} from './canvasEngineMath'

export type { CanvasHistoryEntry } from './canvasHistory.ts'
export type { PersistCanvasStateFn, SaveCanvasFn } from './canvasEngineMath'

export type CanvasEnginePersistRefs = {
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  panelLayoutRef: MutableRefObject<PanelNode | null>
  savedLayoutRef: MutableRefObject<PanelNode | null>
  activePanelIdRef: MutableRefObject<string | null>
  expandedTileIdRef: MutableRefObject<string | null>
  expandedCanvasGroupIdRef: MutableRefObject<string | null>
  expandLayoutGroupIdRef: MutableRefObject<string | null>
  /** When true, debounced canvas persistence is deferred until drag ends. */
  canvasPersistSuspendedRef?: MutableRefObject<boolean>
}

export type UseCanvasEngineOptions = {
  workspace: Workspace | null
  canvasRef: RefObject<HTMLDivElement | null>
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode | null
  activePanelId: string | null
  expandedTileId: string | null
  persistRefs: CanvasEnginePersistRefs
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  /** Optional initial viewport when restoring saved canvas state. */
  initialViewport?: CanvasViewport
  initialNextZIndex?: number
  /**
   * Native hosts that cannot delay window close persist every mutation without
   * a debounce window. Electron uses the lifecycle barrier plus debouncing.
   */
  persistenceMode?: PersistenceMode
}


function buildCanvasStatePayload(
  tileList: TileState[],
  vp: CanvasViewport,
  nz: number,
  resolvedGroups: GroupState[],
  persistRefs: CanvasEnginePersistRefs,
  expandedCanvasPriorViewport: CanvasViewport | null,
): CanvasState {
  return {
    tiles: tileList,
    groups: resolvedGroups,
    viewport: vp,
    nextZIndex: nz,
    panelLayout: persistRefs.panelLayoutRef.current ?? persistRefs.savedLayoutRef.current,
    activePanelId: persistRefs.activePanelIdRef.current,
    tabViewActive: Boolean(persistRefs.panelLayoutRef.current),
    expandedTileId: persistRefs.expandedTileIdRef.current,
    expandedCanvasGroupId: persistRefs.expandedCanvasGroupIdRef.current,
    expandLayoutGroupId: persistRefs.expandLayoutGroupIdRef.current,
    expandedCanvasPriorViewport,
    lockedConnections: persistRefs.lockedConnectionsRef.current.length > 0
      ? persistRefs.lockedConnectionsRef.current
      : undefined,
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type UseCanvasEngineReturn = {
  viewport: CanvasViewport
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  viewportRef: MutableRefObject<CanvasViewport>
  pendingViewportRef: MutableRefObject<CanvasViewport>
  nextZIndex: number
  setNextZIndex: Dispatch<SetStateAction<number>>
  nextZIndexRef: MutableRefObject<number>
  prevZoomRef: MutableRefObject<number>
  expandedCanvasPriorViewportRef: MutableRefObject<CanvasViewport | null>
  persistCanvasStateRef: MutableRefObject<PersistCanvasStateFn | null>
  historyBack: MutableRefObject<CanvasHistoryEntry[]>
  historyForward: MutableRefObject<CanvasHistoryEntry[]>
  skipHistory: MutableRefObject<boolean>
  panVelocityRef: MutableRefObject<{ vx: number; vy: number }>
  panLastPos: MutableRefObject<{ x: number; y: number; t: number }>
  panInertiaRaf: MutableRefObject<number>
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  worldToScreen: (point: { x: number; y: number }) => { x: number; y: number }
  worldToScreenRect: (tile: TileState) => { left: number; top: number; width: number; height: number }
  viewportCenter: () => { x: number; y: number }
  saveCanvas: SaveCanvasFn
  persistCanvasState: PersistCanvasStateFn
  computeFitViewport: typeof computeFitViewport
  zoomToFitArrangedTiles: (
    merged: TileState[],
    getArrangeWidth: (tile: TileState) => number,
    sidebarOffset: number,
  ) => void
  panToTile: (tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'>) => void
  toggleZoomOne: () => void
  resetCanvasZoom: () => void
  cancelPanInertia: () => void
  startPanInertia: () => void
  findManualConnectionTarget: (
    sourceTileId: string,
    point: { x: number; y: number },
    tiles: TileState[],
    panelTileIds: Set<string>,
    getTileCenter: (tile: TileState) => { x: number; y: number },
  ) => string | null
  restoreViewport: (saved: CanvasViewport | null | undefined) => void
  resetViewportState: () => void
  handleWheel: (e: React.WheelEvent) => void
  scheduleViewportUpdate: (nextViewport: CanvasViewport) => void
  /** Attach to the world-transform div — imperative gesture writes target it. */
  worldElRef: MutableRefObject<HTMLDivElement | null>
  /**
   * Apply a viewport change during a continuous gesture (pan / wheel zoom /
   * inertia). With the imperative-pan perf flag on, this writes the transform
   * straight to the world div every event and commits React state only on a
   * throttle; without the flag it falls back to a plain setViewport.
   */
  applyViewportGesture: (next: CanvasViewport) => void
  /** Commit the final gesture viewport to React state. Safe to call when idle. */
  endViewportGesture: () => void
  undoCanvas: () => void
  redoCanvas: () => void
  flushDeferredCanvasPersist: () => void
  /** Clear both undo and redo stacks (call on workspace switch / canvas load). */
  clearHistory: () => void
  /**
   * Immediately fire any pending debounced save for the given workspace id,
   * cancelling the scheduled timer. Call this BEFORE switching workspace so
   * the last edits for the outgoing workspace are not dropped or mis-attributed.
   */
  flushPendingSave: (
    workspaceId: string,
    options?: PersistenceFlushOptions,
  ) => Promise<void>
  /**
   * Record that the canvas state now belongs to the given workspace id.
   * The auto-save effect is gated on this matching workspace.id so that A's
   * tiles cannot be written into B's canvas.json during the switch window.
   */
  markCanvasLoaded: (id: string) => void
  /**
   * Transfer persistence ownership synchronously inside the serialized
   * workspace commit, before incoming canvas refs are applied.
   */
  transferCanvasWorkspaceOwnership: (id: string | null) => void
  /** Evict a clean persistence lane after a workspace is closed or deleted. */
  releaseWorkspacePersistence: (id: string) => boolean
}

export function useCanvasEngine(options: UseCanvasEngineOptions): UseCanvasEngineReturn {
  const {
    workspace,
    canvasRef,
    tiles,
    groups,
    panelLayout,
    activePanelId,
    expandedTileId,
    persistRefs,
    setTiles,
    setGroups,
    initialViewport,
    initialNextZIndex,
    persistenceMode = 'debounced',
  } = options

  const [viewport, setViewport] = useState<CanvasViewport>(initialViewport ?? DEFAULT_CANVAS_VIEWPORT)
  const [nextZIndex, setNextZIndex] = useState(initialNextZIndex ?? 1)

  const prevZoomRef = useRef(1)
  const panVelocityRef = useRef({ vx: 0, vy: 0 })
  const panLastPos = useRef({ x: 0, y: 0, t: 0 })
  const panInertiaRaf = useRef(0)

  const historyBack = useRef<CanvasHistoryEntry[]>([])
  const historyForward = useRef<CanvasHistoryEntry[]>([])
  const skipHistory = useRef(false)

  const viewportRef = useRef(viewport)
  const nextZIndexRef = useRef(nextZIndex)
  const viewportAnimationFrameRef = useRef<number | null>(null)
  const pendingViewportRef = useRef(viewport)
  const expandedCanvasPriorViewportRef = useRef<CanvasViewport | null>(null)
  const persistCanvasStateRef = useRef<PersistCanvasStateFn | null>(null)
  const workspacePersistenceRef = useRef<WorkspaceOrderedPersistence<CanvasState> | null>(null)
  if (workspacePersistenceRef.current === null) {
    workspacePersistenceRef.current = new WorkspaceOrderedPersistence(
      async (workspaceId, state) => {
        await window.electron.canvas.save(workspaceId, state)
      },
      CANVAS_SAVE_DEBOUNCE_MS,
      undefined,
      persistenceMode,
    )
  }
  const workspacePersistence = workspacePersistenceRef.current
  /** Dedicated timer for resetting skipHistory — must never be cleared by the persist path. */
  const skipHistoryResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPersistRef = useRef<{
    tileList: TileState[]
    vp: CanvasViewport
    nz: number
    grps: GroupState[]
  } | null>(null)
  const persistRefsRef = useRef(persistRefs)
  persistRefsRef.current = persistRefs

  /**
   * Ref-based workspace id so schedulePersistWrite can read the current id
   * without closing over the `workspace` state value. This keeps the function
   * identity stable across workspace changes (avoids identity churn in deps).
   */
  const workspaceIdRef = useRef<string | null>(workspace?.id ?? null)
  workspaceIdRef.current = workspace?.id ?? null

  /**
   * Tracks which workspace id the currently-loaded canvas state belongs to.
   * Set to null while a switch is in progress; set to the new id once the load
   * completes. The auto-save effect is gated on this matching workspace.id to
   * prevent A's tiles being written into B's canvas.json during the switch window.
   */
  const canvasLoadedForWorkspaceIdRef = useRef<string | null>(workspace?.id ?? null)

  const worldElRef = useRef<HTMLDivElement | null>(null)
  const viewportGestureActiveRef = useRef(false)
  const lastGestureCommitRef = useRef(0)
  const wheelGestureEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep viewport / z-index refs in sync with state. During an imperative
  // gesture the refs hold the LIVE gesture viewport (ahead of React state) —
  // don't clobber them with the throttled committed value.
  if (!viewportGestureActiveRef.current) {
    viewportRef.current = viewport
    pendingViewportRef.current = viewport
  }
  nextZIndexRef.current = nextZIndex

  const scheduleViewportUpdate = useCallback((nextVp: CanvasViewport) => {
    pendingViewportRef.current = nextVp
    if (viewportAnimationFrameRef.current !== null) return
    viewportAnimationFrameRef.current = requestAnimationFrame(() => {
      viewportAnimationFrameRef.current = null
      setViewport(pendingViewportRef.current)
    })
  }, [])

  /** Throttle for React state commits while an imperative gesture is live. */
  const GESTURE_COMMIT_INTERVAL_MS = 150

  const writeWorldTransform = useCallback((vp: CanvasViewport) => {
    const el = worldElRef.current
    if (el) el.style.transform = `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.zoom})`
  }, [])

  const applyViewportGesture = useCallback((next: CanvasViewport) => {
    if (!perfFlags.imperativePan) {
      setViewport(next)
      return
    }
    viewportGestureActiveRef.current = true
    viewportRef.current = next
    pendingViewportRef.current = next
    writeWorldTransform(next)
    // Periodic state commits keep culling / minimap / overlays roughly in sync
    // during long gestures without paying a React render per pointer event.
    const now = performance.now()
    if (now - lastGestureCommitRef.current > GESTURE_COMMIT_INTERVAL_MS) {
      lastGestureCommitRef.current = now
      setViewport(next)
    }
  }, [writeWorldTransform])

  const endViewportGesture = useCallback(() => {
    if (!viewportGestureActiveRef.current) return
    viewportGestureActiveRef.current = false
    lastGestureCommitRef.current = 0
    setViewport(pendingViewportRef.current)
  }, [])

  // A throttled commit re-renders the world div with a viewport that may be a
  // few pointer events behind the last imperative write — re-apply the live
  // transform after every render while a gesture is active so the frame never
  // jumps backwards.
  useLayoutEffect(() => {
    if (viewportGestureActiveRef.current) writeWorldTransform(pendingViewportRef.current)
  })

  useEffect(() => () => {
    if (viewportAnimationFrameRef.current !== null) {
      cancelAnimationFrame(viewportAnimationFrameRef.current)
      viewportAnimationFrameRef.current = null
    }
    workspacePersistence.cancelPending()
    if (skipHistoryResetTimer.current) clearTimeout(skipHistoryResetTimer.current)
    if (wheelGestureEndTimerRef.current) clearTimeout(wheelGestureEndTimerRef.current)
  }, [])

  const cancelPanInertia = useCallback(() => {
    cancelAnimationFrame(panInertiaRaf.current)
    panVelocityRef.current = { vx: 0, vy: 0 }
    // If inertia was cancelled mid-flight, commit whatever the gesture reached.
    endViewportGesture()
  }, [endViewportGesture])

  const startPanInertia = useCallback(() => {
    const { vx, vy } = panVelocityRef.current
    if (Math.abs(vx) <= 0.5 && Math.abs(vy) <= 0.5) {
      endViewportGesture()
      return
    }
    const friction = 0.92
    const animate = () => {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) < 0.5 && Math.abs(v.vy) < 0.5) {
        endViewportGesture()
        return
      }
      if (perfFlags.imperativePan) {
        const cur = pendingViewportRef.current
        applyViewportGesture({ ...cur, tx: cur.tx + v.vx, ty: cur.ty + v.vy })
      } else {
        setViewport(prev => ({ ...prev, tx: prev.tx + v.vx, ty: prev.ty + v.vy }))
      }
      panVelocityRef.current = { vx: v.vx * friction, vy: v.vy * friction }
      panInertiaRaf.current = requestAnimationFrame(animate)
    }
    panInertiaRaf.current = requestAnimationFrame(animate)
  }, [applyViewportGesture, endViewportGesture])

  const schedulePersistWrite = useCallback((
    tileList: TileState[],
    vp: CanvasViewport,
    nz: number,
    resolvedGroups: GroupState[],
  ) => {
    // Use ref so this function has a stable identity (no `workspace` dep).
    // The workspace id is captured at call-time via the ref, not via closure.
    const wsId = workspaceIdRef.current
    if (!wsId) return
    const refs = persistRefsRef.current
    const priorViewport = expandedCanvasPriorViewportRef.current
    const orderedPersistence = workspacePersistence.forWorkspace(wsId)
    orderedPersistence.schedule(() => {
      return buildCanvasStatePayload(
        tileList,
        vp,
        nz,
        resolvedGroups,
        refs,
        priorViewport,
      )
    })
  }, [workspacePersistence])  // stable — reads workspace id and refs via refs, never via closure

  const persistCanvasState = useCallback<PersistCanvasStateFn>((tileList, vp, nz, grps) => {
    if (!workspaceIdRef.current) return
    const refs = persistRefsRef.current
    const resolvedGroups = grps ?? refs.groupsRef.current

    if (refs.canvasPersistSuspendedRef?.current && persistenceMode === 'debounced') {
      pendingPersistRef.current = { tileList, vp, nz, grps: resolvedGroups }
      workspacePersistence.forWorkspace(workspaceIdRef.current).markDirty()
      return
    }

    schedulePersistWrite(tileList, vp, nz, resolvedGroups)
  }, [persistenceMode, schedulePersistWrite, workspacePersistence])  // stable — workspace id read from ref

  const flushDeferredCanvasPersist = useCallback(() => {
    const pending = pendingPersistRef.current
    if (!pending) return
    pendingPersistRef.current = null
    schedulePersistWrite(pending.tileList, pending.vp, pending.nz, pending.grps)
  }, [schedulePersistWrite])

  /**
   * Immediately fire any pending debounced save, writing it under the given
   * workspace id. Must be called BEFORE setWorkspace() so the old id is used.
   * Cancels the pending timer so the delayed callback never fires.
   * Also drains pendingPersistRef (drag-suspend path) for the same reason.
   */
  const flushPendingSave = useCallback(async (
    oldWorkspaceId: string,
    options: PersistenceFlushOptions = {},
  ): Promise<void> => {
    if (!oldWorkspaceId) return
    const orderedPersistence = workspacePersistence.forWorkspace(oldWorkspaceId)
    // Only write if there is actually a pending save (either debounced timer or
    // drag-suspended pending). Avoid spurious writes on clean-state switches.
    const hasDirtyPersistence = orderedPersistence.isDirty()
    const hasPendingDragSave = pendingPersistRef.current !== null
    if (!options.force && !hasDirtyPersistence && !hasPendingDragSave) {
      await orderedPersistence.waitForIdle()
      return
    }
    // Drain drag-suspended pending write.
    pendingPersistRef.current = null

    // Build and write immediately using authoritative ref values.
    await orderedPersistence.flush(
      () => buildCanvasStatePayload(
        persistRefsRef.current.tilesRef.current,
        viewportRef.current,
        nextZIndexRef.current,
        persistRefsRef.current.groupsRef.current,
        persistRefsRef.current,
        expandedCanvasPriorViewportRef.current,
      ),
      options,
    )
  }, [workspacePersistence])  // stable — all reads go through refs

  /**
   * Mark that canvas state for the given workspace id has been loaded and
   * applied to React state. The auto-save effect is gated on this matching
   * workspace.id; call this after applying loaded state so saves resume.
   */
  const markCanvasLoaded = useCallback((id: string) => {
    canvasLoadedForWorkspaceIdRef.current = id
  }, [])

  const transferCanvasWorkspaceOwnership = useCallback((id: string | null) => {
    workspaceIdRef.current = id
    canvasLoadedForWorkspaceIdRef.current = null
  }, [])

  const releaseWorkspacePersistence = useCallback((id: string): boolean => {
    return workspacePersistence.evictWorkspace(id)
  }, [workspacePersistence])

  const saveCanvas = useCallback<SaveCanvasFn>((tileList, vp, nz, grps, beforeTiles) => {
    if (!workspaceIdRef.current) return
    const refs = persistRefsRef.current
    const resolvedGroups = grps ?? refs.groupsRef.current

    if (!skipHistory.current) {
      // Use the explicit pre-drag snapshot when provided so that the diff is
      // computed against the state BEFORE movement, not the (already-updated)
      // tilesRef (H-11 fix).
      const historyBefore = beforeTiles ?? refs.tilesRef.current
      const entry = buildCanvasHistoryEntry(
        historyBefore,
        tileList,
        refs.groupsRef.current,
        resolvedGroups,
      )
      if (!isEmptyCanvasHistoryEntry(entry)) {
        historyBack.current.push(entry)
        if (historyBack.current.length > HISTORY_MAX_ENTRIES) historyBack.current.shift()
        historyForward.current = []
      }
    }

    persistCanvasState(tileList, vp, nz, resolvedGroups)
  }, [persistCanvasState])  // stable — workspace id read from ref

  // Read viewportRef (not viewport state) so this function's identity is stable
  // across pan frames — prevents CanvasTileItem memo from busting on every pan (medium fix).
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return screenToWorldPoint(sx, sy, rect, viewportRef.current)
  }, [canvasRef, viewportRef])

  const viewportCenter = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 200, y: 100 }
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [canvasRef, screenToWorld])

  const worldToScreen = useCallback((point: { x: number; y: number }) => (
    worldToScreenPoint(point, viewportRef.current)
  ), [viewportRef])

  const worldToScreenRectBound = useCallback((tile: TileState) => (
    worldToScreenRect(tile, viewportRef.current)
  ), [viewportRef])

  const findManualConnectionTarget = useCallback((
    sourceTileId: string,
    point: { x: number; y: number },
    tileList: TileState[],
    panelTileIds: Set<string>,
    getTileCenter: (tile: TileState) => { x: number; y: number },
  ): string | null => {
    const snapPadding = connectionSnapPadding(viewportRef.current.zoom)
    const candidates = tileList
      .filter(tile => tile.id !== sourceTileId && !panelTileIds.has(tile.id))
      .filter(tile => (
        point.x >= tile.x - snapPadding
        && point.x <= tile.x + tile.width + snapPadding
        && point.y >= tile.y - snapPadding
        && point.y <= tile.y + tile.height + snapPadding
      ))
      .map(tile => ({
        tile,
        distance: Math.hypot(point.x - getTileCenter(tile).x, point.y - getTileCenter(tile).y),
      }))
      .sort((a, b) => a.distance - b.distance)
    return candidates[0]?.tile.id ?? null
  }, [])

  const restoreViewport = useCallback((saved: CanvasViewport | null | undefined) => {
    const next = saved
      ? { tx: saved.tx, ty: saved.ty, zoom: saved.zoom }
      : DEFAULT_CANVAS_VIEWPORT
    viewportRef.current = next
    pendingViewportRef.current = next
    setViewport(next)
  }, [])

  const resetViewportState = useCallback(() => {
    viewportRef.current = DEFAULT_CANVAS_VIEWPORT
    pendingViewportRef.current = DEFAULT_CANVAS_VIEWPORT
    nextZIndexRef.current = 1
    setViewport(DEFAULT_CANVAS_VIEWPORT)
    setNextZIndex(1)
  }, [])

  const panToTile = useCallback((tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'>) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pan = computePanToTileViewport(tile, { w: rect.width, h: rect.height }, viewport.zoom)
    setViewport(prev => ({ ...prev, ...pan }))
  }, [canvasRef, viewport.zoom])

  const zoomToFitArrangedTiles = useCallback((
    merged: TileState[],
    getArrangeWidth: (tile: TileState) => number,
    sidebarOffset: number,
  ) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || merged.length === 0) return
    const fit = computeArrangeFitViewport(merged, { w: rect.width, h: rect.height }, sidebarOffset, getArrangeWidth)
    if (fit) setViewport(fit)
  }, [canvasRef])

  const toggleZoomOne = useCallback(() => {
    setViewport(prev => {
      if (prev.zoom === 1) {
        return { ...prev, zoom: prevZoomRef.current !== 1 ? prevZoomRef.current : 1 }
      }
      prevZoomRef.current = prev.zoom
      return { ...prev, zoom: 1 }
    })
  }, [])

  const resetCanvasZoom = useCallback(() => {
    setViewport(prev => ({ ...prev, zoom: 1 }))
    window.electron.zoom.setLevel(0)
  }, [])

  const handleWheel = useCallback((_e: ReactWheelEvent) => {}, [])

  // Auto-save when layout metadata changes.
  // Guard: only persist when the loaded canvas state actually belongs to the
  // current workspace. During a workspace switch, canvasLoadedForWorkspaceIdRef
  // is null (cleared by flushPendingSave caller before setWorkspace) until
  // markCanvasLoaded() is called after canvas.load() completes — preventing
  // A's tiles from being written into B's canvas.json in the switch window.
  useEffect(() => {
    if (!workspace) return
    if (canvasLoadedForWorkspaceIdRef.current !== workspace.id) return
    persistCanvasState(tiles, viewport, nextZIndex, groups)
  }, [workspace, panelLayout, activePanelId, expandedTileId, persistCanvasState, tiles, viewport, nextZIndex, groups])

  // Cmd+0 reset zoom, Cmd+=/- UI zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '0') {
        e.preventDefault()
        resetCanvasZoom()
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        window.electron.zoom.setLevel(window.electron.zoom.getLevel() + 0.5)
      } else if (e.key === '-') {
        e.preventDefault()
        window.electron.zoom.setLevel(window.electron.zoom.getLevel() - 0.5)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetCanvasZoom])

  // Wheel zoom — native listener for { passive: false }
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      const vp = viewportRef.current
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR_IN : ZOOM_WHEEL_FACTOR_OUT
      const newZoom = clampCanvasZoom(vp.zoom * factor)
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const next = zoomAtPoint(vp, mx, my, newZoom)
      if (perfFlags.imperativePan) {
        // Wheel zoom is a continuous gesture with no natural end event — treat
        // a 160ms wheel-idle gap as the gesture end and commit then.
        applyViewportGesture(next)
        if (wheelGestureEndTimerRef.current) clearTimeout(wheelGestureEndTimerRef.current)
        wheelGestureEndTimerRef.current = setTimeout(() => {
          wheelGestureEndTimerRef.current = null
          endViewportGesture()
        }, 160)
      } else {
        setViewport(next)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [canvasRef, viewportRef, applyViewportGesture, endViewportGesture])

  const applyHistoryEntry = useCallback((
    entry: CanvasHistoryEntry,
    direction: 'undo' | 'redo',
  ) => {
    skipHistory.current = true
    const refs = persistRefsRef.current
    const currentTiles = refs.tilesRef.current
    const currentGroups = refs.groupsRef.current
    const { tiles, groups } = direction === 'undo'
      ? applyCanvasHistoryUndo(currentTiles, currentGroups, entry)
      : applyCanvasHistoryRedo(currentTiles, currentGroups, entry)
    setTiles(tiles)
    setGroups(groups)

    // Reset skipHistory on a dedicated timer so persistence never cancels it.
    if (skipHistoryResetTimer.current) clearTimeout(skipHistoryResetTimer.current)

    if (workspace) {
      workspacePersistence.forWorkspace(workspace.id).schedule(() => {
        const state: CanvasState = {
          tiles,
          groups,
          viewport: viewportRef.current,
          nextZIndex: nextZIndexRef.current,
        }
        return state
      })
    }

    // Reset the skip flag after state has flushed — persistence cannot touch
    // this dedicated timer.
    skipHistoryResetTimer.current = setTimeout(() => {
      skipHistoryResetTimer.current = null
      skipHistory.current = false
    }, 0)
  }, [workspace, workspacePersistence, setTiles, setGroups])

  const undoCanvas = useCallback(() => {
    if (historyBack.current.length === 0) return
    const entry = historyBack.current.pop()!
    historyForward.current.push(entry)
    applyHistoryEntry(entry, 'undo')
  }, [applyHistoryEntry])

  const redoCanvas = useCallback(() => {
    if (historyForward.current.length === 0) return
    const entry = historyForward.current.pop()!
    historyBack.current.push(entry)
    if (historyBack.current.length > HISTORY_MAX_ENTRIES) historyBack.current.shift()
    applyHistoryEntry(entry, 'redo')
  }, [applyHistoryEntry])

  /** Clear both stacks when a new canvas is loaded to prevent cross-workspace replay (H-3). */
  const clearHistory = useCallback(() => {
    historyBack.current = []
    historyForward.current = []
  }, [])

  persistCanvasStateRef.current = persistCanvasState

  return {
    viewport,
    setViewport,
    viewportRef,
    pendingViewportRef,
    nextZIndex,
    setNextZIndex,
    nextZIndexRef,
    prevZoomRef,
    expandedCanvasPriorViewportRef,
    persistCanvasStateRef,
    historyBack,
    historyForward,
    skipHistory,
    panVelocityRef,
    panLastPos,
    panInertiaRaf,
    screenToWorld,
    worldToScreen,
    worldToScreenRect: worldToScreenRectBound,
    viewportCenter,
    saveCanvas,
    persistCanvasState,
    computeFitViewport,
    zoomToFitArrangedTiles,
    panToTile,
    toggleZoomOne,
    resetCanvasZoom,
    cancelPanInertia,
    startPanInertia,
    findManualConnectionTarget,
    restoreViewport,
    resetViewportState,
    handleWheel,
    scheduleViewportUpdate,
    worldElRef,
    applyViewportGesture,
    endViewportGesture,
    undoCanvas,
    redoCanvas,
    flushDeferredCanvasPersist,
    clearHistory,
    flushPendingSave,
    markCanvasLoaded,
    transferCanvasWorkspaceOwnership,
    releaseWorkspacePersistence,
  }
}


// Sibling modules (split from this file) — stable public surface for App.tsx
export {
  useCanvasPointerHandlers,
  useConnectionHandleHover,
  type UseCanvasPointerHandlersOptions,
  type UseConnectionHandleHoverOptions,
} from './useCanvasPointerHandlers'
export {
  useCanvasContextMenu,
  useTileContextMenu,
  type CanvasContextMenuItem,
  type UseCanvasContextMenuOptions,
  type UseTileContextMenuOptions,
} from './useCanvasContextMenus'
export {
  useCanvasExpandedGroup,
  useLockConnection,
  useEnforceTileMinimumSizes,
  useLockedConnectionHelpers,
  type UseCanvasExpandedGroupOptions,
  type UseLockConnectionOptions,
  type UseEnforceTileMinimumSizesOptions,
  type UseLockedConnectionHelpersOptions,
} from './useCanvasConnectionLock'

export {
  ALIGN_GUIDE_THRESH,
  computeAlignmentGuides,
  useCanvasDragSync,
  type AlignmentGuide,
  type CanvasAnchorPoint,
  type CanvasAnchorSide,
  type CanvasDragState,
  type UseCanvasDragSyncOptions,
} from './useCanvasDragSync.ts'
