import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { CanvasGroupFrames } from './components/canvas/CanvasGroupFrames'
import type { AggregatedSessionEntry } from '../../shared/session-types'
import type { TileState, GroupState, Workspace, AppSettings, TileType } from '../../shared/types'

import { withDefaultSettings } from '../../shared/types'
import type { MenuItem } from './components/ContextMenu'
import { useExtensions } from './hooks/useExtensions'
import { useLayoutTemplates } from './hooks/useLayoutTemplates'
import { useAutoHideScrollbars } from './hooks/useAutoHideScrollbars'
import { useTitleTooltips } from './hooks/useTitleTooltips'
import { useScrollFadeIndicators } from './hooks/useScrollFadeIndicators'
import { useAppShellChrome } from './hooks/useAppShellChrome'
import { useAppCanvasDerivedState } from './hooks/useAppCanvasDerivedState'
import { readMiniChatOptions } from './lib/miniChatWindow'
import { MiniChatWindow } from './components/MiniChatWindow'
import { AppSidebarRegion } from './components/AppSidebarRegion'
import { AppWorkspaceTabBar } from './components/AppWorkspaceTabBar'
import { AppOverlays } from './components/AppOverlays'
import { AppCanvasSurface } from './components/AppCanvasSurface'
import { AppCanvasTiles } from './components/AppCanvasTiles'
import { AppCanvasConnections } from './components/AppCanvasConnections'
import { AppCanvasPanelRegion } from './components/AppCanvasPanelRegion'
import { AppCanvasArrangeToolbar } from './components/AppCanvasArrangeToolbar'
import { AppCanvasWorldOverlays } from './components/AppCanvasWorldOverlays'
import { AppCanvasGroupToolbar } from './components/AppCanvasGroupToolbar'
import { AppCanvasMinimapOverlay } from './components/AppCanvasMinimapOverlay'
import { resolveFileTileType } from './lib/fileTileType'
import { useNegotiatedDiscovery } from './hooks/useNegotiatedDiscovery'
import {
  useCanvasEngine,
  useLockConnection,
  type CanvasDragState,
} from './hooks/useCanvasEngine'
import { useAppCanvasInteraction } from './hooks/useAppCanvasInteraction'
import { useTileMounting } from './hooks/useTileMounting'
import { useTileClipboard } from './hooks/useTileClipboard'
import { useCanvasGlow } from './hooks/useCanvasGlow'
import { useRenderTileBody } from './hooks/useRenderTileBody'
import { useAutoAgentProximity } from './hooks/useAutoAgentProximity'
import { useDiscoveryPulses } from './hooks/useDiscoveryPulses'
import { usePanelTileChrome } from './hooks/usePanelTileChrome'
import { useAppPanelViewMode } from './hooks/useAppPanelViewMode'
import { useAppCanvasConnectionProps, useAppCanvasPanelRegionProps } from './hooks/useAppCanvasViewProps'
import { useAppWorkspaceOrchestration } from './hooks/useAppWorkspaceOrchestration'
import { useAppSessionOrchestration } from './hooks/useAppSessionOrchestration'
import { getCanonicalWorkspaceId } from './lib/workspaceHelpers'
import {
  readCachedSettings,
  readPersistedWorkspaceTabState,
  persistWorkspaceTabState,
  writeCachedSettings,
} from './lib/appShellPersistence'
import { hrefToLocalPath, snapToCanvasGrid } from './lib/canvasStateHelpers'
import {
  registerWindowPersistenceTask,
  resolveCanvasPersistenceMode,
  startWindowPersistenceBarrier,
  supportsWindowPersistenceBarrier,
} from './lib/windowPersistenceBarrier'

import {
  extensionActionRegistry,
  type AnchorPoint,
} from './lib/discoveryRuntime'
import {
  getConnectionHandlePoint,
  getTileCenter,
} from './lib/connectionRoutes'

import { FontProvider, FontTokenProvider, MONO_DEFAULT } from './FontContext'
import { ThemeProvider } from './ThemeContext'
import { DEFAULT_THEME_ID, registerCustomTheme, unregisterCustomTheme } from './theme'
import type { PanelLeaf, PanelNode } from './components/panelLayoutTree'
import {
  findLeafById,
  findFirstLeafId,
  findLeafIdContainingTile,
  collectPanelLeaves,
} from './components/panelLayoutTree'
import { getDroppedPaths } from './utils/dnd'
import { CODESURF_OPEN_LINK_EVENT, type CodeSurfOpenLinkDetail } from './utils/links'
import {
  CODESURF_CREATE_TILE_EVENT,
  CODESURF_OPEN_CHAT_SURFACE_EVENT,
  normalizeCreateTileDetail,
  normalizeOpenChatSurfaceDetail,
  resolveChatSurfaceTargetTile,
} from './utils/appLaunchRequests'
import { getChatTileRuntimeState } from './components/chatTileRuntimeState'
import { resolveProviderModeId } from './config/providers'

function App(): JSX.Element {
  useAutoHideScrollbars()
  useTitleTooltips()
  useScrollFadeIndicators()
  const miniChatOptions = useMemo(() => readMiniChatOptions(), [])

  const [tiles, setTiles] = useState<TileState[]>([])
  const [groups, setGroups] = useState<GroupState[]>([])
  const [lockedConnections, setLockedConnections] = useState<Array<{ sourceTileId: string; targetTileId: string }>>([])
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [selectedTileIds, setSelectedTileIds] = useState<Set<string>>(new Set())
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [dragState, setDragState] = useState<CanvasDragState>({ type: null })
  const [showMCP, setShowMCP] = useState(false)
  const [showSettings, setShowSettings] = useState<string | false>(false)
  const [showExtensionsGallery, setShowExtensionsGallery] = useState(false)
  // First-run onboarding (P9): gate on a real disk load so returning users
  // (whose persisted settings already have the flag) never see a flash.
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [showMinimap] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [showPetPicker, setShowPetPicker] = useState(false)
  const { addTemplate: addLayoutTemplate } = useLayoutTemplates()
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [panelLayout, setPanelLayout] = useState<PanelNode | null>(null)
  const [chatReloadTokens, setChatReloadTokens] = useState<Record<string, number>>({})
  const [extActionsVersion, setExtActionsVersion] = useState(0)
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
  const [expandLayoutGroupId, setExpandLayoutGroupId] = useState<string | null>(null)
  const expandLayoutGroupIdRef = useRef<string | null>(null)
  // Non-layout group expanded as a fullscreen sub-canvas. Members stay free-floating.
  const [expandedCanvasGroupId, setExpandedCanvasGroupId] = useState<string | null>(null)
  const expandedCanvasGroupIdRef = useRef<string | null>(null)
  // Forward ref so early-defined effects (e.g. Esc handler) can call the
  // canvas-expand exit before its useCallback is declared further down.
  const exitCanvasExpandedRef = useRef<() => void>(() => {})
  const savedLayoutRef = useRef<PanelNode | null>(null)
  const panelLayoutRef = useRef<PanelNode | null>(null)
  const activePanelIdRef = useRef<string | null>(null)
  const expandedTileIdRef = useRef<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(() => readCachedSettings())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null)
  const [canvasArrangeMode, setCanvasArrangeMode] = useState<'grid' | 'column' | 'row' | null>(null)
  const [guides, setGuides] = useState<{ x?: number; y?: number }[]>([])
  const [autoConnectionsEnabled] = useState(false)
  const canvasPointerWorldRef = useRef<{ x: number; y: number } | null>(null)
  const setCanvasPointerWorld = useCallback((value: { x: number; y: number } | null | ((prev: { x: number; y: number } | null) => { x: number; y: number } | null)) => {
    canvasPointerWorldRef.current = typeof value === 'function' ? value(canvasPointerWorldRef.current) : value
  }, [])
  const [hoveredConnectionHandle, setHoveredConnectionHandle] = useState<{ tileId: string; side: AnchorPoint['side'] } | null>(null)
  const [showAgentSetup, setShowAgentSetup] = useState(false)
  // .skill install dialog — populated when user drops a .skill file on the
  // canvas or double-clicks one in Finder (forwarded via `skill:file-opened`
  // from the main process).
  const [skillInstallPath, setSkillInstallPath] = useState<string | null>(null)
  const { extensionTiles, extensionEntries } = useExtensions(
    workspace?.path ?? null,
    !settings.extensionsDisabled,
  )
  const extensionNameById = useMemo(
    () => new Map((extensionEntries ?? []).map(entry => [entry.id, entry.name] as const)),
    [extensionEntries],
  )
  const extensionTileByType = useMemo(
    () => new Map((extensionTiles ?? []).map(entry => [entry.type, entry] as const)),
    [extensionTiles],
  )
  const visibleSidebarExtensionTiles = useMemo(() => {
    if (settings.extensionsDisabled) return []
    const hidden = new Set(settings.hiddenFromSidebarExtIds ?? [])
    return extensionTiles.filter(entry => !hidden.has(entry.extId))
  }, [settings.extensionsDisabled, settings.hiddenFromSidebarExtIds, extensionTiles])
  const visibleSidebarExtensionEntries = useMemo(() => {
    if (settings.extensionsDisabled) return []
    const hidden = new Set(settings.hiddenFromSidebarExtIds ?? [])
    return extensionEntries.filter(entry => entry.enabled !== false && !hidden.has(entry.id))
  }, [settings.extensionsDisabled, settings.hiddenFromSidebarExtIds, extensionEntries])
  const [showWorkspacePickerTab, setShowWorkspacePickerTab] = useState(false)
  const [workspacePickerReturnWorkspaceId, setWorkspacePickerReturnWorkspaceId] = useState<string | null>(null)
  const latestSettingsSaveRef = useRef(0)

  useEffect(() => { panelLayoutRef.current = panelLayout }, [panelLayout])
  useEffect(() => { activePanelIdRef.current = activePanelId }, [activePanelId])
  useEffect(() => { expandedTileIdRef.current = expandedTileId }, [expandedTileId])
  useEffect(() => { expandedCanvasGroupIdRef.current = expandedCanvasGroupId }, [expandedCanvasGroupId])
  useEffect(() => { expandLayoutGroupIdRef.current = expandLayoutGroupId }, [expandLayoutGroupId])
  const currentWorkspaceIdRef = useRef<string | null>(workspace?.id ?? null)
  const workspaceTabsHydratedRef = useRef(false)

  const selectedWorkspaceFilePath = useMemo(() => {
    if (!workspace?.path) return null

    const tileById = new Map(tiles.map(tile => [tile.id, tile]))
    const toWorkspaceFilePath = (tileId: string | null | undefined): string | null => {
      if (!tileId) return null
      const filePath = tileById.get(tileId)?.filePath
      return filePath && filePath.startsWith(workspace.path) ? filePath : null
    }

    if (panelLayout && activePanelId) {
      const leaf = findLeafById(panelLayout, activePanelId)
      const panelPath = toWorkspaceFilePath(leaf?.activeTab)
      if (panelPath) return panelPath
    }

    const expandedPath = toWorkspaceFilePath(expandedTileId)
    if (expandedPath) return expandedPath

    const selectedPath = toWorkspaceFilePath(selectedTileId)
    if (selectedPath) return selectedPath

    for (const tileId of selectedTileIds) {
      const multiSelectedPath = toWorkspaceFilePath(tileId)
      if (multiSelectedPath) return multiSelectedPath
    }

    return null
  }, [workspace?.path, tiles, panelLayout, activePanelId, expandedTileId, selectedTileId, selectedTileIds])

  useEffect(() => {
    setSidebarSelectedPath(null)
  }, [workspace?.id])

  useEffect(() => {
    if (selectedWorkspaceFilePath) setSidebarSelectedPath(selectedWorkspaceFilePath)
  }, [selectedWorkspaceFilePath])

  const { getPanelTileLabel, getPanelTileIcon } = usePanelTileChrome({
    tiles,
    extensionNameById,
    extensionTileByType,
  })

  // Workspace pill tabs — open workspace ids within this window
  const [openWorkspaceIds, setOpenWorkspaceIds] = useState<string[]>([])
  useEffect(() => {
    if (miniChatOptions) return
    if (workspace?.id) setOpenWorkspaceIds(prev => prev.includes(workspace.id) ? prev : [...prev, workspace.id])
  }, [workspace?.id, miniChatOptions])
  useEffect(() => {
    if (miniChatOptions) return
    const canonicalCurrentWorkspaceId = getCanonicalWorkspaceId(workspaces, workspace?.id)
    if (workspace?.id && canonicalCurrentWorkspaceId && canonicalCurrentWorkspaceId !== workspace.id) return

    setOpenWorkspaceIds(prev => {
      const next = Array.from(new Set(
        prev
          .map(id => getCanonicalWorkspaceId(workspaces, id) ?? id)
          .filter(id => workspaces.some(workspaceEntry => workspaceEntry.id === id)),
      ))
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) return prev
      return next
    })
  }, [workspace?.id, workspaces, miniChatOptions])

  useEffect(() => {
    if (miniChatOptions) return
    if (!workspaceTabsHydratedRef.current) return
    const canonicalWorkspaceId = getCanonicalWorkspaceId(workspaces, workspace?.id) ?? workspace?.id ?? null
    const canonicalWorkspacePickerReturnId = getCanonicalWorkspaceId(workspaces, workspacePickerReturnWorkspaceId) ?? workspacePickerReturnWorkspaceId ?? null
    persistWorkspaceTabState({
      openWorkspaceIds,
      currentWorkspaceId: canonicalWorkspaceId ?? canonicalWorkspacePickerReturnId ?? openWorkspaceIds[0] ?? null,
    })
  }, [openWorkspaceIds, workspace?.id, workspacePickerReturnWorkspaceId, workspaces, miniChatOptions])

  const pasteTilesRef = useRef<(pos?: { x: number; y: number }, intoGroupId?: string) => void>(() => {})
  const duplicateTilesRef = useRef<(ids?: string[]) => void>(() => {})
  const copyTilesRef = useRef<(cut?: boolean) => void>(() => {})
  const groupSelectedTilesRef = useRef<() => void>(() => {})
  const groupBoundsRef = useRef<(id: string) => { x: number; y: number; w: number; h: number } | null>(() => null)
  const ungroupTilesRef = useRef<(groupId: string) => void>(() => {})
  const ungroupAllRef = useRef<(groupId: string) => void>(() => {})

  // Refs that always reflect the latest tiles/groups state (for use in keyboard handlers)
  const tilesRef = useRef<TileState[]>(tiles)
  const groupsRef = useRef<GroupState[]>(groups)
  const lockedConnectionsRef = useRef(lockedConnections)
  useEffect(() => { lockedConnectionsRef.current = lockedConnections }, [lockedConnections])
  const [suppressedConnections, setSuppressedConnections] = useState<Set<string>>(new Set())
  const suppressedConnectionsRef = useRef(suppressedConnections)
  useEffect(() => { suppressedConnectionsRef.current = suppressedConnections }, [suppressedConnections])

  // Keep tilesRef / groupsRef in sync with state
  tilesRef.current = tiles
  groupsRef.current = groups
  const selectedTileIdRef = useRef<string | null>(selectedTileId)
  selectedTileIdRef.current = selectedTileId

  // Context menus
  type CtxMenu = { x: number; y: number; items: MenuItem[] }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const closeCtx = useCallback(() => setCtxMenu(null), [])

  const canvasRef = useRef<HTMLDivElement>(null)
  const canvasPersistSuspendedRef = useRef(false)
  const canvasPersistenceMode = resolveCanvasPersistenceMode(
    window.electron?.window,
    Boolean(miniChatOptions),
  )

  const canvasEngine = useCanvasEngine({
    workspace,
    canvasRef,
    tiles,
    groups,
    panelLayout,
    activePanelId,
    expandedTileId,
    persistRefs: {
      tilesRef,
      groupsRef,
      lockedConnectionsRef,
      panelLayoutRef,
      savedLayoutRef,
      activePanelIdRef,
      expandedTileIdRef,
      expandedCanvasGroupIdRef,
      expandLayoutGroupIdRef,
      canvasPersistSuspendedRef,
    },
    setTiles,
    setGroups,
    persistenceMode: canvasPersistenceMode,
  })

  const {
    viewport,
    setViewport,
    viewportRef,
    nextZIndex,
    setNextZIndex,
    nextZIndexRef,
    expandedCanvasPriorViewportRef,
    persistCanvasStateRef,
    panLastPos,
    screenToWorld,
    worldToScreen: worldToScreenPoint,
    viewportCenter,
    saveCanvas,
    persistCanvasState,
    zoomToFitArrangedTiles,
    panToTile,
    toggleZoomOne,
    cancelPanInertia,
    findManualConnectionTarget,
    restoreViewport,
    resetViewportState,
    handleWheel,
    worldElRef,
    undoCanvas,
    redoCanvas,
    flushDeferredCanvasPersist,
    clearHistory,
    flushPendingSave,
    markCanvasLoaded,
    transferCanvasWorkspaceOwnership,
    releaseWorkspacePersistence,
  } = canvasEngine

  const panelTileIdsRef = useRef<Set<string>>(new Set())
  const { discoveryPulses, triggerDiscoveryPulse } = useDiscoveryPulses({
    enabled: autoConnectionsEnabled,
    settings,
    panelTileIdsRef,
  })
  useAutoAgentProximity({
    enabled: autoConnectionsEnabled,
    miniChatMode: Boolean(miniChatOptions),
    workspaceId: workspace?.id,
    tiles,
    dragActive: dragState.type !== null,
    settings,
    panelTileIdsRef,
    setTiles,
  })
  const spaceHeld = useRef(false)
  const canvasGlowEnabled = settings.canvasGlowEnabled
  const canvasGlowRadius = Math.max(50, Math.min(200, settings.canvasGlowRadius ?? 120))
  const {
    dotGlowSmallRef,
    dotGlowLargeRef,
    discoveryGlowRef,
    hideCanvasGlow,
    updateCanvasGlow,
  } = useCanvasGlow({
    canvasRef,
    canvasGlowEnabled,
    canvasGlowRadius,
    viewportZoom: viewport.zoom,
  })
  const snapValue = React.useCallback((value: number) => (
    settings.snapToGrid ? snapToCanvasGrid(value, settings.gridSize) : value
  ), [settings.snapToGrid, settings.gridSize])

  const {
    showEmptyLayoutPage,
    handleSwitchWorkspace,
    handleDeleteWorkspace,
    handleCloseWorkspaceTab,
    handleNewWorkspace,
    handleOpenFolder,
    handleLaunchTemplate,
  } = useAppWorkspaceOrchestration({
    workspace,
    workspaces,
    openWorkspaceIds,
    tilesRef,
    groupsRef,
    panelLayoutRef,
    activePanelIdRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    savedLayoutRef,
    expandedCanvasGroupIdRef,
    expandLayoutGroupIdRef,
    expandedCanvasPriorViewportRef,
    currentWorkspaceIdRef,
    expandedTileIdRef,
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
  })
  const handleSwitchWorkspaceRef = useRef(handleSwitchWorkspace)
  handleSwitchWorkspaceRef.current = handleSwitchWorkspace

  useEffect(() => {
    const persistenceApi = window.electron?.window
    if (!supportsWindowPersistenceBarrier(persistenceApi)) return
    const unregisterCanvas = registerWindowPersistenceTask('canvas', async request => {
      if (miniChatOptions || !request.canvasOwner) return
      const workspaceId = currentWorkspaceIdRef.current
      if (workspaceId) {
        await flushPendingSave(workspaceId, {
          // Every quitting window writes in the deterministic main-process
          // ownership order, even if its local debounce queue is already clean.
          force: request.reason === 'quit',
        })
      }
    })
    const stopBarrier = startWindowPersistenceBarrier(persistenceApi)
    return () => {
      unregisterCanvas()
      stopBarrier()
    }
  }, [currentWorkspaceIdRef, flushPendingSave, miniChatOptions])

  // ─── Load workspace + canvas state on mount ───────────────────────────────
  useEffect(() => {
    writeCachedSettings(settings)
  }, [settings])

  // Listen for .skill files opened via Finder / file-association / argv. Also
  // signal `skills:rendererReady` so main can flush any paths queued before
  // the renderer was mounted.
  //
  // Additionally install a window-level drop listener so `.skill` bundles can
  // be dropped anywhere in the app — full-screen chat / panel layout / expanded
  // tiles — not just the canvas. Only files with the `.skill` extension are
  // intercepted; all other drags fall through to their local handlers.
  useEffect(() => {
    const api = window.electron?.skills
    const unsubList: Array<() => void> = []
    if (api) {
      const unsub = api.onFileOpened(({ path }) => {
        if (path && path.toLowerCase().endsWith('.skill')) {
          setSkillInstallPath(path)
        }
      })
      void api.ready().catch(() => {})
      unsubList.push(() => { try { unsub() } catch {} })
    }

    // Detect whether a drag contains OS files. `types` is the only reliable
    // signal available during dragover — the actual file list is opaque until
    // drop fires, per the HTML5 DnD spec.
    const dragHasFiles = (dt: DataTransfer | null): boolean => {
      if (!dt) return false
      const types = dt.types
      if (!types) return false
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files' || types[i] === 'application/x-moz-file') return true
      }
      return false
    }

    const onWindowDragOver = (e: DragEvent): void => {
      // Only enable drops where the default drop target is normally rejected
      // (outside the canvas). The canvas already preventDefaults on its own,
      // so calling it again here is harmless. We gate on Files so internal
      // HTML drags (text selections, etc.) are untouched.
      if (dragHasFiles(e.dataTransfer)) {
        e.preventDefault()
      }
    }

    const onWindowDrop = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer)) return
      const paths = getDroppedPaths(e.dataTransfer)
      const skillPath = paths.find(p => p.toLowerCase().endsWith('.skill'))
      if (!skillPath) return
      // `.skill` bundles are always consumed by the install modal regardless
      // of which view is active. Stop propagation so no tile-level handler
      // interprets the path as a regular file drop.
      e.preventDefault()
      e.stopPropagation()
      setSkillInstallPath(skillPath)
    }

    window.addEventListener('dragover', onWindowDragOver)
    // Capture phase so we reach the handler before tile-level listeners that
    // might try to swallow the drop.
    window.addEventListener('drop', onWindowDrop, true)

    unsubList.push(() => {
      window.removeEventListener('dragover', onWindowDragOver)
      window.removeEventListener('drop', onWindowDrop, true)
    })

    return () => { for (const fn of unsubList) fn() }
  }, [])

  const updateAppSettings = useCallback((patch: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) => {
    setSettings(current => {
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch
      const next = withDefaultSettings({ ...current, ...resolvedPatch })
      const requestId = ++latestSettingsSaveRef.current
      void window.electron.settings?.set(next).then(saved => {
        if (!saved || requestId !== latestSettingsSaveRef.current) return
        setSettings(withDefaultSettings(saved))
      }).catch(err => {
        console.warn('[settings] Failed to persist app settings patch:', err)
      })
      return next
    })
  }, [])

  const rememberChatProviderMode = useCallback((providerId: string, modeId: string) => {
    const provider = providerId.trim()
    if (!provider) return
    const normalizedMode = resolveProviderModeId(provider, modeId)
    updateAppSettings(current => ({
      chatProviderModes: {
        ...(current.chatProviderModes ?? {}),
        [provider]: normalizedMode,
      },
    }))
  }, [updateAppSettings])

  useEffect(() => {
    async function init(): Promise<void> {
      if (!window.electron) {
        console.warn('window.electron not available — preload may not have loaded')
        return
      }
      const isFresh = await window.electron.window.isFresh()
      const [wsList, active, savedSettings] = await Promise.all([
        window.electron.workspace.list(),
        isFresh ? Promise.resolve(null) : window.electron.workspace.getActive(),
        window.electron.settings?.get()
      ])
      const persistedWorkspaceTabs = readPersistedWorkspaceTabState()
      if (savedSettings) setSettings(withDefaultSettings(savedSettings))
      setSettingsLoaded(true)
      setWorkspaces(wsList)
      const workspaceById = new Map(wsList.map(entry => [entry.id, entry]))
      const restoredWorkspaceId = getCanonicalWorkspaceId(wsList, persistedWorkspaceTabs.currentWorkspaceId)
      const activeWorkspaceId = getCanonicalWorkspaceId(wsList, active?.id ?? null)
      const fallbackWorkspaceId = getCanonicalWorkspaceId(wsList, wsList[0]?.id ?? null)
      let targetWorkspace: Workspace | null =
        (restoredWorkspaceId ? workspaceById.get(restoredWorkspaceId) : undefined)
        ?? (activeWorkspaceId ? workspaceById.get(activeWorkspaceId) : undefined)
        ?? (fallbackWorkspaceId ? workspaceById.get(fallbackWorkspaceId) : undefined)
        ?? null
      if (miniChatOptions) {
        const miniId = getCanonicalWorkspaceId(wsList, miniChatOptions.workspaceId)
        if (miniId) {
          targetWorkspace = workspaceById.get(miniId) ?? targetWorkspace
        }
      }
      const restoredOpenWorkspaceIds = persistedWorkspaceTabs.openWorkspaceIds
        .map(id => getCanonicalWorkspaceId(wsList, id))
        .filter((id): id is string => id != null && workspaceById.has(id))

      if (targetWorkspace && !restoredOpenWorkspaceIds.includes(targetWorkspace.id)) {
        restoredOpenWorkspaceIds.push(targetWorkspace.id)
      }

      setOpenWorkspaceIds(Array.from(new Set(restoredOpenWorkspaceIds)))
      workspaceTabsHydratedRef.current = true

      if (!targetWorkspace) {
        await showEmptyLayoutPage()
        return
      }
      // Initial hydration and interactive navigation share one generation
      // coordinator. A slow initial A load therefore cannot overwrite a newer
      // user-requested switch to B.
      await handleSwitchWorkspaceRef.current(targetWorkspace.id)
    }
    // init() awaits isFresh() and a Promise.all over workspace.list/getActive/
    // settings.get with no try/catch. A rejection (corrupt index, permissions,
    // or codesurfd not yet up on a browser build) unwound before
    // setSettingsLoaded(true), leaving chrome painted over an empty canvas with
    // no workspace list, no picker and no onboarding — RootErrorBoundary only
    // catches render errors, so the sole symptom was an unhandled rejection in
    // devtools. Always release the gate so the shell can render a usable state.
    void init().catch(error => {
      console.error('[App] initial bootstrap failed:', error)
      setSettingsLoaded(true)
    })

    // Check if agent setup is needed (first run or paths not confirmed)
    // Force with: CODESURF_SHOW_SETUP=1 npm run dev
    const forceSetup = import.meta.env.VITE_SHOW_SETUP === '1'
    let cancelled = false
    if (!miniChatOptions) {
      if (forceSetup) {
        setShowAgentSetup(true)
      } else {
        const needsSetup = window.electron?.agentPaths?.needsSetup
        if (needsSetup) {
          void (async () => {
            // Confirmation can land while the first IPC request is in flight.
            // Revalidate before publishing UI state so an obsolete `true`
            // response cannot reopen a modal that was already dismissed.
            if (!(await needsSetup()) || cancelled) return
            if ((await needsSetup()) && !cancelled) {
              setShowAgentSetup(true)
            }
          })().catch(() => {})
        }
      }
    }
    return () => {
      cancelled = true
    }
  }, [showEmptyLayoutPage, miniChatOptions?.workspaceId])

  // ─── Subscribe to custom theme registrations from extensions ─────────────
  useEffect(() => {
    const subscriberId = 'app:theme-bus'
    const unsubscribe = window.electron.bus?.subscribe('themes', subscriberId, (event: { channel: string; payload: unknown }) => {
      if (event?.channel !== 'themes') return
      const data = event.payload as { action?: string; theme?: unknown; themeId?: string } | null
      if (!data) return
      if (data.action === 'register' && data.theme) {
        try { registerCustomTheme(data.theme as Parameters<typeof registerCustomTheme>[0]) } catch { /* skip invalid */ }
      }
      if (data.action === 'apply' && data.theme) {
        try {
          registerCustomTheme(data.theme as Parameters<typeof registerCustomTheme>[0])
          if (data.themeId) setSettings(s => ({ ...s, themeId: data.themeId as string }))
        } catch { /* skip invalid */ }
      }
      if (data.action === 'delete') {
        const deletedThemeId = typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id : ''
        if (!deletedThemeId) return
        unregisterCustomTheme(deletedThemeId)
        setSettings(s => s.themeId === deletedThemeId ? { ...s, themeId: DEFAULT_THEME_ID } : s)
      }
    })
    return () => { unsubscribe?.() }
  }, [])

  const {
    exitExpandedMode,
    enterExpandedMode,
    enterTabbedView,
    handleCanvasEscape,
    applyLivePanelLayout,
    ejectPanelTab,
  } = useAppPanelViewMode({
    panelLayout,
    panelLayoutRef,
    expandedTileIdRef,
    expandLayoutGroupIdRef,
    expandedCanvasGroupIdRef,
    panelTileIdsRef,
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
  })

  const lockConnection = useLockConnection({
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  })

  const getInitialTileSize = useCallback((type: TileState['type']) => {
    const configured = settings.defaultTileSizes[type]
    if (configured) return configured
    if (type.startsWith('ext:')) {
      const extDefault = extensionTiles.find(ext => ext.type === type)?.defaultSize
      if (extDefault) return extDefault
      return { w: 360, h: 280 }
    }
    return { w: 600, h: 400 }
  }, [settings.defaultTileSizes, extensionTiles])

  const pinnedCanvasExtensionTiles = useMemo(() => {
    if (settings.extensionsDisabled) return []
    const pinned = new Set(settings.pinnedExtensionIds ?? [])
    if (pinned.size === 0) return []
    return extensionTiles.filter(ext => pinned.has(ext.extId) || pinned.has(ext.type))
  }, [settings.extensionsDisabled, settings.pinnedExtensionIds, extensionTiles])

  // "You are here" signal for the sidebar's session list. Looks at the current
  // focus: the fullscreen/expanded tile first, then the active panel's active
  // tab, then the selected canvas tile. Only reports the id if that tile is a
  // chat — otherwise the highlight stays off.
  const activeChatTileId = useMemo(() => {
    const candidates: (string | null)[] = []
    if (expandedTileId) candidates.push(expandedTileId)
    if (panelLayout && activePanelId) {
      const leaf = findLeafById(panelLayout, activePanelId)
      if (leaf?.activeTab) candidates.push(leaf.activeTab)
    }
    if (selectedTileId) candidates.push(selectedTileId)
    for (const id of candidates) {
      if (!id) continue
      const tile = tiles.find(t => t.id === id)
      if (tile?.type === 'chat') return tile.id
    }
    return null
  }, [expandedTileId, panelLayout, activePanelId, selectedTileId, tiles])
  const [chatTileSessionMatches, setChatTileSessionMatches] = useState<Record<string, { entryId: string | null; sessionId: string | null }>>({})
  const rememberChatTileSessionMatch = useCallback((tileId: string, session: AggregatedSessionEntry, sessionIdOverride?: string | null) => {
    const sessionId = sessionIdOverride === undefined
      ? (typeof session.sessionId === 'string' ? session.sessionId : null)
      : sessionIdOverride
    setChatTileSessionMatches(prev => {
      const current = prev[tileId]
      if (current?.entryId === session.id && current?.sessionId === sessionId) return prev
      return {
        ...prev,
        [tileId]: {
          entryId: session.id,
          sessionId,
        },
      }
    })
  }, [])
  const activeChatSessionMatch = useMemo(() => {
    if (!activeChatTileId || !workspace?.id) return { entryId: null, sessionId: null }
    const remembered = chatTileSessionMatches[activeChatTileId] ?? { entryId: null, sessionId: null }
    const runtimeState = getChatTileRuntimeState<{
      sessionId?: string | null
      linkedSessionEntryId?: string | null
    }>(workspace.id, activeChatTileId)
    const runtimeEntryId = typeof runtimeState?.linkedSessionEntryId === 'string' ? runtimeState.linkedSessionEntryId : null
    const runtimeSessionId = typeof runtimeState?.sessionId === 'string' ? runtimeState.sessionId : null
    return {
      entryId: runtimeEntryId ?? remembered.entryId,
      sessionId: runtimeSessionId ?? remembered.sessionId,
    }
  }, [activeChatTileId, chatTileSessionMatches, workspace?.id])
  const preferredBrowserOpenTargetRef = useRef<string | null>(null)

  const {
    buildTileState,
    mountTile,
    replacePreviewTile,
    pinPreviewTab,
    addTile,
    closeTile,
  } = useTileMounting({
    workspace,
    gridSize: settings.gridSize,
    gridSpacingSmall: settings.gridSpacingSmall,
    tilesRef,
    panelTileIdsRef,
    panelLayoutRef,
    expandLayoutGroupIdRef,
    activePanelIdRef,
    viewportRef,
    nextZIndexRef,
    selectedTileId,
    setTiles,
    setGroups,
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
  })

  const getNavigationLeaf = useCallback((): PanelLeaf | null => {
    const layout = panelLayoutRef.current
    if (!layout) return null
    if (activePanelIdRef.current) {
      const activeLeaf = findLeafById(layout, activePanelIdRef.current)
      if (activeLeaf) return activeLeaf
    }
    const firstLeafId = findFirstLeafId(layout)
    return firstLeafId ? findLeafById(layout, firstLeafId) : null
  }, [])

  const isPreviewTabReplaceable = useCallback((tileId: string): boolean => {
    const tile = tilesRef.current.find(candidate => candidate.id === tileId)
    if (!tile) return false
    if (tile.type === 'terminal') return false
    if (tile.type === 'chat') {
      const runtimeState = workspace?.id
        ? getChatTileRuntimeState<{ isStreaming?: boolean }>(workspace.id, tileId)
        : null
      return runtimeState?.isStreaming !== true
    }
    return true
  }, [workspace?.id])

  const findPanelFileOpenLeaf = useCallback((sourceTileId: string | undefined, fileType: TileState['type']): PanelLeaf | null => {
    const layout = panelLayoutRef.current
    if (!layout) return null

    const fallbackLeaf = getNavigationLeaf()
    const isEditorFile = fileType === 'code' || fileType === 'note'
    if (!sourceTileId || !isEditorFile) return fallbackLeaf

    const leaves = collectPanelLeaves(layout)
    const sourceLeafId = findLeafIdContainingTile(layout, sourceTileId)
    const sourceLeaf = sourceLeafId ? findLeafById(layout, sourceLeafId) : null
    const tileById = new Map(tilesRef.current.map(tile => [tile.id, tile]))
    const hasEditorRole = (leaf: PanelLeaf): boolean => leaf.tabs.some(tileId => {
      const tile = tileById.get(tileId)
      return tile?.type === 'code' || tile?.type === 'note'
    })
    const hasBlankEditor = (leaf: PanelLeaf): boolean => leaf.tabs.some(tileId => {
      const tile = tileById.get(tileId)
      return (tile?.type === 'code' || tile?.type === 'note') && !tile.filePath && isPreviewTabReplaceable(tile.id)
    })

    const activeEditorLeaf = activePanelIdRef.current
      ? leaves.find(leaf => leaf.id === activePanelIdRef.current && hasEditorRole(leaf))
      : null
    if (activeEditorLeaf && activeEditorLeaf.id !== sourceLeafId) return activeEditorLeaf

    const blankEditorLeaf = leaves.find(leaf => leaf.id !== sourceLeafId && hasBlankEditor(leaf))
      ?? (sourceLeaf && hasBlankEditor(sourceLeaf) ? sourceLeaf : null)
    if (blankEditorLeaf) return blankEditorLeaf

    const associatedEditorLeaf = leaves.find(leaf => leaf.id !== sourceLeafId && hasEditorRole(leaf))
      ?? (sourceLeaf && hasEditorRole(sourceLeaf) ? sourceLeaf : null)
    return associatedEditorLeaf ?? fallbackLeaf
  }, [getNavigationLeaf, isPreviewTabReplaceable])

  useEffect(() => {
    const handleOpenLink = (event: Event) => {
      const customEvent = event as CustomEvent<CodeSurfOpenLinkDetail>
      const href = String(customEvent.detail?.href ?? '').trim()
      if (!href) return

      const localPath = hrefToLocalPath(href)
      if (localPath) {
        void resolveFileTileType(localPath).then(type => addTile(type, localPath))
        return
      }

      const preferredBrowserTileId = preferredBrowserOpenTargetRef.current
      if (preferredBrowserTileId) {
        window.electron?.bus?.publish(
          `tile:${preferredBrowserTileId}`,
          'data',
          'app:open-link',
          { command: 'browser_navigate', url: href },
        )
        return
      }

      if (settings.linkOpenMode === 'external-browser') {
        void window.electron?.shell?.openExternal?.(href)
        return
      }

      addTile('browser', href)
    }

    window.addEventListener(CODESURF_OPEN_LINK_EVENT, handleOpenLink as EventListener)
    return () => window.removeEventListener(CODESURF_OPEN_LINK_EVENT, handleOpenLink as EventListener)
  }, [addTile, settings.linkOpenMode])

  // ─── MCP canvas tool handlers (must be after addTile) ────────────────────
  useEffect(() => {
    const el = (window as any).electron?.mcp
    if (!el?.onKanban) return
    const cleanup = el.onKanban((event: string, data: any) => {
      // mcp:kanban is broadcast to EVERY window, and the payload is copied
      // verbatim from the MCP tool args with no schema validation. Require the
      // workspace to match — an absent workspaceId used to match every window,
      // so one canvas_create_tile ran in all of them.
      if (!data?.workspaceId || data.workspaceId !== workspace?.id) return

      // Only pass a position when BOTH coordinates are real numbers: an omitted
      // y produced snapValue(NaN), which findClearPosition accepts and saveCanvas
      // serialises as "y": null — a tile that cannot be selected, dragged or
      // panned to after reload.
      const finitePosition = (Number.isFinite(data.x) && Number.isFinite(data.y))
        ? { x: Number(data.x), y: Number(data.y) }
        : undefined

      if (event === 'canvas_create_tile') {
        const requestedType = typeof data.type === 'string' && data.type.trim() ? data.type.trim() : 'note'
        const filePath = typeof data.filePath === 'string' ? data.filePath : undefined
        addTile(requestedType as TileState['type'], filePath, finitePosition)
      }
      if (event === 'canvas_open_file') {
        // extToType does filePath.split('.') — a non-string path threw inside an
        // uncaught promise while the agent was told the file opened.
        if (typeof data.path === 'string' && data.path.trim()) {
          void resolveFileTileType(data.path)
            .then(type => addTile(type, data.path))
            .catch(error => console.error('[App] canvas_open_file failed:', error))
        }
      }
      if (event === 'canvas_pan_to') {
        // Centre world-point (data.x, data.y) on screen.
        // tx = screenCenterX - worldX * zoom;  ty = screenCenterY - worldY * zoom
        const rect = canvasRef.current?.getBoundingClientRect()
        const cx = rect ? rect.width / 2 : 600
        const cy = rect ? rect.height / 2 : 400
        // `??` let a non-numeric x through and produced translate(NaNpx, NaNpx),
        // blanking the canvas. Clamp to finite numbers.
        const panX = Number.isFinite(data.x) ? Number(data.x) : 0
        const panY = Number.isFinite(data.y) ? Number(data.y) : 0
        setViewport(prev => ({
          ...prev,
          tx: cx - panX * prev.zoom,
          ty: cy - panY * prev.zoom,
        }))
      }
      if (event === 'canvas_list_tiles') {
        const tileList = tiles.map(t => ({ id: t.id, type: t.type, filePath: t.filePath, x: t.x, y: t.y }))
        void (async () => {
          const port = await (window as any).electron?.mcp?.getPort?.()
          if (!port) return
          const { postMcpEndpoint } = await import('./utils/mcpHttp')
          await postMcpEndpoint(port, '/push', {
            workspace_id: workspace?.id,
            card_id: 'global',
            event: 'canvas_tiles_response',
            data: { tiles: tileList },
          }).catch(() => {})
        })()
      }
    })
    return cleanup
  }, [tiles, addTile, workspace?.id])

  const {
    clipboardRef,
    pasteTargetGroupIdRef,
    copyTiles,
    pasteTiles,
    duplicateTiles,
  } = useTileClipboard({
    tiles,
    groups,
    selectedTileId,
    selectedTileIds,
    viewport,
    nextZIndex,
    setTiles,
    setGroups,
    setNextZIndex,
    setSelectedTileId,
    setSelectedTileIds,
    saveCanvas,
    viewportCenter,
    snapValue,
    groupBoundsRef,
  })

  const bringToFront = useCallback((id: string) => {
    const nz = nextZIndex
    setTiles(prev => {
      const tile = prev.find(t => t.id === id)
      if (!tile) return prev
      // Already at the top — skip the state update and the disk write it triggers
      const maxZ = prev.reduce((m, t) => Math.max(m, t.zIndex ?? 0), 0)
      if ((tile.zIndex ?? 0) >= maxZ && maxZ > 0) return prev
      pasteTargetGroupIdRef.current = tile.groupId
      return prev.map(t => t.id === id ? { ...t, zIndex: nz } : t)
    })
    setNextZIndex(n => n + 1)
    setSelectedTileId(id)
  }, [nextZIndex, pasteTargetGroupIdRef])

  useEffect(() => {
    const handleCreateTileRequest = (event: Event) => {
      const detail = normalizeCreateTileDetail((event as CustomEvent).detail)
      if (!detail) return
      const x = typeof detail.x === 'number' ? detail.x : undefined
      const y = typeof detail.y === 'number' ? detail.y : undefined
      const tileId = addTile(
        detail.type,
        detail.filePath,
        x !== undefined && y !== undefined ? { x, y } : undefined,
      )
      if (detail.focus !== false) bringToFront(tileId)
    }

    window.addEventListener(CODESURF_CREATE_TILE_EVENT, handleCreateTileRequest as EventListener)
    return () => window.removeEventListener(CODESURF_CREATE_TILE_EVENT, handleCreateTileRequest as EventListener)
  }, [addTile, bringToFront])

  useEffect(() => {
    const dispatchTargetedSurfaceOpen = (targetTileId: string, request: { extId: string; surfaceId: string; sourceTileId?: string; initialContext?: Record<string, unknown> }) => {
      const fire = () => {
        window.dispatchEvent(new CustomEvent(CODESURF_OPEN_CHAT_SURFACE_EVENT, {
          detail: { ...request, targetTileId },
        }))
      }
      requestAnimationFrame(() => requestAnimationFrame(fire))
    }

    const handleOpenChatSurfaceRequest = (event: Event) => {
      const detail = normalizeOpenChatSurfaceDetail((event as CustomEvent).detail)
      if (!detail || detail.targetTileId) return

      const target = resolveChatSurfaceTargetTile({
        tiles,
        targetTileId: detail.preferredTileId,
        activeChatTileId,
      })
      const targetTileId = target.shouldCreate || !target.tileId
        ? addTile('chat')
        : target.tileId

      bringToFront(targetTileId)
      if (expandedTileIdRef.current && target.reason === 'create') {
        setExpandedTileId(targetTileId)
      }
      dispatchTargetedSurfaceOpen(targetTileId, {
        extId: detail.extId,
        surfaceId: detail.surfaceId,
        ...(detail.sourceTileId ? { sourceTileId: detail.sourceTileId } : {}),
        ...(detail.initialContext ? { initialContext: detail.initialContext } : {}),
      })
    }

    window.addEventListener(CODESURF_OPEN_CHAT_SURFACE_EVENT, handleOpenChatSurfaceRequest as EventListener)
    return () => window.removeEventListener(CODESURF_OPEN_CHAT_SURFACE_EVENT, handleOpenChatSurfaceRequest as EventListener)
  }, [activeChatTileId, addTile, bringToFront, tiles])

  const {
    handleOpenFile,
    openSessionInChat,
    openSessionInApp,
    openDaemonTask,
  } = useAppSessionOrchestration({
    workspace,
    workspaces,
    settings,
    chatTileSessionMatches,
    rememberChatTileSessionMatch,
    tilesRef,
    panelLayoutRef,
    activePanelIdRef,
    expandedTileIdRef,
    setSidebarSelectedPath,
    setPanelLayout,
    setActivePanelId,
    setExpandedTileId,
    setWorkspaces,
    setChatReloadTokens,
    handleSwitchWorkspace,
    addTile,
    buildTileState,
    mountTile,
    replacePreviewTile,
    pinPreviewTab,
    bringToFront,
    lockConnection,
    getNavigationLeaf,
    isPreviewTabReplaceable,
    findPanelFileOpenLeaf,
  })

  const handleImageReplaceSource = useCallback((tileId: string, filePath: string) => {
    const updatedTiles = tilesRef.current.map(tile => (
      tile.id === tileId ? { ...tile, filePath } : tile
    ))
    tilesRef.current = updatedTiles
    setTiles(updatedTiles)
    saveCanvas(updatedTiles, viewportRef.current, nextZIndexRef.current)
  }, [saveCanvas])

  const importFileToWorkspace = useCallback(async (sourcePath: string, tileId?: string) => {
    if (!workspace?.path) return null
    const { path: importedPath } = await window.electron.fs.copyIntoDir(sourcePath, workspace.path)

    if (tileId) {
      setTiles(prev => {
        const updated = prev.map(tile => tile.id === tileId ? { ...tile, filePath: importedPath } : tile)
        saveCanvas(updated, viewport, nextZIndex)
        return updated
      })
    }

    setSidebarSelectedPath(importedPath)
    return importedPath
  }, [workspace?.path, viewport, nextZIndex, saveCanvas])

  // Rebuild merged MCP config whenever workspace changes
  useEffect(() => {
    if (workspace) {
      window.electron.mcp?.getMergedConfig?.(workspace.id)
    }
  }, [workspace?.id])

  const {
    handleCanvasMouseDown,
    handleConnectionMouseDown,
    handleResizeMouseDown,
    handleCanvasDoubleClick,
    handleTileMouseDown,
    showConnectionHandleForSide,
    scheduleConnectionHandleHide,
    handleCanvasContextMenu,
    handleTileContextMenu,
    groupSelectedTiles,
    ungroupTiles,
    ungroupAll,
    groupBounds,
    collectGroupTileIds,
    convertGroupToLayout,
    revertLayoutGroup,
    expandLayoutGroup,
    enterCanvasExpanded,
    exitCanvasExpanded,
    isConnectionLocked,
    toggleConnectionLock,
    deleteConnection,
  } = useAppCanvasInteraction({
    engine: {
      canvasRef,
      canvasEngine,
      viewport,
      setViewport,
      viewportRef,
      nextZIndex,
      nextZIndexRef,
      panLastPos,
      cancelPanInertia,
      screenToWorld,
      spaceHeld,
      snapValue,
      saveCanvas,
      persistCanvasState,
      undoCanvas,
      redoCanvas,
    },
    state: {
      tiles,
      groups,
      setTiles,
      setGroups,
      tilesRef,
      groupsRef,
      selectedTileId,
      selectedTileIds,
      setSelectedTileId,
      setSelectedTileIds,
      dragState,
      setDragState,
      setGuides,
      setCanvasPointerWorld,
      setHoveredConnectionHandle,
      setCtxMenu,
      setCommandPaletteOpen,
    },
    panel: {
      panelLayout,
      panelTileIdsRef,
      setPanelLayout,
      setActivePanelId,
      setExpandedTileId,
      setExpandLayoutGroupId,
      expandLayoutGroupIdRef,
      setExpandedCanvasGroupId,
      expandedCanvasGroupIdRef,
      expandedCanvasPriorViewportRef,
      exitCanvasExpandedRef,
    },
    connections: {
      lockedConnections,
      lockedConnectionsRef,
      setLockedConnections,
      setSuppressedConnections,
      suppressedConnectionsRef,
      lockConnection,
      triggerDiscoveryPulse,
      findManualConnectionTarget,
      getTileCenter,
      getConnectionHandlePoint: (tile, side) => getConnectionHandlePoint(tile, side),
    },
    tileActions: {
      clipboardRef,
      pasteTiles,
      copyTiles,
      duplicateTiles,
      closeTile,
      addTile,
      bringToFront,
      pinnedCanvasExtensionTiles,
      workspacePath: workspace?.path,
      importFileToWorkspace: (filePath, tileId) => importFileToWorkspace(filePath, tileId),
      handleCanvasEscape,
    },
    actionRefs: {
      pasteTilesRef,
      duplicateTilesRef,
      copyTilesRef,
      groupSelectedTilesRef,
      groupBoundsRef,
      ungroupTilesRef,
      ungroupAllRef,
    },
  })

  useEffect(() => {
    const suspendDuringDrag = dragState.type === 'tile'
      || dragState.type === 'resize'
      || dragState.type === 'group'
      || dragState.type === 'group-resize'
    canvasPersistSuspendedRef.current = suspendDuringDrag
    if (!suspendDuringDrag) flushDeferredCanvasPersist()
  }, [dragState.type, flushDeferredCanvasPersist])

  // ─── Open a layout preset contributed by a plugin (point 10) ──
  // A plugin's contributes.layoutPresets[].layout (a LayoutTemplateNode) is applied
  // through the existing template-launch path — so "AI Chat" (sessions | chat | git)
  // and any other reusable arrangement become one-click, registerable layouts.
  useEffect(() => {
    const onPreset = (e: Event) => {
      const preset = (e as CustomEvent).detail as
        | { id: string; title?: string; layout: import('../../shared/types').LayoutTemplateNode }
        | undefined
      if (!preset?.layout) return
      void handleLaunchTemplate({ id: preset.id, name: preset.title ?? preset.id, created_at: '', tree: preset.layout })
    }
    window.addEventListener('codesurf:open-layout-preset', onPreset as EventListener)
    return () => window.removeEventListener('codesurf:open-layout-preset', onPreset as EventListener)
  }, [handleLaunchTemplate])

  // ─── Create a tile by type (built-in views surfaced via the command palette) ──
  useEffect(() => {
    const onNewTile = (e: Event) => {
      const detail = (e as CustomEvent).detail as { type?: string } | undefined
      if (detail?.type) addTile(detail.type as TileState['type'])
    }
    window.addEventListener('codesurf:new-tile', onNewTile as EventListener)
    return () => window.removeEventListener('codesurf:new-tile', onNewTile as EventListener)
  }, [addTile])

  // ─── A plugin footer chip was clicked → open that plugin's tile (point 3 loop) ──
  // Reuses the exact tile-type form the canvas context menu uses, so the open path
  // is identical to the proven one.
  useEffect(() => {
    const onFooterActivate = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { extId?: string } | undefined
      if (!detail?.extId) return
      try {
        const tiles = await window.electron.extensions?.listTiles?.()
        const tile = tiles?.find(t => t.extId === detail.extId)
        if (tile?.type) addTile(tile.type as TileState['type'])
      } catch { /* noop */ }
    }
    window.addEventListener('codesurf:footer-activate', onFooterActivate as EventListener)
    return () => window.removeEventListener('codesurf:footer-activate', onFooterActivate as EventListener)
  }, [addTile])

  // ─── Save the current panel arrangement as a reusable Layout preset (point 10) ──
  // Captures the live panel layout (PanelNode) into a LayoutTemplate; it then appears
  // in the palette under "Layout:" via the saved-layouts integration. PanelNode sizes
  // share the template's percentage scale (handleLaunchTemplate copies them 1:1), so
  // no conversion is needed beyond mapping tabs → tile-type slots.
  useEffect(() => {
    const onSave = () => {
      const layout = panelLayoutRef.current
      if (!layout) { window.alert('Snap views into a panel layout first, then save it.'); return }
      const toNode = (node: PanelNode): import('../../shared/types').LayoutTemplateNode => {
        if (node.type === 'leaf') {
          const slots = node.tabs.map(id => {
            const t = tilesRef.current.find(x => x.id === id)
            return { tileType: (t?.type ?? 'note') as TileType }
          })
          return { type: 'leaf', slots: slots.length ? slots : [{ tileType: 'note' as TileType }] }
        }
        return { type: 'split', direction: node.direction, children: node.children.map(toNode), sizes: node.sizes }
      }
      const name = window.prompt('Name this layout', 'My Layout')
      if (!name) return
      void addLayoutTemplate({ id: `saved-${Date.now()}`, name, created_at: new Date().toISOString(), tree: toNode(layout) })
    }
    window.addEventListener('codesurf:save-layout', onSave as EventListener)
    return () => window.removeEventListener('codesurf:save-layout', onSave as EventListener)
  }, [addLayoutTemplate])

  // Pet picker + toggle events from the command palette
  useEffect(() => {
    const onOpenPicker = () => setShowPetPicker(true)
    const onTogglePet = () => {
      updateAppSettings((current) => ({
        pet: { ...current.pet, enabled: !current.pet.enabled },
      }))
    }
    window.addEventListener('codesurf:open-pet-picker', onOpenPicker)
    window.addEventListener('codesurf:toggle-pet', onTogglePet)
    return () => {
      window.removeEventListener('codesurf:open-pet-picker', onOpenPicker)
      window.removeEventListener('codesurf:toggle-pet', onTogglePet)
    }
  }, [updateAppSettings])

  // ─── Arrange handler ──────────────────────────────────────────────────────
  const handleArrange = useCallback((updated: TileState[]) => {
    const getArrangeWidth = (tile: TileState) => tile.width + ((tile.type === 'terminal' || tile.type === 'chat') ? 272 : 0)

    // Merge positions + sizes back — preserve zIndex / other fields from current state
    setTiles(prev => {
      const updateIndex: Record<string, { x: number; y: number; width?: number; height?: number }> = {}
      for (const t of updated) updateIndex[t.id] = { x: t.x, y: t.y, width: t.width, height: t.height }
      const merged = prev.map(t => {
        const upd = updateIndex[t.id]
        if (!upd) return t
        return {
          ...t,
          x: upd.x,
          y: upd.y,
          ...(upd.width != null ? { width: upd.width } : {}),
          ...(upd.height != null ? { height: upd.height } : {}),
        }
      })
      saveCanvas(merged, viewport, nextZIndex)
      const sidebarOffset = sidebarCollapsed ? 0 : sidebarWidth + 8
      zoomToFitArrangedTiles(merged, getArrangeWidth, sidebarOffset)

      return merged
    })
  }, [viewport, nextZIndex, saveCanvas, sidebarCollapsed, sidebarWidth, zoomToFitArrangedTiles])

  const {
    panelTileIds,
    tileByIdMap,
    expandedCanvasMembership,
  } = useAppCanvasDerivedState({
    panelLayout,
    groups,
    tiles,
    expandedCanvasGroupId,
    panelTileIdsRef,
  })

  const {
    discoveryFocusTileId,
    discoveryPreview,
    negotiatedDiscoveryState,
    lockedConnectionKeys,
    manualConnectionRenderRoutes,
    ambientDiscoveryRenderRoutes,
  } = useNegotiatedDiscovery({
    autoConnectionsEnabled,
    tiles,
    groups,
    panelLayout,
    panelTileIds,
    settings,
    lockedConnections,
    suppressedConnections,
    extActionsVersion,
    dragState,
    selectedTileId,
    viewportZoom: viewport.zoom,
    workspaceId: workspace?.id,
    workspacePath: workspace?.path,
    activeChatTileId,
    tileByIdMap,
    preferredBrowserOpenTargetRef,
  })

  const terminalFontFamily = settings.terminalFontFamily || settings.fonts?.mono?.family || MONO_DEFAULT
  const terminalFontSize = settings.terminalFontSize || settings.fonts?.mono?.size || 13

  const handleFocusKanbanLinkedTile = useCallback((linkedId: string) => {
    const target = tiles.find(t => t.id === linkedId)
    if (!target) return
    bringToFront(linkedId)
    panToTile(target)
  }, [tiles, bringToFront, panToTile])

  const handleExtensionActionsChanged = useCallback((tileId: string, actions: import('./components/ExtensionTile').ExtensionAction[]) => {
    console.log('[App] Extension actions registered:', tileId, actions.map(a => a.name))
    extensionActionRegistry.set(tileId, actions)
    setExtActionsVersion(v => v + 1)
  }, [])

  const getExtensionActions = useCallback((tileId: string) => extensionActionRegistry.get(tileId), [])

  const renderTileBody = useRenderTileBody({
    workspace,
    settings,
    terminalFontFamily,
    terminalFontSize,
    viewportZoom: viewport.zoom,
    tileByIdMap,
    chatReloadTokens,
    byTileConnections: negotiatedDiscoveryState.byTileConnections,
    connectedTileIds: negotiatedDiscoveryState.connectedTileIds,
    sidebarSelectedPath,
    onImageReplaceSource: handleImageReplaceSource,
    onFocusLinkedTile: handleFocusKanbanLinkedTile,
    onChatModePreferenceChange: rememberChatProviderMode,
    onOpenFile: handleOpenFile,
    onOpenWorkspace: handleOpenFolder,
    onAddTile: addTile,
    onExtensionActionsChanged: handleExtensionActionsChanged,
    getExtensionActions,
  })

  const isDraggingCanvas = dragState.type === 'pan'

  const {
    appFonts,
    fontTokens,
    theme,
    systemPrefersDark,
    sidebarFooterBottom,
    sidebarFooterLeft,
    sidebarFooterHeight,
    mainPanelBottomInset,
    mainPanelTop,
    mainStatusBarLeft,
    collapsedSidebarPillSize,
    sidebarToggleLeft,
    sidebarToggleTop,
    workspaceTabsMinimumLeft,
    mainPanelLeft,
    discoveryHighlightZIndex,
    discoveryGlowZIndex,
    discoveryPillZIndex,
    openWorkspaceTabs,
    hasWorkspaceTabs,
    workspaceTitleFallback,
    showTopWorkspacePickerTab,
    mainPanelCornerRadii,
    mainPanelBorderRadius,
    mainPanelBackground,
    mainPanelInsetEdgeShadow,
    mainPanelShadow,
    selectedTabDropShadow,
    workspaceTabLabelSize,
    workspaceTabBackground,
    workspaceTabInactiveBackground,
    workspaceTabInactiveHoverBackground,
    workspaceTabCloseHoverBackground,
    workspaceTabMaxWidth,
    workspaceTabActiveHeight,
    workspaceTabInactiveHeight,
    workspaceTabTextOffset,
    workspaceTabInactiveTextOffset,
    workspaceTabActiveBottomGap,
    workspaceTabInactiveBottomGap,
    dsc,
  } = useAppShellChrome({
    settings,
    sidebarCollapsed,
    sidebarWidth,
    panelLayout,
    openWorkspaceIds,
    workspaces,
    workspace,
    showWorkspacePickerTab,
  })

  const appCanvasConnectionProps = useAppCanvasConnectionProps({
    panelLayout,
    manualConnectionRenderRoutes,
    ambientDiscoveryRenderRoutes,
    discoveryPreview,
    discoveryFocusTileId,
    lockedConnectionKeys,
    discoveryPulses,
    dragState,
    viewportZoom: viewport.zoom,
    gridSize: settings.gridSize,
    gridSpacingSmall: settings.gridSpacingSmall,
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
  })

  const appCanvasPanelRegionProps = useAppCanvasPanelRegionProps({
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
  })

  useEffect(() => {
    if (!canvasGlowEnabled) hideCanvasGlow()
    return () => hideCanvasGlow()
  }, [canvasGlowEnabled, hideCanvasGlow])

  const miniChatTile = miniChatOptions
    ? tiles.find(tile => tile.id === miniChatOptions.tileId && tile.type === 'chat')
    : null
  const miniChatPeers = miniChatTile
    ? (negotiatedDiscoveryState.byTileConnections.get(miniChatTile.id) ?? []).map(peer => {
      const extActions = extensionActionRegistry.get(peer.peerId)
      const peerTile = tileByIdMap.get(peer.peerId)
      return {
        ...peer,
        actions: extActions,
        filePath: peerTile?.filePath,
        label: peerTile?.label,
      }
    })
    : []

  if (miniChatOptions) {
    return (
      <MiniChatWindow
        miniChatOptions={miniChatOptions}
        theme={theme}
        appFonts={appFonts}
        fontTokens={fontTokens}
        workspace={workspace}
        miniChatTile={miniChatTile}
        miniChatPeers={miniChatPeers}
        settings={settings}
        chatReloadToken={miniChatTile ? (chatReloadTokens[miniChatTile.id] ?? 0) : 0}
        isConnected={miniChatTile ? negotiatedDiscoveryState.connectedTileIds.has(miniChatTile.id) : false}
        isAutoConnected={Boolean(miniChatTile?.autoAgentMode && miniChatTile && negotiatedDiscoveryState.connectedTileIds.has(miniChatTile.id))}
        onChatModePreferenceChange={rememberChatProviderMode}
        onOpenWorkspace={handleOpenFolder}
      />
    )
  }

  return (
    <ThemeProvider value={theme}>
    <FontTokenProvider value={fontTokens}>
    <FontProvider value={appFonts}>
    <div className="w-full h-full" style={{ position: 'relative', color: theme.text.primary, fontFamily: appFonts.primary, fontSize: appFonts.size, background: theme.surface.app }}>
      <AppSidebarRegion
        theme={theme}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        mainPanelBottomInset={mainPanelBottomInset}
        sidebarFooterHeight={sidebarFooterHeight}
        mainPanelLeft={mainPanelLeft}
        mainPanelTop={mainPanelTop}
        sidebarFooterLeft={sidebarFooterLeft}
        sidebarFooterBottom={sidebarFooterBottom}
        mainStatusBarLeft={mainStatusBarLeft}
        workspace={workspace}
        workspaces={workspaces}
        tiles={tiles}
        activeChatTileId={activeChatTileId}
        activeChatSessionMatch={activeChatSessionMatch}
        settings={settings}
        visibleSidebarExtensionTiles={visibleSidebarExtensionTiles}
        visibleSidebarExtensionEntries={visibleSidebarExtensionEntries}
        viewport={viewport}
        nextZIndex={nextZIndex}
        expandedTileIdRef={expandedTileIdRef}
        onSwitchWorkspace={handleSwitchWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        onNewWorkspace={handleNewWorkspace}
        onOpenFolder={handleOpenFolder}
        onOpenFile={handleOpenFile}
        bringToFront={bringToFront}
        setTiles={setTiles}
        saveCanvas={saveCanvas}
        closeTile={closeTile}
        addTile={addTile}
        setShowSettings={setShowSettings}
        openSessionInChat={openSessionInChat}
        openSessionInApp={openSessionInApp}
        updateAppSettings={updateAppSettings}
        setSidebarWidth={setSidebarWidth}
        setSidebarResizing={setSidebarResizing}
        setSidebarCollapsed={setSidebarCollapsed}
        setExpandedTileId={setExpandedTileId}
        setShowExtensionsGallery={setShowExtensionsGallery}
        openDaemonTask={openDaemonTask}
      />
      {/* Main area — toolbar overlays top, canvas fills entire window */}
      <div className="absolute inset-0 flex flex-col" style={{ position: 'absolute' }}>
        <AppWorkspaceTabBar
          theme={theme}
          sidebarCollapsed={sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          sidebarResizing={sidebarResizing}
          setSidebarCollapsed={setSidebarCollapsed}
          workspaceTabsMinimumLeft={workspaceTabsMinimumLeft}
          collapsedSidebarPillSize={collapsedSidebarPillSize}
          sidebarToggleLeft={sidebarToggleLeft}
          sidebarToggleTop={sidebarToggleTop}
          openWorkspaceTabs={openWorkspaceTabs}
          hasWorkspaceTabs={hasWorkspaceTabs}
          workspace={workspace}
          workspaceTitleFallback={workspaceTitleFallback}
          showTopWorkspacePickerTab={showTopWorkspacePickerTab}
          workspaceTabMaxWidth={workspaceTabMaxWidth}
          workspaceTabActiveHeight={workspaceTabActiveHeight}
          workspaceTabInactiveHeight={workspaceTabInactiveHeight}
          workspaceTabActiveBottomGap={workspaceTabActiveBottomGap}
          workspaceTabInactiveBottomGap={workspaceTabInactiveBottomGap}
          workspaceTabBackground={workspaceTabBackground}
          workspaceTabInactiveBackground={workspaceTabInactiveBackground}
          workspaceTabInactiveHoverBackground={workspaceTabInactiveHoverBackground}
          workspaceTabCloseHoverBackground={workspaceTabCloseHoverBackground}
          workspaceTabLabelSize={workspaceTabLabelSize}
          workspaceTabTextOffset={workspaceTabTextOffset}
          workspaceTabInactiveTextOffset={workspaceTabInactiveTextOffset}
          selectedTabDropShadow={selectedTabDropShadow}
          onSwitchWorkspace={handleSwitchWorkspace}
          onCloseWorkspaceTab={handleCloseWorkspaceTab}
          onNewWorkspaceTab={() => {
            void showEmptyLayoutPage({ preserveOpenTabs: true })
          }}
          onCloseWorkspacePickerTab={(fallbackWorkspaceId) => {
            setShowWorkspacePickerTab(false)
            if (fallbackWorkspaceId) void handleSwitchWorkspace(fallbackWorkspaceId)
          }}
          workspacePickerReturnWorkspaceId={workspacePickerReturnWorkspaceId}
        />
        <AppCanvasSurface
          canvasRef={canvasRef}
          mainPanelTop={mainPanelTop}
          mainPanelLeft={mainPanelLeft}
          mainPanelBottomInset={mainPanelBottomInset}
          mainPanelBackground={mainPanelBackground}
          mainPanelBorderRadius={mainPanelBorderRadius}
          mainPanelShadow={mainPanelShadow}
          mainPanelInsetEdgeShadow={mainPanelInsetEdgeShadow}
          isDraggingCanvas={isDraggingCanvas}
          spaceHeldRef={spaceHeld}
          onMouseDown={handleCanvasMouseDown}
          onDoubleClick={handleCanvasDoubleClick}
          onContextMenu={handleCanvasContextMenu}
          onWheel={handleWheel}
          updateCanvasGlow={updateCanvasGlow}
          hideCanvasGlow={hideCanvasGlow}
          setCanvasPointerWorld={setCanvasPointerWorld}
          screenToWorld={screenToWorld}
          tiles={tiles}
          bringToFront={bringToFront}
          panToTile={panToTile}
          addTile={addTile}
          setSkillInstallPath={setSkillInstallPath}
          panelLayout={panelLayout}
          expandedCanvasGroupId={expandedCanvasGroupId}
          groups={groups}
          exitCanvasExpanded={exitCanvasExpanded}
          theme={theme}
          appFonts={appFonts}
          settings={settings}
          viewport={viewport}
          canvasGlowEnabled={canvasGlowEnabled}
          dotGlowSmallRef={dotGlowSmallRef}
          dotGlowLargeRef={dotGlowLargeRef}
          surfaceOverlays={(
            <>
              <AppCanvasPanelRegion {...appCanvasPanelRegionProps} />
              <AppCanvasMinimapOverlay
                enabled={showMinimap}
                tiles={tiles}
                viewport={viewport}
                canvasWidth={canvasRef.current?.clientWidth ?? 1200}
                canvasHeight={canvasRef.current?.clientHeight ?? 800}
                onPan={(tx, ty) => setViewport(prev => ({ ...prev, tx, ty }))}
              />
            </>
          )}
        >
          {/* World container — worldElRef lets pan/zoom gestures write the
              transform imperatively between throttled state commits. */}
          <div
            ref={worldElRef}
            className="absolute"
            style={{
              transform: `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.zoom})`,
              transformOrigin: '0 0'
            }}
          >
            <CanvasGroupFrames
              groups={groups}
              tiles={tiles}
              viewport={viewport}
              dragState={dragState}
              setDragState={setDragState}
              expandedCanvasGroupId={expandedCanvasGroupId}
              expandedCanvasMembership={expandedCanvasMembership}
              theme={theme}
              appFonts={appFonts}
              nextZIndex={nextZIndex}
              setNextZIndex={setNextZIndex}
              clipboardLength={clipboardRef.current.length}
              groupBounds={groupBounds}
              collectGroupTileIds={collectGroupTileIds}
              convertGroupToLayout={convertGroupToLayout}
              revertLayoutGroup={revertLayoutGroup}
              expandLayoutGroup={expandLayoutGroup}
              enterCanvasExpanded={enterCanvasExpanded}
              ungroupTiles={ungroupTiles}
              ungroupAll={ungroupAll}
              copyTiles={copyTiles}
              pasteTiles={pasteTiles}
              setGroups={setGroups}
              setTiles={setTiles}
              selectedTileId={selectedTileId}
              selectedTileIds={selectedTileIds}
              setSelectedTileId={setSelectedTileId}
              setSelectedTileIds={setSelectedTileIds}
              saveCanvas={saveCanvas}
              persistCanvasState={persistCanvasState}
              tilesRef={tilesRef}
              savedLayoutRef={savedLayoutRef}
              viewportRef={viewportRef}
              nextZIndexRef={nextZIndexRef}
              getPanelTileLabel={getPanelTileLabel}
              getPanelTileIcon={getPanelTileIcon}
              getInitialTileSize={getInitialTileSize}
              renderTileBody={renderTileBody}
              screenToWorld={screenToWorld}
              snapValue={snapValue}
            />

            <AppCanvasWorldOverlays dragState={dragState} guides={guides} />

            <AppCanvasConnections layer="pills" {...appCanvasConnectionProps} />

            <AppCanvasTiles
              tiles={tiles}
              panelTileIds={panelTileIds}
              expandedCanvasMembership={expandedCanvasMembership}
              dragState={dragState}
              viewport={viewport}
              canvasRef={canvasRef}
              canvasPointerWorld={null}
              theme={theme}
              dsc={dsc}
              workspaceId={workspace?.id}
              workspaceDir={workspace?.path}
              selectedTileId={selectedTileId}
              selectedTileIds={selectedTileIds}
              negotiatedDiscoveryState={negotiatedDiscoveryState}
              onCloseTile={closeTile}
              onBringToFront={bringToFront}
              onTitlebarMouseDown={handleTileMouseDown}
              onResizeMouseDown={handleResizeMouseDown}
              onContextMenu={handleTileContextMenu}
              onEnterExpandedMode={enterExpandedMode}
              onExitExpandedMode={exitExpandedMode}
              onConnectionMouseDown={handleConnectionMouseDown}
              showConnectionHandleForSide={showConnectionHandleForSide}
              scheduleConnectionHandleHide={scheduleConnectionHandleHide}
              hoveredConnectionHandle={hoveredConnectionHandle}
              setCanvasPointerWorld={setCanvasPointerWorld}
              screenToWorld={screenToWorld}
              renderTileBody={renderTileBody}
            />

            <AppCanvasConnections layer="routes" {...appCanvasConnectionProps} />
          </div>

          <AppCanvasConnections layer="glow" {...appCanvasConnectionProps} />

          <AppCanvasGroupToolbar
            selectedTileCount={selectedTileIds.size}
            theme={theme}
            appFonts={appFonts}
            onGroupSelected={groupSelectedTiles}
            onClearSelection={() => setSelectedTileIds(new Set())}
          />

        </AppCanvasSurface>

        <AppCanvasArrangeToolbar
          tiles={tiles}
          groups={groups}
          panelLayout={panelLayout}
          viewportZoom={viewport.zoom}
          canvasArrangeMode={canvasArrangeMode}
          onArrangeTiles={handleArrange}
          onSetCanvasArrangeMode={setCanvasArrangeMode}
          onExitExpandedMode={exitExpandedMode}
          onEnterTabbedView={enterTabbedView}
          onZoomToggle={toggleZoomOne}
        />
      </div>
      <AppOverlays
        showMCP={showMCP}
        setShowMCP={setShowMCP}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        showExtensionsGallery={showExtensionsGallery}
        setShowExtensionsGallery={setShowExtensionsGallery}
        settingsLoaded={settingsLoaded}
        settings={settings}
        updateAppSettings={updateAppSettings}
        setSettings={setSettings}
        workspaces={workspaces}
        workspacePath={workspace?.path}
        systemPrefersDark={systemPrefersDark}
        ctxMenu={ctxMenu}
        closeCtx={closeCtx}
        showAgentSetup={showAgentSetup}
        setShowAgentSetup={setShowAgentSetup}
        skillInstallPath={skillInstallPath}
        setSkillInstallPath={setSkillInstallPath}
        commandPaletteOpen={commandPaletteOpen}
        setCommandPaletteOpen={setCommandPaletteOpen}
        showPetPicker={showPetPicker}
        setShowPetPicker={setShowPetPicker}
      />
    </div>
    </FontProvider>
    </FontTokenProvider>
    </ThemeProvider>
  )
}

export default App
