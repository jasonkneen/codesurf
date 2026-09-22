/**
 * Tile chrome drawer panels (tasks/tools/skills/context/messages).
 */
import React, { useState, useRef } from 'react'
import type { SkillConfig, ContextItem } from '../../../../shared/types'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import type {
  TaskItem,
  ToolItem,
  AvailableToolItem,
  MessageItem,
  DrawerTab,
  DrawerData,
} from './types'

// ─── Tab icons (12x12 SVGs) ──────────────────────────────────────────────────

export function TabIcon({ tab }: { tab: DrawerTab }): JSX.Element {
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

export const TAB_LABELS: Record<DrawerTab, string> = {
  tasks: 'Tasks', tools: 'Tools Available', skills: 'Skills', context: 'Context', messages: 'Messages'
}

export const ALL_TABS: DrawerTab[] = ['tasks', 'tools', 'skills', 'context', 'messages']

export function drawerTabTitle(tab: DrawerTab): string {
  return TAB_LABELS[tab].toUpperCase()
}

// ─── Status icons ────────────────────────────────────────────────────────────

function TaskStatusIcon({ status }: { status: TaskItem['status'] }): JSX.Element {
  const theme = useTheme()
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

function TasksPanel({ tasks, onUpdateTask, onDeleteTask, onAddTask, readOnly = false }: {
  tasks: TaskItem[]
  onUpdateTask: (id: string, status: TaskItem['status']) => void
  onDeleteTask: (id: string) => void
  onAddTask: (title: string) => void
  readOnly?: boolean
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
        {!readOnly && !doneRow && (
          <ActionBtn title="Done" color={theme.text.muted} onClick={() => onUpdateTask(task.id, 'done')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5l2.5 2.5 3.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </ActionBtn>
        )}
        {!readOnly && (
          <ActionBtn title="Delete" color={doneRow ? theme.text.disabled : theme.text.muted} onClick={() => onDeleteTask(task.id)}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          </ActionBtn>
        )}
      </div>
    </div>
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', display: 'flex', flexDirection: 'column' }}>
      {!readOnly && (
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
              color: theme.text.secondary, fontSize: fonts.secondarySize, fontWeight: fonts.secondaryWeight, padding: '4px 8px', resize: 'vertical', outline: 'none', minHeight: 36, maxHeight: 100, lineHeight: fonts.secondaryLineHeight,
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
      )}

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

function ToolsPanel({ tools, availableTools }: { tools: ToolItem[]; availableTools: AvailableToolItem[] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const availableBySource = {
    builtin: availableTools.filter(tool => tool.source === 'builtin'),
    peer: availableTools.filter(tool => tool.source === 'peer'),
    mcp: availableTools.filter(tool => tool.source === 'mcp-server'),
  }

  const renderAvailableGroup = (
    label: string,
    items: AvailableToolItem[],
    sourceColor: string,
  ): JSX.Element | null => {
    if (items.length === 0) return null
    return (
      <>
        <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>
          {label}
        </div>
        {items.map(item => (
          <div key={item.id} style={{ padding: '5px 12px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ marginTop: 3, width: 6, height: 6, borderRadius: '50%', background: sourceColor, flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </div>
              {item.detail && (
                <div style={{ fontSize: 10, color: theme.text.disabled, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.detail}
                </div>
              )}
            </div>
          </div>
        ))}
      </>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {availableTools.length === 0 && tools.length === 0 ? (
        <EmptyState text="No tools available" />
      ) : (
        <>
          {availableTools.length > 0 && (
            <>
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>
                Available now
              </div>
              {renderAvailableGroup('Built-in', availableBySource.builtin, theme.accent.base)}
              {renderAvailableGroup('Connected peers', availableBySource.peer, theme.status.success)}
              {renderAvailableGroup('MCP servers', availableBySource.mcp, theme.status.warning)}
            </>
          )}

          {tools.length > 0 && (
            <>
              {availableTools.length > 0 && <Divider />}
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>
                Recent tool activity
              </div>
              {tools.slice().reverse().map(t => (
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
              ))}
            </>
          )}
        </>
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
  const workspace = skills.filter(s => s.source === 'workspace')
  const commands = skills.filter(s => s.source === 'command')
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
          width: 28, height: 14, borderRadius: 8, border: 'none', cursor: 'pointer',
          background: s.enabled ? theme.accent.base : theme.surface.panelMuted, position: 'relative',
          transition: 'background 0.15s', flexShrink: 0, padding: 0,
        }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: 6, background: theme.text.inverse,
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
          {workspace.length > 0 && (
            <>
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>Workspace Skills</div>
              {workspace.map(renderSkill)}
            </>
          )}
          {commands.length > 0 && (
            <>
              <div style={{ padding: '6px 8px 2px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase' }}>Commands</div>
              {commands.map(renderSkill)}
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
            minHeight: 36, maxHeight: 100, lineHeight: fonts.secondaryLineHeight,
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
            <span style={{ fontSize: 9, color: c.type === 'note' ? theme.accent.base : theme.status.warning, fontWeight: 600, marginTop: 2, flexShrink: 0 }}>
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
  return <div style={{ height: 1, background: theme.border.subtle, margin: '4px 12px' }} />
}

// ─── Tabbed drawer container ─────────────────────────────────────────────────

export function DrawerPanel({ data, activeTab, onTabChange, onUpdateTask, onDeleteTask, onAddTask, onToggleSkill, onAddNote, onRemoveContext, tasksReadOnly = false }: {
  data: DrawerData
  activeTab: DrawerTab
  onTabChange: (tab: DrawerTab) => void
  onUpdateTask: (id: string, status: TaskItem['status']) => void
  onDeleteTask: (id: string) => void
  onAddTask: (title: string) => void
  onToggleSkill: (id: string) => void
  onAddNote: (text: string) => void
  onRemoveContext: (id: string) => void
  tasksReadOnly?: boolean
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const counts: Record<DrawerTab, number> = {
    tasks: data.tasks.filter(t => t.status !== 'done').length,
    tools: data.availableTools.length > 0 ? data.availableTools.length : data.tools.filter(t => t.status === 'running').length,
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
      {activeTab === 'tasks' && <TasksPanel tasks={data.tasks} onUpdateTask={onUpdateTask} onDeleteTask={onDeleteTask} onAddTask={onAddTask} readOnly={tasksReadOnly} />}
      {activeTab === 'tools' && <ToolsPanel tools={data.tools} availableTools={data.availableTools} />}
      {activeTab === 'skills' && <SkillsPanel skills={data.skills} onToggle={onToggleSkill} />}
      {activeTab === 'context' && <ContextPanel items={data.context} onAddNote={onAddNote} onRemoveItem={onRemoveContext} />}
      {activeTab === 'messages' && <MessagePanel messages={data.messages} />}
    </div>
  )
}

export function TabButton({ tab, active, count, onClick }: {
  tab: DrawerTab; active: boolean; count: number; onClick: () => void
}): JSX.Element {
  const theme = useTheme()
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
