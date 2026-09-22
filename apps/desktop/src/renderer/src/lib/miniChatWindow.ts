export type MiniChatOptions = { workspaceId: string, tileId: string, title: string }

export function readMiniChatOptions(): MiniChatOptions | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.get('miniChat') !== '1') return null
  const workspaceId = params.get('workspaceId')?.trim() ?? ''
  const tileId = params.get('tileId')?.trim() ?? ''
  if (!workspaceId || !tileId) return null
  return {
    workspaceId,
    tileId,
    title: params.get('title')?.trim() || 'Mini Chat',
  }
}