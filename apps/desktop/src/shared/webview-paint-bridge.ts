/**
 * Electron-free bridge between guest <webview> tags and WebContents.setFrameRate.
 *
 * Electron 41's WebviewTag does NOT expose getWebContents() — only
 * getWebContentsId(). Frame-rate control lives on WebContents, resolved in
 * the main process via webContents.fromId(id).
 */

/** Full interactive rate when the tile body is on-screen. */
export const WEBVIEW_PAINT_ACTIVE_FPS = 60
/** Near-frozen rate when the tile body is culled / off-canvas. */
export const WEBVIEW_PAINT_CULLED_FPS = 1

/** Resolve the frame rate for a managed webview given paint visibility. */
export function frameRateForPaintActive(paintActive: boolean): number {
  return paintActive ? WEBVIEW_PAINT_ACTIVE_FPS : WEBVIEW_PAINT_CULLED_FPS
}

export type WebviewPaintCommand = {
  webContentsId: number
  fps: number
}

export type WebContentsLike = {
  setFrameRate?: (fps: number) => void
  isDestroyed?: () => boolean
}

/**
 * Build the IPC payload for a paint freeze/restore from a guest webview.
 * Returns null when getWebContentsId is missing or returns a non-positive id
 * (iframe fallback / Electrobun / not attached yet).
 */
export function resolveWebviewPaintCommand(
  getWebContentsId: () => number | undefined | null,
  paintActive: boolean,
): WebviewPaintCommand | null {
  let id: number | undefined | null
  try {
    id = getWebContentsId()
  } catch {
    return null
  }
  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return null
  return {
    webContentsId: id,
    fps: frameRateForPaintActive(paintActive),
  }
}

/**
 * Main-process (or test) adapter: resolve WebContents by id and set frame rate.
 * `fromId` must be Electron's `webContents.fromId` (or a test double).
 * Returns true when setFrameRate was invoked.
 */
export function applyWebviewPaintFrameRate(
  webContentsId: number,
  fps: number,
  fromId: (id: number) => WebContentsLike | null | undefined,
): boolean {
  if (typeof webContentsId !== 'number' || !Number.isFinite(webContentsId) || webContentsId <= 0) {
    return false
  }
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0) {
    return false
  }
  let wc: WebContentsLike | null | undefined
  try {
    wc = fromId(webContentsId)
  } catch {
    return false
  }
  if (!wc || typeof wc.setFrameRate !== 'function') return false
  try {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
    wc.setFrameRate(fps)
    return true
  } catch {
    return false
  }
}
