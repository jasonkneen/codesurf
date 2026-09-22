/**
 * Install multi-target host bridge before React mounts.
 *
 * - Electron: no-op (preload already exposed window.electron)
 * - Native / Web: install daemon-backed facade + platform markers
 */

import { detectPlatform, type CodesurfPlatform } from './detect'
import { defaultCapabilitiesFor } from './capabilities'
import { createDaemonBackedElectronApi } from './daemonBridge'
import { resolveHostBase } from './hostConfig'
import { hydrateNativeRuntimeConfig } from './nativeRuntimeConfig'
import { isTerminalTransportAvailable } from './terminalTransport'

export interface InstallResult {
  platform: CodesurfPlatform
  hostBase: string
  installedBridge: boolean
}

export async function installHostBridge(): Promise<InstallResult> {
  const platform = detectPlatform()
  // Native sidecars inject per-launch host and terminal capabilities through a
  // bridge command. This must happen before resolveHostBase()/hostFetch use.
  if (platform === 'native') await hydrateNativeRuntimeConfig()
  const hostBase = resolveHostBase()

  const w = window as Window & {
    electron?: typeof window.electron & { __codesurfHostKind?: string }
    __CODESURF_PLATFORM__?: CodesurfPlatform
    __CODESURF_HOST__?: string
    __CODESURF_CAPABILITIES__?: Record<string, boolean>
  }

  w.__CODESURF_PLATFORM__ = platform
  if (hostBase) w.__CODESURF_HOST__ = hostBase

  if (platform === 'electron') {
    // Publish full capability matrix even when preload owns the bridge so
    // feature gates can use one API across all three hosts.
    w.__CODESURF_CAPABILITIES__ = defaultCapabilitiesFor('electron')
    return { platform, hostBase, installedBridge: false }
  }

  // Never clobber a real preload bridge
  if (w.electron) {
    if (w.electron.__codesurfHostKind === 'electrobun') {
      w.__CODESURF_PLATFORM__ = 'native'
      w.__CODESURF_CAPABILITIES__ = defaultCapabilitiesFor('native', {
        terminalAvailable: isTerminalTransportAvailable(),
      })
      return { platform: 'native', hostBase, installedBridge: false }
    }
    w.__CODESURF_PLATFORM__ = 'electron'
    w.__CODESURF_CAPABILITIES__ = defaultCapabilitiesFor('electron')
    return { platform: 'electron', hostBase, installedBridge: false }
  }

  w.electron = createDaemonBackedElectronApi()
  w.__CODESURF_CAPABILITIES__ = defaultCapabilitiesFor(platform, {
    terminalAvailable: isTerminalTransportAvailable(),
  })

  // Warm host / daemon connectivity (non-fatal)
  try {
    const healthUrl = hostBase ? `${hostBase}/host/health` : '/host/health'
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.warn('[codesurf-platform] web-host health check failed', res.status)
    }
  } catch (err) {
    console.warn(
      '[codesurf-platform] web-host unreachable — start with `npm run web:dev` or `npm run desktop:dev`',
      err,
    )
  }

  console.info(`[codesurf-platform] running as ${platform} (host=${hostBase || 'same-origin'})`)
  return { platform, hostBase, installedBridge: true }
}
