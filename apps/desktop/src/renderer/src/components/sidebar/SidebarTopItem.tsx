/**
 * Sidebar top-level nav item — extracted verbatim from Sidebar.tsx.
 * Self-contained presentational component (props + theme/fonts hooks).
 */
import React, { useState } from 'react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

export function SidebarTopItem({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        minHeight: 28,
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: 8,
        padding: '3px 10px 3px 8px',
        border: 'none',
        borderRadius: 6,
        background: hovered ? theme.surface.hover : 'transparent',
        color: theme.text.secondary,
        cursor: 'pointer',
        fontFamily: fonts.primary,
        fontSize: fonts.size,
        fontWeight: fonts.weight,
        lineHeight: fonts.lineHeight,
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 24,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.text.muted,
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingBottom: 1 }}>
        {label}
      </span>
    </button>
  )
}
