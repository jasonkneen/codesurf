/**
 * Browser tile toolbar button — extracted verbatim from BrowserTile.tsx.
 * Self-contained presentational component (props + theme/fonts hooks).
 */
import React from 'react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

export function ToolbarButton({
  label,
  title,
  disabled,
  active,
  onClick,
  children
}: {
  label?: string
  title: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (disabled) return
    e.preventDefault()
    onClick()
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    // Keyboard activation still dispatches click with detail=0.
    if (!disabled && e.detail === 0) onClick()
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: disabled ? theme.text.disabled : active ? theme.accent.hover : theme.text.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: fonts.secondarySize
      }}
      onMouseEnter={e => {
        if (disabled || active) return
        e.currentTarget.style.color = theme.text.primary
      }}
      onMouseLeave={e => {
        if (disabled || active) return
        e.currentTarget.style.color = theme.text.secondary
      }}
    >
      {children}
    </button>
  )
}
