/**
 * Tile chrome labels / title helpers.
 */
import type { TileState } from '../../../../shared/types'

export const DRAWER_WIDTH = 260
export const DRAWER_TYPES = new Set(['terminal', 'chat'])

const TYPE_LABELS: Record<string, string> = {
  terminal: 'Terminal', note: 'Note', code: 'Code', image: 'Image', kanban: 'Board', browser: 'Browser', chat: 'Chat', files: 'Files', customisation: 'Settings',
}

export function getTypeLabel(type: string): string {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type]
  if (type.startsWith('ext:')) {
    const name = type.slice(4)
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  return type
}

export function fileLabel(tile: TileState): string {
  if (tile.label) return tile.label
  if (!tile.filePath) return getTypeLabel(tile.type)
  return tile.filePath.replace(/\\/g, '/').split('/').pop() || tile.filePath
}

export function getTitlebarForeground(background: string | null | undefined, lightFallback: string, darkFallback: string): string {
  if (!background) return lightFallback
  const hex = background.trim().match(/^#([0-9a-f]{6})$/i)
  if (!hex) return lightFallback
  const value = hex[1]
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.62 ? darkFallback : lightFallback
}

