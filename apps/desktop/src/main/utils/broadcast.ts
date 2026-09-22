import { BrowserWindow } from 'electron'

/** Send a message to all non-destroyed renderer windows.
 *  Centralised so every broadcast site shares one definition of "live window"
 *  (both window and webContents must not be destroyed) and one place to add
 *  future per-window scoping. */
export function broadcastToRenderer(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      // sender may die between the check and the send; ignore
    }
  }
}
