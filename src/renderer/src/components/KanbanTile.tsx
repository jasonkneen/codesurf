import React, { useState, useCallback, useEffect, useRef } from 'react'
import { KanbanCard, KanbanCardData } from './KanbanCard'
import { buildAgentBrief } from '../utils/agentBrief'
import { ActivityFeed, ActivityEvent } from './ActivityFeed'
import type { ActivityRecord } from '../../../shared/types'

interface KanbanColumn { id: string; title: string }

interface KanbanSavedState {
  columns: KanbanColumn[]
  cards: KanbanCardData[]
}

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  onFocusTile?: (tileId: string) => void
}

const COLORS = ['#0d2137','#0d2a1a','#2a0d1a','#1a1a0d','#1a0d2a','#0d1a2a','#2a1a0d','#0d2a2a']
const ACTIVE_TTL = 4000

const TERMINAL_POLL_MS = 450
const MAX_TASK_LOG = 240
const MAX_TASK_ENTRIES = 240
const MAX_BUFFER_BYTES = 8192

function normalizeTerminalData(data: string): string {
  // Strip ANSI escapes and control chars to keep terminal task logs readable
  const ansi = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
  return data
    .replace(ansi, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function trimTaskMessage(message: string): string {
  const noNewlines = message.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  if (noNewlines.length <= MAX_TASK_LOG) return noNewlines
  return `${noNewlines.slice(0, MAX_TASK_LOG - 1)}…`
}

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'running', title: 'Running' },
  { id: 'review',  title: 'Review' },
  { id: 'done',    title: 'Done' }
]

type KanbanMode = 'board' | 'overview'

// ─── Agent Overview (auto-generated from activity store) ────────────────────

const STATUS_ORDER: Record<string, number> = { running: 0, pending: 1, error: 2, done: 3 }
const STATUS_COLORS: Record<string, string> = {
  pending: '#8b949e', running: '#58a6ff', done: '#3fb950', error: '#f85149',
}
const TYPE_ICONS: Record<string, string> = {
  task: 'T', tool: 'W', file: 'F', note: 'N',
}

function AgentOverview({ workspaceId, onFocusTile }: {
  workspaceId: string
  onFocusTile?: (tileId: string) => void
}): JSX.Element {
  const [groups, setGroups] = useState<Record<string, ActivityRecord[]>>({})
  const [loading, setLoading] = useState(true)
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    if (!workspaceId || !window.electron?.activity) return
    window.electron.activity.byAgent(workspaceId).then((result: Record<string, ActivityRecord[]>) => {
      setGroups(result)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [workspaceId])

  useEffect(() => {
    refresh()
    refreshTimer.current = setInterval(refresh, 3000)
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current) }
  }, [refresh])

  const agentKeys = Object.keys(groups).sort((a, b) => {
    // Named agents first, tile:xxx fallbacks last
    const aIsTile = a.startsWith('tile:')
    const bIsTile = b.startsWith('tile:')
    if (aIsTile !== bIsTile) return aIsTile ? 1 : -1
    return a.localeCompare(b)
  })

  if (loading) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 12 }}>Loading activity...</div>
  }

  if (agentKeys.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#555' }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M9 12h6M12 9v6" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 12 }}>No activity yet</span>
        <span style={{ fontSize: 10, color: '#444', maxWidth: 200, textAlign: 'center', lineHeight: 1.4 }}>
          Activity from terminals and chats will appear here automatically, grouped by agent
        </span>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflowX: 'auto', overflowY: 'hidden' }}>
      {agentKeys.map((agentKey, i) => {
        const records = groups[agentKey]
        const sorted = [...records].sort((a, b) => {
          const sa = STATUS_ORDER[a.status] ?? 9
          const sb = STATUS_ORDER[b.status] ?? 9
          if (sa !== sb) return sa - sb
          return b.updatedAt - a.updatedAt
        })
        const running = records.filter(r => r.status === 'running').length
        const pending = records.filter(r => r.status === 'pending').length
        const done = records.filter(r => r.status === 'done').length
        const isAgent = !agentKey.startsWith('tile:')
        const label = isAgent ? agentKey : agentKey.replace('tile:', '').slice(0, 8)

        return (
          <div
            key={agentKey}
            style={{
              flex: 1, minWidth: 200, maxWidth: 320,
              display: 'flex', flexDirection: 'column',
              borderRight: i < agentKeys.length - 1 ? '1px solid #21262d' : 'none',
            }}
          >
            {/* Column header */}
            <div style={{
              padding: '8px 10px 6px', flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 6,
              borderBottom: '1px solid #21262d',
            }}>
              {running > 0 && (
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: '#58a6ff', boxShadow: '0 0 6px #58a6ff',
                  display: 'inline-block', flexShrink: 0,
                }} />
              )}
              <span style={{
                flex: 1, fontSize: 11, fontWeight: 700,
                color: isAgent ? '#58a6ff' : '#8b949e',
                textTransform: 'uppercase', letterSpacing: 0.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {label}
              </span>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {running > 0 && <StatusPill count={running} color="#58a6ff" />}
                {pending > 0 && <StatusPill count={pending} color="#8b949e" />}
                {done > 0 && <StatusPill count={done} color="#3fb950" />}
              </div>
            </div>

            {/* Records */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
              {sorted.map(record => (
                <ActivityRecordRow
                  key={record.id}
                  record={record}
                  onFocusTile={onFocusTile}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatusPill({ count, color }: { count: number; color: string }): JSX.Element {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color,
      background: `${color}18`, borderRadius: 8,
      padding: '1px 5px', minWidth: 16, textAlign: 'center',
    }}>
      {count}
    </span>
  )
}

function ActivityRecordRow({ record, onFocusTile }: {
  record: ActivityRecord
  onFocusTile?: (tileId: string) => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const statusColor = STATUS_COLORS[record.status] ?? '#555'
  const typeIcon = TYPE_ICONS[record.type] ?? '?'

  return (
    <div
      style={{
        padding: '5px 6px', marginBottom: 2,
        borderRadius: 5,
        background: hovered ? '#161b22' : 'transparent',
        display: 'flex', alignItems: 'flex-start', gap: 6,
        cursor: onFocusTile ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onFocusTile?.(record.tileId)}
      title={`${record.type} — ${record.status}\nTile: ${record.tileId.slice(0, 8)}\n${new Date(record.updatedAt).toLocaleString()}`}
    >
      {/* Status dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 3,
        border: `1.5px solid ${statusColor}`,
        background: record.status === 'running' ? statusColor : 'transparent',
      }} />

      {/* Type badge */}
      <span style={{
        fontSize: 8, fontWeight: 700, width: 14, height: 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 3, flexShrink: 0, marginTop: 1,
        color: statusColor, background: `${statusColor}15`,
      }}>
        {typeIcon}
      </span>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: '#c9d1d9',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {record.title}
        </div>
        {record.detail && (
          <div style={{
            fontSize: 10, color: '#555', marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {record.detail}
          </div>
        )}
      </div>

      {/* Time */}
      <span style={{ fontSize: 9, color: '#333', flexShrink: 0, marginTop: 2 }}>
        {new Date(record.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  )
}

// ─── Main KanbanTile ────────────────────────────────────────────────────────

export function KanbanTile({ tileId, workspaceId, workspaceDir, width, height, onFocusTile }: Props): JSX.Element {
  const [mode, setMode] = useState<KanbanMode>('board')
  const [columns, setColumns] = useState<KanbanColumn[]>(DEFAULT_COLUMNS)
  const [cards, setCards] = useState<KanbanCardData[]>([])
  const [loaded, setLoaded] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [addTitle, setAddTitle] = useState('')
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [activeTerminals, setActiveTerminals] = useState<Record<string, number>>({})
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([])
  const cleanupRefs = useRef<Record<string, () => void>>({})
  const terminalBufferRefs = useRef<Record<string, string>>({})
  const terminalFlushRefs = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Load saved kanban state on mount
  useEffect(() => {
    if (!workspaceId) return
    window.electron?.kanban?.load(workspaceId, tileId).then((saved: KanbanSavedState | null) => {
      if (saved) {
        if (saved.columns?.length) setColumns(saved.columns)
        if (saved.cards?.length) setCards(saved.cards)
      }
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [workspaceId, tileId])

  // Auto-save kanban state on changes (debounced)
  useEffect(() => {
    if (!loaded || !workspaceId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const state: KanbanSavedState = { columns, cards }
      window.electron?.kanban?.save(workspaceId, tileId, state)
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [columns, cards, loaded, workspaceId, tileId])

  const terminalTaskCards = cards.filter(c => c.linkedTileId && (c.linkedTileType === 'terminal' || !c.linkedTileType))
  const terminalCardIds = new Set(terminalTaskCards.map(c => c.id))

  const terminalEvents = activityLog.filter(e => e.type === 'terminal' && terminalCardIds.has(e.cardId))
  const terminalEventByCard = terminalEvents.reduce((acc, e) => {
    acc[e.cardId] = e
    return acc
  }, {} as Record<string, ActivityEvent>)

  const HEADER = 38
  const MIN_COL_W = 180

  const logActivity = useCallback((type: ActivityEvent['type'], cardId: string, message: string) => {
    setCards(prev => {
      const card = prev.find(c => c.id === cardId)
      setActivityLog(log => {
        const next = [...log, {
          id: `ev-${Date.now()}-${Math.random()}`,
          ts: Date.now(),
          cardId,
          cardTitle: card?.title ?? cardId,
          event: type,
          message,
          type
        }]
        return next.length > MAX_TASK_ENTRIES * 4 ? next.slice(-(MAX_TASK_ENTRIES * 4)) : next
      })
      return prev
    })
  }, [])

  // Watch linked standalone terminals for both activity pings and live output
  useEffect(() => {
    const terminalCards = cards.filter(c => c.linkedTileId && (c.linkedTileType === 'terminal' || !c.linkedTileType))
    const linkedIds = terminalCards.map(c => c.linkedTileId!)

    terminalCards.forEach(card => {
      const id = card.linkedTileId!
      if (cleanupRefs.current[id]) return
      const markActive = () => setActiveTerminals(prev => ({ ...prev, [id]: Date.now() }))
      const watchActive = window.electron?.terminal?.onActive?.(id, markActive)

      const flushOutput = (terminalId: string, cardId: string) => {
        const raw = terminalBufferRefs.current[terminalId]
        if (!raw) {
          terminalBufferRefs.current[terminalId] = ''
          return
        }
        terminalBufferRefs.current[terminalId] = ''
        const message = trimTaskMessage(normalizeTerminalData(raw))
        if (!message) return
        logActivity('terminal', cardId, message)
      }

      const watchData = window.electron?.terminal?.onData?.(id, (data: string) => {
        const clean = normalizeTerminalData(data)
        if (!clean) return
        const prev = terminalBufferRefs.current[id] ?? ''
        terminalBufferRefs.current[id] = prev.length >= MAX_BUFFER_BYTES
          ? prev.slice(-MAX_BUFFER_BYTES) + clean
          : prev + clean
        if (terminalFlushRefs.current[id]) return
        terminalFlushRefs.current[id] = setTimeout(() => {
          terminalFlushRefs.current[id] = undefined
          flushOutput(id, card.id)
        }, TERMINAL_POLL_MS)
      })

      cleanupRefs.current[id] = () => {
        watchActive?.()
        watchData?.()
        if (terminalFlushRefs.current[id]) {
          clearTimeout(terminalFlushRefs.current[id])
          terminalFlushRefs.current[id] = undefined
        }
        terminalBufferRefs.current[id] = ''
        delete terminalBufferRefs.current[id]
      }
    })

    Object.keys(cleanupRefs.current).forEach(id => {
      if (!linkedIds.includes(id)) {
        cleanupRefs.current[id]?.()
        delete cleanupRefs.current[id]
      }
    })
  }, [cards, logActivity])

  useEffect(() => () => Object.values(cleanupRefs.current).forEach(fn => fn()), [])

  const jumpToCard = (cardId: string) => {
    const el = document.querySelector(`[data-card-id="${cardId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleKanbanEvent = useCallback((event: string, data: any) => {
    if (event === 'card_complete') {
      logActivity('complete', data.cardId, data.summary ?? 'Task complete')
      setCards(prev => {
        const card = prev.find(c => c.id === data.cardId)
        if (!card) return prev
        const colIdx = columns.findIndex(c => c.id === card.columnId)
        const nextCol = data.nextCol
          ? columns.find(c => c.id === data.nextCol)
          : columns[colIdx + 1]
        if (!nextCol) return prev
        const note = data.summary ? [{ id: `c-${Date.now()}`, text: `Agent: ${data.summary}`, ts: Date.now() }] : []
        setTimeout(() => setCards(p => p.map(c => c.id === data.cardId ? { ...c, justMoved: false } : c)), 1500)
        return prev.map(c => c.id === data.cardId
          ? { ...c, columnId: nextCol.id, justMoved: true, comments: [...c.comments, ...note] }
          : c)
      })
    }

    if (event === 'card_update') {
      if (data.note) logActivity('update', data.cardId, data.note)
      setCards(prev => prev.map(c => {
        if (c.id !== data.cardId) return c
        const note = data.note ? [{ id: `c-${Date.now()}`, text: data.note, ts: Date.now() }] : []
        return { ...c, comments: [...c.comments, ...note] }
      }))
    }

    if (event === 'card_error') {
      logActivity('error', data.cardId, data.reason ?? 'Error')
      setCards(prev => {
        const card = prev.find(c => c.id === data.cardId)
        if (!card) return prev
        const lastCol = columns[columns.length - 1]
        const note = { id: `c-${Date.now()}`, text: `Error: ${data.reason}`, ts: Date.now() }
        return prev.map(c => c.id === data.cardId
          ? { ...c, columnId: lastCol.id, color: '#2a0d0d', comments: [...c.comments, note] }
          : c)
      })
    }

    if (event === 'canvas_event') {
      logActivity('custom', data.cardId, `${data.event}: ${JSON.stringify(data.data ?? {})}`)
    }

    if (event === 'input_requested') {
      const card = cards.find(c => c.id === data.cardId)
      setActivityLog(prev => [...prev, {
        id: `ev-${Date.now()}`,
        ts: Date.now(),
        cardId: data.cardId,
        cardTitle: card?.title ?? data.cardId,
        event: 'input_requested',
        message: data.question,
        type: 'input',
        question: data.question,
        options: data.options ?? [],
        answered: false
      }])
    }
  }, [columns, logActivity, cards])

  // Subscribe to SSE stream from MCP server
  useEffect(() => {
    let es: EventSource | null = null
    window.electron?.mcp?.getPort?.().then((port: number | null) => {
      if (!port) return
      es = new EventSource(`http://127.0.0.1:${port}/events?card_id=global`)
      const handle = (e: MessageEvent) => {
        try {
          const { cardId, ...rest } = JSON.parse(e.data)
          handleKanbanEvent(e.type, { cardId, ...rest })
        } catch { /**/ }
      }
      ;['card_complete','card_update','card_error','canvas_event'].forEach(ev => {
        es!.addEventListener(ev, handle as EventListener)
      })
    })
    return () => es?.close()
  }, [handleKanbanEvent])

  // Also listen via IPC (fallback for same-process events)
  useEffect(() => {
    const el = (window as any).electron?.mcp
    if (!el?.onKanban) return
    const cleanup = el.onKanban((event: string, data: any) => handleKanbanEvent(event, data))
    return cleanup
  }, [handleKanbanEvent])

  // Streaming handled by pty/xterm — no separate stream listener needed

  const isActive = (id?: string) => !!id && Date.now() - (activeTerminals[id] ?? 0) < ACTIVE_TTL

  const addCard = useCallback((colId: string) => {
    if (!addTitle.trim()) return
    setCards(prev => [...prev, {
      id: `card-${tileId}-${Date.now()}`,
      title: addTitle.trim(), description: '', instructions: '',
      agent: 'claude', tools: [], skillsAndCommands: [],
      fileRefs: [], cardRefs: [], mcpServers: [], hooks: [],
      columnId: colId, color: COLORS[prev.length % COLORS.length],
      launched: false, comments: [], attachments: []
    }])
    setAddTitle(''); setAddingTo(null)
  }, [tileId, addTitle])

  const launchCard = useCallback(async (cardId: string) => {
    const card = cards.find(c => c.id === cardId)
    if (!card || card.launched) return

    // Write the agent brief to disk
    const briefMd = buildAgentBrief(card, cards)
    let briefPath: string | undefined
    try {
      briefPath = await window.electron.fs.writeBrief(cardId, briefMd)
    } catch { /* non-fatal */ }

    // Store brief path on card so MiniTerminal can use it
    const colIdx = columns.findIndex(col => col.id === card.columnId)
    const targetCol = colIdx === 0 ? (columns[1] ?? columns[0]) : columns[colIdx]
    setCards(prev => prev.map(c =>
      c.id === cardId ? { ...c, launched: true, columnId: targetCol.id, briefPath } : c
    ))
  }, [cards, columns])

  const updateCard = useCallback((id: string, patch: Partial<KanbanCardData>) => {
    setCards(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
  }, [])

  const removeCard = useCallback((id: string) => {
    const card = cards.find(c => c.id === id)
    if (card?.linkedTileId) window.electron?.terminal?.destroy?.(card.linkedTileId)
    setCards(prev => prev.filter(c => c.id !== id))
  }, [cards])

  const dropOnCol = useCallback((colId: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    if (dragging) {
      setCards(prev => prev.map(c => c.id === dragging ? { ...c, columnId: colId } : c))
      setDragging(null)
      return
    }
    // Group dragged from canvas label bar
    const linkedGroupId = e.dataTransfer.getData('application/group-id')
    const groupLabel = e.dataTransfer.getData('application/group-label')
    if (linkedGroupId) {
      let tileIds: string[] = []
      let tileTypes: string[] = []
      try { tileIds = JSON.parse(e.dataTransfer.getData('application/group-tile-ids') || '[]') } catch { /**/ }
      try { tileTypes = JSON.parse(e.dataTransfer.getData('application/group-tile-types') || '[]') } catch { /**/ }
      const typeSummary = [...new Set(tileTypes)].join(', ')
      const cardId = `card-${tileId}-${Date.now()}`
      setCards(prev => [...prev, {
        id: cardId,
        title: groupLabel || 'Group',
        description: `Group with ${tileIds.length} tile${tileIds.length !== 1 ? 's' : ''} (${typeSummary})`,
        instructions: '', agent: 'claude',
        tools: [], skillsAndCommands: [], fileRefs: [], cardRefs: [],
        mcpServers: [], hooks: [],
        columnId: colId, color: COLORS[prev.length % COLORS.length],
        linkedGroupId,
        linkedTileIds: tileIds,
        launched: false,
        comments: [], attachments: []
      }])
      window.electron?.bus?.publish(`kanban:${tileId}`, 'task', `kanban:${tileId}`, {
        action: 'group_linked', cardId, groupId: linkedGroupId, tileIds, column: colId
      })
      return
    }
    // Tile dragged from canvas titlebar
    const linkedTileId = e.dataTransfer.getData('application/tile-id')
    const linkedTileType = e.dataTransfer.getData('application/tile-type')
    const linkedTileLabel = e.dataTransfer.getData('application/tile-label')
    if (linkedTileId) {
      const tileCardId = `card-${tileId}-${Date.now()}`
      setCards(prev => [...prev, {
        id: tileCardId,
        title: linkedTileLabel || linkedTileType,
        description: '', instructions: '', agent: 'claude',
        tools: [], skillsAndCommands: [], fileRefs: [], cardRefs: [],
        mcpServers: [], hooks: [],
        columnId: colId, color: COLORS[prev.length % COLORS.length],
        linkedTileId, linkedTileType,
        launched: linkedTileType === 'terminal',
        comments: [], attachments: []
      }])
      window.electron?.bus?.publish(`kanban:${tileId}`, 'task', `kanban:${tileId}`, {
        action: 'tile_linked', cardId: tileCardId, linkedTileId, tileType: linkedTileType, column: colId
      })
      return
    }
    // File from sidebar
    const filePath = e.dataTransfer.getData('text/plain')
    if (filePath) {
      const name = filePath.split('/').pop() ?? filePath
      setCards(prev => [...prev, {
        id: `card-${tileId}-${Date.now()}`,
        title: name, description: filePath,
        instructions: '', agent: 'claude',
        tools: [], skillsAndCommands: [], fileRefs: [filePath], cardRefs: [],
        mcpServers: [], hooks: [],
        columnId: colId, color: COLORS[prev.length % COLORS.length],
        launched: false, comments: [],
        attachments: [{ id: `a-${Date.now()}`, name, path: filePath }]
      }])
    }
  }, [dragging, tileId])

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#13151a', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ height: HEADER, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', borderBottom: '1px solid #21262d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #30363d' }}>
            {(['board', 'overview'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  fontSize: 10, fontWeight: mode === m ? 700 : 400,
                  padding: '2px 8px', border: 'none', cursor: 'pointer',
                  background: mode === m ? '#21262d' : 'transparent',
                  color: mode === m ? '#58a6ff' : '#555',
                  fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: 0.5,
                }}
              >
                {m}
              </button>
            ))}
          </div>

          {mode === 'board' && (
            <>
              <span style={{ fontSize: 10, color: '#444', background: '#1c2128', border: '1px solid #30363d', borderRadius: 10, padding: '1px 7px' }}>
                {cards.length} card{cards.length !== 1 ? 's' : ''}
              </span>
              {Object.keys(activeTerminals).filter(id => isActive(id)).length > 0 && (
                <span style={{ fontSize: 10, color: '#3fb950', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 6px #3fb950', display: 'inline-block' }} />
                  {Object.keys(activeTerminals).filter(id => isActive(id)).length} active
                </span>
              )}
            </>
          )}
        </div>
        {mode === 'board' && (
          <button
            onClick={() => setColumns(prev => [...prev, { id: `col-${Date.now()}`, title: 'New List' }])}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, background: '#21262d', color: '#8b949e', border: '1px solid #30363d', cursor: 'pointer', fontFamily: 'inherit' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#58a6ff'; e.currentTarget.style.background = '#2d333b' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#8b949e'; e.currentTarget.style.background = '#21262d' }}
          >+ List</button>
        )}
      </div>

      {/* Overview mode */}
      {mode === 'overview' && (
        <AgentOverview workspaceId={workspaceId} onFocusTile={onFocusTile} />
      )}

      {/* Board mode — terminal task activity */}
      {mode === 'board' && terminalTaskCards.length > 0 && (
        <div style={{ borderBottom: '1px solid #21262d', background: '#0b1017', padding: '4px 8px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#58a6ff', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>Task Activity</div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
            {terminalTaskCards.map(card => {
              const ev = terminalEventByCard[card.id]
              const hasAny = !!ev
              const isLive = hasAny && Date.now() - ev.ts < ACTIVE_TTL * 2
              return (
                <button
                  key={card.id}
                  onClick={() => jumpToCard(card.id)}
                  style={{
                    fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer',
                    borderRadius: 6, border: `1px solid ${isLive ? '#3fb95055' : '#30363d'}`,
                    background: isLive ? '#162e20' : '#121820',
                    padding: 7, minWidth: 180, maxWidth: 280,
                    color: '#c9d1d9',
                    display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0
                  }}
                  title={`Jump to ${card.title}`}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#58a6ff66' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = isLive ? '#3fb95055' : '#30363d' }}
                >
                  <span style={{ fontSize: 11, color: '#58a6ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.title}</span>
                  <span style={{ fontSize: 10, color: hasAny ? '#8b949e' : '#333', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isLive ? '#3fb950' : '#30363d', boxShadow: isLive ? '0 0 6px #3fb950' : 'none', display: 'inline-block' }} />
                    {hasAny ? ev.message : 'No terminal output yet'}
                  </span>
                  <span style={{ fontSize: 9, color: '#555', letterSpacing: 0.2 }}>
                    {hasAny ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '---'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Columns (board mode only) */}
      {mode === 'board' && <div style={{ flex: 1, display: 'flex', overflowX: 'auto', overflowY: 'hidden' }}>
        {columns.map((col, ci) => {
          const colCards = cards.filter(c => c.columnId === col.id)
          const isOver = dragOver === col.id
          return (
            <div key={col.id}
              style={{
                flex: 1,
                minWidth: MIN_COL_W,
                width: 0,
                display: 'flex', flexDirection: 'column',
                borderRight: ci < columns.length - 1 ? '1px solid #21262d' : 'none',
                background: isOver ? '#161b22' : 'transparent',
                transition: 'background 0.1s'
              }}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(col.id) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null) }}
              onDrop={e => { e.stopPropagation(); dropOnCol(col.id, e) }}
            >
              {/* Column header */}
              <div style={{ padding: '8px 10px 4px', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {renamingCol === col.id ? (
                  <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { setColumns(p => p.map(c => c.id === col.id ? { ...c, title: renameVal } : c)); setRenamingCol(null) } if (e.key === 'Escape') setRenamingCol(null) }}
                    onBlur={() => { setColumns(p => p.map(c => c.id === col.id ? { ...c, title: renameVal } : c)); setRenamingCol(null) }}
                    style={{ flex: 1, fontSize: 11, fontWeight: 700, background: 'transparent', color: '#58a6ff', border: 'none', borderBottom: '1px solid #58a6ff', outline: 'none', textTransform: 'uppercase', letterSpacing: 0.5 }}
                  />
                ) : (
                  <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'text' }}
                    onDoubleClick={() => { setRenamingCol(col.id); setRenameVal(col.title) }}>
                    {col.title}
                  </span>
                )}
                <span style={{ fontSize: 10, color: '#444', background: '#1c2128', borderRadius: 8, padding: '1px 5px', border: '1px solid #21262d' }}>{colCards.length}</span>
                <button onClick={() => { cards.filter(c => c.columnId === col.id).forEach(c => c.linkedTileId && window.electron?.terminal?.destroy?.(c.linkedTileId)); setCards(p => p.filter(c => c.columnId !== col.id)); setColumns(p => p.filter(c => c.id !== col.id)) }}
                  style={{ fontSize: 10, color: '#2d333b', background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#ff7b72')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#2d333b')}
                >✕</button>
              </div>

              {/* Cards */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {colCards.map(card => (
                  <div key={card.id} data-card-id={card.id}>
                    <KanbanCard
                      card={card}
                      workspaceDir={workspaceDir}
                      active={isActive(card.linkedTileId)}
                      dragging={dragging === card.id}
                      isRunning={card.launched}
                      allCards={cards}
                      onUpdate={updateCard}
                      onRemove={removeCard}
                      onLaunch={launchCard}
                      onFocus={card.linkedTileId ? () => onFocusTile?.(card.linkedTileId!) : undefined}
                      onDragStart={() => setDragging(card.id)}
                      onDragEnd={() => { setDragging(null); setDragOver(null) }}
                    />
                  </div>
                ))}

                {/* Add card */}
                {addingTo === col.id ? (
                  <div style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: 6, padding: 8, flexShrink: 0 }}>
                    <input autoFocus value={addTitle} onChange={e => setAddTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') addCard(col.id); if (e.key === 'Escape') { setAddingTo(null); setAddTitle('') } }}
                      placeholder="Card title…"
                      style={{ width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 4, background: '#0d1117', color: '#e6edf3', border: '1px solid #58a6ff', outline: 'none', fontFamily: 'inherit', marginBottom: 6 }}
                    />
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button onClick={() => addCard(col.id)} style={{ flex: 1, padding: '4px 0', borderRadius: 4, background: '#1f6feb', color: '#fff', border: 'none', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
                      <button onClick={() => { setAddingTo(null); setAddTitle('') }} style={{ padding: '4px 8px', borderRadius: 4, background: '#21262d', color: '#8b949e', border: '1px solid #30363d', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setAddingTo(col.id); setAddTitle('') }}
                    style={{ width: '100%', padding: '5px 0', fontSize: 11, color: '#9dc7ff', background: 'rgba(88,166,255,0.12)', border: '1px dashed #79bcff', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0, fontWeight: 600 }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#d7eaff'; e.currentTarget.style.borderColor = '#9dc7ff'; e.currentTarget.style.background = 'rgba(88,166,255,0.24)' }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#9dc7ff'; e.currentTarget.style.borderColor = '#79bcff'; e.currentTarget.style.background = 'rgba(88,166,255,0.12)' }}
                  >+ Add card</button>
                )}
              </div>
            </div>
          )
        })}
      </div>}

      {mode === 'board' && (
        <ActivityFeed
          events={activityLog}
          onClearAll={() => setActivityLog([])}
          onJumpToCard={cardId => {
            const el = document.querySelector(`[data-card-id="${cardId}"]`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
          onReply={(eventId, cardId, message) => {
            // Find the terminal ID for this card and write the message to it
            const card = cards.find(c => c.id === cardId)
            if (card?.launched) {
              const termId = `kterm-${cardId}`
              window.electron?.terminal?.write?.(termId, message + '\r')
            }
            // Mark event as answered
            setActivityLog(prev => prev.map(ev => ev.id === eventId ? { ...ev, answered: true } : ev))
            // Log the reply
            setActivityLog(prev => [...prev, {
              id: `ev-${Date.now()}`,
              ts: Date.now(),
              cardId,
              cardTitle: card?.title ?? cardId,
              event: 'reply',
              message: `You: ${message}`,
              type: 'custom'
            }])
          }}
        />
      )}
    </div>
  )
}
