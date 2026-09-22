import React, { Suspense, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  Ungroup,
  Grid2x2X,
  Scissors,
  ClipboardPaste,
  GripVertical,
  Link2,
  Maximize2,
  LayoutGrid,
} from 'lucide-react'
import type { GroupState, TileState } from '../../../../shared/types'
import { appendTileAndCommitSplit, commitGroupLayout, ejectTileFromLayout, pointerEjectPosition } from '../../lib/layoutGroupMembership.ts'
import type { CanvasDragState, CanvasViewport, PersistCanvasStateFn, SaveCanvasFn } from '../../hooks/useCanvasEngine'
import type { PanelNode } from '../panelLayoutTree'
import {
  closeOthersInLeaf,
  closeToRightInLeaf,
  removeTileFromTree,
} from '../panelLayoutTree'
import { GroupResizeHandles, isGroupDragActive } from './groupResizeHandles'
import {
  groupChromeColors,
  isGroupChromeActive,
  LAYOUT_FRAME_BORDER_PX,
  LAYOUT_FRAME_LEAF_RADII,
  LAYOUT_FRAME_RADIUS_PX,
} from '../../lib/groupChrome.ts'

const CHROME_FADE = 'border-color 160ms ease, background-color 160ms ease, color 160ms ease'

const LazyPanelLayout = React.lazy(() => import('../PanelLayout').then(m => ({ default: m.PanelLayout })))

type GroupBounds = { x: number, y: number, w: number, h: number }

type ThemeTokens = {
  surface: { panel: string }
  border: { default: string }
  text: { muted: string }
}

type AppFontTokens = {
  secondarySize: number | string
}

export type CanvasGroupFramesProps = {
  groups: GroupState[]
  tiles: TileState[]
  viewport: CanvasViewport
  dragState: CanvasDragState
  setDragState: Dispatch<SetStateAction<CanvasDragState>>
  expandedCanvasGroupId: string | null
  expandedCanvasMembership: { tileIds: Set<string>, groupIds: Set<string> } | null
  theme: ThemeTokens
  appFonts: AppFontTokens
  nextZIndex: number
  setNextZIndex: Dispatch<SetStateAction<number>>
  clipboardLength: number
  groupBounds: (groupId: string) => GroupBounds | null
  collectGroupTileIds: (groupId: string) => string[]
  convertGroupToLayout: (groupId: string) => void
  revertLayoutGroup: (groupId: string) => void
  expandLayoutGroup: (groupId: string) => void
  enterCanvasExpanded: (groupId: string) => void
  ungroupTiles: (groupId: string) => void
  ungroupAll: (groupId: string) => void
  copyTiles: (cut?: boolean) => void
  pasteTiles: (pos?: { x: number, y: number }, intoGroupId?: string) => void
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  setTiles: Dispatch<SetStateAction<TileState[]>>
  selectedTileId: string | null
  selectedTileIds: Set<string>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  saveCanvas: SaveCanvasFn
  persistCanvasState: PersistCanvasStateFn
  tilesRef: React.MutableRefObject<TileState[]>
  savedLayoutRef?: MutableRefObject<PanelNode | null>
  viewportRef: React.MutableRefObject<CanvasViewport>
  nextZIndexRef: React.MutableRefObject<number>
  getPanelTileLabel: (tileId: string) => string
  getPanelTileIcon: (tileId: string) => string | undefined
  getInitialTileSize: (type: TileState['type']) => { w: number, h: number }
  renderTileBody: (tile: TileState) => React.ReactNode
  screenToWorld: (sx: number, sy: number) => { x: number, y: number }
  snapValue: (value: number) => number
}

export function CanvasGroupFrames({
  groups,
  tiles,
  viewport,
  dragState,
  setDragState,
  expandedCanvasGroupId,
  expandedCanvasMembership,
  theme,
  appFonts,
  nextZIndex,
  setNextZIndex,
  clipboardLength,
  groupBounds,
  collectGroupTileIds,
  convertGroupToLayout,
  revertLayoutGroup,
  expandLayoutGroup,
  enterCanvasExpanded,
  ungroupTiles,
  ungroupAll,
  copyTiles,
  pasteTiles,
  setGroups,
  setTiles,
  selectedTileId,
  selectedTileIds,
  setSelectedTileId,
  setSelectedTileIds,
  saveCanvas,
  persistCanvasState,
  tilesRef,
  savedLayoutRef,
  viewportRef,
  nextZIndexRef,
  getPanelTileLabel,
  getPanelTileIcon,
  getInitialTileSize,
  renderTileBody,
  screenToWorld,
  snapValue,
}: CanvasGroupFramesProps) {
  const sortedGroups = [...groups].sort(
    (a, b) => (a.parentGroupId ? 1 : 0) - (b.parentGroupId ? 1 : 0),
  )

  return (
    <>
      {sortedGroups.map(g => {
        const b = groupBounds(g.id)
        if (!b) return null

        if (expandedCanvasMembership) {
          if (!expandedCanvasMembership.groupIds.has(g.id)) return null
          if (g.id === expandedCanvasGroupId) return null
        }

        if (g.layoutMode && g.layout) {
          const lb = b
          const layout = g.layout as PanelNode
          const color = g.color ?? '#4a9eff'
          const isDraggingThis = dragState.type === 'group' && dragState.groupId === g.id
          const memberIds = collectGroupTileIds(g.id)
          const chromeActive = isGroupChromeActive({
            memberIds,
            selectedTileId,
            selectedTileIds,
            dragging: isDraggingThis,
          })
          const { border: borderColor, label: labelColor, headerFill } = groupChromeColors(color, chromeActive)
          const headerHeight = 32

          return (
            <div
              key={g.id}
              data-canvas-group-frame="true"
              data-canvas-group-id={g.id}
              style={{
                position: 'absolute',
                left: lb.x,
                top: lb.y,
                width: lb.w,
                height: lb.h,
                border: `${LAYOUT_FRAME_BORDER_PX}px solid ${borderColor}`,
                borderRadius: LAYOUT_FRAME_RADIUS_PX,
                background: theme.surface.panel,
                zIndex: isDraggingThis ? 99989 : 8,
                boxSizing: 'border-box',
                overflow: 'hidden',
                cursor: 'default',
                transition: CHROME_FADE,
              }}
              onMouseDown={event => event.stopPropagation()}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: headerHeight,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 10px',
                  background: headerFill,
                  borderBottom: `1px solid ${borderColor}`,
                  cursor: isDraggingThis ? 'grabbing' : 'grab',
                  userSelect: 'none',
                  boxSizing: 'border-box',
                  transition: CHROME_FADE,
                }}
                onMouseDown={event => {
                  event.stopPropagation()
                  setSelectedTileIds(new Set(memberIds))
                  setSelectedTileId(memberIds[0] ?? null)
                  setDragState({
                    type: 'group',
                    groupId: g.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    snapshots: [],
                    initLayoutBounds: lb,
                  })
                }}
                onDoubleClick={event => { event.stopPropagation(); expandLayoutGroup(g.id) }}
              >
                <LayoutGrid size={12} style={{ color: labelColor, flexShrink: 0, opacity: 0.7 }} />
                <span style={{
                  fontSize: appFonts.secondarySize,
                  color: labelColor,
                  fontWeight: 500,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  transition: 'color 160ms ease',
                }}>
                  {g.label ?? 'layout'}
                </span>
                <div
                  title="Expand fullscreen"
                  onClick={event => { event.stopPropagation(); expandLayoutGroup(g.id) }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, cursor: 'pointer', color: labelColor, opacity: 0.6 }}
                  onMouseEnter={event => { event.currentTarget.style.opacity = '1' }}
                  onMouseLeave={event => { event.currentTarget.style.opacity = '0.6' }}
                >
                  <Maximize2 size={11} />
                </div>
                <div
                  title="Back to blocks"
                  onClick={event => { event.stopPropagation(); revertLayoutGroup(g.id) }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, cursor: 'pointer', color: labelColor, opacity: 0.6 }}
                  onMouseEnter={event => { event.currentTarget.style.opacity = '1' }}
                  onMouseLeave={event => { event.currentTarget.style.opacity = '0.6' }}
                >
                  <Ungroup size={11} />
                </div>
              </div>

              <GroupResizeHandles
                handleSize={10 / viewport.zoom}
                onResizeStart={(dir, event) => {
                  setDragState({
                    type: 'group-resize',
                    groupId: g.id,
                    dir,
                    startX: event.clientX,
                    startY: event.clientY,
                    initBounds: { x: lb.x, y: lb.y, w: lb.w, h: lb.h },
                    snapshots: [],
                  })
                }}
              />

              <div style={{ position: 'absolute', top: headerHeight, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
                <Suspense fallback={null}>
                  <LazyPanelLayout
                    root={layout}
                    dockMinEdgePx={28}
                    insetBottom={0}
                    outerRadii={LAYOUT_FRAME_LEAF_RADII}
                    flushLeafChrome
                    getTileLabel={getPanelTileLabel}
                    renderTile={(tileId) => {
                      const tile = tiles.find(candidate => candidate.id === tileId)
                      if (!tile) return null
                      return (
                        <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12 }}>Loading…</div>}>
                          {renderTileBody(tile)}
                        </Suspense>
                      )
                    }}
                    onLayoutChange={(newLayout) => {
                      setGroups(prev => {
                        const committed = commitGroupLayout(tilesRef.current, prev, g.id, newLayout)
                        tilesRef.current = committed.tiles
                        if (savedLayoutRef) savedLayoutRef.current = newLayout
                        setTiles(committed.tiles)
                        setTimeout(() => persistCanvasState(committed.tiles, viewportRef.current, nextZIndexRef.current, committed.groups), 0)
                        return committed.groups
                      })
                    }}
                    onCloseTab={(tileId) => {
                      setGroups(prev => {
                        const group = prev.find(candidate => candidate.id === g.id)
                        if (!group?.layout) return prev
                        const newLayout = removeTileFromTree(group.layout as PanelNode, tileId)
                        const committed = commitGroupLayout(tilesRef.current, prev, g.id, newLayout)
                        tilesRef.current = committed.tiles
                        if (savedLayoutRef) savedLayoutRef.current = newLayout
                        setTiles(committed.tiles)
                        setTimeout(() => persistCanvasState(committed.tiles, viewportRef.current, nextZIndexRef.current, committed.groups), 0)
                        return committed.groups
                      })
                    }}
                    onAddTile={() => { /* handled externally */ }}
                    onExit={() => revertLayoutGroup(g.id)}
                    activePanelId={null}
                    onActivePanelChange={() => { /* no-op for embedded */ }}
                    getTileType={(tileId) => tiles.find(tile => tile.id === tileId)?.type ?? 'note'}
                    getTileIcon={getPanelTileIcon}
                    onTabDropOutside={(tileId, clientX, clientY) => {
                      const world = screenToWorld(clientX, clientY)
                      const current = tilesRef.current.find(candidate => candidate.id === tileId)
                      const fallback = getInitialTileSize(current?.type ?? 'note')
                      const width = current?.width || fallback.w
                      const z = nextZIndexRef.current
                      const position = pointerEjectPosition(world, width, snapValue)
                      setGroups(prev => {
                        const ejected = ejectTileFromLayout({
                          tiles: tilesRef.current,
                          groups: prev,
                          groupId: g.id,
                          tileId,
                          position,
                          zIndex: z,
                        })
                        tilesRef.current = ejected.tiles
                        setTiles(ejected.tiles)
                        setNextZIndex(next => next + 1)
                        setSelectedTileId(tileId)
                        setSelectedTileIds(new Set())
                        persistCanvasState(ejected.tiles, viewportRef.current, z + 1, ejected.groups)
                        return ejected.groups
                      })
                    }}
                    onSplitNew={(panelId, tileType, zone) => {
                      const { w, h } = getInitialTileSize(tileType as TileState['type'])
                      const newTile: TileState = {
                        id: `tile-${Date.now()}`,
                        type: tileType as TileState['type'],
                        x: 0,
                        y: 0,
                        width: w,
                        height: h,
                        zIndex: nextZIndex,
                        groupId: g.id,
                      }
                      const current = groups.find(candidate => candidate.id === g.id)
                      if (!current?.layout) return
                      const result = appendTileAndCommitSplit({
                        tiles: tilesRef.current,
                        groups,
                        layout: current.layout as PanelNode,
                        groupId: g.id,
                        newTile,
                        panelId,
                        zone,
                      })
                      tilesRef.current = result.tiles
                      setTiles(result.tiles)
                      setNextZIndex(prev => prev + 1)
                      if (savedLayoutRef) savedLayoutRef.current = result.layout
                      setGroups(result.groups)
                      setTimeout(() => persistCanvasState(result.tiles, viewportRef.current, nextZIndexRef.current, result.groups), 0)
                    }}
                    onCloseOthers={(panelId, tileId) => {
                      setGroups(prev => {
                        const group = prev.find(candidate => candidate.id === g.id)
                        if (!group?.layout) return prev
                        const newLayout = closeOthersInLeaf(group.layout as PanelNode, panelId, tileId)
                        const committed = commitGroupLayout(tilesRef.current, prev, g.id, newLayout)
                        tilesRef.current = committed.tiles
                        if (savedLayoutRef) savedLayoutRef.current = newLayout
                        setTiles(committed.tiles)
                        setTimeout(() => persistCanvasState(committed.tiles, viewportRef.current, nextZIndexRef.current, committed.groups), 0)
                        return committed.groups
                      })
                    }}
                    onCloseToRight={(panelId, tileId) => {
                      setGroups(prev => {
                        const group = prev.find(candidate => candidate.id === g.id)
                        if (!group?.layout) return prev
                        const newLayout = closeToRightInLeaf(group.layout as PanelNode, panelId, tileId)
                        const committed = commitGroupLayout(tilesRef.current, prev, g.id, newLayout)
                        tilesRef.current = committed.tiles
                        if (savedLayoutRef) savedLayoutRef.current = newLayout
                        setTiles(committed.tiles)
                        setTimeout(() => persistCanvasState(committed.tiles, viewportRef.current, nextZIndexRef.current, committed.groups), 0)
                        return committed.groups
                      })
                    }}
                    onLaunchTemplate={() => { /* no-op in embedded mode */ }}
                  />
                </Suspense>
              </div>
            </div>
          )
        }

        const isNested = !!g.parentGroupId
        const defaultColor = isNested ? '#ffb432' : '#4a9eff'
        const color = g.color ?? defaultColor
        const isDraggingThis = isGroupDragActive(dragState, g.id)
        const memberIds = collectGroupTileIds(g.id)
        const chromeActive = isGroupChromeActive({
          memberIds,
          selectedTileId,
          selectedTileIds,
          dragging: isDraggingThis,
        })
        const { border: borderColor, label: labelColor, fill: bgColor } = groupChromeColors(color, chromeActive)

        return (
          <div
            key={g.id}
            data-canvas-group-frame="true"
            data-canvas-group-id={g.id}
            style={{
              position: 'absolute',
              left: b.x,
              top: b.y,
              width: b.w,
              height: b.h,
              border: `${LAYOUT_FRAME_BORDER_PX}px dashed ${borderColor}`,
              borderRadius: LAYOUT_FRAME_RADIUS_PX,
              background: bgColor,
              zIndex: isDraggingThis ? 99989 : ('auto' as React.CSSProperties['zIndex']),
              boxSizing: 'border-box',
              cursor: isDraggingThis ? 'grabbing' : 'grab',
              transition: CHROME_FADE,
            }}
            onMouseDown={event => {
              if ((event.target as HTMLElement) !== event.currentTarget) return
              event.stopPropagation()
              const snapshots = tiles
                .filter(tile => memberIds.includes(tile.id))
                .map(tile => ({ id: tile.id, x: tile.x, y: tile.y }))
              setSelectedTileIds(new Set(memberIds))
              setSelectedTileId(memberIds[0] ?? null)
              setDragState({ type: 'group', groupId: g.id, startX: event.clientX, startY: event.clientY, snapshots })
            }}
          >
            <div
              onMouseDown={event => event.stopPropagation()}
              style={{
                position: 'absolute',
                top: -36 / viewport.zoom,
                left: 0,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                userSelect: 'none',
                pointerEvents: 'all',
                background: 'none',
                border: 'none',
                padding: '3px 0',
                cursor: 'grab',
                transform: `scale(${1 / viewport.zoom})`,
                transformOrigin: 'left top',
                zIndex: 99995,
              }}
            >
              <div
                data-group-move-handle="true"
                title="Move group"
                onMouseDown={event => {
                  event.stopPropagation()
                  event.preventDefault()
                  const ids = collectGroupTileIds(g.id)
                  const snapshots = tiles
                    .filter(tile => ids.includes(tile.id))
                    .map(tile => ({ id: tile.id, x: tile.x, y: tile.y }))
                  setDragState({
                    type: 'group',
                    groupId: g.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    snapshots,
                  })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 20,
                  color: labelColor,
                  cursor: isDraggingThis ? 'grabbing' : 'grab',
                  opacity: 0.72,
                }}
              >
                <GripVertical size={14} />
              </div>

              <div
                draggable
                title="Drag group to another block"
                onMouseDown={event => event.stopPropagation()}
                onDragStart={event => {
                  event.stopPropagation()
                  const memberTiles = tiles.filter(tile => tile.groupId === g.id)
                  event.dataTransfer.setData('application/group-id', g.id)
                  event.dataTransfer.setData('application/group-label', g.label ?? 'group')
                  event.dataTransfer.setData('application/group-tile-ids', JSON.stringify(memberTiles.map(tile => tile.id)))
                  event.dataTransfer.setData('application/group-tile-types', JSON.stringify(memberTiles.map(tile => tile.type)))
                  event.dataTransfer.effectAllowed = 'link'
                  const ghost = document.createElement('div')
                  ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px'
                  document.body.appendChild(ghost)
                  event.dataTransfer.setDragImage(ghost, 0, 0)
                  setTimeout(() => ghost.remove(), 0)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 20,
                  color: labelColor,
                  cursor: 'alias',
                  opacity: 0.72,
                }}
              >
                <Link2 size={12} />
              </div>

              <div style={{ position: 'relative' }}>
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: color,
                    cursor: 'pointer',
                    flexShrink: 0,
                    border: `1px solid ${theme.border.default}`,
                  }}
                  onClick={event => {
                    event.stopPropagation()
                    const input = event.currentTarget.nextSibling as HTMLInputElement
                    input?.click()
                  }}
                />
                <input
                  type="color"
                  value={color}
                  onChange={event => {
                    const newColor = event.target.value
                    setGroups(prev => {
                      const updated = prev.map(group => group.id === g.id ? { ...group, color: newColor } : group)
                      setTiles(current => { saveCanvas(current, viewport, nextZIndex, updated); return current })
                      return updated
                    })
                  }}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0, top: 0, left: 0, pointerEvents: 'none' }}
                />
              </div>

              <span
                contentEditable
                suppressContentEditableWarning
                onBlur={event => {
                  const newLabel = event.currentTarget.textContent?.trim() || 'group'
                  setGroups(prev => {
                    const updated = prev.map(group => group.id === g.id ? { ...group, label: newLabel } : group)
                    setTiles(current => { saveCanvas(current, viewport, nextZIndex, updated); return current })
                    return updated
                  })
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    ;(event.target as HTMLElement).blur()
                  }
                  event.stopPropagation()
                }}
                onClick={event => event.stopPropagation()}
                style={{
                  fontSize: appFonts.secondarySize,
                  color: labelColor,
                  fontWeight: 500,
                  minWidth: 30,
                  outline: 'none',
                  cursor: 'text',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  transition: 'color 160ms ease',
                }}
              >
                {g.label ?? 'group'}
              </span>

              <span style={{ width: 1, height: 12, background: color, opacity: 0.3 }} />

              {([
                { icon: <LayoutGrid size={14} />, label: 'Make layout', action: () => convertGroupToLayout(g.id) },
                { icon: <Ungroup size={14} />, label: 'Ungroup', action: () => ungroupTiles(g.id) },
                { icon: <Grid2x2X size={14} />, label: 'Ungroup all', action: () => ungroupAll(g.id) },
                {
                  icon: <Scissors size={14} />,
                  label: 'Cut',
                  action: () => {
                    const ids = collectGroupTileIds(g.id)
                    setSelectedTileIds(new Set(ids))
                    setSelectedTileId(null)
                    setTimeout(() => copyTiles(true), 0)
                  },
                },
                ...(clipboardLength > 0
                  ? [{ icon: <ClipboardPaste size={14} />, label: 'Paste in', action: () => pasteTiles(undefined, g.id) }]
                  : []),
                { icon: <Maximize2 size={14} />, label: 'Expand as canvas', action: () => enterCanvasExpanded(g.id) },
              ] as { icon: React.ReactNode, label: string, action: () => void }[]).map(btn => (
                <div
                  key={btn.label}
                  title={btn.label}
                  onClick={event => { event.stopPropagation(); btn.action() }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: 4,
                    cursor: 'pointer',
                    color: labelColor,
                    opacity: 0.6,
                  }}
                  onMouseEnter={event => { event.currentTarget.style.opacity = '1' }}
                  onMouseLeave={event => { event.currentTarget.style.opacity = '0.6' }}
                >
                  {btn.icon}
                </div>
              ))}
            </div>

            <GroupResizeHandles
              onResizeStart={(dir, event) => {
                const ids = collectGroupTileIds(g.id)
                const snapshots = tiles
                  .filter(tile => ids.includes(tile.id))
                  .map(tile => ({ id: tile.id, x: tile.x, y: tile.y, width: tile.width, height: tile.height }))
                setDragState({
                  type: 'group-resize',
                  groupId: g.id,
                  dir,
                  startX: event.clientX,
                  startY: event.clientY,
                  initBounds: { x: b.x + 20, y: b.y + 20, w: b.w - 40, h: b.h - 40 },
                  snapshots,
                })
              }}
            />
          </div>
        )
      })}
    </>
  )
}
