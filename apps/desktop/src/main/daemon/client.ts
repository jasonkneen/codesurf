import { createDaemonClient, type DaemonClient } from '@codesurf/daemon/client'
import type { AppSettings } from '../../shared/types'
import {
  ensureDaemonRunning,
  getDaemonStatus,
  invalidateDaemonCache,
} from './manager'

const baseClient: DaemonClient = createDaemonClient({
  ensureRunning: ensureDaemonRunning,
  getStatus: getDaemonStatus,
  invalidate: invalidateDaemonCache,
})

/**
 * Desktop-side daemon client. Wraps the package client so the settings methods
 * return the desktop's full `AppSettings` type without callers having to pass
 * the generic at every call site.
 */
export const daemonClient = {
  ...baseClient,
  getSettings(): Promise<AppSettings> {
    return baseClient.getSettings<AppSettings>()
  },
  setSettings(settings: AppSettings): Promise<AppSettings> {
    return baseClient.setSettings<AppSettings>(settings)
  },
  setRawSettingsJson(json: string): Promise<{ ok: boolean; error?: string; settings?: AppSettings }> {
    return baseClient.setRawSettingsJson<AppSettings>(json)
  },
}
