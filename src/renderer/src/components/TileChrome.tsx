import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { TileState, SkillConfig, ContextItem, ActivityStatus } from '../../../shared/types'
import { getCurvierBlockRadius } from '../../../shared/types'
import { buildObjective } from '../utils/objectiveBuilder'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { useTileColor } from '../TileColorContext'

// --- Drawer data types ---

interface TaskItem {
  id: string
  title: string
  status: 'pending' | 'in-progress' | 'done' | 'error' | 'paused'
  detail?: string
  timestamp: number
}

interface ToolItem {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  input?: string
  output?: string
  elapsed?: number
  timestamp: number
}

interface MessageItem {
  id: string
  source: 'direct' | 'group'
  direction: 'inbound' | 'outbound'
  fromTileId: string
  toTileId?: string
  channel?: string
  subject: string
  type?: string
  kind?: string
  scope?: string
  createdAt: number
  status?: string
  mailbox?: string
}

type DrawerTab = 'tasks' | 'tools' | 'skills' | 'context' | 'messages'

interface DrawerData {
  tasks: TaskItem[]
  tools: ToolItem[]
  skills: SkillConfig[]
  context: ContextItem[]
  messages: MessageItem[]
}

// --- TileChrome props ---

interface Props {
  tile: TileState
  workspaceId?: string
  workspaceDir?: string
  onClose: () => void
  onActivate?: () => void
  onTitlebarMouseDown: (e: React.MouseEvent) => void
  onResizeMouseDown: (e: React.MouseEvent, dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw') => void
  onContextMenu?: (e: React.MouseEvent) => void
  onExpandChange?: (expanded: boolean) => void
  children: React.ReactNode
  isSelected?: boolean
  forceExpanded?: boolean
  busChannel?: string
  busUnreadCount?: number
  onBusPopupToggle?: () => void
  showBusPopup?: boolean
  discoveryConnected?: boolean
  connectedPeers?: string[]
  titlebarColor?: string
  titlebarExtra?: React.ReactNode
  busEvents?: Array<{
    id: string
    type: string
    timestamp: number
    source: string
    payload: Record<string, unknown>
  }>
}

const DRAWER_WIDTH = 260
const DRAWER_TYPES = new Set(['terminal', 'chat'])

const TYPE_LABELS: Record<string, string> = {
  terminal: 'Terminal', note: 'Note', code: 'Code', image: 'Image', kanban: 'Board', browser: 'Browser', chat: 'Chat', files: 'Files', customisation: 'Settings',
}

// Extension type labels are resolved dynamically — see getTypeLabel()
function getTypeLabel(type: string): string {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type]
  if (type.startsWith('ext:')) {
    // Show the part after 'ext:' with first letter capitalized
    const name = type.slice(4)
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  return type
}

export function fileLabel(tile: TileState): string {
  if (tile.label) return tile.label
  if (!tile.filePath) return getTypeLabel(tile.type)
  return tile.filePath.replace(/\\/g, '/').split('/').pop() || tile.filePath
}

function ResizeHandle({ dir, onMouseDown }: {
  dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'
  onMouseDown: (e: React.MouseEvent) => void
}): JSX.Element {
  const S = 8
  const style: React.CSSProperties = { position: 'absolute', zIndex: 10 }
  if (dir === 'e')  Object.assign(style, { right: 0, top: S, bottom: S, width: S, cursor: 'col-resize' })
  if (dir === 'w')  Object.assign(style, { left: 0, top: S, bottom: S, width: S, cursor: 'col-resize' })
  if (dir === 's')  Object.assign(style, { bottom: 0, left: S, right: S, height: S, cursor: 'row-resize' })
  if (dir === 'n')  Object.assign(style, { top: 0, left: S, right: S, height: S, cursor: 'row-resize' })
  if (dir === 'se') Object.assign(style, { right: 0, bottom: 0, width: S, height: S, cursor: 'se-resize' })
  if (dir === 'sw') Object.assign(style, { left: 0, bottom: 0, width: S, height: S, cursor: 'sw-resize' })
  if (dir === 'ne') Object.assign(style, { right: 0, top: 0, width: S, height: S, cursor: 'ne-resize' })
  if (dir === 'nw') Object.assign(style, { left: 0, top: 0, width: S, height: S, cursor: 'nw-resize' })
  return <div style={style} onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onMouseDown(e) }} />
}

// ─── Tab icons (12x12 SVGs) ──────────────────────────────────────────────────

function TabIcon({ tab }: { tab: DrawerTab }): JSX.Element {
  if (tab === 'tasks') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="1.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" />
      <rect x="1" y="7.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" />
      <path d="M6 3h5M6 9h5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
  if (tab === 'tools') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M7.5 2.5l2 2-5 5-2.5.5.5-2.5 5-5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M6.5 3.5l2 2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
  if (tab === 'skills') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1l1.5 3.5H11l-3 2.2 1.2 3.3L6 7.8 2.8 10l1.2-3.3-3-2.2h3.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
  if (tab === 'messages') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M1.5 2h9a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-7A.5.5 0 0 1 1.5 2z" stroke="currentColor" strokeWidth="1" />
      <path d="M1.5 2.5 6 5.75 10.5 2.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
  // context
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 1.5h4l2.5 2.5V10.5H3z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M7 1.5V4h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 6.5h3M4.5 8h2" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  )
}

// ─── Tab labels ──────────────────────────────────────────────────────────────

const TAB_LABELS: Record<DrawerTab, string> = {
  tasks: 'Tasks', tools: 'Tools Available', skills: 'Skills', context: 'Context', messages: 'Messages'
}

const ALL_TABS: DrawerTab[] = ['tasks', 'tools', 'skills', 'context', 'messages']

function drawerTabTitle(tab: DrawerTab): string {
  return TAB_LABELS[tab].toUpperCase()
}

function getTitlebarForeground(background: string | null | undefined, lightFallback: string, darkFallback: string): string {
  if (!background) return lightFallback
  const hex = background.trim().match(/^#([0-9a-f]{6})$/i)
  if (!hex) return lightFallback
  const value = hex[1]
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.62 ? darkFallback : lightFallback
}

// ─── Status icons ────────────────────────────────────────────────────────────

function TaskStatusIcon({ status }: { status: TaskItem['status'] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  if (status === 'done') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.status.success} strokeWidth="1.2" />
      <path d="M3.5 6l2 2 3-3.5" stroke={theme.status.success} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  if (status === 'error') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.status.danger} strokeWidth="1.2" />
      <path d="M4 4l4 4M8 4l-4 4" stroke={theme.status.danger} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
  if (status === 'paused') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.status.warning} strokeWidth="1.2" />
      <path d="M4.5 4v4M7.5 4v4" stroke={theme.status.warning} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
  if (status === 'in-progress') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.accent.base} strokeWidth="1.2" />
      <path d="M6 3v3.5l2.5 1.5" stroke={theme.accent.base} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.text.disabled} strokeWidth="1.2" />
    </svg>
  )
}

function ToolStatusIcon({ status }: { status: ToolItem['status'] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  if (status === 'done') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.status.success} strokeWidth="1.2" />
      <path d="M3.5 6l2 2 3-3.5" stroke={theme.status.success} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  if (status === 'error') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.status.danger} strokeWidth="1.2" />
      <path d="M4 4l4 4M8 4l-4 4" stroke={theme.status.danger} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke={theme.accent.base} strokeWidth="1.2" />
      <circle cx="6" cy="6" r="2" fill={theme.accent.base} opacity="0.6" />
    </svg>
  )
}

// ─── Drawer tab content panels ───────────────────────────────────────────────

// ── Small action button for task rows ───────────────────────────────────────

function ActionBtn({ title, color, onClick, children }: {
  title: string; color: string; onClick: () => void; children: React.ReactNode
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        width: 18, height: 18, borderRadius: 3, border: 'none', cursor: 'pointer',
        background: 'transparent', color, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, padding: 0,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  )
}

function parseTaskLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => line.replace(/^(?:[-*+•]\s*)?(?:\[(?: |x|X)\]\s*)?(?:\d+[.)]\s*)?/, '').trim())
    .filter(Boolean)
}

function TasksPanel({ tasks, onUpdateTask, onDeleteTask, onAddTask }: {
  tasks: TaskItem[]
  onUpdateTask: (id: string, status: TaskItem['status']) => void
  onDeleteTask: (id: string) => void
  onAddTask: (title: string) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [newTitle, setNewTitle] = useState('')
  const [taskMenu, setTaskMenu] = useState<{ x: number; y: number; task: TaskItem } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const focusComposer = () => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const submit = () => {
    const t = newTitle.trim()
    if (!t) return
    onAddTask(t)
    setNewTitle('')
    focusComposer()
  }

  const addMany = (titles: string[]) => {
    const cleaned = titles.map(title => title.trim()).filter(Boolean)
    if (cleaned.length === 0) return
    cleaned.forEach(onAddTask)
    setNewTitle('')
    focusComposer()
  }

  const pending = tasks.filter(t => t.status !== 'done')
  const done = tasks.filter(t => t.status === 'done')

  const toggleTaskDone = (task: TaskItem) => {
    onUpdateTask(task.id, task.status === 'done' ? 'pending' : 'done')
  }

  const menuItemsForTask = (task: TaskItem): MenuItem[] => {
    const statusItems: Array<{ status: TaskItem['status']; label: string }> = [
      { status: 'pending', label: 'Mark as Pending' },
      { status: 'in-progress', label: 'Mark as In Progress' },
      { status: 'paused', label: 'Mark as Paused' },
      { status: 'done', label: 'Mark as Done' },
    ]

    return [
      ...statusItems
        .filter(item => item.status !== task.status)
        .map(item => ({ label: item.label, action: () => onUpdateTask(task.id, item.status) })),
      { label: '', action: () => {}, divider: true },
      { label: 'Delete Task', danger: true, action: () => onDeleteTask(task.id) },
    ]
  }

  const renderTaskRow = (task: TaskItem, doneRow = false): JSX.Element => (
    <div
      key={task.id}
      style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
      onContextMenu={e => {
        e.preventDefault()
        e.stopPropagation()
        setTaskMenu({ x: e.clientX, y: e.clientY, task })
      }}
    >
      <button
        title={task.status === 'done' ? 'Mark pending' : 'Mark done'}
        onClick={() => toggleTaskDone(task)}
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <TaskStatusIcon status={task.status} />
      </button>
      <div style={{ flex: 1, minWidth: 0, fontSize: fonts.secondarySize, color: doneRow ? theme.text.disabled : theme.text.secondary, textDecoration: doneRow ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task.title}
      </div>
      <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        {task.status === 'paused' ? (
          <ActionBtn title="Resume" color={theme.accent.base} onClick={() => onUpdateTask(task.id, 'in-progress')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l5 3-5 3z" fill="currentColor"/></svg>
          </ActionBtn>
        ) : !doneRow ? (
          <ActionBtn title="Pause" color={theme.status.warning} onClick={() => onUpdateTask(task.id, 'paused')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2v6M7 2v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </ActionBtn>
        ) : null}
        {!doneRow && (
          <ActionBtn title="Done" color={theme.text.muted} onClick={() => onUpdateTask(task.id, 'done')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5l2.5 2.5 3.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </ActionBtn>
        )}
        <ActionBtn title="Delete" color={doneRow ? theme.text.disabled : theme.text.muted} onClick={() => onDeleteTask(task.id)}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
        </ActionBtn>
      </div>
    </div>
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', display: 'flex', flexDirection: 'column' }}>
      {/* Task composer */}
      <div style={{ padding: '4px 8px', flexShrink: 0 }}>
        <textarea
          ref={inputRef}
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') setNewTitle('')
          }}
          onPaste={e => {
            const pasted = e.clipboardData.getData('text/plain')
            const lines = parseTaskLines(pasted)
            if (lines.length <= 1) return
            e.preventDefault()
            addMany(lines)
          }}
          placeholder="Add a task..."
          rows={2}
          style={{
            width: '100%', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: theme.surface.input,
            color: theme.text.secondary, fontSize: fonts.secondarySize, padding: '4px 8px', resize: 'vertical', outline: 'none', minHeight: 36, maxHeight: 100, lineHeight: 1.4,
          }}
          onFocus={e => {
            e.currentTarget.style.borderColor = theme.border.accent
            e.currentTarget.style.boxShadow = `0 0 0 0.5px ${theme.accent.soft}`
          }}
          onBlur={e => {
            e.currentTarget.style.borderColor = theme.border.default
            e.currentTarget.style.boxShadow = 'none'
          }}
        />
        {newTitle.trim() && (
          <button onClick={submit} style={{
            marginTop: 3, height: 20, borderRadius: 4, border: 'none', background: theme.accent.base,
            color: theme.text.inverse, fontSize: 10, fontWeight: 600, padding: '0 8px', cursor: 'pointer',
          }}>Add task</button>
        )}
      </div>

      {tasks.length === 0 ? (
        <EmptyState text="No tasks yet" />
      ) : (
        <>
          {pending.map(task => renderTaskRow(task))}
          {done.length > 0 && pending.length > 0 && <Divider />}
          {done.map(task => renderTaskRow(task, true))}
        </>
      )}
      {taskMenu && (
        <ContextMenu
          x={taskMenu.x}
          y={taskMenu.y}
          items={menuItemsForTask(taskMenu.task)}
          onClose={() => setTaskMenu(null)}
        />
      )}
    </div>
  )
}

function ToolsPanel({ tools }: { tools: ToolItem[] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {tools.length === 0 ? (
        <EmptyState text="No tool calls yet" />
      ) : (
        tools.slice().reverse().map(t => (
          <div key={t.id} style={{ padding: '5px 12px', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <div style={{ marginTop: 1, flexShrink: 0 }}><ToolStatusIcon status={t.status} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              {t.input && <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.input}</div>}
              {t.elapsed != null && t.status === 'done' && (
                <div style={{ fontSize: 9, color: theme.text.disabled, marginTop: 1 }}>{(t.elapsed / 1000).toFixed(1)}s</div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function SkillsPanel({ skills, onToggle }: {
  skills: SkillConfig[]
  onToggle: (id: string) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const builtin = skills.filter(s => s.source === 'builtin')
  const mcpGroups = new Map<string, SkillConfig[]>()
  for (const s of skills.filter(s => s.source === 'mcp')) {
    const key = s.server ?? 'MCP'
    if (!mcpGroups.has(key)) mcpGroups.set(key, [])
    mcpGroups.get(key)!.push(s)
  }

  const renderSkill = (s: SkillConfig) => (
    <div key={s.id} style={{ padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={() => onToggle(s.id)}
        style={{
          width: 28, height: 14, borderRadius: 7, border: 'none', cursor: 'pointer',
          background: s.enabled ? theme.accent.base : theme.surface.panelMuted, position: 'relative',
          transition: 'background 0.15s', flexShrink: 0, padding: 0,
        }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: 5, background: theme.text.inverse,
          position: 'absolute', top: 2, left: s.enabled ? 16 : 2,
          transition: 'left 0.15s',
        }} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fonts.secondarySize, color: s.enabled ? theme.text.secondary : theme.text.disabled, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
        {s.description && <div style={{ fontSize: 9, color: theme.text.disabled, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>}
      </div>
    </div>
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {skills.length === 0 ? (
        <EmptyState text="No skills available" />
      ) : (
        <>
          {builtin.length > 0 && (
            <>
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>Built-in</div>
              {builtin.map(renderSkill)}
            </>
          )}
          {[...mcpGroups.entries()].map(([server, list]) => (
            <React.Fragment key={server}>
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>{server}</div>
              {list.map(renderSkill)}
            </React.Fragment>
          ))}
        </>
      )}
    </div>
  )
}

function ContextPanel({ items, onAddNote, onRemoveItem }: {
  items: ContextItem[]
  onAddNote: (text: string) => void
  onRemoveItem: (id: string) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [note, setNote] = useState('')
  const submitNote = () => {
    const t = note.trim()
    if (t) { onAddNote(t); setNote('') }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', display: 'flex', flexDirection: 'column' }}>
      {/* Note input */}
      <div style={{ padding: '4px 8px', flexShrink: 0 }}>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNote() } }}
          placeholder="Add a note..."
          rows={2}
          style={{
            width: '100%', borderRadius: 4, border: `1px solid ${theme.border.default}`, background: theme.surface.input,
            color: theme.text.secondary, fontSize: fonts.secondarySize, padding: '4px 6px', resize: 'vertical', outline: 'none',
            minHeight: 36, maxHeight: 100, lineHeight: 1.4,
          }}
          onFocus={e => (e.currentTarget.style.borderColor = theme.border.accent)}
          onBlur={e => (e.currentTarget.style.borderColor = theme.border.default)}
        />
        {note.trim() && (
          <button onClick={submitNote} style={{
            marginTop: 3, height: 20, borderRadius: 3, border: 'none', background: theme.accent.base,
            color: theme.text.inverse, fontSize: 10, fontWeight: 600, padding: '0 8px', cursor: 'pointer',
          }}>Save note</button>
        )}
      </div>

      {/* Context items list */}
      {items.length === 0 ? (
        <EmptyState text="No context items" />
      ) : (
        items.map(c => (
          <div key={c.id} style={{ padding: '4px 8px', display: 'flex', alignItems: 'flex-start', gap: 6, borderBottom: `1px solid ${theme.border.subtle}` }}>
            <span style={{ fontSize: 9, color: c.type === 'note' ? theme.accent.base : '#e2c08d', fontWeight: 600, marginTop: 2, flexShrink: 0 }}>
              {c.type === 'note' ? 'N' : 'F'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
              {c.type === 'note' && c.content && (
                <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.content.slice(0, 80)}</div>
              )}
            </div>
            <ActionBtn title="Remove" color={theme.text.disabled} onClick={() => onRemoveItem(c.id)}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </ActionBtn>
          </div>
        ))
      )}
    </div>
  )
}

function MessagePanel({ messages }: { messages: MessageItem[] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {messages.length === 0 ? (
        <EmptyState text="No messages yet" />
      ) : (
        messages.map(m => {
          const directionLabel = m.direction === 'inbound' ? 'From' : m.direction === 'outbound' ? 'To' : 'Message'
          const peer = m.direction === 'inbound' ? m.fromTileId : m.toTileId
          const peerLabel = peer ? `${peer.slice(0, 8)}` : 'system'
          const badgeColor = m.source === 'group' ? theme.accent.base : theme.text.muted
          return (
            <div key={m.id} style={{ padding: '6px 8px', borderBottom: `1px solid ${theme.border.subtle}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 2 }}>
                <span style={{ fontSize: 10, color: badgeColor, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                  {m.source === 'group' ? `#${m.channel}` : directionLabel}
                </span>
                <span style={{ fontSize: 9, color: theme.text.disabled }}>
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ fontSize: 10, color: theme.text.secondary, marginBottom: 1 }}>{peerLabel} · {m.subject}</div>
              {m.kind && <div style={{ fontSize: 9, color: theme.text.disabled }}>{m.kind}</div>}
            </div>
          )
        })
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return <div style={{ padding: '24px 12px', textAlign: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>{text}</div>
}

function Divider(): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return <div style={{ height: 1, background: theme.border.subtle, margin: '4px 12px' }} />
}

// ─── Tabbed drawer container ─────────────────────────────────────────────────

function DrawerPanel({ data, activeTab, onTabChange, onUpdateTask, onDeleteTask, onAddTask, onToggleSkill, onAddNote, onRemoveContext }: {
  data: DrawerData
  activeTab: DrawerTab
  onTabChange: (tab: DrawerTab) => void
  onUpdateTask: (id: string, status: TaskItem['status']) => void
  onDeleteTask: (id: string) => void
  onAddTask: (title: string) => void
  onToggleSkill: (id: string) => void
  onAddNote: (text: string) => void
  onRemoveContext: (id: string) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const counts: Record<DrawerTab, number> = {
    tasks: data.tasks.filter(t => t.status !== 'done').length,
    tools: data.tools.filter(t => t.status === 'running').length,
    skills: data.skills.filter(s => s.enabled).length,
    context: data.context.length,
    messages: data.messages.length,
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        minHeight: 38, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        borderBottom: `1px solid ${theme.border.subtle}`,
        padding: '5px 8px',
        gap: 4,
        overflowX: 'auto',
      }}>
        {ALL_TABS.map(tab => {
          const active = tab === activeTab
          const count = counts[tab]
          return (
            <TabButton
              key={tab}
              tab={tab}
              active={active}
              count={count}
              onClick={() => onTabChange(tab)}
            />
          )
        })}
      </div>

      {/* Active panel */}
      <div style={{ padding: '10px 14px 7px', borderBottom: `1px solid ${theme.border.subtle}`, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ fontSize: fonts.secondarySize, fontWeight: 700, color: theme.text.secondary, letterSpacing: 0.7, textTransform: 'uppercase', lineHeight: 1 }}>
          {drawerTabTitle(activeTab)}
        </div>
      </div>
      {activeTab === 'tasks' && <TasksPanel tasks={data.tasks} onUpdateTask={onUpdateTask} onDeleteTask={onDeleteTask} onAddTask={onAddTask} />}
      {activeTab === 'tools' && <ToolsPanel tools={data.tools} />}
      {activeTab === 'skills' && <SkillsPanel skills={data.skills} onToggle={onToggleSkill} />}
      {activeTab === 'context' && <ContextPanel items={data.context} onAddNote={onAddNote} onRemoveItem={onRemoveContext} />}
      {activeTab === 'messages' && <MessagePanel messages={data.messages} />}
    </div>
  )
}

function TabButton({ tab, active, count, onClick }: {
  tab: DrawerTab; active: boolean; count: number; onClick: () => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      title={drawerTabTitle(tab)}
      aria-label={drawerTabTitle(tab)}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 28,
        minWidth: 32,
        background: 'transparent',
        border: 'none',
        borderRadius: 7,
        cursor: 'pointer',
        color: active ? theme.accent.base : (h ? theme.text.secondary : theme.text.muted),
        padding: '0 9px',
        transition: 'color 0.15s',
        flex: 1,
      }}
    >
      <TabIcon tab={tab} />
      {count > 0 && (
        <span style={{
          position: 'absolute',
          top: 2,
          right: 4,
          fontSize: 8,
          fontWeight: 700,
          color: active ? theme.accent.base : (h ? theme.text.secondary : theme.text.muted),
          minWidth: 10,
          textAlign: 'center',
          lineHeight: 1,
        }}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}

// ─── Activity store persistence ─────────────────────────────────────────────

function persistToActivityStore(
  workspaceId: string | undefined,
  tileId: string,
  evt: { type: string; payload: Record<string, unknown>; id: string },
): void {
  if (!workspaceId || !window.electron?.activity) return
  const p = evt.payload as any

  if (evt.type === 'task') {
    window.electron.activity.upsert(workspaceId, {
      id: p.task_id ?? p.id ?? evt.id,
      tileId,
      type: 'task',
      status: p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : p.status === 'in-progress' ? 'running' : 'pending',
      title: p.title ?? 'Untitled task',
      detail: p.detail,
      metadata: p,
    })
  }

  if (evt.type === 'tool_start' || evt.type === 'tool') {
    window.electron.activity.upsert(workspaceId, {
      id: p.tool_id ?? p.id ?? evt.id,
      tileId,
      type: 'tool',
      status: evt.type === 'tool_start' ? 'running' : (p.error ? 'error' : 'done'),
      title: p.name ?? p.tool ?? 'Unknown tool',
      detail: p.input?.toString()?.slice(0, 200),
      metadata: p,
    })
  }

  if (evt.type === 'file' || evt.type === 'file_activity') {
    window.electron.activity.upsert(workspaceId, {
      id: p.file_id ?? evt.id,
      tileId,
      type: 'skill',
      status: 'done',
      title: p.path ?? p.file ?? 'unknown',
      detail: p.action,
      metadata: p,
    })
  }

  if (evt.type === 'note' || evt.type === 'notification' || evt.type === 'progress') {
    window.electron.activity.upsert(workspaceId, {
      id: evt.id,
      tileId,
      type: 'context',
      status: 'done',
      title: p.message ?? p.text ?? p.title ?? p.status ?? JSON.stringify(p).slice(0, 200),
      detail: p.source ?? evt.type,
      metadata: p,
    })
  }
}

// ─── Event processing helpers ────────────────────────────────────────────────

function processEvent(evt: { type: string; payload: Record<string, unknown>; id: string; timestamp: number }, setData: React.Dispatch<React.SetStateAction<DrawerData>>): void {
  const p = evt.payload as any

  if (evt.type === 'task') {
    if (p?.action === 'create' || (!p?.action && p?.title)) {
      setData(prev => {
        if (prev.tasks.some(t => t.id === (p.task_id ?? p.id))) return prev
        return { ...prev, tasks: [...prev.tasks, {
          id: p.task_id ?? p.id ?? evt.id,
          title: p.title ?? 'Untitled task',
          status: p.status ?? 'pending',
          detail: p.detail,
          timestamp: evt.timestamp,
        }]}
      })
    } else if (p?.action === 'update' && p?.task_id) {
      setData(prev => ({ ...prev, tasks: prev.tasks.map(t =>
        t.id === p.task_id
          ? { ...t, status: p.status ?? t.status, title: p.title ?? t.title, detail: p.detail ?? t.detail }
          : t
      )}))
    }
  }

  if (evt.type === 'tool_start' || evt.type === 'tool') {
    setData(prev => {
      const toolId = p?.tool_id ?? p?.id ?? evt.id
      if (evt.type === 'tool_start') {
        if (prev.tools.some(t => t.id === toolId)) return prev
        return { ...prev, tools: [...prev.tools, {
          id: toolId,
          name: p?.name ?? p?.tool ?? 'Unknown tool',
          status: 'running',
          input: typeof p?.input === 'string' ? p.input.slice(0, 120) : undefined,
          timestamp: evt.timestamp,
        }]}
      }
      // tool complete/update
      return { ...prev, tools: prev.tools.map(t =>
        t.id === toolId
          ? { ...t, status: p?.error ? 'error' : 'done', output: p?.output?.toString()?.slice(0, 120), elapsed: p?.elapsed }
          : t
      )}
    })
  }

  // Skills and context are managed interactively via the drawer, not from bus events.
  // Bus events for files/notes are persisted to the activity store but don't populate the drawer.
}

// ─── Main TileChrome ─────────────────────────────────────────────────────────

export function TileChrome({
  tile, workspaceId, workspaceDir, onClose, onActivate, onTitlebarMouseDown, onResizeMouseDown, onContextMenu,
  onExpandChange, children, isSelected, forceExpanded,
  busUnreadCount, onBusPopupToggle, showBusPopup, discoveryConnected, connectedPeers, titlebarColor: titlebarColorProp, titlebarExtra, busEvents
}: Props): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const { color: tileContextColor } = useTileColor()
  const titlebarColor = titlebarColorProp ?? tileContextColor
  const titlebarForeground = getTitlebarForeground(titlebarColor, theme.text.primary, '#3a2f00')
  const titlebarMuted = titlebarColor ? `${titlebarForeground}aa` : theme.text.disabled
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = forceExpanded ?? localExpanded
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<DrawerTab>('tasks')
  const [data, setData] = useState<DrawerData>({ tasks: [], tools: [], skills: [], context: [], messages: [] })
  const hasDrawer = DRAWER_TYPES.has(tile.type)
  const peerIds = React.useMemo(() => [...new Set((connectedPeers ?? []).filter(Boolean))], [connectedPeers])

  const toggle = () => {
    const next = !expanded
    setLocalExpanded(next)
    onExpandChange?.(next)
  }

  // ── Collab: auto-regenerate objective.md on drawer state change ────────
  const regenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const regenerateObjective = useCallback(() => {
    if (!workspaceDir) return
    if (regenTimer.current) clearTimeout(regenTimer.current)
    regenTimer.current = setTimeout(() => {
      const md = buildObjective({
        tileId: tile.id,
        tasks: data.tasks.map(t => ({
          id: t.id,
          title: t.title,
          status: (t.status === 'in-progress' ? 'running' : t.status) as ActivityStatus,
        })),
        skills: data.skills,
        context: data.context,
      })
      window.electron?.collab?.writeObjective(workspaceDir, tile.id, md)

      // Also sync state.json
      window.electron?.collab?.writeState(workspaceDir, tile.id, {
        tasks: data.tasks.map(t => ({
          id: t.id,
          title: t.title,
          status: (t.status === 'in-progress' ? 'running' : t.status) as ActivityStatus,
          createdAt: t.timestamp,
          updatedAt: Date.now(),
        })),
        paused: false,
      })

      // Sync skills.json
      window.electron?.collab?.writeSkills(workspaceDir, tile.id, {
        enabled: data.skills.filter(s => s.enabled).map(s => s.id),
        disabled: data.skills.filter(s => !s.enabled).map(s => s.id),
      })
    }, 1000)
  }, [workspaceDir, tile.id, data.tasks, data.skills, data.context])

  useEffect(() => { regenerateObjective() }, [regenerateObjective])
  useEffect(() => () => { if (regenTimer.current) clearTimeout(regenTimer.current) }, [])

  // ── Collab: ensure per-tile protocol dirs; state watcher only for drawer tiles ──
  useEffect(() => {
    if (!workspaceDir) return
    window.electron?.collab?.ensureDir(workspaceDir, tile.id)
    if (!hasDrawer) return
    window.electron?.collab?.watchState(workspaceDir, tile.id)
    return () => { window.electron?.collab?.unwatchState(workspaceDir, tile.id) }
  }, [workspaceDir, tile.id, hasDrawer])

  // ── Collab: listen for external state.json changes ─────────────────────
  useEffect(() => {
    if (!hasDrawer) return
    const unsub = window.electron?.collab?.onStateChanged((change: any) => {
      if (change.tileId !== tile.id) return
      const state = change.state
      if (!state?.tasks) return
      setData(prev => {
        const merged = [...prev.tasks]
        for (const t of state.tasks) {
          const idx = merged.findIndex(m => m.id === t.id)
          const mapped = t.status === 'running' ? 'in-progress' : t.status
          if (idx >= 0) {
            merged[idx] = { ...merged[idx], status: mapped, title: t.title ?? merged[idx].title }
          } else {
            merged.push({ id: t.id, title: t.title, status: mapped, timestamp: t.createdAt ?? Date.now() })
          }
        }
        return { ...prev, tasks: merged }
      })
    })
    return () => { unsub?.() }
  }, [tile.id, hasDrawer])

  // ── Drawer action callbacks ────────────────────────────────────────────
  const handleAddTask = useCallback((title: string) => {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setData(prev => ({ ...prev, tasks: [...prev.tasks, { id, title, status: 'pending', timestamp: Date.now() }] }))
    // Also publish bus event so MCP/agents can see it
    window.electron?.bus?.publish(`tile:${tile.id}`, 'task', 'drawer', { action: 'create', task_id: id, title, status: 'pending' })
  }, [tile.id])

  const handleUpdateTask = useCallback((id: string, status: TaskItem['status']) => {
    setData(prev => ({ ...prev, tasks: prev.tasks.map(t => t.id === id ? { ...t, status } : t) }))
    window.electron?.bus?.publish(`tile:${tile.id}`, 'task', 'drawer', { action: 'update', task_id: id, status })
  }, [tile.id])

  const handleDeleteTask = useCallback((id: string) => {
    setData(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== id) }))
  }, [])

  const handleToggleSkill = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      skills: prev.skills.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s),
    }))
  }, [])

  const handleAddNote = useCallback((text: string) => {
    const id = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const item: ContextItem = { id, name: text.slice(0, 40), type: 'note', content: text }
    setData(prev => ({ ...prev, context: [...prev.context, item] }))
    // Persist to .collab context folder
    if (workspaceDir) {
      window.electron?.collab?.addContext(workspaceDir, tile.id, 'notes.md',
        [...data.context.filter(c => c.type === 'note').map(c => c.content), text].join('\n\n'))
    }
  }, [workspaceDir, tile.id, data.context])

  const handleRemoveContext = useCallback((id: string) => {
    const item = data.context.find(c => c.id === id)
    setData(prev => ({ ...prev, context: prev.context.filter(c => c.id !== id) }))
    if (item?.type === 'file' && item.name && workspaceDir) {
      window.electron?.collab?.removeContext(workspaceDir, tile.id, item.name)
    }
  }, [workspaceDir, tile.id, data.context])

  const loadMessages = useCallback(async () => {
    if (!hasDrawer || !workspaceDir) return

    const peers = new Set(peerIds)
    const items: MessageItem[] = []
    const seen = new Set<string>()

    const pushMessage = (msg: MessageItem) => {
      if (seen.has(msg.id)) return
      seen.add(msg.id)
      items.push(msg)
    }

    const collabInboxes = await window.electron?.collab?.listMessages?.(workspaceDir, tile.id, 'inbox')
    const collabSent = await window.electron?.collab?.listMessages?.(workspaceDir, tile.id, 'sent')
    const collabMessages = [...(collabInboxes ?? []), ...(collabSent ?? [])]
    for (const msg of collabMessages) {
      const from = msg.meta.fromTileId
      const to = msg.meta.toTileId
      const peer = from === tile.id ? to : from
      if (!peers.has(peer) && peers.size > 0) continue
      const direction: MessageItem['direction'] = from === tile.id ? 'outbound' : 'inbound'
      pushMessage({
        id: msg.meta.id,
        source: 'direct',
        direction,
        fromTileId: from,
        toTileId: to,
        subject: msg.meta.subject || '(no subject)',
        type: msg.meta.type,
        kind: msg.meta.type,
        createdAt: msg.meta.createdTs,
        status: msg.meta.status,
        mailbox: msg.mailbox,
      })
    }

    items.sort((a, b) => b.createdAt - a.createdAt)
    setData(prev => ({ ...prev, messages: items }))
  }, [hasDrawer, workspaceDir, tile.id, peerIds.join(',')])

  useEffect(() => {
    if (!hasDrawer || !workspaceDir) return
    loadMessages()
    const interval = setInterval(() => { loadMessages() }, 15000)

    window.electron?.collab?.watchMessages(workspaceDir, tile.id)
    const unsubscribeMessageChanges = window.electron?.collab?.onMessageChanged((change: any) => {
      if (change?.workspacePath && change.workspacePath !== workspaceDir) return
      if (change.tileId !== tile.id) return
      if (change.mailbox === 'inbox' || change.mailbox === 'sent') {
        loadMessages()
      }
    })

    return () => {
      clearInterval(interval)
      window.electron?.collab?.unwatchMessages(workspaceDir, tile.id)
      unsubscribeMessageChanges?.()
    }
  }, [hasDrawer, workspaceDir, tile.id, loadMessages, peerIds.join(',')])

  // ── Load skills from MCP config on mount ───────────────────────────────
  useEffect(() => {
    if (!hasDrawer || !workspaceId) return
    window.electron?.mcp?.getMergedConfig(workspaceId).then((cfg: any) => {
      if (!cfg?.mcpServers) return
      const skills: SkillConfig[] = []
      for (const [server, conf] of Object.entries(cfg.mcpServers)) {
        const c = conf as any
        // Each MCP server is listed as a toggleable skill
        skills.push({
          id: `mcp:${server}`,
          name: server,
          enabled: true,
          source: 'mcp',
          server,
          description: c.url ?? c.command ?? 'MCP server',
        })
      }
      setData(prev => ({ ...prev, skills }))
    })
  }, [hasDrawer, workspaceId])

  // Listen for all event types on this tile's bus channel
  useEffect(() => {
    if (!hasDrawer) return
    const channel = `tile:${tile.id}`
    const unsub = window.electron?.bus?.subscribe(channel, `drawer:${tile.id}`, (event: any) => {
      if (!event?.type) return
      processEvent(event, setData)
      persistToActivityStore(workspaceId, tile.id, event)
    })
    return () => { unsub?.then?.(fn => fn?.()) ?? unsub?.() }
  }, [tile.id, hasDrawer, workspaceId])

  // Also extract from busEvents prop
  useEffect(() => {
    if (!busEvents || !hasDrawer) return
    for (const evt of busEvents) {
      processEvent(evt as any, setData)
    }
  }, [busEvents, hasDrawer])

  // Native mousedown listener on the titlebar
  const titlebarRef = useRef<HTMLDivElement>(null)
  const mouseDownRef = useRef(onTitlebarMouseDown)
  useEffect(() => { mouseDownRef.current = onTitlebarMouseDown })

  useEffect(() => {
    const el = titlebarRef.current
    if (!el) return
    const handler = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return
      mouseDownRef.current(e as unknown as React.MouseEvent)
    }
    el.addEventListener('mousedown', handler)
    return () => el.removeEventListener('mousedown', handler)
  }, [])

  const pendingTasks = data.tasks.filter(t => t.status !== 'done').length
  const totalActivity = pendingTasks + data.tools.filter(t => t.status === 'running').length

  return (
    <div
      data-tile-chrome="true"
      className="absolute"
      style={{
        left: tile.x, top: tile.y,
        width: tile.width, height: tile.height,
        zIndex: tile.zIndex,
        visibility: forceExpanded ? 'hidden' : 'visible',
        pointerEvents: forceExpanded ? 'none' : 'all',
      }}
      onDoubleClick={e => e.stopPropagation()}
      onMouseDownCapture={() => onActivate?.()}
    >
      {/* Drawer panel — sits behind the tile, slides right */}
      {hasDrawer && (
        <div style={{
          position: 'absolute',
          top: 5,
          bottom: 5,
          left: tile.width - 12,
          width: DRAWER_WIDTH + 12,
          background: theme.surface.panelMuted,
          borderRadius: 10,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.panel,
          zIndex: -1,
          transform: drawerOpen ? 'translateX(0)' : `translateX(-${DRAWER_WIDTH}px)`,
          transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          overflow: 'hidden',
          paddingLeft: 12,
        }}>
          <DrawerPanel
            data={data}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
            onAddTask={handleAddTask}
            onToggleSkill={handleToggleSkill}
            onAddNote={handleAddNote}
            onRemoveContext={handleRemoveContext}
          />
        </div>
      )}

      {/* Main tile panel */}
      <div
        className="flex flex-col"
        style={{
          width: '100%', height: '100%',
          borderRadius: getCurvierBlockRadius(tile.borderRadius), overflow: 'hidden',
          border: isSelected ? `1px solid ${theme.accent.base}` : `1px solid ${theme.border.default}`,
          boxShadow: isSelected
            ? `${theme.shadow.panel}, 0 0 0 1px ${theme.border.accent}`
            : theme.shadow.panel,
          background: theme.surface.panel,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Titlebar */}
        <div
          ref={titlebarRef}
          style={{
            height: tile.hideTitlebar ? 0 : 32,
            background: titlebarColor ?? theme.surface.titlebar,
            borderBottom: tile.hideTitlebar ? 'none' : titlebarColor ? 'none' : `1px solid ${theme.border.default}`,
            display: tile.hideTitlebar ? 'none' : 'flex',
            alignItems: 'center', justifyContent: 'space-between',
            padding: '0 8px 0 0', userSelect: 'none', flexShrink: 0, cursor: 'move',
            overflow: 'hidden',
          }}
          onDoubleClick={e => { e.stopPropagation(); toggle() }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e) }}
        >
          {/* Drag handle */}
          <div
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('application/tile-id', tile.id)
              e.dataTransfer.setData('application/tile-type', tile.type)
              e.dataTransfer.setData('application/tile-label', fileLabel(tile))
              e.dataTransfer.effectAllowed = 'link'
              const ghost = document.createElement('div')
              ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px'
              document.body.appendChild(ghost)
              e.dataTransfer.setDragImage(ghost, 0, 0)
              requestAnimationFrame(() => document.body.removeChild(ghost))
              e.stopPropagation()
            }}
            style={{
              width: 28, height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'grab', flexShrink: 0, color: titlebarMuted, fontSize: fonts.secondarySize
            }}
          >
            ::
          </div>

          {tile.type === 'browser' ? (
            <div
              id={`tile-header-slot-${tile.id}`}
              style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center' }}
            />
          ) : (
            <span style={{
              flex: 1, fontSize: fonts.size, fontWeight: 500, color: titlebarForeground,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {fileLabel(tile)}
            </span>
          )}

          {titlebarExtra && (
            <div data-no-drag="" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {titlebarExtra}
            </div>
          )}

          {discoveryConnected && (
            <div
              title="Nearby connection negotiated"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                marginRight: 8,
                background: theme.mode === 'light' ? 'rgba(53, 104, 255, 0.88)' : 'rgba(123, 241, 255, 0.88)',
                boxShadow: theme.mode === 'light'
                  ? '0 0 8px rgba(53, 104, 255, 0.34), 0 0 0 1px rgba(53, 104, 255, 0.12)'
                  : '0 0 8px rgba(123, 241, 255, 0.34), 0 0 0 1px rgba(123, 241, 255, 0.12)',
              }}
            />
          )}

          {/* Drawer toggle — only for terminal/chat */}
          {hasDrawer && (
            <button
              data-no-drag=""
              style={{
                width: 24, height: 24, borderRadius: 4, background: 'transparent',
                border: 'none', cursor: 'pointer', flexShrink: 0,
                color: drawerOpen ? theme.accent.base : theme.text.disabled,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative',
              }}
              onClick={e => { e.stopPropagation(); setDrawerOpen(p => !p) }}
              onMouseDown={e => e.stopPropagation()}
              onMouseEnter={e => { if (!drawerOpen) e.currentTarget.style.color = theme.text.muted }}
              onMouseLeave={e => { if (!drawerOpen) e.currentTarget.style.color = theme.text.disabled }}
              title={drawerOpen ? 'Hide panel' : 'Show panel'}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3.5h8M3 7h8M3 10.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              {totalActivity > 0 && !drawerOpen && (
                <span style={{
                  position: 'absolute', top: 1, right: 1,
                  minWidth: 12, height: 12, borderRadius: 6,
                  background: theme.accent.base, color: theme.text.inverse,
                  fontSize: 8, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 2px',
                }}>
                  {totalActivity > 9 ? '9+' : totalActivity}
                </span>
              )}
            </button>
          )}

          {/* Expand/collapse */}
          <button
            data-no-drag=""
            style={{
              width: 24, height: 24, borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', flexShrink: 0,
              color: theme.text.disabled, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            onClick={e => { e.stopPropagation(); toggle() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
            onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              {expanded ? (
                <path d="M3 5.5h8M3 8.5h8M5.5 3v8M8.5 3v8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              ) : (
                <path d="M2 2h4v4H2zM8 2h4v4H8zM2 8h4v4H2zM8 8h4v4H8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              )}
            </svg>
          </button>

          {/* Bus event indicator */}
          {(busUnreadCount ?? 0) > 0 && (
            <button
              data-no-drag=""
              onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
              onMouseDown={e => e.stopPropagation()}
              style={{
                minWidth: 18, height: 18, borderRadius: 9,
                background: theme.accent.base,
                border: 'none', cursor: 'pointer',
                color: theme.text.inverse, fontSize: 10, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 5px',
                marginLeft: 4,
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.accent.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = theme.accent.base)}
              title={`${busUnreadCount} new event${busUnreadCount !== 1 ? 's' : ''}`}
            >
              {busUnreadCount! > 99 ? '99+' : busUnreadCount}
            </button>
          )}

          <button
            data-no-drag=""
            style={{
              width: 24, height: 24, borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', flexShrink: 0,
              color: theme.text.disabled, display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: 4
            }}
            onClick={e => { e.stopPropagation(); onClose() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
            onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div
          style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative', userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
          onDragOver={e => { if (tile.type !== 'kanban') e.stopPropagation() }}
          onDrop={e => { if (tile.type !== 'kanban') e.stopPropagation() }}
        >
          {forceExpanded ? null : children}

          {/* Chromeless drag strip — when titlebar is hidden, this thin overlay
              at the top provides a reliable drag + right-click target so the
              tile is still movable and the context menu remains reachable. */}
          {tile.hideTitlebar && (
            <div
              data-chromeless-drag=""
              onMouseDown={e => { e.stopPropagation(); onTitlebarMouseDown(e) }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e) }}
              onDoubleClick={e => { e.stopPropagation(); toggle() }}
              style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: 24,
                cursor: 'grab',
                zIndex: 5,
                background: 'linear-gradient(to bottom, rgba(0,0,0,0.35), rgba(0,0,0,0))',
                opacity: 0,
                transition: 'opacity 120ms ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.7)',
                fontSize: 11,
                letterSpacing: 1,
                userSelect: 'none',
                pointerEvents: 'auto',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
            >
              ::::
            </div>
          )}
        </div>

        {(['n','s','e','w','ne','nw','se','sw'] as const).map(dir => (
          <ResizeHandle key={dir} dir={dir} onMouseDown={e => onResizeMouseDown(e, dir)} />
        ))}

        {/* Bus event popup */}
        {showBusPopup && busEvents && (
          <div
            data-no-drag=""
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 34, right: 4,
              width: 300, maxHeight: 280,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.default}`,
              borderRadius: 8,
              boxShadow: theme.shadow.panel,
              zIndex: 20,
              overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: '6px 10px',
              borderBottom: `1px solid ${theme.border.default}`,
              fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Events</span>
              <button
                onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
                style={{
                  background: 'none', border: 'none', color: theme.text.disabled, cursor: 'pointer', fontSize: fonts.secondarySize
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
              {busEvents.length === 0 ? (
                <div style={{ padding: '12px', textAlign: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>
                  No events yet
                </div>
              ) : (
                busEvents.slice(-30).reverse().map(evt => (
                  <div key={evt.id} style={{
                    padding: '4px 10px',
                    borderBottom: `1px solid ${theme.border.subtle}`,
                    fontSize: fonts.secondarySize,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{
                        color: evt.type === 'notification' ? theme.status.warning :
                               evt.type === 'progress' ? theme.accent.base :
                               evt.type === 'task' ? theme.status.success :
                               theme.text.muted,
                        fontWeight: 500,
                      }}>
                        {evt.type}
                      </span>
                      <span style={{ color: theme.text.disabled, fontSize: 10 }}>
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ color: theme.text.secondary }}>
                      {(evt.payload as any).message ?? (evt.payload as any).status ?? (evt.payload as any).title ?? JSON.stringify(evt.payload).slice(0, 80)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
