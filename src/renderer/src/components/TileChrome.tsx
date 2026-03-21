import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { TileState, SkillConfig, ContextItem, ActivityStatus } from '../../../shared/types'
import { buildObjective } from '../utils/objectiveBuilder'
import { ContextMenu, type MenuItem } from './ContextMenu'

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

type DrawerTab = 'tasks' | 'tools' | 'skills' | 'context'

interface DrawerData {
  tasks: TaskItem[]
  tools: ToolItem[]
  skills: SkillConfig[]
  context: ContextItem[]
}

// --- TileChrome props ---

interface Props {
  tile: TileState
  workspaceId?: string
  workspaceDir?: string
  onClose: () => void
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
  terminal: 'Terminal', note: 'Note', code: 'Code', image: 'Image', kanban: 'Board', browser: 'Browser', chat: 'Chat'
}

export function fileLabel(tile: TileState): string {
  if (!tile.filePath) return TYPE_LABELS[tile.type] ?? tile.type
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
  tasks: 'Tasks', tools: 'Tools', skills: 'Skills', context: 'Context'
}

const ALL_TABS: DrawerTab[] = ['tasks', 'tools', 'skills', 'context']

function drawerTabTitle(tab: DrawerTab): string {
  return TAB_LABELS[tab].toUpperCase()
}

// ─── Status icons ────────────────────────────────────────────────────────────

function TaskStatusIcon({ status }: { status: TaskItem['status'] }): JSX.Element {
  if (status === 'done') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#3fb950" strokeWidth="1.2" />
      <path d="M3.5 6l2 2 3-3.5" stroke="#3fb950" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  if (status === 'error') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#e54d2e" strokeWidth="1.2" />
      <path d="M4 4l4 4M8 4l-4 4" stroke="#e54d2e" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
  if (status === 'paused') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#ffb432" strokeWidth="1.2" />
      <path d="M4.5 4v4M7.5 4v4" stroke="#ffb432" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
  if (status === 'in-progress') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#4a9eff" strokeWidth="1.2" />
      <path d="M6 3v3.5l2.5 1.5" stroke="#4a9eff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#555" strokeWidth="1.2" />
    </svg>
  )
}

function ToolStatusIcon({ status }: { status: ToolItem['status'] }): JSX.Element {
  if (status === 'done') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#3fb950" strokeWidth="1.2" />
      <path d="M3.5 6l2 2 3-3.5" stroke="#3fb950" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  if (status === 'error') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#e54d2e" strokeWidth="1.2" />
      <path d="M4 4l4 4M8 4l-4 4" stroke="#e54d2e" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
  // running - pulsing dot
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#4a9eff" strokeWidth="1.2" />
      <circle cx="6" cy="6" r="2" fill="#4a9eff" opacity="0.6" />
    </svg>
  )
}

// ─── Drawer tab content panels ───────────────────────────────────────────────

// ── Small action button for task rows ───────────────────────────────────────

function ActionBtn({ title, color, onClick, children }: {
  title: string; color: string; onClick: () => void; children: React.ReactNode
}): JSX.Element {
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        width: 18, height: 18, borderRadius: 3, border: 'none', cursor: 'pointer',
        background: 'transparent', color, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, padding: 0,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
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
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <TaskStatusIcon status={task.status} />
      </button>
      <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: doneRow ? '#555' : '#bbb', textDecoration: doneRow ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task.title}
      </div>
      <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        {task.status === 'paused' ? (
          <ActionBtn title="Resume" color="#4a9eff" onClick={() => onUpdateTask(task.id, 'in-progress')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l5 3-5 3z" fill="currentColor"/></svg>
          </ActionBtn>
        ) : !doneRow ? (
          <ActionBtn title="Pause" color="#ffb432" onClick={() => onUpdateTask(task.id, 'paused')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2v6M7 2v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </ActionBtn>
        ) : null}
        {!doneRow && (
          <ActionBtn title="Done" color="#666" onClick={() => onUpdateTask(task.id, 'done')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5l2.5 2.5 3.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </ActionBtn>
        )}
        <ActionBtn title="Delete" color={doneRow ? '#444' : '#666'} onClick={() => onDeleteTask(task.id)}>
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
            width: '100%', borderRadius: 6, border: '0.5px solid rgba(255,255,255,0.12)', background: 'rgba(26,26,26,0.88)',
            color: '#ccc', fontSize: 11, padding: '4px 8px', resize: 'vertical', outline: 'none', minHeight: 36, maxHeight: 100, lineHeight: 1.4,
          }}
          onFocus={e => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'
            e.currentTarget.style.boxShadow = '0 0 0 0.5px rgba(74,158,255,0.18)'
          }}
          onBlur={e => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
            e.currentTarget.style.boxShadow = 'none'
          }}
        />
        {newTitle.trim() && (
          <button onClick={submit} style={{
            marginTop: 3, height: 20, borderRadius: 4, border: 'none', background: '#4a9eff',
            color: '#fff', fontSize: 10, fontWeight: 600, padding: '0 8px', cursor: 'pointer',
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
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {tools.length === 0 ? (
        <EmptyState text="No tool calls yet" />
      ) : (
        tools.slice().reverse().map(t => (
          <div key={t.id} style={{ padding: '5px 12px', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <div style={{ marginTop: 1, flexShrink: 0 }}><ToolStatusIcon status={t.status} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#bbb', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              {t.input && <div style={{ fontSize: 10, color: '#555', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.input}</div>}
              {t.elapsed != null && t.status === 'done' && (
                <div style={{ fontSize: 9, color: '#444', marginTop: 1 }}>{(t.elapsed / 1000).toFixed(1)}s</div>
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
          background: s.enabled ? '#4a9eff' : '#333', position: 'relative',
          transition: 'background 0.15s', flexShrink: 0, padding: 0,
        }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: 5, background: '#fff',
          position: 'absolute', top: 2, left: s.enabled ? 16 : 2,
          transition: 'left 0.15s',
        }} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: s.enabled ? '#bbb' : '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
        {s.description && <div style={{ fontSize: 9, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>}
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
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: '#555', letterSpacing: 1, textTransform: 'uppercase' }}>Built-in</div>
              {builtin.map(renderSkill)}
            </>
          )}
          {[...mcpGroups.entries()].map(([server, list]) => (
            <React.Fragment key={server}>
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: '#555', letterSpacing: 1, textTransform: 'uppercase' }}>{server}</div>
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
            width: '100%', borderRadius: 4, border: '1px solid #333', background: '#1a1a1a',
            color: '#ccc', fontSize: 11, padding: '4px 6px', resize: 'vertical', outline: 'none',
            minHeight: 36, maxHeight: 100, lineHeight: 1.4,
          }}
          onFocus={e => (e.currentTarget.style.borderColor = '#4a9eff')}
          onBlur={e => (e.currentTarget.style.borderColor = '#333')}
        />
        {note.trim() && (
          <button onClick={submitNote} style={{
            marginTop: 3, height: 20, borderRadius: 3, border: 'none', background: '#4a9eff',
            color: '#fff', fontSize: 10, fontWeight: 600, padding: '0 8px', cursor: 'pointer',
          }}>Save note</button>
        )}
      </div>

      {/* Context items list */}
      {items.length === 0 ? (
        <EmptyState text="No context items" />
      ) : (
        items.map(c => (
          <div key={c.id} style={{ padding: '4px 8px', display: 'flex', alignItems: 'flex-start', gap: 6, borderBottom: '1px solid #1a1a1a' }}>
            <span style={{ fontSize: 9, color: c.type === 'note' ? '#4a9eff' : '#e2c08d', fontWeight: 600, marginTop: 2, flexShrink: 0 }}>
              {c.type === 'note' ? 'N' : 'F'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
              {c.type === 'note' && c.content && (
                <div style={{ fontSize: 10, color: '#555', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.content.slice(0, 80)}</div>
              )}
            </div>
            <ActionBtn title="Remove" color="#555" onClick={() => onRemoveItem(c.id)}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </ActionBtn>
          </div>
        ))
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return <div style={{ padding: '24px 12px', textAlign: 'center', color: '#444', fontSize: 11 }}>{text}</div>
}

function Divider(): JSX.Element {
  return <div style={{ height: 1, background: '#1a1a1a', margin: '4px 12px' }} />
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
  const counts: Record<DrawerTab, number> = {
    tasks: data.tasks.filter(t => t.status !== 'done').length,
    tools: data.tools.filter(t => t.status === 'running').length,
    skills: data.skills.filter(s => s.enabled).length,
    context: data.context.length,
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        minHeight: 38, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid #222',
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
      <div style={{ padding: '10px 14px 7px', borderBottom: '1px solid #1b1b1b', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#98a2ad', letterSpacing: 0.7, textTransform: 'uppercase', lineHeight: 1 }}>
          {drawerTabTitle(activeTab)}
        </div>
      </div>
      {activeTab === 'tasks' && <TasksPanel tasks={data.tasks} onUpdateTask={onUpdateTask} onDeleteTask={onDeleteTask} onAddTask={onAddTask} />}
      {activeTab === 'tools' && <ToolsPanel tools={data.tools} />}
      {activeTab === 'skills' && <SkillsPanel skills={data.skills} onToggle={onToggleSkill} />}
      {activeTab === 'context' && <ContextPanel items={data.context} onAddNote={onAddNote} onRemoveItem={onRemoveContext} />}
    </div>
  )
}

function TabButton({ tab, active, count, onClick }: {
  tab: DrawerTab; active: boolean; count: number; onClick: () => void
}): JSX.Element {
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
        background: active ? '#21262d' : (h ? 'rgba(255,255,255,0.03)' : 'transparent'),
        border: `1px solid ${active ? '#30363d' : h ? '#2a2f38' : 'transparent'}`,
        borderRadius: 7,
        cursor: 'pointer',
        color: active ? '#58a6ff' : (h ? '#aeb8c4' : '#6f7782'),
        padding: '0 9px',
        transition: 'color 0.15s, background 0.15s, border-color 0.15s',
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
          color: active ? '#58a6ff' : (h ? '#aeb8c4' : '#6f7782'),
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
  tile, workspaceId, workspaceDir, onClose, onTitlebarMouseDown, onResizeMouseDown, onContextMenu,
  onExpandChange, children, isSelected, forceExpanded,
  busUnreadCount, onBusPopupToggle, showBusPopup, busEvents
}: Props): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = forceExpanded ?? localExpanded
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<DrawerTab>('tasks')
  const [data, setData] = useState<DrawerData>({ tasks: [], tools: [], skills: [], context: [] })
  const hasDrawer = DRAWER_TYPES.has(tile.type)

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

  // ── Collab: ensure .collab dir + start watcher on mount ────────────────
  useEffect(() => {
    if (!workspaceDir || !hasDrawer) return
    window.electron?.collab?.ensureDir(workspaceDir, tile.id)
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
    >
      {/* Drawer panel — sits behind the tile, slides right */}
      {hasDrawer && (
        <div style={{
          position: 'absolute',
          top: 5,
          bottom: 5,
          left: tile.width - 12,
          width: DRAWER_WIDTH + 12,
          background: '#141414',
          borderRadius: 10,
          border: '1px solid #252525',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
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
          borderRadius: 8, overflow: 'hidden',
          border: isSelected ? '0.5px solid #4a9eff' : '1px solid #3a3a3a',
          boxShadow: isSelected
            ? '0 8px 32px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(74,158,255,0.3)'
            : '0 4px 20px rgba(0,0,0,0.4)',
          background: '#1e1e1e',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Titlebar */}
        <div
          ref={titlebarRef}
          style={{
            height: 32, background: '#252525', borderBottom: '1px solid #333',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 8px 0 0', userSelect: 'none', flexShrink: 0, cursor: 'move'
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
              cursor: 'grab', flexShrink: 0, color: '#666', fontSize: 11
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
              flex: 1, fontSize: 12, fontWeight: 500, color: '#cccccc',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {fileLabel(tile)}
            </span>
          )}

          {/* Drawer toggle — only for terminal/chat */}
          {hasDrawer && (
            <button
              data-no-drag=""
              style={{
                width: 24, height: 24, borderRadius: 4, background: 'transparent',
                border: 'none', cursor: 'pointer', flexShrink: 0,
                color: drawerOpen ? '#4a9eff' : '#666',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative',
              }}
              onClick={e => { e.stopPropagation(); setDrawerOpen(p => !p) }}
              onMouseDown={e => e.stopPropagation()}
              onMouseEnter={e => { if (!drawerOpen) e.currentTarget.style.color = '#aaa' }}
              onMouseLeave={e => { if (!drawerOpen) e.currentTarget.style.color = '#666' }}
              title={drawerOpen ? 'Hide panel' : 'Show panel'}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3.5h8M3 7h8M3 10.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              {totalActivity > 0 && !drawerOpen && (
                <span style={{
                  position: 'absolute', top: 1, right: 1,
                  minWidth: 12, height: 12, borderRadius: 6,
                  background: '#4a9eff', color: '#fff',
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
              color: '#666', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            onClick={e => { e.stopPropagation(); toggle() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
            onMouseLeave={e => (e.currentTarget.style.color = '#666')}
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
                background: '#4a9eff',
                border: 'none', cursor: 'pointer',
                color: '#fff', fontSize: 10, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 5px',
                marginLeft: 4,
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#5ab0ff')}
              onMouseLeave={e => (e.currentTarget.style.background = '#4a9eff')}
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
              color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: 4
            }}
            onClick={e => { e.stopPropagation(); onClose() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = '#ff5f56')}
            onMouseLeave={e => (e.currentTarget.style.color = '#666')}
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
              background: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              zIndex: 20,
              overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: '6px 10px',
              borderBottom: '1px solid #2d2d2d',
              fontSize: 11, fontWeight: 600, color: '#888',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Events</span>
              <button
                onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
                style={{
                  background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
              {busEvents.length === 0 ? (
                <div style={{ padding: '12px', textAlign: 'center', color: '#555', fontSize: 11 }}>
                  No events yet
                </div>
              ) : (
                busEvents.slice(-30).reverse().map(evt => (
                  <div key={evt.id} style={{
                    padding: '4px 10px',
                    borderBottom: '1px solid #1f1f1f',
                    fontSize: 11,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{
                        color: evt.type === 'notification' ? '#ffb432' :
                               evt.type === 'progress' ? '#4a9eff' :
                               evt.type === 'task' ? '#66bb6a' :
                               '#888',
                        fontWeight: 500,
                      }}>
                        {evt.type}
                      </span>
                      <span style={{ color: '#555', fontSize: 10 }}>
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ color: '#aaa' }}>
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
