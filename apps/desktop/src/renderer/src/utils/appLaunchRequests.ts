import type { TileType } from '../../../shared/types'

export const CODESURF_CREATE_TILE_EVENT = 'codesurf:create-tile'
export const CODESURF_OPEN_CHAT_SURFACE_EVENT = 'codesurf:open-chat-surface'

export interface CodeSurfCreateTileDetail {
  type: TileType
  filePath?: string
  x?: number
  y?: number
  focus?: boolean
  sourceTileId?: string
}

export interface CodeSurfOpenChatSurfaceDetail {
  extId: string
  surfaceId: string
  targetTileId?: string
  preferredTileId?: string
  sourceTileId?: string
  initialContext?: Record<string, unknown>
}

export interface LaunchableTileRef {
  id: string
  type: string
}

export interface ChatSurfaceTargetResolution {
  tileId: string | null
  shouldCreate: boolean
  reason: 'target' | 'active' | 'existing' | 'create'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function normalizeCreateTileDetail(value: unknown): CodeSurfCreateTileDetail | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = stringValue(record.type)
  if (!type) return null

  const filePath = stringValue(record.filePath)
  const sourceTileId = stringValue(record.sourceTileId)
  const x = optionalNumber(record.x)
  const y = optionalNumber(record.y)

  return {
    type: type as TileType,
    ...(filePath ? { filePath } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    focus: record.focus === false ? false : true,
    ...(sourceTileId ? { sourceTileId } : {}),
  }
}

export function normalizeOpenChatSurfaceDetail(value: unknown): CodeSurfOpenChatSurfaceDetail | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const extId = stringValue(record.extId)
  const surfaceId = stringValue(record.surfaceId ?? record.id)
  if (!extId || !surfaceId) return null

  const targetTileId = stringValue(record.targetTileId)
  const preferredTileId = stringValue(record.preferredTileId)
  const sourceTileId = stringValue(record.sourceTileId)
  const initialContext = record.initialContext && typeof record.initialContext === 'object' && !Array.isArray(record.initialContext)
    ? record.initialContext as Record<string, unknown>
    : undefined

  return {
    extId,
    surfaceId,
    ...(targetTileId ? { targetTileId } : {}),
    ...(preferredTileId ? { preferredTileId } : {}),
    ...(sourceTileId ? { sourceTileId } : {}),
    ...(initialContext ? { initialContext } : {}),
  }
}

export function resolveChatSurfaceTargetTile({
  tiles,
  targetTileId,
  activeChatTileId,
}: {
  tiles: LaunchableTileRef[]
  targetTileId?: string | null
  activeChatTileId?: string | null
}): ChatSurfaceTargetResolution {
  const isChatTile = (tileId: string | null | undefined) => !!tileId && tiles.some(tile => tile.id === tileId && tile.type === 'chat')

  if (isChatTile(targetTileId)) {
    return { tileId: targetTileId!, shouldCreate: false, reason: 'target' }
  }

  if (isChatTile(activeChatTileId)) {
    return { tileId: activeChatTileId!, shouldCreate: false, reason: 'active' }
  }

  const existing = tiles.find(tile => tile.type === 'chat')
  if (existing) {
    return { tileId: existing.id, shouldCreate: false, reason: 'existing' }
  }

  return { tileId: null, shouldCreate: true, reason: 'create' }
}

export function dispatchCreateTile(detail: CodeSurfCreateTileDetail): void {
  window.dispatchEvent(new CustomEvent<CodeSurfCreateTileDetail>(CODESURF_CREATE_TILE_EVENT, { detail }))
}

export function dispatchOpenChatSurface(detail: CodeSurfOpenChatSurfaceDetail): void {
  window.dispatchEvent(new CustomEvent<CodeSurfOpenChatSurfaceDetail>(CODESURF_OPEN_CHAT_SURFACE_EVENT, { detail }))
}
