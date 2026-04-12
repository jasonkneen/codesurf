import { ipcMain, BrowserWindow } from 'electron'
import { bus } from '../event-bus'
import { removeTile as removePeerTile } from '../peer-state'

// Debounce GC — if cleanupTile is called many times in quick succession we don't
// want to hammer global.gc(). Runs ~1s after the last cleanup.
let gcTimer: NodeJS.Timeout | null = null

function scheduleGC(): void {
  if (gcTimer) clearTimeout(gcTimer)
  gcTimer = setTimeout(() => {
    gcTimer = null
    runGC()
  }, 1000)
}

function runGC(): void {
  // Main process — requires electron launched with --js-flags=--expose-gc
  const g = globalThis as unknown as { gc?: () => void }
  if (typeof g.gc === 'function') {
    try {
      g.gc()
    } catch (err) {
      console.warn('[system] main gc() threw:', err)
    }
  }
  // Renderers — request they run gc too (window.gc requires --expose-gc on renderer)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send('system:gc-requested')
    } catch { /* sender dead */ }
  }
}

export function registerSystemIPC(): void {
  ipcMain.handle('system:cleanupTile', (_, tileId: string) => {
    if (!tileId || typeof tileId !== 'string') return { ok: false }
    // 1. Drop all bus history pinned to this tile
    const channelsDropped = bus.dropChannelsMatching(`tile:${tileId}`)
    // 2. Clear peer state (agent state, messages, links)
    removePeerTile(tileId)
    // 3. Schedule a debounced GC
    scheduleGC()
    return { ok: true, channelsDropped }
  })

  ipcMain.handle('system:gc', () => {
    runGC()
    return { ok: true, exposed: typeof (globalThis as { gc?: unknown }).gc === 'function' }
  })

  ipcMain.handle('system:memStats', () => {
    const mem = process.memoryUsage()
    return {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      bus: bus.getStats(),
    }
  })
}
