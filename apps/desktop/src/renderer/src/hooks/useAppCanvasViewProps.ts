import { useMemo, type MutableRefObject } from 'react'
import type { GroupState, TileState } from '../../../shared/types'
import type { AppCanvasConnectionsProps } from '../components/AppCanvasConnections'
import type { PanelCornerRadii, AppCanvasPanelRegionProps } from '../components/AppCanvasPanelRegion'
import type { CanvasDragState } from './useCanvasEngine'
import type {
  AmbientDiscoveryRenderRoute,
  ManualConnectionRenderRoute,
} from './useNegotiatedDiscovery'
import type { DiscoveryPreviewState } from '../components/AppCanvasConnections'
import type { DiscoveryPulse } from '../lib/discoveryRuntime'
import type { PanelNode } from '../components/panelLayoutTree'
import type { AppTheme } from '../theme'
import type { RenderTileBodyOptions } from './useRenderTileBody'
import type { LayoutTemplate } from '../../../shared/types'
import { pointerEjectPosition } from '../lib/layoutGroupMembership.ts'

type DiscoveryShellColors = { line: string, dot: string, bg: string, text: string }

export type UseAppCanvasConnectionPropsParams = {
  panelLayout: PanelNode | null
  manualConnectionRenderRoutes: ManualConnectionRenderRoute[]
  ambientDiscoveryRenderRoutes: AmbientDiscoveryRenderRoute[]
  discoveryPreview: DiscoveryPreviewState
  discoveryFocusTileId: string | null
  lockedConnectionKeys: Set<string>
  discoveryPulses: DiscoveryPulse[]
  dragState: CanvasDragState
  viewportZoom: number
  gridSize: number | undefined
  gridSpacingSmall: number | undefined
  dsc: DiscoveryShellColors
  tileByIdMap: Map<string, TileState>
  discoveryPillZIndex: number
  discoveryHighlightZIndex: number
  discoveryGlowZIndex: number
  canvasGlowEnabled: boolean
  discoveryGlowRef: React.RefObject<HTMLDivElement | null>
  worldToScreenPoint: (point: { x: number, y: number }) => { x: number, y: number }
  isConnectionLocked: (tileIdA: string, tileIdB: string) => boolean
  toggleConnectionLock: (tileIdA: string, tileIdB: string) => void
  deleteConnection: (tileIdA: string, tileIdB: string) => void
}

export type UseAppCanvasPanelRegionPropsParams = {
  panelLayout: PanelNode | null
  mainPanelCornerRadii: PanelCornerRadii
  tiles: TileState[]
  theme: AppTheme
  activePanelId: string | null
  nextZIndex: number
  getPanelTileLabel: (tileId: string) => string
  getPanelTileIcon: (tileId: string) => string | undefined
  renderTileBody: (tile: TileState, options?: RenderTileBodyOptions) => React.ReactNode
  viewportCenter: () => { x: number, y: number }
  getInitialTileSize: (type: TileState['type']) => { w: number, h: number }
  snapValue: (value: number) => number
  setPanelLayout: React.Dispatch<React.SetStateAction<PanelNode | null>>
  applyLivePanelLayout?: React.Dispatch<React.SetStateAction<PanelNode | null>>
  closeTile: (tileId: string) => void
  addTile: (type: TileState['type'], filePath?: string, world?: { x: number, y: number }) => string
  exitExpandedMode: () => void
  setActivePanelId: React.Dispatch<React.SetStateAction<string | null>>
  handleLaunchTemplate: (template: LayoutTemplate) => void | Promise<void>
  setTiles: React.Dispatch<React.SetStateAction<TileState[]>>
  setGroups?: React.Dispatch<React.SetStateAction<GroupState[]>>
  setNextZIndex: React.Dispatch<React.SetStateAction<number>>
  expandLayoutGroupId?: string | null
  tilesRef?: MutableRefObject<TileState[]>
  groupsRef?: MutableRefObject<GroupState[]>
  screenToWorld?: (sx: number, sy: number) => { x: number, y: number }
  ejectPanelTab?: (tileId: string, position: { x: number, y: number }, zIndex: number) => void
}

export function useAppCanvasConnectionProps(params: UseAppCanvasConnectionPropsParams): Omit<AppCanvasConnectionsProps, 'layer'> {
  const {
    panelLayout,
    manualConnectionRenderRoutes,
    ambientDiscoveryRenderRoutes,
    discoveryPreview,
    discoveryFocusTileId,
    lockedConnectionKeys,
    discoveryPulses,
    dragState,
    viewportZoom,
    gridSize,
    gridSpacingSmall,
    dsc,
    tileByIdMap,
    discoveryPillZIndex,
    discoveryHighlightZIndex,
    discoveryGlowZIndex,
    canvasGlowEnabled,
    discoveryGlowRef,
    worldToScreenPoint,
    isConnectionLocked,
    toggleConnectionLock,
    deleteConnection,
  } = params

  return useMemo(() => ({
    panelLayout,
    manualConnectionRenderRoutes,
    ambientDiscoveryRenderRoutes,
    discoveryPreview,
    discoveryFocusTileId,
    lockedConnectionKeys,
    discoveryPulses,
    dragState,
    viewportZoom,
    gridSize,
    gridSpacingSmall,
    dsc,
    tileByIdMap,
    discoveryPillZIndex,
    discoveryHighlightZIndex,
    discoveryGlowZIndex,
    canvasGlowEnabled,
    discoveryGlowRef,
    worldToScreenPoint,
    isConnectionLocked,
    onToggleConnectionLock: toggleConnectionLock,
    onDeleteConnection: deleteConnection,
  }), [
    panelLayout,
    manualConnectionRenderRoutes,
    ambientDiscoveryRenderRoutes,
    discoveryPreview,
    discoveryFocusTileId,
    lockedConnectionKeys,
    discoveryPulses,
    dragState,
    viewportZoom,
    gridSize,
    gridSpacingSmall,
    dsc,
    tileByIdMap,
    discoveryPillZIndex,
    discoveryHighlightZIndex,
    discoveryGlowZIndex,
    canvasGlowEnabled,
    worldToScreenPoint,
    isConnectionLocked,
    toggleConnectionLock,
    deleteConnection,
  ])
}

export function useAppCanvasPanelRegionProps(params: UseAppCanvasPanelRegionPropsParams): AppCanvasPanelRegionProps {
  const {
    panelLayout,
    mainPanelCornerRadii,
    tiles,
    theme,
    activePanelId,
    nextZIndex,
    getPanelTileLabel,
    getPanelTileIcon,
    renderTileBody,
    viewportCenter,
    getInitialTileSize,
    snapValue,
    setPanelLayout,
    applyLivePanelLayout,
    closeTile,
    addTile,
    exitExpandedMode,
    setActivePanelId,
    handleLaunchTemplate,
    setTiles,
    setGroups,
    setNextZIndex,
    expandLayoutGroupId,
    tilesRef,
    groupsRef,
    screenToWorld,
    ejectPanelTab,
  } = params

  return useMemo(() => ({
    panelLayout,
    mainPanelCornerRadii,
    tiles,
    theme,
    activePanelId,
    nextZIndex,
    getPanelTileLabel,
    getPanelTileIcon,
    renderTileBody,
    viewportCenter,
    getInitialTileSize,
    snapValue,
    onLayoutChange: applyLivePanelLayout ?? setPanelLayout,
    onCloseTab: closeTile,
    onAddTile: addTile,
    onExitExpandedMode: exitExpandedMode,
    onActivePanelChange: setActivePanelId,
    onLaunchTemplate: handleLaunchTemplate,
    setTiles,
    setGroups,
    setNextZIndex,
    expandLayoutGroupId,
    tilesRef,
    groupsRef,
    onTabDropOutside: ejectPanelTab && screenToWorld
      ? (tileId, clientX, clientY) => {
        const current = tilesRef?.current.find(tile => tile.id === tileId)
          ?? tiles.find(tile => tile.id === tileId)
        const fallback = getInitialTileSize(current?.type ?? 'note')
        const position = pointerEjectPosition(screenToWorld(clientX, clientY), current?.width || fallback.w, snapValue)
        ejectPanelTab(tileId, position, nextZIndex)
        setNextZIndex(value => value + 1)
      }
      : undefined,
  }), [
    panelLayout,
    mainPanelCornerRadii,
    tiles,
    theme,
    activePanelId,
    nextZIndex,
    getPanelTileLabel,
    getPanelTileIcon,
    renderTileBody,
    viewportCenter,
    getInitialTileSize,
    snapValue,
    setPanelLayout,
    applyLivePanelLayout,
    closeTile,
    addTile,
    exitExpandedMode,
    setActivePanelId,
    handleLaunchTemplate,
    setTiles,
    setGroups,
    setNextZIndex,
    expandLayoutGroupId,
    tilesRef,
    groupsRef,
    screenToWorld,
    ejectPanelTab,
  ])
}