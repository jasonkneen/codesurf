import { ipcMain } from 'electron'
import {
  listProfiles,
  syncCookiesToPartition,
  getBookmarks,
  searchHistory,
  clearCachedPassword,
} from '../chrome-sync'
import { readSettingsSync } from './workspace'

let lastSync: number | null = null

export function registerChromeSyncIPC(): void {
  ipcMain.handle('chromeSync:listProfiles', () => {
    return listProfiles()
  })

  ipcMain.handle('chromeSync:getStatus', (_event, settings: { enabled: boolean; profileDir: string | null }) => {
    return {
      enabled: settings.enabled,
      profileDir: settings.profileDir,
      lastSync,
      profiles: listProfiles(),
    }
  })

  ipcMain.handle('chromeSync:syncCookies', async (_event, profileDir: string, partition: string) => {
    // risk-06: cookie injection is default-DENY. Without an approved-domains
    // allowlist syncCookiesToPartition injects nothing (no allowUnscoped here).
    // The target partition must be a real session partition string.
    if (typeof partition !== 'string' || !/^(persist:)?[\w.:-]+$/.test(partition)) {
      return { count: 0, errors: ['Invalid session partition.'] }
    }
    try {
      const approvedDomains = readSettingsSync().chromeSyncApprovedDomains ?? []
      const result = await syncCookiesToPartition(profileDir, partition, { approvedDomains })
      if (result.errors.length === 0) lastSync = Date.now()
      return result
    } catch (e) {
      return { count: 0, errors: [e instanceof Error ? e.message : String(e)] }
    } finally {
      // Don't hold the decryption key in memory longer than the sync duration
      clearCachedPassword()
    }
  })

  ipcMain.handle('chromeSync:getBookmarks', (_event, profileDir: string) => {
    try {
      return getBookmarks(profileDir)
    } catch {
      return []
    }
  })

  ipcMain.handle('chromeSync:searchHistory', async (_event, profileDir: string, query: string, limit?: number) => {
    try {
      return await searchHistory(profileDir, query, limit)
    } catch {
      return []
    }
  })
}
