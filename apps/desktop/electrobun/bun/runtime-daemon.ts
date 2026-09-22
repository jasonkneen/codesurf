import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export type ElectrobunDaemonInfo = {
  pid: number
  port: number
  token: string
  startedAt: string
  protocolVersion: number
  appVersion: string | null
}

export type ElectrobunDaemonPublicInfo = Omit<ElectrobunDaemonInfo, 'token'>

export type ElectrobunDaemonStatus = {
  running: boolean
  info: ElectrobunDaemonPublicInfo | null
  runtime: 'electrobun'
  error?: string
}

type CreateDaemonRuntimeOptions = {
  appVersion?: string | null
  repoRoot?: string | null
  nodeBin?: string | null
  daemonScript?: string | null
  startupTimeoutMs?: number
}

const HEALTH_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 150
const STARTUP_GRACE_MS = 1_200
const LOCK_STALE_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const KILL_TIMEOUT_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function resolveRepoRoot(explicitRoot?: string | null): string | null {
  const candidates = unique([
    explicitRoot ?? '',
    process.env.CODESURF_REPO_ROOT ?? '',
    process.env.INIT_CWD ?? '',
    process.env.PWD ?? '',
    process.cwd(),
  ])
  for (const candidate of candidates) {
    const root = resolve(candidate)
    if (existsSync(join(root, 'bin', 'codesurfd.mjs'))) return root
  }
  return null
}

function processResourcesCandidates(): string[] {
  const cwd = process.cwd()
  const argvMain = typeof process.argv[1] === 'string' ? process.argv[1] : ''
  const argvDir = argvMain ? dirname(argvMain) : ''
  return unique([
    join(cwd, '..', 'Resources', 'app'),
    join(cwd, '..', 'Resources'),
    join(argvDir, 'app'),
    argvDir,
  ]).map(value => resolve(value))
}

function resolveDaemonScriptPath(options: CreateDaemonRuntimeOptions): string {
  const candidates = unique([
    options.daemonScript ?? '',
    process.env.CODESURF_DAEMON_SCRIPT ?? '',
    ...(resolveRepoRoot(options.repoRoot) ? [join(resolveRepoRoot(options.repoRoot)!, 'bin', 'codesurfd.mjs')] : []),
    ...processResourcesCandidates().map(root => join(root, 'bin', 'codesurfd.mjs')),
  ])

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(`Unable to locate codesurfd.mjs. Looked in: ${candidates.join(', ')}`)
}

function parsePidInfo(pidPath: string): ElectrobunDaemonInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as Partial<ElectrobunDaemonInfo> & { version?: number }
    const protocolVersion = typeof parsed.protocolVersion === 'number'
      ? parsed.protocolVersion
      : (typeof parsed.version === 'number' ? parsed.version : null)
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.port !== 'number'
      || typeof parsed.token !== 'string'
      || typeof parsed.startedAt !== 'string'
      || typeof protocolVersion !== 'number'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      startedAt: parsed.startedAt,
      protocolVersion,
      appVersion: typeof parsed.appVersion === 'string' && parsed.appVersion.trim().length > 0
        ? parsed.appVersion.trim()
        : null,
    }
  } catch {
    return null
  }
}

function toPublicInfo(info: ElectrobunDaemonInfo): ElectrobunDaemonPublicInfo {
  return {
    pid: info.pid,
    port: info.port,
    startedAt: info.startedAt,
    protocolVersion: info.protocolVersion,
    appVersion: info.appVersion,
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
    return code === 'EPERM'
  }
}

async function healthcheck(info: ElectrobunDaemonInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(2_000),
      headers: { Authorization: `Bearer ${info.token}` },
    })
    if (!response.ok) return false
    const parsed = await response.json() as { ok?: boolean }
    return parsed.ok === true
  } catch {
    return false
  }
}

function removeFileIfPresent(filePath: string): void {
  try {
    rmSync(filePath, { force: true })
  } catch {
    // ignore cleanup failures
  }
}

function tailLog(logPath: string, lines = 20): string {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-lines)
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return !isProcessAlive(pid)
}

export function createElectrobunDaemonRuntime(homeDir: string, options: CreateDaemonRuntimeOptions = {}) {
  const home = homeDir || join(homedir(), '.codesurf')
  const daemonDir = join(home, 'daemon')
  const pidPath = process.env.CODESURF_DAEMON_PID_PATH ?? join(daemonDir, 'pid.json')
  const logPath = process.env.CODESURF_DAEMON_LOG_PATH ?? join(daemonDir, 'daemon.log')
  const lockPath = join(daemonDir, 'startup.lock')
  const appVersion = String(options.appVersion ?? process.env.CODESURF_APP_VERSION ?? '0.1.0').trim() || '0.1.0'
  const startupTimeoutMs = options.startupTimeoutMs ?? HEALTH_TIMEOUT_MS
  let cachedInfo: ElectrobunDaemonInfo | null = null
  let startupPromise: Promise<ElectrobunDaemonInfo> | null = null

  function ensureDir(): void {
    mkdirSync(daemonDir, { recursive: true })
  }

  function readPidInfo(): ElectrobunDaemonInfo | null {
    return parsePidInfo(pidPath)
  }

  function cleanupStalePid(): void {
    const info = readPidInfo()
    if (!info || !isProcessAlive(info.pid)) removeFileIfPresent(pidPath)
  }

  function lockLooksStale(): boolean {
    try {
      return (Date.now() - statSync(lockPath).mtimeMs) > LOCK_STALE_MS
    } catch {
      return false
    }
  }

  async function waitForReady(): Promise<ElectrobunDaemonInfo> {
    const start = Date.now()
    while ((Date.now() - start) < startupTimeoutMs) {
      const info = readPidInfo()
      if (info && isProcessAlive(info.pid) && await healthcheck(info)) {
        cachedInfo = info
        return info
      }
      await sleep(POLL_INTERVAL_MS)
    }
    const logTail = tailLog(logPath)
    throw new Error(logTail
      ? `CodeSurf daemon did not become healthy in time. Recent daemon logs:\n${logTail}`
      : 'CodeSurf daemon did not become healthy in time')
  }

  async function waitForChildStartupGrace(child: ChildProcess): Promise<void> {
    const exitedEarly = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), STARTUP_GRACE_MS)
      child.once('error', () => {
        clearTimeout(timer)
        finish(true)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        finish(true)
      })
    })
    if (!exitedEarly) return
    const logTail = tailLog(logPath)
    throw new Error(logTail
      ? `CodeSurf daemon exited during startup. Recent daemon logs:\n${logTail}`
      : 'CodeSurf daemon exited during startup')
  }

  function spawnDaemon(): ChildProcess {
    ensureDir()
    const scriptPath = resolveDaemonScriptPath(options)
    const scriptRoot = dirname(dirname(scriptPath))
    const out = openSync(logPath, 'a')
    const nodeBin = options.nodeBin ?? process.env.CODESURF_DAEMON_NODE ?? 'node'
    const child = spawn(nodeBin, [scriptPath], {
      cwd: scriptRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        CODESURF_HOME: home,
        CODESURF_DAEMON_PID_PATH: pidPath,
        CODESURF_APP_VERSION: appVersion,
      },
    })
    child.unref()
    closeSync(out)
    return child
  }

  async function stop(info: ElectrobunDaemonInfo | null): Promise<void> {
    if (!info || !isProcessAlive(info.pid)) {
      removeFileIfPresent(pidPath)
      return
    }
    signalProcess(info.pid, 'SIGTERM')
    let stopped = await waitForExit(info.pid, STOP_TIMEOUT_MS)
    if (!stopped) {
      signalProcess(info.pid, 'SIGKILL')
      stopped = await waitForExit(info.pid, KILL_TIMEOUT_MS)
    }
    if (!stopped) throw new Error(`Timed out stopping CodeSurf daemon PID ${info.pid}`)
    removeFileIfPresent(pidPath)
  }

  async function withStartupLock(work: () => Promise<ElectrobunDaemonInfo>): Promise<ElectrobunDaemonInfo> {
    ensureDir()
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      cleanupStalePid()
      try {
        const fd = openSync(lockPath, 'wx')
        try {
          return await work()
        } finally {
          closeSync(fd)
          removeFileIfPresent(lockPath)
        }
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
        if (code !== 'EEXIST') throw error
        const existing = readPidInfo()
        if (existing && isProcessAlive(existing.pid) && await healthcheck(existing)) {
          cachedInfo = existing
          return existing
        }
        if (lockLooksStale()) {
          removeFileIfPresent(lockPath)
          continue
        }
        await sleep(POLL_INTERVAL_MS)
      }
    }
    throw new Error('Timed out acquiring CodeSurf daemon startup lock')
  }

  async function ensureRunning(options?: { forceRestart?: boolean }): Promise<ElectrobunDaemonInfo> {
    const forceRestart = options?.forceRestart === true
    if (cachedInfo && isProcessAlive(cachedInfo.pid) && await healthcheck(cachedInfo)) {
      if (!forceRestart && (!cachedInfo.appVersion || cachedInfo.appVersion === appVersion)) return cachedInfo
    }
    if (startupPromise) return startupPromise

    startupPromise = (async () => {
      const existing = readPidInfo()
      if (forceRestart) {
        await stop(existing)
        cachedInfo = null
      } else if (
        existing
        && isProcessAlive(existing.pid)
        && await healthcheck(existing)
        && (!existing.appVersion || existing.appVersion === appVersion)
      ) {
        cachedInfo = existing
        return existing
      }

      return await withStartupLock(async () => {
        const lockedExisting = readPidInfo()
        if (
          !forceRestart
          && lockedExisting
          && isProcessAlive(lockedExisting.pid)
          && await healthcheck(lockedExisting)
          && (!lockedExisting.appVersion || lockedExisting.appVersion === appVersion)
        ) {
          cachedInfo = lockedExisting
          return lockedExisting
        }
        if (forceRestart && lockedExisting) {
          await stop(lockedExisting)
          cachedInfo = null
        }
        const child = spawnDaemon()
        await waitForChildStartupGrace(child)
        return await waitForReady()
      })
    })()

    try {
      return await startupPromise
    } finally {
      startupPromise = null
    }
  }

  async function status(): Promise<ElectrobunDaemonStatus> {
    const info = readPidInfo()
    if (!info || !isProcessAlive(info.pid) || !(await healthcheck(info))) {
      cachedInfo = null
      return { running: false, info: null, runtime: 'electrobun' }
    }
    cachedInfo = info
    return { running: true, info: toPublicInfo(info), runtime: 'electrobun' }
  }

  async function restart(): Promise<ElectrobunDaemonInfo> {
    cachedInfo = null
    return await ensureRunning({ forceRestart: true })
  }

  async function request<T>(path: string, requestOptions?: { method?: 'GET' | 'POST' | 'DELETE', body?: unknown }): Promise<T> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info = await ensureRunning()
      try {
        const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
          method: requestOptions?.method ?? (requestOptions?.body == null ? 'GET' : 'POST'),
          headers: {
            Authorization: `Bearer ${info.token}`,
            ...(requestOptions?.body == null ? {} : { 'Content-Type': 'application/json' }),
          },
          body: requestOptions?.body == null ? undefined : JSON.stringify(requestOptions.body),
          signal: AbortSignal.timeout(5_000),
        })
        if (!response.ok) {
          const text = await response.text()
          lastError = new Error(text || `Daemon request failed: ${response.status}`)
          cachedInfo = null
          if (attempt === 0 && [401, 408, 502, 503, 504].includes(response.status)) continue
          throw lastError
        }
        return await response.json() as T
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        cachedInfo = null
        if (attempt === 0) continue
        throw lastError
      }
    }
    throw (lastError ?? new Error('Daemon request failed'))
  }

  return {
    pidPath,
    logPath,
    resolveDaemonScriptPath: () => resolveDaemonScriptPath(options),
    ensureRunning,
    status,
    restart,
    request,
  }
}

export function summarizeDaemonDashboard(dashboard: any, status: ElectrobunDaemonStatus) {
  return {
    ...status,
    jobs: dashboard?.summary
      ? {
          total: dashboard.summary.total ?? 0,
          active: dashboard.summary.active ?? 0,
          backgroundActive: dashboard.summary.backgroundActive ?? 0,
          completed: dashboard.summary.completed ?? 0,
          failed: dashboard.summary.failed ?? 0,
          cancelled: dashboard.summary.cancelled ?? 0,
          other: dashboard.summary.other ?? 0,
          recent: Array.isArray(dashboard.jobs) ? dashboard.jobs.slice(0, 20) : [],
        }
      : { total: 0, active: 0, backgroundActive: 0, completed: 0, failed: 0, cancelled: 0, other: 0, recent: [] },
    dreaming: dashboard?.dreaming ?? null,
  }
}

export function builtInDaemonHosts(): Array<Record<string, unknown>> {
  return [
    {
      id: 'electrobun-runtime',
      type: 'runtime',
      label: 'Electrobun Runtime',
      enabled: true,
    },
    {
      id: 'local-daemon',
      type: 'local-daemon',
      label: 'Local daemon',
      enabled: true,
      url: 'http://127.0.0.1',
      authToken: null,
    },
  ]
}

export function sanitizeDaemonStatusError(error: unknown): ElectrobunDaemonStatus {
  return {
    running: false,
    info: null,
    runtime: 'electrobun',
    error: error instanceof Error ? error.message : String(error),
  }
}
