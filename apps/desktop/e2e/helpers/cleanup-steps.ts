export interface CleanupTimers {
  setTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> | number
  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void
}

const defaultTimers: CleanupTimers = {
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: handle => clearTimeout(handle),
}

export type AsyncCleanupStep = {
  label: string
  run: () => Promise<void>
}

export type IsolatedElectronCleanup = {
  homeDir: string
  closeApp?: () => Promise<void>
  stopDaemon: () => Promise<void>
  removeHome: () => Promise<void>
}

export function withCleanupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  timers: CleanupTimers = defaultTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = timers.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    promise.then(
      value => {
        timers.clearTimeout(timeout)
        resolve(value)
      },
      error => {
        timers.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

/**
 * Run every cleanup step even if an earlier step fails. This is important for
 * E2E launches: an Electron close failure must never skip daemon shutdown or
 * deletion of the isolated home directory.
 */
export async function runCleanupSteps(steps: readonly AsyncCleanupStep[]): Promise<void> {
  const errors: Error[] = []
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      errors.push(new Error(`${step.label}: ${cause.message}`, { cause }))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to clean up isolated Electron E2E launch: ${errors.map(error => error.message).join('; ')}`,
    )
  }
}

/**
 * Preserve daemon pid/token evidence when shutdown cannot be confirmed. App
 * close failures still proceed to daemon shutdown, but removing the isolated
 * home is safe only after the daemon is known to be stopped.
 */
export async function runIsolatedElectronCleanup(cleanup: IsolatedElectronCleanup): Promise<void> {
  let daemonStopped = false
  try {
    await runCleanupSteps([
      ...(cleanup.closeApp ? [{ label: 'close Electron app', run: cleanup.closeApp }] : []),
      {
        label: 'stop isolated daemon',
        run: async () => {
          await cleanup.stopDaemon()
          daemonStopped = true
        },
      },
      {
        label: 'remove isolated home',
        run: async () => {
          if (!daemonStopped) return
          await cleanup.removeHome()
        },
      },
    ])
  } catch (error) {
    if (!daemonStopped && error instanceof AggregateError) {
      throw new AggregateError(
        error.errors,
        `Failed to clean up isolated Electron E2E launch; preserved ${cleanup.homeDir}`,
      )
    }
    throw error
  }
}
