import React, { useState, useCallback, useEffect, useRef } from 'react'
import { KanbanCard, KanbanCardData, buildLaunchCmd } from './KanbanCard'
import { buildAgentBrief } from '../utils/agentBrief'
import { ActivityFeed, ActivityEvent } from './ActivityFeed'

interface KanbanColumn { id: string; title: string }

interface Props {
  tileId: string
  workspaceDir: string
  width: number
  height: number
  onFocusTile?: (tileId: string) => void
}

const COLORS = ['#0d2137','#0d2a1a','#2a0d1a','#1a1a0d','#1a0d2a','#0d1a2a','#2a1a0d','#0d2a2a']
const ACTIVE_TTL = 4000

const DONE_PATTERNS = [
  /task complete/i, /all done/i, /completed successfully/i,
  /ready for review/i, /✓\s*(done|complete)/i,
  /\$ $/, /❯ $/, /% $/
]

export function KanbanTile({ tileId, workspaceDir, width, height, onFocusTile }: Props): JSX.Element {
  const [columns, setColumns] = useState<KanbanColumn[]>([
    { id: 'backlog', title: 'Backlog' },
    { id: 'running', title: 'Running' },
    { id: 'review',  title: 'Review' },
    { id: 'done',    title: 'Done' }
  ])
  const [cards, setCards] = useState<KanbanCardData[]>([])
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [addTitle, setAddTitle] = useState('')
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [activeTerminals, setActiveTerminals] = useState<Record<string, number>>({})
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([])
  const cleanupRefs = useRef<Record<string, () => void>>({})

  const HEADER = 38
  const COL_W = Math.max(200, Math.floor(width / columns.length))

  // Watch terminals for activity (dot only — moves come from MCP card_complete)
  useEffect(() => {
    const linked = cards.filter(c => c.linkedTileId && (c.linkedTileType === 'terminal' || !c.linkedTileType))
    linked.forEach(card => {
      const id = card.linkedTileId!
      if (cleanupRefs.current[id]) return
      const c1 = window.electron?.terminal?.onActive?.(id, () =>
        setActiveTerminals(prev => ({ ...prev, [id]: Date.now() }))
      )
      cleanupRefs.current[id] = () => { c1?.() }
    })
    Object.keys(cleanupRefs.current).forEach(id => {
      if (!linked.find(c => c.linkedTileId === id)) {
        cleanupRefs.current[id]?.()
        delete cleanupRefs.current[id]
      }
    })
  }, [cards])

  useEffect(() => () => Object.values(cleanupRefs.current).forEach(fn => fn()), [])

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
  }, [])

  const logActivity = useCallback((type: ActivityEvent['type'], cardId: string, message: string) => {
    setCards(prev => {
      const card = prev.find(c => c.id === cardId)
      setActivityLog(log => [...log, {
        id: `ev-${Date.now()}-${Math.random()}`,
        ts: Date.now(),
        cardId,
        cardTitle: card?.title ?? cardId,
        event: type,
        message,
        type
      }])
      return prev
    })
  }, [])

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
    // Tile dragged from canvas titlebar
    const linkedTileId = e.dataTransfer.getData('application/tile-id')
    const linkedTileType = e.dataTransfer.getData('application/tile-type')
    const linkedTileLabel = e.dataTransfer.getData('application/tile-label')
    if (linkedTileId) {
      setCards(prev => [...prev, {
        id: `card-${tileId}-${Date.now()}`,
        title: linkedTileLabel || linkedTileType,
        description: '', instructions: '', agent: 'claude',
        tools: [], skillsAndCommands: [], fileRefs: [], cardRefs: [],
        mcpServers: [], hooks: [],
        columnId: colId, color: COLORS[prev.length % COLORS.length],
        linkedTileId, linkedTileType,
        launched: linkedTileType === 'terminal',
        comments: [], attachments: []
      }])
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
          <span style={{ fontSize: 11, fontWeight: 700, color: '#58a6ff', letterSpacing: 1, textTransform: 'uppercase' }}>Board</span>
          <span style={{ fontSize: 10, color: '#444', background: '#1c2128', border: '1px solid #30363d', borderRadius: 10, padding: '1px 7px' }}>
            {cards.length} card{cards.length !== 1 ? 's' : ''}
          </span>
          {Object.keys(activeTerminals).filter(id => isActive(id)).length > 0 && (
            <span style={{ fontSize: 10, color: '#3fb950', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 6px #3fb950', display: 'inline-block' }} />
              {Object.keys(activeTerminals).filter(id => isActive(id)).length} active
            </span>
          )}
        </div>
        <button
          onClick={() => setColumns(prev => [...prev, { id: `col-${Date.now()}`, title: 'New List' }])}
          style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, background: '#21262d', color: '#8b949e', border: '1px solid #30363d', cursor: 'pointer', fontFamily: 'inherit' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#58a6ff'; e.currentTarget.style.background = '#2d333b' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#8b949e'; e.currentTarget.style.background = '#21262d' }}
        >+ List</button>
      </div>

      {/* Columns */}
      <div style={{ flex: 1, display: 'flex', overflowX: 'auto', overflowY: 'hidden' }}>
        {columns.map((col, ci) => {
          const colCards = cards.filter(c => c.columnId === col.id)
          const isOver = dragOver === col.id
          return (
            <div key={col.id}
              style={{ width: COL_W, minWidth: COL_W, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: ci < columns.length - 1 ? '1px solid #21262d' : 'none', background: isOver ? '#161b22' : 'transparent', transition: 'background 0.1s' }}
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
                    style={{ width: '100%', padding: '5px 0', fontSize: 11, color: '#333', background: 'none', border: '1px dashed #21262d', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#58a6ff'; e.currentTarget.style.borderColor = '#388bfd44' }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#333'; e.currentTarget.style.borderColor = '#21262d' }}
                  >+ Add card</button>
                )}
              </div>
            </div>
          )
        })}
      </div>

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
    </div>
  )
}
