type PendingEffect<Value> = {
  value: Value
  generation: number
}

type WorkspaceEffectEntry<Value> = {
  running: boolean
  pending: PendingEffect<Value> | null
  idleWaiters: Set<() => void>
}

export type WorkspaceEffectContext = {
  isActive: () => boolean
}

/**
 * Runs at most one derived effect per workspace and coalesces queued work to
 * the newest value. Saves do not await this lane, so slow relay I/O cannot
 * hold the renderer's persistence acknowledgement open.
 */
export class WorkspaceLatestEffectQueue<Value> {
  private readonly entries = new Map<string, WorkspaceEffectEntry<Value>>()
  private readonly runEffect: (
    workspaceId: string,
    value: Value,
    context: WorkspaceEffectContext,
  ) => Promise<void>
  private readonly onError: (workspaceId: string, error: unknown) => void
  private active = true
  private generation = 0

  constructor(
    runEffect: (
      workspaceId: string,
      value: Value,
      context: WorkspaceEffectContext,
    ) => Promise<void>,
    onError: (workspaceId: string, error: unknown) => void = () => {},
  ) {
    this.runEffect = runEffect
    this.onError = onError
  }

  schedule(workspaceId: string, value: Value): boolean {
    if (!this.active) return false
    let entry = this.entries.get(workspaceId)
    if (!entry) {
      entry = {
        running: false,
        pending: null,
        idleWaiters: new Set(),
      }
      this.entries.set(workspaceId, entry)
    }
    entry.pending = { value, generation: this.generation }
    if (entry.running) return true
    entry.running = true
    void this.drain(workspaceId, entry)
    return true
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.generation += 1
    for (const entry of this.entries.values()) {
      entry.pending = null
    }
  }

  activate(): void {
    if (this.active) return
    this.active = true
    this.generation += 1
  }

  waitForIdle(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId)
    if (!entry) return Promise.resolve()
    return new Promise(resolve => {
      entry.idleWaiters.add(resolve)
    })
  }

  private async drain(
    workspaceId: string,
    entry: WorkspaceEffectEntry<Value>,
  ): Promise<void> {
    while (entry.pending) {
      const next = entry.pending
      entry.pending = null
      const context: WorkspaceEffectContext = {
        isActive: () => (
          this.active
          && this.generation === next.generation
          && this.entries.get(workspaceId) === entry
        ),
      }
      if (!context.isActive()) continue
      try {
        await this.runEffect(workspaceId, next.value, context)
      } catch (error) {
        try {
          this.onError(workspaceId, error)
        } catch {
          // Diagnostics must not poison later derived effects.
        }
      }
    }

    entry.running = false
    if (this.entries.get(workspaceId) === entry) {
      this.entries.delete(workspaceId)
    }
    for (const resolve of entry.idleWaiters) resolve()
    entry.idleWaiters.clear()
  }
}
