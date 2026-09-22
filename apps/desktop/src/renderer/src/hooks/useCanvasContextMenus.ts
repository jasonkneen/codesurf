/**
 * Canvas + tile context menu hooks.
 * Extracted from useCanvasEngine.
 */
import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { TileState, GroupState } from '../../../shared/types.ts'
import { assignTileToGroup } from '../lib/layoutGroupMembership.ts'
import type { PanelNode } from '../components/panelLayoutTree.ts'
import type { CanvasViewport, SaveCanvasFn } from './canvasEngineMath.ts'

export type CanvasContextMenuItem = {
  label: string
  action: () => void
  divider?: boolean
  danger?: boolean
}

export type UseCanvasContextMenuOptions = {
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  panelLayout: PanelNode | null
  groups: GroupState[]
  groupBoundsRef: MutableRefObject<(id: string) => { x: number; y: number; w: number; h: number } | null>
  addTile: (type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => string
  pinnedCanvasExtensionTiles: Array<{ type: string; label: string }>
  clipboardRef: MutableRefObject<TileState[]>
  pasteAt: (pos: { x: number; y: number }, groupId?: string) => void
  selectedTileIds: Set<string>
  groupSelectedTiles: () => void
  setCtxMenu: Dispatch<SetStateAction<{ x: number; y: number; items: CanvasContextMenuItem[] } | null>>
}

export function buildCanvasContextMenuItems(options: {
  world: { x: number; y: number }
  hitGroupId?: string
  pinnedCanvasExtensionTiles: Array<{ type: string; label: string }>
  hasClipboard: boolean
  selectedTileCount: number
  addTile: UseCanvasContextMenuOptions['addTile']
  pasteAt: UseCanvasContextMenuOptions['pasteAt']
  groupSelectedTiles: UseCanvasContextMenuOptions['groupSelectedTiles']
}): CanvasContextMenuItem[] {
  const {
    world,
    hitGroupId,
    pinnedCanvasExtensionTiles,
    hasClipboard,
    selectedTileCount,
    addTile,
    pasteAt,
    groupSelectedTiles,
  } = options
  const items: CanvasContextMenuItem[] = [
    { label: 'New Terminal', action: () => addTile('terminal', undefined, world) },
    { label: 'New Note', action: () => addTile('note', undefined, world) },
    { label: 'New Browser', action: () => addTile('browser', undefined, world) },
    { label: 'New Board', action: () => addTile('kanban', undefined, world) },
  ]
  if (pinnedCanvasExtensionTiles.length > 0) {
    items.push({ label: '', action: () => {}, divider: true })
    for (const ext of pinnedCanvasExtensionTiles) {
      items.push({
        label: ext.label,
        action: () => addTile(ext.type as TileState['type'], undefined, world),
      })
    }
  }
  if (hasClipboard) {
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: 'Paste', action: () => pasteAt(world) })
    if (hitGroupId) {
      items.push({ label: 'Paste into group', action: () => pasteAt(world, hitGroupId) })
    }
  }
  if (selectedTileCount >= 2) {
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: `Group ${selectedTileCount} blocks`, action: groupSelectedTiles })
  }
  return items
}

export function useCanvasContextMenu(options: UseCanvasContextMenuOptions) {
  const {
    screenToWorld,
    panelLayout,
    groups,
    groupBoundsRef,
    addTile,
    pinnedCanvasExtensionTiles,
    clipboardRef,
    pasteAt,
    selectedTileIds,
    groupSelectedTiles,
    setCtxMenu,
  } = options

  return useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    if (panelLayout) return
    const world = screenToWorld(e.clientX, e.clientY)
    const hitGroup = groups.find(g => {
      const b = groupBoundsRef.current(g.id)
      return b && world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h
    })
    const items = buildCanvasContextMenuItems({
      world,
      hitGroupId: hitGroup?.id,
      pinnedCanvasExtensionTiles,
      hasClipboard: clipboardRef.current.length > 0,
      selectedTileCount: selectedTileIds.size,
      addTile,
      pasteAt,
      groupSelectedTiles,
    })
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [
    screenToWorld,
    panelLayout,
    groups,
    groupBoundsRef,
    addTile,
    pinnedCanvasExtensionTiles,
    clipboardRef,
    pasteAt,
    selectedTileIds,
    groupSelectedTiles,
    setCtxMenu,
  ])
}

export type UseTileContextMenuOptions = {
  viewport: CanvasViewport
  nextZIndex: number
  groups: GroupState[]
  workspacePath: string | null | undefined
  saveCanvas: SaveCanvasFn
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  setCtxMenu: Dispatch<SetStateAction<{ x: number; y: number; items: CanvasContextMenuItem[] } | null>>
  clipboardRef: MutableRefObject<TileState[]>
  duplicateTiles: (ids: string[]) => void
  copyTiles: (cut: boolean) => void
  pasteTiles: (pos?: { x: number; y: number }, groupId?: string) => void
  ungroupTiles: (groupId: string) => void
  ungroupAll: (groupId: string) => void
  closeTile: (id: string) => void
  importFileToWorkspace: (filePath: string, tileId: string) => void | Promise<unknown>
}

export function useTileContextMenu(options: UseTileContextMenuOptions) {
  const {
    viewport,
    nextZIndex,
    groups,
    workspacePath,
    saveCanvas,
    setTiles,
    setGroups,
    setSelectedTileId,
    setSelectedTileIds,
    setCtxMenu,
    clipboardRef,
    duplicateTiles,
    copyTiles,
    pasteTiles,
    ungroupTiles,
    ungroupAll,
    closeTile,
    importFileToWorkspace,
  } = options

  return useCallback((e: ReactMouseEvent, tile: TileState) => {
    e.preventDefault()
    e.stopPropagation()
    const items: CanvasContextMenuItem[] = [
      { label: 'Duplicate', action: () => duplicateTiles([tile.id]) },
      { label: 'Copy', action: () => { setSelectedTileId(tile.id); setSelectedTileIds(new Set()); copyTiles(false) } },
      { label: 'Cut', action: () => { setSelectedTileId(tile.id); setSelectedTileIds(new Set()); copyTiles(true) } },
    ]
    if (clipboardRef.current.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: 'Paste', action: () => pasteTiles() })
      if (tile.groupId) {
        items.push({ label: 'Paste into this group', action: () => pasteTiles(undefined, tile.groupId) })
      }
    }
    items.push({ label: '', action: () => {}, divider: true })
    if (tile.groupId) {
      items.push({ label: 'Remove from group', action: () => {
        setTiles(prev => {
          const assigned = assignTileToGroup(prev, groups, tile.id, undefined)
          setGroups(assigned.groups)
          saveCanvas(assigned.tiles, viewport, nextZIndex, assigned.groups)
          return assigned.tiles
        })
      } })
      items.push({ label: 'Ungroup', action: () => ungroupTiles(tile.groupId!) })
      items.push({ label: 'Ungroup All', action: () => ungroupAll(tile.groupId!) })
      items.push({ label: '', action: () => {}, divider: true })
    }
    const availableGroups = groups.filter(g => g.id !== tile.groupId)
    if (availableGroups.length > 0) {
      availableGroups.forEach(g => {
        items.push({
          label: `Add to ${g.label ?? g.id.slice(-6)}`,
          action: () => {
            setTiles(prev => {
              const assigned = assignTileToGroup(prev, groups, tile.id, g.id)
              setGroups(assigned.groups)
              saveCanvas(assigned.tiles, viewport, nextZIndex, assigned.groups)
              return assigned.tiles
            })
          },
        })
      })
      items.push({ label: '', action: () => {}, divider: true })
    }
    if (tile.type === 'file' && tile.filePath && workspacePath && !tile.filePath.startsWith(workspacePath)) {
      items.push({
        label: 'Add to workspace',
        action: () => { void importFileToWorkspace(tile.filePath!, tile.id) },
      })
      items.push({ label: '', action: () => {}, divider: true })
    }
    const currentlyChromeless = !!tile.hideTitlebar || !!tile.hideNavbar
    items.push({
      label: currentlyChromeless ? 'Show Controls' : 'Hide Controls',
      action: () => {
        setTiles(prev => {
          const updated = prev.map(t => t.id === tile.id
            ? { ...t, hideTitlebar: !currentlyChromeless, hideNavbar: !currentlyChromeless }
            : t)
          saveCanvas(updated, viewport, nextZIndex)
          return updated
        })
      },
    })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: 'Close', action: () => closeTile(tile.id), danger: true })
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [
    viewport,
    nextZIndex,
    groups,
    workspacePath,
    saveCanvas,
    setTiles,
    setGroups,
    setSelectedTileId,
    setSelectedTileIds,
    setCtxMenu,
    clipboardRef,
    duplicateTiles,
    copyTiles,
    pasteTiles,
    ungroupTiles,
    ungroupAll,
    closeTile,
    importFileToWorkspace,
  ])
}
