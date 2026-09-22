import React, { useEffect, useRef } from 'react'
import type { TileState } from '../../../shared/types'
import type { AppTheme } from '../theme'
import type { CanvasDragState } from '../hooks/useCanvasEngine'
import type { NegotiatedDiscoveryState } from '../hooks/useNegotiatedDiscovery'
import type { RenderTileBodyOptions } from '../hooks/useRenderTileBody'
import type { AnchorPoint } from '../lib/discoveryRuntime'
import { CanvasTileItem } from './canvas/CanvasTileItem'
import { perfFlags, CANVAS_LOD_ZOOM } from '../perfFlags'
import { isTileOffscreen, isHeavyTileType } from '../lib/canvasCulling'
import { setManagedWebviewPaintActive } from './browser/webviewManager'

type ResizeDir = 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'
type Side = AnchorPoint['side']

export type ExpandedCanvasMembership = {
  tileIds: Set<string>
  groupIds: Set<string>
}

export type AppCanvasTilesProps = {
  tiles: TileState[]
  panelTileIds: Set<string>
  expandedCanvasMembership: ExpandedCanvasMembership | null
  dragState: CanvasDragState
  viewport: { tx: number, ty: number, zoom: number }
  /** Canvas surface element — culling uses its client rect, not the full window. */
  canvasRef?: React.RefObject<HTMLDivElement | null>
  canvasPointerWorld: { x: number, y: number } | null
  theme: AppTheme
  dsc: { line: string, dot: string, bg: string, text: string }
  workspaceId?: string
  workspaceDir?: string
  selectedTileId: string | null
  selectedTileIds: Set<string>
  negotiatedDiscoveryState: NegotiatedDiscoveryState
  onCloseTile: (tileId: string) => void
  onBringToFront: (tileId: string) => void
  onTitlebarMouseDown: (event: React.MouseEvent, tile: TileState) => void
  onResizeMouseDown: (event: React.MouseEvent, tile: TileState, dir: ResizeDir) => void
  onContextMenu: (event: React.MouseEvent, tile: TileState) => void
  onEnterExpandedMode: (tileId: string) => void
  onExitExpandedMode: () => void
  onConnectionMouseDown: (event: React.MouseEvent, tile: TileState, side: AnchorPoint['side']) => void
  showConnectionHandleForSide: (tileId: string, side: AnchorPoint['side']) => void
  scheduleConnectionHandleHide: (tileId: string, side: AnchorPoint['side']) => void
  hoveredConnectionHandle: { tileId: string, side: AnchorPoint['side'] } | null
  setCanvasPointerWorld: React.Dispatch<React.SetStateAction<{ x: number, y: number } | null>>
  screenToWorld: (clientX: number, clientY: number) => { x: number, y: number }
  renderTileBody: (tile: TileState, options?: RenderTileBodyOptions) => React.ReactNode
}

export function filterVisibleCanvasTiles(
  tiles: TileState[],
  panelTileIds: Set<string>,
  expandedCanvasMembership: ExpandedCanvasMembership | null,
): TileState[] {
  return tiles
    .filter(tile => !panelTileIds.has(tile.id))
    .filter(tile => !expandedCanvasMembership || expandedCanvasMembership.tileIds.has(tile.id))
}

const EMPTY_PEERS: string[] = []

export function AppCanvasTiles(props: AppCanvasTilesProps): JSX.Element {
  const {
    tiles,
    panelTileIds,
    expandedCanvasMembership,
    dragState,
    viewport,
    canvasRef,
    theme,
    dsc,
    workspaceId,
    workspaceDir,
    selectedTileId,
    selectedTileIds,
    negotiatedDiscoveryState,
    onCloseTile,
    onBringToFront,
    onTitlebarMouseDown,
    onResizeMouseDown,
    onContextMenu,
    onEnterExpandedMode,
    onExitExpandedMode,
    onConnectionMouseDown,
    showConnectionHandleForSide,
    scheduleConnectionHandleHide,
    hoveredConnectionHandle,
    setCanvasPointerWorld,
    screenToWorld,
    renderTileBody,
  } = props

  const visibleTiles = filterVisibleCanvasTiles(tiles, panelTileIds, expandedCanvasMembership)
  const connectionDragActive = dragState.type === 'connection'
  // Perf: viewport culling + zoom LOD are computed per commit (not per pointer
  // event — imperative gestures throttle commits), so this stays cheap.
  const cullingOn = perfFlags.viewportCulling
  const lodActive = perfFlags.zoomLod && viewport.zoom < CANVAS_LOD_ZOOM
  // Cull against the canvas surface rect (sidebar/panels excluded), not the
  // full browser window — otherwise tiles under chrome look wrongly culled.
  const canvasEl = canvasRef?.current
  const screenW = canvasEl?.clientWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : 1920)
  const screenH = canvasEl?.clientHeight
    ?? (typeof window !== 'undefined' ? window.innerHeight : 1080)
  const lastPaintActiveRef = useRef<Map<string, boolean>>(new Map())

  // Browser webview paint freeze: throttle frame production when the body is
  // culled (off-canvas). Restores full rate when visible again. Pure policy
  // lives in webviewPaint.ts; this only applies it when the flag flips.
  useEffect(() => {
    if (!cullingOn) return
    for (const tile of visibleTiles) {
      if (tile.type !== 'browser' && !tile.type.startsWith('ext:')) continue
      const interacting =
        tile.id === selectedTileId ||
        selectedTileIds.has(tile.id) ||
        panelTileIds.has(tile.id)
      const culled = !interacting && isTileOffscreen(tile, viewport, screenW, screenH)
      const paintActive = !culled
      const prev = lastPaintActiveRef.current.get(tile.id)
      if (prev === paintActive) continue
      lastPaintActiveRef.current.set(tile.id, paintActive)
      setManagedWebviewPaintActive(tile.id, paintActive)
    }
  }, [visibleTiles, viewport, screenW, screenH, cullingOn, selectedTileId, selectedTileIds, panelTileIds])

  // Only cheap, per-tile *scalars* are computed here. The expensive part — the tile
  // chrome, body (Monaco/terminal/browser), link sensors and handle — lives in the
  // memoized CanvasTileItem, so an interaction that changes one tile's flags only
  // re-renders that tile, not all of them.
  return (
    <>
      {visibleTiles.map(tile => {
        const isActiveDrag =
          (dragState.type === 'tile' && (dragState.tileId === tile.id || dragState.groupSnapshots.some(s => s.id === tile.id))) ||
          (dragState.type === 'resize' && dragState.tileId === tile.id) ||
          ((dragState.type === 'group' || dragState.type === 'group-resize') && tile.groupId === dragState.groupId)
        const isConnectionSource = dragState.type === 'connection' && dragState.sourceTileId === tile.id
        const isConnectionTarget = dragState.type === 'connection' && dragState.targetTileId === tile.id
        const hoveredSide: Side | null = hoveredConnectionHandle?.tileId === tile.id ? hoveredConnectionHandle.side : null
        const showConnectionHandle = isConnectionSource || Boolean(hoveredSide)
        // The handle is invisible unless hovered or the active source, so its resting
        // side/position is never seen — use a stable default when hidden. This keeps the
        // per-tile props independent of the live pointer position (canvasPointerWorld),
        // so moving the mouse no longer re-renders every tile.
        const activeHandleSide: Side = isConnectionSource
          ? dragState.side
          : hoveredSide ?? 'right'
        const isSelected = tile.id === selectedTileId || selectedTileIds.has(tile.id)
        // Never cull/LOD a tile mid-interaction or when it's the focused panel
        // member — a hidden body under the cursor would read as a glitch.
        const interacting = isActiveDrag || isSelected || panelTileIds.has(tile.id)
        const bodyCulled = cullingOn && !interacting &&
          isTileOffscreen(tile, viewport, screenW, screenH)
        const lodPlaceholder = lodActive && !interacting && !bodyCulled && isHeavyTileType(tile.type)

        return (
          <CanvasTileItem
            key={tile.id}
            tile={tile}
            zoom={viewport.zoom}
            bodyCulled={bodyCulled}
            lodPlaceholder={lodPlaceholder}
            workspaceId={workspaceId}
            workspaceDir={workspaceDir}
            isActiveDrag={isActiveDrag}
            isSelected={isSelected}
            isConnectionSource={isConnectionSource}
            isConnectionTarget={isConnectionTarget}
            connectionDragActive={connectionDragActive}
            showConnectionHandle={showConnectionHandle}
            activeHandleSide={activeHandleSide}
            forceExpanded={panelTileIds.has(tile.id)}
            discoveryConnected={negotiatedDiscoveryState.connectedTileIds.has(tile.id)}
            connectedPeers={negotiatedDiscoveryState.byTileConnections.get(tile.id)?.map(link => link.peerId) ?? EMPTY_PEERS}
            isUntitledNote={tile.type === 'note' && !tile.filePath}
            dscLine={dsc.line}
            dscText={dsc.text}
            theme={theme}
            onClose={onCloseTile}
            onActivate={onBringToFront}
            onTitlebarMouseDown={onTitlebarMouseDown}
            onResizeMouseDown={onResizeMouseDown}
            onContextMenu={onContextMenu}
            onEnterExpandedMode={onEnterExpandedMode}
            onExitExpandedMode={onExitExpandedMode}
            onConnectionMouseDown={onConnectionMouseDown}
            showConnectionHandleForSide={showConnectionHandleForSide}
            scheduleConnectionHandleHide={scheduleConnectionHandleHide}
            setCanvasPointerWorld={setCanvasPointerWorld}
            screenToWorld={screenToWorld}
            renderTileBody={renderTileBody}
          />
        )
      })}
    </>
  )
}
