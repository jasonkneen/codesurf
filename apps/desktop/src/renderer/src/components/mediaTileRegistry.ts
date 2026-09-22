export const mediaNodes = new Map<string, HTMLElement>()

export function disposeMediaTile(tileId: string): void {
  const node = mediaNodes.get(tileId)
  if (!node) return
  // Pause anything that plays so it stops consuming codec/resources immediately.
  const media = node instanceof HTMLMediaElement
    ? node
    : node.querySelector('video, audio') as HTMLMediaElement | null
  if (media) {
    try {
      media.pause()
      media.removeAttribute('src')
      media.load()
    } catch { /* ignore */ }
  }
  node.remove()
  mediaNodes.delete(tileId)
}
