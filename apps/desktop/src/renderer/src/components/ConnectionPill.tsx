import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Link2, Lock, Unlock } from 'lucide-react'
import { useTheme } from '../ThemeContext'

interface Props {
  x: number
  y: number
  zoom: number
  isLocked: boolean
  onToggleLock: () => void
  onDelete: () => void
  /** Discovery color RGB string, e.g. "53, 104, 255" */
  dscLine: string
}

export function ConnectionPill({ x, y, zoom: _zoom, isLocked, onToggleLock, onDelete: _onDelete, dscLine }: Props): JSX.Element {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (collapseTimer.current) clearTimeout(collapseTimer.current) }
  }, [])

  const handleMouseEnter = useCallback(() => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null }
    setExpanded(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    collapseTimer.current = setTimeout(() => setExpanded(false), 400)
  }, [])

  const isLight = theme.mode === 'light'
  // Pill body anchored on theme surfaces. The dynamic dscLine is the
  // discovery-route line color (bright cyan/blue per mode) — kept as the
  // categorical accent for the border so the connection's identity is
  // preserved regardless of palette/contrast.
  const pillBg = isLight
    ? `color-mix(in srgb, ${theme.surface.app} 97%, transparent)`
    : `color-mix(in srgb, ${theme.surface.app} 96%, transparent)`
  const pillBorder = `rgba(${dscLine}, ${expanded ? 0.5 : 0.35})`
  const activeColor = isLight ? theme.accent.base : `rgba(${dscLine}, 0.95)`
  const mutedColor = isLight ? theme.text.disabled : `rgba(${dscLine}, 0.35)`

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null }
    onToggleLock()
  }, [onToggleLock])

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        zIndex: 99999,
        pointerEvents: 'all',
        isolation: 'isolate',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: expanded ? 0 : 0,
          height: 24,
          padding: expanded ? '0 3px' : '0',
          width: expanded ? 'auto' : 24,
          minWidth: 24,
          borderRadius: 999,
          background: pillBg,
          border: `1px solid ${pillBorder}`,
          boxShadow: `0 4px 16px color-mix(in srgb, #000 ${isLight ? 12 : 28}%, transparent)`,
          cursor: 'pointer',
          transition: 'width 0.18s ease, padding 0.18s ease, border-color 0.15s ease',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
        onClick={handleClick}
      >
        {/* Lock — left side */}
        {expanded && (
          <div style={{
            width: 20, height: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: isLocked ? activeColor : mutedColor,
            flexShrink: 0,
            transition: 'color 0.12s ease',
          }}>
            <Lock size={11} strokeWidth={isLocked ? 2.4 : 1.6} />
          </div>
        )}

        {/* Link icon — center */}
        <div style={{
          width: 20, height: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: activeColor,
          flexShrink: 0,
        }}>
          <Link2 size={expanded ? 11 : 12} strokeWidth={2.2} />
        </div>

        {/* Unlock — right side */}
        {expanded && (
          <div style={{
            width: 20, height: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: !isLocked ? activeColor : mutedColor,
            flexShrink: 0,
            transition: 'color 0.12s ease',
          }}>
            <Unlock size={11} strokeWidth={!isLocked ? 2.4 : 1.6} />
          </div>
        )}
      </div>
    </div>
  )
}
