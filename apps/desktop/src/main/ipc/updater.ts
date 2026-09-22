import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

export function registerUpdaterIPC(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      const info = result?.updateInfo
      const updateAvailable = !!info && info.version !== app.getVersion()
      return {
        ok: true,
        currentVersion: app.getVersion(),
        status: updateAvailable ? 'update-available' : 'up-to-date',
        updateAvailable,
        updateInfo: info ? {
          version: info.version,
          releaseName: info.releaseName,
          releaseDate: info.releaseDate,
        } : undefined,
      }
    } catch (error) {
      return {
        ok: false,
        currentVersion: app.getVersion(),
        status: error instanceof Error ? error.message : 'update-check-failed',
        updateAvailable: false,
      }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true, status: 'downloaded' }
    } catch (error) {
      return { ok: false, status: error instanceof Error ? error.message : 'download-failed' }
    }
  })

  ipcMain.handle('updater:quitAndInstall', async () => {
    setImmediate(() => autoUpdater.quitAndInstall())
    return { ok: true }
  })
}
