/**
 * Sidebar session/workspace controller — state, effects, and list model.
 * Extracted from Sidebar.tsx so the view component stays presentational.
 */
import React, { useEffect, useRef, useState, useMemo, useCallback, useSyncExternalStore } from 'react'
import { Archive, ArchiveRestore, Clock3, Maximize2, Pin } from 'lucide-react'
import { getChatStreamingSnapshot, subscribeChatStreaming } from '../chatStreamingStore'
import { getChatMessageSentSnapshot, subscribeChatMessageSent } from '../chatMessageSentStore'
import type { ProjectRecord, Workspace, TileState } from '../../../../shared/types'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import type { MenuItem } from '../ContextMenu'
import type { SidebarTextDialogState } from './SidebarTextDialog'
import { SessionSidebarRow } from './SessionSidebarRow'
import {
  type SessionReadWatermarks,
  type PinnedSessionKeys,
  getSessionActivityKey,
  getSessionSelectionKey,
  loadSessionReadWatermarks,
  saveSessionReadWatermarks,
  loadPinnedSessionKeys,
  savePinnedSessionKeys,
  hasUnreadSessionUpdate,
  SessionSidebarIndicator,
  formatSessionSidebarMeta,
} from './session-indicators'
import { sidebarPathBelongsToProject } from './path-utils'
import {
  SESSION_ACTION_BUTTON_SIZE,
  SESSION_ACTION_ICON_SIZE,
  formatSessionSidebarRelativeTime,
  getSessionRowExtraWidth,
  getSessionArchiveActionLabel,
} from './session-actions'
import {
  getSessionTitleGenerationIndicator,
  getSessionTitleGenerationKey,
  type SessionTitleGenerationState,
  updateSessionTitleGenerationState,
} from './session-title-generation'
import { getSessionOpenIntent } from './session-open'
import { buildNestedSessionList, deriveProjectsFromWorkspaces, formatSessionTitleForSidebar, getProjectDisplayLabel, getSessionAgentIcon, getSessionAgentKey, getSessionAgentLabel, getWorkspaceProjectPaths, isCronSession, isSubagentSession, normalizeSidebarPath } from './utils'
import { isInternalMaintenanceSession } from './session-filters'
import { applySessionPromotions, isSessionActive } from './session-ordering'
import { type DisplaySessionEntry, type ProjectListEntry, SESSION_PAGE_SIZE, type SessionEntry, type SessionProjectGroup, type ThreadOrganizeMode, type ThreadSortMode } from './types'

interface ExtTileEntry { extId: string; type: string; label: string; icon?: string }
interface ExtensionEntrySummary { id: string; name: string; icon?: string | null; enabled: boolean }
export const PROJECT_SESSION_PREVIEW_COUNT = 5
export const PROJECT_SESSION_SHOW_MORE_COUNT = 10

export interface SidebarControllerProps {
  workspace: Workspace | null
  workspaces: Workspace[]
  tiles: TileState[]
  onSwitchWorkspace: (id: string) => void
  onDeleteWorkspace: (id: string) => void
  onNewWorkspace: (name: string) => void
  onOpenFolder: () => void
  onOpenFile: (filePath: string, options?: { persist?: boolean }) => void
  onFocusTile: (tileId: string) => void
  onUpdateTile: (tileId: string, patch: Partial<TileState>) => void
  onCloseTile: (tileId: string) => void
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  /**
   * Start a new chat scoped to a specific project row. Host decides whether
   * to open it fullscreen or drop it onto the canvas based on the current
   * view mode. When omitted, the per-row "+" buttons are hidden.
   */
  onNewChatForProject?: (args: { projectId: string; projectPath: string; workspaceId: string | null }) => void
  onNewFiles: () => void
  onOpenSettings: (tab: string) => void
  onOpenSessionInChat: (session: SessionEntry, options?: { persist?: boolean }) => void
  onOpenSessionInApp: (session: SessionEntry) => void
  extensionTiles?: ExtTileEntry[]
  extensionEntries?: ExtensionEntrySummary[]
  onAddExtensionTile?: (type: string) => void
  pinnedExtensionIds?: string[]
  onTogglePinnedExtension?: (extId: string) => void
  collapsed: boolean
  width: number
  onWidthChange: (width: number) => void
  minWidth?: number
  maxWidth?: number
  onResizeStateChange?: (resizing: boolean) => void
  onToggleCollapse: () => void
  showFooter?: boolean
  /**
   * Tile id of the currently focused chat, or null when the focus isn't on a
   * chat. Used to emphasize the matching session row in the thread list so
   * the user can see "you are here" without clicking around.
   */
  activeChatTileId?: string | null
  activeChatSessionId?: string | null
  activeChatSessionEntryId?: string | null
}


const SESSION_FOCUS_REFRESH_STALE_MS = 15_000

export function useSidebarController({
  workspace, workspaces, tiles: _tiles, onSwitchWorkspace: _onSwitchWorkspace, onDeleteWorkspace: _onDeleteWorkspace, onNewWorkspace: _onNewWorkspace, onOpenFolder, onOpenFile, onFocusTile: _onFocusTile, onUpdateTile: _onUpdateTile, onCloseTile: _onCloseTile,
  onNewTerminal: _onNewTerminal, onNewKanban: _onNewKanban, onNewBrowser: _onNewBrowser, onNewChat: _onNewChat, onNewChatForProject: _onNewChatForProject, onNewFiles: _onNewFiles, onOpenSettings: _onOpenSettings,
  onOpenSessionInChat, onOpenSessionInApp,
  extensionTiles: _extensionTiles, extensionEntries: _extensionEntries, onAddExtensionTile: _onAddExtensionTile, pinnedExtensionIds = [],
  collapsed: _collapsed, width, onWidthChange, minWidth = 270, maxWidth = 520, onResizeStateChange, onToggleCollapse: _onToggleCollapse, showFooter: _showFooter = true,
  activeChatTileId = null,
  activeChatSessionId = null,
  activeChatSessionEntryId = null,
}: SidebarControllerProps) {
  const fonts = useAppFonts()
  const theme = useTheme()
  const widthRef = useRef(width)
  const scrollRef = useRef<HTMLDivElement>(null)
  void pinnedExtensionIds
  useEffect(() => { widthRef.current = width }, [width])
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false)
  const [searchPaletteQuery, setSearchPaletteQuery] = useState('')
  const [sessionCtx, setSessionCtx] = useState<{ x: number; y: number; session: SessionEntry } | null>(null)
  const [projectCtx, setProjectCtx] = useState<{ x: number; y: number; group: SessionProjectGroup } | null>(null)
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const [threadOrganizeMode, setThreadOrganizeMode] = useState<ThreadOrganizeMode>('project')
  const [threadSortMode, setThreadSortMode] = useState<ThreadSortMode>('updated')
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [showCronSessions, setShowCronSessions] = useState(false)
  const [showSubagentSessions, setShowSubagentSessions] = useState(true)
  const [hiddenSessionAgents, setHiddenSessionAgents] = useState<Record<string, boolean>>({})
  const [collapsedThreadGroups, setCollapsedThreadGroups] = useState<Record<string, boolean>>({})
  const [projectSessionVisibleCounts, setProjectSessionVisibleCounts] = useState<Record<string, number>>({})
  const [loadedSessionWorkspaceIds, setLoadedSessionWorkspaceIds] = useState<string[]>([])
  const [hoveredProjectRow, setHoveredProjectRow] = useState<string | null>(null)
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null)
  const [generatingSessionTitleIds, setGeneratingSessionTitleIds] = useState<SessionTitleGenerationState>({})
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_PAGE_SIZE)
  const [sessionPromotions, setSessionPromotions] = useState<Record<string, number>>({})
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sessionReadWatermarks, setSessionReadWatermarks] = useState<SessionReadWatermarks>(() => loadSessionReadWatermarks())
  const [pinnedSessionKeys, setPinnedSessionKeys] = useState<PinnedSessionKeys>(() => loadPinnedSessionKeys())
  const [textDialog, setTextDialog] = useState<SidebarTextDialogState | null>(null)
  const threadMenuRef = useRef<HTMLDivElement>(null)
  const sessionLoadRequestSeqRef = useRef(0)
  const latestSessionLoadTokenByWorkspaceRef = useRef(new Map<string, number>())
  const lastSessionLoadAtByWorkspaceRef = useRef(new Map<string, number>())
  const readSeededWorkspaceIdsRef = useRef(new Set<string>())

  const openSearchPalette = useCallback(() => {
    setSearchPaletteQuery('')
    setSearchPaletteOpen(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g')) return
      event.preventDefault()
      event.stopPropagation()
      openSearchPalette()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [openSearchPalette])

  useEffect(() => {
    let cancelled = false

    const loadProjects = async () => {
      const listProjects = window.electron.workspace.listProjects
      if (typeof listProjects !== 'function') {
        if (!cancelled) setProjects([])
        return
      }

      const next = await listProjects().catch(() => null)
      if (cancelled || !next) return
      setProjects(next)
    }

    void loadProjects()
    window.addEventListener('focus', loadProjects)

    return () => {
      cancelled = true
      window.removeEventListener('focus', loadProjects)
    }
  }, [workspaces])

  const projectEntries = useMemo<ProjectListEntry[]>(() => {
    const workspaceIdsByPath = new Map<string, string[]>()
    for (const workspaceEntry of workspaces) {
      for (const projectPath of getWorkspaceProjectPaths(workspaceEntry)) {
        const existing = workspaceIdsByPath.get(projectPath) ?? []
        if (!existing.includes(workspaceEntry.id)) existing.push(workspaceEntry.id)
        workspaceIdsByPath.set(projectPath, existing)
      }
    }

    const sourceProjects = projects.length > 0
      ? projects.map(project => ({
        id: project.id,
        name: project.name,
        path: project.path,
        workspaceIds: [],
        representativeWorkspaceId: null,
      }))
      : deriveProjectsFromWorkspaces(workspaces)

    return sourceProjects
      .map(project => {
        const normalizedPath = normalizeSidebarPath(project.path)
        const workspaceIds = workspaceIdsByPath.get(normalizedPath) ?? []
        return {
          ...project,
          workspaceIds,
          representativeWorkspaceId: workspaceIds.includes(workspace?.id ?? '')
            ? (workspace?.id ?? null)
            : (workspaceIds[0] ?? null),
        }
      })
      .filter(project => project.workspaceIds.length > 0)
      .sort((a, b) => getProjectDisplayLabel(a).localeCompare(getProjectDisplayLabel(b), undefined, { sensitivity: 'base' }))
  }, [projects, workspaces, workspace?.id])

  const workspaceById = useMemo(() => new Map(workspaces.map(workspaceEntry => [workspaceEntry.id, workspaceEntry] as const)), [workspaces])

  const refreshProjects = useCallback(async () => {
    const listProjects = window.electron.workspace.listProjects
    if (typeof listProjects !== 'function') return
    const next = await listProjects().catch(() => null)
    if (next) setProjects(next)
  }, [])

  const activeProjectId = useMemo(() => {
    const primaryProjectPath = normalizeSidebarPath(workspace?.path)
    const currentPaths = new Set(getWorkspaceProjectPaths(workspace))
    const currentProject = projectEntries.find(project => normalizeSidebarPath(project.path) === primaryProjectPath)
      ?? projectEntries.find(project => currentPaths.has(normalizeSidebarPath(project.path)))
      ?? null
    return currentProject?.id ?? projectEntries[0]?.id ?? null
  }, [projectEntries, workspace])

  const loadedSessionWorkspaceIdSet = useMemo(() => new Set(loadedSessionWorkspaceIds), [loadedSessionWorkspaceIds])

  useEffect(() => {
    if (activeProjectId) setSelectedProjectId(activeProjectId)
  }, [activeProjectId])

  useEffect(() => {
    const activeSessions = sessions.filter(session => isSessionActive(session, {
      activeChatTileId,
      activeChatSessionId,
      activeChatSessionEntryId,
    }))
    if (activeSessions.length === 0) return
    if (activeSessions.some(session => getSessionSelectionKey(session) === selectedSessionKey)) return
    setSelectedSessionKey(getSessionSelectionKey(activeSessions[0]))
  }, [activeChatSessionEntryId, activeChatSessionId, activeChatTileId, selectedSessionKey, sessions])

  const scrollSessionsToTop = useCallback(() => {
    window.requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    })
  }, [])

  const promoteSession = useCallback((session: SessionEntry | null | undefined) => {
    if (!session) return
    const promotedAt = Date.now()
    setSessionPromotions(prev => {
      const current = prev[session.id] ?? 0
      if (current >= promotedAt) return prev
      return {
        ...prev,
        [session.id]: promotedAt,
      }
    })
    scrollSessionsToTop()
  }, [scrollSessionsToTop])

  const markSessionRead = useCallback((session: SessionEntry | null | undefined) => {
    if (!session) return
    const key = getSessionActivityKey(session)
    setSessionReadWatermarks(prev => {
      const current = prev[key] ?? 0
      if (current >= session.updatedAt) return prev
      return {
        ...prev,
        [key]: session.updatedAt,
      }
    })
  }, [])

  useEffect(() => {
    saveSessionReadWatermarks(sessionReadWatermarks)
  }, [sessionReadWatermarks])

  useEffect(() => {
    savePinnedSessionKeys(pinnedSessionKeys)
  }, [pinnedSessionKeys])

  // Consolidated reconciliation effect: prune promotions, seed watermarks, and
  // auto-mark active sessions as read — all in one pass to avoid fan-out renders.
  useEffect(() => {
    if (sessions.length === 0) return

    const validIds = new Set(sessions.map(s => s.id))
    setSessionPromotions(prev => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [sessionId, promotedAt] of Object.entries(prev)) {
        if (!validIds.has(sessionId)) { changed = true; continue }
        next[sessionId] = promotedAt
      }
      return changed ? next : prev
    })

    const activeSessions = sessions.filter(session => isSessionActive(session, {
      activeChatTileId,
      activeChatSessionId,
      activeChatSessionEntryId,
    }))
    setSessionReadWatermarks(prev => {
      let changed = false
      const next: SessionReadWatermarks = { ...prev }
      // Seed new sessions
      for (const session of sessions) {
        const key = getSessionActivityKey(session)
        if (Object.prototype.hasOwnProperty.call(next, key)) continue
        const isSeededWorkspace = readSeededWorkspaceIdsRef.current.has(session.workspaceId)
        next[key] = isSeededWorkspace ? 0 : session.updatedAt
        changed = true
      }
      for (const session of sessions) {
        readSeededWorkspaceIdsRef.current.add(session.workspaceId)
      }
      // Auto-mark active sessions as read
      for (const session of activeSessions) {
        const key = getSessionActivityKey(session)
        const current = next[key] ?? 0
        if (current >= session.updatedAt) continue
        next[key] = session.updatedAt
        changed = true
      }
      return changed ? next : prev
    })
  }, [activeChatSessionEntryId, activeChatSessionId, activeChatTileId, sessions])

  // Streaming session/tile ids published by ChatTile — used to swap the row
  // icon for a spinner while the thread is actively streaming. Read-only: we
  // no longer use streaming as a promotion trigger because it fires for any
  // stream start (resume, tool-call continuation, auto-continue), not just a
  // user submit.
  const streamingSnapshot = useSyncExternalStore(subscribeChatStreaming, getChatStreamingSnapshot, getChatStreamingSnapshot)

  // Explicit "user hit send" signal from ChatTile. Promote only when the seq
  // advances — opening, focusing, or resuming a thread does not publish here.
  const sentSnapshot = useSyncExternalStore(subscribeChatMessageSent, getChatMessageSentSnapshot, getChatMessageSentSnapshot)
  const lastPromotedSeqRef = useRef(0)
  useEffect(() => {
    if (!sentSnapshot || sentSnapshot.seq <= lastPromotedSeqRef.current) return
    lastPromotedSeqRef.current = sentSnapshot.seq
    const match = sessions.find(session => {
      if (sentSnapshot.entryId && session.id === sentSnapshot.entryId) return true
      if (sentSnapshot.tileId && session.tileId === sentSnapshot.tileId) return true
      return false
    })
    if (match) promoteSession(match)
  }, [sentSnapshot, sessions, promoteSession])

  const isThreadGroupCollapsed = useCallback((group: SessionProjectGroup | ProjectListEntry) => {
    const groupKey = 'key' in group ? group.key : group.id
    const explicit = collapsedThreadGroups[groupKey]
    if (typeof explicit === 'boolean') return explicit
    // The sidebar is shared chrome: switching workspace/tab state should only
    // change the main panel, not silently reshape the conversation list.
    return false
  }, [collapsedThreadGroups])

  const allProjectThreadGroupsCollapsed = useMemo(() => {
    return projectEntries.length > 0 && projectEntries.every(projectEntry => isThreadGroupCollapsed(projectEntry))
  }, [isThreadGroupCollapsed, projectEntries])

  useEffect(() => {
    if (!threadMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const insidePortal = Boolean(target?.closest('[data-sidebar-menu-portal="true"]'))
      if (!insidePortal && threadMenuRef.current && !threadMenuRef.current.contains(event.target as Node)) {
        setThreadMenuOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThreadMenuOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [threadMenuOpen])

  const annotateSessions = useCallback((workspaceEntry: Workspace, items: Array<Omit<SessionEntry, 'workspaceId' | 'workspaceName' | 'workspacePath'>>): SessionEntry[] => {
    return items.map(session => ({
      ...session,
      workspaceId: workspaceEntry.id,
      workspaceName: workspaceEntry.name,
      workspacePath: workspaceEntry.path,
    }))
  }, [])

  const loadWorkspaceSessions = useCallback(async (workspaceEntry: Workspace, forceRefresh = false) => {
    const requestToken = sessionLoadRequestSeqRef.current + 1
    sessionLoadRequestSeqRef.current = requestToken
    latestSessionLoadTokenByWorkspaceRef.current.set(workspaceEntry.id, requestToken)

    let items: Array<Omit<SessionEntry, 'workspaceId' | 'workspaceName' | 'workspacePath'>>
    try {
      items = await window.electron.canvas.listSessions(workspaceEntry.id, forceRefresh)
    } catch (error) {
      console.warn('[sidebar] failed to load sessions', {
        workspaceId: workspaceEntry.id,
        forceRefresh,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (latestSessionLoadTokenByWorkspaceRef.current.get(workspaceEntry.id) !== requestToken) return
    const annotated = annotateSessions(workspaceEntry, items)
    if (annotated.length === 0) readSeededWorkspaceIdsRef.current.add(workspaceEntry.id)
    setSessions(prev => [...prev.filter(session => session.workspaceId !== workspaceEntry.id), ...annotated])
    lastSessionLoadAtByWorkspaceRef.current.set(workspaceEntry.id, Date.now())
    setLoadedSessionWorkspaceIds(prev => prev.includes(workspaceEntry.id) ? prev : [...prev, workspaceEntry.id])
  }, [annotateSessions])

  useEffect(() => {
    const validWorkspaceIds = new Set(projectEntries.flatMap(projectEntry => projectEntry.workspaceIds))
    setSessions(prev => prev.filter(session => validWorkspaceIds.has(session.workspaceId)))
    setLoadedSessionWorkspaceIds(prev => prev.filter(workspaceId => validWorkspaceIds.has(workspaceId)))
  }, [projectEntries])

  useEffect(() => {
    if (projectEntries.length === 0) {
      setSessions([])
      setLoadedSessionWorkspaceIds([])
      return
    }

    const workspaceIdsToLoad = new Set<string>()
    for (const projectEntry of projectEntries) {
      for (const workspaceId of projectEntry.workspaceIds) {
        workspaceIdsToLoad.add(workspaceId)
      }
    }

    for (const workspaceId of workspaceIdsToLoad) {
      if (loadedSessionWorkspaceIdSet.has(workspaceId)) continue
      const workspaceEntry = workspaceById.get(workspaceId)
      if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry)
    }
  }, [
    loadWorkspaceSessions,
    loadedSessionWorkspaceIdSet,
    projectEntries,
    workspaceById,
  ])

  useEffect(() => {
    const unsubscribe = window.electron.canvas.onSessionsChanged(({ workspaceId }) => {
      // Wildcard '*' (or missing) → refresh every loaded workspace. Used by
      // the thread indexer when a reseed affects rows across workspaces.
      if (!workspaceId || workspaceId === '*') {
        for (const loadedId of loadedSessionWorkspaceIdSet) {
          const entry = workspaceById.get(loadedId)
          if (entry) void loadWorkspaceSessions(entry, false)
        }
        return
      }
      const workspaceEntry = workspaceById.get(workspaceId)
      if (!workspaceEntry || !loadedSessionWorkspaceIdSet.has(workspaceEntry.id)) return
      void loadWorkspaceSessions(workspaceEntry, true)
    })

    const onFocus = () => {
      const now = Date.now()
      const visibleWorkspaceIds = new Set<string>()
      if (workspace?.id) visibleWorkspaceIds.add(workspace.id)
      for (const projectEntry of projectEntries) {
        if (isThreadGroupCollapsed(projectEntry)) continue
        for (const workspaceId of projectEntry.workspaceIds) visibleWorkspaceIds.add(workspaceId)
      }

      for (const workspaceId of loadedSessionWorkspaceIdSet) {
        if (!visibleWorkspaceIds.has(workspaceId)) continue
        const lastLoadedAt = lastSessionLoadAtByWorkspaceRef.current.get(workspaceId) ?? 0
        if ((now - lastLoadedAt) < SESSION_FOCUS_REFRESH_STALE_MS) continue
        const workspaceEntry = workspaceById.get(workspaceId)
        if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry, true)
      }
    }

    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [isThreadGroupCollapsed, loadWorkspaceSessions, loadedSessionWorkspaceIdSet, projectEntries, workspace?.id, workspaceById])

  const promotedSessions = useMemo(() => applySessionPromotions(sessions, sessionPromotions), [sessions, sessionPromotions])

  const orderedProjectEntries = projectEntries

  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const toggleThreadGroup = useCallback((key: string) => {
    setSelectedProjectId(key)
    const projectEntry = projectEntries.find(entry => entry.id === key) ?? null
    const isActiveGroup = key === activeProjectId
    const isCollapsed = collapsedThreadGroups[key] ?? false

    if (!isActiveGroup && projectEntry) {
      setCollapsedThreadGroups(prev => ({ ...prev, [key]: false }))
      for (const workspaceId of projectEntry.workspaceIds) {
        const workspaceEntry = workspaceById.get(workspaceId)
        if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry)
      }
      // Switching to a different project should jump back to that project's
      // existing workspace/tab state rather than acting like a collapse toggle.
      const targetWsId = projectEntry.representativeWorkspaceId ?? projectEntry.workspaceIds[0]
      if (targetWsId && targetWsId !== workspace?.id) {
        _onSwitchWorkspace(targetWsId)
      }
      return
    }

    const shouldCollapse = !isCollapsed
    if (shouldCollapse) {
      setProjectSessionVisibleCounts(prev => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
    setCollapsedThreadGroups(prev => ({ ...prev, [key]: shouldCollapse }))
  }, [activeProjectId, collapsedThreadGroups, loadWorkspaceSessions, projectEntries, workspaceById, workspace?.id, _onSwitchWorkspace])

  const toggleAllThreadGroups = useCallback(() => {
    setProjectSessionVisibleCounts({})
    setCollapsedThreadGroups(() => {
      const next: Record<string, boolean> = {}
      for (const projectEntry of projectEntries) {
        next[projectEntry.id] = !allProjectThreadGroupsCollapsed
      }
      return next
    })
  }, [allProjectThreadGroupsCollapsed, projectEntries])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      onWidthChange(Math.max(minWidth, Math.min(maxWidth, startWidth.current + e.clientX - startX.current)))
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      onResizeStateChange?.(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onResizeStateChange, onWidthChange])

  const visibleSessions = useMemo(() => {
    // Dedup across workspaces: the same underlying chat can be surfaced by
    // multiple workspaces that share a project path. When it carries a real
    // provider sessionId we key on (agent, sessionId) so duplicates collapse;
    // fall back to `id` only for rows without a sessionId. Tiebreaker prefers
    // workspace/project scope over user scope, then the more recent entry.
    const deduped = new Map<string, SessionEntry>()
    const archivedByKey = new Map<string, boolean>()
    const keyFor = (session: SessionEntry): string => {
      if (session.sessionId) return `sid:${getSessionAgentKey(session)}:${session.sessionId}`
      return `id:${session.id}`
    }
    const scopeRank = (session: SessionEntry): number => (session.scope === 'user' ? 0 : 1)
    for (const session of promotedSessions) {
      const key = keyFor(session)
      // OR-merge archived across every copy of the session: archive state is
      // stored per-workspace, so a row archived in workspace A can appear
      // "unarchived" via workspace B. If ANY copy is archived, treat the
      // deduped row as archived.
      if (session.isArchived === true) archivedByKey.set(key, true)
      const existing = deduped.get(key)
      if (!existing) {
        deduped.set(key, session)
        continue
      }
      const existingScore = scopeRank(existing)
      const nextScore = scopeRank(session)
      if (nextScore > existingScore) { deduped.set(key, session); continue }
      if (nextScore === existingScore && session.updatedAt > existing.updatedAt) {
        deduped.set(key, session)
      }
    }
    for (const [key, entry] of deduped) {
      if (archivedByKey.get(key) === true && entry.isArchived !== true) {
        deduped.set(key, { ...entry, isArchived: true })
      }
    }

    const filtered = [...deduped.values()].filter(session => {
      const normalizedTitle = session.title?.trim().toLowerCase() ?? ''
      const hasContent = Boolean(session.title?.trim()) || Boolean(session.lastMessage?.trim()) || session.messageCount > 0
      if (!hasContent) return false
      if (normalizedTitle === 'new agent') return false
      if (isInternalMaintenanceSession(session)) return false
      if (!showArchivedSessions && session.isArchived === true) return false
      if (!showCronSessions && isCronSession(session)) return false
      if (!showSubagentSessions && isSubagentSession(session)) return false
      if (hiddenSessionAgents[getSessionAgentKey(session)] === true) return false
      return true
    })
    return buildNestedSessionList(filtered, threadSortMode, sessionPromotions)
  }, [promotedSessions, showArchivedSessions, showCronSessions, showSubagentSessions, hiddenSessionAgents, threadOrganizeMode, threadSortMode, sessionPromotions])

  const toggleSessionPinned = useCallback((session: SessionEntry) => {
    const key = getSessionActivityKey(session)
    setPinnedSessionKeys(prev => {
      if (prev[key]) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: true }
    })
  }, [])

  const pinnedVisibleSessions = useMemo(() => (
    visibleSessions.filter(session => pinnedSessionKeys[getSessionActivityKey(session)] === true)
  ), [pinnedSessionKeys, visibleSessions])

  const normalVisibleSessions = useMemo(() => (
    visibleSessions.filter(session => pinnedSessionKeys[getSessionActivityKey(session)] !== true)
  ), [pinnedSessionKeys, visibleSessions])

  const availableSessionAgents = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; icon: React.JSX.Element }>()
    for (const session of sessions) {
      const key = getSessionAgentKey(session)
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        label: getSessionAgentLabel(session),
        icon: getSessionAgentIcon(session),
      })
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }, [sessions])

  // Chronological mode uses a single flat list with one paginator.
  // Project mode renders the full project thread list and relies on the
  // sidebar scroller instead of a second per-project paging layer.
  useEffect(() => {
    setVisibleSessionCount(SESSION_PAGE_SIZE)
    setProjectSessionVisibleCounts({})
  }, [showArchivedSessions, showCronSessions, showSubagentSessions, threadOrganizeMode, threadSortMode])

  // Keep per-project pagination independent of the active workspace tab. The
  // sidebar should not reset visible thread counts just because the main view
  // switched to another tab/workspace.

  const displayedSessions = useMemo(() => {
    if (threadOrganizeMode !== 'chronological') return normalVisibleSessions
    return normalVisibleSessions.slice(0, visibleSessionCount)
  }, [normalVisibleSessions, visibleSessionCount, threadOrganizeMode])

  const displayedSessionGroups = useMemo<SessionProjectGroup[]>(() => {
    if (threadOrganizeMode === 'chronological') {
      return displayedSessions.length > 0 ? [{
        projectId: 'chronological',
        projectPath: '',
        representativeWorkspaceId: null,
        key: 'chronological',
        label: 'Threads',
        sessions: displayedSessions,
      }] : []
    }
    return orderedProjectEntries
      .map(projectEntry => {
        const projectPath = normalizeSidebarPath(projectEntry.path)
        const workspaceIdSet = new Set(projectEntry.workspaceIds)
        const allWorkspaceSessions = normalVisibleSessions.filter(session => {
          const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
          if (sessionProjectPath) return sidebarPathBelongsToProject(projectPath, sessionProjectPath)
          return workspaceIdSet.has(session.workspaceId)
        })
        return {
          projectId: projectEntry.id,
          projectPath: projectEntry.path,
          representativeWorkspaceId: projectEntry.representativeWorkspaceId,
          key: projectEntry.id,
          label: getProjectDisplayLabel(projectEntry),
          sessions: allWorkspaceSessions,
        }
      })
  }, [normalVisibleSessions, displayedSessions, orderedProjectEntries, threadOrganizeMode])

  const filteredSessionGroups = displayedSessionGroups

  const hasMoreSessions = threadOrganizeMode === 'chronological'
    ? displayedSessions.length < normalVisibleSessions.length
    : false

  const searchPaletteSessions = useMemo(() => {
    const q = searchPaletteQuery.trim().toLowerCase()
    const base = visibleSessions
    const filtered = q
      ? base.filter(session =>
        session.title?.toLowerCase().includes(q)
        || session.lastMessage?.toLowerCase().includes(q)
        || session.sourceLabel?.toLowerCase().includes(q)
        || session.workspaceName?.toLowerCase().includes(q)
      )
      : base
    return filtered.slice(0, 9)
  }, [searchPaletteQuery, visibleSessions])

  const setSessionArchived = useCallback(async (session: SessionEntry, archived: boolean) => {
    if (!session.workspaceId || archivingSessionId) return
    setArchivingSessionId(session.id)
    try {
      // Archive state is persisted per-workspace, but the same underlying chat
      // can be surfaced by multiple workspaces sharing a project path. Write
      // the flag to every workspace that lists this session (match by
      // agent + sessionId, or by id when sessionId is absent) so the row
      // can't resurrect from a copy that wasn't told about the change.
      const agentKey = getSessionAgentKey(session)
      const targets = new Map<string, SessionEntry>()
      for (const candidate of sessions) {
        const sameBySessionId = Boolean(session.sessionId)
          && candidate.sessionId === session.sessionId
          && getSessionAgentKey(candidate) === agentKey
        const sameById = candidate.id === session.id
        if (!sameBySessionId && !sameById) continue
        if (!candidate.workspaceId) continue
        const key = `${candidate.workspaceId}::${candidate.id}`
        if (!targets.has(key)) targets.set(key, candidate)
      }
      if (targets.size === 0) {
        targets.set(`${session.workspaceId}::${session.id}`, session)
      }

      const results = await Promise.all(
        [...targets.values()].map(target => {
          // Stable identity key so archive state survives the main-process
          // session merge (which can re-key the same chat under a different
          // entry id). Mirrors the server's sessionArchiveIdentityKey and the
          // dedup keyFor above. Undefined when there's no sessionId → server
          // falls back to the raw entry id.
          const targetKey = target.sessionId
            ? `sid:${getSessionAgentKey(target)}:${target.sessionId}`
            : undefined
          return window.electron.canvas.setSessionArchived(target.workspaceId, target.id, archived, targetKey)
            .catch(() => ({ ok: false }))
            .then(result => ({ target, ok: Boolean(result?.ok) }))
        }),
      )

      const succeeded = new Set(
        results.filter(r => r.ok).map(r => `${r.target.workspaceId}::${r.target.id}`),
      )
      if (succeeded.size > 0) {
        setSessions(prev => prev.map(entry => {
          if (!succeeded.has(`${entry.workspaceId}::${entry.id}`)) return entry
          return { ...entry, isArchived: archived }
        }))
      }
    } finally {
      setArchivingSessionId(null)
    }
  }, [archivingSessionId, sessions])

  const handleArchiveSessionClick = useCallback((session: SessionEntry) => {
    void setSessionArchived(session, !(session.isArchived === true))
  }, [setSessionArchived])

  const openSessionFromSidebar = useCallback((session: SessionEntry, options?: { persist?: boolean }) => {
    setSelectedSessionKey(getSessionSelectionKey(session))
    setSelectedProjectId(projectEntries.find(projectEntry => projectEntry.workspaceIds.includes(session.workspaceId))?.id ?? selectedProjectId)
    markSessionRead(session)
    const intent = getSessionOpenIntent(session, options)
    if (intent.kind === 'chat') {
      onOpenSessionInChat(session, { persist: intent.persist })
      return
    }
    if (intent.kind === 'app') {
      onOpenSessionInApp(session)
      return
    }
    if (intent.kind === 'file' && session.filePath) {
      onOpenFile(session.filePath, { persist: intent.persist })
    }
  }, [markSessionRead, onOpenFile, onOpenSessionInApp, onOpenSessionInChat, projectEntries, selectedProjectId])

  const openSessionMiniFromSidebar = useCallback((session: SessionEntry) => {
    const tileId = typeof session.tileId === 'string' ? session.tileId.trim() : ''
    if (!tileId) {
      openSessionFromSidebar(session)
      return
    }
    setSelectedSessionKey(getSessionSelectionKey(session))
    setSelectedProjectId(projectEntries.find(projectEntry => projectEntry.workspaceIds.includes(session.workspaceId))?.id ?? selectedProjectId)
    markSessionRead(session)
    void window.electron.window.openMiniChat({
      workspaceId: session.workspaceId,
      tileId,
      title: session.title,
    }).catch(error => {
      console.warn('[sidebar] failed to open mini chat window', error)
      openSessionFromSidebar(session)
    })
  }, [markSessionRead, openSessionFromSidebar, projectEntries, selectedProjectId])

  const sessionContextMenuItems = useCallback((session: SessionEntry): MenuItem[] => {
    const items: MenuItem[] = []
    const sessionKey = getSessionTitleGenerationKey(session.workspaceId, session.id)
    const titleGeneration = getSessionTitleGenerationIndicator(generatingSessionTitleIds[sessionKey] === true)
    if (session.canOpenInChat !== false) {
      items.push({ label: 'Open in Chat', action: () => onOpenSessionInChat(session) })
      items.push({ label: 'Open in Pinned Tab', action: () => onOpenSessionInChat(session, { persist: true }) })
      if (typeof session.tileId === 'string' && session.tileId.trim().length > 0) {
        items.push({ label: 'Open Mini Window', action: () => openSessionMiniFromSidebar(session) })
      }
    }
    if (session.canOpenInApp) {
      items.push({ label: `Open in ${session.sourceLabel}`, action: () => onOpenSessionInApp(session) })
    }
    if (session.id.startsWith('codesurf-runtime:') && (session.checkpointCount ?? 0) > 0) {
      items.push({
        label: session.checkpointCount === 1 ? 'Restore Latest Checkpoint' : `Restore Latest Checkpoint (${session.checkpointCount})`,
        action: () => {
          const confirmed = window.confirm(`Restore the latest checkpoint for "${session.title}"?`)
          if (!confirmed) return
          void window.electron.canvas.listCheckpoints(session.workspaceId, session.id)
            .then(checkpoints => {
              const latest = checkpoints[0]
              if (!latest) return null
              return window.electron.canvas.restoreCheckpoint(session.workspaceId, latest.id, session.id)
            })
            .then(async result => {
              if (!result?.ok) {
                if (result?.error) window.alert(result.error)
                return
              }
              const workspaceEntry = workspaceById.get(session.workspaceId)
              if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
              if (session.canOpenInChat !== false) await onOpenSessionInChat(session)
            })
            .catch(error => {
              window.alert(error instanceof Error ? error.message : String(error))
            })
        },
      })
    }
    if (session.filePath) {
      items.push({ label: 'Open Raw File', action: () => onOpenFile(session.filePath!) })
      items.push({ label: 'Open Raw File in Pinned Tab', action: () => onOpenFile(session.filePath!, { persist: true }) })
    }

    items.push({
      label: 'Rename Thread',
      action: () => {
        setTextDialog({
          title: 'Rename Thread',
          description: 'Update the title shown in the sidebar for this conversation.',
          confirmLabel: 'Rename',
          initialValue: session.title,
          submit: async (rawValue: string) => {
            const nextTitle = rawValue.trim()
            if (!nextTitle || nextTitle === session.title) return
            const result = await window.electron.canvas.renameSession(session.workspaceId, session.id, nextTitle)
            if (!result?.ok) throw new Error(result?.error || 'Failed to rename thread.')
            setSessions(prev => prev.map(entry => entry.id === session.id && entry.workspaceId === session.workspaceId
              ? { ...entry, title: nextTitle }
              : entry))
            const workspaceEntry = workspaceById.get(session.workspaceId)
            if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
          },
        })
      },
    })

    items.push({
      label: titleGeneration.menuLabel,
      action: () => {
        if (generatingSessionTitleIds[sessionKey] === true) return
        setGeneratingSessionTitleIds(prev => updateSessionTitleGenerationState(prev, sessionKey, true))
        void window.electron.canvas.generateSessionTitle(session.workspaceId, session.id, {
          id: session.id,
          source: session.source,
          filePath: session.filePath,
          sessionId: session.sessionId,
          provider: session.provider,
          model: session.model,
          messageCount: session.messageCount,
          title: session.title,
          projectPath: session.projectPath ?? null,
        })
          .then(async result => {
            if (!result?.ok) throw new Error(result?.error || 'Failed to generate thread title.')
            const nextTitle = result.title ?? session.title
            setSessions(prev => prev.map(entry => entry.id === session.id && entry.workspaceId === session.workspaceId
              ? { ...entry, title: nextTitle }
              : entry))
            const workspaceEntry = workspaceById.get(session.workspaceId)
            if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
          })
          .catch(error => {
            window.alert(error instanceof Error ? error.message : String(error))
          })
          .finally(() => {
            setGeneratingSessionTitleIds(prev => updateSessionTitleGenerationState(prev, sessionKey, false))
          })
      },
    })

    items.push({
      label: getSessionArchiveActionLabel(session.isArchived === true),
      action: () => { void setSessionArchived(session, !(session.isArchived === true)) },
    })

    return items.length > 0 ? items : [{ label: 'No actions available', action: () => {} }]
  }, [generatingSessionTitleIds, loadWorkspaceSessions, onOpenFile, onOpenSessionInApp, onOpenSessionInChat, openSessionMiniFromSidebar, setSessionArchived, workspaceById])

  const handleOpenProjectFromSidebar = useCallback(() => {
    onOpenFolder()
    setThreadMenuOpen(false)
  }, [onOpenFolder])

  const projectContextMenuItems = useCallback((group: SessionProjectGroup): MenuItem[] => {
    const projectEntry = projectEntries.find(entry => entry.id === group.projectId) ?? null
    const projectPath = projectEntry?.path ?? group.projectPath
    const workspaceIds = projectEntry?.workspaceIds ?? []

    return [
      {
        label: 'Open in Finder',
        action: () => {
          if (!projectPath) return
          const reveal = window.electron.fs.revealInFinder
          if (typeof reveal !== 'function') return
          void reveal(projectPath).catch(() => {})
        },
      },
      {
        label: 'Create permanent worktree',
        action: () => {
          if (!projectPath) return
          setTextDialog({
            title: 'Create Permanent Worktree',
            description: `Create a named worktree for ${group.label}. Invalid characters will be replaced with "-".`,
            confirmLabel: 'Create',
            initialValue: '',
            placeholder: 'feature/my-branch',
            submit: async (rawValue: string) => {
              const name = rawValue.trim()
              if (!name) return
              const safeName = name.replace(/[^A-Za-z0-9._/-]/g, '-')
              if (!safeName) throw new Error('Invalid worktree name.')
              const result = await window.electron.workspace.createProjectWorktree({
                projectId: projectEntry?.id,
                projectPath,
                name: safeName,
              })
              if (!result?.ok) throw new Error(result?.error || 'Failed to create worktree.')
              await refreshProjects()
            },
          })
        },
      },
      {
        label: 'Rename project',
        action: () => {
          const currentName = projectEntry?.name ?? group.label
          setTextDialog({
            title: 'Rename Project',
            description: 'Change the display name used for this project in the sidebar.',
            confirmLabel: 'Rename',
            initialValue: currentName,
            submit: async (rawValue: string) => {
              const nextName = rawValue.trim()
              if (!nextName || nextName === currentName) return
              const result = await window.electron.workspace.renameProject({
                projectId: projectEntry?.id,
                projectPath,
                name: nextName,
              })
              if (!result?.ok) throw new Error(result?.error || 'Failed to rename project.')
              await refreshProjects()
            },
          })
        },
      },
      {
        label: 'Archive chats',
        action: () => {
          const projectSessions = sessions.filter(session => {
            const normalizedProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
            if (normalizedProjectPath && projectPath) return sidebarPathBelongsToProject(projectPath, normalizedProjectPath)
            return workspaceIds.includes(session.workspaceId)
          }).filter(session => session.isArchived !== true)
          if (projectSessions.length === 0) return
          const confirmed = window.confirm(`Archive ${projectSessions.length} chat${projectSessions.length === 1 ? '' : 's'} in ${group.label}?`)
          if (!confirmed) return
          for (const session of projectSessions) {
            void setSessionArchived(session, true)
          }
        },
      },
      {
        label: 'Remove',
        action: () => {
          const confirmed = window.confirm(`Remove ${group.label} from the sidebar? (Files are not deleted.)`)
          if (!confirmed) return
          void Promise.all(workspaceIds.map(workspaceId =>
            window.electron.workspace.removeProjectFolder(workspaceId, projectPath).catch(() => null),
          )).then(async () => {
            const listProjects = window.electron.workspace.listProjects
            if (typeof listProjects !== 'function') return
            const next = await listProjects().catch(() => null)
            if (next) setProjects(next)
          })
        },
      },
    ]
  }, [projectEntries, sessions, setSessionArchived])

  const renderSessionRow = useCallback((session: DisplaySessionEntry) => {
    // Selection must be keyed by the concrete sidebar entry, not by the
    // provider session id. Some agents reuse session ids across mirrored rows,
    // which made multiple entries look selected at once.
    const isSelected = selectedSessionKey === getSessionSelectionKey(session)
    const isStreaming =
      (session.tileId ? streamingSnapshot.tileIds.has(session.tileId) : false)
      || streamingSnapshot.entryIds.has(session.id)
    const sessionMeta = formatSessionSidebarMeta(session)
    const sessionTitleKey = getSessionTitleGenerationKey(session.workspaceId, session.id)
    const titleGeneration = getSessionTitleGenerationIndicator(generatingSessionTitleIds[sessionTitleKey] === true, sessionMeta)
    const rowMeta = titleGeneration.rowMeta
    const isGeneratingTitle = generatingSessionTitleIds[sessionTitleKey] === true
    const hasUnreadUpdate = !isSelected && hasUnreadSessionUpdate(session, sessionReadWatermarks)
    const showActivityIndicator = isStreaming || isGeneratingTitle || hasUnreadUpdate
    const isPinned = pinnedSessionKeys[getSessionActivityKey(session)] === true
    const muted = session.isArchived === true && !isSelected
    const relativeTime = formatSessionSidebarRelativeTime(session.updatedAt)
    const scheduled = isCronSession(session)
    const canOpenMiniWindow = typeof session.tileId === 'string' && session.tileId.trim().length > 0

    return (
      <SessionSidebarRow
        key={session.id}
        label={formatSessionTitleForSidebar(session.title)}
        meta={rowMeta}
        leading={
          <button
            type="button"
            title={isPinned ? 'Unpin thread' : 'Pin thread'}
            aria-label={isPinned ? 'Unpin thread' : 'Pin thread'}
            onClick={e => {
              e.stopPropagation()
              toggleSessionPinned(session)
            }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: isPinned ? theme.text.secondary : theme.text.disabled,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <Pin size={15} strokeWidth={1.7} />
          </button>
        }
        leadingVisible={isPinned}
        trailing={
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: showActivityIndicator || scheduled ? 'flex-end' : 'flex-end',
            width: '100%',
            minWidth: 0,
          }}>
            {scheduled && (
              <Clock3 size={15} strokeWidth={1.7} />
            )}
            {showActivityIndicator ? (
              <SessionSidebarIndicator session={session} streaming={isStreaming || isGeneratingTitle} muted={muted} theme={theme} />
            ) : (
              <span style={{
                width: '100%',
                textAlign: 'right',
                fontSize: Math.max(11, fonts.secondarySize),
                fontWeight: 650,
                lineHeight: 1,
                color: muted ? theme.text.disabled : theme.text.disabled,
              }}>
                {relativeTime}
              </span>
            )}
          </span>
        }
        indent={Math.max(0, session.displayIndent)}
        indentUnit={6}
        extraWidth={getSessionRowExtraWidth(session.checkpointCount, canOpenMiniWindow)}
        title={`${session.title}${sessionMeta ? `\n${sessionMeta}` : ''}\n${session.sourceLabel}${session.messageCount > 0 ? ` · ${session.messageCount} msg` : ''}${(session.checkpointCount ?? 0) > 0 ? ` · ${session.checkpointCount} checkpoint${session.checkpointCount === 1 ? '' : 's'}` : ''}${session.isArchived ? ' · archived' : ''}${titleGeneration.rowTitleSuffix}`}
        active={isSelected}
        muted={muted}
        onClick={() => { openSessionFromSidebar(session) }}
        onDoubleClick={() => { openSessionFromSidebar(session, { persist: true }) }}
        onContextMenu={e => {
          e.preventDefault()
          setSessionCtx({ x: e.clientX, y: e.clientY, session })
        }}
        extra={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {(session.checkpointCount ?? 0) > 0 && (
              <>
                <div
                  title={`${session.checkpointCount} checkpoint${session.checkpointCount === 1 ? '' : 's'} available`}
                  style={{
                    minWidth: 18,
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 999,
                    border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                    background: theme.chat.assistantBubble,
                    color: theme.text.secondary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 600,
                    lineHeight: 1,
                    boxSizing: 'border-box',
                  }}
                >
                  {session.checkpointCount}
                </div>
                <button
                  title="Restore latest checkpoint"
                  onClick={e => {
                    e.stopPropagation()
                    const confirmed = window.confirm(`Restore the latest checkpoint for "${session.title}"?`)
                    if (!confirmed) return
                    void window.electron.canvas.listCheckpoints(session.workspaceId, session.id)
                      .then(checkpoints => {
                        const latest = checkpoints[0]
                        if (!latest) return null
                        return window.electron.canvas.restoreCheckpoint(session.workspaceId, latest.id, session.id)
                      })
                      .then(async result => {
                        if (!result?.ok) {
                          if (result?.error) window.alert(result.error)
                          return
                        }
                        const workspaceEntry = workspaceById.get(session.workspaceId)
                        if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
                        if (session.canOpenInChat !== false) await onOpenSessionInChat(session)
                      })
                      .catch(error => {
                        window.alert(error instanceof Error ? error.message : String(error))
                      })
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: 'none',
                    background: 'transparent',
                    color: theme.text.disabled,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                    <path d="M3.1 4.1V1.9m0 0h2.3m-2.3 0 2 2m1.9-1.1a4.8 4.8 0 1 1-2.7 8.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
            {canOpenMiniWindow && (
              <button
                title="Open mini window"
                aria-label={`Open mini window for ${session.title}`}
                onClick={e => {
                  e.stopPropagation()
                  openSessionMiniFromSidebar(session)
                }}
                style={{
                  width: SESSION_ACTION_BUTTON_SIZE,
                  height: SESSION_ACTION_BUTTON_SIZE,
                  borderRadius: 7,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Maximize2 size={SESSION_ACTION_ICON_SIZE} strokeWidth={1.7} />
              </button>
            )}
            <button
              title={getSessionArchiveActionLabel(session.isArchived === true)}
              onClick={e => {
                e.stopPropagation()
                handleArchiveSessionClick(session)
              }}
              disabled={archivingSessionId === session.id}
              style={{
                width: SESSION_ACTION_BUTTON_SIZE,
                height: SESSION_ACTION_BUTTON_SIZE,
                borderRadius: 7,
                border: 'none',
                background: session.isArchived === true ? theme.surface.hover : 'transparent',
                color: session.isArchived === true ? theme.text.secondary : theme.text.disabled,
                cursor: archivingSessionId === session.id ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: archivingSessionId === session.id ? 0.5 : 1,
                flexShrink: 0,
              }}
            >
              {session.isArchived === true ? (
                <ArchiveRestore size={SESSION_ACTION_ICON_SIZE} strokeWidth={1.7} />
              ) : (
                <Archive size={SESSION_ACTION_ICON_SIZE} strokeWidth={1.7} />
              )}
            </button>
          </div>
        }
      />
    )
  }, [
    activeChatSessionEntryId,
    activeChatSessionId,
    activeChatTileId,
    archivingSessionId,
    fonts.secondarySize,
    generatingSessionTitleIds,
    handleArchiveSessionClick,
    loadWorkspaceSessions,
    onOpenSessionInChat,
    openSessionFromSidebar,
    openSessionMiniFromSidebar,
    pinnedSessionKeys,
    selectedSessionKey,
    sessionReadWatermarks,
    streamingSnapshot.entryIds,
    streamingSnapshot.tileIds,
    theme,
    toggleSessionPinned,
    workspaceById,
  ])

  return {
    fonts,
    theme,
    widthRef,
    scrollRef,
    searchPaletteOpen,
    setSearchPaletteOpen,
    searchPaletteQuery,
    setSearchPaletteQuery,
    sessionCtx,
    setSessionCtx,
    projectCtx,
    setProjectCtx,
    sessions,
    setSessions,
    projects,
    setProjects,
    threadMenuOpen,
    setThreadMenuOpen,
    threadOrganizeMode,
    setThreadOrganizeMode,
    threadSortMode,
    setThreadSortMode,
    showArchivedSessions,
    setShowArchivedSessions,
    showCronSessions,
    setShowCronSessions,
    showSubagentSessions,
    setShowSubagentSessions,
    hiddenSessionAgents,
    setHiddenSessionAgents,
    collapsedThreadGroups,
    setCollapsedThreadGroups,
    projectSessionVisibleCounts,
    setProjectSessionVisibleCounts,
    loadedSessionWorkspaceIds,
    setLoadedSessionWorkspaceIds,
    hoveredProjectRow,
    setHoveredProjectRow,
    archivingSessionId,
    setArchivingSessionId,
    generatingSessionTitleIds,
    setGeneratingSessionTitleIds,
    visibleSessionCount,
    setVisibleSessionCount,
    sessionPromotions,
    setSessionPromotions,
    selectedSessionKey,
    setSelectedSessionKey,
    selectedProjectId,
    setSelectedProjectId,
    sessionReadWatermarks,
    setSessionReadWatermarks,
    pinnedSessionKeys,
    setPinnedSessionKeys,
    textDialog,
    setTextDialog,
    threadMenuRef,
    sessionLoadRequestSeqRef,
    latestSessionLoadTokenByWorkspaceRef,
    lastSessionLoadAtByWorkspaceRef,
    readSeededWorkspaceIdsRef,
    openSearchPalette,
    projectEntries,
    workspaceById,
    refreshProjects,
    activeProjectId,
    loadedSessionWorkspaceIdSet,
    scrollSessionsToTop,
    promoteSession,
    markSessionRead,
    streamingSnapshot,
    sentSnapshot,
    lastPromotedSeqRef,
    isThreadGroupCollapsed,
    allProjectThreadGroupsCollapsed,
    annotateSessions,
    loadWorkspaceSessions,
    promotedSessions,
    orderedProjectEntries,
    resizing,
    startX,
    startWidth,
    toggleThreadGroup,
    toggleAllThreadGroups,
    visibleSessions,
    toggleSessionPinned,
    pinnedVisibleSessions,
    normalVisibleSessions,
    availableSessionAgents,
    displayedSessions,
    displayedSessionGroups,
    filteredSessionGroups,
    hasMoreSessions,
    searchPaletteSessions,
    setSessionArchived,
    handleArchiveSessionClick,
    openSessionFromSidebar,
    openSessionMiniFromSidebar,
    sessionContextMenuItems,
    handleOpenProjectFromSidebar,
    projectContextMenuItems,
    renderSessionRow,
    PROJECT_SESSION_PREVIEW_COUNT,
    PROJECT_SESSION_SHOW_MORE_COUNT,
    SESSION_PAGE_SIZE,
  }
}
