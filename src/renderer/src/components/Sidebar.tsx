import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Pin, Settings } from 'lucide-react'
import type { Workspace, TileState, ProjectRecord } from '../../../shared/types'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { basename } from '../utils/dnd'
import { ContextMenu, type MenuItem } from './ContextMenu'

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

interface ProjectListEntry extends ProjectRecord {
  workspaceIds: string[]
  representativeWorkspaceId: string | null
}

// ─── Section header ──────────────────────────────────────────────────────────

function SectionHeader({ label, collapsed, onToggle, extra }: { label: string; collapsed: boolean; onToggle: () => void; extra?: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        padding: '6px 12px 4px',
        cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <svg
          width="8" height="8" viewBox="0 0 8 8"
          style={{ transition: 'transform 0.15s ease', transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', opacity: 0.5, flexShrink: 0 }}
        >
          <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{
          fontSize: fonts.secondarySize - 2, fontWeight: 700, color: theme.text.disabled,
          letterSpacing: 1.2, textTransform: 'uppercase',
        }}>
          {label}
        </span>
      </div>
      {extra && <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>{extra}</div>}
    </div>
  )
}

function ThreadMenuSectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{
      padding: '6px 12px 4px',
      fontSize: Math.max(11, fonts.secondarySize + 1),
      fontWeight: 500,
      color: theme.text.disabled,
      userSelect: 'none',
      WebkitUserSelect: 'none',
    }}>
      {children}
    </div>
  )
}

function ThreadMenuItem({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        border: 'none',
        background: hovered ? theme.surface.hover : 'transparent',
        color: active ? theme.text.primary : theme.text.secondary,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        borderRadius: 8,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        fontFamily: fonts.primary,
        fontSize: Math.max(fonts.size, 14),
        lineHeight: 1.2,
        textAlign: 'left',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, color: theme.text.muted, flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ width: 14, color: theme.text.secondary, opacity: active ? 1 : 0, flexShrink: 0 }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 7.3 5.7 10 11 4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  )
}

function SidebarMenuPortal({
  anchorRef,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}): JSX.Element | null {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) {
        setPosition(null)
        return
      }
      const rect = anchor.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef])

  if (!position) return null

  return createPortal(
    <div
      data-sidebar-menu-portal="true"
      style={{
        position: 'fixed',
        top: position.top,
        right: position.right,
        zIndex: 4000,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

// ─── Sidebar item ────────────────────────────────────────────────────────────

function SidebarItem({ label, icon, active, muted, onClick, onContextMenu, indent = 0, extra, extraAlwaysVisible = false, extraWidth }: {
  label: string
  icon?: React.ReactNode
  active?: boolean
  muted?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  indent?: number
  extra?: React.ReactNode
  extraAlwaysVisible?: boolean
  extraWidth?: number
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 12 + indent * 14,
        paddingRight: extra && (hovered || extraAlwaysVisible) ? 8 + (extraWidth ?? 20) : 8,
        minHeight: 30,
        cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none',
        borderRadius: 6, margin: '0 6px',
        background: active ? theme.surface.selection : hovered ? theme.surface.hover : 'transparent',
        transition: 'background 0.1s ease',
        position: 'relative',
      }}
    >
      {icon && <span style={{ color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.muted, flexShrink: 0, display: 'flex', alignItems: 'center' }}>{icon}</span>}
      <span style={{
        fontSize: fonts.size, fontWeight: active ? 500 : 400,
        lineHeight: 1.2,
        color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.secondary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {label}
      </span>
      {extra && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: extraWidth,
          minWidth: 20,
          minHeight: 20,
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: hovered || extraAlwaysVisible ? 1 : 0,
          visibility: hovered || extraAlwaysVisible ? 'visible' : 'hidden',
          pointerEvents: hovered || extraAlwaysVisible ? 'auto' : 'none',
          transition: 'opacity 0.1s ease',
        }}>
          {extra}
        </span>
      )}
    </div>
  )
}

// ─── Tile type icons (16px) ──────────────────────────────────────────────────

const TILE_ICONS: Record<string, JSX.Element> = {
  terminal: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M7 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>,
  code: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M5 3L1 7l4 4M9 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  note: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>,
  browser: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M1 5h12" stroke="currentColor" strokeWidth="1.2" /></svg>,
  chat: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 2h10a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 2.5V10H2a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  files: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1 3C1 2.17 1.67 1.5 2.5 1.5H5L6.5 3H11.5C12.33 3 13 3.67 13 4.5V11C13 11.83 12.33 12.5 11.5 12.5H2.5C1.67 12.5 1 11.83 1 11V3Z" stroke="currentColor" strokeWidth="1.2" /></svg>,
  kanban: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /></svg>,
  image: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="5" cy="5" r="1.2" stroke="currentColor" strokeWidth="1" /><path d="M1.5 10l3-3 2 2 2.5-3 3.5 4" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /></svg>,
}

const RESOURCE_ITEMS = [
  { id: 'prompts', label: 'Prompts', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3 2h8a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" /><path d="M4 5h6M4 7.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg> },
  { id: 'skills', label: 'Skills', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.8 3.6L13 5.2l-3 2.9.7 4.1L7 10.3 3.3 12.2l.7-4.1-3-2.9 4.2-.6L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg> },
  { id: 'tools', label: 'Tools', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M8.5 2.5a3 3 0 00-4.2 4.2L2 9l1 2 2 1 2.3-2.3a3 3 0 004.2-4.2L9.5 7.5 8 7l-.5-1.5L9.5 3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg> },
  { id: 'agents', label: 'Agents', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 12.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg> },
]

const SESSION_SOURCE_ICONS: Record<string, JSX.Element> = {
  codesurf: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.2" /><path d="M4 4.5h6M4 7h6M4 9.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>,
  claude: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3 7c0-2.2 1.8-4 4-4 1.5 0 2.8.8 3.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M11 7c0 2.2-1.8 4-4 4-1.5 0-2.8-.8-3.5-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="7" cy="7" r="1" fill="currentColor" /></svg>,
  codex: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M5 2.5 1.8 7 5 11.5M9 2.5 12.2 7 9 11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.3 12 7.7 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>,
  cursor: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3 3h8v8H3z" stroke="currentColor" strokeWidth="1.2" /><path d="M5 5h4v4H5z" stroke="currentColor" strokeWidth="1.2" opacity="0.55" /></svg>,
  openclaw: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3 5c0-1.4 1-2.5 2.2-2.5.7 0 1 .4 1.8.4s1.1-.4 1.8-.4C10 2.5 11 3.6 11 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M2.5 7.5c0 1.7 1.4 3 3 3h3c1.6 0 3-1.3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="5" cy="7" r=".8" fill="currentColor" /><circle cx="9" cy="7" r=".8" fill="currentColor" /></svg>,
  opencode: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 9.5 7 4.5l2.5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
}

interface SessionEntry {
  workspaceId: string
  workspaceName: string
  workspacePath: string
  id: string
  source: 'codesurf' | 'claude' | 'codex' | 'cursor' | 'openclaw' | 'opencode'
  scope: 'workspace' | 'project' | 'user'
  tileId: string | null
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  lastMessage: string | null
  updatedAt: number
  filePath?: string
  title: string
  projectPath?: string | null
  sourceLabel: string
  sourceDetail?: string
  canOpenInChat?: boolean
  canOpenInApp?: boolean
  resumeBin?: string
  resumeArgs?: string[]
  relatedGroupId?: string | null
  nestingLevel?: number
}

interface DisplaySessionEntry extends SessionEntry {
  displayIndent: number
}

interface SessionProjectGroup {
  projectId: string
  projectPath: string
  representativeWorkspaceId: string | null
  key: string
  label: string
  sessions: DisplaySessionEntry[]
}

type ThreadOrganizeMode = 'project' | 'chronological'
type ThreadSortMode = 'updated' | 'title'

const SESSION_PAGE_SIZE = 10

function sessionMetaText(session: SessionEntry): string {
  return `${session.title} ${session.sourceLabel} ${session.sourceDetail ?? ''}`.toLowerCase()
}

function normalizeSidebarPath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function getProjectDisplayLabel(project: Pick<ProjectRecord, 'name' | 'path'>): string {
  const normalizedPath = normalizeSidebarPath(project.path)
  const pathLabel = basename(normalizedPath)
  const nameLabel = project.name?.trim() || ''
  const looksGenerated = /^ws-\d{6,}$/.test(pathLabel)
  if (pathLabel && !looksGenerated) return pathLabel
  return nameLabel || pathLabel || 'Project'
}

function getWorkspaceProjectPaths(workspaceEntry: Workspace | null | undefined): string[] {
  if (!workspaceEntry) return []
  const seen = new Set<string>()
  const paths = [
    workspaceEntry.path,
    ...(workspaceEntry.projectPaths ?? []),
  ]

  for (const candidate of paths) {
    const normalized = normalizeSidebarPath(candidate)
    if (normalized) seen.add(normalized)
  }

  return [...seen]
}

function isCronSession(session: SessionEntry): boolean {
  const meta = sessionMetaText(session)
  return meta.includes('scheduled task') || meta.includes('cron')
}

function isSubagentSession(session: SessionEntry): boolean {
  if ((session.nestingLevel ?? 0) > 0) return true
  return sessionMetaText(session).includes('subagent')
}

function compareSessions(a: SessionEntry, b: SessionEntry, sortMode: ThreadSortMode): number {
  if (sortMode === 'title') {
    const titleCompare = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    if (titleCompare !== 0) return titleCompare
    return b.updatedAt - a.updatedAt
  }
  return b.updatedAt - a.updatedAt
}

function buildNestedSessionList(sessions: SessionEntry[], sortMode: ThreadSortMode): DisplaySessionEntry[] {
  type SessionNode = {
    session: SessionEntry
    children: SessionNode[]
    parentId: string | null
    subtreeUpdatedAt: number
  }

  const sorted = [...sessions].sort((a, b) => compareSessions(a, b, sortMode))
  const nodes = new Map<string, SessionNode>(sorted.map(session => [session.id, {
    session,
    children: [],
    parentId: null,
    subtreeUpdatedAt: session.updatedAt,
  } satisfies SessionNode] as const))
  const byGroup = new Map<string, SessionEntry[]>()

  for (const session of sorted) {
    if (!session.relatedGroupId) continue
    const group = byGroup.get(session.relatedGroupId) ?? []
    group.push(session)
    byGroup.set(session.relatedGroupId, group)
  }

  const chooseParent = (session: SessionEntry): SessionEntry | null => {
    const groupId = session.relatedGroupId
    const level = session.nestingLevel ?? 0
    if (!groupId || level <= 0) return null

    const candidates = (byGroup.get(groupId) ?? []).filter(candidate => {
      if (candidate.id === session.id) return false
      return (candidate.nestingLevel ?? 0) < level
    })
    if (candidates.length === 0) return null

    const preferredLevel = level - 1
    const preferred = candidates.filter(candidate => (candidate.nestingLevel ?? 0) === preferredLevel)
    const pool = preferred.length > 0 ? preferred : candidates
    const older = pool.filter(candidate => candidate.updatedAt <= session.updatedAt)
    if (older.length > 0) {
      older.sort((a, b) => b.updatedAt - a.updatedAt)
      return older[0]
    }
    return [...pool].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  for (const session of sorted) {
    const parent = chooseParent(session)
    if (!parent) continue
    const parentNode = nodes.get(parent.id)
    const childNode = nodes.get(session.id)
    if (!parentNode || !childNode) continue
    childNode.parentId = parent.id
    parentNode.children.push(childNode)
  }

  const computeSubtree = (node: SessionNode): number => {
    let latest = node.session.updatedAt
    for (const child of node.children) {
      latest = Math.max(latest, computeSubtree(child))
    }
    node.children.sort((a, b) => compareSessions(a.session, b.session, sortMode))
    node.subtreeUpdatedAt = latest
    return latest
  }

  const roots = [...nodes.values()].filter(node => !node.parentId)
  for (const root of roots) computeSubtree(root)
  roots.sort((a, b) => compareSessions(a.session, b.session, sortMode))

  const flattened: DisplaySessionEntry[] = []
  const walk = (node: SessionNode, depth: number) => {
    flattened.push({ ...node.session, displayIndent: depth })
    for (const child of node.children) walk(child, depth + 1)
  }

  for (const root of roots) walk(root, 0)
  return flattened
}

// ─── SidebarFooter ──────────────────────────────────────────────────────────

type SidebarFooterProps = Pick<Props,
  'onNewTerminal' | 'onNewKanban' | 'onNewBrowser' | 'onNewChat' | 'onNewFiles' | 'onOpenSettings' | 'extensionTiles' | 'onAddExtensionTile'
>

export function SidebarFooter({
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles,
  onOpenSettings,
  extensionTiles, onAddExtensionTile,
}: SidebarFooterProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [showExtMenu, setShowExtMenu] = useState(false)
  const extMenuRef = useRef<HTMLDivElement>(null)
  const footerIconColor = theme.text.secondary

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (extMenuRef.current && !extMenuRef.current.contains(target)) setShowExtMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    setShowExtMenu(false)
  }, [extensionTiles])

  return (
    <div style={{ padding: '11px 8px 2px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2, flexShrink: 0 }}>
        {([
          { label: 'Settings', icon: <Settings size={14} />, action: () => onOpenSettings('general') },
          { label: 'New Terminal', icon: TILE_ICONS.terminal, action: onNewTerminal },
          { label: 'Agent Board', icon: TILE_ICONS.kanban, action: onNewKanban, disabled: true },
          { label: 'Browser', icon: TILE_ICONS.browser, action: onNewBrowser },
          { label: 'Chat', icon: TILE_ICONS.chat, action: onNewChat },
          { label: 'Files', icon: TILE_ICONS.files, action: onNewFiles },
        ] as { label: string; icon: React.ReactNode; action: () => void; disabled?: boolean }[]).map(btn => (
          <button key={btn.label} title={btn.disabled ? `${btn.label} disabled` : btn.label} style={{
            width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent',
            color: btn.disabled ? theme.text.disabled : footerIconColor, cursor: btn.disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: btn.disabled ? 0.45 : 1,
          }}
            onMouseEnter={e => { if (!btn.disabled) e.currentTarget.style.color = theme.text.primary }}
            onMouseLeave={e => { e.currentTarget.style.color = btn.disabled ? theme.text.disabled : footerIconColor }}
            onClick={btn.disabled ? undefined : btn.action}
          >
            {btn.icon}
          </button>
        ))}

        {extensionTiles && extensionTiles.length > 0 && (
          <div style={{ position: 'relative' }} ref={extMenuRef}>
            <button title="Extensions" style={{
              width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent',
              color: showExtMenu ? theme.text.primary : footerIconColor, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
              onMouseEnter={e => { e.currentTarget.style.color = theme.text.primary }}
              onMouseLeave={e => { if (!showExtMenu) e.currentTarget.style.color = footerIconColor }}
              onClick={() => setShowExtMenu(p => !p)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                <path d="M8 7.5h2a.5.5 0 01.5.5v1.5H10a1 1 0 00-1 1v0a1 1 0 001 1h.5V13a.5.5 0 01-.5.5H8V13a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H4.5A.5.5 0 014 13v-1.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H4V8a.5.5 0 01.5-.5H8z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.5" />
              </svg>
            </button>
            {showExtMenu && (
              <div style={{
                position: 'absolute', bottom: 32, right: 0, minWidth: 160,
                background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`, borderRadius: 8,
                padding: 4, boxShadow: theme.shadow.panel, zIndex: 1000,
              }}>
                {extensionTiles.map(ext => {
                  const disabled = ext.type === 'ext:artifact-builder'
                  return (
                    <button key={ext.type} onClick={disabled ? undefined : () => { onAddExtensionTile?.(ext.type); setShowExtMenu(false) }} style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', borderRadius: 6,
                      border: 'none', background: 'transparent', color: disabled ? theme.text.disabled : theme.text.secondary, fontSize: fonts.size, cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
                      opacity: disabled ? 0.45 : 1,
                    }}
                      onMouseEnter={e => {
                        if (disabled) return
                        e.currentTarget.style.background = theme.surface.panelMuted; e.currentTarget.style.color = theme.text.primary
                      }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = disabled ? theme.text.disabled : theme.text.secondary }}
                      title={disabled ? `${ext.label} disabled` : ext.label}
                    >
                      <span>{ext.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({
  workspace, workspaces, tiles, onSwitchWorkspace: _onSwitchWorkspace, onDeleteWorkspace: _onDeleteWorkspace, onNewWorkspace: _onNewWorkspace, onOpenFolder, onOpenFile, onFocusTile, onUpdateTile: _onUpdateTile, onCloseTile: _onCloseTile,
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles, onOpenSettings,
  onOpenSessionInChat, onOpenSessionInApp,
  extensionTiles, extensionEntries, onAddExtensionTile, pinnedExtensionIds, onTogglePinnedExtension,
  collapsed, width, onWidthChange, minWidth = 270, maxWidth = 520, onResizeStateChange, onToggleCollapse: _onToggleCollapse, onScrollMetricsChange, showFooter = true
}: Props): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const widthRef = useRef(width)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  useEffect(() => { widthRef.current = width }, [width])
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<string, boolean>>({})
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
    void window.electron.workspace.listProjects()
      .then(items => {
        if (!cancelled) setProjects(items)
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
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

    return projects
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

  const sessionContextMenuItems = useCallback((session: SessionEntry): MenuItem[] => {
    const items: MenuItem[] = []

    if (session.tileId) {
      items.push({ label: 'Focus Existing Chat', action: () => onFocusTile(session.tileId!) })
    }
    if (session.canOpenInChat !== false) {
      items.push({ label: 'Open in Chat', action: () => onOpenSessionInChat(session) })
    }
    if (session.canOpenInApp) {
      items.push({ label: `Open in ${session.sourceLabel}`, action: () => onOpenSessionInApp(session) })
    }
    if (session.filePath) {
      items.push({ label: 'Open Raw File', action: () => onOpenFile(session.filePath!) })
    }

    return items.length > 0 ? items : [{ label: 'No actions available', action: () => {} }]
  }, [onFocusTile, onOpenFile, onOpenSessionInApp, onOpenSessionInChat])
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
    }
  }, [activeProjectId, collapsedThreadGroups, loadWorkspaceSessions, projectEntries, workspaceById])

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

  useEffect(() => {
    setVisibleSessionCount(SESSION_PAGE_SIZE)
  }, [workspace?.id, showCronSessions, showSubagentSessions, threadOrganizeMode, threadSortMode, sessions.length])

  const displayedSessions = useMemo(() => {
    return visibleSessions.slice(0, visibleSessionCount)
  }, [visibleSessions, visibleSessionCount])

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
        const workspaceSessions = displayedSessions.filter(session => {
          const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
          if (sessionProjectPath) return sessionProjectPath === projectPath
          return workspaceIdSet.has(session.workspaceId)
        })
        return {
          projectId: projectEntry.id,
          projectPath: projectEntry.path,
          representativeWorkspaceId: projectEntry.representativeWorkspaceId,
          key: projectEntry.id,
          label: getProjectDisplayLabel(projectEntry),
          sessions: workspaceSessions,
        }
      })
  }, [displayedSessions, projectEntries, threadOrganizeMode])

  const hasMoreSessions = displayedSessions.length < visibleSessions.length

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

        <div style={{ paddingBottom: 6 }}>
          {RESOURCE_ITEMS.map(item => (
            <SidebarItem
              key={item.id}
              label={item.label}
              icon={item.icon}
              onClick={() => onOpenSettings(item.id)}
            />
          ))}
        </div>

        <div style={{ padding: '8px 12px 10px' }}>
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

          {threadOrganizeMode === 'chronological' && visibleSessions.length === 0 ? (
            <div style={{ padding: '4px 0', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No threads yet</div>
          ) : (
            <>
              {displayedSessionGroups.map(group => (
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
                      extraWidth={132}
                      onClick={() => {
                        if (session.tileId) {
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
                          <span style={{
                            fontSize: fonts.secondarySize - 1,
                            color: theme.text.disabled,
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}>
                            {session.sourceLabel}{session.messageCount > 0 ? ` · ${session.messageCount} msg` : ''}
                          </span>
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
                </div>
              ))}

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
                {/* Installed extensions with instances */}
                {groupedExtensions.map(group => {
                  const multiBlock = group.items.length > 1
                  const groupPinned = pinnedExtensionIdSet.has(group.extId)
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
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          padding: '6px 8px 4px 12px',
                          margin: '0 6px',
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                        }}
                      >
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
                          onClick={() => onTogglePinnedExtension?.(group.extId)}
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
                      {group.items.map(ext => {
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
                {extensionInstances.length === 0 && !extensionTiles?.length && (
                  <div style={{ padding: '4px 12px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No extensions</div>
                )}
              </div>
            )}
          </>
        )}
        </div>
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
