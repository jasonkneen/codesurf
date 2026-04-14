import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { Pin } from 'lucide-react'
import type { Workspace, TileState } from '../../../shared/types'
import { getCurvierBlockRadius } from '../../../shared/types'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
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
  showFooter?: boolean
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
        cursor: 'pointer', userSelect: 'none',
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

// ─── Sidebar item ────────────────────────────────────────────────────────────

function SidebarItem({ label, icon, active, muted, onClick, onContextMenu, indent = 0, extra, extraAlwaysVisible = false }: {
  label: string
  icon?: React.ReactNode
  active?: boolean
  muted?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  indent?: number
  extra?: React.ReactNode
  extraAlwaysVisible?: boolean
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
        padding: '4px 8px 4px ' + (12 + indent * 14) + 'px',
        cursor: 'pointer', userSelect: 'none',
        borderRadius: 6, margin: '0 6px',
        background: active ? theme.surface.selection : hovered ? theme.surface.hover : 'transparent',
        transition: 'background 0.1s ease',
      }}
    >
      {icon && <span style={{ color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.muted, flexShrink: 0, display: 'flex', alignItems: 'center' }}>{icon}</span>}
      <span style={{
        fontSize: fonts.size, fontWeight: active ? 500 : 400,
        color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.secondary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {label}
      </span>
      {extra && (hovered || extraAlwaysVisible) && extra}
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

const SESSION_PAGE_SIZE = 10

function sessionMetaText(session: SessionEntry): string {
  return `${session.title} ${session.sourceLabel} ${session.sourceDetail ?? ''}`.toLowerCase()
}

function isCronSession(session: SessionEntry): boolean {
  const meta = sessionMetaText(session)
  return meta.includes('scheduled task') || meta.includes('cron')
}

function isSubagentSession(session: SessionEntry): boolean {
  if ((session.nestingLevel ?? 0) > 0) return true
  return sessionMetaText(session).includes('subagent')
}

function buildNestedSessionList(sessions: SessionEntry[]): DisplaySessionEntry[] {
  type SessionNode = {
    session: SessionEntry
    children: SessionNode[]
    parentId: string | null
    subtreeUpdatedAt: number
  }

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const nodes = new Map(sorted.map(session => [session.id, {
    session,
    children: [],
    parentId: null,
    subtreeUpdatedAt: session.updatedAt,
  }]))
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
    node.children.sort((a, b) => b.subtreeUpdatedAt - a.subtreeUpdatedAt || b.session.updatedAt - a.session.updatedAt)
    node.subtreeUpdatedAt = latest
    return latest
  }

  const roots = [...nodes.values()].filter(node => !node.parentId)
  for (const root of roots) computeSubtree(root)
  roots.sort((a, b) => b.subtreeUpdatedAt - a.subtreeUpdatedAt || b.session.updatedAt - a.session.updatedAt)

  const flattened: DisplaySessionEntry[] = []
  const walk = (node: SessionNode, depth: number) => {
    flattened.push({ ...node.session, displayIndent: depth })
    for (const child of node.children) walk(child, depth + 1)
  }

  for (const root of roots) walk(root, 0)
  return flattened
}

// ─── Tile label helper ───────────────────────────────────────────────────────

function tileLabel(tile: TileState): string {
  if (tile.filePath) {
    const name = tile.filePath.split('/').pop() ?? tile.filePath
    return name
  }
  const TYPE_LABELS: Record<string, string> = {
    terminal: 'Terminal', note: 'Note', code: 'Code', image: 'Image',
    kanban: 'Board', browser: 'Browser', chat: 'Chat', files: 'Files',
  }
  return TYPE_LABELS[tile.type] ?? tile.type
}

// ─── SidebarFooter ──────────────────────────────────────────────────────────

type SidebarFooterProps = Pick<Props,
  'onNewTerminal' | 'onNewKanban' | 'onNewBrowser' | 'onNewChat' | 'onNewFiles' | 'extensionTiles' | 'onAddExtensionTile'
>

export function SidebarFooter({
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles,
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
  workspace, workspaces, tiles, onSwitchWorkspace, onDeleteWorkspace, onNewWorkspace, onOpenFolder, onOpenFile, onFocusTile, onUpdateTile, onCloseTile,
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles, onOpenSettings,
  onOpenSessionInChat, onOpenSessionInApp,
  extensionTiles, extensionEntries, onAddExtensionTile, pinnedExtensionIds, onTogglePinnedExtension,
  collapsed, width, onWidthChange, minWidth = 270, maxWidth = 520, onResizeStateChange, onToggleCollapse: _onToggleCollapse, showFooter = true
}: Props): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false)
  const [newWsInput, setNewWsInput] = useState(false)
  const [newWsName, setNewWsName] = useState('')
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<string, boolean>>({})
  const [tileCtx, setTileCtx] = useState<{ x: number; y: number; tile: TileState } | null>(null)
  const [sessionCtx, setSessionCtx] = useState<{ x: number; y: number; session: SessionEntry } | null>(null)
  const [renamingTileId, setRenamingTileId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [showCronSessions, setShowCronSessions] = useState(false)
  const [showSubagentSessions, setShowSubagentSessions] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_PAGE_SIZE)
  const deleteConfirmTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (deleteConfirmTimerRef.current) window.clearTimeout(deleteConfirmTimerRef.current)
    }
  }, [])

  // Load sessions for current workspace
  useEffect(() => {
    if (!workspace) {
      setSessions([])
      return
    }
    let cancelled = false
    const load = (forceRefresh = false) => {
      window.electron.canvas.listSessions(workspace.id, forceRefresh).then(s => {
        if (!cancelled) setSessions(s)
      }).catch(() => {})
    }
    load()
    const unsubscribe = window.electron.canvas.onSessionsChanged(({ workspaceId }) => {
      if (workspaceId === workspace.id) load()
    })
    const onFocus = () => load(true)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [workspace?.id])

  const BORDER_RADIUS_CYCLE = [12, 0, 24, 32]
  const cycleBorderRadius = useCallback((tile: TileState) => {
    const current = getCurvierBlockRadius(tile.borderRadius)
    const next = BORDER_RADIUS_CYCLE.find(value => value > current) ?? BORDER_RADIUS_CYCLE[0]
    onUpdateTile(tile.id, { borderRadius: next })
  }, [onUpdateTile])

  const tileContextMenuItems = useCallback((tile: TileState): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Rename', action: () => { setRenamingTileId(tile.id); setRenameValue(tile.label ?? tileLabel(tile)) } },
      { label: '', action: () => {}, divider: true },
      { label: tile.hideTitlebar ? 'Show Titlebar' : 'Hide Titlebar', action: () => onUpdateTile(tile.id, { hideTitlebar: !tile.hideTitlebar }) },
    ]
    if (tile.type === 'browser') {
      items.push({ label: tile.hideNavbar ? 'Show Navbar' : 'Hide Navbar', action: () => onUpdateTile(tile.id, { hideNavbar: !tile.hideNavbar }) })
    }
    items.push(
      { label: `Corner Radius: ${getCurvierBlockRadius(tile.borderRadius)}px`, action: () => cycleBorderRadius(tile) },
      { label: '', action: () => {}, divider: true },
      { label: 'Close', action: () => onCloseTile(tile.id), danger: true },
    )
    return items
  }, [onUpdateTile, onCloseTile, cycleBorderRadius])
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

  // Group tiles by type for the Extensions section
  const coreTiles = useMemo(() => tiles.filter(t => ['terminal', 'code', 'note', 'browser', 'chat', 'files', 'file', 'kanban', 'image'].includes(t.type)), [tiles])
  const extensionInstances = useMemo(() => tiles.filter(t => t.type.startsWith('ext:')), [tiles])

  // Group core tiles by type
  const coreGroups = useMemo(() => {
    const groups: Record<string, TileState[]> = {}
    for (const t of coreTiles) {
      if (!groups[t.type]) groups[t.type] = []
      groups[t.type].push(t)
    }
    return groups
  }, [coreTiles])

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
    const filtered = sessions.filter(session => {
      const normalizedTitle = session.title?.trim().toLowerCase() ?? ''
      const hasContent = Boolean(session.title?.trim()) || Boolean(session.lastMessage?.trim()) || session.messageCount > 0
      if (!hasContent) return false
      if (normalizedTitle === 'new agent') return false
      if (!showCronSessions && isCronSession(session)) return false
      if (!showSubagentSessions && isSubagentSession(session)) return false
      return true
    })
    return buildNestedSessionList(filtered)
  }, [sessions, showCronSessions, showSubagentSessions])

  useEffect(() => {
    setVisibleSessionCount(SESSION_PAGE_SIZE)
  }, [workspace?.id, showCronSessions, showSubagentSessions, sessions.length])

  const displayedSessions = useMemo(() => {
    return visibleSessions.slice(0, visibleSessionCount)
  }, [visibleSessions, visibleSessionCount])

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
    if (!workspace || deletingSessionId) return
    setDeletingSessionId(session.id)
    try {
      const result = await window.electron.canvas.deleteSession(workspace.id, session.id)
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
  }, [workspace, deletingSessionId])

  return (
    <div style={{
      width: collapsed ? 0 : Math.max(width, minWidth),
      minWidth: collapsed ? 0 : minWidth,
      height: '100%',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      transition: 'width 0.15s ease',
    }}>
      {/* ── WORKSPACES ── */}
      <div style={{ padding: '4px 10px 2px' }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            padding: '5px 10px', borderRadius: 8,
            background: theme.surface.panelMuted, border: `1px solid ${theme.border.default}`
          }}
          onClick={() => setWsDropdownOpen(p => !p)}
        >
          <span style={{
            fontSize: fonts.size, color: theme.text.primary, fontWeight: 500,
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit'
          }}>
            {workspace?.name ?? 'No workspace'}
          </span>
          <span style={{ fontSize: 9, color: theme.text.disabled }}>{wsDropdownOpen ? '\u25B4' : '\u25BE'}</span>
        </div>

        {wsDropdownOpen && (
          <div style={{ marginTop: 4, background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`, borderRadius: 8, overflow: 'hidden' }}>
            {workspaces.map(ws => (
              <div key={ws.id}
                style={{
                  padding: '7px 10px 7px 14px', fontSize: fonts.size, fontFamily: 'inherit', color: ws.id === workspace?.id ? theme.accent.base : theme.text.secondary, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { onSwitchWorkspace(ws.id); setWsDropdownOpen(false) }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
                <button
                  title="Delete workspace record"
                  onClick={e => {
                    e.stopPropagation()
                    onDeleteWorkspace(ws.id)
                  }}
                  style={{
                    width: 18, height: 18, borderRadius: 4, border: 'none', background: 'transparent',
                    color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = theme.surface.panelMuted; e.currentTarget.style.color = theme.status.danger }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.text.disabled }}
                >
                  ×
                </button>
              </div>
            ))}
            <div style={{ height: 1, background: theme.border.default, margin: '2px 0' }} />
            {newWsInput ? (
              <div style={{ padding: '4px 8px' }}>
                <input autoFocus value={newWsName} onChange={e => setNewWsName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newWsName.trim()) { onNewWorkspace(newWsName.trim()); setNewWsName(''); setNewWsInput(false); setWsDropdownOpen(false) }
                    if (e.key === 'Escape') { setNewWsInput(false); setNewWsName('') }
                  }}
                  placeholder="Workspace name..."
                  style={{ width: '100%', padding: '4px 8px', fontSize: fonts.size, borderRadius: 4, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.accent.base}`, outline: 'none', fontFamily: 'inherit' }}
                />
              </div>
            ) : (
              <>
                <div style={{ padding: '7px 14px', fontSize: fonts.size, color: theme.text.muted, cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { onOpenFolder(); setWsDropdownOpen(false) }}
                >Open Folder...</div>
                <div style={{ padding: '7px 14px', fontSize: fonts.size, color: theme.text.muted, cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => setNewWsInput(true)}
                >+ New empty workspace</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Scrollable sections */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 6 }}>

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

        {/* ── BLOCKS ── */}
        <SectionHeader label="Blocks" collapsed={!!sectionsCollapsed.blocks} onToggle={() => toggleSection('blocks')} />
        {!sectionsCollapsed.blocks && (
          <div style={{ paddingBottom: 6 }}>
            {Object.entries(coreGroups).map(([type, instances]) => (
              <React.Fragment key={type}>
                {instances.map(tile => (
                  renamingTileId === tile.id ? (
                    <div key={tile.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 12px', margin: '0 6px' }}>
                      <span style={{ color: theme.text.muted, flexShrink: 0, display: 'flex', alignItems: 'center' }}>{TILE_ICONS[tile.type] ?? TILE_ICONS.code}</span>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const trimmed = renameValue.trim()
                            onUpdateTile(tile.id, { label: trimmed || undefined })
                            setRenamingTileId(null)
                          }
                          if (e.key === 'Escape') setRenamingTileId(null)
                        }}
                        onBlur={() => {
                          const trimmed = renameValue.trim()
                          onUpdateTile(tile.id, { label: trimmed || undefined })
                          setRenamingTileId(null)
                        }}
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: fonts.size, borderRadius: 4,
                          background: theme.surface.input, color: theme.text.primary,
                          border: `1px solid ${theme.accent.base}`, outline: 'none',
                          fontFamily: 'inherit', minWidth: 0,
                        }}
                      />
                    </div>
                  ) : (
                    <SidebarItem
                      key={tile.id}
                      label={tileLabel(tile)}
                      icon={TILE_ICONS[tile.type] ?? TILE_ICONS.code}
                      onClick={() => onFocusTile(tile.id)}
                      onContextMenu={e => { e.preventDefault(); setTileCtx({ x: e.clientX, y: e.clientY, tile }) }}
                      extra={
                        <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                          {/* Hide/show titlebar */}
                          <button onClick={e => { e.stopPropagation(); onUpdateTile(tile.id, { hideTitlebar: !tile.hideTitlebar }) }}
                            title={tile.hideTitlebar ? 'Show titlebar' : 'Hide titlebar'}
                            style={{ width: 18, height: 18, borderRadius: 3, border: 'none', background: 'transparent', color: tile.hideTitlebar ? theme.accent.base : theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0 }}
                            className="sidebar-tile-action"
                          >
                            <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" /><path d="M1 4.5h12" stroke="currentColor" strokeWidth="1.3" /></svg>
                          </button>
                          {/* Cycle border radius */}
                          <button onClick={e => { e.stopPropagation(); cycleBorderRadius(tile) }}
                            title={`Border radius: ${getCurvierBlockRadius(tile.borderRadius)}px`}
                            style={{ width: 18, height: 18, borderRadius: 3, border: 'none', background: 'transparent', color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0 }}
                            className="sidebar-tile-action"
                          >
                            <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="12" height="12" rx={Math.min(getCurvierBlockRadius(tile.borderRadius) / 2, 6)} stroke="currentColor" strokeWidth="1.3" /></svg>
                          </button>
                        </div>
                      }
                    />
                  )
                ))}
              </React.Fragment>
            ))}
            {coreTiles.length === 0 && (
              <div style={{ padding: '4px 12px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No blocks open</div>
            )}
          </div>
        )}

        {/* ── SESSIONS ── */}
        <SectionHeader
          label="Threads"
          collapsed={!!sectionsCollapsed.sessions}
          onToggle={() => toggleSection('sessions')}
          extra={(
            <>
              <button
                title={showCronSessions ? 'Hide cron sessions' : 'Show cron sessions'}
                aria-label={showCronSessions ? 'Hide cron sessions' : 'Show cron sessions'}
                onClick={() => setShowCronSessions(value => !value)}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  border: 'none',
                  background: showCronSessions ? theme.surface.hover : 'transparent',
                  color: showCronSessions ? theme.text.secondary : theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: showCronSessions ? 1 : 0.65,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M7 4.4v2.9l1.8 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                title={showSubagentSessions ? 'Hide subagent sessions' : 'Show subagent sessions'}
                aria-label={showSubagentSessions ? 'Hide subagent sessions' : 'Show subagent sessions'}
                onClick={() => setShowSubagentSessions(value => !value)}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  border: 'none',
                  background: showSubagentSessions ? theme.surface.hover : 'transparent',
                  color: showSubagentSessions ? theme.text.secondary : theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: showSubagentSessions ? 1 : 0.65,
                }}
              >
                <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
                  <path d="M4 3.2h6M4 10.8h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  <path d="M4.8 3.2v2.1c0 .9.7 1.6 1.6 1.6h1.2c.9 0 1.6.7 1.6 1.6v2.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </>
          )}
        />
        {!sectionsCollapsed.sessions && (
          <div style={{ paddingBottom: 6 }}>
            {visibleSessions.length === 0 ? (
              <div style={{ padding: '4px 12px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No sessions yet</div>
            ) : (
              <>
                {displayedSessions.map(session => (
                  <SidebarItem
                    key={session.id}
                    label={session.title.length > 44 ? `${session.title.slice(0, 44)}...` : session.title}
                    icon={SESSION_SOURCE_ICONS[session.source]}
                    indent={session.displayIndent}
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
                          fontSize: fonts.secondarySize - 1, color: theme.text.disabled,
                          whiteSpace: 'nowrap', flexShrink: 0,
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
                {hasMoreSessions && (
                  <div style={{ padding: '6px 12px 0', textAlign: 'center' }}>
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
        )}

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
                        }}
                      >
                        <span style={{ color: theme.text.muted, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                          <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>
                        </span>
                        <span style={{
                          fontSize: fonts.secondarySize,
                          fontWeight: 700,
                          color: theme.text.muted,
                          letterSpacing: 0.5,
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

      {showFooter && (
        <SidebarFooter
          onNewTerminal={onNewTerminal} onNewKanban={onNewKanban} onNewBrowser={onNewBrowser}
          onNewChat={onNewChat} onNewFiles={onNewFiles}
          extensionTiles={extensionTiles} onAddExtensionTile={onAddExtensionTile}
        />
      )}

      {/* Tile context menu */}
      {tileCtx && (
        <ContextMenu x={tileCtx.x} y={tileCtx.y} items={tileContextMenuItems(tileCtx.tile)} onClose={() => setTileCtx(null)} />
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
