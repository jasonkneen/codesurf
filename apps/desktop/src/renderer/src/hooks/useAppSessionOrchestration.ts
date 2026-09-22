import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { AggregatedSessionEntry, WorkspaceSessionEntry } from '../../../shared/session-types'
import type { AppSettings, TileState, Workspace } from '../../../shared/types'
import {
  findLeafIdContainingTile,
  pinTabInLeaf,
  setActiveTab,
  type PanelLeaf,
  type PanelNode,
} from '../components/panelLayoutTree'
import { setChatTileRuntimeState } from '../components/chatTileRuntimeState'
import { resolveFileTileType } from '../lib/fileTileType'
import {
  buildSessionEntryHint,
  findMatchingChatTileIdForSession,
  type ChatTileSessionMatch,
} from '../lib/sessionEntryHelpers'
import {
  buildNextChatTileRuntimeState,
  INITIAL_EXTERNAL_SESSION_TAIL_LOAD,
  shouldUsePagedLinkedHistory,
  type LoadedSessionState,
} from '../lib/sessionChatState'
import {
  getCanonicalWorkspaceId,
  normalizeWorkspacePath,
  resolveWorkspaceCandidateForProjectPath,
} from '../lib/workspaceHelpers'
import { basename } from '../utils/dnd'

export type FocusOpenOptions = { persist?: boolean; sourceTileId?: string }
export type SessionTargetEntry = AggregatedSessionEntry | WorkspaceSessionEntry

type PendingSessionOpen =
  | { kind: 'chat'; session: SessionTargetEntry; workspaceId: string; options?: FocusOpenOptions }
  | { kind: 'app'; session: SessionTargetEntry; workspaceId: string }

export type UseAppSessionOrchestrationParams = {
  workspace: Workspace | null
  workspaces: Workspace[]
  settings: AppSettings
  chatTileSessionMatches: Record<string, ChatTileSessionMatch>
  rememberChatTileSessionMatch: (tileId: string, session: AggregatedSessionEntry, sessionIdOverride?: string | null) => void
  tilesRef: RefObject<TileState[]>
  panelLayoutRef: RefObject<PanelNode | null>
  activePanelIdRef: RefObject<string | null>
  expandedTileIdRef: RefObject<string | null>
  setSidebarSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  setPanelLayout: React.Dispatch<React.SetStateAction<PanelNode | null>>
  setActivePanelId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandedTileId: React.Dispatch<React.SetStateAction<string | null>>
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>
  setChatReloadTokens: React.Dispatch<React.SetStateAction<Record<string, number>>>
  handleSwitchWorkspace: (id: string) => Promise<void>
  addTile: (
    type: TileState['type'],
    filePath?: string,
    position?: { x: number; y: number },
    launch?: { launchBin: string; launchArgs: string[] },
  ) => string
  buildTileState: (type: TileState['type'], filePath?: string) => TileState
  mountTile: (tile: TileState, options: { panelId: string; preview?: boolean }) => string
  replacePreviewTile: (tileId: string, tile: TileState, panelId: string, options: { preview: boolean }) => string
  pinPreviewTab: (tileId: string) => void
  bringToFront: (id: string) => void
  lockConnection: (sourceTileId: string, targetTileId: string) => void
  getNavigationLeaf: () => PanelLeaf | null
  isPreviewTabReplaceable: (tileId: string) => boolean
  findPanelFileOpenLeaf: (sourceTileId: string | undefined, fileType: TileState['type']) => PanelLeaf | null
}

export function useAppSessionOrchestration(params: UseAppSessionOrchestrationParams) {
  const {
    workspace,
    workspaces,
    settings,
    chatTileSessionMatches,
    rememberChatTileSessionMatch,
    tilesRef,
    panelLayoutRef,
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
  } = params

  const [pendingSessionOpen, setPendingSessionOpen] = useState<PendingSessionOpen | null>(null)

  const focusTileInWorkspace = useCallback((tileId: string) => {
    bringToFront(tileId)

    const currentLayout = panelLayoutRef.current
    if (currentLayout) {
      const leafId = findLeafIdContainingTile(currentLayout, tileId)
      if (leafId) {
        setActivePanelId(leafId)
        setPanelLayout(prev => prev ? setActiveTab(prev, leafId, tileId) : prev)
      }
    }

    if (expandedTileIdRef.current) {
      setExpandedTileId(tileId)
    }
  }, [bringToFront, expandedTileIdRef, panelLayoutRef, setActivePanelId, setExpandedTileId, setPanelLayout])

  const handleOpenFile = useCallback((filePath: string, options?: FocusOpenOptions) => {
    const persist = options?.persist === true
    const sourceTileId = options?.sourceTileId
    setSidebarSelectedPath(filePath)

    const existing = tilesRef.current.find(tile => tile.filePath === filePath)
    if (existing) {
      focusTileInWorkspace(existing.id)
      if (persist) pinPreviewTab(existing.id)
      if (sourceTileId) lockConnection(sourceTileId, existing.id)
      return
    }

    void resolveFileTileType(filePath).then(type => {
      let targetLeaf = panelLayoutRef.current ? findPanelFileOpenLeaf(sourceTileId, type) : null
      if (targetLeaf?.previewTabId && !persist && !isPreviewTabReplaceable(targetLeaf.previewTabId)) {
        setPanelLayout(prev => prev ? pinTabInLeaf(prev, targetLeaf!.id, targetLeaf!.previewTabId!) : prev)
        targetLeaf = { ...targetLeaf, previewTabId: null }
      }

      if (!targetLeaf) {
        const openedTileId = addTile(type, filePath)
        if (sourceTileId) lockConnection(sourceTileId, openedTileId)
        return
      }

      const newTile = buildTileState(type, filePath)
      const blankEditorTileId = !persist && (type === 'code' || type === 'note')
        ? targetLeaf.tabs.find(tileId => {
          const tile = tilesRef.current.find(candidate => candidate.id === tileId)
          return (tile?.type === 'code' || tile?.type === 'note') && !tile.filePath && isPreviewTabReplaceable(tile.id)
        })
        : undefined
      if (blankEditorTileId) {
        const openedTileId = replacePreviewTile(blankEditorTileId, newTile, targetLeaf.id, { preview: true })
        if (sourceTileId) lockConnection(sourceTileId, openedTileId)
        return
      }

      if (!persist && targetLeaf.previewTabId && isPreviewTabReplaceable(targetLeaf.previewTabId)) {
        const openedTileId = replacePreviewTile(targetLeaf.previewTabId, newTile, targetLeaf.id, { preview: true })
        if (sourceTileId) lockConnection(sourceTileId, openedTileId)
        return
      }

      const openedTileId = mountTile(newTile, { panelId: targetLeaf.id, preview: !persist })
      if (sourceTileId) lockConnection(sourceTileId, openedTileId)
    })
  }, [
    addTile,
    buildTileState,
    findPanelFileOpenLeaf,
    focusTileInWorkspace,
    isPreviewTabReplaceable,
    lockConnection,
    mountTile,
    panelLayoutRef,
    pinPreviewTab,
    replacePreviewTile,
    setPanelLayout,
    setSidebarSelectedPath,
    tilesRef,
  ])

  const resolveWorkspaceForProjectPath = useCallback(async (projectPath: string | null | undefined): Promise<Workspace | null> => {
    const normalizedProjectPath = normalizeWorkspacePath(projectPath)
    if (!normalizedProjectPath) return workspace ?? null

    const existingWorkspace = resolveWorkspaceCandidateForProjectPath(workspaces, normalizedProjectPath, workspace?.id)
    if (existingWorkspace) return existingWorkspace

    const workspaceName = basename(normalizedProjectPath) || 'Project'
    const created = await window.electron.workspace.createWithPath(workspaceName, normalizedProjectPath)
    const updated = await window.electron.workspace.list().catch(() => null)
    if (updated && updated.length > 0) setWorkspaces(updated)
    return created
  }, [workspace, workspaces, setWorkspaces])

  const resolveWorkspaceForSession = useCallback(async (session: SessionTargetEntry): Promise<Workspace | null> => {
    const workspaceId = 'workspaceId' in session && typeof session.workspaceId === 'string'
      ? session.workspaceId
      : null
    if (workspaceId) {
      const canonicalWorkspaceId = getCanonicalWorkspaceId(workspaces, workspaceId) ?? workspaceId
      const directWorkspace = workspaces.find(candidate => candidate.id === canonicalWorkspaceId) ?? null
      if (directWorkspace) return directWorkspace
      if (workspace?.id === canonicalWorkspaceId) return workspace
    }
    return resolveWorkspaceForProjectPath(session.projectPath)
  }, [resolveWorkspaceForProjectPath, workspace, workspaces])

  const openSessionInChatCurrentWorkspace = useCallback(async (
    session: AggregatedSessionEntry,
    workspaceId: string,
    options?: FocusOpenOptions,
  ) => {
    const persist = options?.persist === true
    const sessionHint = buildSessionEntryHint(session)
    const usePagedLinkedHistory = shouldUsePagedLinkedHistory(session)
    const existingTileId = findMatchingChatTileIdForSession(
      workspaceId,
      tilesRef.current,
      session,
      chatTileSessionMatches,
    )

    if (existingTileId) {
      rememberChatTileSessionMatch(existingTileId, session)
      if (persist) pinPreviewTab(existingTileId)
      focusTileInWorkspace(existingTileId)
    }

    const state = await window.electron.canvas.getSessionState(workspaceId, session.id, {
      entryHint: sessionHint,
      tailLimit: usePagedLinkedHistory ? INITIAL_EXTERNAL_SESSION_TAIL_LOAD : undefined,
    }).catch(() => null) as LoadedSessionState | null
    if (!state) {
      if (existingTileId) return
      if (!session.id.startsWith('codesurf-') && session.filePath) handleOpenFile(session.filePath, { persist })
      return
    }

    const nextChatState = buildNextChatTileRuntimeState(session, state, settings)
    const matchingChatTileId = existingTileId ?? findMatchingChatTileIdForSession(
      workspaceId,
      tilesRef.current,
      session,
      chatTileSessionMatches,
    )
    const shouldOpenPermanent = persist || nextChatState.isStreaming === true

    if (matchingChatTileId) {
      rememberChatTileSessionMatch(matchingChatTileId, session, nextChatState.sessionId ?? null)
      setChatTileRuntimeState(workspaceId, matchingChatTileId, nextChatState)
      await window.electron.canvas.saveTileState(workspaceId, matchingChatTileId, nextChatState).catch(() => {})
      if (shouldOpenPermanent) pinPreviewTab(matchingChatTileId)
      setChatReloadTokens(prev => ({ ...prev, [matchingChatTileId]: (prev[matchingChatTileId] ?? 0) + 1 }))
      focusTileInWorkspace(matchingChatTileId)
      return
    }

    let targetLeaf = panelLayoutRef.current ? getNavigationLeaf() : null
    if (targetLeaf?.previewTabId && !shouldOpenPermanent && !isPreviewTabReplaceable(targetLeaf.previewTabId)) {
      setPanelLayout(prev => prev ? pinTabInLeaf(prev, targetLeaf!.id, targetLeaf!.previewTabId!) : prev)
      targetLeaf = { ...targetLeaf, previewTabId: null }
    }

    const chatTileId = targetLeaf
      ? (() => {
          const newTile = buildTileState('chat')
          if (!shouldOpenPermanent && targetLeaf?.previewTabId && isPreviewTabReplaceable(targetLeaf.previewTabId)) {
            return replacePreviewTile(targetLeaf.previewTabId, newTile, targetLeaf.id, { preview: true })
          }
          return mountTile(newTile, { panelId: targetLeaf.id, preview: !shouldOpenPermanent })
        })()
      : addTile('chat')

    rememberChatTileSessionMatch(chatTileId, session, nextChatState.sessionId ?? null)
    setChatTileRuntimeState(workspaceId, chatTileId, nextChatState)
    await window.electron.canvas.saveTileState(workspaceId, chatTileId, nextChatState).catch(() => {})
    if (targetLeaf) {
      if (shouldOpenPermanent) pinPreviewTab(chatTileId)
      return
    }
    bringToFront(chatTileId)
  }, [
    addTile,
    bringToFront,
    buildTileState,
    chatTileSessionMatches,
    focusTileInWorkspace,
    getNavigationLeaf,
    handleOpenFile,
    isPreviewTabReplaceable,
    mountTile,
    panelLayoutRef,
    pinPreviewTab,
    rememberChatTileSessionMatch,
    replacePreviewTile,
    setChatReloadTokens,
    setPanelLayout,
    settings,
    tilesRef,
  ])

  const openSessionInChat = useCallback(async (session: SessionTargetEntry, options?: FocusOpenOptions) => {
    const targetWorkspace = await resolveWorkspaceForSession(session)
    if (!targetWorkspace?.id) return

    if (targetWorkspace.id !== workspace?.id) {
      setPendingSessionOpen({ kind: 'chat', session, workspaceId: targetWorkspace.id, options })
      await handleSwitchWorkspace(targetWorkspace.id)
      return
    }

    await openSessionInChatCurrentWorkspace(session, targetWorkspace.id, options)
  }, [resolveWorkspaceForSession, workspace?.id, handleSwitchWorkspace, openSessionInChatCurrentWorkspace])

  const openSessionInAppCurrentWorkspace = useCallback((session: AggregatedSessionEntry) => {
    if (!session.resumeBin) return
    const tileId = addTile('terminal', undefined, undefined, {
      launchBin: session.resumeBin,
      launchArgs: session.resumeArgs ?? [],
    })
    bringToFront(tileId)
  }, [addTile, bringToFront])

  const openSessionInApp = useCallback(async (session: SessionTargetEntry) => {
    const targetWorkspace = await resolveWorkspaceForSession(session)
    if (!targetWorkspace?.id) return

    if (targetWorkspace.id !== workspace?.id) {
      setPendingSessionOpen({ kind: 'app', session, workspaceId: targetWorkspace.id })
      await handleSwitchWorkspace(targetWorkspace.id)
      return
    }

    openSessionInAppCurrentWorkspace(session)
  }, [resolveWorkspaceForSession, workspace?.id, handleSwitchWorkspace, openSessionInAppCurrentWorkspace])

  const openDaemonTask = useCallback(async (task: {
    id: string
    taskLabel: string | null
    status: string
    provider: string | null
    model: string | null
    workspaceDir: string | null
    sessionId: string | null
  }) => {
    const projectPath = normalizeWorkspacePath(task.workspaceDir)
    if (!projectPath) return

    const session: AggregatedSessionEntry = {
      id: `codesurf-job:${task.id}`,
      source: 'codesurf',
      scope: 'workspace',
      tileId: null,
      sessionId: task.sessionId,
      provider: task.provider ?? 'claude',
      model: task.model ?? '',
      messageCount: 0,
      lastMessage: task.taskLabel,
      updatedAt: Date.now(),
      title: task.taskLabel ?? `${task.provider ?? 'Agent'} task`,
      projectPath,
      sourceLabel: 'CodeSurf',
      sourceDetail: `${task.provider ?? 'Agent'} daemon`,
      canOpenInChat: true,
      canOpenInApp: false,
      relatedGroupId: null,
      nestingLevel: 0,
    }

    await openSessionInChat(session)
  }, [openSessionInChat])

  useEffect(() => {
    if (!pendingSessionOpen || !workspace?.id) return
    if (pendingSessionOpen.workspaceId !== workspace.id) return

    const nextPending = pendingSessionOpen
    setPendingSessionOpen(null)

    if (nextPending.kind === 'chat') {
      void openSessionInChatCurrentWorkspace(nextPending.session, workspace.id, nextPending.options)
      return
    }

    openSessionInAppCurrentWorkspace(nextPending.session)
  }, [pendingSessionOpen, workspace?.id, openSessionInAppCurrentWorkspace, openSessionInChatCurrentWorkspace])

  return {
    handleOpenFile,
    openSessionInChat,
    openSessionInApp,
    openDaemonTask,
  }
}
