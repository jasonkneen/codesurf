import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  GripVertical,
  MessageSquare,
  Trash2,
} from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { ChatComposerDrawerFrame } from './ChatComposer'
import {
  CHAT_COMPOSER_WIDTH,
  CHAT_COMPOSER_MIN_WIDTH_STYLE,
} from './chatTileLayout'
import { isUrgentQueuedContent } from './chatTileUtils'
import type { QueuedChatTurn } from './chatTileTypes'

const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

export interface ChatTileQueuedTurnsDrawerProps {
  queuedTurns: QueuedChatTurn[]
  queueCollapsed: boolean
  draggingTurnId: string | null
  dragOverTurn: { id: string; mode: 'before' | 'after' | 'into' } | null
  joinedToPrevious: boolean
  isStreaming: boolean
  fontSans: string
  fontSize: number
  onToggleCollapsed: () => void
  onSetDraggingTurnId: (id: string | null) => void
  onSetDragOverTurn: (value: { id: string; mode: 'before' | 'after' | 'into' } | null) => void
  onReorderQueuedTurn: (draggedId: string, targetId: string, mode: 'before' | 'after' | 'into') => void
  onSteerTurn: (turn: QueuedChatTurn) => void
  onDeleteTurn: (turnId: string) => void
}

export function ChatTileQueuedTurnsDrawer({
  queuedTurns,
  queueCollapsed,
  draggingTurnId,
  dragOverTurn,
  joinedToPrevious,
  isStreaming,
  fontSans,
  fontSize,
  onToggleCollapsed,
  onSetDraggingTurnId,
  onSetDragOverTurn,
  onReorderQueuedTurn,
  onSteerTurn,
  onDeleteTurn,
}: ChatTileQueuedTurnsDrawerProps): JSX.Element | null {
  const theme = useTheme()

  if (queuedTurns.length === 0) return null

  const urgentCount = queuedTurns.filter(t => isUrgentQueuedContent(t.content)).length
  const showCollapsed = queueCollapsed && queuedTurns.length >= 3

  return (
    <ChatComposerDrawerFrame
      joinedToPrevious={joinedToPrevious}
      collapsed={showCollapsed}
      style={{
        width: `calc(${CHAT_COMPOSER_WIDTH} - 24px)`,
        minWidth: `calc(${CHAT_COMPOSER_MIN_WIDTH_STYLE} - 24px)`,
        margin: '0 auto 0 auto',
      }}
    >
      {queuedTurns.length >= 3 && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 14px',
            border: 'none',
            borderBottom: showCollapsed ? 'none' : `1px solid ${theme.chat.divider}`,
            background: 'transparent',
            color: theme.chat.textSecondary,
            cursor: 'pointer',
            fontFamily: fontSans,
            fontSize: 11,
            lineHeight: 1,
            textAlign: 'left',
            ...NON_SELECTABLE_UI_STYLE,
          }}
          title={showCollapsed ? 'Expand queued messages' : 'Collapse queued messages'}
        >
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            color: theme.chat.muted,
            flexShrink: 0,
          }}>
            {showCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            color: urgentCount > 0 ? theme.status.danger : theme.chat.muted,
            flexShrink: 0,
          }}>
            {urgentCount > 0 ? <AlertTriangle size={12} /> : <MessageSquare size={12} />}
          </span>
          <span style={{
            flex: 1, minWidth: 0,
            display: 'inline-flex',
            alignItems: 'center',
            lineHeight: 1,
          }}>
            <span style={{ fontWeight: 600 }}>
              {queuedTurns.length} queued {queuedTurns.length === 1 ? 'message' : 'messages'}
            </span>
            {urgentCount > 0 && (
              <>
                <span style={{ color: theme.chat.muted }}>, </span>
                <span style={{ color: theme.status.danger, fontWeight: 600 }}>
                  {urgentCount} {urgentCount === 1 ? 'error' : 'errors'}
                </span>
              </>
            )}
          </span>
        </button>
      )}
      {!showCollapsed && queuedTurns.map((turn, index) => {
        const depth = turn.parentId ? 1 : 0
        const isDraggingThis = draggingTurnId === turn.id
        const dropHere = dragOverTurn?.id === turn.id ? dragOverTurn.mode : null
        const isUrgent = isUrgentQueuedContent(turn.content)
        return (
          <div
            key={turn.id}
            onDragOver={(ev) => {
              if (!ev.dataTransfer.types.includes('application/x-codesurf-queued-turn')) return
              if (draggingTurnId === turn.id) return
              ev.preventDefault()
              ev.stopPropagation()
              ev.dataTransfer.dropEffect = 'move'
              const rect = ev.currentTarget.getBoundingClientRect()
              const y = ev.clientY - rect.top
              const h = rect.height
              let mode: 'before' | 'after' | 'into'
              if (y < h * 0.25) mode = 'before'
              else if (y > h * 0.75) mode = 'after'
              else mode = turn.parentId ? 'after' : 'into'
              if (dragOverTurn?.id !== turn.id || dragOverTurn.mode !== mode) {
                onSetDragOverTurn({ id: turn.id, mode })
              }
            }}
            onDragLeave={(ev) => {
              const related = ev.relatedTarget as Node | null
              if (related && ev.currentTarget.contains(related)) return
              if (dragOverTurn?.id === turn.id) onSetDragOverTurn(null)
            }}
            onDrop={(ev) => {
              const draggedId = ev.dataTransfer.getData('application/x-codesurf-queued-turn')
                || ev.dataTransfer.getData('text/plain')
              if (!draggedId || draggedId === turn.id) return
              ev.preventDefault()
              ev.stopPropagation()
              const rect = ev.currentTarget.getBoundingClientRect()
              const y = ev.clientY - rect.top
              const h = rect.height
              let mode: 'before' | 'after' | 'into'
              if (y < h * 0.25) mode = 'before'
              else if (y > h * 0.75) mode = 'after'
              else mode = turn.parentId ? 'after' : 'into'
              onReorderQueuedTurn(draggedId, turn.id, mode)
              onSetDragOverTurn(null)
              onSetDraggingTurnId(null)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '6px 14px',
              paddingLeft: 14 + depth * 22,
              borderTop: index > 0 ? `1px solid ${theme.chat.divider}` : undefined,
              background: dropHere === 'into'
                ? theme.surface.hover
                : (isDraggingThis
                  ? theme.surface.selection
                  : (isUrgent ? `color-mix(in srgb, ${theme.status.danger} 18%, transparent)` : 'transparent')),
              boxShadow: dropHere === 'before'
                ? `inset 0 2px 0 0 ${theme.accent.base}`
                : dropHere === 'after'
                  ? `inset 0 -2px 0 0 ${theme.accent.base}`
                  : (isUrgent ? `inset 3px 0 0 0 ${theme.status.danger}` : undefined),
              opacity: isDraggingThis ? 0.5 : 1,
              transition: 'background 0.12s, opacity 0.12s',
              position: 'relative',
            }}
          >
            <div
              draggable
              onDragStart={(ev) => {
                ev.stopPropagation()
                ev.dataTransfer.effectAllowed = 'move'
                try {
                  ev.dataTransfer.setData('application/x-codesurf-queued-turn', turn.id)
                } catch { /* older browsers reject custom types silently */ }
                ev.dataTransfer.setData('text/plain', turn.id)
                onSetDraggingTurnId(turn.id)
              }}
              onDragEnd={() => {
                onSetDraggingTurnId(null)
                onSetDragOverTurn(null)
              }}
              title="Drag to reorder — drop on a row to nest as a sub-item"
              style={{
                width: 24,
                height: 24,
                marginLeft: -4,
                marginRight: -4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: theme.chat.muted,
                cursor: 'grab',
                flexShrink: 0,
                opacity: 0.6,
                borderRadius: 4,
                ...NON_SELECTABLE_UI_STYLE,
              }}
              onMouseEnter={(ev) => {
                ev.currentTarget.style.opacity = '1'
                ev.currentTarget.style.background = theme.surface.hover
              }}
              onMouseLeave={(ev) => {
                ev.currentTarget.style.opacity = '0.6'
                ev.currentTarget.style.background = 'transparent'
              }}
            >
              <GripVertical size={14} />
            </div>
            <div style={{
              width: 18,
              height: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isUrgent ? theme.status.danger : theme.chat.muted,
              flexShrink: 0,
              ...NON_SELECTABLE_UI_STYLE,
            }}>
              {isUrgent ? <AlertTriangle size={14} /> : <MessageSquare size={14} />}
            </div>
            <div
              title={isUrgent ? 'This queued message looks like a pasted error/crash log' : undefined}
              style={{
                minWidth: 0, flex: 1,
                color: isUrgent ? theme.status.danger : theme.chat.textSecondary,
                fontWeight: isUrgent ? 600 : undefined,
                fontSize: Math.max(11, fontSize - 2),
                fontFamily: fontSans,
                lineHeight: 1.35,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {turn.preview}
            </div>
            <button
              type="button"
              onClick={() => { void onSteerTurn(turn) }}
              style={{
                border: 'none',
                background: 'transparent',
                color: theme.chat.textSecondary,
                fontSize: 12,
                fontFamily: fontSans,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: 0,
                opacity: 1,
                flexShrink: 0,
                ...NON_SELECTABLE_UI_STYLE,
              }}
              title={isStreaming ? 'Send this message into the running stream' : 'Send this queued message now'}
            >
              <CornerDownRight size={14} />
              <span>Steer</span>
            </button>
            <button
              type="button"
              onClick={() => onDeleteTurn(turn.id)}
              style={{
                border: 'none',
                background: 'transparent',
                color: theme.chat.muted,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                flexShrink: 0,
                ...NON_SELECTABLE_UI_STYLE,
              }}
              title="Remove queued message"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}
    </ChatComposerDrawerFrame>
  )
}