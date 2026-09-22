const childCloseStates = new WeakMap()
const childStopPromises = new WeakMap()

function exitResult(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return null
}

function streamsSettled(child) {
  return [child.stdin, child.stdout, child.stderr]
    .every((stream) => !stream || stream.closed || stream.destroyed)
}

/**
 * Start observing `close` as soon as a test child is spawned. Unlike `exit`,
 * `close` proves that the process ended and its stdio handles were closed.
 */
export function trackTestChild(child) {
  const existing = childCloseStates.get(child)
  if (existing) return existing.promise

  let resolveClose
  const state = {
    closed: false,
    result: null,
    promise: new Promise((resolve) => {
      resolveClose = resolve
    }),
  }
  const settle = (result) => {
    if (state.closed) return
    state.closed = true
    state.result = result
    child.off('close', onClose)
    resolveClose(result)
  }
  const onClose = (code, signal) => settle({ code, signal })
  child.once('close', onClose)
  childCloseStates.set(child, state)

  // Support a late observer without confusing `exit` for fully-drained stdio.
  const result = exitResult(child)
  if (result && streamsSettled(child)) settle(result)
  return state.promise
}

async function boundedClose(closePromise, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  return Promise.race([closePromise, timeout]).finally(() => clearTimeout(timer))
}

export function signalTestChild(
  child,
  signal,
  killProcessGroup,
  signalProcess = process.kill,
) {
  if (killProcessGroup && process.platform !== 'win32' && child.pid) {
    try {
      signalProcess(-child.pid, signal)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      // The group id can become temporarily unsignalable while the exact
      // ChildProcess is still ours. Fall back only to that owned child; never
      // retry another group id that may already have been reused.
      if (error?.code === 'EPERM') {
        try {
          return child.kill(signal)
        } catch (childError) {
          if (childError?.code === 'ESRCH') return false
          throw childError
        }
      }
      throw error
    }
  }
  try {
    return child.kill(signal)
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function destroyStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue
    if (!stream.destroyed) stream.destroy()
    stream.removeAllListeners()
  }
}

export function isIgnorablePostCloseProcessGroupError(error) {
  // ESRCH means the group is already gone. On macOS, a post-close sweep can
  // instead report EPERM after the owned group leader has exited and its last
  // descendant is no longer signalable by this process. The initial TERM/KILL
  // paths remain strict; this exception applies only to the redundant sweep.
  return error?.code === 'ESRCH' || error?.code === 'EPERM'
}

export function sweepRemainingTestProcessGroup(
  child,
  killProcessGroup,
  signalProcess = process.kill,
) {
  if (!killProcessGroup || process.platform === 'win32' || !child.pid) return false
  try {
    signalProcess(-child.pid, 'SIGKILL')
    return true
  } catch (error) {
    if (isIgnorablePostCloseProcessGroupError(error)) return false
    throw error
  }
}

/**
 * Close a test child deterministically. Call `trackTestChild` immediately
 * after spawn so an early close cannot be missed.
 *
 * For a POSIX child spawned with `detached: true`, set `killProcessGroup` so
 * TERM/KILL reaches Electron renderer/helper descendants as well as the host.
 */
async function stopTestChildOnce(
  child,
  {
    graceMs = 5_000,
    killMs = 5_000,
    killProcessGroup = false,
    signalProcess = process.kill,
  } = {},
) {
  const closePromise = trackTestChild(child)
  const state = childCloseStates.get(child)
  if (state.closed) {
    destroyStdio(child)
    const groupSwept = sweepRemainingTestProcessGroup(child, killProcessGroup, signalProcess)
    return { ...state.result, escalated: false, groupSwept }
  }

  try {
    child.stdin?.end()
  } catch {}
  signalTestChild(child, 'SIGTERM', killProcessGroup, signalProcess)

  const gracefulClose = await boundedClose(closePromise, graceMs)
  if (gracefulClose) {
    destroyStdio(child)
    const groupSwept = sweepRemainingTestProcessGroup(child, killProcessGroup, signalProcess)
    return { ...gracefulClose, escalated: false, groupSwept }
  }

  signalTestChild(child, 'SIGKILL', killProcessGroup, signalProcess)
  const forcedClose = await boundedClose(closePromise, killMs)
  if (!forcedClose) {
    throw new Error(`child process ${child.pid ?? 'unknown'} did not close after SIGKILL`)
  }
  destroyStdio(child)
  const groupSwept = sweepRemainingTestProcessGroup(child, killProcessGroup, signalProcess)
  return { ...forcedClose, escalated: true, groupSwept }
}

export function stopTestChild(child, options = {}) {
  const existing = childStopPromises.get(child)
  if (existing) return existing
  const stopping = stopTestChildOnce(child, options)
  childStopPromises.set(child, stopping)
  return stopping
}
