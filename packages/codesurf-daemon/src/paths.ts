import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Default home directory for CodeSurf state. Can be overridden by setting
 * the CODESURF_HOME env var or by passing `homeDir` to `createDaemonManager`.
 */
export const CODESURF_HOME_DIRNAME = '.codesurf'

export function defaultCodesurfHome(): string {
  return process.env.CODESURF_HOME?.trim() || join(homedir(), CODESURF_HOME_DIRNAME)
}

export const CODESURF_HOME = defaultCodesurfHome()

/**
 * Version of the @codesurf/daemon package itself. Hosts (desktop, TUI) should
 * report this string as the daemon's `appVersion` rather than their own
 * package version, so two hosts at different release cadences don't trigger
 * each other's force-restart logic. Override via CODESURF_DAEMON_VERSION_PIN.
 */
export const DAEMON_PACKAGE_VERSION = '0.1.0'
