import React, { useEffect, useRef, useState } from 'react'

export interface ActivityEvent {
  id: string
  ts: number
  cardId: string
  cardTitle: string
  event: string
  message: string
  type: 'complete' | 'update' | 'error' | 'custom' | 'input'
  question?: string
  options?: string[]
  answered?: boolean
}

interface Props {
  events: ActivityEvent[]
  onClearAll: () => void
  onJumpToCard: (cardId: string) => void
  onReply: (eventId: string, cardId: string, message: string) => void
}

const TYPE_COLOR: Record<string, string> = {
  complete: '#3fb950',
  update:   '#58a6ff',
  error:    '#ff7b72',
  custom:   '#d7ba7d',
  input:    '#f9af4f'
}

const TYPE_LABEL: Record<string, string> = {
  complete: 'done',
  update:   'update',
  error:    'error',
  custom:   'event',
  input:    'input?'
}

function EventRow({ ev, onJump, onReply }: { ev: ActivityEvent; onJump: (id: string) => void; onReply: (evId: string, cardId: string, msg: string) => void }): JSX.Element {
  const [reply, setReply] = useState('')
  const [hovered, setHovered] = useState(false)
  const isInput = ev.type === 'input' && !ev.answered

  return (
    <div
      style={{ padding: isInput ? '6px 12px 8px' : '2px 12px', background: isInput ? '#161b0a' : 'transparent', borderLeft: isInput ? '2px solid #f9af4f' : 'none' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }} onClick={() => onJump(ev.cardId)}>
        <span style={{ fontSize: 9, color: '#333', fontFamily: 'monospace', flexShrink: 0, width: 60 }}>
          {new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span style={{
          fontSize: 9, color: TYPE_COLOR[ev.type], fontFamily: 'monospace',
          background: `${TYPE_COLOR[ev.type]}11`, border: `1px solid ${TYPE_COLOR[ev.type]}33`,
          borderRadius: 3, padding: '0 5px', flexShrink: 0
        }}>
          {TYPE_LABEL[ev.type]}
        </span>
        <span style={{ fontSize: 9, color: '#58a6ff', fontFamily: 'monospace', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ev.cardTitle}
        </span>
        <span style={{ fontSize: 10, color: isInput ? '#f9af4f' : '#8b949e', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isInput ? 600 : 400 }}>
          {ev.message}
        </span>
      </div>

      {/* Option chips */}
      {isInput && ev.options && ev.options.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, marginLeft: 68, flexWrap: 'wrap' }}>
          {ev.options.map(opt => (
            <button key={opt} onClick={() => onReply(ev.id, ev.cardId, opt)}
              style={{ fontSize: 10, padding: '2px 10px', borderRadius: 4, background: '#1c2128', color: '#c9d1d9', border: '1px solid #30363d', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#388bfd'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.background = '#1c2128'; e.currentTarget.style.color = '#c9d1d9' }}>
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Free-text reply */}
      {isInput && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, marginLeft: 68 }}>
          <input
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && reply.trim()) { onReply(ev.id, ev.cardId, reply); setReply('') } }}
            placeholder="Reply to agent…"
            style={{ flex: 1, fontSize: 10, padding: '3px 8px', borderRadius: 4, background: '#0d1117', color: '#c9d1d9', border: '1px solid #f9af4f44', outline: 'none', fontFamily: 'monospace' }}
            autoFocus
          />
          <button onClick={() => { if (reply.trim()) { onReply(ev.id, ev.cardId, reply); setReply('') } }}
            style={{ padding: '3px 10px', borderRadius: 4, background: '#f9af4f', color: '#000', border: 'none', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
            send
          </button>
        </div>
      )}
    </div>
  )
}

export function ActivityFeed({ events, onClearAll, onJumpToCard, onReply }: Props): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)

  // Auto-scroll to latest
  useEffect(() => {
    if (!collapsed) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length, collapsed])

  const recent = events.slice(-50) // keep last 50

  return (
    <div style={{
      borderTop: '1px solid #21262d',
      background: '#0d1117',
      flexShrink: 0,
      maxHeight: collapsed ? 28 : 160,
      transition: 'max-height 0.2s ease',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 10px', borderBottom: collapsed ? 'none' : '1px solid #21262d',
        flexShrink: 0, cursor: 'pointer', userSelect: 'none'
      }} onClick={() => setCollapsed(p => !p)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, color: '#388bfd', fontFamily: 'monospace', letterSpacing: 1, fontWeight: 700 }}>
            ACTIVITY
          </span>
          {events.length > 0 && (
            <span style={{ fontSize: 9, color: '#444', background: '#161b22', border: '1px solid #21262d', borderRadius: 8, padding: '0 5px' }}>
              {events.length}
            </span>
          )}
          {/* Live dot if recent activity */}
          {events.length > 0 && Date.now() - events[events.length - 1].ts < 5000 && (
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 4px #3fb950', display: 'inline-block' }} />
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
          {events.length > 0 && (
            <button onClick={onClearAll} style={{ fontSize: 9, color: '#444', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#ff7b72')}
              onMouseLeave={e => (e.currentTarget.style.color = '#444')}>
              clear
            </button>
          )}
          <span style={{ fontSize: 9, color: '#333', fontFamily: 'monospace' }}>{collapsed ? 'v' : '^'}</span>
        </div>
      </div>

      {/* Feed */}
      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {recent.length === 0 ? (
            <div style={{ fontSize: 10, color: '#2a2a2a', padding: '8px 12px', fontFamily: 'monospace' }}>
              No activity yet. Launch an agent to see events here.
            </div>
          ) : (
            recent.map(ev => <EventRow key={ev.id} ev={ev} onJump={onJumpToCard} onReply={onReply} />)
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
