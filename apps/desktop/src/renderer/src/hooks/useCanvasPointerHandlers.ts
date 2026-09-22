/**
 * Canvas surface pointer handlers + connection-handle hover.
 * Extracted from useCanvasEngine.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { TileState } from '../../../shared/types.ts'
import type { PanelNode } from '../components/panelLayoutTree.ts'
import type { CanvasViewport } from './canvasEngineMath.ts'
import type { CanvasAnchorPoint, CanvasAnchorSide, CanvasDragState } from './useCanvasDragSync.ts'
import { shouldSpawnTileOnCanvasDoubleClick } from './canvasEngineMath.ts'

// ─── Canvas surface mouse handlers ───────────────────────────────────────────

export type UseCanvasPointerHandlersOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  viewport: CanvasViewport
  setDragState: Dispatch<SetStateAction<CanvasDragState>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  panLastPos: MutableRefObject<{ x: number; y: number; t: number }>
  cancelPanInertia: () => void
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  spaceHeld: MutableRefObject<boolean>
  bringToFront: (id: string) => void
  getConnectionHandlePoint: (tile: TileState, side: CanvasAnchorSide) => CanvasAnchorPoint
  panelLayout: PanelNode | null
  addTile: (type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => string
}

export function createTileDragState(
  tile: TileState,
  clientX: number,
  clientY: number,
): Extract<CanvasDragState, { type: 'tile' }> {
  return {
    type: 'tile',
    tileId: tile.id,
    startX: clientX,
    startY: clientY,
    initX: tile.x,
    initY: tile.y,
    groupSnapshots: [],
  }
}

export function createResizeDragState(
  tile: TileState,
  dir: Extract<CanvasDragState, { type: 'resize' }>['dir'],
  clientX: number,
  clientY: number,
): Extract<CanvasDragState, { type: 'resize' }> {
  return {
    type: 'resize',
    tileId: tile.id,
    dir,
    startX: clientX,
    startY: clientY,
    initX: tile.x,
    initY: tile.y,
    initW: tile.width,
    initH: tile.height,
  }
}

export function useCanvasPointerHandlers(options: UseCanvasPointerHandlersOptions) {
  const {
    canvasRef,
    viewport,
    setDragState,
    setSelectedTileId,
    setSelectedTileIds,
    panLastPos,
    cancelPanInertia,
    screenToWorld,
    spaceHeld,
    bringToFront,
    getConnectionHandlePoint,
    panelLayout,
    addTile,
  } = options

  const handleCanvasMouseDown = useCallback((e: ReactMouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-tile-chrome]')) return
    e.preventDefault()
    const isPan = e.button === 1 || (e.button === 0 && (e.metaKey || spaceHeld.current))
    if (isPan) {
      cancelPanInertia()
      panLastPos.current = { x: e.clientX, y: e.clientY, t: performance.now() }
      setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY, initTx: viewport.tx, initTy: viewport.ty })
      setSelectedTileId(null)
      return
    }
    if (e.button === 0) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const wx = (e.clientX - rect.left - viewport.tx) / viewport.zoom
      const wy = (e.clientY - rect.top - viewport.ty) / viewport.zoom
      setDragState({ type: 'select', startWx: wx, startWy: wy, curWx: wx, curWy: wy })
      setSelectedTileIds(new Set())
      setSelectedTileId(null)
    }
  }, [canvasRef, viewport, setDragState, setSelectedTileId, setSelectedTileIds, panLastPos, cancelPanInertia, spaceHeld])

  const handleConnectionMouseDown = useCallback((
    e: ReactMouseEvent,
    tile: TileState,
    side: CanvasAnchorSide,
  ) => {
    e.stopPropagation()
    e.preventDefault()
    bringToFront(tile.id)
    const anchor = getConnectionHandlePoint(tile, side)
    setDragState({
      type: 'connection',
      sourceTileId: tile.id,
      startX: e.clientX,
      startY: e.clientY,
      side,
      anchor,
      current: screenToWorld(e.clientX, e.clientY),
      targetTileId: null,
    })
  }, [bringToFront, getConnectionHandlePoint, screenToWorld, setDragState])

  const handleResizeMouseDown = useCallback((
    e: ReactMouseEvent,
    tile: TileState,
    dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    setDragState(createResizeDragState(tile, dir, e.clientX, e.clientY))
  }, [setDragState])

  const handleCanvasDoubleClick = useCallback((e: ReactMouseEvent) => {
    if (panelLayout) return
    const target = e.target as HTMLElement
    if (!shouldSpawnTileOnCanvasDoubleClick(target)) return
    const world = screenToWorld(e.clientX, e.clientY)
    addTile('terminal', undefined, world)
  }, [panelLayout, screenToWorld, addTile])

  const handleTileMouseDown = useCallback((e: ReactMouseEvent, tile: TileState) => {
    e.stopPropagation()
    bringToFront(tile.id)
    setDragState(createTileDragState(tile, e.clientX, e.clientY))
  }, [bringToFront, setDragState])

  return {
    handleCanvasMouseDown,
    handleConnectionMouseDown,
    handleResizeMouseDown,
    handleCanvasDoubleClick,
    handleTileMouseDown,
  }
}

export type UseConnectionHandleHoverOptions = {
  setHoveredConnectionHandle: Dispatch<SetStateAction<{ tileId: string; side: CanvasAnchorSide } | null>>
}

export function useConnectionHandleHover(options: UseConnectionHandleHoverOptions) {
  const { setHoveredConnectionHandle } = options
  const connectionHandleHideTimerRef = useRef<number | null>(null)

  const showConnectionHandleForSide = useCallback((tileId: string, side: CanvasAnchorSide) => {
    if (connectionHandleHideTimerRef.current !== null) {
      window.clearTimeout(connectionHandleHideTimerRef.current)
      connectionHandleHideTimerRef.current = null
    }
    setHoveredConnectionHandle({ tileId, side })
  }, [setHoveredConnectionHandle])

  const scheduleConnectionHandleHide = useCallback((tileId: string, side: CanvasAnchorSide) => {
    if (connectionHandleHideTimerRef.current !== null) {
      window.clearTimeout(connectionHandleHideTimerRef.current)
    }
    connectionHandleHideTimerRef.current = window.setTimeout(() => {
      connectionHandleHideTimerRef.current = null
      setHoveredConnectionHandle(prev => prev?.tileId === tileId && prev.side === side ? null : prev)
    }, 140)
  }, [setHoveredConnectionHandle])

  useEffect(() => () => {
    if (connectionHandleHideTimerRef.current !== null) {
      window.clearTimeout(connectionHandleHideTimerRef.current)
      connectionHandleHideTimerRef.current = null
    }
  }, [])

  return { showConnectionHandleForSide, scheduleConnectionHandleHide }
}
