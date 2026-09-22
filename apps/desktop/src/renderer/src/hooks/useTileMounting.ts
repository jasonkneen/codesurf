import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { GroupState, TileState, Workspace } from '../../../shared/types'
import { addTilesToGroupLayout, removeTileFromAllGroupLayouts } from '../lib/layoutGroupMembership.ts'
import { isMediaFile } from '../utils/dnd'
import {
  findClearPosition,
  getMinTileHeight,
  getMinTileWidth,
  TILE_PLACEMENT_GRID,
} from '../utils/tilePlacement'
import { disposeChatTileRuntimeState } from '../components/chatTileRuntimeState'
import { disposeMediaTile } from '../components/mediaTileRegistry'
import {
  addTabToLeaf,
  createLeaf,
  findLeafByTileId,
  pinTabInLeaf,
  removeTileFromTree,
  replaceTabInLeaf,
  setActiveTab,
  type PanelNode,
} from '../components/panelLayoutTree'
import type { CanvasViewport, SaveCanvasFn } from './useCanvasEngine'

export type TileMountInitialOptions = {
  hideTitlebar?: boolean
  hideNavbar?: boolean
  launchBin?: string
  launchArgs?: string[]
}

export type UseTileMountingOptions = {
  workspace: Workspace | null
  gridSize: number
  gridSpacingSmall: number
  tilesRef: MutableRefObject<TileState[]>
  panelTileIdsRef: MutableRefObject<Set<string>>
  panelLayoutRef: MutableRefObject<PanelNode | null>
  expandLayoutGroupIdRef: MutableRefObject<string | null>
  activePanelIdRef: MutableRefObject<string | null>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndexRef: MutableRefObject<number>
  selectedTileId: string | null
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setNextZIndex: Dispatch<SetStateAction<number>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setPanelLayout: Dispatch<SetStateAction<PanelNode | null>>
  setActivePanelId: Dispatch<SetStateAction<string | null>>
  setChatTileSessionMatches: Dispatch<SetStateAction<Record<string, { entryId: string | null, sessionId: string | null }>>>
  saveCanvas: SaveCanvasFn
  viewportCenter: () => { x: number, y: number }
  snapValue: (value: number) => number
  getInitialTileSize: (type: TileState['type']) => { w: number, h: number }
  triggerDiscoveryPulse: (tileId: string, tiles: TileState[]) => void
}

export function useTileMounting({
  workspace,
  gridSize,
  gridSpacingSmall,
  tilesRef,
  panelTileIdsRef,
  panelLayoutRef,
  expandLayoutGroupIdRef,
  activePanelIdRef,
  setGroups,
  viewportRef,
  nextZIndexRef,
  selectedTileId,
  setTiles,
  setNextZIndex,
  setSelectedTileId,
  setPanelLayout,
  setActivePanelId,
  setChatTileSessionMatches,
  saveCanvas,
  viewportCenter,
  snapValue,
  getInitialTileSize,
  triggerDiscoveryPulse,
}: UseTileMountingOptions) {
  const cleanupTileResources = useCallback((tileId: string) => {
    const tile = tilesRef.current.find(candidate => candidate.id === tileId)
    if (tile?.type === 'terminal' && workspace?.id) {
      window.electron.terminal.destroy(tileId, workspace.id)
    }
    if (tile?.type === 'chat') {
      if (workspace?.id) {
        disposeChatTileRuntimeState(workspace.id, tileId)
        void window.electron.chat?.disposeCard?.(workspace.id, tileId)
      }
      // The chat tile can embed a terminal under a deterministic derived id
      // (`${tileId}-terminal`). Tear down its PTY too, since that backend is
      // keyed by tileId and would otherwise leak when the chat tile closes.
      if (workspace?.id) {
        window.electron.terminal.destroy(`${tileId}-terminal`, workspace.id)
      }
    }
    if (tile?.type === 'media') {
      disposeMediaTile(tileId)
    }
    if (workspace?.id) {
      void Promise.allSettled([
        window.electron?.system?.cleanupTile?.(workspace.id, tileId),
        window.electron.canvas.deleteTileArtifacts(workspace.id, tileId),
        window.electron.activity.clearTile(workspace.id, tileId),
        workspace.path ? window.electron?.collab?.removeTileDir?.(workspace.path, tileId) : Promise.resolve(true),
      ])
    }
  }, [tilesRef, workspace?.id, workspace?.path])

  const buildTileState = useCallback((
    type: TileState['type'],
    filePath?: string,
    pos?: { x: number, y: number },
    initialOptions?: TileMountInitialOptions,
  ) => {
    const center = pos ?? viewportCenter()
    const { w, h } = getInitialTileSize(type)
    const minW = getMinTileWidth(type)
    const minH = getMinTileHeight(type)
    const width = Math.max(w, minW)
    const height = Math.max(h, minH)
    const placementStep = Math.max(16, gridSize || gridSpacingSmall || TILE_PLACEMENT_GRID)
    const preferred = {
      x: snapValue(center.x - width / 2),
      y: snapValue(center.y - height / 2),
    }
    const position = findClearPosition(
      preferred.x,
      preferred.y,
      width,
      height,
      tilesRef.current,
      panelTileIdsRef.current,
      placementStep,
    )

    const isMedia = !!filePath && isMediaFile(filePath)
    const defaultHideTitlebar = isMedia ? true : undefined
    const defaultHideNavbar = isMedia ? true : undefined

    return {
      id: `tile-${Date.now()}`,
      type,
      x: position.x,
      y: position.y,
      width,
      height,
      zIndex: nextZIndexRef.current,
      filePath,
      hideTitlebar: initialOptions?.hideTitlebar ?? defaultHideTitlebar,
      hideNavbar: initialOptions?.hideNavbar ?? defaultHideNavbar,
      launchBin: initialOptions?.launchBin,
      launchArgs: initialOptions?.launchArgs,
    }
  }, [
    getInitialTileSize,
    gridSize,
    gridSpacingSmall,
    nextZIndexRef,
    panelTileIdsRef,
    snapValue,
    tilesRef,
    viewportCenter,
  ])

  const mountTile = useCallback((
    newTile: TileState,
    options?: { panelId?: string | null, preview?: boolean },
  ): string => {
    const panelId = options?.panelId ?? activePanelIdRef.current
    const layoutGroupId = expandLayoutGroupIdRef.current
    const tileToMount = layoutGroupId && panelLayoutRef.current
      ? { ...newTile, groupId: layoutGroupId }
      : newTile
    let updatedTiles = tilesRef.current
    let newNZ = nextZIndexRef.current
    setTiles(prev => {
      updatedTiles = [...prev, tileToMount]
      tilesRef.current = updatedTiles
      newNZ = Math.max(nextZIndexRef.current, tileToMount.zIndex) + 1
      nextZIndexRef.current = newNZ
      saveCanvas(updatedTiles, viewportRef.current, newNZ)
      return updatedTiles
    })
    setNextZIndex(newNZ)
    setSelectedTileId(tileToMount.id)
    if (panelLayoutRef.current && panelId) {
      setPanelLayout(prev => prev ? addTabToLeaf(prev, panelId, tileToMount.id, { preview: options?.preview }) : prev)
      setActivePanelId(panelId)
    }
    if (layoutGroupId) {
      setGroups(prev => addTilesToGroupLayout(prev, updatedTiles, layoutGroupId, [tileToMount.id]))
    }
    window.setTimeout(() => triggerDiscoveryPulse(tileToMount.id, updatedTiles), 40)
    return tileToMount.id
  }, [
    activePanelIdRef,
    expandLayoutGroupIdRef,
    nextZIndexRef,
    panelLayoutRef,
    saveCanvas,
    setActivePanelId,
    setGroups,
    setNextZIndex,
    setPanelLayout,
    setSelectedTileId,
    setTiles,
    tilesRef,
    triggerDiscoveryPulse,
    viewportRef,
  ])

  const replacePreviewTile = useCallback((
    currentTileId: string,
    newTile: TileState,
    panelId: string,
    options?: { preview?: boolean },
  ): string => {
    cleanupTileResources(currentTileId)
    const layoutGroupId = expandLayoutGroupIdRef.current
    const tileToAdd = layoutGroupId ? { ...newTile, groupId: layoutGroupId } : newTile
    setGroups(prev => removeTileFromAllGroupLayouts(prev, currentTileId))
    let updatedTiles = tilesRef.current
    let newNZ = nextZIndexRef.current
    setTiles(prev => {
      updatedTiles = [...prev.filter(tile => tile.id !== currentTileId), tileToAdd]
      tilesRef.current = updatedTiles
      newNZ = Math.max(nextZIndexRef.current, newTile.zIndex) + 1
      nextZIndexRef.current = newNZ
      saveCanvas(updatedTiles, viewportRef.current, newNZ)
      return updatedTiles
    })
    setNextZIndex(newNZ)
    setSelectedTileId(tileToAdd.id)
    setPanelLayout(prev => prev
      ? setActiveTab(replaceTabInLeaf(prev, panelId, currentTileId, tileToAdd.id, { preview: options?.preview }), panelId, tileToAdd.id)
      : prev)
    setActivePanelId(panelId)
    setChatTileSessionMatches(prev => {
      if (!(currentTileId in prev)) return prev
      const next = { ...prev }
      delete next[currentTileId]
      return next
    })
    window.setTimeout(() => triggerDiscoveryPulse(tileToAdd.id, updatedTiles), 40)
    return tileToAdd.id
  }, [
    cleanupTileResources,
    expandLayoutGroupIdRef,
    nextZIndexRef,
    saveCanvas,
    setActivePanelId,
    setChatTileSessionMatches,
    setGroups,
    setNextZIndex,
    setPanelLayout,
    setSelectedTileId,
    setTiles,
    tilesRef,
    triggerDiscoveryPulse,
    viewportRef,
  ])

  const pinPreviewTab = useCallback((tileId: string) => {
    const layout = panelLayoutRef.current
    if (!layout) return
    const leaf = findLeafByTileId(layout, tileId)
    if (!leaf) return
    const leafId = leaf.id
    if (leaf.previewTabId !== tileId) return
    setPanelLayout(prev => prev ? pinTabInLeaf(prev, leafId, tileId) : prev)
  }, [panelLayoutRef, setPanelLayout])

  const addTile = useCallback((
    type: TileState['type'],
    filePath?: string,
    pos?: { x: number, y: number },
    initialOptions?: TileMountInitialOptions,
  ) => {
    const newTile = buildTileState(type, filePath, pos, initialOptions)
    return mountTile(newTile, { panelId: panelLayoutRef.current ? activePanelIdRef.current : null, preview: false })
  }, [activePanelIdRef, buildTileState, mountTile, panelLayoutRef])

  const closeTile = useCallback((id: string) => {
    cleanupTileResources(id)
    setGroups(prev => removeTileFromAllGroupLayouts(prev, id))
    setTiles(prev => {
      const updated = prev.filter(tile => tile.id !== id)
      saveCanvas(updated, viewportRef.current, nextZIndexRef.current)
      return updated
    })
    setPanelLayout(prev => {
      if (!prev) return prev
      const next = removeTileFromTree(prev, id)
      if (next) return next
      const emptyLeaf = createLeaf([])
      setActivePanelId(emptyLeaf.id)
      return emptyLeaf
    })
    setChatTileSessionMatches(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (selectedTileId === id) setSelectedTileId(null)
  }, [
    cleanupTileResources,
    nextZIndexRef,
    saveCanvas,
    selectedTileId,
    setActivePanelId,
    setChatTileSessionMatches,
    setGroups,
    setPanelLayout,
    setSelectedTileId,
    setTiles,
    viewportRef,
  ])

  return {
    buildTileState,
    mountTile,
    replacePreviewTile,
    pinPreviewTab,
    addTile,
    closeTile,
    cleanupTileResources,
  }
}
