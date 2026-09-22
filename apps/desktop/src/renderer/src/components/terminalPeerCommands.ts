export function resolveTerminalPeerWrite(
  workspaceId: string,
  tileId: string,
  payload: Record<string, unknown>,
): string | null {
  if (payload.workspaceId !== workspaceId) return null
  const targetTileId = typeof payload.tileId === 'string'
    ? payload.tileId
    : typeof payload.cardId === 'string'
      ? payload.cardId
      : ''
  if (targetTileId !== tileId) return null

  if (payload.command === 'terminal_clear') return '\x0c'
  if (payload.command !== 'terminal_send_input' || typeof payload.input !== 'string') {
    return null
  }

  return `${payload.input}${payload.enter === false ? '' : '\r'}`
}
