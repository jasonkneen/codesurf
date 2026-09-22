import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'

export interface MenuItem {
  label: string
  action: () => void
  danger?: boolean
  divider?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useTheme()
  const fonts = useAppFonts()
  const menuWidth = 180
  const menuHeight = items.filter(item => !item.divider).length * 32 + items.filter(item => item.divider).length * 7 + 8
  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const closeKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', closeKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeKey)
    }
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed',
    top,
    left,
    zIndex: 99999,
    background: theme.surface.panelElevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: 6,
    padding: '4px 0',
    minWidth: 180,
    boxShadow: theme.shadow.panel,
    userSelect: 'none',
    fontFamily: fonts.primary,
    fontSize: fonts.size,
  }

  return createPortal(
    <div ref={ref} style={style}>
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} style={{ height: 1, background: theme.border.default, margin: '3px 0' }} />
        ) : (
          <div
            key={i}
            style={{
              padding: '5px 14px',
              fontSize: fonts.size,
              fontFamily: fonts.primary,
              color: item.danger ? theme.status.danger : theme.text.secondary,
              cursor: 'pointer',
              borderRadius: 3,
              margin: '0 2px'
            }}
            onMouseEnter={e => (e.currentTarget.style.background = item.danger ? `color-mix(in srgb, ${theme.status.danger} 14%, transparent)` : theme.surface.hover)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => { item.action(); onClose() }}
          >
            {item.label}
          </div>
        )
      )}
    </div>,
    document.body,
  )
}
