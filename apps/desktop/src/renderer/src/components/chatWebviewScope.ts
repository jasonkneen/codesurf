export function scopeChatWebviewParams(
  params: unknown,
  workspaceId: string,
  tileId: string,
): Record<string, unknown> {
  return {
    ...((params && typeof params === 'object') ? params : {}),
    workspaceId,
    cardId: tileId,
  }
}
