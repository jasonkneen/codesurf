/**
 * PlanCard — shared renderer for the agent's current TodoWrite list.
 *
 * Three placements consume this same component (Mission Control pattern — one
 * telemetry downlink, many console projections):
 *   - inline in the chat transcript, as the upgraded TodoWrite tool output
 *   - inside `PlanPane` on the right of ChatTile when docked / fullscreen
 *   - inside the existing canvas slide-out popover (future — same shape)
 *
 * Variants:
 *   - 'inline'     — bordered panel, for use in the scrollable transcript
 *   - 'pane'       — flat, borderless, used inside PlanPane's own chrome
 *
 * Relies on the `chat-spin` keyframe that ChatTile injects globally via
 * `ensureShimmerStyles()` — safe to use because PlanCard only ever mounts
 * inside a rendered ChatTile.
 */
import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Check, Circle } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import type { TileTodoItem } from '../../state/tileTodosStore'

export interface PlanCardProps {
  todos: TileTodoItem[]
  defaultCollapsed?: boolean
  variant?: 'inline' | 'pane'
  /** Hide the header summary row (used when the parent already shows one). */
  hideHeader?: boolean
}

export const PlanCard = React.memo(function PlanCard({
  todos,
  defaultCollapsed = false,
  variant = 'inline',
  hideHeader = false,
}: PlanCardProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  const completed = todos.reduce((n, t) => (t.status === 'completed' ? n + 1 : n), 0)
  const total = todos.length
  const inProgressIdx = todos.findIndex(t => t.status === 'in_progress')

  const isInline = variant === 'inline'

  return (
    <div style={{
      ...(isInline ? {
        border: `1px solid ${theme.border.subtle}`,
        borderRadius: 10,
        background: theme.surface.panelMuted,
        padding: '10px 12px',
      } : {
        padding: '4px 0',
      }),
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontFamily: fonts.primary,
      minWidth: 0,
    }}>
      {!hideHeader && (
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 0',
            color: theme.chat.textSecondary,
            fontSize: 11,
            fontFamily: fonts.primary,
            textAlign: 'left',
          }}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>{completed} out of {total} task{total === 1 ? '' : 's'} completed</span>
        </button>
      )}
      {!collapsed && (
        <ol style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}>
          {todos.map((todo, i) => {
            const status = todo.status
            const isActive = i === inProgressIdx
            const isDone = status === 'completed'
            const iconColor = isDone
              ? theme.status.success
              : status === 'in_progress'
                ? theme.accent.base
                : theme.chat.muted
            const label = status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content
            return (
              <li key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '5px 8px',
                borderRadius: 6,
                background: isActive ? theme.surface.accentSoft : 'transparent',
                fontSize: 12,
                color: theme.chat.text,
                lineHeight: 1.4,
              }}>
                <span style={{
                  width: 14, height: 14, minWidth: 14,
                  marginTop: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: iconColor,
                }}>
                  {isDone ? (
                    <Check size={11} strokeWidth={3} />
                  ) : isActive ? (
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%',
                      border: `2px solid ${theme.accent.base}`,
                      borderTopColor: 'transparent',
                      animation: 'chat-spin 0.9s linear infinite',
                      display: 'inline-block',
                    }} />
                  ) : (
                    <Circle size={9} strokeWidth={2} />
                  )}
                </span>
                <span style={{
                  textDecoration: isDone ? 'line-through' : undefined,
                  opacity: isDone ? 0.55 : 1,
                  wordBreak: 'break-word',
                  flex: 1,
                  fontWeight: isActive ? 500 : 400,
                }}>
                  {label}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
})
