import React, { useState } from 'react'
import { Settings } from 'lucide-react'
import type { TileState, GroupState } from '../../../shared/types'

const GAP = 40
const GROUP_PAD = 20
const SLIDEOUT_RESERVE_WIDTH = 272

type Mode = 'grid' | 'column' | 'row'

type ArrangeItem = {
  id: string
  kind: 'tile' | 'group'
  x: number
  y: number
  width: number
  height: number
  tileIds: string[]
}

interface Props {
  tiles: TileState[]
  groups: GroupState[]
  onArrange: (updated: TileState[], mode: Mode) => void
  zoom: number
  onZoomToggle: () => void
  onToggleTabs: () => void
  onOpenSettings: () => void
  isTabbedView?: boolean
  activeCanvasMode?: Mode | null
}

function arrangeGrid(items: ArrangeItem[]): ArrangeItem[] {
  if (items.length === 0) return items

  const sorted = [...items].sort((a, b) => (b.height * b.width) - (a.height * a.width))
  const originX = Math.min(...items.map(t => t.x))
  const originY = Math.min(...items.map(t => t.y))
  const totalArea = items.reduce((sum, t) => sum + (t.width * t.height), 0)
  const targetRowWidth = Math.max(
    Math.max(...items.map(t => t.width)),
    Math.round(Math.sqrt(totalArea) * 1.35)
  )

  let cursorX = originX
  let cursorY = originY
  let rowHeight = 0

  const placed = new Map<string, ArrangeItem>()

  for (const item of sorted) {
    const nextWidth = cursorX === originX ? item.width : (cursorX - originX) + GAP + item.width
    if (nextWidth > targetRowWidth && cursorX !== originX) {
      cursorX = originX
      cursorY += rowHeight + GAP
      rowHeight = 0
    }

    placed.set(item.id, {
      ...item,
      x: cursorX,
      y: cursorY,
    })

    cursorX += item.width + GAP
    rowHeight = Math.max(rowHeight, item.height)
  }

  return items.map(item => placed.get(item.id) ?? item)
}

function arrangeColumn(items: ArrangeItem[]): ArrangeItem[] {
  if (items.length === 0) return items
  const sorted = [...items].sort((a, b) => a.y - b.y)
  const originX = Math.min(...items.map(t => t.x))
  let cursor = Math.min(...items.map(t => t.y))
  return sorted.map(item => {
    const placed = { ...item, x: originX, y: cursor }
    cursor += item.height + GAP
    return placed
  })
}

function arrangeRow(items: ArrangeItem[]): ArrangeItem[] {
  if (items.length === 0) return items
  const sorted = [...items].sort((a, b) => a.x - b.x)
  const originY = Math.min(...items.map(t => t.y))
  let cursor = Math.min(...items.map(t => t.x))
  return sorted.map(item => {
    const placed = { ...item, x: cursor, y: originY }
    cursor += item.width + GAP
    return placed
  })
}

function getArrangeWidth(tile: TileState): number {
  const reserve = tile.type === 'terminal' || tile.type === 'chat' ? SLIDEOUT_RESERVE_WIDTH : 0
  return tile.width + reserve
}

function buildArrangeItems(tiles: TileState[], groups: GroupState[]): ArrangeItem[] {
  const groupMap = new Map(groups.map(group => [group.id, group]))
  const childrenByGroup = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.parentGroupId) continue
    const siblings = childrenByGroup.get(group.parentGroupId) ?? []
    siblings.push(group.id)
    childrenByGroup.set(group.parentGroupId, siblings)
  }

  const collectGroupTileIds = (groupId: string): string[] => {
    const direct = tiles.filter(tile => tile.groupId === groupId).map(tile => tile.id)
    const childGroups = childrenByGroup.get(groupId) ?? []
    return [...direct, ...childGroups.flatMap(childId => collectGroupTileIds(childId))]
  }

  const findRootGroupId = (groupId?: string): string | undefined => {
    let current = groupId
    while (current) {
      const group = groupMap.get(current)
      if (!group?.parentGroupId || !groupMap.has(group.parentGroupId)) return current
      current = group.parentGroupId
    }
    return undefined
  }

  const topLevelGroups = groups.filter(group => !group.parentGroupId || !groupMap.has(group.parentGroupId))
  const groupedTileIds = new Set<string>()
  const items: ArrangeItem[] = []

  for (const group of topLevelGroups) {
    const tileIds = collectGroupTileIds(group.id)
    if (tileIds.length === 0) continue
    const members = tiles.filter(tile => tileIds.includes(tile.id))
    if (members.length === 0) continue
    tileIds.forEach(id => groupedTileIds.add(id))
    const minX = Math.min(...members.map(tile => tile.x)) - GROUP_PAD
    const minY = Math.min(...members.map(tile => tile.y)) - GROUP_PAD
    const maxX = Math.max(...members.map(tile => tile.x + getArrangeWidth(tile))) + GROUP_PAD
    const maxY = Math.max(...members.map(tile => tile.y + tile.height)) + GROUP_PAD
    items.push({
      id: group.id,
      kind: 'group',
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      tileIds,
    })
  }

  for (const tile of tiles) {
    const rootGroupId = findRootGroupId(tile.groupId)
    if (rootGroupId && groupedTileIds.has(tile.id)) continue
    items.push({
      id: tile.id,
      kind: 'tile',
      x: tile.x,
      y: tile.y,
      width: getArrangeWidth(tile),
      height: tile.height,
      tileIds: [tile.id],
    })
  }

  return items
}

function applyArrangement(tiles: TileState[], groups: GroupState[], mode: Mode): TileState[] {
  const items = buildArrangeItems(tiles, groups)
  if (items.length === 0) return tiles

  const arranged = mode === 'grid'
    ? arrangeGrid(items)
    : mode === 'column'
      ? arrangeColumn(items)
      : arrangeRow(items)

  const originalById = new Map(items.map(item => [item.id, item]))
  const deltaByTileId = new Map<string, { dx: number; dy: number }>()

  for (const item of arranged) {
    const original = originalById.get(item.id)
    if (!original) continue
    const dx = item.x - original.x
    const dy = item.y - original.y
    for (const tileId of original.tileIds) deltaByTileId.set(tileId, { dx, dy })
  }

  return tiles.map(tile => {
    const delta = deltaByTileId.get(tile.id)
    return delta ? { ...tile, x: tile.x + delta.dx, y: tile.y + delta.dy } : tile
  })
}

// ─── Button ──────────────────────────────────────────────────────────────────
function Btn({ label, title, active, loading, onClick }: {
  label: React.ReactNode
  title: string
  active: boolean
  loading: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 23, height: 23, borderRadius: 7,
        border: `1px solid ${active ? 'rgba(90,170,255,0.42)' : '#2d2d2d'}`,
        // @ts-ignore
        WebkitAppRegion: 'no-drag',
        background: active
          ? 'linear-gradient(180deg, rgba(74,158,255,0.20) 0%, rgba(74,158,255,0.10) 100%)'
          : 'rgba(30,30,30,0.9)',
        color: active ? '#d7ebff' : '#888',
        cursor: loading ? 'wait' : 'pointer',
        transition: 'all 0.12s ease',
        fontSize: 12,
        opacity: loading ? 0.5 : 1,
        boxShadow: active
          ? 'inset 0 1px 0 rgba(255,255,255,0.14), 0 8px 24px rgba(24,84,160,0.28), 0 0 0 1px rgba(74,158,255,0.08)'
          : 'none',
        backdropFilter: active ? 'blur(14px)' : 'none',
        WebkitBackdropFilter: active ? 'blur(14px)' : 'none',
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(74,158,255,0.08)'
          e.currentTarget.style.color = '#aaa'
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(30,30,30,0.9)'
          e.currentTarget.style.color = '#888'
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

// ─── Toolbar ─────────────────────────────────────────────────────────────────
export function ArrangeToolbar({ tiles, groups, onArrange, zoom, onZoomToggle, onToggleTabs, onOpenSettings, isTabbedView = false, activeCanvasMode = null }: Props): JSX.Element {
  const [loading, setLoading] = useState(false)

  const run = (mode: Mode) => {
    if (tiles.length < 2 || loading) return
    setLoading(true)
    try {
      const updated = applyArrangement(tiles, groups, mode)
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
        gap: 6,
        pointerEvents: 'all',
        zIndex: 1000,
        alignItems: 'center',
        // @ts-ignore
        WebkitAppRegion: 'no-drag',
      }}
    >
      <button
        onClick={onOpenSettings}
        title="Settings"
        style={{
          width: 29,
          height: 29,
          borderRadius: 9,
          background: 'rgba(20,20,20,0.92)',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
          border: '1px solid #2d2d2d',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          transition: 'all 0.12s ease',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(74,158,255,0.08)'
          e.currentTarget.style.color = '#ccc'
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(20,20,20,0.92)'
          e.currentTarget.style.color = '#888'
          e.currentTarget.style.borderColor = '#2d2d2d'
        }}
      >
        <Settings size={14} />
      </button>

      <div
        style={{
          display: 'flex',
          gap: 4,
          height: 29,
          padding: '2px 6px',
          background: 'rgba(20,20,20,0.92)',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
          border: '1px solid #2d2d2d',
          borderRadius: 9,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          alignItems: 'center',
        }}
      >
        <Btn label={<TabsIcon />}   title="Tabbed view"              active={isTabbedView}                              loading={false}   onClick={onToggleTabs} />
        <div style={{ width: 1, height: 14, background: '#2d2d2d', margin: '0 1px' }} />
        <Btn label={<GridIcon />}   title="Grid layout (auto-wrap)"  active={!isTabbedView && activeCanvasMode === 'grid'}   loading={loading} onClick={() => run('grid')} />
        <Btn label={<ColumnIcon />} title="Stack in column"          active={!isTabbedView && activeCanvasMode === 'column'} loading={loading} onClick={() => run('column')} />
        <Btn label={<RowIcon />}    title="Arrange in row"           active={!isTabbedView && activeCanvasMode === 'row'}    loading={loading} onClick={() => run('row')} />
        <div style={{ width: 1, height: 14, background: '#2d2d2d', margin: '0 1px' }} />
        <button
          onClick={onZoomToggle}
          title="Toggle zoom to 100%"
          style={{
            fontSize: 10,
            color: zoom === 1 ? '#4a9eff' : '#888',
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
            border: 'none',
            cursor: 'pointer',
            padding: '0 5px',
            borderRadius: 4,
            userSelect: 'none',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#ccc' }}
          onMouseLeave={e => { e.currentTarget.style.color = zoom === 1 ? '#4a9eff' : '#888' }}
        >
          {Math.round(zoom * 100)}%
        </button>
      </div>
    </div>
  )
}
