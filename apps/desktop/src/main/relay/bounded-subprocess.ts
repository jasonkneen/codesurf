import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'

export const RELAY_SUBPROCESS_STDOUT_MAX_BYTES = 8 * 1024 * 1024
export const RELAY_SUBPROCESS_STDERR_MAX_BYTES = 1024 * 1024
export const RELAY_SUBPROCESS_TERM_GRACE_MS = 1_000
export const RELAY_SUBPROCESS_KILL_WAIT_MS = 1_000

export type BoundedSubprocessFailureReason =
  | 'spawn'
  | 'abort'
  | 'timeout'
  | 'stdout-limit'
  | 'stderr-limit'
  | 'termination'

export class BoundedSubprocessError extends Error {
  readonly reason: BoundedSubprocessFailureReason
  readonly command: string
  readonly pid: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(options: {
    reason: BoundedSubprocessFailureReason
    message: string
    command: string
    pid: number | null
    stdout: string
    stderr: string
    cause?: unknown
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BoundedSubprocessError'
    this.reason = options.reason
    this.command = options.command
    this.pid = options.pid
    this.stdout = options.stdout
    this.stderr = options.stderr
  }
}

export type BoundedSubprocessResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  pid: number
}

export type RunBoundedSubprocessOptions = {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  label?: string
  timeoutMs: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  termGraceMs?: number
  killWaitMs?: number
  windowsHide?: boolean
  signal?: AbortSignal
}

type CloseResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type WindowsTaskkillOutcome =
  | 'success'
  | 'verified'
  | 'spawn-error'
  | 'nonzero-exit'
  | 'timeout'

export type WindowsTaskkillResult = {
  confirmed: boolean
  outcome: WindowsTaskkillOutcome
  detail: string
}

export type WindowsTaskkillProcess = {
  onError(listener: (error: Error) => void): void
  onClose(listener: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void): void
  kill(): void
}

export type WindowsTaskkillDependencies = {
  spawnTaskkill(pid: number): WindowsTaskkillProcess
  verifyProcessTreeExited?: (pid: number) => Promise<boolean>
}

const defaultWindowsTaskkillDependencies: WindowsTaskkillDependencies = {
  spawnTaskkill: pid => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return {
      onError(listener) {
        child.once('error', listener)
      },
      onClose(listener) {
        child.once('close', listener)
      },
      kill() {
        try { child.kill('SIGKILL') } catch {}
      },
    }
  },
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs)
  })
}

function waitForClose(closePromise: Promise<CloseResult>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (closed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(closed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void closePromise.then(() => finish(true))
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
    await wait(Math.min(15, remaining))
  }
  return true
}

function signalPosixProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid
  if (pid) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // The group may already be gone or group signalling may be unavailable.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // The direct child already exited.
  }
}

export async function runWindowsTaskkill(
  pid: number,
  waitMs: number,
  dependencies: WindowsTaskkillDependencies = defaultWindowsTaskkillDependencies,
): Promise<WindowsTaskkillResult> {
  return await new Promise<WindowsTaskkillResult>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = async (
      outcome: Exclude<WindowsTaskkillOutcome, 'verified'>,
      detail: string,
      taskkillSucceeded = false,
    ): Promise<void> => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (taskkillSucceeded) {
        resolve({ confirmed: true, outcome, detail })
        return
      }
      const verified = await dependencies.verifyProcessTreeExited?.(pid)
        .catch(() => false)
      resolve(verified
        ? {
            confirmed: true,
            outcome: 'verified',
            detail: `${detail}; descendants independently verified dead`,
          }
        : { confirmed: false, outcome, detail })
    }
    let killer: WindowsTaskkillProcess
    try {
      killer = dependencies.spawnTaskkill(pid)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void finish('spawn-error', `taskkill /T failed to start: ${message}`)
      return
    }
    timer = setTimeout(() => {
      killer.kill()
      void finish(
        'timeout',
        `taskkill /T did not exit within ${waitMs}ms`,
      )
    }, waitMs)
    killer.onError(error => {
      void finish(
        'spawn-error',
        `taskkill /T failed to start: ${error.message}`,
      )
    })
    killer.onClose((code, signal) => {
      if (code === 0) {
        void finish('success', 'taskkill /T exited successfully', true)
        return
      }
      void finish(
        'nonzero-exit',
        `taskkill /T exited with code ${code ?? 'null'}`
          + (signal ? ` and signal ${signal}` : ''),
      )
    })
  })
}

async function terminateProcessTree(options: {
  proc: ChildProcess
  closePromise: Promise<CloseResult>
  termGraceMs: number
  killWaitMs: number
}): Promise<{ confirmed: boolean; detail?: string }> {
  const { proc, closePromise, termGraceMs, killWaitMs } = options
  const pid = proc.pid

  if (!pid) {
    return { confirmed: await waitForClose(closePromise, killWaitMs) }
  }

  if (process.platform === 'win32') {
    const taskkill = await runWindowsTaskkill(pid, killWaitMs)
    if (!taskkill.confirmed) {
      // Best-effort direct-child fallback reduces leakage, but it does not
      // prove descendants exited and therefore cannot make shutdown succeed.
      try { proc.kill('SIGKILL') } catch {}
    }
    const childClosed = await waitForClose(closePromise, killWaitMs)
    return {
      confirmed: taskkill.confirmed && childClosed,
      detail: taskkill.detail,
    }
  }

  signalPosixProcessGroup(proc, 'SIGTERM')
  await waitForClose(closePromise, termGraceMs)

  if (isPosixProcessGroupAlive(pid) || proc.exitCode === null) {
    signalPosixProcessGroup(proc, 'SIGKILL')
  }

  const [childClosed, groupExited] = await Promise.all([
    waitForClose(closePromise, killWaitMs),
    waitForPosixProcessGroupExit(pid, killWaitMs),
  ])
  return { confirmed: childClosed && groupExited }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return resolved
}

/**
 * Run a CLI child with bounded output and process-tree termination.
 *
 * POSIX children lead a dedicated process group. Timeout/output failures signal
 * the entire group with TERM, wait a bounded grace period, then escalate to
 * KILL. Windows uses taskkill /T /F so grandchildren are included.
 */
export async function runBoundedSubprocess(
  options: RunBoundedSubprocessOptions,
): Promise<BoundedSubprocessResult> {
  const stdoutMaxBytes = positiveLimit(
    options.stdoutMaxBytes,
    RELAY_SUBPROCESS_STDOUT_MAX_BYTES,
    'stdoutMaxBytes',
  )
  const stderrMaxBytes = positiveLimit(
    options.stderrMaxBytes,
    RELAY_SUBPROCESS_STDERR_MAX_BYTES,
    'stderrMaxBytes',
  )
  const termGraceMs = positiveLimit(
    options.termGraceMs,
    RELAY_SUBPROCESS_TERM_GRACE_MS,
    'termGraceMs',
  )
  const killWaitMs = positiveLimit(
    options.killWaitMs,
    RELAY_SUBPROCESS_KILL_WAIT_MS,
    'killWaitMs',
  )
  const timeoutMs = positiveLimit(options.timeoutMs, 0, 'timeoutMs')
  const label = options.label?.trim() || options.command
  if (options.signal?.aborted) {
    throw new BoundedSubprocessError({
      reason: 'abort',
      message: `${label} turn was cancelled before launch`,
      command: options.command,
      pid: null,
      stdout: '',
      stderr: '',
      cause: options.signal.reason,
    })
  }

  const spawnOptions: SpawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: options.windowsHide ?? true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  const proc = spawn(options.command, [...(options.args ?? [])], spawnOptions)
  const pid = proc.pid ?? null
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let collectionStopped = false
  let failure: {
    reason: BoundedSubprocessFailureReason
    message: string
    cause?: unknown
  } | null = null

  let resolveClose!: (result: CloseResult) => void
  const closePromise = new Promise<CloseResult>(resolve => {
    resolveClose = resolve
  })

  const capturedStdout = (): string => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')
  const capturedStderr = (): string => Buffer.concat(stderrChunks, stderrBytes).toString('utf8')

  const stopCollecting = (): void => {
    if (collectionStopped) return
    collectionStopped = true
    proc.stdout?.off('data', onStdout)
    proc.stderr?.off('data', onStderr)
    proc.stdout?.destroy()
    proc.stderr?.destroy()
  }

  let startFailure!: (
    reason: BoundedSubprocessFailureReason,
    message: string,
    cause?: unknown,
  ) => void

  const collect = (
    streamName: 'stdout' | 'stderr',
    rawChunk: Buffer | string,
  ): void => {
    if (collectionStopped) return
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const currentBytes = streamName === 'stdout' ? stdoutBytes : stderrBytes
    const maxBytes = streamName === 'stdout' ? stdoutMaxBytes : stderrMaxBytes
    if (currentBytes + chunk.byteLength > maxBytes) {
      if (failure) {
        // Abort/timeout teardown may still produce useful diagnostics. Keep
        // collecting only while the original byte caps remain intact.
        stopCollecting()
        return
      }
      startFailure(
        streamName === 'stdout' ? 'stdout-limit' : 'stderr-limit',
        `${label} ${streamName} exceeded ${maxBytes} byte limit`,
      )
      return
    }
    if (streamName === 'stdout') {
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.byteLength
    } else {
      stderrChunks.push(chunk)
      stderrBytes += chunk.byteLength
    }
  }

  const onStdout = (chunk: Buffer | string): void => collect('stdout', chunk)
  const onStderr = (chunk: Buffer | string): void => collect('stderr', chunk)
  proc.stdout?.on('data', onStdout)
  proc.stderr?.on('data', onStderr)

  proc.once('close', (code, signal) => {
    resolveClose({ code, signal })
  })

  const timeoutHandle = setTimeout(() => {
    startFailure('timeout', `${label} turn timed out after ${timeoutMs}ms`)
  }, timeoutMs)

  let resolveOutcome!: (result: BoundedSubprocessResult) => void
  let rejectOutcome!: (error: Error) => void
  let outcomeSettled = false
  const outcome = new Promise<BoundedSubprocessResult>((resolve, reject) => {
    resolveOutcome = resolve
    rejectOutcome = reject
  })

  const cleanupOutcome = (): void => {
    clearTimeout(timeoutHandle)
    options.signal?.removeEventListener('abort', onAbort)
  }

  const rejectFailure = (reason: BoundedSubprocessFailureReason, message: string, cause?: unknown): void => {
    if (outcomeSettled) return
    outcomeSettled = true
    cleanupOutcome()
    rejectOutcome(new BoundedSubprocessError({
      reason,
      message,
      command: options.command,
      pid,
      stdout: capturedStdout(),
      stderr: capturedStderr(),
      cause,
    }))
  }

  startFailure = (reason, message, cause) => {
    if (failure || outcomeSettled) return
    failure = { reason, message, cause }
    clearTimeout(timeoutHandle)
    if (reason === 'stdout-limit' || reason === 'stderr-limit') {
      stopCollecting()
    }
    void (async () => {
      const termination = await terminateProcessTree({
        proc,
        closePromise,
        termGraceMs,
        killWaitMs,
      })
      const finalReason = termination.confirmed ? reason : 'termination'
      const finalMessage = termination.confirmed
        ? message
        : `${message}; process exit could not be confirmed after forced termination`
          + (termination.detail ? ` (${termination.detail})` : '')
      rejectFailure(finalReason, finalMessage, cause)
    })()
  }

  const onAbort = (): void => {
    startFailure(
      'abort',
      `${label} turn was cancelled`,
      options.signal?.reason,
    )
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  proc.once('error', error => {
    startFailure('spawn', `${label} failed to start: ${error.message}`, error)
  })

  void closePromise.then(result => {
    cleanupOutcome()
    if (failure || outcomeSettled) return
    outcomeSettled = true
    resolveOutcome({
      stdout: capturedStdout(),
      stderr: capturedStderr(),
      code: result.code,
      signal: result.signal,
      pid: pid ?? 0,
    })
  })

  return await outcome
}
