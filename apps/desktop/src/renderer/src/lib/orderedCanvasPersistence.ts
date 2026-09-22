export type PersistenceTimerHandle = ReturnType<typeof setTimeout> | number

export interface PersistenceTimers {
  setTimeout(callback: () => void, delayMs: number): PersistenceTimerHandle
  clearTimeout(handle: PersistenceTimerHandle): void
}

export type PersistenceMode = 'debounced' | 'immediate' | 'disabled'
export type PersistenceFlushOptions = {
  force?: boolean
}

export type PersistenceState = {
  dirty: boolean
  dirtyGeneration: number
  persistedGeneration: number
  failedGeneration: number | null
  failure: unknown | null
}

const defaultTimers: PersistenceTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle),
}

type PendingWrite<T> = {
  generation: number
  createValue: () => T
}

/**
 * A debounced, single-file write queue. Writes run strictly in enqueue order,
 * including writes whose IPC promises overlap in wall-clock time. Dirty and
 * failed generations remain observable until the same or a newer generation
 * is durably written.
 */
export class OrderedDebouncedPersistence<T> {
  private timer: PersistenceTimerHandle | null = null
  private pending: PendingWrite<T> | null = null
  private tail: Promise<void> = Promise.resolve()
  private latestWrite: Promise<void> = Promise.resolve()
  private flushTail: Promise<void> = Promise.resolve()
  private immediateDrain: Promise<void> | null = null
  private queuedWrites = 0
  private generation = 0
  private dirtyGeneration = 0
  private persistedGeneration = 0
  private failedGeneration: number | null = null
  private failure: unknown | null = null
  private readonly write: (value: T) => Promise<void>
  private readonly delayMs: number
  private readonly timers: PersistenceTimers
  private readonly mode: PersistenceMode

  constructor(
    write: (value: T) => Promise<void>,
    delayMs: number,
    timers: PersistenceTimers = defaultTimers,
    mode: PersistenceMode = 'debounced',
  ) {
    this.write = write
    this.delayMs = delayMs
    this.timers = timers
    this.mode = mode
  }

  markDirty(): number {
    if (this.mode === 'disabled') return this.generation
    this.generation += 1
    this.dirtyGeneration = this.generation
    return this.generation
  }

  schedule(createValue: () => T): void {
    if (this.mode === 'disabled') return
    const generation = this.markDirty()
    const pending = { generation, createValue }
    if (this.mode === 'immediate') {
      // Native hosts cannot delay close for a renderer acknowledgement. Keep
      // at most one write in flight and one replaceable latest snapshot so a
      // long drag does not create an unbounded IPC/write chain.
      this.pending = pending
      this.startImmediateDrain()
      return
    }

    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.pending = pending
    this.timer = this.timers.setTimeout(() => {
      const pending = this.pending
      // Clear timer and pending state before the async write starts. A flush
      // racing this callback will now wait for the in-flight queue.
      this.timer = null
      this.pending = null
      if (pending) void this.enqueue(pending).catch(() => {})
    }, this.delayMs)
  }

  hasPending(): boolean {
    return this.timer !== null
      || this.pending !== null
      || this.immediateDrain !== null
  }

  isDirty(): boolean {
    return this.dirtyGeneration > this.persistedGeneration
  }

  getState(): PersistenceState {
    return {
      dirty: this.isDirty(),
      dirtyGeneration: this.dirtyGeneration,
      persistedGeneration: this.persistedGeneration,
      failedGeneration: this.failedGeneration,
      failure: this.failure,
    }
  }

  async flush(
    createAuthoritativeValue?: () => T,
    options: PersistenceFlushOptions = {},
  ): Promise<void> {
    const operation = this.flushTail
      .catch(() => {})
      .then(() => this.flushNow(createAuthoritativeValue, options))
    this.flushTail = operation.catch(() => {})
    return operation
  }

  private async flushNow(
    createAuthoritativeValue: (() => T) | undefined,
    options: PersistenceFlushOptions,
  ): Promise<void> {
    if (this.mode === 'disabled') return
    const pendingFactory = this.pending?.createValue
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null

    // Observe any write that was already in flight. Its failure is recorded on
    // the generation and recovered below; success may make the flush a no-op.
    try {
      await this.immediateDrain
    } catch {}
    try {
      await this.latestWrite
    } catch {}

    const createValue = createAuthoritativeValue ?? pendingFactory
    if (options.force && !this.isDirty()) this.markDirty()
    while (this.isDirty()) {
      if (!createValue) {
        if (this.failedGeneration !== null) throw this.failure
        throw new Error('Cannot flush dirty persistence state without an authoritative value')
      }

      // A generation that already failed (for example when its debounce timer
      // fired) gets exactly one fresh authoritative retry. A pending generation
      // receives its first authoritative attempt plus one retry on failure.
      const generation = this.dirtyGeneration
      const attempts = this.failedGeneration === generation ? 1 : 2
      let succeeded = false
      let lastError: unknown
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await this.enqueue({ generation, createValue })
          succeeded = true
          break
        } catch (error) {
          lastError = error
        }
      }
      if (!succeeded) throw lastError

      // State may have changed while the write was in flight. Cancel its new
      // debounce timer and persist another fresh authoritative snapshot.
      if (this.timer !== null) {
        this.timers.clearTimeout(this.timer)
        this.timer = null
      }
      this.pending = null
    }
  }

  cancelPending(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const drain = this.immediateDrain
      if (drain) await drain
      const latestWrite = this.latestWrite
      await latestWrite
      if (
        this.immediateDrain === null
        && latestWrite === this.latestWrite
      ) {
        return
      }
    }
  }

  canEvict(): boolean {
    return this.mode === 'disabled'
      || (
        !this.isDirty()
        && this.timer === null
        && this.pending === null
        && this.immediateDrain === null
        && this.queuedWrites === 0
      )
  }

  private startImmediateDrain(): void {
    if (this.immediateDrain || this.mode !== 'immediate') return
    const drain = Promise.resolve().then(async () => {
      let lastError: unknown | null = null
      while (this.pending) {
        const pending = this.pending
        this.pending = null
        try {
          await this.enqueue(pending)
          lastError = null
        } catch (error) {
          // Keep draining a newer coalesced snapshot. If none exists, surface
          // the failure through waitForIdle/flush while retaining dirty state.
          lastError = error
        }
      }
      if (lastError !== null) throw lastError
    })
    this.immediateDrain = drain
    void drain
      .catch(() => {})
      .finally(() => {
        if (this.immediateDrain === drain) this.immediateDrain = null
        if (this.pending) this.startImmediateDrain()
      })
  }

  private enqueue(pending: PendingWrite<T>): Promise<void> {
    this.queuedWrites += 1
    const write = this.tail
      .catch(() => {})
      .then(() => this.write(pending.createValue()))
      .then(() => {
        this.persistedGeneration = Math.max(this.persistedGeneration, pending.generation)
        if (
          this.failedGeneration !== null
          && this.failedGeneration <= pending.generation
        ) {
          this.failedGeneration = null
          this.failure = null
        }
      })
      .catch(error => {
        if (
          pending.generation >= this.persistedGeneration
          && (this.failedGeneration === null || pending.generation >= this.failedGeneration)
        ) {
          this.failedGeneration = pending.generation
          this.failure = error
        }
        throw error
      })
      .finally(() => {
        this.queuedWrites -= 1
      })
    // Explicit waits observe this uncaught promise. The caught tail exists
    // only to let a later authoritative write recover and proceed in order.
    this.latestWrite = write
    this.tail = write.catch(() => {})
    return write
  }
}

/**
 * Keeps dirty, failed, pending, and persisted generations independent for
 * every workspace artifact. A successful write for workspace B must never
 * clear a failed generation belonging to workspace A.
 */
export class WorkspaceOrderedPersistence<T> {
  private readonly entries = new Map<string, OrderedDebouncedPersistence<T>>()
  private readonly write: (workspaceId: string, value: T) => Promise<void>
  private readonly delayMs: number
  private readonly timers: PersistenceTimers
  private readonly mode: PersistenceMode

  constructor(
    write: (workspaceId: string, value: T) => Promise<void>,
    delayMs: number,
    timers: PersistenceTimers = defaultTimers,
    mode: PersistenceMode = 'debounced',
  ) {
    this.write = write
    this.delayMs = delayMs
    this.timers = timers
    this.mode = mode
  }

  forWorkspace(workspaceId: string): OrderedDebouncedPersistence<T> {
    const existing = this.entries.get(workspaceId)
    if (existing) return existing
    const persistence = new OrderedDebouncedPersistence<T>(
      value => this.write(workspaceId, value),
      this.delayMs,
      this.timers,
      this.mode,
    )
    this.entries.set(workspaceId, persistence)
    return persistence
  }

  evictWorkspace(workspaceId: string): boolean {
    const persistence = this.entries.get(workspaceId)
    if (!persistence) return true
    if (!persistence.canEvict()) return false
    persistence.cancelPending()
    this.entries.delete(workspaceId)
    return true
  }

  entryCount(): number {
    return this.entries.size
  }

  cancelPending(): void {
    for (const persistence of this.entries.values()) {
      persistence.cancelPending()
    }
  }
}

export async function awaitCanvasBeforeWorkspaceSwitch(
  outgoingWorkspaceId: string | null,
  flushPendingSave: (workspaceId: string) => Promise<void>,
): Promise<void> {
  if (!outgoingWorkspaceId) return
  await flushPendingSave(outgoingWorkspaceId)
}
