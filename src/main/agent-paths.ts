/**
 * Agent binary detection + persistence.
 *
 * On startup, resolves full paths for claude, codex, opencode.
 * Persists to ~/.contex/agent-paths.json so the packaged app knows where they are.
 * Exports getAgentPath(id) for use by chat.ts and anywhere else.
 */

import { ipcMain } from 'electron'
import { execFileSync, execSync } from 'child_process'
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
  shellPath: string | null
  updatedAt: string
}

// In-memory cache
let cachedPaths: AgentPathsConfig | null = null

/** Get the user's real shell PATH (packaged Electron gets a minimal one) */
function resolveShellPath(): string {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // -ilc loads the user's full login profile
    return execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    // Assemble a reasonable fallback
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
}

// Cache the resolved PATH once
let _shellPath: string | null = null
function getShellPath(): string {
  if (!_shellPath) _shellPath = resolveShellPath()
  return _shellPath
}

/** Simple `which` using the real shell PATH */
function whichSync(cmd: string): string | null {
  try {
    const result = execSync(`which ${cmd}`, {
      timeout: 3000,
      encoding: 'utf8',
      env: { ...process.env, PATH: getShellPath() },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result && !result.includes('not found') ? result : null
  } catch {
    return null
  }
}

/** Check if a file exists and is executable */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await fs.access(path, 0o1) // X_OK
    return true
  } catch {
    return false
  }
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

// Fallback paths if `which` fails
const FALLBACK_PATHS: Record<string, string[]> = {
  claude: [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${homedir()}/.bun/bin/claude`,
    `${homedir()}/.npm-global/bin/claude`,
    `${homedir()}/.local/bin/claude`,
    `${homedir()}/.yarn/bin/claude`,
  ],
  codex: [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    `${homedir()}/.bun/bin/codex`,
    `${homedir()}/.npm-global/bin/codex`,
    `${homedir()}/.local/bin/codex`,
    `${homedir()}/.yarn/bin/codex`,
  ],
  opencode: [
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    `${homedir()}/.bun/bin/opencode`,
    `${homedir()}/go/bin/opencode`,
    `${homedir()}/.local/bin/opencode`,
  ],
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
    if (await isExecutable(p)) {
      const version = getVersionSync(p)
      return { path: p, version, detectedAt: now, confirmed: false }
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

  const [claude, codex, opencode] = await Promise.all([
    detectBinary('claude'),
    detectBinary('codex'),
    detectBinary('opencode'),
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
    shellPath,
    updatedAt: new Date().toISOString(),
  }

  // Re-verify confirmed paths still exist
  for (const key of ['claude', 'codex', 'opencode'] as const) {
    const entry = config[key]
    if (entry.path && entry.confirmed) {
      if (!(await isExecutable(entry.path))) {
        console.log(`[AgentPaths] Previously confirmed ${key} at ${entry.path} no longer exists, re-detecting`)
        config[key] = await detectBinary(key)
      }
    }
  }

  await savePaths(config)

  const found = [
    config.claude.path ? `claude=${config.claude.path}` : null,
    config.codex.path ? `codex=${config.codex.path}` : null,
    config.opencode.path ? `opencode=${config.opencode.path}` : null,
  ].filter(Boolean).join(', ')
  console.log(`[AgentPaths] Detection complete: ${found || 'none found'}`)

  return config
}

/** Get the resolved path for an agent, or null */
export function getAgentPath(agentId: 'claude' | 'codex' | 'opencode'): string | null {
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

  ipcMain.handle('agentPaths:set', async (_, agentId: string, path: string | null) => {
    if (!cachedPaths) return null
    const key = agentId as 'claude' | 'codex' | 'opencode'
    if (!(key in cachedPaths)) return null

    let version: string | null = null
    if (path) {
      if (!(await isExecutable(path))) {
        return { error: `Not executable: ${path}` }
      }
      version = getVersionSync(path)
    }

    cachedPaths[key] = {
      path,
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
    const { claude, codex, opencode } = cachedPaths
    return !claude.confirmed && !codex.confirmed && !opencode.confirmed
  })

  ipcMain.handle('agentPaths:confirmAll', async () => {
    if (!cachedPaths) return null
    for (const key of ['claude', 'codex', 'opencode'] as const) {
      cachedPaths[key].confirmed = true
    }
    cachedPaths.updatedAt = new Date().toISOString()
    await savePaths(cachedPaths)
    return cachedPaths
  })
}
