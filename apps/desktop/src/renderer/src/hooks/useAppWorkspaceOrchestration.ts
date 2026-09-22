import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { CanvasState, GroupState, LayoutTemplate, LockedConnection, TileState, Workspace } from '../../../shared/types'
import {
  createLeaf,
  findLeafById,
  replaceLeafInPanelTree,
  type PanelLeaf,
  type PanelNode,
} from '../components/panelLayoutTree'
import { getCanonicalWorkspaceId } from '../lib/workspaceHelpers'
import { applyEmptyCanvasWorkspaceState, applySavedCanvasState } from '../lib/canvasWorkspaceLoad'
import { dedupeLockedConnections } from '../lib/canvasStateHelpers'
import { generateLayoutFromTemplate } from '../lib/layoutTemplateLaunch'
import { ensureLayoutGroup } from '../lib/layoutGroupMembership.ts'
import { awaitCanvasBeforeWorkspaceSwitch } from '../lib/orderedCanvasPersistence'
import {
  commitWorkspaceCanvasOwnership,
  LatestWorkspaceSwitchCoordinator,
  transitionToWorkspacePicker,
} from '../lib/workspaceSwitchCoordinator'

export type UseAppWorkspaceOrchestrationParams = {
  workspace: Workspace | null
  workspaces: Workspace[]
  openWorkspaceIds: string[]
  tilesRef: RefObject<TileState[]>
  groupsRef: RefObject<GroupState[]>
  panelLayoutRef: RefObject<PanelNode | null>
  activePanelIdRef: RefObject<string | null>
  expandedTileIdRef: RefObject<string | null>
  viewportRef: RefObject<{ tx: number, ty: number, zoom: number }>
  nextZIndexRef: RefObject<number>
  lockedConnectionsRef: RefObject<LockedConnection[]>
  savedLayoutRef: RefObject<PanelNode | null>
  expandedCanvasGroupIdRef: RefObject<string | null>
  expandLayoutGroupIdRef: RefObject<string | null>
  expandedCanvasPriorViewportRef: RefObject<CanvasState['viewport'] | null>
  currentWorkspaceIdRef: RefObject<string | null>
  setWorkspace: React.Dispatch<React.SetStateAction<Workspace | null>>
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>
  setOpenWorkspaceIds: React.Dispatch<React.SetStateAction<string[]>>
  setShowWorkspacePickerTab: React.Dispatch<React.SetStateAction<boolean>>
  setWorkspacePickerReturnWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>
  setTiles: React.Dispatch<React.SetStateAction<TileState[]>>
  setGroups: React.Dispatch<React.SetStateAction<GroupState[]>>
  setLockedConnections: React.Dispatch<React.SetStateAction<LockedConnection[]>>
  setViewport: React.Dispatch<React.SetStateAction<{ tx: number, ty: number, zoom: number }>>
  setNextZIndex: React.Dispatch<React.SetStateAction<number>>
  setPanelLayout: React.Dispatch<React.SetStateAction<PanelNode | null>>
  setActivePanelId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandedTileId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandedCanvasGroupId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandLayoutGroupId: React.Dispatch<React.SetStateAction<string | null>>
  restoreViewport: (viewport: CanvasState['viewport']) => void
  resetViewportState: () => void
  /** Clear undo/redo history stacks on workspace switch (H-3 fix). */
  clearHistory: () => void
  /**
   * Immediately flush any pending debounced save for the given workspace id.
   * Call before setWorkspace() so the outgoing workspace's last edits are not
   * dropped. Provided by useCanvasEngine.
   */
  flushPendingSave: (workspaceId: string) => Promise<void>
  /**
   * Record that the canvas state for the given workspace id is now loaded.
   * Provided by useCanvasEngine — unblocks the auto-save effect after switch.
   */
  markCanvasLoaded: (id: string) => void
  transferCanvasWorkspaceOwnership: (id: string | null) => void
  releaseWorkspacePersistence: (id: string) => boolean
}

export function useAppWorkspaceOrchestration(params: UseAppWorkspaceOrchestrationParams) {
  const {
    workspace,
    workspaces,
    openWorkspaceIds,
    tilesRef,
    groupsRef,
    panelLayoutRef,
    activePanelIdRef,
    expandedTileIdRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    savedLayoutRef,
    expandedCanvasGroupIdRef,
    expandLayoutGroupIdRef,
    expandedCanvasPriorViewportRef,
    currentWorkspaceIdRef,
    setWorkspace,
    setWorkspaces,
    setOpenWorkspaceIds,
    setShowWorkspacePickerTab,
    setWorkspacePickerReturnWorkspaceId,
    setTiles,
    setGroups,
    setLockedConnections,
    setViewport,
    setNextZIndex,
    setPanelLayout,
    setActivePanelId,
    setExpandedTileId,
    setExpandedCanvasGroupId,
    setExpandLayoutGroupId,
    restoreViewport,
    resetViewportState,
    clearHistory,
    flushPendingSave,
    markCanvasLoaded,
    transferCanvasWorkspaceOwnership,
    releaseWorkspacePersistence,
  } = params
  const workspaceSwitchCoordinatorRef = useRef<LatestWorkspaceSwitchCoordinator | null>(null)
  if (workspaceSwitchCoordinatorRef.current === null) {
    workspaceSwitchCoordinatorRef.current = new LatestWorkspaceSwitchCoordinator()
  }
  const workspaceSwitchCoordinator = workspaceSwitchCoordinatorRef.current

  const buildCanvasLoadAppliers = useCallback(() => ({
    setTiles: (nextTiles: TileState[]) => {
      tilesRef.current = nextTiles
      setTiles(nextTiles)
    },
    setGroups: (nextGroups: GroupState[]) => {
      groupsRef.current = nextGroups
      setGroups(nextGroups)
    },
    restoreViewport,
    setNextZIndex: (next: number) => {
      nextZIndexRef.current = next
      setNextZIndex(next)
    },
    setPanelLayout: (next: PanelNode | null) => {
      panelLayoutRef.current = next
      setPanelLayout(next)
    },
    setActivePanelId: (next: string | null) => {
      activePanelIdRef.current = next
      setActivePanelId(next)
    },
    setExpandedTileId: (next: string | null) => {
      expandedTileIdRef.current = next
      setExpandedTileId(next)
    },
    setExpandedCanvasGroupId: (next: string | null) => {
      expandedCanvasGroupIdRef.current = next
      setExpandedCanvasGroupId(next)
    },
    setExpandLayoutGroupId: (next: string | null) => {
      expandLayoutGroupIdRef.current = next
      setExpandLayoutGroupId(next)
    },
    setLockedConnections: (next: LockedConnection[]) => {
      lockedConnectionsRef.current = next
      setLockedConnections(next)
    },
    savedLayoutRef,
    expandedCanvasGroupIdRef,
    expandLayoutGroupIdRef,
    expandedCanvasPriorViewportRef,
  }), [
    activePanelIdRef,
    expandLayoutGroupIdRef,
    expandedCanvasGroupIdRef,
    expandedCanvasPriorViewportRef,
    expandedTileIdRef,
    groupsRef,
    lockedConnectionsRef,
    nextZIndexRef,
    panelLayoutRef,
    restoreViewport,
    savedLayoutRef,
    setActivePanelId,
    setExpandLayoutGroupId,
    setExpandedCanvasGroupId,
    setExpandedTileId,
    setGroups,
    setLockedConnections,
    setNextZIndex,
    setPanelLayout,
    setTiles,
    tilesRef,
  ])

  const showEmptyLayoutPage = useCallback(async (
    options?: { preserveOpenTabs?: boolean },
  ): Promise<void> => {
    const preserveOpenTabs = options?.preserveOpenTabs ?? false
    const outgoingWorkspaceId = currentWorkspaceIdRef.current
    await transitionToWorkspacePicker({
      coordinator: workspaceSwitchCoordinator,
      outgoingWorkspaceId,
      flushOutgoing: flushPendingSave,
      onFlushError: (workspaceId, error) => {
        console.error(
          `[canvas] Failed to persist workspace ${workspaceId} before opening the picker; continuing:`,
          error,
        )
      },
      commitPicker: () => {
        const emptyPanel = createLeaf([])
        commitWorkspaceCanvasOwnership(
          null,
          currentWorkspaceIdRef,
          transferCanvasWorkspaceOwnership,
          () => {
            clearHistory()
            setShowWorkspacePickerTab(true)
            setWorkspacePickerReturnWorkspaceId(
              preserveOpenTabs ? outgoingWorkspaceId : null,
            )
            setWorkspace(null)
            if (!preserveOpenTabs) setOpenWorkspaceIds([])
            tilesRef.current = []
            groupsRef.current = []
            lockedConnectionsRef.current = []
            expandedCanvasGroupIdRef.current = null
            expandLayoutGroupIdRef.current = null
            expandedCanvasPriorViewportRef.current = null
            setTiles([])
            setGroups([])
            setLockedConnections([])
            resetViewportState()
            savedLayoutRef.current = emptyPanel
            panelLayoutRef.current = emptyPanel
            activePanelIdRef.current = emptyPanel.id
            expandedTileIdRef.current = null
            setPanelLayout(emptyPanel)
            setActivePanelId(emptyPanel.id)
            setExpandedTileId(null)
            setExpandedCanvasGroupId(null)
            setExpandLayoutGroupId(null)
          },
        )
        if (outgoingWorkspaceId) {
          releaseWorkspacePersistence(outgoingWorkspaceId)
        }
      },
    })
  }, [
    activePanelIdRef,
    clearHistory,
    currentWorkspaceIdRef,
    expandLayoutGroupIdRef,
    expandedTileIdRef,
    expandedCanvasGroupIdRef,
    expandedCanvasPriorViewportRef,
    flushPendingSave,
    groupsRef,
    lockedConnectionsRef,
    panelLayoutRef,
    releaseWorkspacePersistence,
    resetViewportState,
    savedLayoutRef,
    setActivePanelId,
    setExpandLayoutGroupId,
    setExpandedTileId,
    setGroups,
    setLockedConnections,
    setOpenWorkspaceIds,
    setPanelLayout,
    setShowWorkspacePickerTab,
    setTiles,
    setWorkspace,
    setWorkspacePickerReturnWorkspaceId,
    tilesRef,
    transferCanvasWorkspaceOwnership,
    workspaceSwitchCoordinator,
  ])

  const handleSwitchWorkspace = useCallback(async (id: string) => {
    const switchToken = workspaceSwitchCoordinator.begin()
    let workspaceList = workspaces
    let refreshedWorkspaceList: Workspace[] | null = null
    let targetWorkspaceId = getCanonicalWorkspaceId(workspaceList, id) ?? id
    let ws = workspaceList.find(candidate => candidate.id === targetWorkspaceId) ?? null
    if (!ws) {
      const refreshed = await window.electron.workspace.list().catch(() => [])
      if (refreshed.length > 0) {
        refreshedWorkspaceList = refreshed
        workspaceList = refreshed
        targetWorkspaceId = getCanonicalWorkspaceId(refreshed, targetWorkspaceId) ?? targetWorkspaceId
        ws = refreshed.find(candidate => candidate.id === targetWorkspaceId) ?? null
      }
    }

    // Flush any pending debounced save for the OUTGOING workspace BEFORE
    // calling setWorkspace(). currentWorkspaceIdRef still holds the old id here
    // so the write goes to the correct canvas.json. This prevents the last
    // ≤500ms of edits from being dropped when the timer is cleared by the
    // incoming workspace's first schedulePersistWrite call.
    const outgoingId = currentWorkspaceIdRef.current
    try {
      await awaitCanvasBeforeWorkspaceSwitch(outgoingId, flushPendingSave)
    } catch (error) {
      // flushPendingSave already made its single authoritative retry. Surface
      // the second failure, then fail open so navigation cannot deadlock.
      console.error(
        `[canvas] Failed to persist workspace ${outgoingId ?? '<unknown>'} before switch; continuing:`,
        error,
      )
    }

    const saved = ws
      ? await window.electron.canvas.load(targetWorkspaceId)
      : null

    await workspaceSwitchCoordinator.commitLatest(switchToken, async isCurrent => {
      await window.electron.workspace.setActive(targetWorkspaceId)
      if (!isCurrent()) return

      const ownedWorkspaceId = ws ? targetWorkspaceId : null
      commitWorkspaceCanvasOwnership(
        ownedWorkspaceId,
        currentWorkspaceIdRef,
        transferCanvasWorkspaceOwnership,
        () => {
          if (refreshedWorkspaceList) setWorkspaces(refreshedWorkspaceList)
          setWorkspace(ws)
          setShowWorkspacePickerTab(false)
          setWorkspacePickerReturnWorkspaceId(null)
          if (!ws) return

          // Canvas refs and React state are applied synchronously inside the
          // same serialized ownership commit. The next lifecycle challenge
          // therefore cannot observe B ownership with A refs.
          if (saved) {
            clearHistory()
            applySavedCanvasState(saved, buildCanvasLoadAppliers())
          } else {
            clearHistory()
            applyEmptyCanvasWorkspaceState(buildCanvasLoadAppliers(), resetViewportState)
          }
          markCanvasLoaded(targetWorkspaceId)
        },
      )
      if (!ws) return

      if (outgoingId && outgoingId !== targetWorkspaceId) {
        releaseWorkspacePersistence(outgoingId)
      }

      const savedTiles = saved?.tiles ?? []
      void window.electron?.collab?.pruneOrphanedTileDirs?.(
        ws.path,
        savedTiles.map(tile => tile.id),
      )
    })
  }, [
    buildCanvasLoadAppliers,
    clearHistory,
    currentWorkspaceIdRef,
    flushPendingSave,
    markCanvasLoaded,
    resetViewportState,
    releaseWorkspacePersistence,
    setShowWorkspacePickerTab,
    setWorkspace,
    setWorkspacePickerReturnWorkspaceId,
    setWorkspaces,
    transferCanvasWorkspaceOwnership,
    workspaceSwitchCoordinator,
    workspaces,
  ])

  const handleDeleteWorkspace = useCallback(async (id: string) => {
    const wasActive = workspace?.id === id
    const nextOpenIds = openWorkspaceIds.filter(wsId => wsId !== id)

    if (wasActive) {
      try {
        await flushPendingSave(id)
      } catch (error) {
        console.error(
          `[canvas] Failed to persist workspace ${id} before deletion; continuing:`,
          error,
        )
      }
    }
    await window.electron.workspace.delete(id)
    releaseWorkspacePersistence(id)
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    setOpenWorkspaceIds(nextOpenIds)

    if (!wasActive) return

    const nextId = nextOpenIds.find(wsId => updated.some(ws => ws.id === wsId)) ?? updated[0]?.id ?? null
    if (nextId) {
      await handleSwitchWorkspace(nextId)
      return
    }

    await showEmptyLayoutPage()
  }, [
    flushPendingSave,
    handleSwitchWorkspace,
    openWorkspaceIds,
    releaseWorkspacePersistence,
    setOpenWorkspaceIds,
    setWorkspaces,
    showEmptyLayoutPage,
    workspace?.id,
  ])

  const handleCloseWorkspaceTab = useCallback(async (id: string) => {
    const tabIndex = openWorkspaceIds.indexOf(id)
    if (tabIndex === -1) return

    const nextOpenIds = openWorkspaceIds.filter(wsId => wsId !== id)

    if (workspace?.id !== id) {
      setOpenWorkspaceIds(nextOpenIds)
      releaseWorkspacePersistence(id)
      return
    }

    const nextId = nextOpenIds[tabIndex] ?? nextOpenIds[tabIndex - 1] ?? null
    if (nextId) {
      setOpenWorkspaceIds(nextOpenIds)
      await handleSwitchWorkspace(nextId)
      releaseWorkspacePersistence(id)
      return
    }

    // The final-tab path uses the same serialized, flushing transition as the
    // plus-tab picker. Do not clear A's refs until its debounce lane is durable.
    await showEmptyLayoutPage()
    releaseWorkspacePersistence(id)
  }, [
    handleSwitchWorkspace,
    openWorkspaceIds,
    releaseWorkspacePersistence,
    setOpenWorkspaceIds,
    showEmptyLayoutPage,
    workspace?.id,
  ])

  const handleNewWorkspace = useCallback(async (name: string) => {
    if (!name.trim()) return
    const ws = await window.electron.workspace.create(name.trim())
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    await handleSwitchWorkspace(ws.id)
  }, [handleSwitchWorkspace, setWorkspaces])

  const handleOpenFolder = useCallback(async () => {
    const folderPath = await window.electron.workspace.openFolder()
    if (!folderPath) return
    const ws = await window.electron.workspace.createFromFolder(folderPath)
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    await handleSwitchWorkspace(ws.id)
  }, [handleSwitchWorkspace, setWorkspaces])

  useEffect(() => {
    return window.electron?.window?.onNewTab?.(() => {
      const next = workspaces.find(candidate => !openWorkspaceIds.includes(candidate.id))
      if (next) {
        setOpenWorkspaceIds(prev => [...prev, next.id])
        handleSwitchWorkspace(next.id)
      }
    })
  }, [workspaces, openWorkspaceIds, handleSwitchWorkspace, setOpenWorkspaceIds])

  const handleLaunchTemplate = useCallback(async (template: LayoutTemplate) => {
    const generated = generateLayoutFromTemplate(template)
    if (!generated) return

    const {
      tiles: generatedTiles,
      groups: generatedGroups,
      panelLayout: generatedPanelLayout,
      activePanelId: generatedActivePanelId,
      connections: generatedConnections,
      nextZIndex: zIdx,
      expandLayoutGroupId: generatedExpandId,
    } = generated

    if (!workspace?.id) {
      const workspaceName = template.name.trim() || 'Workspace'
      const ws = await window.electron.workspace.create(workspaceName)
      const updatedList = await window.electron.workspace.list()
      setWorkspaces(updatedList)

      const nextState: CanvasState = {
        tiles: generatedTiles,
        groups: generatedGroups,
        viewport: { tx: 0, ty: 0, zoom: 1 },
        nextZIndex: zIdx,
        panelLayout: generatedPanelLayout,
        activePanelId: generatedActivePanelId,
        tabViewActive: true,
        expandedTileId: null,
        expandLayoutGroupId: generatedExpandId,
        lockedConnections: generatedConnections.length > 0 ? generatedConnections : undefined,
      }

      await window.electron.canvas.save(ws.id, nextState)
      await window.electron.workspace.setActive(ws.id)
      commitWorkspaceCanvasOwnership(
        ws.id,
        currentWorkspaceIdRef,
        transferCanvasWorkspaceOwnership,
        () => {
          setWorkspace(ws)
          applySavedCanvasState(nextState, buildCanvasLoadAppliers())
          markCanvasLoaded(ws.id)
          setOpenWorkspaceIds(prev => prev.includes(ws.id) ? prev : [...prev, ws.id])
        },
      )
      return
    }

    const currentLayout = panelLayoutRef.current
    const currentPanelId = activePanelIdRef.current
    const activeLeaf = currentLayout && currentPanelId
      ? findLeafById(currentLayout, currentPanelId) as PanelLeaf | null
      : null
    const canInsertIntoActiveLeaf = Boolean(currentLayout && activeLeaf && activeLeaf.tabs.length === 0)
    const canReplaceWorkspaceState = !currentLayout
      && tilesRef.current.length === 0
      && groupsRef.current.length === 0
    if (!canInsertIntoActiveLeaf && !canReplaceWorkspaceState) return

    const mergedTiles = canInsertIntoActiveLeaf
      ? [...tilesRef.current, ...generatedTiles]
      : generatedTiles
    const mergedGroups = canInsertIntoActiveLeaf ? groupsRef.current : generatedGroups
    const nextViewport = canInsertIntoActiveLeaf ? viewportRef.current : { tx: 0, ty: 0, zoom: 1 }
    const nextConnections = canInsertIntoActiveLeaf
      ? dedupeLockedConnections([...lockedConnectionsRef.current, ...generatedConnections])
      : generatedConnections
    const nextPanelLayout = canInsertIntoActiveLeaf && currentLayout && activeLeaf
      ? replaceLeafInPanelTree(currentLayout, activeLeaf.id, generatedPanelLayout)
      : generatedPanelLayout
    const ensured = ensureLayoutGroup({
      tiles: mergedTiles,
      groups: mergedGroups,
      layout: nextPanelLayout,
      reuseGroupId: canInsertIntoActiveLeaf ? expandLayoutGroupIdRef.current : generatedExpandId,
    })
    const nextTiles = ensured.tiles
    const nextGroups = ensured.groups
    const nextExpandId = ensured.groupId || generatedExpandId

    const nextState: CanvasState = {
      tiles: nextTiles,
      groups: nextGroups,
      viewport: nextViewport,
      nextZIndex: zIdx,
      panelLayout: nextPanelLayout,
      activePanelId: generatedActivePanelId,
      tabViewActive: true,
      expandedTileId: null,
      expandLayoutGroupId: nextExpandId,
      lockedConnections: nextConnections.length > 0 ? nextConnections : undefined,
    }

    tilesRef.current = nextTiles
    groupsRef.current = nextGroups
    expandLayoutGroupIdRef.current = nextExpandId
    setTiles(nextTiles)
    setGroups(nextGroups)
    setLockedConnections(nextConnections)
    setViewport(nextViewport)
    setNextZIndex(zIdx)
    savedLayoutRef.current = nextPanelLayout
    setPanelLayout(nextPanelLayout)
    setActivePanelId(generatedActivePanelId)
    setExpandedTileId(null)
    setExpandLayoutGroupId(nextExpandId)
    await window.electron.canvas.save(workspace.id, nextState).catch(() => {})
  }, [
    workspace,
    activePanelIdRef,
    buildCanvasLoadAppliers,
    currentWorkspaceIdRef,
    expandLayoutGroupIdRef,
    groupsRef,
    lockedConnectionsRef,
    panelLayoutRef,
    savedLayoutRef,
    setActivePanelId,
    setExpandLayoutGroupId,
    setExpandedTileId,
    setGroups,
    setLockedConnections,
    setNextZIndex,
    setOpenWorkspaceIds,
    setPanelLayout,
    setTiles,
    setViewport,
    setWorkspace,
    setWorkspaces,
    tilesRef,
    viewportRef,
    markCanvasLoaded,
    transferCanvasWorkspaceOwnership,
  ])

  return {
    showEmptyLayoutPage,
    handleSwitchWorkspace,
    handleDeleteWorkspace,
    handleCloseWorkspaceTab,
    handleNewWorkspace,
    handleOpenFolder,
    handleLaunchTemplate,
    applySavedCanvasState: useCallback((saved: CanvasState) => {
      clearHistory()
      applySavedCanvasState(saved, buildCanvasLoadAppliers())
    }, [buildCanvasLoadAppliers, clearHistory]),
  }
}
