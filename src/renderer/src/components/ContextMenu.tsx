import React, { useEffect, useRef } from 'react'

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

  // Keep menu on screen
  const style: React.CSSProperties = {
    position: 'fixed',
    top: y,
    left: x,
    zIndex: 99999,
    background: '#252526',
    border: '1px solid #3a3a3a',
    borderRadius: 6,
    padding: '4px 0',
    minWidth: 180,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    userSelect: 'none'
  }

  return (
    <div ref={ref} style={style}>
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} style={{ height: 1, background: '#333', margin: '3px 0' }} />
        ) : (
          <div
            key={i}
            style={{
              padding: '5px 14px',
              fontSize: 12,
              color: item.danger ? '#f44747' : '#cccccc',
              cursor: 'pointer',
              borderRadius: 3,
              margin: '0 2px'
            }}
            onMouseEnter={e => (e.currentTarget.style.background = item.danger ? '#3a1a1a' : '#2a2d2e')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => { item.action(); onClose() }}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  )
}
