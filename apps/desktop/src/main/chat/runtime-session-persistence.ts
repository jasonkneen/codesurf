export interface RuntimeSessionPersistenceScope {
  workspaceId?: string | null
  cardId: string
}

export interface RuntimeSessionPersistenceBackend<State = unknown> {
  upsertRuntimeSession(
    workspaceId: string,
    cardId: string,
    state: State,
  ): Promise<unknown>
  clearRuntimeSession(workspaceId: string, cardId: string): Promise<unknown>
}

export interface RuntimeSessionPersistenceLease {
  key: string
  generation: number
}

function normalizedScope(scope: RuntimeSessionPersistenceScope): {
  workspaceId: string
  cardId: string
  key: string
} | null {
  const workspaceId = String(scope.workspaceId ?? '').trim()
  const cardId = String(scope.cardId ?? '').trim()
  if (!workspaceId || !cardId) return null
  return {
    workspaceId,
    cardId,
    key: JSON.stringify([workspaceId, cardId]),
  }
}

/**
 * Serialises daemon persistence per tile and tombstones every request object
 * from the generation preceding a clear. An already-running write completes
 * before the queued clear; queued or later callbacks from that old turn skip.
 */
export class RuntimeSessionPersistenceCoordinator<State = unknown> {
  private readonly backend: RuntimeSessionPersistenceBackend<State>
  private readonly generations = new Map<string, number>()
  private readonly requestBindings = new WeakMap<object, RuntimeSessionPersistenceLease>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(backend: RuntimeSessionPersistenceBackend<State>) {
    this.backend = backend
  }

  beginRequest(
    request: RuntimeSessionPersistenceScope & object,
    advanceGeneration = true,
  ): RuntimeSessionPersistenceLease | null {
    const scope = normalizedScope(request)
    if (!scope) return null
    const currentGeneration = this.generations.get(scope.key) ?? 0
    const generation = advanceGeneration ? currentGeneration + 1 : currentGeneration
    this.generations.set(scope.key, generation)
    const lease = {
      key: scope.key,
      generation,
    }
    this.requestBindings.set(request, lease)
    return lease
  }

  bindRequest(
    request: RuntimeSessionPersistenceScope & object,
    lease: RuntimeSessionPersistenceLease | null,
  ): boolean {
    const scope = normalizedScope(request)
    if (!scope || !lease || lease.key !== scope.key) return false
    this.requestBindings.set(request, lease)
    return true
  }

  upsert(request: RuntimeSessionPersistenceScope & object, state: State): Promise<void> {
    const scope = normalizedScope(request)
    if (!scope) return Promise.resolve()

    const binding = this.requestBindings.get(request)
    // Derived or forgotten request objects must be explicitly bound to the
    // entry-time lease. Auto-enrolling here would let a pre-clear turn join the
    // post-clear generation and resurrect its state.
    if (!binding || binding.key !== scope.key) return Promise.resolve()

    const requestGeneration = binding.generation
    return this.enqueue(scope.key, async () => {
      if ((this.generations.get(scope.key) ?? 0) !== requestGeneration) return
      await this.backend.upsertRuntimeSession(scope.workspaceId, scope.cardId, state)
    })
  }

  clear(scopeValue: RuntimeSessionPersistenceScope): Promise<void> {
    const scope = normalizedScope(scopeValue)
    if (!scope) return Promise.resolve()

    this.generations.set(scope.key, (this.generations.get(scope.key) ?? 0) + 1)
    return this.enqueue(scope.key, async () => {
      await this.backend.clearRuntimeSession(scope.workspaceId, scope.cardId)
    })
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(task)
    this.queues.set(key, current)
    const cleanup = (): void => {
      if (this.queues.get(key) === current) this.queues.delete(key)
    }
    void current.then(cleanup, cleanup)
    return current
  }
}
