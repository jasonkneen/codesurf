import type { PersistenceMode } from './orderedCanvasPersistence'

export type WindowPersistenceReason = 'close' | 'quit' | 'reload' | 'force-reload'
export type WindowPersistenceRequest = {
  nonce: string
  reason: WindowPersistenceReason
  canvasOwner: boolean
}

export interface WindowPersistenceApi {
  onPersistenceRequest(callback: (request: WindowPersistenceRequest) => void): () => void
  persistenceReady(nonce: string): void
}

export type WindowPersistenceTask = (
  request: WindowPersistenceRequest,
) => void | Promise<void>

export function supportsWindowPersistenceBarrier(
  api: Partial<WindowPersistenceApi> | null | undefined,
): api is WindowPersistenceApi {
  return typeof api?.onPersistenceRequest === 'function'
    && typeof api?.persistenceReady === 'function'
}

export function resolveCanvasPersistenceMode(
  api: Partial<WindowPersistenceApi> | null | undefined,
  isMiniChat: boolean,
): PersistenceMode {
  if (isMiniChat) return 'disabled'
  return supportsWindowPersistenceBarrier(api) ? 'debounced' : 'immediate'
}

/**
 * One renderer-owned acknowledgement point with named, joinable persistence
 * tasks. Canvas registers today; chat and tile stores can join without adding
 * more main-process close acknowledgements.
 */
export class WindowPersistenceBarrier {
  private readonly tasks = new Map<string, WindowPersistenceTask>()
  private readonly handledNonces = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private readonly onTaskError: (name: string, error: unknown) => void

  constructor(
    onTaskError: (name: string, error: unknown) => void = (name, error) => {
      console.error(`[persistence] ${name} failed during window lifecycle transition:`, error)
    },
  ) {
    this.onTaskError = onTaskError
  }

  register(name: string, task: WindowPersistenceTask): () => void {
    this.tasks.set(name, task)
    return () => {
      if (this.tasks.get(name) === task) this.tasks.delete(name)
    }
  }

  start(api: WindowPersistenceApi): () => void {
    if (this.unsubscribe) return () => this.stop()
    this.unsubscribe = api.onPersistenceRequest(request => {
      const nonce = typeof request?.nonce === 'string' ? request.nonce : ''
      if (!nonce || this.handledNonces.has(nonce)) return
      this.handledNonces.add(nonce)
      const tasks = [...this.tasks.entries()]
      void Promise.allSettled(tasks.map(([, task]) => Promise.resolve().then(() => task(request))))
        .then(results => {
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              try {
                this.onTaskError(tasks[index][0], result.reason)
              } catch (error) {
                console.error('[persistence] failed to report window close error:', error)
              }
            }
          })
          api.persistenceReady(nonce)
        })
    })
    return () => this.stop()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}

const windowPersistenceBarrier = new WindowPersistenceBarrier()

export function registerWindowPersistenceTask(
  name: string,
  task: WindowPersistenceTask,
): () => void {
  return windowPersistenceBarrier.register(name, task)
}

export function startWindowPersistenceBarrier(api: WindowPersistenceApi): () => void {
  return windowPersistenceBarrier.start(api)
}
