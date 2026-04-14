import React, { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import type { TileState, GroupState } from '../../../shared/types'
import { useTheme } from '../ThemeContext'

const GAP = 50
const GROUP_PAD = 20
const SLIDEOUT_RESERVE_WIDTH = 272

type Mode = 'grid' | 'column' | 'row'

interface Props {
  tiles: TileState[]
  groups: GroupState[]
  onArrange: (updated: TileState[], mode: Mode) => void
  zoom: number
  onZoomToggle: () => void
  onToggleTabs: () => void
  onOpenSettings: () => void
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  onNewFiles: () => void
  extensionTiles?: Array<{ extId: string; type: string; label: string; icon?: string }>
  onAddExtensionTile?: (type: string) => void
  isTabbedView?: boolean
  activeCanvasMode?: Mode | null
}

function getArrangeWidth(tile: TileState): number {
  const reserve = tile.type === 'terminal' || tile.type === 'chat' ? SLIDEOUT_RESERVE_WIDTH : 0
  return tile.width + reserve
}

// ─── Pure-math layouts ───────────────────────────────────────────────────────

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

  // Grid: keep each tile's natural size, pack into rows
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

// ─── Button ──────────────────────────────────────────────────────────────────
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
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 23, height: 23, borderRadius: 7,
        border: 'none',
        // @ts-ignore
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

// ─── SVG icons ───────────────────────────────────────────────────────────────
const TabsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="5" width="14" height="10" rx="1"/>
    <rect x="1" y="2" width="4" height="4" rx="1"/>
    <rect x="6" y="2" width="4" height="4" rx="1"/>
  </svg>
)

const GridIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="6" height="6" rx="1"/>
    <rect x="9" y="1" width="6" height="6" rx="1"/>
    <rect x="1" y="9" width="6" height="6" rx="1"/>
    <rect x="9" y="9" width="6" height="6" rx="1"/>
  </svg>
)

const ColumnIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="1" width="12" height="4" rx="1"/>
    <rect x="2" y="6" width="12" height="4" rx="1"/>
    <rect x="2" y="11" width="12" height="4" rx="1"/>
  </svg>
)

const RowIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="4" height="12" rx="1"/>
    <rect x="6" y="2" width="4" height="12" rx="1"/>
    <rect x="11" y="2" width="4" height="12" rx="1"/>
  </svg>
)

const QUICK_ACTION_ICONS: Record<string, JSX.Element> = {
  terminal: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M7 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>,
  browser: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M1 5h12" stroke="currentColor" strokeWidth="1.2" /></svg>,
  chat: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 2h10a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 2.5V10H2a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  files: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1 3C1 2.17 1.67 1.5 2.5 1.5H5L6.5 3H11.5C12.33 3 13 3.67 13 4.5V11C13 11.83 12.33 12.5 11.5 12.5H2.5C1.67 12.5 1 11.83 1 11V3Z" stroke="currentColor" strokeWidth="1.2" /></svg>,
  kanban: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /></svg>,
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────
export function ArrangeToolbar({
  tiles, groups, onArrange, zoom, onZoomToggle, onToggleTabs, onOpenSettings,
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles,
  extensionTiles, onAddExtensionTile,
  isTabbedView = false, activeCanvasMode = null,
}: Props): JSX.Element {
  const theme = useTheme()
  const [loading, setLoading] = useState(false)
  const [showExtMenu, setShowExtMenu] = useState(false)
  const extMenuRef = useRef<HTMLDivElement>(null)

  const isLight = theme.mode === 'light'
  const inCanvasMode = !isTabbedView
  const dividerBg = isLight ? 'rgba(0,0,0,0.14)' : (inCanvasMode ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)')
  const zoomBg = isLight ? 'rgba(255,255,255,0.78)' : (inCanvasMode ? 'rgba(33,36,43,0.92)' : 'rgba(20,20,20,0.56)')
  const zoomBgHover = isLight ? 'rgba(255,255,255,0.9)' : (inCanvasMode ? 'rgba(40,43,51,0.98)' : 'rgba(20,20,20,0.68)')
  const zoomBorder = isLight ? 'rgba(0,0,0,0.14)' : (inCanvasMode ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)')
  const zoomBorderHover = isLight ? 'rgba(0,0,0,0.2)' : (inCanvasMode ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.14)')
  const zoomTextColor = inCanvasMode ? theme.text.primary : (zoom === 1 ? theme.accent.base : theme.text.muted)
  const quickActionColor = inCanvasMode ? theme.text.secondary : theme.text.muted

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (extMenuRef.current && !extMenuRef.current.contains(target)) setShowExtMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    setShowExtMenu(false)
  }, [extensionTiles])

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
        bottom: 6,
        left: 16,
        right: 16,
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        pointerEvents: 'all',
        zIndex: 1000,
        alignItems: 'center',
        // @ts-ignore
        WebkitAppRegion: 'no-drag',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
        {([
          { label: 'Settings', icon: <Settings size={14} />, action: onOpenSettings },
          { label: 'New Terminal', icon: QUICK_ACTION_ICONS.terminal, action: onNewTerminal },
          { label: 'Agent Board', icon: QUICK_ACTION_ICONS.kanban, action: onNewKanban, disabled: true },
          { label: 'Browser', icon: QUICK_ACTION_ICONS.browser, action: onNewBrowser },
          { label: 'Chat', icon: QUICK_ACTION_ICONS.chat, action: onNewChat },
          { label: 'Files', icon: QUICK_ACTION_ICONS.files, action: onNewFiles },
        ] as { label: string; icon: React.ReactNode; action: () => void; disabled?: boolean }[]).map(btn => (
          <button
            key={btn.label}
            title={btn.disabled ? `${btn.label} disabled` : btn.label}
            onClick={btn.disabled ? undefined : btn.action}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: btn.disabled ? theme.text.disabled : quickActionColor,
              cursor: btn.disabled ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: btn.disabled ? 0.45 : 0.96,
              padding: 0,
            }}
            onMouseEnter={e => {
              if (!btn.disabled) {
                e.currentTarget.style.color = theme.text.primary
                e.currentTarget.style.opacity = '1'
              }
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = btn.disabled ? theme.text.disabled : quickActionColor
              e.currentTarget.style.opacity = btn.disabled ? '0.45' : '0.96'
            }}
          >
            {btn.icon}
          </button>
        ))}

        {extensionTiles && extensionTiles.length > 0 && (
          <div style={{ position: 'relative' }} ref={extMenuRef}>
            <button
              title="Extensions"
              onClick={() => setShowExtMenu(v => !v)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: showExtMenu ? theme.text.primary : quickActionColor,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: 0.96,
                padding: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = theme.text.primary
                e.currentTarget.style.opacity = '1'
              }}
              onMouseLeave={e => {
                if (!showExtMenu) e.currentTarget.style.color = quickActionColor
                e.currentTarget.style.opacity = '0.96'
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                <path d="M8 7.5h2a.5.5 0 01.5.5v1.5H10a1 1 0 00-1 1v0a1 1 0 001 1h.5V13a.5.5 0 01-.5.5H8V13a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H4.5A.5.5 0 014 13v-1.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H4V8a.5.5 0 01.5-.5H8z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.5" />
              </svg>
            </button>
            {showExtMenu && (
              <div style={{
                position: 'absolute',
                bottom: 'calc(100% + 6px)',
                left: 0,
                minWidth: 160,
                background: theme.surface.panelElevated,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 8,
                padding: 4,
                boxShadow: theme.shadow.panel,
                zIndex: 1000,
              }}>
                {extensionTiles.map(ext => (
                  <button
                    key={ext.type}
                    onClick={() => {
                      onAddExtensionTile?.(ext.type)
                      setShowExtMenu(false)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      color: theme.text.secondary,
                      fontSize: 13,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = theme.surface.panelMuted
                      e.currentTarget.style.color = theme.text.primary
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = theme.text.secondary
                    }}
                    title={ext.label}
                  >
                    <span>{ext.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          height: 29,
          padding: '2px 0',
          background: 'transparent',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
          border: 'none',
          borderRadius: 9,
          alignItems: 'center',
        }}
      >
        <Btn label={<Settings size={14} />} title="Settings" active={false} loading={false} onClick={onOpenSettings} />
        <div style={{ width: 1, height: 14, background: dividerBg, margin: '0 2px' }} />
        <Btn label={<TabsIcon />}   title="Fullview"                 active={isTabbedView}                              loading={false}   onClick={onToggleTabs} />
        <div style={{ width: 1, height: 14, background: dividerBg, margin: '0 2px' }} />
        <Btn label={<GridIcon />}   title="Grid layout (ELK)"        active={!isTabbedView && activeCanvasMode === 'grid'}   loading={loading} onClick={() => run('grid')} />
        <Btn label={<ColumnIcon />} title="Stack in column (ELK)"    active={!isTabbedView && activeCanvasMode === 'column'} loading={loading} onClick={() => run('column')} />
        <Btn label={<RowIcon />}    title="Arrange in row (ELK)"     active={!isTabbedView && activeCanvasMode === 'row'}    loading={loading} onClick={() => run('row')} />
        <div style={{ width: 1, height: 14, background: dividerBg, margin: '0 2px' }} />
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
            // @ts-ignore
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
      </div>
    </div>
  )
}
