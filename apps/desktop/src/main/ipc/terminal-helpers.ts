import { homedir } from 'os'
import { join } from 'path'
import { CODESURF_HOME } from '../paths.ts'

// --- Security: binary allowlist for pty spawn (SEC-04) ---
export const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh',
  '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
  '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
])

// Windows shells
if (process.platform === 'win32') {
  ALLOWED_SHELLS.add('powershell.exe')
  ALLOWED_SHELLS.add('pwsh.exe')
  ALLOWED_SHELLS.add('cmd.exe')
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  ALLOWED_SHELLS.add(`${sysRoot}\\System32\\cmd.exe`)
  ALLOWED_SHELLS.add(`${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
  // Add pwsh if installed
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  ALLOWED_SHELLS.add(`${programFiles}\\PowerShell\\7\\pwsh.exe`)
}

// Also allow the user's default shell
const userShell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined)
if (userShell) ALLOWED_SHELLS.add(userShell)

// Known agent CLIs that are allowed to be spawned directly
export const ALLOWED_AGENT_BINS = ['claude', 'codex', 'aider', 'opencode', 'openclaw', 'hermes', 'pi']

export function isAllowedBinary(bin: string): boolean {
  // Allow known shells
  if (ALLOWED_SHELLS.has(bin)) return true
  // Allow known agent CLIs (matched by basename, handle both / and \ separators,
  // strip any Windows shim extension so .exe / .cmd / .bat / .ps1 all match)
  const base = (bin.split(/[/\\]/).pop() || '').replace(/\.(exe|cmd|bat|ps1)$/i, '')
  if (ALLOWED_AGENT_BINS.includes(base)) return true
  return false
}

/**
 * Return true when a new terminal request selects a different provider argv.
 * An omitted binary is a legacy reconnect request and intentionally preserves
 * the existing PTY instead of replacing a provider session with a shell.
 */
export function terminalLaunchChanged(
  existing: { launchBin?: string; launchArgs?: readonly string[] },
  requestedLaunchBin?: string,
  requestedLaunchArgs?: readonly string[],
): boolean {
  if (requestedLaunchBin === undefined) return false
  const existingArgs = existing.launchArgs ?? []
  const requestedArgs = requestedLaunchArgs ?? []
  return existing.launchBin !== requestedLaunchBin
    || existingArgs.length !== requestedArgs.length
    || existingArgs.some((value, index) => value !== requestedArgs[index])
}

export function expandHome(arg: string): string {
  if (!arg.startsWith('~')) return arg
  const home = homedir()
  if (arg === '~') return home

  // Resolve legacy ~/.contex/ and current ~/.codesurf/ paths to CODESURF_HOME.
  if (arg.startsWith('~/.contex/')) {
    return join(CODESURF_HOME, arg.slice('~/.contex/'.length))
  }
  if (arg.startsWith('~\\.contex\\')) {
    return join(CODESURF_HOME, arg.slice('~\\.contex\\'.length))
  }
  if (arg.startsWith('~/.codesurf/')) {
    return join(CODESURF_HOME, arg.slice('~/.codesurf/'.length))
  }
  if (arg.startsWith('~\\.codesurf\\')) {
    return join(CODESURF_HOME, arg.slice('~\\.codesurf\\'.length))
  }
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return join(home, arg.slice(2))
  return arg
}

// Build a sanitized spawn environment — keep essential vars, strip known secrets.
// This prevents leaking API keys and tokens from the Electron main process to
// every spawned terminal and agent subprocess.
export const SPAWN_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'EDITOR', 'VISUAL',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'NODE_PATH', 'NVM_DIR', 'NVM_BIN', 'FNM_DIR', 'VOLTA_HOME',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'SSH_AUTH_SOCK', 'GPG_AGENT_INFO',
  // Platform essentials
  ...(process.platform === 'win32' ? [
    'SystemRoot', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)',
    'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERNAME', 'COMPUTERNAME',
    'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'WINDIR',
  ] : []),
])
export const SPAWN_ENV_DENYLIST_RE = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_CREDENTIALS)$/i

export function buildSafeSpawnEnv(
  extra: Record<string, string> = {},
  sourceEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue
    if (SPAWN_ENV_ALLOWLIST.has(key) && !SPAWN_ENV_DENYLIST_RE.test(key)) {
      env[key] = value
    }
  }
  return { ...env, ...extra }
}

export const MANAGED_LOCAL_PROXY_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
])

export const DEFAULT_MANAGED_LOCAL_PROXY_PORT = 1337
export const MANAGED_LOCAL_PROXY_MODE_ENV = 'CODESURF_MANAGED_LOCAL_PROXY_MODE'
export const MANAGED_LOCAL_PROXY_PORT_ERROR = 'Local proxy port must be an integer between 1 and 65535'

export type ManagedLocalProxyMode = 'disabled' | 'enabled'

export interface ManagedLocalProxyProcessState {
  mode: ManagedLocalProxyMode
  token: string | null
}

export interface ManagedLocalProxySessionState {
  eligible: boolean
  desired: ManagedLocalProxyProcessState
  actual: ManagedLocalProxyProcessState
}

export interface ManagedLocalProxyReconciliation {
  action: 'replace' | 'reuse'
  state: ManagedLocalProxySessionState
}

export function isValidManagedLocalProxyPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= 65_535
}

export function resolveManagedLocalProxyPort(value: unknown): number | null {
  return isValidManagedLocalProxyPort(value) ? value : null
}

export function resolveReportedManagedLocalProxyPort(
  runtimePort: unknown,
  configuredPort: unknown,
): number {
  return resolveManagedLocalProxyPort(runtimePort)
    ?? resolveManagedLocalProxyPort(configuredPort)
    ?? DEFAULT_MANAGED_LOCAL_PROXY_PORT
}

export function managedLocalProxyProcessState(
  mode: ManagedLocalProxyMode,
  token: string | null = null,
): ManagedLocalProxyProcessState {
  return {
    mode,
    token: mode === 'enabled' ? token : null,
  }
}

export interface ManagedLocalProxyEnvironmentEvidence {
  mode?: string | null
  baseUrl?: string | null
  token?: string | null
}

export function hasManagedLocalProxyEnvironmentEvidence(
  environment: ManagedLocalProxyEnvironmentEvidence,
): boolean {
  return environment.mode === 'enabled'
    || environment.mode === 'disabled'
    || Boolean(environment.baseUrl?.trim())
    || Boolean(environment.token?.trim())
}

export function inferManagedLocalProxyProcessState(
  environment: ManagedLocalProxyEnvironmentEvidence,
): ManagedLocalProxyProcessState {
  const token = environment.token?.trim() || null
  const enabled = environment.mode === 'enabled'
    || Boolean(environment.baseUrl?.trim())
    || token !== null
  return managedLocalProxyProcessState(
    enabled ? 'enabled' : 'disabled',
    token,
  )
}

export function reconcileManagedLocalProxySession(
  current: ManagedLocalProxySessionState,
  desired: ManagedLocalProxyProcessState,
): ManagedLocalProxyReconciliation {
  const modeChanged = current.actual.mode !== desired.mode
  const enabledTokenChanged = desired.mode === 'enabled'
    && current.actual.token !== desired.token
  return {
    action: current.eligible && (modeChanged || enabledTokenChanged)
      ? 'replace'
      : 'reuse',
    state: {
      ...current,
      desired,
    },
  }
}

export function shouldForwardTmuxEnvironment(key: string): boolean {
  return key.startsWith('CODESURF_')
    || key.startsWith('COLLAB_')
    || key === 'CARD_ID'
    || key === 'LANG'
    || key === 'LC_ALL'
    || key === 'LC_CTYPE'
    || MANAGED_LOCAL_PROXY_ENV_KEYS.has(key)
}

interface ManagedLocalProxySettings {
  localProxyEnabled?: boolean
  localProxyPort?: number
}

interface ManagedLocalProxyStartResult {
  ok: boolean
  port?: number
  message?: string
}

interface ManagedLocalProxyStatus {
  running: boolean
  port: number
  token: string | null
}

export async function resolveManagedLocalProxySpawnEnvironment(
  settings: ManagedLocalProxySettings,
  runtime: {
    ensureRunning: (port?: number) => Promise<ManagedLocalProxyStartResult>
    getStatus: () => ManagedLocalProxyStatus
  },
): Promise<{ env: Record<string, string>; token: string } | null> {
  if (!settings.localProxyEnabled) return null
  const configuredPort = settings.localProxyPort ?? DEFAULT_MANAGED_LOCAL_PROXY_PORT
  const port = resolveManagedLocalProxyPort(configuredPort)
  if (port === null) throw new Error(MANAGED_LOCAL_PROXY_PORT_ERROR)
  const started = await runtime.ensureRunning(port)
  if (!started.ok) {
    throw new Error(started.message || 'Failed to start the managed local proxy')
  }
  const status = runtime.getStatus()
  if (
    !status.running
    || !status.token
    || !isValidManagedLocalProxyPort(status.port)
  ) {
    throw new Error('The managed local proxy is not running')
  }
  return {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${status.port}/v1`,
      ANTHROPIC_AUTH_TOKEN: status.token,
    },
    token: status.token,
  }
}
