import { useCallback } from 'react'
import type {
  AppCanvasInteractionActionRefs,
  AppCanvasInteractionEngine,
  AppCanvasInteractionPanel,
  AppCanvasInteractionState,
  AppCanvasInteractionTileActions,
} from './useAppCanvasInteraction.ts'
import { findFirstLeafId, type PanelNode } from '../components/panelLayoutTree.ts'
import { useCanvasContextMenu, useTileContextMenu } from './useCanvasContextMenus.ts'
import { useCanvasGroupManager } from './useCanvasGroupManager.ts'
import { useCanvasKeyboard } from './useCanvasKeyboard.ts'
import { useCanvasTileShortcuts } from './useCanvasTileShortcuts.ts'
import { useCanvasExpandedGroup } from './useCanvasConnectionLock.ts'

export type UseAppCanvasGroupInteractionParams = {
  engine: Pick<AppCanvasInteractionEngine,
    | 'canvasRef' | 'viewport' | 'setViewport' | 'viewportRef' | 'nextZIndex'
    | 'saveCanvas' | 'undoCanvas' | 'redoCanvas' | 'spaceHeld' | 'screenToWorld'>
  state: Pick<AppCanvasInteractionState,
    | 'tiles' | 'groups' | 'setTiles' | 'setGroups' | 'tilesRef' | 'groupsRef'
    | 'selectedTileId' | 'selectedTileIds' | 'setSelectedTileId' | 'setSelectedTileIds'
    | 'setCtxMenu' | 'setCommandPaletteOpen'>
  panel: AppCanvasInteractionPanel
  tileActions: AppCanvasInteractionTileActions
  actionRefs: AppCanvasInteractionActionRefs
}

export function useAppCanvasGroupInteraction(params: UseAppCanvasGroupInteractionParams) {
  const { engine, state, panel, tileActions, actionRefs } = params
  const groupManager = useCanvasGroupManager({
    tiles: state.tiles,
    groups: state.groups,
    selectedTileIds: state.selectedTileIds,
    viewport: engine.viewport,
    nextZIndex: engine.nextZIndex,
    setTiles: state.setTiles,
    setGroups: state.setGroups,
    setSelectedTileIds: state.setSelectedTileIds,
    saveCanvas: engine.saveCanvas,
  })

  const handleCanvasContextMenu = useCanvasContextMenu({
    screenToWorld: engine.screenToWorld,
    panelLayout: panel.panelLayout,
    groups: state.groups,
    groupBoundsRef: actionRefs.groupBoundsRef,
    addTile: tileActions.addTile,
    pinnedCanvasExtensionTiles: tileActions.pinnedCanvasExtensionTiles,
    clipboardRef: tileActions.clipboardRef,
    pasteAt: (pos, groupId) => actionRefs.pasteTilesRef.current(pos, groupId),
    selectedTileIds: state.selectedTileIds,
    groupSelectedTiles: () => actionRefs.groupSelectedTilesRef.current(),
    setCtxMenu: state.setCtxMenu,
  })

  useCanvasKeyboard({
    selectedTileIds: state.selectedTileIds,
    groupSelectedTiles: groupManager.groupSelectedTiles,
    setCommandPaletteOpen: state.setCommandPaletteOpen,
    undoCanvas: engine.undoCanvas,
    redoCanvas: engine.redoCanvas,
    onEscape: tileActions.handleCanvasEscape,
    spaceHeldRef: engine.spaceHeld,
  })

  const handleTileContextMenu = useTileContextMenu({
    viewport: engine.viewport,
    nextZIndex: engine.nextZIndex,
    groups: state.groups,
    workspacePath: tileActions.workspacePath,
    saveCanvas: engine.saveCanvas,
    setTiles: state.setTiles,
    setGroups: state.setGroups,
    setSelectedTileId: state.setSelectedTileId,
    setSelectedTileIds: state.setSelectedTileIds,
    setCtxMenu: state.setCtxMenu,
    clipboardRef: tileActions.clipboardRef,
    duplicateTiles: tileActions.duplicateTiles,
    copyTiles: tileActions.copyTiles,
    pasteTiles: tileActions.pasteTiles,
    ungroupTiles: groupManager.ungroupTiles,
    ungroupAll: groupManager.ungroupAll,
    closeTile: tileActions.closeTile,
    importFileToWorkspace: tileActions.importFileToWorkspace,
  })

  const expandLayoutGroup = useCallback((groupId: string) => {
    const group = state.groupsRef.current.find(candidate => candidate.id === groupId)
    if (!group?.layout) return
    const layout = group.layout as PanelNode
    panel.setExpandLayoutGroupId(groupId)
    panel.expandLayoutGroupIdRef.current = groupId
    panel.setPanelLayout(layout)
    panel.setActivePanelId(findFirstLeafId(layout))
    panel.setExpandedTileId(null)
  }, [state.groupsRef, panel])

  const expandedGroup = useCanvasExpandedGroup({
    canvasRef: engine.canvasRef,
    viewportRef: engine.viewportRef,
    expandedCanvasPriorViewportRef: panel.expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef: panel.expandedCanvasGroupIdRef,
    groupsRef: state.groupsRef,
    setViewport: engine.setViewport,
    setExpandedCanvasGroupId: panel.setExpandedCanvasGroupId,
    setExpandedTileId: panel.setExpandedTileId,
    groupBounds: groupManager.groupBounds,
  })
  panel.exitCanvasExpandedRef.current = expandedGroup.exitCanvasExpanded

  actionRefs.pasteTilesRef.current = tileActions.pasteTiles
  actionRefs.duplicateTilesRef.current = tileActions.duplicateTiles
  actionRefs.copyTilesRef.current = tileActions.copyTiles
  actionRefs.groupSelectedTilesRef.current = groupManager.groupSelectedTiles
  actionRefs.groupBoundsRef.current = groupManager.groupBounds
  actionRefs.ungroupTilesRef.current = groupManager.ungroupTiles
  actionRefs.ungroupAllRef.current = groupManager.ungroupAll

  useCanvasTileShortcuts({
    selectedTileId: state.selectedTileId,
    selectedTileIds: state.selectedTileIds,
    viewport: engine.viewport,
    nextZIndex: engine.nextZIndex,
    setTiles: state.setTiles,
    setSelectedTileId: state.setSelectedTileId,
    setSelectedTileIds: state.setSelectedTileIds,
    saveCanvas: engine.saveCanvas,
    copyTiles: tileActions.copyTiles,
    pasteTiles: tileActions.pasteTiles,
    duplicateTiles: tileActions.duplicateTiles,
  })

  return {
    handleCanvasContextMenu,
    handleTileContextMenu,
    ...groupManager,
    expandLayoutGroup,
    ...expandedGroup,
  }
}
