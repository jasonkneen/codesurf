import React, { useState, useCallback, useEffect, useRef } from 'react'
import { KanbanCard, KanbanCardData } from './KanbanCard'
import { buildAgentBrief } from '../utils/agentBrief'
import { ActivityFeed, ActivityEvent } from './ActivityFeed'
import type { ActivityHealthSnapshot, ActivityRecord } from '../../../shared/types'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { hasCapability } from '../platform/capabilities'

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

const COLORS = [
  'rgba(88, 166, 255, 0.16)',
  'rgba(52, 211, 153, 0.16)',
  'rgba(192, 132, 252, 0.16)',
  'rgba(251, 191, 36, 0.16)',
  'rgba(244, 114, 182, 0.16)',
  'rgba(96, 165, 250, 0.14)',
  'rgba(45, 212, 191, 0.15)',
  'rgba(248, 113, 113, 0.15)',
]
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
const TYPE_ICONS: Record<string, string> = {
  task: 'T', tool: 'W', file: 'F', note: 'N',
}

function getStatusColor(theme: ReturnType<typeof useTheme>, status: string): string {
  switch (status) {
    case 'running':
      return theme.accent.base
    case 'done':
      return theme.status.success
    case 'error':
      return theme.status.danger
    case 'pending':
    default:
      return theme.text.muted
  }
}

function AgentOverview({ workspaceId, onFocusTile }: {
  workspaceId: string
  onFocusTile?: (tileId: string) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [groups, setGroups] = useState<Record<string, ActivityRecord[]>>({})
  const [viewState, setViewState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [health, setHealth] = useState<ActivityHealthSnapshot | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    if (!workspaceId || !window.electron?.activity || !hasCapability('activity')) {
      setGroups({})
      setViewState('unavailable')
      return
    }
    Promise.all([
      window.electron.activity.byAgent(workspaceId),
      window.electron.activity.health(workspaceId),
    ]).then(([result, nextHealth]) => {
      setGroups(result)
      setHealth(nextHealth)
      setViewState(nextHealth.available ? 'ready' : 'unavailable')
    }).catch(() => {
      setGroups({})
      setViewState('error')
    })
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

  if (viewState === 'loading') {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>Loading activity...</div>
  }

  if (viewState === 'unavailable' || viewState === 'error') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: fonts.secondarySize, textAlign: 'center', padding: 16 }}>
        {viewState === 'unavailable'
          ? 'Activity persistence is unavailable on this host'
          : 'Activity storage could not be loaded'}
      </div>
    )
  }

  if (agentKeys.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: theme.text.muted }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M9 12h6M12 9v6" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: fonts.secondarySize }}>
          {health?.status === 'degraded' ? 'Activity storage is degraded' : 'No activity yet'}
        </span>
        <span style={{ fontSize: 10, color: theme.text.disabled, maxWidth: 200, textAlign: 'center', lineHeight: 1.4 }}>
          {health?.status === 'degraded'
            ? 'Recent activity may not have been saved. Retry after storage recovers.'
            : 'Activity from terminals and chats will appear here automatically, grouped by agent'}
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
              borderRight: i < agentKeys.length - 1 ? `1px solid ${theme.border.subtle}` : 'none',
            }}
          >
            {/* Column header */}
            <div style={{
              padding: '8px 10px 6px', flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 6,
              borderBottom: `1px solid ${theme.border.subtle}`,
            }}>
              {running > 0 && (
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: theme.accent.base, boxShadow: `0 0 6px ${theme.accent.base}`,
                  display: 'inline-block', flexShrink: 0,
                }} />
              )}
              <span style={{
                flex: 1, fontSize: fonts.secondarySize, fontWeight: 700,
                color: isAgent ? theme.accent.base : theme.text.muted,
                textTransform: 'uppercase', letterSpacing: 0.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {label}
              </span>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {running > 0 && <StatusPill count={running} color={theme.accent.base} />}
                {pending > 0 && <StatusPill count={pending} color={theme.text.muted} />}
                {done > 0 && <StatusPill count={done} color={theme.status.success} />}
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
  const theme = useTheme()
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color,
      background: `${color}18`, borderRadius: 8,
      border: `1px solid ${theme.border.subtle}`,
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
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  const statusColor = getStatusColor(theme, record.status)
  const typeIcon = TYPE_ICONS[record.type] ?? '?'

  return (
    <div
      style={{
        padding: '5px 6px', marginBottom: 2,
        borderRadius: 5,
        background: hovered ? theme.surface.hover : 'transparent',
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
          fontSize: fonts.secondarySize, color: theme.text.secondary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {record.title}
        </div>
        {record.detail && (
          <div style={{
            fontSize: 10, color: theme.text.disabled, marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {record.detail}
          </div>
        )}
      </div>

      {/* Time */}
      <span style={{ fontSize: 9, color: theme.text.disabled, flexShrink: 0, marginTop: 2 }}>
        {new Date(record.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  )
}

// ─── Main KanbanTile ────────────────────────────────────────────────────────

export function KanbanTile({ tileId, workspaceId, workspaceDir, width: _width, height: _height, onFocusTile }: Props): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [mode] = useState<KanbanMode>('board')
  const [columns, setColumns] = useState<KanbanColumn[]>(DEFAULT_COLUMNS)
  const [cards, setCards] = useState<KanbanCardData[]>([])
  const [loaded, setLoaded] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [addTitle, setAddTitle] = useState('')
  const [addInstructions, setAddInstructions] = useState('')
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

  const columnsRef = useRef(columns)
  const cardsRef = useRef(cards)
  const themeRef = useRef(theme)
  const tileIdRef = useRef(tileId)
  const logActivityRef = useRef(logActivity)
  columnsRef.current = columns
  cardsRef.current = cards
  themeRef.current = theme
  tileIdRef.current = tileId
  logActivityRef.current = logActivity

  const handleKanbanEvent = useCallback((event: string, data: any) => {
    if (data?.workspaceId && data.workspaceId !== workspaceId) return
    if (data?.boardTileId && data.boardTileId !== tileIdRef.current) return

    const columns = columnsRef.current
    const cards = cardsRef.current
    const theme = themeRef.current
    const logActivity = logActivityRef.current

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
          ? { ...c, columnId: lastCol.id, color: `color-mix(in srgb, ${theme.status.danger} ${theme.mode === 'light' ? 22 : 18}%, transparent)`, comments: [...c.comments, note] }
          : c)
      })
    }

    if (event === 'canvas_event') {
      logActivity('custom', data.cardId, `${data.event}: ${JSON.stringify(data.data ?? {})}`)
    }

    if (event === 'kanban_card_created') {
      setCards(prev => prev.some(c => c.id === data.card?.id) ? prev : [...prev, data.card])
    }

    if (event === 'kanban_card_updated') {
      setCards(prev => prev.map(c => c.id === data.cardId ? { ...c, ...(data.patch ?? {}) } : c))
    }

    if (event === 'kanban_card_moved') {
      setCards(prev => prev.map(c => c.id === data.cardId ? { ...c, columnId: data.columnId } : c))
    }

    if (event === 'kanban_card_paused') {
      setCards(prev => prev.map(c => c.id === data.cardId ? { ...c, launched: false, columnId: c.columnId === 'running' ? 'backlog' : c.columnId } : c))
    }

    if (event === 'kanban_card_deleted') {
      setCards(prev => prev.filter(c => c.id !== data.cardId))
    }

    if (event === 'kanban_column_created') {
      setColumns(prev => prev.some(c => c.id === data.column?.id) ? prev : [...prev, data.column])
    }

    if (event === 'kanban_column_renamed') {
      setColumns(prev => prev.map(c => c.id === data.columnId ? { ...c, title: data.title } : c))
    }

    if (event === 'kanban_column_deleted') {
      setColumns(prev => prev.filter(c => c.id !== data.columnId))
      setCards(prev => prev.filter(c => c.columnId !== data.columnId))
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
  }, [])

  const handleKanbanEventRef = useRef(handleKanbanEvent)
  handleKanbanEventRef.current = handleKanbanEvent

  // Main stamps `_eventId` on every event it emits over BOTH the SSE stream and
  // the IPC broadcast (the IPC listener below is documented as an SSE fallback
  // but is not gated on SSE failing, so both fire). card_complete is not
  // idempotent — the duplicate advanced the card a second column and appended
  // duplicate comments — so drop whichever copy arrives second.
  const seenKanbanEventIds = useRef<Set<string>>(new Set())

  const dispatchKanbanEvent = useCallback((event: string, data: any) => {
    const eventId = data?._eventId
    if (typeof eventId === 'string') {
      if (seenKanbanEventIds.current.has(eventId)) return
      seenKanbanEventIds.current.add(eventId)
      // Bound the set; ids are monotonic so the oldest are safe to forget.
      if (seenKanbanEventIds.current.size > 512) {
        const keep = Array.from(seenKanbanEventIds.current).slice(-256)
        seenKanbanEventIds.current = new Set(keep)
      }
    }
    handleKanbanEventRef.current(event, data)
  }, [])

  // Subscribe to SSE stream from MCP server
  useEffect(() => {
    let es: EventSource | null = null
    void (async () => {
      const port = await window.electron?.mcp?.getPort?.()
      if (!port) return
      const { openMcpEventSource } = await import('../utils/mcpHttp')
      es = await openMcpEventSource(port, 'global', workspaceId)
      if (!es) return
      const handle = (e: MessageEvent) => {
        try {
          const { cardId, ...rest } = JSON.parse(e.data)
          dispatchKanbanEvent(e.type, { cardId, ...rest })
        } catch { /**/ }
      }
      ;['card_complete','card_update','card_error','canvas_event'].forEach(ev => {
        es!.addEventListener(ev, handle as EventListener)
      })
    })()
    return () => es?.close()
  }, [dispatchKanbanEvent, workspaceId])

  // Also listen via IPC (fallback for same-process events)
  useEffect(() => {
    const el = (window as any).electron?.mcp
    if (!el?.onKanban) return
    const cleanup = el.onKanban((event: string, data: any) => dispatchKanbanEvent(event, data))
    return cleanup
  }, [dispatchKanbanEvent])

  // Listen for peer MCP commands from connected chat/tiles
  useEffect(() => {
    if (!workspaceId || !tileId || !window.electron?.bus) return
    const channel = `tile:${workspaceId}:${tileId}`
    const subscriberId = `kanban:${workspaceId}:${tileId}:mcp`
    const unsubscribe = window.electron.bus.subscribe(channel, subscriberId, (evt) => {
      if (!evt?.type?.startsWith('mcp_') && !String(evt.source || '').startsWith('mcp:')) return
      const payload = (evt.payload as Record<string, unknown>) || {}
      const command = typeof payload.command === 'string' ? payload.command : ''
      if (!command) return

      if (command === 'kanban_set_status' && typeof payload.content === 'string') {
        logActivityRef.current('update', String(payload.card_id ?? tileId), payload.content)
        return
      }

      if (command === 'kanban_create_card' && typeof payload.title === 'string') {
        const now = Date.now()
        const fallbackColumn = columnsRef.current[0]?.id ?? 'backlog'
        setCards(prev => [...prev, {
          id: `card-${tileId}-${now}`,
          title: String(payload.title),
          description: typeof payload.description === 'string' ? payload.description : '',
          instructions: typeof payload.instructions === 'string' ? payload.instructions : '',
          agent: typeof payload.agent === 'string' ? payload.agent : 'claude',
          model: typeof payload.model === 'string' ? payload.model : undefined,
          tools: Array.isArray(payload.tools) ? payload.tools.filter((v): v is string => typeof v === 'string') : ['all'],
          skillsAndCommands: [],
          fileRefs: Array.isArray(payload.file_refs) ? payload.file_refs.filter((v): v is string => typeof v === 'string') : [],
          cardRefs: Array.isArray(payload.card_refs) ? payload.card_refs.filter((v): v is string => typeof v === 'string') : [],
          mcpServers: [],
          hooks: [],
          columnId: typeof payload.column_id === 'string' ? payload.column_id : fallbackColumn,
          color: typeof payload.color === 'string' ? payload.color : COLORS[prev.length % COLORS.length],
          launched: false,
          comments: [],
          attachments: [],
        }])
        return
      }

      if (command === 'kanban_update_card' && typeof payload.card_id === 'string') {
        const patch: Partial<KanbanCardData> = {}
        if (typeof payload.title === 'string') patch.title = payload.title
        if (typeof payload.description === 'string') patch.description = payload.description
        if (typeof payload.instructions === 'string') patch.instructions = payload.instructions
        if (typeof payload.column_id === 'string') patch.columnId = payload.column_id
        if (typeof payload.agent === 'string') patch.agent = payload.agent
        if (typeof payload.model === 'string') patch.model = payload.model
        if (typeof payload.color === 'string') patch.color = payload.color
        if (typeof payload.launched === 'boolean') patch.launched = payload.launched
        if (Array.isArray(payload.tools)) patch.tools = payload.tools.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(payload.file_refs)) patch.fileRefs = payload.file_refs.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(payload.card_refs)) patch.cardRefs = payload.card_refs.filter((v): v is string => typeof v === 'string')
        setCards(prev => prev.map(c => c.id === payload.card_id ? { ...c, ...patch } : c))
        return
      }

      if (command === 'kanban_move_card' && typeof payload.card_id === 'string' && typeof payload.column_id === 'string') {
        const cardId = payload.card_id
        const columnId = payload.column_id
        setCards(prev => prev.map(c => c.id === cardId ? { ...c, columnId } : c))
        return
      }

      if (command === 'kanban_pause_card' && typeof payload.card_id === 'string') {
        setCards(prev => prev.map(c => c.id === payload.card_id ? { ...c, launched: false, columnId: c.columnId === 'running' ? 'backlog' : c.columnId } : c))
        return
      }

      if (command === 'kanban_delete_card' && typeof payload.card_id === 'string') {
        setCards(prev => prev.filter(c => c.id !== payload.card_id))
        return
      }

      if (command === 'kanban_create_column' && typeof payload.title === 'string') {
        const column = { id: typeof payload.column_id === 'string' ? payload.column_id : `col-${Date.now()}`, title: payload.title }
        setColumns(prev => prev.some(c => c.id === column.id) ? prev : [...prev, column])
        return
      }

      if (command === 'kanban_rename_column' && typeof payload.column_id === 'string' && typeof payload.title === 'string') {
        setColumns(prev => prev.map(c => c.id === payload.column_id ? { ...c, title: payload.title as string } : c))
        return
      }

      if (command === 'kanban_delete_column' && typeof payload.column_id === 'string') {
        setColumns(prev => prev.filter(c => c.id !== payload.column_id))
        setCards(prev => prev.filter(c => c.columnId !== payload.column_id))
      }
    })
    return () => unsubscribe?.()
  }, [workspaceId, tileId])

  // Streaming handled by pty/xterm — no separate stream listener needed

  const isActive = (id?: string) => !!id && Date.now() - (activeTerminals[id] ?? 0) < ACTIVE_TTL

  const addCard = useCallback((colId: string) => {
    if (!addTitle.trim()) return
    setCards(prev => [...prev, {
      id: `card-${tileId}-${Date.now()}`,
      title: addTitle.trim(), description: '', instructions: addInstructions.trim(),
      agent: 'claude', tools: ['all'], skillsAndCommands: [],
      fileRefs: [], cardRefs: [], mcpServers: [], hooks: [],
      columnId: colId, color: COLORS[prev.length % COLORS.length],
      launched: false, comments: [], attachments: []
    }])
    setAddTitle(''); setAddInstructions(''); setAddingTo(null)
  }, [tileId, addTitle, addInstructions])

  const launchCard = useCallback(async (cardId: string) => {
    const card = cards.find(c => c.id === cardId)
    if (!card || card.launched) return

    const unresolvedDeps = card.cardRefs
      .map(ref => cards.find(c => c.id === ref || c.title === ref))
      .filter((c): c is KanbanCardData => !!c)
      .filter(c => c.columnId !== 'done')

    if (unresolvedDeps.length > 0) {
      window.alert(`This card can only start after: ${unresolvedDeps.map(c => c.title).join(', ')}`)
      return
    }

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

  const pauseCard = useCallback((cardId: string) => {
    setCards(prev => prev.map(c =>
      c.id === cardId
        ? { ...c, launched: false, columnId: c.columnId === 'running' ? 'backlog' : c.columnId }
        : c,
    ))
  }, [])

  const saveCard = useCallback(async () => {
    if (!workspaceId) return
    const state: KanbanSavedState = { columns, cards }
    await window.electron?.kanban?.save(workspaceId, tileId, state)
  }, [workspaceId, tileId, columns, cards])

  const updateCard = useCallback((id: string, patch: Partial<KanbanCardData>) => {
    setCards(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
  }, [])

  const removeCard = useCallback((id: string) => {
    const card = cards.find(c => c.id === id)
    if (card?.linkedTileId) {
      window.electron?.terminal?.destroy?.(card.linkedTileId, workspaceId)
    }
    setCards(prev => prev.filter(c => c.id !== id))
  }, [cards, workspaceId])

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
        description: `Group with ${tileIds.length} block${tileIds.length !== 1 ? 's' : ''} (${typeSummary})`,
        instructions: '', agent: 'claude',
        tools: ['all'], skillsAndCommands: [], fileRefs: [], cardRefs: [],
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
        tools: ['all'], skillsAndCommands: [], fileRefs: [], cardRefs: [],
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
        tools: ['all'], skillsAndCommands: [], fileRefs: [filePath], cardRefs: [],
        mcpServers: [], hooks: [],
        columnId: colId, color: COLORS[prev.length % COLORS.length],
        launched: false, comments: [],
        attachments: [{ id: `a-${Date.now()}`, name, path: filePath }]
      }])
    }
  }, [dragging, tileId])

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: theme.surface.panel, overflow: 'hidden', position: 'relative' }}>

      {mode === 'board' && (
        <button
          onClick={() => setColumns(prev => [...prev, { id: `col-${Date.now()}`, title: 'New List' }])}
          style={{ position: 'absolute', top: 8, right: 12, zIndex: 10, fontSize: fonts.secondarySize, padding: '3px 10px', borderRadius: 5, background: theme.surface.panelElevated, color: theme.text.primary, border: `1px solid ${theme.border.default}`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.75' }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
        >+ List</button>
      )}

      {/* Overview mode */}
      {mode === 'overview' && (
        <AgentOverview workspaceId={workspaceId} onFocusTile={onFocusTile} />
      )}

      {/* Board mode — terminal task activity */}
      {mode === 'board' && terminalTaskCards.length > 0 && (
        <div style={{ borderBottom: `1px solid ${theme.border.subtle}`, background: theme.surface.panel, padding: '4px 8px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: theme.accent.base, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>Task Activity</div>
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
                    borderRadius: 6, border: `1px solid ${isLive ? `${theme.status.success}55` : theme.border.default}`,
                    background: isLive ? `${theme.status.success}14` : theme.surface.panelMuted,
                    padding: 7, minWidth: 180, maxWidth: 280,
                    color: theme.text.secondary,
                    display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0
                  }}
                  title={`Jump to ${card.title}`}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = `${theme.accent.base}66` }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = isLive ? `${theme.status.success}55` : theme.border.default }}
                >
                  <span style={{ fontSize: fonts.secondarySize, color: theme.accent.base, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.title}</span>
                  <span style={{ fontSize: 10, color: hasAny ? theme.text.muted : theme.text.disabled, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isLive ? theme.status.success : theme.border.default, boxShadow: isLive ? `0 0 6px ${theme.status.success}` : 'none', display: 'inline-block' }} />
                    {hasAny ? ev.message : 'No terminal output yet'}
                  </span>
                  <span style={{ fontSize: 9, color: theme.text.disabled, letterSpacing: 0.2 }}>
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
                borderRight: ci < columns.length - 1 ? `1px solid ${theme.border.subtle}` : 'none',
                background: isOver ? theme.surface.hover : 'transparent',
                transition: 'background 0.1s'
              }}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(col.id) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null) }}
              onDrop={e => { e.stopPropagation(); dropOnCol(col.id, e) }}
            >
              {/* Column header */}
              <div style={{ padding: '8px 10px 6px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {renamingCol === col.id ? (
                  <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { setColumns(p => p.map(c => c.id === col.id ? { ...c, title: renameVal } : c)); setRenamingCol(null) } if (e.key === 'Escape') setRenamingCol(null) }}
                    onBlur={() => { setColumns(p => p.map(c => c.id === col.id ? { ...c, title: renameVal } : c)); setRenamingCol(null) }}
                    style={{ flex: 1, fontSize: fonts.secondarySize, fontWeight: 700, background: 'transparent', color: theme.text.primary, border: 'none', borderBottom: `1px solid ${theme.text.primary}`, outline: 'none', textTransform: 'uppercase', letterSpacing: 0.5 }}
                  />
                ) : (
                  <span style={{ flex: 1, fontSize: fonts.secondarySize, fontWeight: 700, color: theme.text.primary, textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'text' }}
                    onDoubleClick={() => { setRenamingCol(col.id); setRenameVal(col.title) }}>
                    {col.title}
                  </span>
                )}
                <button
                  onClick={() => { setAddingTo(col.id); setAddTitle(''); setAddInstructions('') }}
                  style={{ fontSize: 20, lineHeight: 1, color: theme.text.primary, background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontFamily: 'inherit', fontWeight: 800 }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = '0.75' }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
                  title="Add card"
                >+
                </button>
                <span style={{ fontSize: fonts.size, color: theme.text.primary, background: theme.surface.panelElevated, borderRadius: 10, minWidth: 24, height: 24, padding: '0 8px', border: `1px solid ${theme.border.default}`, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{colCards.length}</span>
                <button onClick={() => { cards.filter(c => c.columnId === col.id).forEach(c => c.linkedTileId && window.electron?.terminal?.destroy?.(c.linkedTileId, workspaceId)); setCards(p => p.filter(c => c.columnId !== col.id)); setColumns(p => p.filter(c => c.id !== col.id)) }}
                  style={{ fontSize: fonts.size, lineHeight: 1, color: theme.text.primary, background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px', fontWeight: 800, fontFamily: 'inherit' }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.72')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >✕</button>
              </div>

              {/* Cards */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {colCards.map(card => (
                  <div key={card.id} data-card-id={card.id}>
                    <KanbanCard
                      card={card}
                      workspaceId={workspaceId}
                      workspaceDir={workspaceDir}
                      active={isActive(card.linkedTileId)}
                      dragging={dragging === card.id}
                      isRunning={card.launched}
                      allCards={cards}
                      onUpdate={updateCard}
                      onRemove={removeCard}
                      onLaunch={launchCard}
                      onPause={pauseCard}
                      onSave={saveCard}
                      onFocus={card.linkedTileId ? () => onFocusTile?.(card.linkedTileId!) : undefined}
                      onDragStart={() => setDragging(card.id)}
                      onDragEnd={() => { setDragging(null); setDragOver(null) }}
                    />
                  </div>
                ))}

                {/* Add card */}
                {addingTo === col.id ? (
                  <div style={{ background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`, borderRadius: 6, padding: 8, flexShrink: 0 }}>
                    <input autoFocus value={addTitle} onChange={e => setAddTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') { setAddingTo(null); setAddTitle(''); setAddInstructions('') } }}
                      placeholder="Title…"
                      style={{ width: '100%', fontSize: fonts.secondarySize, padding: '5px 8px', borderRadius: 4, background: theme.surface.input, color: theme.text.primary, border: `1px solid ${theme.accent.base}`, outline: 'none', fontFamily: 'inherit', marginBottom: 6 }}
                    />
                    <textarea value={addInstructions} onChange={e => setAddInstructions(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addCard(col.id); if (e.key === 'Escape') { setAddingTo(null); setAddTitle(''); setAddInstructions('') } }}
                      placeholder="Instructions…"
                      style={{ width: '100%', minHeight: 68, fontSize: fonts.secondarySize, fontWeight: fonts.secondaryWeight, padding: '6px 8px', borderRadius: 4, resize: 'vertical', background: theme.surface.input, color: theme.text.primary, border: `1px solid ${theme.border.default}`, outline: 'none', fontFamily: 'inherit', marginBottom: 6, lineHeight: fonts.secondaryLineHeight }}
                    />
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button onClick={() => addCard(col.id)} style={{ flex: 1, padding: '4px 0', borderRadius: 4, background: theme.accent.base, color: theme.text.inverse, border: 'none', fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
                      <button onClick={() => { setAddingTo(null); setAddTitle(''); setAddInstructions('') }} style={{ padding: '4px 8px', borderRadius: 4, background: theme.surface.panel, color: theme.text.muted, border: `1px solid ${theme.border.default}`, fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                    </div>
                  </div>
                ) : null}
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
