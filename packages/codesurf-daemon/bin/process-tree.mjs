import { spawn } from 'node:child_process'

export const PROCESS_TREE_TERM_GRACE_MS = 1_000
export const PROCESS_TREE_KILL_WAIT_MS = 2_000

const terminationPromises = new WeakMap()

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function positiveSafeInteger(value, fallback, name) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return resolved
}

function childHasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForChildExit(proc, timeoutMs) {
  if (childHasExited(proc)) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.off?.('close', onClose)
      proc.off?.('error', onError)
      resolve(exited)
    }
    const onClose = () => finish(true)
    // A spawn error means no owned child exists. Errors after a successful
    // spawn do not prove exit, so the PID/group checks below remain decisive.
    const onError = () => {
      if (!proc.pid) finish(true)
    }
    const timer = setTimeout(() => finish(childHasExited(proc)), timeoutMs)
    proc.once('close', onClose)
    proc.once('error', onError)
  })
}

function isPosixProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForPosixProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (isPosixProcessGroupAlive(pid)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await delay(Math.min(20, remaining))
  }
  return true
}

function signalDirectChild(proc, signal) {
  try {
    proc.kill(signal)
    return true
  } catch {
    return childHasExited(proc)
  }
}

function signalPosixProcessGroup(proc, signal) {
  const pid = proc.pid
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return true
    }
  }
  return signalDirectChild(proc, signal)
}

async function runWindowsTaskkill(pid, timeoutMs, spawnProcess = spawn) {
  return await new Promise(resolve => {
    let settled = false
    let killer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    try {
      killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        confirmed: false,
        detail: `taskkill /T /F failed to start: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL') } catch {}
      finish({
        confirmed: false,
        detail: `taskkill /T /F did not settle within ${timeoutMs}ms`,
      })
    }, timeoutMs)
    killer.once('error', error => {
      finish({
        confirmed: false,
        detail: `taskkill /T /F failed: ${error.message}`,
      })
    })
    killer.once('close', (code, signal) => {
      finish(code === 0
        ? { confirmed: true, detail: 'taskkill /T /F confirmed process-tree termination' }
        : {
            confirmed: false,
            detail: `taskkill /T /F exited with code ${code ?? 'null'}`
              + (signal ? ` and signal ${signal}` : ''),
          })
    })
  })
}

/**
 * Windows-specific helper used by the lifecycle tests and the cancellation
 * path. A reaped leader cannot safely be handed to taskkill: the PID may have
 * been reused while descendants are still alive, so report the tree as
 * unconfirmed instead of claiming a false cleanup.
 */
async function terminateWindowsProcessTree(proc, pid, timeoutMs, spawnProcess = spawn) {
  if (childHasExited(proc)) {
    return {
      confirmed: false,
      pid,
      stage: 'failed',
      detail: 'direct child exited before tree cancellation; descendant exit is unconfirmed',
    }
  }
  const taskkill = await runWindowsTaskkill(pid, timeoutMs, spawnProcess)
  const childExited = await waitForChildExit(proc, timeoutMs)
  const confirmed = taskkill.confirmed && childExited
  return {
    confirmed,
    pid,
    stage: confirmed ? 'taskkill' : 'failed',
    detail: confirmed
      ? taskkill.detail
      : `${taskkill.detail}; descendant exit is unconfirmed`,
  }
}

async function terminateProcessTreeOnce(proc, options) {
  const termGraceMs = positiveSafeInteger(
    options.termGraceMs,
    PROCESS_TREE_TERM_GRACE_MS,
    'termGraceMs',
  )
  const killWaitMs = positiveSafeInteger(
    options.killWaitMs,
    PROCESS_TREE_KILL_WAIT_MS,
    'killWaitMs',
  )
  const pid = Number.isSafeInteger(proc.pid) && proc.pid > 0 ? proc.pid : null

  if (!pid) {
    // Node assigns pid synchronously for a successful spawn. No PID means no
    // operating-system child/tree was created (the ChildProcess will emit an
    // error such as ENOENT), so absence itself is confirmation.
    return {
      confirmed: true,
      pid: null,
      stage: 'already-exited',
      detail: childHasExited(proc) ? 'child already exited' : 'spawn created no child PID',
    }
  }

  if (process.platform === 'win32') {
    // A natural `close` can race lifecycle finalization. taskkill cannot target
    // a PID that Windows has already reaped; in that case the owned direct
    // child is settled and no further tree action is available. Cancellation
    // paths enter here while the leader is live and therefore still use /T /F.
    if (childHasExited(proc)) {
      return {
        confirmed: true,
        pid,
        stage: 'already-exited',
        detail: 'direct child already exited before Windows tree cancellation',
      }
    }
    const taskkill = await runWindowsTaskkill(pid, killWaitMs, options.spawnProcess)
    if (!taskkill.confirmed) {
      // Reduce leakage without claiming descendant termination was confirmed.
      signalDirectChild(proc, 'SIGKILL')
    }
    const childExited = await waitForChildExit(proc, killWaitMs)
    const confirmed = taskkill.confirmed && childExited
    return {
      confirmed,
      pid,
      stage: confirmed ? 'taskkill' : 'failed',
      detail: childExited
        ? taskkill.detail
        : `${taskkill.detail}; direct child exit was not observed`,
    }
  }

  signalPosixProcessGroup(proc, 'SIGTERM')
  const [termChildExited, termGroupExited] = await Promise.all([
    waitForChildExit(proc, termGraceMs),
    waitForPosixProcessGroupExit(pid, termGraceMs),
  ])
  if (termChildExited && termGroupExited) {
    return {
      confirmed: true,
      pid,
      stage: 'sigterm',
      detail: 'process group exited after SIGTERM',
    }
  }

  signalPosixProcessGroup(proc, 'SIGKILL')
  const [killChildExited, killGroupExited] = await Promise.all([
    waitForChildExit(proc, killWaitMs),
    waitForPosixProcessGroupExit(pid, killWaitMs),
  ])
  const confirmed = killChildExited && killGroupExited
  return {
    confirmed,
    pid,
    stage: confirmed ? 'sigkill' : 'failed',
    detail: confirmed
      ? 'process group exited after SIGKILL escalation'
      : `process-tree exit was not confirmed after SIGKILL (child=${killChildExited}, group=${killGroupExited})`,
  }
}

/**
 * Options for a child that must be terminated as one owned process tree.
 * POSIX children lead a dedicated process group; Windows relies on taskkill
 * /T /F at shutdown rather than Node's misleading ChildProcess.killed flag.
 */
export function processTreeSpawnOptions(options = {}) {
  return {
    ...options,
    detached: process.platform !== 'win32',
    windowsHide: true,
  }
}

/**
 * TERM the entire owned tree, await a bounded grace period, then KILL and
 * await proof that both the direct child and POSIX group have disappeared.
 * Concurrent callers share one termination attempt for the same ChildProcess.
 */
export async function terminateProcessTree(proc, options = {}) {
  const existing = terminationPromises.get(proc)
  if (existing) return await existing

  const pending = terminateProcessTreeOnce(proc, options)
  terminationPromises.set(proc, pending)
  const result = await pending
  if (!result.confirmed) terminationPromises.delete(proc)
  return result
}

export const __test = {
  isPosixProcessGroupAlive,
  runWindowsTaskkill,
  terminateWindowsProcessTree,
  waitForPosixProcessGroupExit,
}
