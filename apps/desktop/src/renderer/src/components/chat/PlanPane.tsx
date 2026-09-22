/**
 * PlanPane — right-docked plan panel inside ChatTile.
 *
 * Used in docked/fullscreen modes where there's no room for the canvas
 * slide-out. Participates in the ChatTile flex row so opening it shifts the
 * transcript + composer leftward instead of overlaying them.
 *
 * Header mimics the canvas slide-out styling (`PLAN` pill + timestamp +
 * collapse icon) so the two surfaces feel like the same object seen from
 * different angles — see "Mission Control" metaphor in PlanCard's docstring.
 */
import { useMemo } from 'react'
import { PanelRightClose } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import type { TileTodoItem } from '../../state/tileTodosStore'
import { PlanCard } from './PlanCard'

export interface PlanPaneProps {
  todos: TileTodoItem[]
  updatedAt?: number | null
  width?: number
  onClose: () => void
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function PlanPane({ todos, updatedAt, width = 320, onClose }: PlanPaneProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()

  const stamp = useMemo(() => (updatedAt ? formatClock(updatedAt) : ''), [updatedAt])

  return (
    <aside
      aria-label="Plan"
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${theme.border.subtle}`,
        background: theme.surface.panel,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderBottom: `1px solid ${theme.border.subtle}`,
          fontFamily: fonts.primary,
        }}
      >
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 6,
            background: theme.surface.accentSoft,
            color: theme.accent.base,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
          }}
        >
          Plan
        </span>
        {stamp && (
          <span
            style={{
              fontSize: 11,
              color: theme.chat.muted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {stamp}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close plan"
          aria-label="Close plan panel"
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: theme.chat.muted,
            cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.chat.text }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.chat.muted }}
        >
          <PanelRightClose size={15} />
        </button>
      </header>

      <div
        style={{
          padding: '10px 12px 4px 12px',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: theme.text.muted,
          fontFamily: fonts.primary,
        }}
      >
        Steps
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '2px 8px 12px 8px',
        }}
      >
        <PlanCard todos={todos} variant="pane" hideHeader />
      </div>
    </aside>
  )
}
