/**
 * Generic sidebar list row (sessions, projects, items) — extracted verbatim
 * from Sidebar.tsx. Pure presentational: props in, theme/fonts from context,
 * local hover state only.
 */
import React, { useState } from 'react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

const SIDEBAR_RIGHT_RAIL_WIDTH = 44
// Nudge action buttons onto the same optical center as the timestamp rail so
// hovering a row swaps time for archive without a lateral jump.
const SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2

export function SessionSidebarRow({
  label,
  meta,
  icon,
  active,
  muted,
  emphasize,
  onClick,
  onContextMenu,
  indent = 0,
  indentUnit = 10,
  extra,
  extraWidth,
  leading,
  leadingVisible,
  trailing,
  title,
  onDoubleClick,
}: {
  label: string
  meta?: string
  icon?: React.ReactNode
  active?: boolean
  muted?: boolean
  emphasize?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  indent?: number
  indentUnit?: number
  extra?: React.ReactNode
  extraWidth?: number
  leading?: React.ReactNode
  leadingVisible?: boolean
  trailing?: React.ReactNode
  title?: string
  onDoubleClick?: () => void
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
    ? theme.text.primary
    : muted
      ? theme.text.disabled
      : emphasize === true
        ? theme.text.primary
        : emphasize === false
          ? theme.text.muted
          : theme.text.primary
  const metaColor = muted
    ? theme.text.disabled
    : active
      ? theme.text.secondary
      : theme.text.disabled
  const leadingIconLeft = Math.max(0, 8 + indent * indentUnit - 14)
  const activeBackground = theme.mode === 'light'
    ? `color-mix(in srgb, ${theme.surface.app} 56%, transparent)`
    : `color-mix(in srgb, ${theme.text.primary} 7.5%, transparent)`
  const hoverBackground = theme.mode === 'light'
    ? `color-mix(in srgb, ${theme.surface.app} 34%, transparent)`
    : theme.surface.hover
  const activeShadow = theme.mode === 'light'
    ? `inset 0 0 0 1px color-mix(in srgb, ${theme.surface.app} 90%, transparent), 0 0 0 1px color-mix(in srgb, ${theme.text.primary} 6%, transparent)`
    : 'var(--cs-edge-shadow)'

  return (
    <div
      className={`cs-thread-row${active ? ' cs-thread-row-active' : ''}`}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: `${leading ? 22 : 0}px minmax(0, 1fr) ${SIDEBAR_RIGHT_RAIL_WIDTH}px`,
        alignItems: 'center',
        columnGap: leading ? 6 : 0,
        paddingTop: meta ? 6 : 4,
        paddingBottom: meta ? 6 : 4,
        paddingLeft: `calc(var(--cs-sidebar-row-pad-x) + ${indent * indentUnit}px)`,
        paddingRight: 5,
        minHeight: meta ? 40 : 28,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        borderRadius: 'var(--cs-sidebar-row-radius)',
        margin: '0',
        background: 'transparent',
        boxShadow: 'none',
        transition: 'background 0.1s ease, box-shadow 0.1s ease',
        position: 'relative',
        ...({ '--cs-thread-row-accent': active ? theme.accent.base : theme.text.muted } as React.CSSProperties),
      }}
    >
      {(active || hovered) && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 1,
            bottom: 1,
            borderRadius: 'inherit',
            background: active ? activeBackground : hoverBackground,
            boxShadow: active ? activeShadow : 'var(--cs-edge-shadow-subtle)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
      <span
        style={{
          width: 22,
          display: leading ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: leadingVisible || hovered || active ? 1 : 0,
          transition: 'opacity 0.1s ease',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {leading}
      </span>
      {icon && (
        <span
          style={{
            position: 'absolute',
            left: leadingIconLeft,
            top: '50%',
            transform: 'translateY(-50%)',
            color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.muted,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          {icon}
        </span>
      )}
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: meta ? 2 : 0, position: 'relative', zIndex: 1 }}>
        <span style={{
          fontSize: fonts.size,
          fontWeight: labelWeight,
          lineHeight: fonts.lineHeight,
          color: labelColor,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        {meta && (
          <span style={{
            fontSize: Math.max(10, fonts.secondarySize - 1),
            fontWeight: 500,
            lineHeight: 1.25,
            color: metaColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {meta}
          </span>
        )}
      </div>
      {trailing && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          width: SIDEBAR_RIGHT_RAIL_WIDTH,
          minWidth: SIDEBAR_RIGHT_RAIL_WIDTH,
          paddingRight: 8,
          boxSizing: 'border-box',
          color: active ? theme.text.secondary : muted ? theme.text.disabled : theme.text.disabled,
          opacity: extra && hovered ? 0 : 1,
          transition: 'opacity 0.1s ease',
          position: 'relative',
          zIndex: 1,
        }}>
          {trailing}
        </span>
      )}
      {extra && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          width: extraWidth,
          minWidth: 20,
          minHeight: 20,
          position: 'absolute',
          right: SIDEBAR_RIGHT_RAIL_ACTION_RIGHT,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: hovered ? 1 : 0,
          visibility: hovered ? 'visible' : 'hidden',
          pointerEvents: hovered ? 'auto' : 'none',
          zIndex: 1,
          transition: 'opacity 0.1s ease',
        }}>
          {extra}
        </span>
      )}
    </div>
  )
}
