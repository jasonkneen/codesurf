import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { GroupState, TileState } from '../../../shared/types'
import { assignTilesToGroup, removeTileFromAllGroupLayouts } from '../lib/layoutGroupMembership.ts'
import type { SaveCanvasFn } from './useCanvasEngine'
import type { CanvasViewport } from './useCanvasEngine'

export type UseTileClipboardOptions = {
  tiles: TileState[]
  groups: GroupState[]
  selectedTileId: string | null
  selectedTileIds: Set<string>
  viewport: CanvasViewport
  nextZIndex: number
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  setNextZIndex: Dispatch<SetStateAction<number>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  saveCanvas: SaveCanvasFn
  viewportCenter: () => { x: number, y: number }
  snapValue: (value: number) => number
  groupBoundsRef: MutableRefObject<(id: string) => { x: number, y: number, w: number, h: number } | null>
}

export function useTileClipboard({
  tiles,
  groups,
  selectedTileId,
  selectedTileIds,
  viewport,
  nextZIndex,
  setTiles,
  setGroups,
  setNextZIndex,
  setSelectedTileId,
  setSelectedTileIds,
  saveCanvas,
  viewportCenter,
  snapValue,
  groupBoundsRef,
}: UseTileClipboardOptions) {
  const clipboardRef = useRef<TileState[]>([])
  const isCutRef = useRef(false)
  const pasteOffsetRef = useRef(0)
  const pasteTargetGroupIdRef = useRef<string | undefined>(undefined)

  const getActiveTiles = useCallback((): TileState[] => {
    return tiles.filter(tile =>
      selectedTileIds.size > 0 ? selectedTileIds.has(tile.id) : tile.id === selectedTileId,
    )
  }, [tiles, selectedTileIds, selectedTileId])

  const copyTiles = useCallback((cut = false) => {
    const active = getActiveTiles()
    if (active.length === 0) return
    clipboardRef.current = active
    isCutRef.current = cut
    pasteOffsetRef.current = 0
    pasteTargetGroupIdRef.current = cut ? active[0]?.groupId : undefined
    if (cut) {
      const ids = new Set(active.map(tile => tile.id))
      setGroups(prev => {
        let next = prev
        for (const id of ids) next = removeTileFromAllGroupLayouts(next, id)
        return next
      })
      setTiles(prev => {
        const updated = prev.filter(tile => !ids.has(tile.id))
        saveCanvas(updated, viewport, nextZIndex)
        return updated
      })
      setSelectedTileId(null)
      setSelectedTileIds(new Set())
    }
  }, [getActiveTiles, viewport, nextZIndex, saveCanvas, setGroups, setSelectedTileId, setSelectedTileIds, setTiles])

  const pasteTiles = useCallback((pos?: { x: number, y: number }, intoGroupId?: string) => {
    if (clipboardRef.current.length === 0) return
    if (pasteOffsetRef.current > 10) pasteOffsetRef.current = 0
    pasteOffsetRef.current += 1
    const OFFSET = pasteOffsetRef.current * 30
    const srcMinX = Math.min(...clipboardRef.current.map(tile => tile.x))
    const srcMinY = Math.min(...clipboardRef.current.map(tile => tile.y))
    const center = pos ?? viewportCenter()
    const newNZ = nextZIndex + clipboardRef.current.length
    let targetGroup = intoGroupId ?? pasteTargetGroupIdRef.current
    if (!targetGroup && pos) {
      for (const group of groups) {
        const bounds = groupBoundsRef.current(group.id)
        if (bounds && pos.x >= bounds.x && pos.x <= bounds.x + bounds.w && pos.y >= bounds.y && pos.y <= bounds.y + bounds.h) {
          targetGroup = group.id
          break
        }
      }
    }
    const newTiles = clipboardRef.current.map((tile, index) => ({
      ...tile,
      id: `tile-${Date.now()}-${index}`,
      x: pos
        ? snapValue(center.x + (tile.x - srcMinX) - (Math.max(...clipboardRef.current.map(other => other.x + other.width)) - srcMinX) / 2)
        : snapValue(tile.x + OFFSET),
      y: pos
        ? snapValue(center.y + (tile.y - srcMinY) - (Math.max(...clipboardRef.current.map(other => other.y + other.height)) - srcMinY) / 2)
        : snapValue(tile.y + OFFSET),
      zIndex: nextZIndex + index,
      groupId: targetGroup,
    }))
    setTiles(prev => {
      const assigned = assignTilesToGroup(
        [...prev, ...newTiles],
        groups,
        newTiles.map(tile => tile.id),
        targetGroup,
      )
      setGroups(assigned.groups)
      saveCanvas(assigned.tiles, viewport, newNZ, assigned.groups)
      return assigned.tiles
    })
    setNextZIndex(newNZ)
    setSelectedTileIds(new Set(newTiles.map(tile => tile.id)))
    setSelectedTileId(null)
  }, [
    groups,
    groupBoundsRef,
    setGroups,
    nextZIndex,
    saveCanvas,
    setNextZIndex,
    setSelectedTileId,
    setSelectedTileIds,
    setTiles,
    snapValue,
    viewport,
    viewportCenter,
  ])

  const duplicateTiles = useCallback((ids?: string[]) => {
    const targets = ids
      ? tiles.filter(tile => ids.includes(tile.id))
      : getActiveTiles()
    if (targets.length === 0) return
    const newNZ = nextZIndex + targets.length
    const newTiles = targets.map((tile, index) => ({
      ...tile,
      id: `tile-${Date.now()}-${index}`,
      x: snapValue(tile.x + 40),
      y: snapValue(tile.y + 40),
      zIndex: nextZIndex + index,
      groupId: undefined,
    }))
    setTiles(prev => {
      const updated = [...prev, ...newTiles]
      saveCanvas(updated, viewport, newNZ)
      return updated
    })
    setNextZIndex(newNZ)
    setSelectedTileIds(new Set(newTiles.map(tile => tile.id)))
    setSelectedTileId(null)
  }, [getActiveTiles, nextZIndex, saveCanvas, setNextZIndex, setSelectedTileId, setSelectedTileIds, setTiles, snapValue, tiles, viewport])

  return {
    clipboardRef,
    pasteTargetGroupIdRef,
    copyTiles,
    pasteTiles,
    duplicateTiles,
  }
}