import type {
  AppCanvasInteractionConnections,
  AppCanvasInteractionEngine,
  AppCanvasInteractionPanel,
  AppCanvasInteractionState,
} from './useAppCanvasInteraction.ts'
import type { MutableRefObject } from 'react'
import type { TileState } from '../../../shared/types.ts'
import { useCanvasDragSync } from './useCanvasDragSync.ts'
import {
  useCanvasPointerHandlers,
  useConnectionHandleHover,
} from './useCanvasPointerHandlers.ts'
import { useEnforceTileMinimumSizes } from './useCanvasConnectionLock.ts'
import { getMinTileHeight, getMinTileWidth } from '../utils/tilePlacement.ts'

export type UseAppCanvasPointerInteractionParams = {
  engine: Pick<AppCanvasInteractionEngine,
    | 'canvasRef' | 'canvasEngine' | 'viewport' | 'nextZIndex' | 'panLastPos'
    | 'cancelPanInertia' | 'screenToWorld' | 'spaceHeld' | 'snapValue' | 'saveCanvas'>
  state: Pick<AppCanvasInteractionState,
    | 'tiles' | 'groups' | 'setTiles' | 'setGroups' | 'tilesRef' | 'groupsRef'
    | 'setSelectedTileId' | 'setSelectedTileIds' | 'dragState' | 'setDragState'
    | 'setGuides' | 'setCanvasPointerWorld' | 'setHoveredConnectionHandle'>
  panel: Pick<AppCanvasInteractionPanel, 'panelLayout' | 'panelTileIdsRef'>
  connections: Pick<AppCanvasInteractionConnections,
    | 'setSuppressedConnections' | 'suppressedConnectionsRef' | 'lockConnection' | 'triggerDiscoveryPulse'
    | 'findManualConnectionTarget' | 'getTileCenter' | 'getConnectionHandlePoint'>
  bringToFront: (id: string) => void
  addTile: (type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => string
  groupBoundsRef: MutableRefObject<(id: string) => { x: number; y: number; w: number; h: number } | null>
}

export function useAppCanvasPointerInteraction(params: UseAppCanvasPointerInteractionParams) {
  const { engine, state, panel, connections, bringToFront, addTile, groupBoundsRef } = params

  useEnforceTileMinimumSizes({
    tiles: state.tiles,
    viewport: engine.viewport,
    nextZIndex: engine.nextZIndex,
    saveCanvas: engine.saveCanvas,
    setTiles: state.setTiles,
    getMinTileWidth,
    getMinTileHeight,
  })

  const pointerHandlers = useCanvasPointerHandlers({
    canvasRef: engine.canvasRef,
    viewport: engine.viewport,
    setDragState: state.setDragState,
    setSelectedTileId: state.setSelectedTileId,
    setSelectedTileIds: state.setSelectedTileIds,
    panLastPos: engine.panLastPos,
    cancelPanInertia: engine.cancelPanInertia,
    screenToWorld: engine.screenToWorld,
    spaceHeld: engine.spaceHeld,
    bringToFront,
    getConnectionHandlePoint: connections.getConnectionHandlePoint,
    panelLayout: panel.panelLayout,
    addTile,
  })

  const hoverHandlers = useConnectionHandleHover({
    setHoveredConnectionHandle: state.setHoveredConnectionHandle,
  })

  useCanvasDragSync({
    canvasRef: engine.canvasRef,
    dragState: state.dragState,
    setDragState: state.setDragState,
    engine: engine.canvasEngine,
    tilesRef: state.tilesRef,
    groupsRef: state.groupsRef,
    groups: state.groups,
    setTiles: state.setTiles,
    setGroups: state.setGroups,
    setGuides: state.setGuides,
    setCanvasPointerWorld: state.setCanvasPointerWorld,
    setSelectedTileIds: state.setSelectedTileIds,
    setSuppressedConnections: connections.setSuppressedConnections,
    suppressedConnectionsRef: connections.suppressedConnectionsRef,
    panelTileIdsRef: panel.panelTileIdsRef,
    groupBoundsRef,
    snapValue: engine.snapValue,
    resolveManualConnectionTarget: (sourceTileId, point) => (
      connections.findManualConnectionTarget(
        sourceTileId,
        point,
        state.tilesRef.current,
        panel.panelTileIdsRef.current,
        connections.getTileCenter,
      )
    ),
    lockConnection: connections.lockConnection,
    triggerDiscoveryPulse: connections.triggerDiscoveryPulse,
    getMinTileWidth,
    getMinTileHeight,
  })

  return { ...pointerHandlers, ...hoverHandlers }
}
