import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_DAEMON_ENTRY = join(PACKAGE_ROOT, 'bin', 'codesurfd.mjs')
const TEST_TMP_ROOT = join(PACKAGE_ROOT, '.tmp', 'daemon-tests')
// A cold daemon import can exceed five seconds on a loaded CI runner. Keep the
// default bounded while leaving enough headroom for deterministic integration
// tests; explicit timeout tests pass their own much smaller value.
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_TERM_TIMEOUT_MS = 5_000
const DEFAULT_KILL_TIMEOUT_MS = 5_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024

function delay(ms) {
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, ms)
  })
}

async function withTimeout(promise, timeoutMs, description) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function createOutputCollector(stream, maxBytes) {
  const chunks = []
  let bytes = 0
  let truncated = false

  const onData = chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    const remaining = maxBytes - bytes
    if (remaining <= 0) {
      truncated = true
      return
    }
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining))
      bytes += remaining
      truncated = true
      return
    }
    chunks.push(buffer)
    bytes += buffer.length
  }

  stream?.on('data', onData)
  return {
    cleanup() {
      stream?.off('data', onData)
    },
    read() {
      const output = Buffer.concat(chunks).toString('utf8')
      return truncated ? `${output}\n[output truncated at ${maxBytes} bytes]` : output
    },
  }
}

function processIsRunning(child, spawnError) {
  return !spawnError && child.exitCode === null && child.signalCode === null
}

export async function waitFor(check, timeoutMs = 5_000, intervalMs = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await delay(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

export async function makeDaemonTestTempDir(prefix) {
  if (
    typeof prefix !== 'string'
    || !prefix
    || prefix === '.'
    || prefix === '..'
    || prefix.includes('/')
    || prefix.includes('\\')
    || prefix.includes(sep)
  ) {
    throw new Error('daemon test temp prefix must be one safe path segment')
  }
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

export function spawnManagedChild({
  command,
  args = [],
  cwd = PACKAGE_ROOT,
  env = process.env,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
}) {
  if (typeof command !== 'string' || !command) {
    throw new Error('managed child command is required')
  }

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutCollector = createOutputCollector(child.stdout, outputLimitBytes)
  const stderrCollector = createOutputCollector(child.stderr, outputLimitBytes)
  let spawnError = null
  let finalResult = null
  let stopPromise = null

  let resolveClosed
  const closed = new Promise(resolveClose => {
    resolveClosed = resolveClose
  })

  const onError = error => {
    spawnError = error
  }
  const onExit = () => {}
  const onClose = (exitCode, signalCode) => {
    child.off('error', onError)
    child.off('exit', onExit)
    child.off('close', onClose)
    stdoutCollector.cleanup()
    stderrCollector.cleanup()
    finalResult = {
      exitCode,
      signalCode,
      spawnError,
      stdout: stdoutCollector.read(),
      stderr: stderrCollector.read(),
    }
    resolveClosed(finalResult)
  }

  child.once('error', onError)
  child.once('exit', onExit)
  child.once('close', onClose)

  const stop = ({
    termTimeoutMs = DEFAULT_TERM_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
  } = {}) => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      let escalated = false

      if (processIsRunning(child, spawnError)) {
        child.kill('SIGTERM')
      }

      try {
        const result = await withTimeout(closed, termTimeoutMs, 'managed child SIGTERM shutdown')
        return { ...result, escalated }
      } catch (termError) {
        if (processIsRunning(child, spawnError)) {
          escalated = true
          child.kill('SIGKILL')
        } else {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }

        try {
          const result = await withTimeout(closed, killTimeoutMs, 'managed child final exit')
          return { ...result, escalated }
        } catch (killError) {
          throw new AggregateError(
            [termError, killError],
            `child process ${child.pid ?? 'unknown'} did not reach a final close`,
          )
        }
      }
    })()
    return stopPromise
  }

  return {
    child,
    closed,
    stop,
    waitForExit(timeoutMs = DEFAULT_KILL_TIMEOUT_MS) {
      return withTimeout(closed, timeoutMs, 'managed child exit')
    },
    get finalResult() {
      return finalResult
    },
    get spawnError() {
      return spawnError
    },
    get stdout() {
      return finalResult?.stdout ?? stdoutCollector.read()
    },
    get stderr() {
      return finalResult?.stderr ?? stderrCollector.read()
    },
  }
}

function createRequestHelpers(pidInfo) {
  const authorizedHeaders = {
    Authorization: `Bearer ${pidInfo.token}`,
  }
  const baseUrl = `http://127.0.0.1:${pidInfo.port}`

  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? (options.body == null ? 'GET' : 'POST'),
      headers: {
        ...authorizedHeaders,
        ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    return {
      status: response.status,
      payload: text.trim() ? JSON.parse(text) : null,
    }
  }

  const requestText = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...authorizedHeaders,
        ...(options.headers ?? {}),
      },
    })
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    }
  }

  const requestRaw = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'POST',
      headers: {
        ...authorizedHeaders,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      body: options.body ?? '',
    })
    const text = await response.text()
    return {
      status: response.status,
      payload: text.trim() ? JSON.parse(text) : null,
    }
  }

  return { request, requestRaw, requestText }
}

function startupError(message, managed, cause) {
  const diagnostics = [
    managed.stdout.trim() ? `stdout:\n${managed.stdout.trim()}` : '',
    managed.stderr.trim() ? `stderr:\n${managed.stderr.trim()}` : '',
  ].filter(Boolean).join('\n')
  const error = new Error(`${message}${diagnostics ? `\n${diagnostics}` : ''}`, { cause })
  error.childPid = managed.child.pid
  return error
}

export async function spawnDaemon({
  homeDir: suppliedHomeDir,
  homePrefix = 'codesurfd-test-',
  daemonEntry = DEFAULT_DAEMON_ENTRY,
  appVersion = 'test-suite',
  env = {},
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  termTimeoutMs = DEFAULT_TERM_TIMEOUT_MS,
  killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
  cleanupHome = true,
  assertEmptyStderr = true,
} = {}) {
  const requestedHomeDir = suppliedHomeDir ?? await makeDaemonTestTempDir(homePrefix)
  if (!isAbsolute(requestedHomeDir)) {
    throw new Error('daemon test home must be absolute')
  }
  const homeDir = resolve(requestedHomeDir)
  if (!homeDir.startsWith(`${TEST_TMP_ROOT}${sep}`)) {
    throw new Error(`daemon test home must be inside ${TEST_TMP_ROOT}`)
  }
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const managed = spawnManagedChild({
    command: process.execPath,
    args: [daemonEntry],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      ...env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: appVersion,
    },
  })

  let pidInfo
  try {
    pidInfo = await waitFor(async () => {
      if (managed.spawnError) {
        throw startupError('daemon process failed to spawn', managed, managed.spawnError)
      }
      if (managed.finalResult) {
        throw startupError('daemon exited before publishing startup state', managed)
      }
      try {
        const parsed = JSON.parse(await readFile(pidPath, 'utf8'))
        if (parsed.pid !== managed.child.pid) return null
        if (!Number.isInteger(parsed.port) || parsed.port <= 0 || typeof parsed.token !== 'string' || !parsed.token) {
          throw new Error('daemon pid file did not contain a positive port and token')
        }
        return parsed
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    }, startupTimeoutMs, 25)
  } catch (error) {
    const startupFailure = error?.childPid
      ? error
      : startupError(error.message, managed, error)
    let shutdownError = null
    try {
      await managed.stop({ termTimeoutMs, killTimeoutMs })
    } catch (stopError) {
      shutdownError = stopError
    }
    if (!shutdownError && cleanupHome) {
      await rm(homeDir, { recursive: true, force: true })
    }
    if (shutdownError) {
      throw new AggregateError(
        [startupFailure, shutdownError],
        'daemon startup failed and its child did not shut down cleanly',
      )
    }
    throw startupFailure
  }

  const requests = createRequestHelpers(pidInfo)
  let daemonStopPromise = null
  const stop = () => {
    if (daemonStopPromise) return daemonStopPromise
    daemonStopPromise = (async () => {
      const result = await managed.stop({ termTimeoutMs, killTimeoutMs })
      if (cleanupHome) {
        await rm(homeDir, { recursive: true, force: true })
      }
      if (assertEmptyStderr && result.stderr.trim()) {
        throw new Error(`daemon stderr was not empty:\n${result.stderr}`)
      }
      return result
    })()
    return daemonStopPromise
  }

  return {
    child: managed.child,
    daemonEntry,
    homeDir,
    pidInfo,
    pidPath,
    managed,
    stop,
    ...requests,
  }
}
