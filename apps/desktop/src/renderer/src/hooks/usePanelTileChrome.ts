import { useCallback } from 'react'
import type { ExtensionTileContrib, TileState } from '../../../shared/types'

export type UsePanelTileChromeParams = {
  tiles: TileState[]
  extensionNameById: Map<string, string>
  extensionTileByType: Map<string, ExtensionTileContrib>
}

export function usePanelTileChrome(params: UsePanelTileChromeParams) {
  const { tiles, extensionNameById, extensionTileByType } = params

  const getPanelTileLabel = useCallback((tileId: string): string => {
    const tile = tiles.find(entry => entry.id === tileId)
    if (!tile) return 'Unknown'
    if (tile.label?.trim()) return tile.label.trim()
    if (tile.filePath) return tile.filePath.replace(/\\/g, '/').split('/').pop() ?? tile.filePath
    if (tile.type.startsWith('ext:')) {
      const tileLabel = extensionTileByType.get(tile.type)?.label
      if (tileLabel?.trim()) return tileLabel.trim()
      const friendlyName = extensionNameById.get(tile.type.slice(4))
      if (friendlyName?.trim()) return friendlyName.trim()
    }
    return tile.type.charAt(0).toUpperCase() + tile.type.slice(1)
  }, [extensionNameById, extensionTileByType, tiles])

  const getPanelTileIcon = useCallback((tileId: string): string | undefined => {
    const tile = tiles.find(entry => entry.id === tileId)
    if (!tile?.type.startsWith('ext:')) return undefined
    return extensionTileByType.get(tile.type)?.icon
  }, [extensionTileByType, tiles])

  return { getPanelTileLabel, getPanelTileIcon }
}