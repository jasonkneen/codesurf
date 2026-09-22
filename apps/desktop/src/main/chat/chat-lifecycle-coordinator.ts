import {
  ChatPreparationFence,
  type ChatPreparationLease,
} from './chat-preparation-fence.ts'

export type ChatLifecycleRunMode = 'foreground' | 'background'

/**
 * Linearizes chat sends and lifecycle teardown per workspace/card. Lifecycle
 * entry invalidates preparation synchronously, before it joins the FIFO, so an
 * in-flight preparation cannot dispatch while stop/clear/dispose is waiting.
 */
export class ChatLifecycleCoordinator {
  private readonly fence: ChatPreparationFence
  private readonly queues = new Map<string, Promise<void>>()

  constructor(fence = new ChatPreparationFence()) {
    this.fence = fence
  }

  runSend<T>(
    scopeKey: string,
    mode: ChatLifecycleRunMode,
    operation: (lease: ChatPreparationLease) => Promise<T> | T,
  ): Promise<T> {
    // Reserve synchronously: a foreground replacement must tombstone an older
    // adapter while that adapter is still suspended in asynchronous setup,
    // rather than waiting for the older FIFO operation to finish first.
    const lease = this.fence.begin(scopeKey, mode)
    return this.enqueue(scopeKey, () => operation(lease))
  }

  runLifecycle<T>(
    scopeKey: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.fence.invalidate(scopeKey)
    return this.enqueue(scopeKey, operation)
  }

  isCurrent(lease: ChatPreparationLease): boolean {
    return this.fence.isCurrent(lease)
  }

  private enqueue<T>(scopeKey: string, operation: () => Promise<T> | T): Promise<T> {
    const prior = this.queues.get(scopeKey) ?? Promise.resolve()
    const result = prior.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(scopeKey, tail)
    void tail.finally(() => {
      if (this.queues.get(scopeKey) === tail) this.queues.delete(scopeKey)
    })
    return result
  }
}
