import { useEffect, useRef, useState } from 'react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'

export interface ActivityEvent {
  id: string
  ts: number
  cardId: string
  cardTitle: string
  event: string
  message: string
  type: 'complete' | 'update' | 'error' | 'custom' | 'input' | 'terminal'
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

function getEventColor(theme: ReturnType<typeof useTheme>, type: ActivityEvent['type']): string {
  switch (type) {
    case 'complete':
    case 'terminal':
      return theme.status.success
    case 'update':
      return theme.accent.base
    case 'error':
      return theme.status.danger
    case 'input':
      return theme.status.warning
    case 'custom':
    default:
      return '#d7ba7d'
  }
}

const TYPE_LABEL: Record<string, string> = {
  complete: 'done',
  update:   'update',
  error:    'error',
  custom:   'event',
  input:    'input?',
  terminal: 'term'
}

function EventRow({ ev, onJump, onReply }: { ev: ActivityEvent; onJump: (id: string) => void; onReply: (evId: string, cardId: string, msg: string) => void }): JSX.Element {
  const [reply, setReply] = useState('')
  const [hovered, setHovered] = useState(false)
  const fonts = useAppFonts()
  const theme = useTheme()
  const isInput = ev.type === 'input' && !ev.answered
  const eventColor = getEventColor(theme, ev.type)

  return (
    <div
      style={{
        padding: isInput ? '6px 12px 8px' : '2px 12px',
        background: isInput ? `${eventColor}12` : hovered ? theme.surface.hover : 'transparent',
        borderLeft: isInput ? `2px solid ${eventColor}` : 'none',
        transition: 'background 0.12s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }} onClick={() => onJump(ev.cardId)}>
        <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, flexShrink: 0, width: 68 }}>
          {new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span style={{
          fontSize: 10,
          color: eventColor,
          fontFamily: 'inherit',
          background: `${eventColor}12`,
          border: `1px solid ${eventColor}33`,
          borderRadius: 3,
          padding: '0 5px',
          flexShrink: 0,
        }}>
          {TYPE_LABEL[ev.type]}
        </span>
        <span style={{ fontSize: 10, color: theme.accent.base, fontFamily: 'inherit', flexShrink: 0, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ev.cardTitle}
        </span>
        <span style={{ fontSize: fonts.secondarySize, color: isInput ? eventColor : theme.text.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isInput ? 600 : fonts.secondaryWeight }}>
          {ev.message}
        </span>
      </div>

      {isInput && ev.options && ev.options.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, marginLeft: 68, flexWrap: 'wrap' }}>
          {ev.options.map(opt => (
            <button key={opt} onClick={() => onReply(ev.id, ev.cardId, opt)}
              style={{
                fontSize: fonts.secondarySize,
                padding: '2px 10px',
                borderRadius: 4,
                background: theme.surface.panelElevated,
                color: theme.text.secondary,
                border: `1px solid ${theme.border.default}`,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = theme.surface.hover
                e.currentTarget.style.color = theme.text.primary
                e.currentTarget.style.borderColor = theme.border.accent
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = theme.surface.panelElevated
                e.currentTarget.style.color = theme.text.secondary
                e.currentTarget.style.borderColor = theme.border.default
              }}>
              {opt}
            </button>
          ))}
        </div>
      )}

      {isInput && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, marginLeft: 68 }}>
          <input
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && reply.trim()) { onReply(ev.id, ev.cardId, reply); setReply('') } }}
            placeholder="Reply to agent…"
            style={{
              flex: 1,
              fontSize: fonts.secondarySize,
              padding: '3px 8px',
              borderRadius: 4,
              background: theme.surface.input,
              color: theme.text.secondary,
              border: `1px solid ${eventColor}55`,
              outline: 'none',
              fontFamily: 'inherit',
            }}
            autoFocus
          />
          <button onClick={() => { if (reply.trim()) { onReply(ev.id, ev.cardId, reply); setReply('') } }}
            style={{ padding: '3px 10px', borderRadius: 4, background: eventColor, color: theme.text.inverse, border: 'none', fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
            send
          </button>
        </div>
      )}
    </div>
  )
}

export function ActivityFeed({ events, onClearAll, onJumpToCard, onReply }: Props): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevLenRef = useRef(events.length)
  const [collapsed, setCollapsed] = useState(false)
  const theme = useTheme()
  const fonts = useAppFonts()

  useEffect(() => {
    if (!collapsed && events.length > 0 && events.length > prevLenRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevLenRef.current = events.length
  }, [events.length, collapsed])

  const recent = events.slice(-50)

  return (
    <div style={{
      borderTop: `1px solid ${theme.border.subtle}`,
      background: theme.surface.panel,
      flexShrink: 0,
      maxHeight: collapsed ? 28 : 160,
      transition: 'max-height 0.2s ease',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 10px', borderBottom: collapsed ? 'none' : `1px solid ${theme.border.subtle}`,
        flexShrink: 0, cursor: 'pointer', userSelect: 'none',
      }} onClick={() => setCollapsed(p => !p)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: theme.accent.base, fontFamily: 'inherit', letterSpacing: 1, fontWeight: 700 }}>
            ACTIVITY
          </span>
          {events.length > 0 && (
            <span style={{ fontSize: 10, color: theme.text.disabled, background: theme.surface.panelMuted, border: `1px solid ${theme.border.default}`, borderRadius: 8, padding: '0 6px' }}>
              {events.length}
            </span>
          )}
          {events.length > 0 && Date.now() - events[events.length - 1].ts < 5000 && (
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: theme.status.success, boxShadow: `0 0 4px ${theme.status.success}`, display: 'inline-block' }} />
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
          {events.length > 0 && (
            <button onClick={onClearAll} style={{ fontSize: 10, color: theme.text.disabled, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
              onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
              clear
            </button>
          )}
          <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: 'inherit' }}>{collapsed ? 'v' : '^'}</span>
        </div>
      </div>

      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {recent.length === 0 ? (
            <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, padding: '8px 12px', fontFamily: 'inherit' }}>
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
