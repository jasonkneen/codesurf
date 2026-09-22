import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface DaemonStatusInfo {
  pid: number
  port: number
  token: string
  startedAt: string
  protocolVersion: number
  appVersion: string | null
}

export interface DaemonManagerConfig {
  /**
   * Root directory for daemon state (`pid.json`, `daemon.log`, `startup.lock`).
   * Typically `~/.codesurf`. Use `defaultCodesurfHome()` from `./paths`.
   */
  homeDir: string
  /**
   * Returns the host application's version string. Forwarded to the daemon
   * via the `CODESURF_APP_VERSION` env var so the manager can detect drift
   * and force-restart if the host upgrades.
   */
  getAppVersion: () => string
  /**
   * Locates the absolute path to `codesurfd.mjs` to spawn. Implementations
   * should check release-bundled paths first (e.g. inside `app.asar.unpacked`
   * or `node_modules/@codesurf/daemon/bin`) and fall back to a dev path.
   * Throws if no candidate is found.
   */
  resolveDaemonScriptPath: () => string
  /**
   * Optional: extra env vars to pass to the spawned daemon. Merged on top of
   * `process.env` and the manager's own additions (CODESURF_HOME, etc.).
   */
  extraEnv?: () => NodeJS.ProcessEnv
  /**
   * Optional: how long to wait for the daemon's HTTP socket to come up.
   * Default 15s.
   */
  healthTimeoutMs?: number
}

export interface DaemonManagerRuntime {
  /** Test seam for daemon health requests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Test seam for detached child creation. Defaults to `node:child_process.spawn`. */
  spawn?: typeof spawn
  /** Test seam for process liveness checks and TERM/KILL delivery. */
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean
  /** Test seam that bypasses the real startup grace timer. */
  waitForChildStartupGrace?: (child: ChildProcess) => Promise<void>
  /** Test seam for the bounded TERM/KILL wait without a wall-clock delay. */
  waitForPidExit?: (pid: number, timeoutMs: number) => Promise<boolean>
}

export interface DaemonManager {
  ensureDaemonRunning: (options?: { forceRestart?: boolean }) => Promise<DaemonStatusInfo>
  getDaemonStatus: () => Promise<{ running: boolean; info: DaemonStatusInfo | null }>
  invalidateDaemonCache: () => void
  restartDaemon: () => Promise<DaemonStatusInfo>
  stopDaemon: () => Promise<void>
}

const DAEMON_STARTUP_GRACE_MS = 1_200
const DAEMON_POLL_INTERVAL_MS = 150
const DAEMON_LOCK_STALE_MS = 30_000
const DAEMON_STOP_TIMEOUT_MS = 5_000
const DAEMON_KILL_TIMEOUT_MS = 2_000

/**
 * Creates a singleton-style daemon supervisor for `codesurfd`. Intended to be
 * instantiated once per host process (Electron main, codesurf TUI, etc.) and
 * shared across all callers in that process.
 */
export function createDaemonManager(
  config: DaemonManagerConfig,
  runtime: DaemonManagerRuntime = {},
): DaemonManager {
  const healthTimeoutMs = config.healthTimeoutMs ?? 15_000
  // Resolved per call, not captured: a manager is created once per home and
  // outlives any host that swaps `globalThis.fetch` afterwards (instrumentation,
  // a proxy, a test stub). Binding it here made the health check reach past
  // every such replacement to the fetch that existed at construction time.
  const resolveFetch = (): typeof globalThis.fetch => runtime.fetch ?? globalThis.fetch
  const spawnImpl = runtime.spawn ?? spawn
  const killImpl = runtime.kill ?? ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal))
  const DAEMON_DIR = join(config.homeDir, 'daemon')
  const DAEMON_PID_PATH = join(DAEMON_DIR, 'pid.json')
  const DAEMON_LOG_PATH = join(DAEMON_DIR, 'daemon.log')
  const DAEMON_LOCK_PATH = join(DAEMON_DIR, 'startup.lock')

  let cachedInfo: DaemonStatusInfo | null = null
  let startupPromise: Promise<DaemonStatusInfo> | null = null
  let startupForcesRestart = false
  let queuedForceRestartPromise: Promise<DaemonStatusInfo> | null = null

  function ensureDaemonDir(): void {
    mkdirSync(DAEMON_DIR, { recursive: true })
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function resolveAppVersion(): string {
    const version = config.getAppVersion()
    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : '0.0.0'
  }

  function readPidInfo(): DaemonStatusInfo | null {
    try {
      const parsed = JSON.parse(readFileSync(DAEMON_PID_PATH, 'utf8')) as Partial<DaemonStatusInfo> & {
        version?: number
        protocolVersion?: number
        appVersion?: string | null
      }
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

  function isProcessAlive(pid: number): boolean {
    try {
      killImpl(pid, 0)
      return true
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
      return code === 'EPERM'
    }
  }

  function refersToSameDaemon(
    first: DaemonStatusInfo | null,
    second: DaemonStatusInfo | null,
  ): boolean {
    return Boolean(
      first
      && second
      && first.pid === second.pid
      && first.port === second.port
      && first.token === second.token
      && first.startedAt === second.startedAt,
    )
  }

  async function readAuthenticatedDaemonHealth(
    info: DaemonStatusInfo,
  ): Promise<{ shuttingDown: boolean } | null> {
    try {
      const response = await resolveFetch()(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(2_000),
        headers: {
          Authorization: `Bearer ${info.token}`,
        },
      })
      if (!response.ok) return null
      const parsed = await response.json() as {
        ok?: boolean
        shuttingDown?: boolean
        pid?: number
        startedAt?: string
      }
      const identityMatches = (
        parsed.ok === true
        && parsed.pid === info.pid
        && parsed.startedAt === info.startedAt
      )
      return identityMatches
        ? { shuttingDown: parsed.shuttingDown === true }
        : null
    } catch {
      return null
    }
  }

  async function healthcheck(info: DaemonStatusInfo): Promise<boolean> {
    const health = await readAuthenticatedDaemonHealth(info)
    return health !== null && !health.shuttingDown
  }

  function clearDaemonCache(): void {
    cachedInfo = null
  }

  function removeFileIfPresent(filePath: string): void {
    try {
      rmSync(filePath, { force: true })
    } catch {
      // ignore
    }
  }

  function cleanupStalePidFile(): void {
    const info = readPidInfo()
    if (!info || !isProcessAlive(info.pid)) {
      removeFileIfPresent(DAEMON_PID_PATH)
    }
  }

  function tailDaemonLog(lines = 20): string {
    try {
      const content = readFileSync(DAEMON_LOG_PATH, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-lines)
        .join('\n')
      return content.trim()
    } catch {
      return ''
    }
  }

  function lockLooksStale(): boolean {
    try {
      return (Date.now() - statSync(DAEMON_LOCK_PATH).mtimeMs) > DAEMON_LOCK_STALE_MS
    } catch {
      return false
    }
  }

  async function waitForDaemonReady(): Promise<DaemonStatusInfo> {
    const start = Date.now()
    while ((Date.now() - start) < healthTimeoutMs) {
      const info = readPidInfo()
      if (info && isProcessAlive(info.pid) && await healthcheck(info)) {
        cachedInfo = info
        return info
      }
      await sleep(DAEMON_POLL_INTERVAL_MS)
    }
    const recentLogs = tailDaemonLog()
    throw new Error(
      recentLogs
        ? `CodeSurf daemon did not become healthy in time.\n\nRecent daemon logs:\n${recentLogs}`
        : 'CodeSurf daemon did not become healthy in time',
    )
  }

  async function waitForChildStartupGrace(child: ChildProcess): Promise<void> {
    if (runtime.waitForChildStartupGrace) {
      await runtime.waitForChildStartupGrace(child)
      return
    }

    const exitedEarly = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const timer = setTimeout(() => finish(false), DAEMON_STARTUP_GRACE_MS)
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

    const recentLogs = tailDaemonLog()
    throw new Error(
      recentLogs
        ? `CodeSurf daemon exited during startup.\n\nRecent daemon logs:\n${recentLogs}`
        : 'CodeSurf daemon exited during startup',
    )
  }

  function spawnDaemonProcess(): ChildProcess {
    ensureDaemonDir()
    const out = openSync(DAEMON_LOG_PATH, 'a')
    const daemonScriptPath = config.resolveDaemonScriptPath()
    if (!existsSync(daemonScriptPath)) {
      throw new Error(`Resolved daemon script path does not exist: ${daemonScriptPath}`)
    }
    const child = spawnImpl(process.execPath, [daemonScriptPath], {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        ...(config.extraEnv ? config.extraEnv() : {}),
        // ELECTRON_RUN_AS_NODE is harmless outside Electron; required when the
        // host process is the Electron main bundle so the spawned interpreter
        // behaves as plain Node.
        ELECTRON_RUN_AS_NODE: '1',
        CODESURF_HOME: config.homeDir,
        CODESURF_DAEMON_PID_PATH: DAEMON_PID_PATH,
        CODESURF_APP_VERSION: resolveAppVersion(),
      },
    })
    child.unref()
    closeSync(out)
    return child
  }

  async function withStartupLock(
    work: () => Promise<DaemonStatusInfo>,
    canReuseExisting: (info: DaemonStatusInfo) => boolean,
  ): Promise<DaemonStatusInfo> {
    ensureDaemonDir()
    const deadline = Date.now() + healthTimeoutMs

    while (Date.now() < deadline) {
      cleanupStalePidFile()
      try {
        const fd = openSync(DAEMON_LOCK_PATH, 'wx')
        try {
          return await work()
        } finally {
          closeSync(fd)
          removeFileIfPresent(DAEMON_LOCK_PATH)
        }
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
        if (code !== 'EEXIST') throw error

        const existing = readPidInfo()
        if (
          existing
          && canReuseExisting(existing)
          && isProcessAlive(existing.pid)
          && await healthcheck(existing)
        ) {
          cachedInfo = existing
          return existing
        }

        if (lockLooksStale()) {
          removeFileIfPresent(DAEMON_LOCK_PATH)
          continue
        }

        await sleep(DAEMON_POLL_INTERVAL_MS)
      }
    }

    throw new Error('Timed out acquiring CodeSurf daemon startup lock')
  }

  function signalProcessSafely(pid: number, signal: NodeJS.Signals): boolean {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
    try {
      killImpl(pid, signal)
      return true
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
      if (code === 'ESRCH') return false
      if (code === 'EPERM') return true
      throw error
    }
  }

  function signalProcessGroupSafely(pid: number, signal: NodeJS.Signals): boolean {
    if (process.platform === 'win32') {
      return signalProcessSafely(pid, signal)
    }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
    try {
      killImpl(-pid, signal)
      return true
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
      if (code === 'ESRCH') return signalProcessSafely(pid, signal)
      if (code === 'EPERM') return true
      throw error
    }
  }

  async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    if (runtime.waitForPidExit) {
      return await runtime.waitForPidExit(pid, timeoutMs)
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true
      await sleep(DAEMON_POLL_INTERVAL_MS)
    }
    return !isProcessAlive(pid)
  }

  async function authenticateDaemonBeforeSignal(
    info: DaemonStatusInfo,
    signal: NodeJS.Signals,
  ): Promise<void> {
    const currentBeforeHealth = readPidInfo()
    if (
      !refersToSameDaemon(currentBeforeHealth, info)
      || !(await readAuthenticatedDaemonHealth(info))
    ) {
      throw new Error(
        `Refusing to send ${signal} to PID ${info.pid}: daemon identity could not be authenticated`,
      )
    }

    const currentAfterHealth = readPidInfo()
    if (!refersToSameDaemon(currentAfterHealth, info)) {
      throw new Error(
        `Refusing to send ${signal} to PID ${info.pid}: daemon identity changed during verification`,
      )
    }
  }

  async function stopDaemonProcess(info: DaemonStatusInfo | null): Promise<void> {
    if (!info) {
      if (!readPidInfo()) {
        removeFileIfPresent(DAEMON_PID_PATH)
      }
      return
    }

    if (!isProcessAlive(info.pid)) {
      const current = readPidInfo()
      if (!current || refersToSameDaemon(current, info)) {
        removeFileIfPresent(DAEMON_PID_PATH)
      }
      return
    }

    await authenticateDaemonBeforeSignal(info, 'SIGTERM')
    signalProcessSafely(info.pid, 'SIGTERM')
    let stopped = await waitForPidExit(info.pid, DAEMON_STOP_TIMEOUT_MS)
    if (!stopped) {
      // Re-authenticate before escalation. If SIGTERM closes HTTP while the
      // process remains alive, fail closed rather than risk sending SIGKILL to
      // a recycled PID. The caller receives the explicit refusal from the
      // identity check and can inspect/remove stale daemon state deliberately.
      await authenticateDaemonBeforeSignal(info, 'SIGKILL')
      signalProcessGroupSafely(info.pid, 'SIGKILL')
      stopped = await waitForPidExit(info.pid, DAEMON_KILL_TIMEOUT_MS)
    }

    if (!stopped) {
      throw new Error(`Timed out stopping CodeSurf daemon PID ${info.pid}`)
    }

    const current = readPidInfo()
    if (!current || refersToSameDaemon(current, info)) {
      removeFileIfPresent(DAEMON_PID_PATH)
    }
  }

  async function runEnsureDaemon(forceRestart: boolean): Promise<DaemonStatusInfo> {
    const appVersion = resolveAppVersion()
    const hasCompatibleVersion = (info: DaemonStatusInfo): boolean => (
      !info.appVersion || info.appVersion === appVersion
    )
    const canReuse = (info: DaemonStatusInfo): boolean => !forceRestart && hasCompatibleVersion(info)

    if (cachedInfo && isProcessAlive(cachedInfo.pid) && await healthcheck(cachedInfo)) {
      if (canReuse(cachedInfo)) {
        return cachedInfo
      }
    }

    const existing = readPidInfo()
    const existingHealthy = Boolean(
      existing
      && isProcessAlive(existing.pid)
      && await healthcheck(existing),
    )
    if (forceRestart || (existingHealthy && existing && !hasCompatibleVersion(existing))) {
      await stopDaemonProcess(existing)
      clearDaemonCache()
    } else if (
      existing
      && existingHealthy
      && hasCompatibleVersion(existing)
    ) {
      cachedInfo = existing
      return existing
    }

    return await withStartupLock(async () => {
      const lockedExisting = readPidInfo()
      const lockedExistingHealthy = Boolean(
        lockedExisting
        && isProcessAlive(lockedExisting.pid)
        && await healthcheck(lockedExisting),
      )
      if (
        lockedExisting
        && lockedExistingHealthy
        && canReuse(lockedExisting)
      ) {
        cachedInfo = lockedExisting
        return lockedExisting
      }

      if (
        lockedExisting
        && (
          forceRestart
          || (lockedExistingHealthy && !hasCompatibleVersion(lockedExisting))
        )
      ) {
        await stopDaemonProcess(lockedExisting)
        clearDaemonCache()
      }

      const child = spawnDaemonProcess()
      await waitForChildStartupGrace(child)
      return await waitForDaemonReady()
    }, canReuse)
  }

  function beginStartup(forceRestart: boolean): Promise<DaemonStatusInfo> {
    const operation = runEnsureDaemon(forceRestart)
    startupPromise = operation
    startupForcesRestart = forceRestart

    const clearOperation = (): void => {
      if (startupPromise !== operation) return
      startupPromise = null
      startupForcesRestart = false
    }
    void operation.then(clearOperation, clearOperation)
    return operation
  }

  function ensureDaemonRunning(options?: { forceRestart?: boolean }): Promise<DaemonStatusInfo> {
    const forceRestart = options?.forceRestart === true

    // Once a forced restart is queued, all later callers must observe its
    // replacement. Returning the original startup here would hand out a daemon
    // that is about to be terminated.
    if (queuedForceRestartPromise) {
      return queuedForceRestartPromise
    }

    if (startupPromise) {
      if (!forceRestart || startupForcesRestart) {
        return startupPromise
      }

      const activeStartup = startupPromise
      const queuedRestart = activeStartup
        .catch(() => undefined)
        .then(() => beginStartup(true))
      queuedForceRestartPromise = queuedRestart

      const clearQueuedRestart = (): void => {
        if (queuedForceRestartPromise === queuedRestart) {
          queuedForceRestartPromise = null
        }
      }
      void queuedRestart.then(clearQueuedRestart, clearQueuedRestart)
      return queuedRestart
    }

    return beginStartup(forceRestart)
  }

  async function getDaemonStatus(): Promise<{ running: boolean; info: DaemonStatusInfo | null }> {
    const info = readPidInfo()
    if (!info || !isProcessAlive(info.pid) || !(await healthcheck(info))) {
      clearDaemonCache()
      return { running: false, info: null }
    }
    cachedInfo = info
    return { running: true, info }
  }

  function invalidateDaemonCache(): void {
    clearDaemonCache()
  }

  async function restartDaemon(): Promise<DaemonStatusInfo> {
    invalidateDaemonCache()
    return await ensureDaemonRunning({ forceRestart: true })
  }

  async function stopDaemon(): Promise<void> {
    const info = readPidInfo()
    await stopDaemonProcess(info)
    clearDaemonCache()
  }

  return {
    ensureDaemonRunning,
    getDaemonStatus,
    invalidateDaemonCache,
    restartDaemon,
    stopDaemon,
  }
}

/**
 * Resolves a path to `codesurfd.mjs` by trying a list of candidate paths in
 * order. Returns the first path that exists, or throws if none do. Helper for
 * implementations of `DaemonManagerConfig.resolveDaemonScriptPath`.
 */
export function resolveDaemonScriptFromCandidates(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Unable to locate codesurfd.mjs in any of:\n  ${candidates.join('\n  ')}`)
}
