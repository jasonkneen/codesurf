import React, { useState } from 'react'
import type { TileState, GroupState } from '../../../shared/types'
import { useTheme } from '../ThemeContext'

const GAP = 50
const SLIDEOUT_RESERVE_WIDTH = 272

type Mode = 'grid' | 'column' | 'row'

interface Props {
  tiles: TileState[]
  groups: GroupState[]
  onArrange: (updated: TileState[], mode: Mode) => void
  zoom: number
  onZoomToggle: () => void
  onToggleTabs: () => void
  isTabbedView?: boolean
  activeCanvasMode?: Mode | null
}

function getArrangeWidth(tile: TileState): number {
  const reserve = tile.type === 'terminal' || tile.type === 'chat' ? SLIDEOUT_RESERVE_WIDTH : 0
  return tile.width + reserve
}

function arrangeTiles(
  tiles: TileState[],
  _groups: GroupState[],
  mode: Mode
): TileState[] {
  if (tiles.length === 0) return tiles

  if (mode === 'column') {
    let y = 0
    return tiles.map(t => {
      const out = { ...t, x: 0, y }
      y += t.height + GAP
      return out
    })
  }

  if (mode === 'row') {
    let x = 0
    return tiles.map(t => {
      const w = getArrangeWidth(t)
      const out = { ...t, x, y: 0 }
      x += w + GAP
      return out
    })
  }

  const cols = Math.max(1, Math.round(Math.sqrt(tiles.length * 1.6)))
  const colW = Math.max(...tiles.map(t => t.width))

  const result: TileState[] = []
  let y = 0
  for (let row = 0; row * cols < tiles.length; row++) {
    const rowTiles = tiles.slice(row * cols, (row + 1) * cols)
    const rowH = Math.max(...rowTiles.map(t => t.height))
    for (let col = 0; col < rowTiles.length; col++) {
      result.push({
        ...rowTiles[col],
        x: col * (colW + GAP),
        y,
      })
    }
    y += rowH + GAP
  }
  return result
}

function Btn({ label, title, active, loading, onClick }: {
  label: React.ReactNode
  title: string
  active: boolean
  loading: boolean
  onClick: () => void
}): JSX.Element {
  const theme = useTheme()
  const baseColor = active ? theme.text.primary : theme.text.secondary
  const hoverColor = theme.text.primary

  return (
    <button
      title={title}
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 23,
        height: 23,
        borderRadius: 7,
        border: 'none',
        WebkitAppRegion: 'no-drag',
        background: 'transparent',
        color: baseColor,
        cursor: loading ? 'wait' : 'pointer',
        transition: 'color 0.12s ease, opacity 0.12s ease, transform 0.12s ease',
        fontSize: 12,
        opacity: loading ? 0.45 : active ? 1 : 0.96,
        padding: 0,
        boxShadow: 'none',
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.color = hoverColor
          e.currentTarget.style.opacity = '1'
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.color = baseColor
          e.currentTarget.style.opacity = loading ? '0.45' : '0.82'
        }
      }}
    >
      {label}
    </button>
  )
}

const TabsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round">
    <rect x="1" y="5" width="14" height="10" rx="1.5"/>
    <rect x="1" y="2" width="4" height="4" rx="1"/>
    <rect x="6" y="2" width="4" height="4" rx="1"/>
  </svg>
)

const GridIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round">
    <rect x="1" y="1" width="6" height="6" rx="1"/>
    <rect x="9" y="1" width="6" height="6" rx="1"/>
    <rect x="1" y="9" width="6" height="6" rx="1"/>
    <rect x="9" y="9" width="6" height="6" rx="1"/>
  </svg>
)

const ColumnIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round">
    <rect x="2" y="1" width="12" height="4" rx="1"/>
    <rect x="2" y="6" width="12" height="4" rx="1"/>
    <rect x="2" y="11" width="12" height="4" rx="1"/>
  </svg>
)

const RowIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round">
    <rect x="1" y="2" width="4" height="12" rx="1"/>
    <rect x="6" y="2" width="4" height="12" rx="1"/>
    <rect x="11" y="2" width="4" height="12" rx="1"/>
  </svg>
)

const CanvasBackIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.5 3H3v3.5" />
    <path d="M9.5 13H13V9.5" />
    <path d="M13 6.5V3H9.5" />
    <path d="M3 9.5V13h3.5" />
    <path d="M11 5 5 11" />
  </svg>
)

export function ArrangeToolbar({
  tiles,
  groups,
  onArrange,
  zoom,
  onZoomToggle,
  onToggleTabs,
  isTabbedView = false,
  activeCanvasMode = null,
}: Props): JSX.Element {
  const theme = useTheme()
  const [loading, setLoading] = useState(false)

  const isLight = theme.mode === 'light'
  const inCanvasMode = !isTabbedView
  // Toolbar palette anchored on theme tokens — text.primary alpha for
  // dividers and outlines, surface.app/panelMuted for the glass plate.
  const dividerBg = isLight
    ? `color-mix(in srgb, ${theme.text.primary} 14%, transparent)`
    : (inCanvasMode
        ? `color-mix(in srgb, ${theme.text.primary} 16%, transparent)`
        : `color-mix(in srgb, ${theme.text.primary} 8%, transparent)`)
  const zoomBg = isLight
    ? `color-mix(in srgb, ${theme.surface.app} 78%, transparent)`
    : (inCanvasMode
        ? `color-mix(in srgb, ${theme.surface.panelElevated} 92%, transparent)`
        : `color-mix(in srgb, ${theme.surface.panelMuted} 56%, transparent)`)
  const zoomBgHover = isLight
    ? `color-mix(in srgb, ${theme.surface.app} 92%, transparent)`
    : (inCanvasMode
        ? `color-mix(in srgb, ${theme.surface.panel} 98%, transparent)`
        : `color-mix(in srgb, ${theme.surface.panelMuted} 68%, transparent)`)
  const zoomBorder = isLight
    ? `color-mix(in srgb, ${theme.text.primary} 14%, transparent)`
    : (inCanvasMode
        ? `color-mix(in srgb, ${theme.text.primary} 14%, transparent)`
        : `color-mix(in srgb, ${theme.text.primary} 8%, transparent)`)
  const zoomBorderHover = isLight
    ? `color-mix(in srgb, ${theme.text.primary} 20%, transparent)`
    : (inCanvasMode
        ? `color-mix(in srgb, ${theme.text.primary} 22%, transparent)`
        : `color-mix(in srgb, ${theme.text.primary} 14%, transparent)`)
  const zoomTextColor = inCanvasMode ? theme.text.primary : (zoom === 1 ? theme.accent.base : theme.text.muted)

  const run = async (mode: Mode) => {
    if (tiles.length < 2 || loading) return
    setLoading(true)
    try {
      const updated = arrangeTiles(tiles, groups, mode)
      onArrange(updated, mode)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 6,
        right: 16,
        display: 'flex',
        gap: 4,
        height: 29,
        padding: '2px 0',
        background: 'transparent',
        pointerEvents: 'all',
        zIndex: 1000,
        alignItems: 'center',
        WebkitAppRegion: 'no-drag',
        border: 'none',
        borderRadius: 9,
      }}
    >
      <Btn label={<TabsIcon />} title="Fullview" active={isTabbedView} loading={false} onClick={onToggleTabs} />
      <div style={{ width: 1, height: 14, background: dividerBg, margin: '0 2px' }} />
      <Btn label={<GridIcon />} title="Grid layout (ELK)" active={!isTabbedView && activeCanvasMode === 'grid'} loading={loading} onClick={() => run('grid')} />
      <Btn label={<ColumnIcon />} title="Stack in column (ELK)" active={!isTabbedView && activeCanvasMode === 'column'} loading={loading} onClick={() => run('column')} />
      <Btn label={<RowIcon />} title="Arrange in row (ELK)" active={!isTabbedView && activeCanvasMode === 'row'} loading={loading} onClick={() => run('row')} />
      <div style={{ width: 1, height: 14, background: dividerBg, margin: '0 2px' }} />
      {isTabbedView ? (
        <Btn label={<CanvasBackIcon />} title="Back to canvas" active={false} loading={false} onClick={onToggleTabs} />
      ) : (
        <button
          onClick={onZoomToggle}
          title="Toggle zoom to 100%"
          style={{
            fontSize: 10,
            color: zoomTextColor,
            background: zoomBg,
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            WebkitAppRegion: 'no-drag',
            border: `1px solid ${zoomBorder}`,
            cursor: 'pointer',
            padding: '0 8px',
            borderRadius: 8,
            userSelect: 'none',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = theme.text.primary
            e.currentTarget.style.borderColor = zoomBorderHover
            e.currentTarget.style.background = zoomBgHover
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = zoomTextColor
            e.currentTarget.style.borderColor = zoomBorder
            e.currentTarget.style.background = zoomBg
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
      )}
    </div>
  )
}
