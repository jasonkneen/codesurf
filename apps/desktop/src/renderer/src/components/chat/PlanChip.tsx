/**
 * PlanChip — composer toolbar button that surfaces the current plan's
 * progress and toggles the right-docked PlanPane.
 *
 * Mirrors the look of ChatTile's other toolbar pills (Provider, Model, Mode)
 * so it sits naturally in the primary toolbar row.
 */
import { useState } from 'react'
import { ListTodo } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import type { TileTodoItem } from '../../state/tileTodosStore'

export interface PlanChipProps {
  todos: TileTodoItem[]
  active: boolean
  onClick: () => void
}

export function PlanChip({ todos, active, onClick }: PlanChipProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hover, setHover] = useState(false)

  const completed = todos.reduce((n, t) => (t.status === 'completed' ? n + 1 : n), 0)
  const total = todos.length
  const inProgress = todos.some(t => t.status === 'in_progress')

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${completed}/${total} tasks • ${active ? 'Close' : 'Open'} plan pane`}
      aria-pressed={active}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: active ? theme.surface.hover : (hover ? theme.surface.panelMuted : 'transparent'),
        border: 'none',
        borderRadius: 6,
        padding: '4px 9px',
        cursor: 'pointer',
        fontSize: 11,
        fontFamily: fonts.primary,
        fontWeight: 500,
        color: inProgress ? theme.accent.base : (hover || active ? theme.chat.text : theme.chat.textSecondary),
        transition: 'color 0.12s, background 0.12s',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <ListTodo size={12} style={{ opacity: 0.85 }} />
      <span style={{ opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{completed}/{total}</span>
      <span>Tasks</span>
    </button>
  )
}
