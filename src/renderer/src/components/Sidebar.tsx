import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { Pin } from 'lucide-react'
import type { ProjectRecord, Workspace, TileState } from '../../../shared/types'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { SidebarFooter } from './sidebar/SidebarFooter'
import { SectionHeader, SidebarItem, SidebarMenuPortal, ThreadMenuItem, ThreadMenuSectionLabel } from './sidebar/ui'
import { buildNestedSessionList, deriveProjectsFromWorkspaces, getProjectDisplayLabel, getWorkspaceProjectPaths, isCronSession, isSubagentSession, normalizeSidebarPath, RESOURCE_ITEMS, SESSION_SOURCE_ICONS } from './sidebar/utils'
import { type ProjectListEntry, SESSION_PAGE_SIZE, type SessionEntry, type SessionProjectGroup, type ThreadOrganizeMode, type ThreadSortMode } from './sidebar/types'

interface ExtTileEntry { extId: string; type: string; label: string; icon?: string }
interface ExtensionEntrySummary { id: string; name: string }

interface Props {
  workspace: Workspace | null
  workspaces: Workspace[]
  tiles: TileState[]
  onSwitchWorkspace: (id: string) => void
  onDeleteWorkspace: (id: string) => void
  onNewWorkspace: (name: string) => void
  onOpenFolder: () => void
  onOpenFile: (filePath: string) => void
  onFocusTile: (tileId: string) => void
  onUpdateTile: (tileId: string, patch: Partial<TileState>) => void
  onCloseTile: (tileId: string) => void
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  onNewFiles: () => void
  onOpenSettings: (tab: string) => void
  onOpenSessionInChat: (session: SessionEntry) => void
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
  onScrollMetricsChange?: (metrics: { hasOverflow: boolean; topRatio: number; thumbRatio: number }) => void
  showFooter?: boolean
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({
  workspace, workspaces, tiles, onSwitchWorkspace: _onSwitchWorkspace, onDeleteWorkspace: _onDeleteWorkspace, onNewWorkspace: _onNewWorkspace, onOpenFolder, onOpenFile, onFocusTile, onUpdateTile: _onUpdateTile, onCloseTile: _onCloseTile,
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles, onOpenSettings,
  onOpenSessionInChat, onOpenSessionInApp,
  extensionTiles, extensionEntries, onAddExtensionTile, pinnedExtensionIds, onTogglePinnedExtension,
  collapsed, width, onWidthChange, minWidth = 270, maxWidth = 520, onResizeStateChange, onToggleCollapse: _onToggleCollapse, onScrollMetricsChange, showFooter = true
}: Props): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const widthRef = useRef(width)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  useEffect(() => { widthRef.current = width }, [width])
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<string, boolean>>({})
  const [extGroupsCollapsed, setExtGroupsCollapsed] = useState<Record<string, boolean>>({})
  const [extSearch, setExtSearch] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [sessionCtx, setSessionCtx] = useState<{ x: number; y: number; session: SessionEntry } | null>(null)
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const [threadOrganizeMode, setThreadOrganizeMode] = useState<ThreadOrganizeMode>('project')
  const [threadSortMode, setThreadSortMode] = useState<ThreadSortMode>('updated')
  const [showCronSessions, setShowCronSessions] = useState(false)
  const [showSubagentSessions, setShowSubagentSessions] = useState(false)
  const [collapsedThreadGroups, setCollapsedThreadGroups] = useState<Record<string, boolean>>({})
  const [loadedSessionWorkspaceIds, setLoadedSessionWorkspaceIds] = useState<string[]>([])
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_PAGE_SIZE)
  const deleteConfirmTimerRef = useRef<number | null>(null)
  const threadMenuRef = useRef<HTMLDivElement>(null)

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

  const activeProjectId = useMemo(() => {
    const primaryProjectPath = normalizeSidebarPath(workspace?.path)
    const currentPaths = new Set(getWorkspaceProjectPaths(workspace))
    const currentProject = projectEntries.find(project => normalizeSidebarPath(project.path) === primaryProjectPath)
      ?? projectEntries.find(project => currentPaths.has(normalizeSidebarPath(project.path)))
      ?? null
    return currentProject?.id ?? projectEntries[0]?.id ?? null
  }, [projectEntries, workspace])

  const loadedSessionWorkspaceIdSet = useMemo(() => new Set(loadedSessionWorkspaceIds), [loadedSessionWorkspaceIds])

  const isThreadGroupCollapsed = useCallback((group: SessionProjectGroup) => {
    const explicit = collapsedThreadGroups[group.key]
    if (typeof explicit === 'boolean') return explicit
    return group.projectId !== activeProjectId
  }, [collapsedThreadGroups, activeProjectId])

  useEffect(() => {
    return () => {
      if (deleteConfirmTimerRef.current) window.clearTimeout(deleteConfirmTimerRef.current)
    }
  }, [])

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
    const items = await window.electron.canvas.listSessions(workspaceEntry.id, forceRefresh).catch(() => [])
    const annotated = annotateSessions(workspaceEntry, items as Array<Omit<SessionEntry, 'workspaceId' | 'workspaceName' | 'workspacePath'>>)
    setSessions(prev => [...prev.filter(session => session.workspaceId !== workspaceEntry.id), ...annotated])
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
    const activeProject = activeProjectId
      ? (projectEntries.find(projectEntry => projectEntry.id === activeProjectId) ?? null)
      : null

    for (const workspaceId of activeProject?.workspaceIds ?? []) {
      workspaceIdsToLoad.add(workspaceId)
    }

    if (threadOrganizeMode === 'project') {
      for (const projectEntry of projectEntries) {
        const group: SessionProjectGroup = {
          projectId: projectEntry.id,
          projectPath: projectEntry.path,
          representativeWorkspaceId: projectEntry.representativeWorkspaceId,
          key: projectEntry.id,
          label: getProjectDisplayLabel(projectEntry),
          sessions: [],
        }
        if (!isThreadGroupCollapsed(group)) {
          for (const workspaceId of projectEntry.workspaceIds) {
            workspaceIdsToLoad.add(workspaceId)
          }
        }
      }
    }

    for (const workspaceId of workspaceIdsToLoad) {
      if (loadedSessionWorkspaceIdSet.has(workspaceId)) continue
      const workspaceEntry = workspaceById.get(workspaceId)
      if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry)
    }
  }, [
    activeProjectId,
    isThreadGroupCollapsed,
    loadWorkspaceSessions,
    loadedSessionWorkspaceIdSet,
    projectEntries,
    threadOrganizeMode,
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
      for (const workspaceId of loadedSessionWorkspaceIdSet) {
        const workspaceEntry = workspaceById.get(workspaceId)
        if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry, true)
      }
    }

    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [loadWorkspaceSessions, loadedSessionWorkspaceIdSet, workspaceById])

  const openTileIdSet = useMemo(() => new Set(tiles.map(tile => tile.id)), [tiles])

  const sessionContextMenuItems = useCallback((session: SessionEntry): MenuItem[] => {
    const items: MenuItem[] = []
    const hasOpenTile = Boolean(session.tileId && openTileIdSet.has(session.tileId))

    if (hasOpenTile) {
      items.push({ label: 'Focus Existing Chat', action: () => onFocusTile(session.tileId!) })
    }
    if (session.canOpenInChat !== false) {
      items.push({ label: hasOpenTile ? 'Open in New Chat' : 'Open in Chat', action: () => onOpenSessionInChat(session) })
    }
    if (session.canOpenInApp) {
      items.push({ label: `Open in ${session.sourceLabel}`, action: () => onOpenSessionInApp(session) })
    }
    if (session.filePath) {
      items.push({ label: 'Open Raw File', action: () => onOpenFile(session.filePath!) })
    }

    items.push({
      label: 'Rename Thread',
      action: () => {
        const nextTitle = window.prompt('Rename thread', session.title)?.trim()
        if (!nextTitle || nextTitle === session.title) return
        void window.electron.canvas.renameSession(session.workspaceId, session.id, nextTitle).then(result => {
          if (!result?.ok) return
          setSessions(prev => prev.map(entry => entry.id === session.id && entry.workspaceId === session.workspaceId
            ? { ...entry, title: nextTitle }
            : entry))
          const workspaceEntry = workspaceById.get(session.workspaceId)
          if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry, true)
        }).catch(() => {})
      },
    })

    return items.length > 0 ? items : [{ label: 'No actions available', action: () => {} }]
  }, [loadWorkspaceSessions, onFocusTile, onOpenFile, onOpenSessionInApp, onOpenSessionInChat, openTileIdSet, workspaceById])
  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const toggleSection = (key: string) => setSectionsCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  const toggleThreadGroup = useCallback((key: string) => {
    const projectEntry = projectEntries.find(entry => entry.id === key) ?? null
    const nextCollapsed = !(collapsedThreadGroups[key] ?? (key !== activeProjectId))
    setCollapsedThreadGroups(prev => ({ ...prev, [key]: nextCollapsed }))
    if (!nextCollapsed && projectEntry) {
      for (const workspaceId of projectEntry.workspaceIds) {
        const workspaceEntry = workspaceById.get(workspaceId)
        if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry)
      }
      // Switch to this project's workspace (also reopens the tab if it was closed).
      // Prefer the representative workspace (which tracks the currently-active one
      // when this project has it) so we don't flip to a different tab unnecessarily.
      const targetWsId = projectEntry.representativeWorkspaceId ?? projectEntry.workspaceIds[0]
      if (targetWsId && targetWsId !== workspace?.id) {
        _onSwitchWorkspace(targetWsId)
      }
    }
  }, [activeProjectId, collapsedThreadGroups, loadWorkspaceSessions, projectEntries, workspaceById, workspace?.id, _onSwitchWorkspace])

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

  const extensionInstances = useMemo(() => tiles.filter(t => t.type.startsWith('ext:')), [tiles])

  // Group extension tiles by type
  const extGroups = useMemo(() => {
    const groups: Record<string, TileState[]> = {}
    for (const t of extensionInstances) {
      if (!groups[t.type]) groups[t.type] = []
      groups[t.type].push(t)
    }
    return groups
  }, [extensionInstances])

  const extensionNameById = useMemo(() => {
    const entries = (extensionEntries ?? []).map(ext => [ext.id, ext.name] as const)
    return new Map(entries)
  }, [extensionEntries])

  const pinnedExtensionIdSet = useMemo(() => new Set(pinnedExtensionIds ?? []), [pinnedExtensionIds])

  const isPinnedExtensionEntry = useCallback((entry: ExtTileEntry) => {
    return pinnedExtensionIdSet.has(entry.extId) || pinnedExtensionIdSet.has(entry.type)
  }, [pinnedExtensionIdSet])

  const groupedExtensions = useMemo(() => {
    const groups = new Map<string, ExtTileEntry[]>()
    for (const ext of extensionTiles ?? []) {
      const existing = groups.get(ext.extId) ?? []
      existing.push(ext)
      groups.set(ext.extId, existing)
    }
    return [...groups.entries()]
      .map(([extId, items]) => ({
        extId,
        name: extensionNameById.get(extId) ?? extId.replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
        items: items.slice().sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [extensionTiles, extensionNameById])

  const filteredGroupedExtensions = useMemo(() => {
    const q = extSearch.trim().toLowerCase()
    if (!q) return groupedExtensions
    return groupedExtensions
      .map(group => {
        if (group.name.toLowerCase().includes(q)) return group
        const matchedItems = group.items.filter(item => item.label.toLowerCase().includes(q))
        if (matchedItems.length === 0) return null
        return { ...group, items: matchedItems }
      })
      .filter(Boolean) as typeof groupedExtensions
  }, [groupedExtensions, extSearch])

  const toggleExtGroup = useCallback((extId: string) => {
    setExtGroupsCollapsed(prev => ({ ...prev, [extId]: !prev[extId] }))
  }, [])

const visibleSessions = useMemo(() => {
    const deduped = new Map<string, SessionEntry>()
    for (const session of sessions) {
      const existing = deduped.get(session.id)
      if (!existing) {
        deduped.set(session.id, session)
        continue
      }
      if (existing.scope === 'user' && session.scope !== 'user') {
        deduped.set(session.id, session)
      }
    }

    const filtered = [...deduped.values()].filter(session => {
      const normalizedTitle = session.title?.trim().toLowerCase() ?? ''
      const hasContent = Boolean(session.title?.trim()) || Boolean(session.lastMessage?.trim()) || session.messageCount > 0
      if (!hasContent) return false
      if (normalizedTitle === 'new agent') return false
      if (!showCronSessions && isCronSession(session)) return false
      if (!showSubagentSessions && isSubagentSession(session)) return false
      if (threadOrganizeMode === 'project' && session.scope === 'user') return false
      return true
    })
    return buildNestedSessionList(filtered, threadSortMode)
  }, [sessions, showCronSessions, showSubagentSessions, threadOrganizeMode, threadSortMode])

  // Chronological mode uses a single flat list with one paginator.
  // Project mode paginates per-project (see projectVisibleCounts below).
  useEffect(() => {
    setVisibleSessionCount(SESSION_PAGE_SIZE)
  }, [workspace?.id, showCronSessions, showSubagentSessions, threadOrganizeMode, threadSortMode])

  const displayedSessions = useMemo(() => {
    if (threadOrganizeMode !== 'chronological') return visibleSessions
    return visibleSessions.slice(0, visibleSessionCount)
  }, [visibleSessions, visibleSessionCount, threadOrganizeMode])

  // Per-project pagination — each project keeps its own "show more" count.
  // Keyed by projectId; entries persist across refetches.
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({})
  const getProjectCount = useCallback((projectId: string): number => {
    return projectVisibleCounts[projectId] ?? SESSION_PAGE_SIZE
  }, [projectVisibleCounts])
  const bumpProjectCount = useCallback((projectId: string) => {
    setProjectVisibleCounts(prev => ({
      ...prev,
      [projectId]: (prev[projectId] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE,
    }))
  }, [])
  // Track full per-project counts so each group can render its own "More".
  const projectSessionTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const projectEntry of projectEntries) {
      const projectPath = normalizeSidebarPath(projectEntry.path)
      const workspaceIdSet = new Set(projectEntry.workspaceIds)
      totals[projectEntry.id] = visibleSessions.filter(session => {
        const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
        if (sessionProjectPath) return sessionProjectPath === projectPath
        return workspaceIdSet.has(session.workspaceId)
      }).length
    }
    return totals
  }, [visibleSessions, projectEntries])

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
    return projectEntries
      .map(projectEntry => {
        const projectPath = normalizeSidebarPath(projectEntry.path)
        const workspaceIdSet = new Set(projectEntry.workspaceIds)
        const allWorkspaceSessions = visibleSessions.filter(session => {
          const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
          if (sessionProjectPath) return sessionProjectPath === projectPath
          return workspaceIdSet.has(session.workspaceId)
        })
        const count = getProjectCount(projectEntry.id)
        return {
          projectId: projectEntry.id,
          projectPath: projectEntry.path,
          representativeWorkspaceId: projectEntry.representativeWorkspaceId,
          key: projectEntry.id,
          label: getProjectDisplayLabel(projectEntry),
          sessions: allWorkspaceSessions.slice(0, count),
        }
      })
  }, [visibleSessions, displayedSessions, projectEntries, threadOrganizeMode, getProjectCount])

  const filteredSessionGroups = useMemo(() => {
    const q = projectSearch.trim().toLowerCase()
    if (!q) return displayedSessionGroups
    return displayedSessionGroups
      .map(group => {
        const labelMatch = group.label.toLowerCase().includes(q)
        const matchedSessions = group.sessions.filter(s => s.title.toLowerCase().includes(q))
        if (labelMatch) return group
        if (matchedSessions.length === 0) return null
        return { ...group, sessions: matchedSessions }
      })
      .filter(Boolean) as typeof displayedSessionGroups
  }, [displayedSessionGroups, projectSearch])

  const hasMoreSessions = threadOrganizeMode === 'chronological'
    ? displayedSessions.length < visibleSessions.length
    : false

  const armDeleteSession = useCallback((sessionId: string) => {
    if (deleteConfirmTimerRef.current) window.clearTimeout(deleteConfirmTimerRef.current)
    setPendingDeleteSessionId(sessionId)
    deleteConfirmTimerRef.current = window.setTimeout(() => {
      setPendingDeleteSessionId(current => current === sessionId ? null : current)
      deleteConfirmTimerRef.current = null
    }, 4000)
  }, [])

  const deleteSession = useCallback(async (session: SessionEntry) => {
    if (!session.workspaceId || deletingSessionId) return
    setDeletingSessionId(session.id)
    try {
      const result = await window.electron.canvas.deleteSession(session.workspaceId, session.id)
      if (result?.ok) {
        setSessions(prev => prev.filter(entry => entry.id !== session.id))
      }
    } finally {
      setDeletingSessionId(null)
      setPendingDeleteSessionId(current => current === session.id ? null : current)
      if (deleteConfirmTimerRef.current) {
        window.clearTimeout(deleteConfirmTimerRef.current)
        deleteConfirmTimerRef.current = null
      }
    }
  }, [deletingSessionId])

  const handleOpenProjectFromSidebar = useCallback(() => {
    onOpenFolder()
    setThreadMenuOpen(false)
  }, [onOpenFolder])

  const emitScrollMetrics = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      onScrollMetricsChange?.({ hasOverflow: false, topRatio: 0, thumbRatio: 1 })
      return
    }

    const { scrollTop, scrollHeight, clientHeight } = el
    const maxScroll = Math.max(0, scrollHeight - clientHeight)
    const hasOverflow = maxScroll > 1
    const topRatio = hasOverflow ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0
    const thumbRatio = hasOverflow ? Math.min(1, Math.max(0.14, clientHeight / scrollHeight)) : 1

    onScrollMetricsChange?.({ hasOverflow, topRatio, thumbRatio })
  }, [onScrollMetricsChange])

  useEffect(() => {
    emitScrollMetrics()
  }, [emitScrollMetrics, sessions.length, visibleSessions.length, displayedSessions.length, tiles.length, extensionTiles?.length, groupedExtensions.length])

  useEffect(() => {
    const scrollEl = scrollRef.current
    const contentEl = scrollContentRef.current
    if (!scrollEl) return

    emitScrollMetrics()
    const handleScroll = () => emitScrollMetrics()
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })

    const observer = new ResizeObserver(() => emitScrollMetrics())
    observer.observe(scrollEl)
    if (contentEl) observer.observe(contentEl)

    return () => {
      scrollEl.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }
  }, [emitScrollMetrics])

  return (
    <div style={{
      width: collapsed ? 0 : Math.max(width, minWidth),
      minWidth: collapsed ? 0 : minWidth,
      height: '100%',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      transition: 'width 0.15s ease',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      fontFamily: fonts.primary,
      fontSize: fonts.size,
      fontWeight: fonts.weight,
      lineHeight: fonts.lineHeight,
    }}>
      {/* Scrollable sections */}
      <div
        ref={scrollRef}
        className="sidebar-scroll-container"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 6, scrollbarWidth: 'none', msOverflowStyle: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div ref={scrollContentRef} style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>

        {/* ── PINNED EXTENSIONS ── */}
        {pinnedExtensionIds && pinnedExtensionIds.length > 0 && (() => {
          const pinned = (extensionTiles ?? []).filter(isPinnedExtensionEntry)
          if (pinned.length === 0) return null
          return (
            <>
              <SectionHeader label="Extensions" collapsed={!!sectionsCollapsed.extensions} onToggle={() => toggleSection('extensions')} />
              {!sectionsCollapsed.extensions && (
                <div style={{ paddingBottom: 6 }}>
                  {pinned.map(ext => (
                    <SidebarItem
                      key={ext.type}
                      label={ext.label}
                      icon={<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1 1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1 1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1 1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>}
                      onClick={() => onAddExtensionTile?.(ext.type)}
                    />
                  ))}
                </div>
              )}
            </>
          )
        })()}

        <div style={{ padding: '8px 12px 10px', fontSize: fonts.secondarySize, fontWeight: fonts.secondaryWeight, lineHeight: fonts.secondaryLineHeight }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{
              fontSize: fonts.secondarySize - 2,
              fontWeight: 700,
              color: theme.text.disabled,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}>
              Projects
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }} ref={threadMenuRef}>
              <button
                title="Filter and sort projects and threads"
                aria-label="Filter and sort projects and threads"
                onClick={() => setThreadMenuOpen(open => !open)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: threadMenuOpen ? theme.surface.hover : 'transparent',
                  color: threadMenuOpen ? theme.text.secondary : theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: threadMenuOpen || showCronSessions || showSubagentSessions || threadOrganizeMode !== 'project' || threadSortMode !== 'updated' ? 1 : 0.8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <button
                title="Open project folder"
                aria-label="Open project folder"
                onClick={handleOpenProjectFromSidebar}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.85,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
              >
                <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                  <path d="M2.75 5.25c0-1.1.9-2 2-2h2.9l1.6 1.6h4.05c1.1 0 2 .9 2 2v5.95c0 1.1-.9 2-2 2H4.75c-1.1 0-2-.9-2-2v-7.55Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M13.5 2.75v4M11.5 4.75h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              </button>
              {threadMenuOpen && (
                <SidebarMenuPortal anchorRef={threadMenuRef}>
                  <div style={{
                    width: 292,
                    background: theme.surface.panelElevated,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 14,
                    boxShadow: theme.shadow.panel,
                    padding: 8,
                  }}>
                  <ThreadMenuSectionLabel>Organize</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 5c0-.83.67-1.5 1.5-1.5h2.5l1.4 1.4H12c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>}
                    label="By project"
                    active={threadOrganizeMode === 'project'}
                    onClick={() => setThreadOrganizeMode('project')}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.1" stroke="currentColor" strokeWidth="1.25" /><path d="M8 5.2v3.3l2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Chronological list"
                    active={threadOrganizeMode === 'chronological'}
                    onClick={() => setThreadOrganizeMode('chronological')}
                  />
                  <div style={{ height: 1, background: theme.border.default, margin: '8px 4px' }} />
                  <ThreadMenuSectionLabel>Sort by</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 12.5V6.2M3.5 6.2l-1.8 1.8M3.5 6.2 5.3 8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /><rect x="7" y="3.25" width="6" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /><rect x="7" y="7" width="4.5" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /><rect x="7" y="10.75" width="3" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /></svg>}
                    label="Updated"
                    active={threadSortMode === 'updated'}
                    onClick={() => setThreadSortMode('updated')}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 4h9M5.5 7h5M6.5 10h4M7.5 13h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>}
                    label="Title"
                    active={threadSortMode === 'title'}
                    onClick={() => setThreadSortMode('title')}
                  />
                  <div style={{ height: 1, background: theme.border.default, margin: '8px 4px' }} />
                  <ThreadMenuSectionLabel>Show</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 5.1h10M3 10.9h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /><path d="M4.3 5.1v2.2c0 .92.75 1.67 1.67 1.67h1.06c.92 0 1.67.75 1.67 1.67v1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Sub-threads"
                    active={showSubagentSessions}
                    onClick={() => setShowSubagentSessions(value => !value)}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.1" stroke="currentColor" strokeWidth="1.25" /><path d="M8 5.2v3.3l2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Cron jobs"
                    active={showCronSessions}
                    onClick={() => setShowCronSessions(value => !value)}
                  />
                  </div>
                </SidebarMenuPortal>
              )}
            </div>
          </div>

          {/* Project/thread search filter */}
          {displayedSessionGroups.length > 0 && (
            <div style={{ padding: '0 0 6px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                borderRadius: 6,
                background: theme.surface.hover,
                border: `1px solid ${theme.border.subtle}`,
              }}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
                  <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  placeholder="Filter projects and threads..."
                  value={projectSearch}
                  onChange={e => setProjectSearch(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: theme.text.primary,
                    fontSize: fonts.secondarySize,
                    fontFamily: 'inherit',
                    padding: 0,
                    minWidth: 0,
                  }}
                />
                {projectSearch && (
                  <button
                    type="button"
                    onClick={() => setProjectSearch('')}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}

          {threadOrganizeMode === 'chronological' && visibleSessions.length === 0 ? (
            <div style={{ padding: '4px 0', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No threads yet</div>
          ) : (
            <>
              {filteredSessionGroups.map(group => (
                <div key={group.key} style={{ paddingBottom: 8 }}>
                  {threadOrganizeMode === 'project' && (
                    <button
                      type="button"
                      onClick={() => toggleThreadGroup(group.key)}
                      title={`${isThreadGroupCollapsed(group) ? 'Expand' : 'Collapse'} ${group.label}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        padding: '6px 0 8px',
                        color: group.projectId === activeProjectId ? theme.text.primary : theme.text.secondary,
                        background: 'transparent',
                        border: 'none',
                        textAlign: 'left',
                        cursor: 'pointer',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 10,
                          color: theme.text.disabled,
                          flexShrink: 0,
                        }}
                      >
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 8 8"
                          style={{
                            transition: 'transform 0.15s ease',
                            transform: isThreadGroupCollapsed(group) ? 'rotate(0deg)' : 'rotate(90deg)',
                          }}
                        >
                          <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', color: theme.text.disabled }}>
                        <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
                          <path d="M1.8 4.1c0-.9.7-1.6 1.6-1.6h2l1.1 1.2h4.1c.9 0 1.6.7 1.6 1.6v4.4c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6V4.1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span style={{ fontSize: fonts.size + 1, fontWeight: 600, color: theme.text.secondary }}>
                        {group.label}
                      </span>
                    </button>
                  )}

                  {(threadOrganizeMode !== 'project' || !isThreadGroupCollapsed(group)) && group.sessions.map(session => (
                    <SidebarItem
                      key={session.id}
                      label={session.title.length > 44 ? `${session.title.slice(0, 44)}...` : session.title}
                      icon={SESSION_SOURCE_ICONS[session.source]}
                      indent={Math.max(1, session.displayIndent + 1)}
                      extraWidth={24}
                      title={`${session.title}\n${session.sourceLabel}${session.messageCount > 0 ? ` · ${session.messageCount} msg` : ''}`}
                      onClick={() => {
                        if (session.tileId && openTileIdSet.has(session.tileId)) {
                          onFocusTile(session.tileId)
                          return
                        }
                        onOpenSessionInChat(session)
                      }}
                      onContextMenu={e => {
                        e.preventDefault()
                        setSessionCtx({ x: e.clientX, y: e.clientY, session })
                      }}
                      extra={
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <button
                            title={pendingDeleteSessionId === session.id ? 'Click again to confirm delete' : 'Delete session'}
                            onClick={e => {
                              e.stopPropagation()
                              if (pendingDeleteSessionId === session.id) {
                                void deleteSession(session)
                                return
                              }
                              armDeleteSession(session.id)
                            }}
                            disabled={deletingSessionId === session.id}
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: 4,
                              border: 'none',
                              background: pendingDeleteSessionId === session.id ? theme.status.danger : 'transparent',
                              color: pendingDeleteSessionId === session.id ? '#fff' : theme.text.disabled,
                              cursor: deletingSessionId === session.id ? 'default' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              opacity: deletingSessionId === session.id ? 0.5 : 1,
                            }}
                          >
                            {pendingDeleteSessionId === session.id ? (
                              <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                                <path d="M3 7.2 5.6 9.8 11 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : (
                              <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                                <path d="M3.5 4.5h7M5 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1M4.3 4.5l.4 6.1c0 .5.4.9.9.9h2.8c.5 0 .9-.4.9-.9l.4-6.1M6 6.2v3.2M8 6.2v3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </button>
                        </div>
                      }
                    />
                  ))}

                  {threadOrganizeMode === 'project' && !isThreadGroupCollapsed(group) && group.sessions.length === 0 && (
                    <div
                      style={{
                        padding: '0 0 2px 36px',
                        fontSize: fonts.secondarySize,
                        color: theme.text.disabled,
                      }}
                    >
                      No threads yet
                    </div>
                  )}

                  {/* Per-project "show more". Only renders when this specific
                      project has more threads than currently displayed. */}
                  {threadOrganizeMode === 'project'
                    && !isThreadGroupCollapsed(group)
                    && (projectSessionTotals[group.projectId] ?? 0) > group.sessions.length && (
                    <button
                      type="button"
                      onClick={() => bumpProjectCount(group.projectId)}
                      style={{
                        marginLeft: 36,
                        marginTop: 2,
                        padding: '2px 6px',
                        border: 'none',
                        background: 'transparent',
                        color: theme.text.disabled,
                        cursor: 'pointer',
                        fontSize: fonts.secondarySize,
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        alignSelf: 'flex-start',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                      onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                    >
                      More ({(projectSessionTotals[group.projectId] ?? 0) - group.sessions.length})
                    </button>
                  )}
                </div>
              ))}

              {filteredSessionGroups.length === 0 && projectSearch && (
                <div style={{ padding: '4px 0', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No matching projects or threads</div>
              )}
              {hasMoreSessions && (
                <div style={{ padding: '2px 0 0', textAlign: 'center' }}>
                  <button
                    onClick={() => setVisibleSessionCount(count => count + SESSION_PAGE_SIZE)}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      fontSize: fonts.secondarySize,
                      fontFamily: 'inherit',
                      textAlign: 'center',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                    onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                  >
                    More ({visibleSessions.length - displayedSessions.length})
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── EXTENSIONS ── (hidden when extensionTiles is empty and no instances) */}
        {(extensionInstances.length > 0 || (extensionTiles && extensionTiles.length > 0)) && (
          <>
            <SectionHeader label="Extensions" collapsed={!!sectionsCollapsed.extensions} onToggle={() => toggleSection('extensions')} />
            {!sectionsCollapsed.extensions && (
              <div style={{ paddingBottom: 6 }}>
                {/* Search filter */}
                {(groupedExtensions.length > 3) && (
                  <div style={{ padding: '2px 8px 4px', margin: '0 6px' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: theme.surface.hover,
                      border: `1px solid ${theme.border.subtle}`,
                    }}>
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
                        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                      <input
                        type="text"
                        placeholder="Filter extensions..."
                        value={extSearch}
                        onChange={e => setExtSearch(e.target.value)}
                        style={{
                          flex: 1,
                          background: 'transparent',
                          border: 'none',
                          outline: 'none',
                          color: theme.text.primary,
                          fontSize: fonts.secondarySize,
                          fontFamily: 'inherit',
                          padding: 0,
                          minWidth: 0,
                        }}
                      />
                      {extSearch && (
                        <button
                          type="button"
                          onClick={() => setExtSearch('')}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: theme.text.disabled,
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center',
                            flexShrink: 0,
                          }}
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {/* Installed extensions with instances */}
                {filteredGroupedExtensions.map(group => {
                  const multiBlock = group.items.length > 1
                  const groupPinned = pinnedExtensionIdSet.has(group.extId)
                  const groupCollapsed = !!extGroupsCollapsed[group.extId] && !extSearch
                  if (!multiBlock) {
                    const ext = group.items[0]
                    const instances = extGroups[ext.type] ?? []
                    const blockPinned = isPinnedExtensionEntry(ext)
                    return (
                      <React.Fragment key={ext.type}>
                        <SidebarItem
                          label={ext.label}
                          muted={instances.length === 0}
                          icon={<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>}
                          onClick={() => instances[0] ? onFocusTile(instances[0].id) : onAddExtensionTile?.(ext.type)}
                          extra={(
                            <button
                              type="button"
                              title={blockPinned ? 'Unpin from canvas menu' : 'Pin to canvas menu'}
                              onClick={e => {
                                e.stopPropagation()
                                onTogglePinnedExtension?.(ext.type)
                              }}
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 5,
                                border: 'none',
                                background: blockPinned ? theme.surface.accentSoft : 'transparent',
                                color: blockPinned ? theme.accent.base : theme.text.disabled,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 0,
                                flexShrink: 0,
                              }}
                            >
                              <Pin size={12} />
                            </button>
                          )}
                          extraAlwaysVisible={blockPinned}
                        />
                        {instances.length > 1 && instances.map(tile => (
                          <SidebarItem
                            key={tile.id}
                            label={`Instance ${tile.id.split('-').pop()}`}
                            muted
                            indent={1}
                            onClick={() => onFocusTile(tile.id)}
                          />
                        ))}
                      </React.Fragment>
                    )
                  }

                  return (
                    <React.Fragment key={group.extId}>
                      <div
                        onClick={() => toggleExtGroup(group.extId)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          padding: '6px 8px 4px 12px',
                          margin: '0 6px',
                          cursor: 'pointer',
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                          borderRadius: 6,
                        }}
                      >
                        <svg
                          width="8" height="8" viewBox="0 0 8 8"
                          style={{ transition: 'transform 0.15s ease', transform: groupCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', opacity: 0.4, flexShrink: 0 }}
                        >
                          <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span style={{ color: theme.text.muted, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                          <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>
                        </span>
                        <span style={{
                          fontSize: fonts.secondarySize - 2,
                          fontWeight: 700,
                          color: theme.text.disabled,
                          letterSpacing: 1.2,
                          textTransform: 'uppercase',
                          flex: 1,
                          minWidth: 0,
                        }}>
                          {group.name}
                        </span>
                        <button
                          type="button"
                          title={groupPinned ? 'Unpin all blocks from canvas menu' : 'Pin all blocks to canvas menu'}
                          onClick={e => {
                            e.stopPropagation()
                            onTogglePinnedExtension?.(group.extId)
                          }}
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 5,
                            border: 'none',
                            background: groupPinned ? theme.surface.accentSoft : 'transparent',
                            color: groupPinned ? theme.accent.base : theme.text.disabled,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                            flexShrink: 0,
                          }}
                        >
                          <Pin size={12} />
                        </button>
                      </div>
                      {!groupCollapsed && group.items.map(ext => {
                        const instances = extGroups[ext.type] ?? []
                        const explicitBlockPinned = pinnedExtensionIdSet.has(ext.type)
                        const blockPinned = groupPinned || explicitBlockPinned
                        return (
                          <React.Fragment key={ext.type}>
                            <SidebarItem
                              label={ext.label}
                              muted={instances.length === 0}
                              indent={1}
                              icon={<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>}
                              onClick={() => instances[0] ? onFocusTile(instances[0].id) : onAddExtensionTile?.(ext.type)}
                              extra={(
                                <button
                                  type="button"
                                  title={
                                    groupPinned && !explicitBlockPinned
                                      ? 'Pinned via extension'
                                      : blockPinned
                                        ? 'Unpin this block from canvas menu'
                                        : 'Pin this block to canvas menu'
                                  }
                                  onClick={e => {
                                    e.stopPropagation()
                                    if (groupPinned && !explicitBlockPinned) return
                                    onTogglePinnedExtension?.(ext.type)
                                  }}
                                  style={{
                                    width: 20,
                                    height: 20,
                                    borderRadius: 5,
                                    border: 'none',
                                    background: blockPinned ? theme.surface.accentSoft : 'transparent',
                                    color: blockPinned ? theme.accent.base : theme.text.disabled,
                                    cursor: groupPinned && !explicitBlockPinned ? 'default' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: 0,
                                    flexShrink: 0,
                                  }}
                                >
                                  <Pin size={12} />
                                </button>
                              )}
                              extraAlwaysVisible={blockPinned}
                            />
                            {instances.length > 1 && instances.map(tile => (
                              <SidebarItem
                                key={tile.id}
                                label={`Instance ${tile.id.split('-').pop()}`}
                                muted
                                indent={2}
                                onClick={() => onFocusTile(tile.id)}
                              />
                            ))}
                          </React.Fragment>
                        )
                      })}
                    </React.Fragment>
                  )
                })}
                {filteredGroupedExtensions.length === 0 && extSearch && (
                  <div style={{ padding: '4px 12px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No matching extensions</div>
                )}
                {extensionInstances.length === 0 && !extensionTiles?.length && (
                  <div style={{ padding: '4px 12px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No extensions</div>
                )}
              </div>
            )}
          </>
        )}
        </div>
      </div>

      {/* Static footer list — resources (Prompts / Skills / Tools / Agents)
          live between the scrollable projects panel and the icon toolbar. */}
      <div
        style={{
          padding: '6px 0 4px',
          borderTop: `1px solid ${theme.border.subtle}`,
          flexShrink: 0,
        }}
      >
        {RESOURCE_ITEMS.map(item => (
          <SidebarItem
            key={item.id}
            label={item.label}
            icon={item.icon}
            onClick={() => onOpenSettings(item.id)}
          />
        ))}
      </div>

      {showFooter && (
        <SidebarFooter
          onNewTerminal={onNewTerminal} onNewKanban={onNewKanban} onNewBrowser={onNewBrowser}
          onNewChat={onNewChat} onNewFiles={onNewFiles}
          onOpenSettings={onOpenSettings}
          extensionTiles={extensionTiles} onAddExtensionTile={onAddExtensionTile}
        />
      )}

      {sessionCtx && (
        <ContextMenu x={sessionCtx.x} y={sessionCtx.y} items={sessionContextMenuItems(sessionCtx.session)} onClose={() => setSessionCtx(null)} />
      )}

      {/* Resize handle */}
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 3, cursor: 'col-resize' }}
        onMouseDown={e => { resizing.current = true; startX.current = e.clientX; startWidth.current = widthRef.current; onResizeStateChange?.(true); e.preventDefault() }}
        onMouseEnter={e => (e.currentTarget.style.background = theme.accent.soft)}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      />
    </div>
  )
}

export { SidebarFooter } from './sidebar/SidebarFooter'
