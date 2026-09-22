import { app } from 'electron'
import { join } from 'node:path'
import {
  createDaemonManager,
  resolveDaemonScriptFromCandidates,
  type DaemonStatusInfo,
} from '@codesurf/daemon/manager'
import { DAEMON_PACKAGE_VERSION } from '@codesurf/daemon/paths'
import { CODESURF_HOME } from '../paths'
import { getSecret } from '../secrets'
import { GATEWAY_SECRET_NAME, resolveGatewayApiKey } from '../chat/gateway-tools'

export type { DaemonStatusInfo }

/**
 * Report the @codesurf/daemon package version (not Electron's app version) so
 * we don't fight the codesurf TUI for daemon ownership: any host that pins
 * the same daemon package will agree, and the daemon won't force-restart on
 * the boundary between desktop and TUI sessions. Override with
 * `CODESURF_DAEMON_VERSION_PIN` if you need a different value.
 *
 * Kept for diagnostics: `app.getVersion()` is logged via the daemon process
 * env (`CODESURF_HOST_APP_VERSION`).
 */
function resolveAppVersion(): string {
  const pin = process.env.CODESURF_DAEMON_VERSION_PIN?.trim()
  return pin && pin.length > 0 ? pin : DAEMON_PACKAGE_VERSION
}

function resolveHostAppVersion(): string {
  const version = app.getVersion?.()
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : '0.0.0'
}

function resolveDaemonScriptPath(): string {
  const appPath = app.getAppPath()
  return resolveDaemonScriptFromCandidates([
    // Packaged: bin shipped via electron-builder `files`/`asarUnpack`.
    join(appPath, 'bin', 'codesurfd.mjs'),
    join(appPath, '..', 'app.asar.unpacked', 'bin', 'codesurfd.mjs'),
    // Dev: use the same compatibility launcher from the source tree.
    join(process.cwd(), 'bin', 'codesurfd.mjs'),
  ])
}

const manager = createDaemonManager({
  homeDir: CODESURF_HOME,
  getAppVersion: resolveAppVersion,
  resolveDaemonScriptPath,
  extraEnv: () => {
    // Hand the keychain-stored AI Gateway key to the daemon so daemon-executed
    // gateway jobs work without a separately configured environment.
    //
    // Precedence is resolveGatewayApiKey's (stored secret first), shared with
    // the in-process provider. These two used to disagree, so with both a
    // stored key and an env var the app and the daemon authenticated as
    // different accounts.
    //
    // Note this is captured at SPAWN time, so changing the key requires a
    // daemon restart — see restartDaemonForGatewayKeyChange, called from
    // secrets-ipc when the key is written or cleared.
    const gatewayKey = resolveGatewayApiKey(getSecret(GATEWAY_SECRET_NAME), process.env)
    return {
      CODESURF_HOST_APP_VERSION: resolveHostAppVersion(),
      ...(gatewayKey ? { AI_GATEWAY_API_KEY: gatewayKey } : {}),
    }
  },
})

/**
 * Re-spawn the daemon so it picks up a changed AI Gateway key.
 *
 * extraEnv() is evaluated once per spawn, so without this a running daemon
 * keeps serving gateway jobs with the key it was started with — the user
 * updates it in Settings, the app starts using the new key immediately, and
 * daemon-backed clients silently keep using the old one.
 *
 * No-op when the daemon is not running: the next spawn reads the new value
 * anyway, so there is nothing to do and nothing to start.
 */
export async function restartDaemonForGatewayKeyChange(): Promise<void> {
  const status = await manager.getDaemonStatus()
  if (!status.running) return
  await manager.restartDaemon()
}

export const ensureDaemonRunning = manager.ensureDaemonRunning
export const getDaemonStatus = manager.getDaemonStatus
export const invalidateDaemonCache = manager.invalidateDaemonCache
export const restartDaemon = manager.restartDaemon
export const stopDaemon = manager.stopDaemon
