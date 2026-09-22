import React, { useState, useRef } from 'react'
import { useTheme } from '../ThemeContext'

interface Props {
  /** Simple single-line label. Ignored if `content` is provided. */
  label?: string
  /** Rich tooltip body. When provided, disables nowrap and widens the tooltip. */
  content?: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'bottom'
  /** Horizontal alignment relative to the trigger. */
  align?: 'start' | 'center' | 'end'
  /** Delay before showing (ms). Defaults to 400. */
  delay?: number
  /** Max width for rich content. Defaults to 320px. */
  maxWidth?: number
}

export function Tooltip({
  label,
  content,
  children,
  side = 'bottom',
  align = 'center',
  delay = 400,
  maxWidth = 320,
}: Props): JSX.Element {
  const theme = useTheme()
  const isLight = theme.mode === 'light'
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = () => {
    timer.current = setTimeout(() => setVisible(true), delay)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setVisible(false)
  }

  const isRich = content !== undefined

  const alignStyles: React.CSSProperties =
    align === 'start'
      ? { left: 0 }
      : align === 'end'
      ? { right: 0 }
      : { left: '50%', transform: 'translateX(-50%)' }

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {visible && (
        <div
          style={{
            position: 'absolute',
            [side === 'bottom' ? 'top' : 'bottom']: '100%',
            ...alignStyles,
            marginTop: side === 'bottom' ? 5 : undefined,
            marginBottom: side === 'top' ? 5 : undefined,
            background: theme.surface.panelElevated,
            border: `1px solid ${theme.border.default}`,
            borderRadius: 4,
            padding: isRich ? '8px 10px' : '3px 7px',
            fontSize: 11,
            color: theme.text.secondary,
            whiteSpace: isRich ? 'normal' : 'nowrap',
            maxWidth: isRich ? maxWidth : undefined,
            pointerEvents: 'none',
            zIndex: 99999,
            boxShadow: isLight
              ? `0 4px 14px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
              : `0 2px 8px color-mix(in srgb, #000 40%, transparent)`,
          }}
        >
          {isRich ? content : label}
        </div>
      )}
    </div>
  )
}
