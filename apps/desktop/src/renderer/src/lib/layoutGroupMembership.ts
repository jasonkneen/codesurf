/**
 * Layout-group membership: one object, two views.
 *
 * A layout group (blue canvas frame) is the source of truth for an IDE
 * arrangement. Fullscreen / tab mode is a view of that group's `layout` tree.
 * `tile.groupId` membership must equal the tile IDs in `group.layout`.
 */

import type { GroupState, TileState } from '../../../shared/types.ts'
import {
  addTabToLeaf,
  createLeaf,
  findFirstLeafId,
  findLeafIdContainingTile,
  getAllTileIds,
  removeTileFromTree,
  sanitizePanelLayout,
  setActiveTab,
  splitLeaf,
  type DockZone,
  type PanelNode,
} from '../components/panelLayoutTree.ts'
import { tilesToPanelNode } from './layoutSnap.ts'

export const LAYOUT_GROUP_COLOR = '#4a9eff'

export type LayoutBounds = { x: number, y: number, w: number, h: number }

export type ArrangementResolution = {
  tileIds: string[]
  layout: PanelNode
  reuseGroupId: string | null
}

export function isPanelNode(value: unknown): value is PanelNode {
  if (!value || typeof value !== 'object') return false
  const node = value as { type?: unknown }
  return node.type === 'leaf' || node.type === 'split'
}

export function tileIdsInLayout(layout: unknown): string[] {
  return isPanelNode(layout) ? getAllTileIds(layout) : []
}

export function collectLayoutTreeTileIds(groups: GroupState[]): Map<string, string> {
  const owned = new Map<string, string>()
  for (const group of groups) {
    if (!group.layoutMode) continue
    for (const tileId of tileIdsInLayout(group.layout)) {
      if (!owned.has(tileId)) owned.set(tileId, group.id)
    }
  }
  return owned
}

export function findLayoutGroupIdForTile(groups: GroupState[], tileId: string): string | null {
  return collectLayoutTreeTileIds(groups).get(tileId) ?? null
}

export function computeLayoutBounds(
  tiles: TileState[],
  tileIds: readonly string[],
  fallback?: LayoutBounds | null,
): LayoutBounds {
  const idSet = new Set(tileIds)
  const members = tiles.filter(tile => idSet.has(tile.id))
  if (members.length === 0) {
    return fallback ?? { x: 0, y: 0, w: 800, h: 600 }
  }
  const padding = 20
  const minX = Math.min(...members.map(tile => tile.x)) - padding
  const minY = Math.min(...members.map(tile => tile.y)) - padding
  const maxX = Math.max(...members.map(tile => tile.x + tile.width)) + padding
  const maxY = Math.max(...members.map(tile => tile.y + tile.height)) + padding
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export const LAYOUT_LANDSCAPE_ASPECT = 16 / 10
export const LAYOUT_PORTRAIT_ASPECT = 4 / 5
export const FULLSCREEN_PANEL_ATTR = 'data-codesurf-fullscreen-panel'

/** Columns / tab IDEs are landscape; stacked rows stay taller. */
export function aspectRatioFromPanelNode(layout: unknown): number {
  if (!isPanelNode(layout) || layout.type === 'leaf') return LAYOUT_LANDSCAPE_ASPECT
  if (layout.direction === 'horizontal') {
    return Math.max(LAYOUT_LANDSCAPE_ASPECT, layout.children.length * 0.7)
  }
  return LAYOUT_PORTRAIT_ASPECT
}

export function fitBoundsToAspect(bounds: LayoutBounds, aspect: number): LayoutBounds {
  const safeAspect = aspect > 0 ? aspect : LAYOUT_LANDSCAPE_ASPECT
  const current = bounds.w / Math.max(1, bounds.h)
  if (Math.abs(current - safeAspect) / safeAspect < 0.08) return bounds
  const area = Math.max(bounds.w * bounds.h, 400 * 300)
  const w = Math.max(320, Math.sqrt(area * safeAspect))
  const h = Math.max(220, w / safeAspect)
  return { x: bounds.x, y: bounds.y, w, h }
}

export function orientationsDisagree(bounds: LayoutBounds, aspect: number): boolean {
  const current = bounds.w / Math.max(1, bounds.h)
  return (current < 1) !== (aspect < 1)
}

export function layoutBoundsForArrangement(input: {
  tiles: TileState[]
  tileIds: readonly string[]
  layout: unknown
  existing?: LayoutBounds | null
  panelSize?: { w: number, h: number } | null
}): LayoutBounds {
  const origin = input.existing ?? computeLayoutBounds(input.tiles, input.tileIds)
  const aspect = input.panelSize && input.panelSize.h > 0
    ? input.panelSize.w / input.panelSize.h
    : aspectRatioFromPanelNode(input.layout)
  if (input.existing && !orientationsDisagree(origin, aspect) && !input.panelSize) {
    return input.existing
  }
  return fitBoundsToAspect(origin, aspect)
}

/** Flip only when the frame is portrait vs a landscape arrangement (or the reverse). */
export function correctLayoutBoundsOrientation(
  bounds: LayoutBounds,
  layout: unknown,
): LayoutBounds {
  const aspect = aspectRatioFromPanelNode(layout)
  if (!orientationsDisagree(bounds, aspect)) return bounds
  return fitBoundsToAspect(bounds, aspect)
}

export function measureFullscreenPanelSize(): { w: number, h: number } | null {
  if (typeof document === 'undefined') return null
  const el = document.querySelector(`[${FULLSCREEN_PANEL_ATTR}]`)
  if (!(el instanceof HTMLElement)) return null
  const width = el.clientWidth
  const height = el.clientHeight
  if (width < 80 || height < 80) return null
  return { w: width, h: height }
}

export function collectDescendantTileIds(
  tiles: TileState[],
  groups: GroupState[],
  groupId: string,
): string[] {
  const direct = tiles.filter(tile => tile.groupId === groupId).map(tile => tile.id)
  const childGroups = groups.filter(group => group.parentGroupId === groupId)
  return [
    ...direct,
    ...childGroups.flatMap(group => collectDescendantTileIds(tiles, groups, group.id)),
  ]
}

export function activateTileInLayout(
  layout: PanelNode,
  tileId: string,
): { layout: PanelNode, activePanelId: string | null } {
  const leafId = findLeafIdContainingTile(layout, tileId) ?? findFirstLeafId(layout)
  if (!leafId) return { layout, activePanelId: null }
  if (!getAllTileIds(layout).includes(tileId)) {
    return { layout, activePanelId: leafId }
  }
  return {
    layout: setActiveTab(layout, leafId, tileId),
    activePanelId: leafId,
  }
}

export function syncTilesToLayoutGroup(
  tiles: TileState[],
  groupId: string,
  layout: unknown,
): TileState[] {
  const inLayout = new Set(tileIdsInLayout(layout))
  let changed = false
  const next = tiles.map(tile => {
    if (inLayout.has(tile.id)) {
      if (tile.groupId === groupId) return tile
      changed = true
      return { ...tile, groupId }
    }
    if (tile.groupId === groupId) {
      changed = true
      const { groupId: _removed, ...rest } = tile
      return rest as TileState
    }
    return tile
  })
  return changed ? next : tiles
}

export function applyLayoutToGroup(
  groups: GroupState[],
  groupId: string,
  layout: PanelNode | null | undefined,
  bounds?: LayoutBounds | null,
): GroupState[] {
  const ids = tileIdsInLayout(layout)
  const empty = ids.length === 0 || !layout
  return groups.map(group => {
    if (group.id !== groupId) return group
    if (empty) {
      return {
        ...group,
        layoutMode: false,
        layout: undefined,
        layoutBounds: undefined,
      }
    }
    return {
      ...group,
      layoutMode: true,
      color: group.color ?? LAYOUT_GROUP_COLOR,
      layout,
      layoutBounds: bounds ?? group.layoutBounds,
    }
  })
}

export function removeTileFromAllGroupLayouts(
  groups: GroupState[],
  tileId: string,
): GroupState[] {
  return groups.map(group => {
    if (!group.layoutMode || !isPanelNode(group.layout)) return group
    if (!tileIdsInLayout(group.layout).includes(tileId)) return group
    const nextLayout = removeTileFromTree(group.layout, tileId)
    if (!nextLayout || tileIdsInLayout(nextLayout).length === 0) {
      return {
        ...group,
        layoutMode: false,
        layout: undefined,
        layoutBounds: undefined,
      }
    }
    return { ...group, layout: nextLayout }
  })
}

export function addTilesToGroupLayout(
  groups: GroupState[],
  tiles: TileState[],
  groupId: string,
  tileIds: readonly string[],
): GroupState[] {
  const group = groups.find(candidate => candidate.id === groupId)
  if (!group) return groups
  const incoming = tileIds.filter(Boolean)
  if (incoming.length === 0) return groups

  let layout = isPanelNode(group.layout)
    ? group.layout
    : createLeaf(
      tiles.filter(tile => tile.groupId === groupId).map(tile => tile.id),
    )
  if (tileIdsInLayout(layout).length === 0) {
    layout = createLeaf([...incoming], incoming[0])
  } else {
    const firstLeaf = findFirstLeafId(layout)
    if (!firstLeaf) return groups
    for (const tileId of incoming) {
      if (!tileIdsInLayout(layout).includes(tileId)) {
        layout = addTabToLeaf(layout, firstLeaf, tileId)
      }
    }
  }

  const memberIds = tileIdsInLayout(layout)
  return applyLayoutToGroup(
    groups,
    groupId,
    layout,
    group.layoutBounds ?? layoutBoundsForArrangement({
      tiles,
      tileIds: memberIds,
      layout,
    }),
  )
}

function pruneGroups(
  groups: GroupState[],
  tiles: TileState[],
  candidates: Iterable<string>,
  keepId: string,
): GroupState[] {
  const remaining = new Set(candidates)
  remaining.delete(keepId)
  if (remaining.size === 0) return groups
  return groups.filter(group => {
    if (!remaining.has(group.id)) return true
    if (tiles.some(tile => tile.groupId === group.id)) return true
    if (tileIdsInLayout(group.layout).length > 0) return true
    if (groups.some(child => child.parentGroupId === group.id && child.id !== group.id && !remaining.has(child.id))) {
      return true
    }
    return false
  })
}

export function assignTilesToGroup(
  tiles: TileState[],
  groups: GroupState[],
  tileIds: readonly string[],
  targetGroupId: string | undefined,
): { tiles: TileState[], groups: GroupState[] } {
  const idSet = new Set(tileIds)
  if (idSet.size === 0) return { tiles, groups }

  let nextGroups = groups
  for (const tileId of idSet) {
    nextGroups = removeTileFromAllGroupLayouts(nextGroups, tileId)
  }

  const target = targetGroupId
    ? nextGroups.find(group => group.id === targetGroupId)
    : undefined

  if (target?.layoutMode) {
    nextGroups = addTilesToGroupLayout(nextGroups, tiles, target.id, [...idSet])
    const nextTiles = syncTilesToLayoutGroup(
      tiles,
      target.id,
      nextGroups.find(group => group.id === target.id)?.layout,
    )
    return { tiles: nextTiles, groups: nextGroups }
  }

  const nextTiles = tiles.map(tile => {
    if (!idSet.has(tile.id)) return tile
    if (!targetGroupId) {
      if (!tile.groupId) return tile
      const { groupId: _removed, ...rest } = tile
      return rest as TileState
    }
    if (tile.groupId === targetGroupId) return tile
    return { ...tile, groupId: targetGroupId }
  })
  return { tiles: nextTiles, groups: nextGroups }
}

export function assignTileToGroup(
  tiles: TileState[],
  groups: GroupState[],
  tileId: string,
  targetGroupId: string | undefined,
): { tiles: TileState[], groups: GroupState[] } {
  return assignTilesToGroup(tiles, groups, [tileId], targetGroupId)
}

export function appendTileAndCommitSplit(input: {
  tiles: TileState[]
  groups: GroupState[]
  layout: PanelNode
  groupId: string
  newTile: TileState
  panelId: string
  zone: DockZone
}): { tiles: TileState[], groups: GroupState[], layout: PanelNode } {
  const nextTiles = [...input.tiles, input.newTile]
  const nextLayout = splitLeaf(input.layout, input.panelId, input.newTile.id, input.zone)
  const committed = commitGroupLayout(nextTiles, input.groups, input.groupId, nextLayout)
  return { tiles: committed.tiles, groups: committed.groups, layout: nextLayout }
}

/**
 * Pull a tile out of a layout group onto the free canvas.
 * Last tab tears the layout down and removes the empty group.
 */
export function ejectTileFromLayout(input: {
  tiles: TileState[]
  groups: GroupState[]
  groupId: string
  tileId: string
  position: { x: number, y: number }
  zIndex: number
}): { tiles: TileState[], groups: GroupState[] } {
  const group = input.groups.find(candidate => candidate.id === input.groupId)
  let nextGroups = input.groups
  let nextTiles = input.tiles

  if (group?.layoutMode && isPanelNode(group.layout) && tileIdsInLayout(group.layout).includes(input.tileId)) {
    const nextLayout = removeTileFromTree(group.layout, input.tileId)
    const committed = commitGroupLayout(input.tiles, input.groups, input.groupId, nextLayout)
    nextGroups = committed.groups
    nextTiles = committed.tiles
  }

  nextTiles = nextTiles.map(tile => {
    if (tile.id !== input.tileId) return tile
    const { groupId: _removed, ...rest } = tile
    return {
      ...rest,
      x: input.position.x,
      y: input.position.y,
      zIndex: input.zIndex,
    } as TileState
  })

  const leftoverGroup = nextGroups.find(candidate => candidate.id === input.groupId)
  const leftoverTiles = nextTiles.some(tile => tile.groupId === input.groupId)
  const leftoverLayout = tileIdsInLayout(leftoverGroup?.layout).length > 0
  const leftoverChildren = nextGroups.some(candidate => candidate.parentGroupId === input.groupId)
  if (!leftoverTiles && !leftoverLayout && !leftoverChildren) {
    nextGroups = nextGroups.filter(candidate => candidate.id !== input.groupId)
  }

  return { tiles: nextTiles, groups: nextGroups }
}

/** Place the torn-off tile so the pointer sits near its titlebar. */
export function pointerEjectPosition(
  world: { x: number, y: number },
  tileWidth: number,
  snapValue: (value: number) => number,
): { x: number, y: number } {
  const width = Number.isFinite(tileWidth) && tileWidth > 0 ? tileWidth : 320
  return {
    x: snapValue(world.x - Math.min(72, width / 4)),
    y: snapValue(world.y - 18),
  }
}

export type PanelTabEjectResult = {
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode | null
  expandLayoutGroupId: string | null
  activePanelId: string | null
}

/** Fullscreen / tab-mode counterpart to `ejectTileFromLayout`. */
export function applyPanelTabEject(input: {
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode | null
  expandLayoutGroupId: string | null
  tileId: string
  position: { x: number, y: number }
  zIndex: number
}): PanelTabEjectResult {
  if (input.expandLayoutGroupId) {
    const ejected = ejectTileFromLayout({
      tiles: input.tiles,
      groups: input.groups,
      groupId: input.expandLayoutGroupId,
      tileId: input.tileId,
      position: input.position,
      zIndex: input.zIndex,
    })
    const leftover = ejected.groups.find(group => group.id === input.expandLayoutGroupId)
    const leftoverLayout = leftover?.layoutMode && isPanelNode(leftover.layout) ? leftover.layout : null
    return {
      tiles: ejected.tiles,
      groups: ejected.groups,
      panelLayout: leftoverLayout,
      expandLayoutGroupId: leftoverLayout ? input.expandLayoutGroupId : null,
      activePanelId: leftoverLayout ? findFirstLeafId(leftoverLayout) : null,
    }
  }

  const nextLayout = input.panelLayout ? removeTileFromTree(input.panelLayout, input.tileId) : null
  const kept = nextLayout && tileIdsInLayout(nextLayout).length > 0 ? nextLayout : null
  const nextTiles = input.tiles.map(tile => {
    if (tile.id !== input.tileId) return tile
    const { groupId: _removed, ...rest } = tile
    return {
      ...rest,
      x: input.position.x,
      y: input.position.y,
      zIndex: input.zIndex,
    } as TileState
  })
  return {
    tiles: nextTiles,
    groups: input.groups,
    panelLayout: kept,
    expandLayoutGroupId: null,
    activePanelId: kept ? findFirstLeafId(kept) : null,
  }
}

export function commitGroupLayout(
  tiles: TileState[],
  groups: GroupState[],
  groupId: string,
  layout: PanelNode | null | undefined,
): { tiles: TileState[], groups: GroupState[] } {
  const ids = tileIdsInLayout(layout)
  const existing = groups.find(group => group.id === groupId)?.layoutBounds
  const nextGroups = applyLayoutToGroup(
    groups,
    groupId,
    layout && ids.length > 0 ? layout : null,
    layout && ids.length > 0
      ? (existing ?? layoutBoundsForArrangement({ tiles, tileIds: ids, layout }))
      : undefined,
  )
  const nextTiles = syncTilesToLayoutGroup(tiles, groupId, layout && ids.length > 0 ? layout : null)
  return { tiles: nextTiles, groups: nextGroups }
}

export function ensureLayoutGroup(input: {
  tiles: TileState[]
  groups: GroupState[]
  layout: PanelNode
  reuseGroupId?: string | null
  createId?: string
}): { tiles: TileState[], groups: GroupState[], groupId: string, layout: PanelNode } {
  const { layout } = input
  const memberIds = tileIdsInLayout(layout)
  if (memberIds.length === 0) {
    return { tiles: input.tiles, groups: input.groups, groupId: input.reuseGroupId ?? '', layout }
  }

  const reuse = input.reuseGroupId && input.groups.some(group => group.id === input.reuseGroupId)
    ? input.reuseGroupId
    : null
  const groupId = reuse ?? input.createId ?? `group-${Date.now()}`
  const previousGroupIds = new Set(
    input.tiles
      .filter(tile => memberIds.includes(tile.id) && tile.groupId)
      .map(tile => tile.groupId as string),
  )

  let nextGroups = input.groups
  if (!reuse) {
    nextGroups = [
      ...input.groups,
      {
        id: groupId,
        color: LAYOUT_GROUP_COLOR,
        layoutMode: true,
        layout,
        layoutBounds: layoutBoundsForArrangement({
          tiles: input.tiles,
          tileIds: memberIds,
          layout,
        }),
      },
    ]
  } else {
    nextGroups = nextGroups.filter(group => group.id === groupId || group.parentGroupId !== groupId)
  }

  const existingBounds = nextGroups.find(group => group.id === groupId)?.layoutBounds
  nextGroups = applyLayoutToGroup(
    nextGroups,
    groupId,
    layout,
    layoutBoundsForArrangement({
      tiles: input.tiles,
      tileIds: memberIds,
      layout,
      existing: existingBounds,
    }),
  )
  const nextTiles = syncTilesToLayoutGroup(input.tiles, groupId, layout)
  nextGroups = pruneGroups(nextGroups, nextTiles, previousGroupIds, groupId)

  return { tiles: nextTiles, groups: nextGroups, groupId, layout }
}

function sharedGroupId(tiles: TileState[], tileIds: readonly string[]): string | null {
  const idSet = new Set(tileIds)
  const memberGroups = new Set(
    tiles.filter(tile => idSet.has(tile.id) && tile.groupId).map(tile => tile.groupId as string),
  )
  return memberGroups.size === 1 ? [...memberGroups][0] : null
}

function sharedDashedGroupId(
  tiles: TileState[],
  groups: GroupState[],
  tileIds: readonly string[],
): string | null {
  const shared = sharedGroupId(tiles, tileIds)
  if (!shared) return null
  const group = groups.find(candidate => candidate.id === shared)
  if (!group || group.layoutMode) return null
  return shared
}

function findGroupOwningExactTileSet(groups: GroupState[], tileIds: Set<string>): string | null {
  if (tileIds.size === 0) return null
  for (const group of groups) {
    if (!group.layoutMode) continue
    const owned = tileIdsInLayout(group.layout)
    if (owned.length === tileIds.size && owned.every(id => tileIds.has(id))) return group.id
  }
  return null
}

export function findOverlappingLayoutGroupId(
  groups: GroupState[],
  tileIds: readonly string[],
): string | null {
  const idSet = new Set(tileIds)
  let bestId: string | null = null
  let bestCount = 0
  for (const group of groups) {
    if (!group.layoutMode) continue
    const overlap = tileIdsInLayout(group.layout).filter(id => idSet.has(id)).length
    if (overlap > bestCount) {
      bestId = group.id
      bestCount = overlap
    }
  }
  return bestId
}

export function findReusableArrangementGroupId(
  tiles: TileState[],
  groups: GroupState[],
  tileIds: readonly string[],
): string | null {
  return findGroupOwningExactTileSet(groups, new Set(tileIds))
    ?? sharedDashedGroupId(tiles, groups, tileIds)
}

export function resolveExpandFromTile(input: {
  tileId: string
  tiles: TileState[]
  groups: GroupState[]
}): ArrangementResolution {
  const { tileId, tiles, groups } = input
  const layoutOwner = findLayoutGroupIdForTile(groups, tileId)
    ?? groups.find(group => group.layoutMode && tiles.some(tile => tile.id === tileId && tile.groupId === group.id))?.id
    ?? null

  if (layoutOwner) {
    const group = groups.find(candidate => candidate.id === layoutOwner)
    const existing = isPanelNode(group?.layout)
      ? group!.layout
      : createLeaf(
        tiles.filter(tile => tile.groupId === layoutOwner).map(tile => tile.id),
        tileId,
      )
    const activated = activateTileInLayout(existing, tileId)
    return {
      tileIds: tileIdsInLayout(activated.layout),
      layout: activated.layout,
      reuseGroupId: layoutOwner,
    }
  }

  const clicked = tiles.find(tile => tile.id === tileId)
  if (clicked?.groupId) {
    const memberIds = collectDescendantTileIds(tiles, groups, clicked.groupId)
    const ordered = memberIds.includes(tileId)
      ? [tileId, ...memberIds.filter(id => id !== tileId)]
      : memberIds
    const rects = tiles
      .filter(tile => ordered.includes(tile.id))
      .map(tile => ({ id: tile.id, x: tile.x, y: tile.y, width: tile.width, height: tile.height }))
    const spatial = tilesToPanelNode(rects) ?? createLeaf(ordered, tileId)
    const activated = activateTileInLayout(spatial, tileId)
    return {
      tileIds: tileIdsInLayout(activated.layout),
      layout: activated.layout,
      reuseGroupId: clicked.groupId,
    }
  }

  const layout = createLeaf([tileId], tileId)
  return { tileIds: [tileId], layout, reuseGroupId: null }
}

export function resolveWorkspaceTabArrangement(input: {
  tiles: TileState[]
  groups: GroupState[]
  savedLayout: PanelNode | null
  selectedTileId?: string | null
}): ArrangementResolution {
  const { tiles, groups, savedLayout, selectedTileId } = input
  const layoutOwned = collectLayoutTreeTileIds(groups)

  if (selectedTileId && layoutOwned.has(selectedTileId)) {
    return resolveExpandFromTile({ tileId: selectedTileId, tiles, groups })
  }

  const existingIds = tiles.map(tile => tile.id)

  if (savedLayout) {
    const sanitized = sanitizePanelLayout(savedLayout, existingIds).layout
    if (sanitized && tileIdsInLayout(sanitized).length > 0) {
      const overlapping = findOverlappingLayoutGroupId(groups, tileIdsInLayout(sanitized))
      if (overlapping) {
        const group = groups.find(candidate => candidate.id === overlapping)
        if (group && isPanelNode(group.layout)) {
          return {
            tileIds: tileIdsInLayout(group.layout),
            layout: group.layout,
            reuseGroupId: overlapping,
          }
        }
      }

      let restored: PanelNode | null = sanitized
      for (const tileId of tileIdsInLayout(sanitized)) {
        if (layoutOwned.has(tileId)) {
          restored = restored ? removeTileFromTree(restored, tileId) : null
        }
      }
      const tileIds = tileIdsInLayout(restored)
      if (restored && tileIds.length > 0) {
        return {
          tileIds,
          layout: restored,
          reuseGroupId: findReusableArrangementGroupId(tiles, groups, tileIds),
        }
      }
    }
  }

  const freeTiles = tiles.filter(tile => !layoutOwned.has(tile.id))
  if (freeTiles.length > 0) {
    const tileIds = freeTiles.map(tile => tile.id)
    return {
      tileIds,
      layout: createLeaf(tileIds, tileIds[0]),
      reuseGroupId: findReusableArrangementGroupId(tiles, groups, tileIds),
    }
  }

  const firstLayout = groups.find(group => group.layoutMode && tileIdsInLayout(group.layout).length > 0)
  if (firstLayout && isPanelNode(firstLayout.layout)) {
    return {
      tileIds: tileIdsInLayout(firstLayout.layout),
      layout: firstLayout.layout,
      reuseGroupId: firstLayout.id,
    }
  }

  return { tileIds: [], layout: createLeaf([]), reuseGroupId: null }
}

export function convertGroupToLayoutGroup(
  tiles: TileState[],
  groups: GroupState[],
  groupId: string,
): { tiles: TileState[], groups: GroupState[] } | null {
  const memberIds = collectDescendantTileIds(tiles, groups, groupId)
  if (memberIds.length === 0) return null
  const rects = tiles
    .filter(tile => memberIds.includes(tile.id))
    .map(tile => ({ id: tile.id, x: tile.x, y: tile.y, width: tile.width, height: tile.height }))
  const layout = tilesToPanelNode(rects) ?? createLeaf(memberIds, memberIds[0])
  const descendantGroupIds = new Set(collectDescendantGroupIds(groups, groupId))
  const nextGroups = groups.filter(group => !descendantGroupIds.has(group.id))
  const ensured = ensureLayoutGroup({
    tiles,
    groups: nextGroups,
    layout,
    reuseGroupId: groupId,
  })
  return { tiles: ensured.tiles, groups: ensured.groups }
}

function collectDescendantGroupIds(groups: GroupState[], groupId: string): string[] {
  const children = groups.filter(group => group.parentGroupId === groupId)
  return [
    ...children.map(group => group.id),
    ...children.flatMap(group => collectDescendantGroupIds(groups, group.id)),
  ]
}

export function attachLayoutGroupToGenerated(input: {
  tiles: TileState[]
  panelLayout: PanelNode
  groupId?: string
}): { tiles: TileState[], groups: GroupState[], expandLayoutGroupId: string } {
  const groupId = input.groupId ?? `group-${Date.now()}`
  const ensured = ensureLayoutGroup({
    tiles: input.tiles,
    groups: [],
    layout: input.panelLayout,
    createId: groupId,
  })
  return {
    tiles: ensured.tiles,
    groups: ensured.groups,
    expandLayoutGroupId: ensured.groupId,
  }
}
