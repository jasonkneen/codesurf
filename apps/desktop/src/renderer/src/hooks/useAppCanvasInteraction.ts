/**
 * Small facade over the independently bounded canvas interaction domains.
 * App supplies stable state/action bundles; pointer/drag and group/menu/keyboard
 * composition live in separate modules so this hook does not become a second App.
 */
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react'
import type { GroupState, TileState } from '../../../shared/types.ts'
import type { PanelNode } from '../components/panelLayoutTree.ts'
import type {
  CanvasAnchorPoint,
  CanvasAnchorSide,
  CanvasDragState,
} from './useCanvasDragSync.ts'
import type { CanvasContextMenuItem } from './useCanvasContextMenus.ts'
import type { CanvasViewport, SaveCanvasFn, PersistCanvasStateFn } from './canvasEngineMath.ts'
import type { AlignmentGuide } from './canvasAlignment.ts'
import { useCanvasDragSync } from './useCanvasDragSync.ts'
import { useAppCanvasPointerInteraction } from './useAppCanvasPointerInteraction.ts'
import { useAppCanvasGroupInteraction } from './useAppCanvasGroupInteraction.ts'
import { useLockedConnectionHelpers } from './useCanvasConnectionLock.ts'

type UseCanvasDragSyncEngine = Parameters<typeof useCanvasDragSync>[0]['engine']

export type AppCanvasInteractionEngine = {
  canvasRef: RefObject<HTMLDivElement | null>
  canvasEngine: UseCanvasDragSyncEngine
  viewport: CanvasViewport
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndex: number
  nextZIndexRef: MutableRefObject<number>
  panLastPos: MutableRefObject<{ x: number; y: number; t: number }>
  cancelPanInertia: () => void
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  spaceHeld: MutableRefObject<boolean>
  snapValue: (value: number) => number
  saveCanvas: SaveCanvasFn
  persistCanvasState: PersistCanvasStateFn
  undoCanvas: () => void
  redoCanvas: () => void
}

export type AppCanvasInteractionState = {
  tiles: TileState[]
  groups: GroupState[]
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  selectedTileId: string | null
  selectedTileIds: Set<string>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  dragState: CanvasDragState
  setDragState: Dispatch<SetStateAction<CanvasDragState>>
  setGuides: Dispatch<SetStateAction<AlignmentGuide[]>>
  setCanvasPointerWorld: Dispatch<SetStateAction<{ x: number; y: number } | null>>
  setHoveredConnectionHandle: Dispatch<SetStateAction<{ tileId: string; side: CanvasAnchorSide } | null>>
  setCtxMenu: Dispatch<SetStateAction<{ x: number; y: number; items: CanvasContextMenuItem[] } | null>>
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>
}

export type AppCanvasInteractionPanel = {
  panelLayout: PanelNode | null
  panelTileIdsRef: MutableRefObject<Set<string>>
  setPanelLayout: Dispatch<SetStateAction<PanelNode | null>>
  setActivePanelId: Dispatch<SetStateAction<string | null>>
  setExpandedTileId: Dispatch<SetStateAction<string | null>>
  setExpandLayoutGroupId: Dispatch<SetStateAction<string | null>>
  expandLayoutGroupIdRef: MutableRefObject<string | null>
  setExpandedCanvasGroupId: Dispatch<SetStateAction<string | null>>
  expandedCanvasGroupIdRef: MutableRefObject<string | null>
  expandedCanvasPriorViewportRef: MutableRefObject<CanvasViewport | null>
  exitCanvasExpandedRef: MutableRefObject<() => void>
}

export type AppCanvasInteractionConnections = {
  lockedConnections: Array<{ sourceTileId: string; targetTileId: string }>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  setLockedConnections: Dispatch<SetStateAction<Array<{ sourceTileId: string; targetTileId: string }>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
  suppressedConnectionsRef: MutableRefObject<Set<string>>
  lockConnection: (tileA: string, tileB: string) => void
  triggerDiscoveryPulse: (tileId: string, tileList: TileState[]) => void
  findManualConnectionTarget: (
    sourceTileId: string,
    point: { x: number; y: number },
    tiles: TileState[],
    panelTileIds: Set<string>,
    getTileCenter: (tile: TileState) => { x: number; y: number },
  ) => string | null
  getTileCenter: (tile: TileState) => { x: number; y: number }
  getConnectionHandlePoint: (tile: TileState, side: CanvasAnchorSide) => CanvasAnchorPoint
}

export type AppCanvasInteractionTileActions = {
  clipboardRef: MutableRefObject<TileState[]>
  pasteTiles: (pos?: { x: number; y: number }, intoGroupId?: string) => void
  copyTiles: (cut?: boolean) => void
  duplicateTiles: (ids?: string[]) => void
  closeTile: (id: string) => void
  addTile: (type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => string
  bringToFront: (id: string) => void
  pinnedCanvasExtensionTiles: Array<{ type: string; label: string }>
  workspacePath: string | null | undefined
  importFileToWorkspace: (filePath: string, tileId: string) => void | Promise<unknown>
  handleCanvasEscape: () => void
}

export type AppCanvasInteractionActionRefs = {
  pasteTilesRef: MutableRefObject<(pos?: { x: number; y: number }, intoGroupId?: string) => void>
  duplicateTilesRef: MutableRefObject<(ids?: string[]) => void>
  copyTilesRef: MutableRefObject<(cut?: boolean) => void>
  groupSelectedTilesRef: MutableRefObject<() => void>
  groupBoundsRef: MutableRefObject<(id: string) => { x: number; y: number; w: number; h: number } | null>
  ungroupTilesRef: MutableRefObject<(groupId: string) => void>
  ungroupAllRef: MutableRefObject<(groupId: string) => void>
}

export type UseAppCanvasInteractionParams = {
  engine: AppCanvasInteractionEngine
  state: AppCanvasInteractionState
  panel: AppCanvasInteractionPanel
  connections: AppCanvasInteractionConnections
  tileActions: AppCanvasInteractionTileActions
  actionRefs: AppCanvasInteractionActionRefs
}

export function useAppCanvasInteraction(params: UseAppCanvasInteractionParams) {
  const pointer = useAppCanvasPointerInteraction({
    engine: params.engine,
    state: params.state,
    panel: params.panel,
    connections: params.connections,
    bringToFront: params.tileActions.bringToFront,
    addTile: params.tileActions.addTile,
    groupBoundsRef: params.actionRefs.groupBoundsRef,
  })
  const groups = useAppCanvasGroupInteraction({
    engine: params.engine,
    state: params.state,
    panel: params.panel,
    tileActions: params.tileActions,
    actionRefs: params.actionRefs,
  })
  const connections = useLockedConnectionHelpers({
    lockedConnections: params.connections.lockedConnections,
    persistCanvasState: params.engine.persistCanvasState,
    tilesRef: params.state.tilesRef,
    groupsRef: params.state.groupsRef,
    viewportRef: params.engine.viewportRef,
    nextZIndexRef: params.engine.nextZIndexRef,
    lockedConnectionsRef: params.connections.lockedConnectionsRef,
    setLockedConnections: params.connections.setLockedConnections,
    setSuppressedConnections: params.connections.setSuppressedConnections,
  })
  return { ...pointer, ...groups, ...connections }
}
