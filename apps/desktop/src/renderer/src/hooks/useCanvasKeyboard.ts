import { useEffect, type MutableRefObject } from 'react'
import { isEditableTarget } from '../utils/editableTarget.ts'

type UseCanvasKeyboardOptions = {
  selectedTileIds: Set<string>
  groupSelectedTiles: () => void
  setCommandPaletteOpen: (updater: boolean | ((open: boolean) => boolean)) => void
  undoCanvas: () => void
  redoCanvas: () => void
  onEscape: () => void
  spaceHeldRef: MutableRefObject<boolean>
}

export type CanvasKeyboardCommand = 'group' | 'undo' | 'redo' | null

export function resolveCanvasKeyboardCommand(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): CanvasKeyboardCommand {
  const mod = event.metaKey || event.ctrlKey
  if (!mod) return null
  if (event.key === 'g') return 'group'
  if (event.key === 'z' && !event.shiftKey) return 'undo'
  if ((event.key === 'z' && event.shiftKey) || event.key === 'y') return 'redo'
  return null
}

export function executeCanvasKeyboardCommand(
  command: Exclude<CanvasKeyboardCommand, null>,
  options: {
    selectedTileCount: number
    groupSelectedTiles: () => void
    undoCanvas: () => void
    redoCanvas: () => void
  },
): boolean {
  if (command === 'group') {
    if (options.selectedTileCount >= 2) options.groupSelectedTiles()
    return true
  }
  if (command === 'undo') options.undoCanvas()
  else options.redoCanvas()
  return true
}

export function useCanvasKeyboard({
  selectedTileIds,
  groupSelectedTiles,
  setCommandPaletteOpen,
  undoCanvas,
  redoCanvas,
  onEscape,
  spaceHeldRef,
}: UseCanvasKeyboardOptions) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const command = resolveCanvasKeyboardCommand(event)
      if (!command) return
      const handled = executeCanvasKeyboardCommand(command, {
        selectedTileCount: selectedTileIds.size,
        groupSelectedTiles,
        undoCanvas,
        redoCanvas,
      })
      if (!handled) return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [groupSelectedTiles, redoCanvas, selectedTileIds, undoCanvas])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault()
        setCommandPaletteOpen(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommandPaletteOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !event.repeat) {
        if (isEditableTarget(event.target)) return
        event.preventDefault()
        spaceHeldRef.current = true
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeldRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [spaceHeldRef])
}
