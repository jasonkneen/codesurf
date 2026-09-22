import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { TileState } from '../../../shared/types'
import type { SaveCanvasFn } from './useCanvasEngine'
import type { CanvasViewport } from './useCanvasEngine'
import { isEditableTarget } from '../utils/editableTarget'

export type UseCanvasTileShortcutsOptions = {
  selectedTileId: string | null
  selectedTileIds: Set<string>
  viewport: CanvasViewport
  nextZIndex: number
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  saveCanvas: SaveCanvasFn
  copyTiles: (cut?: boolean) => void
  pasteTiles: (pos?: { x: number, y: number }, intoGroupId?: string) => void
  duplicateTiles: (ids?: string[]) => void
}

export function useCanvasTileShortcuts({
  selectedTileId,
  selectedTileIds,
  viewport,
  nextZIndex,
  setTiles,
  setSelectedTileId,
  setSelectedTileIds,
  saveCanvas,
  copyTiles,
  pasteTiles,
  duplicateTiles,
}: UseCanvasTileShortcutsOptions) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key === 'c') { event.preventDefault(); copyTiles(false) }
      if (mod && event.key === 'x') { event.preventDefault(); copyTiles(true) }
      if (mod && event.key === 'v') { event.preventDefault(); pasteTiles() }
      if (mod && event.key === 'd') { event.preventDefault(); duplicateTiles() }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !mod) {
        const active = selectedTileIds.size > 0
          ? [...selectedTileIds]
          : selectedTileId ? [selectedTileId] : []
        if (active.length > 0) {
          const ids = new Set(active)
          setTiles(prev => {
            const updated = prev.filter(tile => !ids.has(tile.id))
            saveCanvas(updated, viewport, nextZIndex)
            return updated
          })
          setSelectedTileId(null)
          setSelectedTileIds(new Set())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    copyTiles,
    duplicateTiles,
    nextZIndex,
    pasteTiles,
    saveCanvas,
    selectedTileId,
    selectedTileIds,
    setSelectedTileId,
    setSelectedTileIds,
    setTiles,
    viewport,
  ])
}