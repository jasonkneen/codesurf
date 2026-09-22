import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

export interface ElectrobunStopResult {
  confirmed: boolean
  hadProcess: boolean
  error?: string
}

export const DEFAULT_ELECTROBUN_TERM_GRACE_MS = 1_000
export const DEFAULT_ELECTROBUN_KILL_WAIT_MS = 1_500

export async function waitForElectrobunPromise(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function closePromise(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('close', finish)
    child.once('exit', finish)
    child.once('error', finish)
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
  while (Date.now() < deadline) {
    if (!isPosixProcessGroupAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return !isPosixProcessGroupAlive(pid)
}

function signalPosixProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // A non-detached or already-closing child has no dedicated process group.
    }
  }
  try { child.kill(signal) } catch { /* already exited */ }
}

function windowsTaskkillExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  return systemRoot && win32.isAbsolute(systemRoot)
    ? win32.join(systemRoot, 'System32', 'taskkill.exe')
    : 'C:\\Windows\\System32\\taskkill.exe'
}

async function runWindowsTaskkill(pid: number, timeoutMs: number): Promise<boolean> {
  const taskkill = spawn(windowsTaskkillExecutable(), ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  })
  const completed = new Promise<boolean>(resolve => {
    taskkill.once('error', () => resolve(false))
    taskkill.once('close', code => resolve(code === 0))
  })
  const onTime = await waitForElectrobunPromise(completed, timeoutMs)
  if (!onTime) {
    try { taskkill.kill('SIGKILL') } catch { /* already exited */ }
    return false
  }
  return await completed
}

export async function terminateElectrobunProcessTree(
  child: ChildProcess,
  options: { termGraceMs?: number, killWaitMs?: number } = {},
): Promise<ElectrobunStopResult> {
  const termGraceMs = options.termGraceMs ?? DEFAULT_ELECTROBUN_TERM_GRACE_MS
  const killWaitMs = options.killWaitMs ?? DEFAULT_ELECTROBUN_KILL_WAIT_MS
  const closed = closePromise(child)
  const pid = child.pid

  if (process.platform === 'win32' && pid) {
    const treeStopped = await runWindowsTaskkill(pid, termGraceMs + killWaitMs)
    const childStopped = await waitForElectrobunPromise(closed, killWaitMs)
    return {
      confirmed: treeStopped && childStopped,
      hadProcess: true,
      ...(!treeStopped || !childStopped ? { error: 'Failed to confirm chat process-tree termination' } : {}),
    }
  }

  signalPosixProcessTree(child, 'SIGTERM')
  const childStoppedGracefully = await waitForElectrobunPromise(closed, termGraceMs)
  const groupStoppedGracefully = pid
    ? await waitForPosixProcessGroupExit(pid, Math.min(termGraceMs, 250))
    : childStoppedGracefully
  if (childStoppedGracefully && groupStoppedGracefully) {
    return { confirmed: true, hadProcess: true }
  }

  signalPosixProcessTree(child, 'SIGKILL')
  const [childStopped, groupStopped] = await Promise.all([
    waitForElectrobunPromise(closed, killWaitMs),
    pid ? waitForPosixProcessGroupExit(pid, killWaitMs) : Promise.resolve(false),
  ])
  const confirmed = childStopped && (pid ? groupStopped : childStopped)
  return {
    confirmed,
    hadProcess: true,
    ...(!confirmed ? { error: 'Failed to confirm chat process-tree termination' } : {}),
  }
}

type WindowsTreeKillSync = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => unknown

export function forceTerminateElectrobunProcessTree(
  child: ChildProcess,
  options: {
    platform?: NodeJS.Platform
    runWindowsTreeKillSync?: WindowsTreeKillSync
  } = {},
): boolean {
  const platform = options.platform ?? process.platform
  if (platform === 'win32' && child.pid) {
    const runWindowsTreeKillSync = options.runWindowsTreeKillSync
      ?? ((file, args, execOptions) => execFileSync(file, args, execOptions))
    try {
      runWindowsTreeKillSync(
        windowsTaskkillExecutable(),
        ['/PID', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
          timeout: DEFAULT_ELECTROBUN_TERM_GRACE_MS + DEFAULT_ELECTROBUN_KILL_WAIT_MS,
          shell: false,
        },
      )
      return true
    } catch {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      return false
    }
  }
  signalPosixProcessTree(child, 'SIGKILL')
  return true
}
