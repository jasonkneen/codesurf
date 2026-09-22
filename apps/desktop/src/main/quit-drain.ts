export interface QuitDrain {
  name: string
  run(): Promise<void>
}

export interface QuitDrainFailure {
  name: string
  code: 'failed' | 'timeout' | 'reenter_failed'
}

export interface BeforeQuitEventLike {
  preventDefault(): void
}

export interface QuitDrainCoordinator {
  beforeQuit(event: BeforeQuitEventLike): 'intercepted' | 'pass-through'
  getState(): 'idle' | 'draining' | 'reentering' | 'complete'
}

export interface QuitDrainCoordinatorOptions {
  drains: readonly QuitDrain[]
  timeoutMs: number
  requestQuit(): void
  onFailure?: (failure: QuitDrainFailure) => void
  timeout?: (timeoutMs: number) => Promise<void>
}

export type QuitDrainRunOptions = Omit<QuitDrainCoordinatorOptions, 'requestQuit'>

function defaultTimeout(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const handle = setTimeout(resolve, timeoutMs)
    handle.unref?.()
  })
}

function validateDrainOptions(options: QuitDrainRunOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer')
  }
  const names = new Set<string>()
  for (const drain of options.drains) {
    if (!drain.name || names.has(drain.name)) {
      throw new TypeError('quit drain names must be non-empty and unique')
    }
    names.add(drain.name)
  }
}

function reportDrainFailure(
  observer: QuitDrainRunOptions['onFailure'],
  failure: QuitDrainFailure,
): void {
  try {
    observer?.(failure)
  } catch {
    // Failure observers cannot prevent the bounded quit policy.
  }
}

export async function runQuitDrains(options: QuitDrainRunOptions): Promise<void> {
  validateDrainOptions(options)
  const timeout = options.timeout ?? defaultTimeout
  const pending = new Set(options.drains.map(drain => drain.name))
  let acceptingFailures = true
  const drains = Promise.all(options.drains.map(async drain => {
    try {
      await drain.run()
    } catch {
      if (acceptingFailures) {
        reportDrainFailure(options.onFailure, { name: drain.name, code: 'failed' })
      }
    } finally {
      pending.delete(drain.name)
    }
  }))
  const outcome = await Promise.race([
    drains.then(() => 'drained' as const),
    timeout(options.timeoutMs).then(() => 'timeout' as const),
  ])
  acceptingFailures = false
  if (outcome === 'timeout') {
    for (const name of pending) {
      reportDrainFailure(options.onFailure, { name, code: 'timeout' })
    }
  }
}

export function createQuitDrainCoordinator(
  options: QuitDrainCoordinatorOptions,
): QuitDrainCoordinator {
  validateDrainOptions(options)
  let state: 'idle' | 'draining' | 'reentering' | 'complete' = 'idle'

  const report = (failure: QuitDrainFailure): void => {
    reportDrainFailure(options.onFailure, failure)
  }

  const startDrain = (): void => {
    void runQuitDrains({
      drains: options.drains,
      timeoutMs: options.timeoutMs,
      timeout: options.timeout,
      onFailure: failure => {
        if (state === 'draining') report(failure)
      },
    }).then(() => {
      if (state !== 'draining') return
      state = 'reentering'
      try {
        options.requestQuit()
      } catch {
        state = 'complete'
        report({ name: 'coordinator', code: 'reenter_failed' })
      }
    })
  }

  return {
    beforeQuit(event) {
      if (state === 'reentering') {
        state = 'complete'
        return 'pass-through'
      }
      if (state === 'complete') return 'pass-through'
      event.preventDefault()
      if (state === 'idle') {
        state = 'draining'
        startDrain()
      }
      return 'intercepted'
    },
    getState() {
      return state
    },
  }
}
