import React, { useState } from 'react'
import { ChevronDown, Lock } from 'lucide-react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

const TOOLBAR_TEXT_SIZE = 12
const CHAT_FOOTER_TEXT_SIZE = 12
const TOOLBAR_CHEVRON_SIZE = 12

const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

export function ToolbarBtn({ icon, tooltip, color, onClick }: {
  icon: React.ReactNode
  tooltip: string
  color?: string
  onClick: () => void
}): JSX.Element {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      title={tooltip}
      style={{
        background: hovered ? theme.surface.hover : 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '5px 7px',
        borderRadius: 6,
        color: color ?? (hovered ? theme.chat.text : theme.chat.muted),
        transition: 'color 0.1s, background 0.1s',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...NON_SELECTABLE_UI_STYLE,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {icon}
    </button>
  )
}

export function ToolbarPill({ prefix, label, color, active, onClick, disabled, title }: {
  prefix?: React.ReactNode
  label: string
  color?: string
  active: boolean
  onClick: () => void
  disabled?: boolean
  title?: string
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: !disabled && active ? theme.surface.hover : (!disabled && hovered ? theme.surface.panelMuted : 'transparent'),
        border: 'none',
        borderRadius: 6,
        padding: '4px 9px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: TOOLBAR_TEXT_SIZE,
        fontFamily: fonts.primary,
        color: color ?? (disabled ? theme.chat.muted : hovered ? theme.chat.text : theme.chat.textSecondary),
        transition: 'color 0.1s, background 0.1s',
        whiteSpace: 'nowrap',
        maxWidth: 180,
        overflow: 'hidden',
        opacity: disabled ? 0.6 : 1,
        ...NON_SELECTABLE_UI_STYLE,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {prefix && <span style={{ display: 'flex', opacity: 0.8 }}>{prefix}</span>}
      <span className="cs-toolbar-pill-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {disabled
        ? <Lock size={TOOLBAR_CHEVRON_SIZE - 1} style={{ marginLeft: 1, opacity: 0.55, flexShrink: 0 }} />
        : <ChevronDown size={TOOLBAR_CHEVRON_SIZE} style={{ marginLeft: 1, opacity: 0.4, flexShrink: 0 }} />}
    </button>
  )
}

// Mode-pill accent colours are tuned for dark backgrounds. On light surfaces
// the bright tokens (especially green) wash out and read as pastel — map them
// to denser, WCAG-friendly variants when the theme is in light mode.
const FOOTER_PILL_LIGHT_COLOR: Record<string, string> = {
  '#3fb950': '#1f883d', // green  → deeper moss
  '#58a6ff': '#1f6feb', // blue   → deeper cobalt
  '#ffb432': '#a66300', // amber  → darker ochre
  '#e54d2e': '#c3361c', // red    → darker crimson
}

export function FooterPill({ prefix, label, color, active, onClick }: {
  prefix?: React.ReactNode
  label: string
  color?: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  const isLight = theme.mode === 'light'
  const resolvedColor = color
    ? (isLight ? (FOOTER_PILL_LIGHT_COLOR[color.toLowerCase()] ?? color) : color)
    : undefined

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        border: 'none',
        borderRadius: 999,
        padding: '3px 10px',
        cursor: 'pointer',
        fontSize: CHAT_FOOTER_TEXT_SIZE,
        fontFamily: fonts.primary,
        color: resolvedColor ?? (active || hovered ? theme.chat.text : theme.chat.textSecondary),
        transition: 'color 0.1s',
        whiteSpace: 'nowrap',
        minHeight: 24,
        ...NON_SELECTABLE_UI_STYLE,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {prefix && <span style={{ display: 'flex', opacity: 0.9 }}>{prefix}</span>}
      <span className="cs-footer-pill-label">{label}</span>
      <ChevronDown size={TOOLBAR_CHEVRON_SIZE} style={{ opacity: 0.5, flexShrink: 0 }} />
    </button>
  )
}
