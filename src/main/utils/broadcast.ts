import { BrowserWindow } from 'electron'

/** Send a message to all non-destroyed renderer windows. */
export function broadcastToRenderer(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
