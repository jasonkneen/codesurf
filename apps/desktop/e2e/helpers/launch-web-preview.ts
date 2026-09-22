import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { runWindowsTaskkill } from '../../src/main/relay/bounded-subprocess.ts'
import { buildIsolatedWebPreviewEnv } from './web-preview-env'

const REPO_ROOT = join(__dirname, '../..')
const WEB_PREVIEW_ENTRY = join(REPO_ROOT, 'scripts/web-preview.mjs')
const WEB_BUILD_ENTRY = join(REPO_ROOT, 'dist/index.html')
const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 15_000
const STOP_TERM_GRACE_MS = 5_000
const MAX_LOG_BYTES = 64 * 1024

export interface LaunchedWebPreview {
  url: string
  hostUrl: string
  homeDir: string
  close: () => Promise<void>
}

async function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not reserve a loopback port for built-web E2E')
  }
  return { server, port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
}

async function reserveDistinctPorts(count: number): Promise<number[]> {
  const reservations: Array<{ server: Server; port: number }> = []
  try {
    for (let index = 0; index < count; index += 1) {
      reservations.push(await listenOnEphemeralPort())
    }
    return reservations.map(({ port }) => port)
  } finally {
    await Promise.all(reservations.map(({ server }) => closeServer(server)))
  }
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('close', onExit)
      resolveExit(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      child.off('close', onExit)
      resolveExit(child.exitCode !== null || child.signalCode !== null)
    }, timeoutMs)
    child.once('exit', onExit)
    child.once('close', onExit)
  })
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isPosixProcessGroupAlive(pid)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(50, remaining)))
  }
  return true
}

function signalPosixProcessTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // The group may already be gone. Fall back to the coordinator when it is
    // still alive; the exit checks below remain authoritative.
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal)
    } catch {
      // The exit checks below determine whether cleanup succeeded.
    }
  }
}

async function stopPreview(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) {
    if (await waitForProcessExit(child, STOP_TIMEOUT_MS)) return
    throw new Error('Built-web preview coordinator has no PID and did not exit')
  }

  if (process.platform === 'win32') {
    // Invoke taskkill even when the coordinator has already exited. Returning
    // based on the leader alone can strand its host/daemon/terminal descendants.
    const taskkill = await runWindowsTaskkill(pid, STOP_TIMEOUT_MS)
    const coordinatorExited = await waitForProcessExit(child, STOP_TIMEOUT_MS)
    if (!taskkill.confirmed || !coordinatorExited) {
      throw new Error(`Built-web preview process tree ${pid} did not exit: ${taskkill.detail}`)
    }
    return
  }

  signalPosixProcessTree(child, pid, 'SIGTERM')
  await Promise.all([
    waitForProcessExit(child, STOP_TERM_GRACE_MS),
    waitForPosixProcessGroupExit(pid, STOP_TERM_GRACE_MS),
  ])
  if (child.exitCode === null || isPosixProcessGroupAlive(pid)) {
    signalPosixProcessTree(child, pid, 'SIGKILL')
  }
  const [coordinatorExited, groupExited] = await Promise.all([
    waitForProcessExit(child, STOP_TIMEOUT_MS),
    waitForPosixProcessGroupExit(pid, STOP_TIMEOUT_MS),
  ])
  if (!coordinatorExited || !groupExited) {
    throw new Error(
      `Built-web preview process tree ${pid} did not exit ` +
        `(coordinator=${coordinatorExited}, group=${groupExited})`,
    )
  }
}

async function waitForPreview(
  url: string,
  child: ChildProcess,
  getLogTail: () => string,
  getSpawnError: () => Error | null,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const spawnError = getSpawnError()
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Built-web preview exited before becoming ready ` +
          `(code=${child.exitCode}, signal=${child.signalCode}).\n${getLogTail()}`,
      )
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (response.ok && (await response.text()).includes('<div id="root">')) return
    } catch {
      // Preview, host, and daemon start independently. Retry until the full UI
      // is reachable or the coordinator exits.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error(`Timed out waiting for built-web preview at ${url}.\n${getLogTail()}`)
}

export async function launchBuiltWebPreview(): Promise<LaunchedWebPreview> {
  if (!existsSync(WEB_BUILD_ENTRY)) {
    throw new Error(`Built-web E2E requires ${WEB_BUILD_ENTRY}; run \`npm run build:web\` first`)
  }
  if (!existsSync(WEB_PREVIEW_ENTRY)) {
    throw new Error(`Built-web preview entry is missing: ${WEB_PREVIEW_ENTRY}`)
  }

  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-web-e2e-home-'))
  const codesurfHome = join(homeDir, '.codesurf')
  await mkdir(codesurfHome, { recursive: true })

  const [previewPort, hostPort, runtimeConfigPort, terminalPort] = await reserveDistinctPorts(4)
  const url = `http://127.0.0.1:${previewPort}/`
  const hostUrl = `http://127.0.0.1:${hostPort}`
  const hostToken = randomBytes(32).toString('base64url')
  const terminalToken = randomBytes(32).toString('base64url')
  const child = spawn(process.execPath, [WEB_PREVIEW_ENTRY], {
    cwd: REPO_ROOT,
    detached: process.platform !== 'win32',
    env: buildIsolatedWebPreviewEnv(process.env, {
      homeDir,
      codesurfHome,
      hostUrl,
      hostPort,
      hostToken,
      previewPort,
      runtimeConfigPort,
      terminalPort,
      terminalToken,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let logTail = ''
  let spawnError: Error | null = null
  const appendLog = (chunk: Buffer | string) => {
    logTail += String(chunk)
    if (logTail.length > MAX_LOG_BYTES) logTail = logTail.slice(-MAX_LOG_BYTES)
  }
  child.stdout?.on('data', appendLog)
  child.stderr?.on('data', appendLog)
  child.once('error', (error) => {
    spawnError = error
  })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    const cleanupErrors: unknown[] = []
    try {
      await stopPreview(child)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await rm(homeDir, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Built-web preview cleanup failed')
    }
  }

  try {
    await waitForPreview(
      url,
      child,
      () => logTail,
      () => spawnError,
    )
    return { url, hostUrl, homeDir, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Built-web preview launch and cleanup failed')
    }
    throw error
  }
}
