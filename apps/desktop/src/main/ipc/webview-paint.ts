/**
 * Main-process IPC for guest webview paint throttling.
 * Renderer only has getWebContentsId(); we resolve WebContents here via fromId.
 */

import { ipcMain, webContents } from 'electron'
import { applyWebviewPaintFrameRate } from '../../shared/webview-paint-bridge.ts'

export function registerWebviewPaintIPC(): void {
  ipcMain.handle(
    'webview:setFrameRate',
    (_evt, webContentsId: number, fps: number): { ok: boolean } => {
      const ok = applyWebviewPaintFrameRate(webContentsId, fps, (id) => {
        try {
          return webContents.fromId(id) ?? null
        } catch {
          return null
        }
      })
      return { ok }
    },
  )
}
