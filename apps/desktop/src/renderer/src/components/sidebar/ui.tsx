import React, { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

export const SIDEBAR_MENU_WIDTH = 264

export function SectionHeader({ label, collapsed, onToggle, extra }: { label: string; collapsed: boolean; onToggle: () => void; extra?: React.ReactNode }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
        padding: '6px 8px 4px',
        cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <svg width="8" height="8" viewBox="0 0 8 8" style={{ transition: 'transform 0.15s ease', transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', opacity: 0.5, flexShrink: 0 }}>
          <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontFamily: fonts.secondary, fontSize: fonts.secondarySize - 2, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1.2, textTransform: 'uppercase' }}>
          {label}
        </span>
      </div>
      {extra && <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>{extra}</div>}
    </div>
  )
}

export function ThreadMenuSectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{ padding: '4px 12px 2px', fontFamily: fonts.secondary, fontSize: Math.max(10, fonts.secondarySize), fontWeight: 500, color: theme.text.disabled, userSelect: 'none', WebkitUserSelect: 'none' }}>
      {children}
    </div>
  )
}

export function ThreadMenuItem({ icon, label, active = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', border: 'none', background: hovered ? theme.surface.hover : 'transparent', color: active ? theme.text.primary : theme.text.secondary,
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
        userSelect: 'none', WebkitUserSelect: 'none', fontFamily: fonts.primary, fontSize: fonts.size,
        lineHeight: fonts.lineHeight, fontWeight: fonts.weight, textAlign: 'left',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, color: theme.text.muted, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ width: 12, color: theme.text.secondary, opacity: active ? 1 : 0, flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M3 7.3 5.7 10 11 4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  )
}

export function SidebarMenuPortal({ anchorRef, children }: { anchorRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }): React.JSX.Element | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) {
        setPosition(null)
        return
      }
      const rect = anchor.getBoundingClientRect()
      const estimatedMenuWidth = SIDEBAR_MENU_WIDTH
      setPosition({
        top: rect.bottom + 6,
        left: Math.min(Math.max(8, rect.right - estimatedMenuWidth), Math.max(8, window.innerWidth - estimatedMenuWidth - 8)),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef])

  if (!position) return null

  return createPortal(
    <div data-sidebar-menu-portal="true" style={{ position: 'fixed', top: position.top, left: position.left, zIndex: 4000 }}>
      {children}
    </div>,
    document.body,
  )
}

export function SidebarItem({ label, icon, active, muted, emphasize, compact = false, onClick, onContextMenu, indent = 0, indentUnit = 10, extra, extraAlwaysVisible = false, extraWidth, idleExtra, idleExtraWidth = 44, title }: {
  label: string
  icon?: React.ReactNode
  active?: boolean
  muted?: boolean
  compact?: boolean
  /**
   * Subtle "you are here" marker, independent of `active` (which is loud: bg +
   * accent color). Three states:
   *   - `true`  → bold label (primary color)
   *   - `false` → slightly subdued label (text.muted)
   *   - `undefined` → no effect
   *
   * Used by the session list so the currently focused chat reads heavier than
   * its siblings without lighting up like a folder selection.
   */
  emphasize?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  indent?: number
  /** px per indent level (default 10). Lower values bring nested items closer to the edge. */
  indentUnit?: number
  extra?: React.ReactNode
  extraAlwaysVisible?: boolean
  extraWidth?: number
  /**
   * Content shown on the right side of the row ONLY when not hovered (and
   * `extra` is not always visible). Swapped out for `extra` on hover — used
   * e.g. for codex-style relative timestamps that give way to row actions.
   */
  idleExtra?: React.ReactNode
  /** Reserved right-side space for `idleExtra` so the label ellipsises cleanly before hitting it. */
  idleExtraWidth?: number
  /** Native tooltip (shown after OS delay) — useful for truncated labels / metadata. */
  title?: string
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  const labelWeight = active
    ? Math.min(900, fonts.weight + 100)
    : emphasize === true
      ? Math.min(900, fonts.weight + 100)
      : fonts.weight
  const labelColor = active
    ? theme.accent.base
    : muted
      ? theme.text.disabled
      : emphasize === true
        ? theme.text.primary
        : emphasize === false
          ? theme.text.muted
          : theme.text.secondary
  return (
    <div
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: compact ? 8 : 6,
        paddingTop: compact ? 2 : 4, paddingBottom: compact ? 2 : 4, paddingLeft: 8 + indent * indentUnit,
        paddingRight: extra && (hovered || extraAlwaysVisible)
          ? 6 + (extraWidth ?? 20)
          : idleExtra && !extraAlwaysVisible
            ? 6 + idleExtraWidth
            : 6,
        minHeight: compact ? 25 : 28, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none', borderRadius: 6, margin: '0 4px',
        background: active ? theme.surface.selection : hovered ? theme.surface.hover : 'transparent',
        transition: 'background 0.1s ease', position: 'relative',
      }}
    >
      {icon && (
        <span
          style={{
            color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.muted,
            flex: '0 0 24px',
            width: 24,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 1,
          }}
        >
          {icon}
        </span>
      )}
      <span style={{
        fontSize: fonts.size, fontWeight: labelWeight, lineHeight: compact ? fonts.lineHeight * 0.9 : fonts.lineHeight,
        color: labelColor,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
      }}>
        {label}
      </span>
      {idleExtra && !extraAlwaysVisible && (
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          color: theme.text.disabled, fontSize: Math.max(10, fonts.secondarySize - 1), fontWeight: 500,
          lineHeight: 1, whiteSpace: 'nowrap', pointerEvents: 'none',
          opacity: hovered ? 0 : 1, visibility: hovered ? 'hidden' : 'visible',
          transition: 'opacity 0.1s ease',
        }}>
          {idleExtra}
        </span>
      )}
      {extra && (
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', width: extraWidth, minWidth: 20, minHeight: 20,
          position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)', opacity: hovered || extraAlwaysVisible ? 1 : 0,
          visibility: hovered || extraAlwaysVisible ? 'visible' : 'hidden', pointerEvents: hovered || extraAlwaysVisible ? 'auto' : 'none', transition: 'opacity 0.1s ease',
        }}>
          {extra}
        </span>
      )}
    </div>
  )
}
