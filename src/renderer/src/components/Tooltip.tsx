import React, { useState, useRef } from 'react'

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
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 4,
            padding: isRich ? '8px 10px' : '3px 7px',
            fontSize: 11,
            color: '#ccc',
            whiteSpace: isRich ? 'normal' : 'nowrap',
            maxWidth: isRich ? maxWidth : undefined,
            pointerEvents: 'none',
            zIndex: 99999,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          {isRich ? content : label}
        </div>
      )}
    </div>
  )
}
