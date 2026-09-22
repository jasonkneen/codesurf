import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { GroupState, TileState } from '../../../shared/types.ts'
import {
  convertGroupToLayoutGroup,
  correctLayoutBoundsOrientation,
} from '../lib/layoutGroupMembership.ts'
import type { SaveCanvasFn, CanvasViewport } from './useCanvasEngine.ts'

export type UseCanvasGroupManagerOptions = {
  tiles: TileState[]
  groups: GroupState[]
  selectedTileIds: Set<string>
  viewport: CanvasViewport
  nextZIndex: number
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  saveCanvas: SaveCanvasFn
}

export function collectCanvasGroupTileIds(
  tiles: TileState[],
  groups: GroupState[],
  groupId: string,
): string[] {
  const direct = tiles.filter(tile => tile.groupId === groupId).map(tile => tile.id)
  const childGroups = groups.filter(group => group.parentGroupId === groupId)
  return [
    ...direct,
    ...childGroups.flatMap(group => collectCanvasGroupTileIds(tiles, groups, group.id)),
  ]
}

export function computeCanvasGroupBounds(
  tiles: TileState[],
  groups: GroupState[],
  groupId: string,
): { x: number; y: number; w: number; h: number } | null {
  const group = groups.find(candidate => candidate.id === groupId)
  if (group?.layoutMode && group.layoutBounds) {
    return correctLayoutBoundsOrientation(
      group.layoutBounds as { x: number; y: number; w: number; h: number },
      group.layout,
    )
  }
  const ids = new Set(collectCanvasGroupTileIds(tiles, groups, groupId))
  const members = tiles.filter(tile => ids.has(tile.id))
  if (members.length === 0) return null
  const padding = 20
  const minX = Math.min(...members.map(tile => tile.x)) - padding
  const minY = Math.min(...members.map(tile => tile.y)) - padding
  const maxX = Math.max(...members.map(tile => tile.x + tile.width)) + padding
  const maxY = Math.max(...members.map(tile => tile.y + tile.height)) + padding
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function useCanvasGroupManager({
  tiles,
  groups,
  selectedTileIds,
  viewport,
  nextZIndex,
  setTiles,
  setGroups,
  setSelectedTileIds,
  saveCanvas,
}: UseCanvasGroupManagerOptions) {
  const groupSelectedTiles = useCallback(() => {
    if (selectedTileIds.size < 2) return
    const groupId = `group-${Date.now()}`

    setGroups(prevGroups => {
      const childGroupIds = new Set(
        prevGroups
          .filter(group => {
            const members = tiles.filter(tile => tile.groupId === group.id)
            return members.length > 0 && members.every(tile => selectedTileIds.has(tile.id))
          })
          .map(group => group.id),
      )

      const updatedGroups = prevGroups.map(group =>
        childGroupIds.has(group.id) ? { ...group, parentGroupId: groupId } : group,
      )
      const newGroup: GroupState = { id: groupId }
      const finalGroups = [...updatedGroups, newGroup]

      setTiles(prev => {
        const updated = prev.map(tile =>
          selectedTileIds.has(tile.id) && !childGroupIds.has(tile.groupId ?? '')
            ? { ...tile, groupId }
            : tile,
        )
        saveCanvas(updated, viewport, nextZIndex, finalGroups)
        return updated
      })
      return finalGroups
    })
    setSelectedTileIds(new Set())
  }, [selectedTileIds, tiles, viewport, nextZIndex, saveCanvas, setSelectedTileIds, setTiles, setGroups])

  const ungroupTiles = useCallback((groupId: string) => {
    setGroups(prevGroups => {
      const group = prevGroups.find(candidate => candidate.id === groupId)
      const parentId = group?.parentGroupId

      const updatedGroups = prevGroups
        .filter(candidate => candidate.id !== groupId)
        .map(candidate => candidate.parentGroupId === groupId
          ? { ...candidate, parentGroupId: parentId }
          : candidate)

      setTiles(prev => {
        const updated = prev.map(tile =>
          tile.groupId === groupId ? { ...tile, groupId: parentId } : tile,
        )
        saveCanvas(updated, viewport, nextZIndex, updatedGroups)
        return updated
      })
      return updatedGroups
    })
  }, [viewport, nextZIndex, saveCanvas, setGroups, setTiles])

  const ungroupAll = useCallback((groupId: string) => {
    setGroups(prevGroups => {
      const toRemove = new Set<string>()
      const collect = (id: string) => {
        toRemove.add(id)
        prevGroups.filter(group => group.parentGroupId === id).forEach(group => collect(group.id))
      }
      collect(groupId)

      const updatedGroups = prevGroups.filter(group => !toRemove.has(group.id))

      setTiles(prev => {
        const updated = prev.map(tile =>
          toRemove.has(tile.groupId ?? '') ? { ...tile, groupId: undefined } : tile,
        )
        saveCanvas(updated, viewport, nextZIndex, updatedGroups)
        return updated
      })
      return updatedGroups
    })
  }, [viewport, nextZIndex, saveCanvas, setGroups, setTiles])

  const groupBounds = useCallback((groupId: string): { x: number, y: number, w: number, h: number } | null => {
    return computeCanvasGroupBounds(tiles, groups, groupId)
  }, [tiles, groups])

  const collectGroupTileIds = useCallback((groupId: string): string[] => {
    return collectCanvasGroupTileIds(tiles, groups, groupId)
  }, [tiles, groups])

  const convertGroupToLayout = useCallback((groupId: string) => {
    const converted = convertGroupToLayoutGroup(tiles, groups, groupId)
    if (!converted) return
    setGroups(converted.groups)
    setTiles(converted.tiles)
    saveCanvas(converted.tiles, viewport, nextZIndex, converted.groups)
  }, [tiles, groups, viewport, nextZIndex, saveCanvas, setGroups, setTiles])

  const revertLayoutGroup = useCallback((groupId: string) => {
    setGroups(prev => {
      const updated = prev.map(group => group.id === groupId ? {
        ...group,
        layoutMode: false,
        layout: undefined,
        layoutBounds: undefined,
      } : group)
      setTiles(current => { saveCanvas(current, viewport, nextZIndex, updated); return current })
      return updated
    })
  }, [viewport, nextZIndex, saveCanvas, setGroups, setTiles])

  return {
    groupSelectedTiles,
    ungroupTiles,
    ungroupAll,
    groupBounds,
    collectGroupTileIds,
    convertGroupToLayout,
    revertLayoutGroup,
  }
}
