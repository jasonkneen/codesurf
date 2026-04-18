/**
 * Agent binary detection + persistence.
 *
 * On startup, resolves full paths for claude, codex, opencode.
 * Persists to ~/.contex/agent-paths.json so the packaged app knows where they are.
 * Exports getAgentPath(id) for use by chat.ts and anywhere else.
 */

import { ipcMain } from 'electron'
import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONTEX_HOME } from './paths'

const PATHS_FILE = join(CONTEX_HOME, 'agent-paths.json')

export interface AgentPathEntry {
  path: string | null
  version: string | null
  detectedAt: string
  confirmed: boolean
}

export interface AgentPathsConfig {
  claude: AgentPathEntry
  codex: AgentPathEntry
  opencode: AgentPathEntry
  openclaw: AgentPathEntry
  hermes: AgentPathEntry
  shellPath: string | null
  updatedAt: string
}

// In-memory cache
let cachedPaths: AgentPathsConfig | null = null

/** Get the user's real shell PATH (packaged Electron gets a minimal one) */
function resolveShellPath(): string {
  const isWin = process.platform === 'win32'

  if (!isWin) {
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      // -ilc loads the user's full login profile
      return execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch { /* fall through to fallback */ }
  }

  if (isWin) {
    // On Windows, process.env.PATH is usually already correct
    if (process.env.PATH) return process.env.PATH
    const home = homedir()
    return [
      join(home, 'AppData', 'Roaming', 'npm'),
      join(home, '.bun', 'bin'),
      join(home, 'go', 'bin'),
      join(home, '.cargo', 'bin'),
      'C:\\Program Files\\nodejs',
    ].join(';')
  }

  // Unix fallback
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    `${homedir()}/.bun/bin`,
    `${homedir()}/.npm-global/bin`,
    `${homedir()}/.local/bin`,
    `${homedir()}/.nvm/versions/node`,
    `${homedir()}/go/bin`,
    `${homedir()}/.yarn/bin`,
  ].join(':')
}

// Cache the resolved PATH once
let _shellPath: string | null = null
function getShellPath(): string {
  if (!_shellPath) _shellPath = resolveShellPath()
  return _shellPath
}

/** Simple `which`/`where` using the real shell PATH */
export function whichSync(cmd: string): string | null {
  // Use execFileSync, not execSync — execSync goes through a shell where an
  // unescaped `cmd` could be interpreted (shell-injection surface) and fails
  // if the name contains spaces.
  try {
    const prog = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = execFileSync(prog, [cmd], {
      timeout: 3000,
      encoding: 'utf8',
      env: { ...process.env, PATH: getShellPath() },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (!result || result.includes('not found') || result.includes('Could not find')) return null
    const lines = result.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length === 0) return null
    // `where` on Windows returns all PATH matches. Prefer a native .exe (which
    // Node's spawn() can execute directly) over .cmd/.bat shims or extensionless
    // shell scripts. npm-global installs via Volta create all of these side by
    // side in the same directory, and the shim was winning as "first match".
    if (process.platform === 'win32') {
      const exeMatch = lines.find(line => /\.exe$/i.test(line))
      if (exeMatch) return exeMatch
    }
    return lines[0] || null
  } catch {
    return null
  }
}

/** Check if a file exists and is executable.
 *  POSIX enforces the execute bit via X_OK; Windows has no such concept, so
 *  existence (F_OK) is the best we can ask for there. */
async function isExecutable(filePath: string): Promise<boolean> {
  const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
  try {
    await fs.access(filePath, mode)
    return true
  } catch { /* continue */ }

  // On Windows, try common executable extensions if no extension provided
  if (process.platform === 'win32' && !/\.\w+$/.test(filePath)) {
    for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
      try {
        await fs.access(filePath + ext, fs.constants.F_OK)
        return true
      } catch { /* continue */ }
    }
  }

  return false
}

/** Resolve a path to a spawnable native binary.
 *
 * On Windows we only accept `.exe` — Node's spawn() can't execute `.cmd`
 * or `.bat` shims directly (needs shell:true, which the Claude SDK doesn't
 * set, producing EINVAL). Callers that need a shim should spawn it through
 * a shell themselves; the default detection pipeline persists only paths
 * that real consumers can spawn.
 */
async function resolveExecutablePath(filePath: string): Promise<string | null> {
  if (process.platform === 'win32') {
    const hasExt = /\.\w+$/i.test(filePath)
    if (hasExt) {
      if (!/\.exe$/i.test(filePath)) return null
      try {
        await fs.access(filePath)
        return filePath
      } catch { return null }
    }
    // bare name — probe only for .exe
    const candidate = filePath + '.exe'
    try {
      await fs.access(candidate)
      return candidate
    } catch { return null }
  }

  try {
    await fs.access(filePath)
    return filePath
  } catch { /* continue */ }

  return null
}

/** Walk nvm versions dir to find a binary */
async function findInNvm(cmd: string): Promise<string | null> {
  const nvmBase = join(homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = await fs.readdir(nvmBase)
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const ver of versions) {
      const binPath = join(nvmBase, ver, 'bin', cmd)
      if (await isExecutable(binPath)) return binPath
    }
  } catch { /* nvm not installed */ }
  return null
}

/** Get version string from a binary */
function getVersionSync(binPath: string): string | null {
  try {
    const out = execFileSync(binPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const match = out.match(/[\d]+\.[\d]+[\d.]*/)
    return match ? match[0] : out.trim().split('\n')[0]?.substring(0, 40) || null
  } catch {
    return null
  }
}

// Fallback paths if `which`/`where` fails. On Windows these must be `.exe` —
// `.cmd` shims can't be spawned directly by Node, so resolveExecutablePath
// would reject them anyway.
const isWin = process.platform === 'win32'

function buildFallbackPaths(cmd: string, extras: string[] = []): string[] {
  const home = homedir()
  if (isWin) {
    return [
      join(home, 'AppData', 'Roaming', 'npm', `${cmd}.exe`),
      join(home, '.bun', 'bin', `${cmd}.exe`),
      join(home, '.local', 'bin', `${cmd}.exe`),
      join(home, 'go', 'bin', `${cmd}.exe`),
      join(home, '.cargo', 'bin', `${cmd}.exe`),
      ...extras,
    ]
  }
  return [
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `${home}/.bun/bin/${cmd}`,
    `${home}/.npm-global/bin/${cmd}`,
    `${home}/.local/bin/${cmd}`,
    `${home}/.yarn/bin/${cmd}`,
    ...extras,
  ]
}

const FALLBACK_PATHS: Record<string, string[]> = {
  claude: buildFallbackPaths('claude'),
  codex: buildFallbackPaths('codex'),
  opencode: buildFallbackPaths('opencode', isWin ? [] : [`${homedir()}/go/bin/opencode`]),
  openclaw: buildFallbackPaths('openclaw', isWin ? [] : [`${homedir()}/.cargo/bin/openclaw`]),
  hermes: buildFallbackPaths('hermes', [
    ...(isWin ? [] : [`${homedir()}/.hermes/bin/hermes`]),
    join(homedir(), 'Documents', 'GitHub', 'hermes-agent', isWin ? 'hermes.exe' : 'hermes'),
  ]),
}

/** Detect a single agent binary */
async function detectBinary(agentId: string): Promise<AgentPathEntry> {
  const now = new Date().toISOString()

  // 1. `which` with the real shell PATH — simplest and most reliable
  const found = whichSync(agentId)
  if (found) {
    const version = getVersionSync(found)
    return { path: found, version, detectedAt: now, confirmed: false }
  }

  // 2. Check nvm dirs (common for npm-global installs)
  const nvmPath = await findInNvm(agentId)
  if (nvmPath) {
    const version = getVersionSync(nvmPath)
    return { path: nvmPath, version, detectedAt: now, confirmed: false }
  }

  // 3. Hardcoded fallback paths
  for (const p of FALLBACK_PATHS[agentId] ?? []) {
    const resolved = await resolveExecutablePath(p)
    if (resolved) {
      const version = getVersionSync(resolved)
      return { path: resolved, version, detectedAt: now, confirmed: false }
    }
  }

  return { path: null, version: null, detectedAt: now, confirmed: false }
}

/** Load saved paths from disk */
async function loadSavedPaths(): Promise<AgentPathsConfig | null> {
  try {
    const raw = await fs.readFile(PATHS_FILE, 'utf8')
    return JSON.parse(raw) as AgentPathsConfig
  } catch {
    return null
  }
}

/** Prime in-memory cache from disk without probing binaries or shell PATH */
export async function initializeAgentPathsCache(): Promise<AgentPathsConfig | null> {
  if (cachedPaths) return cachedPaths
  const saved = await loadSavedPaths()
  if (!saved) return null

  // Re-resolve each saved path so stale entries (e.g. a Windows npm shim) get
  // promoted to a spawn-able native binary on the next app launch. Node's
  // spawn() on Windows can only execute a native .exe directly; .cmd/.bat
  // require shell:true, which most SDKs (e.g. Claude) don't set — so if the
  // saved path isn't already an .exe, re-query PATH to look for one.
  let mutated = false
  for (const key of ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const) {
    const entry = saved[key]
    if (!entry?.path) continue

    const resolved = await resolveExecutablePath(entry.path)
    let best = resolved && resolved !== entry.path ? resolved : null

    // On Windows, resolveExecutablePath only returns .exe or null — so the
    // only case where we need to re-query PATH is when it returned null
    // (saved path is a .cmd/.bat shim or no longer exists).
    if (process.platform === 'win32' && !resolved) {
      const fromWhich = whichSync(key)
      if (fromWhich && /\.exe$/i.test(fromWhich)) best = fromWhich
    }

    if (best && best !== entry.path) {
      entry.path = best
      mutated = true
    }
  }

  cachedPaths = saved
  if (mutated) await savePaths(saved).catch(() => { /* best-effort */ })
  return cachedPaths
}

/** Save paths to disk */
async function savePaths(config: AgentPathsConfig): Promise<void> {
  await fs.mkdir(CONTEX_HOME, { recursive: true })
  await fs.writeFile(PATHS_FILE, JSON.stringify(config, null, 2))
  cachedPaths = config
}

/** Run full detection for all agents */
export async function detectAllAgents(): Promise<AgentPathsConfig> {
  console.log('[AgentPaths] Detecting agent binaries...')
  const shellPath = getShellPath()

  const [claude, codex, opencode, openclaw, hermes] = await Promise.all([
    detectBinary('claude'),
    detectBinary('codex'),
    detectBinary('opencode'),
    detectBinary('openclaw'),
    detectBinary('hermes'),
  ])

  // Merge with any previously confirmed paths
  const saved = await loadSavedPaths()

  const merge = (detected: AgentPathEntry, savedEntry?: AgentPathEntry): AgentPathEntry => {
    if (savedEntry?.confirmed && savedEntry.path) {
      return { ...detected, path: savedEntry.path, confirmed: true }
    }
    return detected
  }

  const config: AgentPathsConfig = {
    claude: merge(claude, saved?.claude),
    codex: merge(codex, saved?.codex),
    opencode: merge(opencode, saved?.opencode),
    openclaw: merge(openclaw, saved?.openclaw),
    hermes: merge(hermes, saved?.hermes),
    shellPath,
    updatedAt: new Date().toISOString(),
  }

  // Re-verify confirmed paths still exist
  for (const key of ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const) {
    const entry = config[key]
    if (entry.path && entry.confirmed) {
      const resolved = await resolveExecutablePath(entry.path)
      if (!resolved) {
        console.log(`[AgentPaths] Previously confirmed ${key} at ${entry.path} no longer exists, re-detecting`)
        config[key] = await detectBinary(key)
      } else if (resolved !== entry.path) {
        // Update path if it resolved to a different name (e.g. added .exe)
        entry.path = resolved
      }
    }
  }

  await savePaths(config)

  const found = [
    config.claude.path ? `claude=${config.claude.path}` : null,
    config.codex.path ? `codex=${config.codex.path}` : null,
    config.opencode.path ? `opencode=${config.opencode.path}` : null,
    config.openclaw.path ? `openclaw=${config.openclaw.path}` : null,
    config.hermes.path ? `hermes=${config.hermes.path}` : null,
  ].filter(Boolean).join(', ')
  console.log(`[AgentPaths] Detection complete: ${found || 'none found'}`)

  return config
}

/** Get the resolved path for an agent, or null */
export function getAgentPath(agentId: 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'): string | null {
  return cachedPaths?.[agentId]?.path ?? null
}

/** Get the real shell PATH for spawning subprocesses */
export function getShellEnvPath(): string | null {
  return cachedPaths?.shellPath ?? null
}

/** Get the full config (for renderer) */
export function getAgentPathsConfig(): AgentPathsConfig | null {
  return cachedPaths
}

/** Register IPC handlers */
export function registerAgentPathsIPC(): void {
  ipcMain.handle('agentPaths:get', () => cachedPaths)

  ipcMain.handle('agentPaths:detect', async () => detectAllAgents())

  ipcMain.handle('agentPaths:set', async (_, agentId: string, inputPath: string | null) => {
    if (!cachedPaths) return null
    // Allowlist — cachedPaths also contains shellPath/updatedAt keys, which
    // must never be overwritten via this IPC. Validate before casting so a
    // malicious or buggy caller can't stomp on unrelated config.
    const AGENT_KEYS = ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const
    type AgentKey = typeof AGENT_KEYS[number]
    if (!(AGENT_KEYS as readonly string[]).includes(agentId)) return null
    const key = agentId as AgentKey

    let resolvedPath: string | null = null
    let version: string | null = null
    if (inputPath) {
      // Normalize path separators
      const normalized = inputPath.replace(/\//g, process.platform === 'win32' ? '\\' : '/')
      resolvedPath = await resolveExecutablePath(normalized)
      if (!resolvedPath) {
        return { error: `Not found: ${inputPath}` }
      }
      version = getVersionSync(resolvedPath)
    }

    cachedPaths[key] = {
      path: resolvedPath,
      version,
      detectedAt: new Date().toISOString(),
      confirmed: true,
    }
    cachedPaths.updatedAt = new Date().toISOString()
    await savePaths(cachedPaths)
    return cachedPaths
  })

  ipcMain.handle('agentPaths:needsSetup', () => {
    if (!cachedPaths) return true
    const { claude, codex, opencode, openclaw, hermes } = cachedPaths
    return !claude.confirmed && !codex.confirmed && !opencode.confirmed && !openclaw.confirmed && !hermes.confirmed
  })

  ipcMain.handle('agentPaths:confirmAll', async () => {
    if (!cachedPaths) return null
    for (const key of ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const) {
      cachedPaths[key].confirmed = true
    }
    cachedPaths.updatedAt = new Date().toISOString()
    await savePaths(cachedPaths)
    return cachedPaths
  })
}
