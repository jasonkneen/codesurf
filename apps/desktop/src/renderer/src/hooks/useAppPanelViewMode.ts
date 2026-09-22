import { useCallback, useEffect, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { GroupState, TileState } from '../../../shared/types'
import {
  findFirstLeafId,
  getAllTileIds,
  type PanelNode,
} from '../components/panelLayoutTree'
import {
  activateTileInLayout,
  applyLayoutToGroup,
  applyPanelTabEject,
  commitGroupLayout,
  ensureLayoutGroup,
  layoutBoundsForArrangement,
  measureFullscreenPanelSize,
  findReusableArrangementGroupId,
  resolveExpandFromTile,
  resolveWorkspaceTabArrangement,
  tileIdsInLayout,
  type ArrangementResolution,
} from '../lib/layoutGroupMembership.ts'

export type UseAppPanelViewModeParams = {
  panelLayout: PanelNode | null
  panelLayoutRef: RefObject<PanelNode | null>
  expandedTileIdRef: RefObject<string | null>
  expandLayoutGroupIdRef: MutableRefObject<string | null>
  expandedCanvasGroupIdRef: RefObject<string | null>
  panelTileIdsRef: RefObject<Set<string>>
  tilesRef: RefObject<TileState[]>
  groupsRef: RefObject<GroupState[]>
  selectedTileIdRef: RefObject<string | null>
  viewportRef: RefObject<{ tx: number, ty: number, zoom: number }>
  nextZIndexRef: RefObject<number>
  persistCanvasStateRef: RefObject<((tiles: TileState[], viewport: { tx: number, ty: number, zoom: number }, nextZIndex: number, groups: GroupState[]) => void) | null>
  savedLayoutRef: RefObject<PanelNode | null>
  setPanelLayout: React.Dispatch<React.SetStateAction<PanelNode | null>>
  setExpandedTileId: React.Dispatch<React.SetStateAction<string | null>>
  setActivePanelId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandLayoutGroupId: React.Dispatch<React.SetStateAction<string | null>>
  setGroups: React.Dispatch<React.SetStateAction<GroupState[]>>
  setTiles: React.Dispatch<React.SetStateAction<TileState[]>>
  exitCanvasExpandedRef: RefObject<() => void>
}

export function useAppPanelViewMode(params: UseAppPanelViewModeParams) {
  const {
    panelLayout,
    panelLayoutRef,
    expandLayoutGroupIdRef,
    expandedCanvasGroupIdRef,
    tilesRef,
    groupsRef,
    selectedTileIdRef,
    viewportRef,
    nextZIndexRef,
    persistCanvasStateRef,
    savedLayoutRef,
    setPanelLayout,
    setExpandedTileId,
    setActivePanelId,
    setExpandLayoutGroupId,
    setGroups,
    setTiles,
    exitCanvasExpandedRef,
  } = params

  const persistNow = useCallback((tiles: TileState[], groups: GroupState[]) => {
    const viewport = viewportRef.current
    if (!viewport) return
    persistCanvasStateRef.current?.(tiles, viewport, nextZIndexRef.current ?? 1, groups)
  }, [nextZIndexRef, persistCanvasStateRef, viewportRef])

  const applyArrangement = useCallback((
    resolution: ArrangementResolution,
    activeTileId?: string | null,
  ): string | null => {
    if (resolution.tileIds.length === 0) return null
    const ensured = ensureLayoutGroup({
      tiles: tilesRef.current,
      groups: groupsRef.current,
      layout: resolution.layout,
      reuseGroupId: resolution.reuseGroupId,
    })
    if (!ensured.groupId) return null

    tilesRef.current = ensured.tiles
    groupsRef.current = ensured.groups
    setTiles(ensured.tiles)
    setGroups(ensured.groups)

    const activated = activeTileId
      ? activateTileInLayout(ensured.layout, activeTileId)
      : { layout: ensured.layout, activePanelId: findFirstLeafId(ensured.layout) }

    expandLayoutGroupIdRef.current = ensured.groupId
    setExpandLayoutGroupId(ensured.groupId)
    savedLayoutRef.current = activated.layout
    setPanelLayout(activated.layout)
    setActivePanelId(activated.activePanelId)
    setExpandedTileId(null)
    persistNow(ensured.tiles, ensured.groups)
    return ensured.groupId
  }, [
    expandLayoutGroupIdRef,
    groupsRef,
    persistNow,
    savedLayoutRef,
    setActivePanelId,
    setExpandLayoutGroupId,
    setExpandedTileId,
    setGroups,
    setPanelLayout,
    setTiles,
    tilesRef,
  ])

  const promoteExpandedTileToLayoutGroup = useCallback(() => {
    if (expandLayoutGroupIdRef.current) return
    const layout = panelLayoutRef.current
    if (!layout) return
    const tileIds = getAllTileIds(layout)
    if (tileIds.length === 0) return
    applyArrangement({
      tileIds,
      layout,
      reuseGroupId: findReusableArrangementGroupId(tilesRef.current, groupsRef.current, tileIds),
    })
  }, [applyArrangement, expandLayoutGroupIdRef, groupsRef, panelLayoutRef, tilesRef])

  useEffect(() => {
    if (!panelLayout) return
    if (expandLayoutGroupIdRef.current) return
    if (tileIdsInLayout(panelLayout).length === 0) return
    promoteExpandedTileToLayoutGroup()
  }, [panelLayout, promoteExpandedTileToLayoutGroup, expandLayoutGroupIdRef])

  const exitExpandedMode = useCallback(() => {
    promoteExpandedTileToLayoutGroup()

    const expandingGroup = expandLayoutGroupIdRef.current
    setPanelLayout(prev => {
      if (expandingGroup && prev) {
        const committed = commitGroupLayout(tilesRef.current, groupsRef.current, expandingGroup, prev)
        const fitted = applyLayoutToGroup(
          committed.groups,
          expandingGroup,
          prev,
          layoutBoundsForArrangement({
            tiles: committed.tiles,
            tileIds: getAllTileIds(prev),
            layout: prev,
            existing: committed.groups.find(group => group.id === expandingGroup)?.layoutBounds,
            panelSize: measureFullscreenPanelSize(),
          }),
        )
        tilesRef.current = committed.tiles
        groupsRef.current = fitted
        savedLayoutRef.current = prev
        setTiles(committed.tiles)
        setGroups(fitted)
        setTimeout(() => persistNow(committed.tiles, committed.groups), 0)
      } else if (!expandingGroup) {
        savedLayoutRef.current = prev
      }
      return null
    })
    setExpandedTileId(null)
    setActivePanelId(null)
    setExpandLayoutGroupId(null)
    expandLayoutGroupIdRef.current = null
  }, [
    expandLayoutGroupIdRef,
    persistNow,
    promoteExpandedTileToLayoutGroup,
    savedLayoutRef,
    setActivePanelId,
    setExpandLayoutGroupId,
    setExpandedTileId,
    setGroups,
    setPanelLayout,
    setTiles,
    tilesRef,
    groupsRef,
  ])

  const applyLivePanelLayout = useCallback((next: SetStateAction<PanelNode | null>) => {
    setPanelLayout(prev => {
      const layout = typeof next === 'function' ? next(prev) : next
      if (!layout) return layout
      savedLayoutRef.current = layout
      const groupId = expandLayoutGroupIdRef.current
      if (groupId) {
        const committed = commitGroupLayout(tilesRef.current, groupsRef.current, groupId, layout)
        tilesRef.current = committed.tiles
        groupsRef.current = committed.groups
        setTiles(committed.tiles)
        setGroups(committed.groups)
        persistNow(committed.tiles, committed.groups)
      }
      return layout
    })
  }, [
    expandLayoutGroupIdRef,
    groupsRef,
    persistNow,
    savedLayoutRef,
    setGroups,
    setPanelLayout,
    setTiles,
    tilesRef,
  ])

  const enterExpandedMode = useCallback((tileId: string) => {
    const resolution = resolveExpandFromTile({
      tileId,
      tiles: tilesRef.current,
      groups: groupsRef.current,
    })
    applyArrangement(resolution, tileId)
  }, [applyArrangement, groupsRef, tilesRef])

  const enterTabbedView = useCallback(() => {
    if (expandLayoutGroupIdRef.current && panelLayoutRef.current) return
    const resolution = resolveWorkspaceTabArrangement({
      tiles: tilesRef.current,
      groups: groupsRef.current,
      savedLayout: savedLayoutRef.current,
      selectedTileId: selectedTileIdRef.current,
    })
    applyArrangement(resolution)
  }, [
    applyArrangement,
    expandLayoutGroupIdRef,
    groupsRef,
    panelLayoutRef,
    savedLayoutRef,
    selectedTileIdRef,
    tilesRef,
  ])

  const handleCanvasEscape = useCallback(() => {
    if (expandedCanvasGroupIdRef.current) {
      exitCanvasExpandedRef.current()
      return
    }
    exitExpandedMode()
  }, [expandedCanvasGroupIdRef, exitCanvasExpandedRef, exitExpandedMode])

  const ejectPanelTab = useCallback((tileId: string, position: { x: number, y: number }, zIndex: number) => {
    const next = applyPanelTabEject({
      tiles: tilesRef.current,
      groups: groupsRef.current,
      panelLayout: panelLayoutRef.current,
      expandLayoutGroupId: expandLayoutGroupIdRef.current,
      tileId,
      position,
      zIndex,
    })
    tilesRef.current = next.tiles
    groupsRef.current = next.groups
    setTiles(next.tiles)
    setGroups(next.groups)
    persistNow(next.tiles, next.groups)
    savedLayoutRef.current = next.panelLayout
    setPanelLayout(next.panelLayout)
    setExpandLayoutGroupId(next.expandLayoutGroupId)
    expandLayoutGroupIdRef.current = next.expandLayoutGroupId
    setActivePanelId(next.activePanelId)
    if (!next.panelLayout) setExpandedTileId(null)
  }, [
    expandLayoutGroupIdRef,
    groupsRef,
    panelLayoutRef,
    persistNow,
    savedLayoutRef,
    setActivePanelId,
    setExpandLayoutGroupId,
    setExpandedTileId,
    setGroups,
    setPanelLayout,
    setTiles,
    tilesRef,
  ])

  return {
    exitExpandedMode,
    enterExpandedMode,
    enterTabbedView,
    handleCanvasEscape,
    applyLivePanelLayout,
    ejectPanelTab,
  }
}
