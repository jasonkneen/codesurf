import React, { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

export function SectionHeader({ label, collapsed, onToggle, extra }: { label: string; collapsed: boolean; onToggle: () => void; extra?: React.ReactNode }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        padding: '6px 12px 4px',
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
    <div style={{ padding: '6px 12px 4px', fontFamily: fonts.secondary, fontSize: Math.max(11, fonts.secondarySize + 1), fontWeight: 500, color: theme.text.disabled, userSelect: 'none', WebkitUserSelect: 'none' }}>
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
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
        userSelect: 'none', WebkitUserSelect: 'none', fontFamily: fonts.primary, fontSize: Math.max(fonts.size, 14),
        lineHeight: fonts.lineHeight, fontWeight: fonts.weight, textAlign: 'left',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, color: theme.text.muted, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ width: 14, color: theme.text.secondary, opacity: active ? 1 : 0, flexShrink: 0 }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
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
      const estimatedMenuWidth = 292
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

export function SidebarItem({ label, icon, active, muted, onClick, onContextMenu, indent = 0, extra, extraAlwaysVisible = false, extraWidth, title }: {
  label: string
  icon?: React.ReactNode
  active?: boolean
  muted?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  indent?: number
  extra?: React.ReactNode
  extraAlwaysVisible?: boolean
  extraWidth?: number
  /** Native tooltip (shown after OS delay) — useful for truncated labels / metadata. */
  title?: string
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        paddingTop: 4, paddingBottom: 4, paddingLeft: 12 + indent * 14,
        paddingRight: extra && (hovered || extraAlwaysVisible) ? 8 + (extraWidth ?? 20) : 8,
        minHeight: 30, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none', borderRadius: 6, margin: '0 6px',
        background: active ? theme.surface.selection : hovered ? theme.surface.hover : 'transparent',
        transition: 'background 0.1s ease', position: 'relative',
      }}
    >
      {icon && <span style={{ color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.muted, flexShrink: 0, display: 'flex', alignItems: 'center' }}>{icon}</span>}
      <span style={{
        fontSize: fonts.size, fontWeight: active ? Math.min(900, fonts.weight + 100) : fonts.weight, lineHeight: fonts.lineHeight,
        color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.secondary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
      }}>
        {label}
      </span>
      {extra && (
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: extraWidth, minWidth: 20, minHeight: 20,
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', opacity: hovered || extraAlwaysVisible ? 1 : 0,
          visibility: hovered || extraAlwaysVisible ? 'visible' : 'hidden', pointerEvents: hovered || extraAlwaysVisible ? 'auto' : 'none', transition: 'opacity 0.1s ease',
        }}>
          {extra}
        </span>
      )}
    </div>
  )
}
