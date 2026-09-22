import type {
  CodesurfRelay,
  RelayAgentExecutor,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayOperationContext,
  RelayParticipant,
  RelayRuntimeOptions,
  RelaySpawnRequest,
  RelayTurnInput,
  RelayWorkContext,
} from '../../../packages/codesurf-relay/src/index.ts'
import type { TileState } from '../../shared/types'

export type RelayOperationGuard = {
  isActive: () => boolean
}

type RelayRuntimeLike = {
  spawn(request: RelaySpawnRequest): Promise<RelayParticipant>
  stop(participantId: string): Promise<void>
  destroy(): void | Promise<void>
}

export type WorkspaceRelayInstance = {
  relay: CodesurfRelay
  runtime: RelayRuntimeLike
  unsubscribe: () => void
  generation: number
  disposed: boolean
  disposePromise: Promise<void> | null
}

export type WorkspaceRelayServiceDependencies = {
  createRelay: (workspacePath: string) => CodesurfRelay
  createRuntime: (
    relay: CodesurfRelay,
    options: RelayRuntimeOptions,
  ) => RelayRuntimeLike
  createExecutor: (
    participant: RelayParticipant,
    request: RelaySpawnRequest,
  ) => RelayAgentExecutor
  readTileState: (workspaceId: string, tileId: string) => Promise<any | null>
  broadcast: (event: RelayEvent, workspacePath: string) => void
}

type RelayLifecycleGuard = RelayOperationGuard & {
  generation: number
  signal: AbortSignal
}

export class RelayOperationCancelledError extends Error {
  constructor() {
    super('Relay operation was cancelled during lifecycle transition')
    this.name = 'RelayOperationCancelledError'
  }
}

export class WorkspaceRelayService {
  private readonly dependencies: WorkspaceRelayServiceDependencies
  private readonly instances = new Map<string, WorkspaceRelayInstance>()
  private generation = 0
  private active = false
  private abortController: AbortController | null = null
  private readonly pendingDisposals = new Set<Promise<void>>()

  constructor(dependencies: WorkspaceRelayServiceDependencies) {
    this.dependencies = dependencies
  }

  start(): void {
    if (this.active) return
    this.generation += 1
    this.abortController = new AbortController()
    this.active = true
  }

  captureGeneration(): number | null {
    return this.active ? this.generation : null
  }

  isGenerationActive(generation: number): boolean {
    return this.active && this.generation === generation
  }

  activeInstanceCount(): number {
    return this.instances.size
  }

  async getWorkspaceRelay(
    workspacePath: string,
    guard?: RelayOperationGuard,
  ): Promise<WorkspaceRelayInstance> {
    const lifecycleGuard = this.captureOperationGuard(guard)
    const instance = await this.getWorkspaceRelayForGuard(
      workspacePath,
      lifecycleGuard,
    )
    this.assertActive(lifecycleGuard)
    return instance
  }

  async syncWorkspaceRelayParticipants(
    workspaceId: string,
    workspacePath: string,
    tiles: TileState[],
    guard?: RelayOperationGuard,
  ): Promise<RelayParticipant[]> {
    let lifecycleGuard: RelayLifecycleGuard
    try {
      lifecycleGuard = this.captureOperationGuard(guard)
    } catch (error) {
      if (error instanceof RelayOperationCancelledError) return []
      throw error
    }

    try {
      const { relay } = await this.getWorkspaceRelayForGuard(
        workspacePath,
        lifecycleGuard,
      )
      const operationContext = this.createRelayOperationContext(lifecycleGuard)
      const seen = new Set<string>()

      for (const tile of tiles) {
        if (tile.type !== 'chat') continue
        const tileState = await this.awaitGuarded(
          () => this.dependencies.readTileState(workspaceId, tile.id),
          lifecycleGuard,
        )
        const provider = tileState?.provider ?? 'claude'
        const model = tileState?.model ?? undefined
        const agentMode = Boolean(tileState?.agentMode)
        const name = (tileState?.title as string | undefined)
          ?? `Agent ${tile.id.slice(-4)}`

        seen.add(tile.id)
        await this.awaitGuarded(
          () => relay.upsertParticipant({
            id: tile.id,
            name,
            kind: 'agent',
            status: agentMode ? 'ready' : 'stopped',
            tileId: tile.id,
            provider,
            model,
            channels: [],
            metadata: {
              tileType: tile.type,
              x: tile.x,
              y: tile.y,
              width: tile.width,
              height: tile.height,
              agentMode,
            },
          }, operationContext),
          lifecycleGuard,
        )
      }

      const existing = await this.awaitGuarded(
        () => relay.listParticipants(),
        lifecycleGuard,
      )
      const stale = existing.filter(participant => (
        participant.kind === 'agent'
        && participant.tileId
        && !seen.has(participant.tileId)
      ))
      for (const participant of stale) {
        await this.awaitGuarded(
          () => relay.setParticipantStatus(
            participant.id,
            'stopped',
            operationContext,
          ),
          lifecycleGuard,
        )
      }

      return await this.awaitGuarded(
        () => relay.listParticipants(),
        lifecycleGuard,
      )
    } catch (error) {
      if (error instanceof RelayOperationCancelledError) return []
      throw error
    }
  }

  async spawnWorkspaceRelayAgent(
    workspacePath: string,
    request: RelaySpawnRequest,
  ): Promise<RelayParticipant> {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ runtime }) => runtime.spawn(request),
    )
  }

  async stopWorkspaceRelayAgent(
    workspacePath: string,
    participantId: string,
  ): Promise<void> {
    await this.withWorkspaceRelay(
      workspacePath,
      ({ runtime }) => runtime.stop(participantId),
    )
  }

  async sendWorkspaceDirectRelayMessage(
    workspacePath: string,
    from: string,
    draft: RelayDirectMessageDraft,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.sendDirectMessage(
        from,
        draft,
        this.createRelayOperationContext(guard),
      ),
    )
  }

  async sendWorkspaceChannelRelayMessage(
    workspacePath: string,
    from: string,
    draft: RelayChannelMessageDraft,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.sendChannelMessage(
        from,
        draft,
        this.createRelayOperationContext(guard),
      ),
    )
  }

  async listWorkspaceRelayParticipants(workspacePath: string) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }) => relay.listParticipants(),
    )
  }

  async listWorkspaceRelayChannels(workspacePath: string) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }) => relay.listChannels(),
    )
  }

  async listWorkspaceRelayCentralFeed(
    workspacePath: string,
    limit?: number,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }) => relay.listCentralFeed(limit),
    )
  }

  async listWorkspaceRelayMessages(
    workspacePath: string,
    participantId: string,
    mailbox: 'inbox' | 'sent' | 'memory' | 'bin',
    limit?: number,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }) => relay.listMessages(participantId, mailbox, limit),
    )
  }

  async readWorkspaceRelayMessage(
    workspacePath: string,
    participantId: string,
    mailbox: 'inbox' | 'sent' | 'memory' | 'bin',
    filename: string,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }) => relay.readParticipantMessage(
        participantId,
        mailbox,
        filename,
      ),
    )
  }

  async updateWorkspaceRelayMessageStatus(
    workspacePath: string,
    participantId: string,
    mailbox: 'inbox' | 'sent' | 'memory' | 'bin',
    filename: string,
    status: 'unread' | 'read' | 'sent' | 'archived',
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.updateMessageStatus(
        participantId,
        mailbox,
        filename,
        status,
        this.createRelayOperationContext(guard),
      ),
    )
  }

  async moveWorkspaceRelayMessage(
    workspacePath: string,
    participantId: string,
    fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin',
    toMailbox: 'inbox' | 'sent' | 'memory' | 'bin',
    filename: string,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.moveMessage(
        participantId,
        fromMailbox,
        toMailbox,
        filename,
        this.createRelayOperationContext(guard),
      ),
    )
  }

  async setWorkspaceRelayWorkContext(
    workspacePath: string,
    participantId: string,
    work: RelayWorkContext,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.updateWorkContext(
        participantId,
        work,
        this.createRelayOperationContext(guard),
      ),
    )
  }

  async analyzeWorkspaceRelayRelationships(workspacePath: string) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }) => relay.analyzeRelationships(),
    )
  }

  async waitForWorkspaceRelayReady(
    workspacePath: string,
    ids: string[],
    timeoutMs?: number,
  ): Promise<boolean> {
    await this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.waitForReady(
        ids,
        { timeoutMs },
        this.createRelayOperationContext(guard),
      ),
    )
    return true
  }

  async waitForWorkspaceRelayAny(
    workspacePath: string,
    ids: string[],
    timeoutMs?: number,
  ) {
    return this.withWorkspaceRelay(
      workspacePath,
      ({ relay }, guard) => relay.waitForAny(
        ids,
        { timeoutMs },
        this.createRelayOperationContext(guard),
      ),
    )
  }

  async stopAll(): Promise<void> {
    this.active = false
    this.abortController?.abort()
    this.abortController = null
    const instances = [...this.instances.values()]
    this.instances.clear()
    const disposals = instances.map(instance => this.disposeInstance(instance))
    const results = await Promise.allSettled(
      new Set([...this.pendingDisposals, ...disposals]),
    )
    const errors = results.flatMap(result => (
      result.status === 'rejected' ? [result.reason] : []
    ))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Multiple relay runtimes failed during shutdown',
      )
    }
  }

  private captureOperationGuard(
    guard?: RelayOperationGuard,
  ): RelayLifecycleGuard {
    const generation = this.captureGeneration()
    const signal = this.abortController?.signal
    if (generation === null || !signal) {
      throw new RelayOperationCancelledError()
    }
    const lifecycleGuard: RelayLifecycleGuard = {
      generation,
      signal,
      isActive: () => (
        this.isGenerationActive(generation)
        && (guard?.isActive() ?? true)
      ),
    }
    this.assertActive(lifecycleGuard)
    return lifecycleGuard
  }

  private assertActive(guard: RelayOperationGuard): void {
    if (!guard.isActive()) throw new RelayOperationCancelledError()
  }

  private createRelayOperationContext(
    guard: RelayLifecycleGuard,
  ): RelayOperationContext {
    return {
      assertActive: () => this.assertActive(guard),
      signal: guard.signal,
    }
  }

  private async awaitGuarded<T>(
    operation: () => Promise<T>,
    guard: RelayLifecycleGuard,
  ): Promise<T> {
    this.assertActive(guard)
    let cancel!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new RelayOperationCancelledError())
    })
    guard.signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await Promise.race([operation(), cancelled])
      this.assertActive(guard)
      return result
    } catch (error) {
      this.assertActive(guard)
      throw error
    } finally {
      guard.signal.removeEventListener('abort', cancel)
    }
  }

  private createGuardedExecutor(
    participant: RelayParticipant,
    request: RelaySpawnRequest,
    guard: RelayLifecycleGuard,
  ): RelayAgentExecutor {
    this.assertActive(guard)
    const executor = this.dependencies.createExecutor(participant, request)
    this.assertActive(guard)
    return {
      runTurn: async (
        input: RelayTurnInput,
        signal?: AbortSignal,
      ): Promise<string> => {
        this.assertActive(guard)
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new RelayOperationCancelledError()
        }
        const linkedController = new AbortController()
        const abortFromRuntime = (): void => {
          linkedController.abort(
            signal?.reason instanceof Error
              ? signal.reason
              : new RelayOperationCancelledError(),
          )
        }
        const abortFromService = (): void => {
          linkedController.abort(new RelayOperationCancelledError())
        }
        signal?.addEventListener('abort', abortFromRuntime, { once: true })
        guard.signal.addEventListener('abort', abortFromService, { once: true })
        if (signal?.aborted) abortFromRuntime()
        if (guard.signal.aborted) abortFromService()
        try {
          const result = await executor.runTurn(
            input,
            linkedController.signal,
          )
          this.assertActive(guard)
          if (signal?.aborted) abortFromRuntime()
          if (linkedController.signal.aborted) {
            throw linkedController.signal.reason
          }
          return result
        } finally {
          signal?.removeEventListener('abort', abortFromRuntime)
          guard.signal.removeEventListener('abort', abortFromService)
        }
      },
    }
  }

  private async getWorkspaceRelayForGuard(
    workspacePath: string,
    guard: RelayLifecycleGuard,
  ): Promise<WorkspaceRelayInstance> {
    this.assertActive(guard)
    const existing = this.instances.get(workspacePath)
    if (existing && existing.generation === guard.generation) {
      this.assertActive(guard)
      return existing
    }
    if (existing) {
      this.instances.delete(workspacePath)
      await this.disposeInstance(existing)
    }

    const relay = this.dependencies.createRelay(workspacePath)
    this.assertActive(guard)
    await this.awaitGuarded(
      () => relay.init(this.createRelayOperationContext(guard)),
      guard,
    )

    const raced = this.instances.get(workspacePath)
    if (raced && raced.generation === guard.generation) {
      this.assertActive(guard)
      return raced
    }
    if (raced) {
      this.instances.delete(workspacePath)
      await this.disposeInstance(raced)
    }

    let runtime: RelayRuntimeLike | null = null
    let unsubscribe: (() => void) | null = null
    let published: WorkspaceRelayInstance | null = null
    try {
      this.assertActive(guard)
      runtime = this.dependencies.createRuntime(relay, {
        executorFactory: (participant, request) => (
          this.createGuardedExecutor(participant, request, guard)
        ),
        assertActive: () => this.assertActive(guard),
      })
      this.assertActive(guard)
      unsubscribe = relay.on(event => {
        if (guard.isActive()) this.dependencies.broadcast(event, workspacePath)
      })
      this.assertActive(guard)

      published = {
        relay,
        runtime,
        unsubscribe,
        generation: guard.generation,
        disposed: false,
        disposePromise: null,
      }
      this.assertActive(guard)
      this.instances.set(workspacePath, published)
      this.assertActive(guard)
      return published
    } catch (error) {
      if (published && this.instances.get(workspacePath) === published) {
        this.instances.delete(workspacePath)
      }
      if (published) {
        await this.disposeInstance(published)
      } else {
        try {
          unsubscribe?.()
        } catch {}
        try {
          await runtime?.destroy()
        } catch {}
      }
      throw error
    }
  }

  private async withWorkspaceRelay<T>(
    workspacePath: string,
    operation: (
      instance: WorkspaceRelayInstance,
      guard: RelayLifecycleGuard,
    ) => Promise<T>,
  ): Promise<T> {
    const guard = this.captureOperationGuard()
    const instance = await this.getWorkspaceRelayForGuard(workspacePath, guard)
    this.assertActive(guard)
    return this.awaitGuarded(() => operation(instance, guard), guard)
  }

  private disposeInstance(instance: WorkspaceRelayInstance): Promise<void> {
    if (instance.disposePromise) return instance.disposePromise
    instance.disposed = true
    try {
      instance.unsubscribe()
    } catch {}
    const disposePromise = Promise.resolve()
      .then(() => instance.runtime.destroy())
      .then(() => undefined)
    instance.disposePromise = disposePromise
    this.pendingDisposals.add(disposePromise)
    void disposePromise.finally(() => {
      this.pendingDisposals.delete(disposePromise)
    }).catch(() => {})
    return disposePromise
  }
}
