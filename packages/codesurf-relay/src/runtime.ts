import type {
  RelayAgentExecutor,
  RelayAgentTurnOutput,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayMessage,
  RelayOperationContext,
  RelayParticipant,
  RelaySpawnRequest,
  RelayTurnInput,
} from './types'
import { CodesurfRelay } from './relay'
import {
  sanitizeForPrompt,
  isValidParticipantStatus,
  normalizeStringList,
  normalizeRelayImpacts,
} from './validation'

export interface RelayRuntimeOptions {
  executorFactory: (participant: RelayParticipant, spawn: RelaySpawnRequest) => RelayAgentExecutor
  turnTimeoutMs?: number
  assertActive?: () => void
}

export class RelayTimeoutError extends Error {
  constructor(participantId: string, timeoutMs: number) {
    super(`Agent ${participantId} turn timed out after ${timeoutMs}ms`)
    this.name = 'RelayTimeoutError'
  }
}

export class RelayRuntimeDisposedError extends Error {
  constructor() {
    super('Relay runtime was disposed during an active operation')
    this.name = 'RelayRuntimeDisposedError'
  }
}

export class RelayTurnCancelledError extends Error {
  readonly participantId: string
  readonly epoch: number

  constructor(participantId: string, epoch: number, reason: string) {
    super(`Agent ${participantId} turn ${epoch} was cancelled: ${reason}`)
    this.name = 'RelayTurnCancelledError'
    this.participantId = participantId
    this.epoch = epoch
  }
}

interface ActiveRuntimeTurn {
  epoch: number
  controller: AbortController
  providerTeardown: Promise<void>
}

interface ActiveRuntimeTick {
  epoch: number
  promise: Promise<void>
}

interface RuntimeAgentState {
  spawn: RelaySpawnRequest
  running: boolean
  ready: boolean
  executor: RelayAgentExecutor
  epoch: number
  pendingTick: boolean
  activeTurn: ActiveRuntimeTurn | null
  activeTick: ActiveRuntimeTick | null
  providerTeardowns: Set<Promise<void>>
  providerTeardownFailures: unknown[]
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```json\n([\s\S]*?)\n```/)
  if (fenced) return fenced[1]
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return raw.slice(start, end + 1)
  return raw
}

function sanitizeMessageForPrompt(msg: RelayMessage): { meta: RelayMessage['meta']; body: string; data?: Record<string, unknown> } {
  return {
    meta: msg.meta,
    body: sanitizeForPrompt(msg.body),
    data: msg.data,
  }
}

/**
 * Parse and VALIDATE a model turn.
 *
 * This was a bare JSON.parse + cast on top of a naive first-`{`/last-`}`
 * extraction, and its output is persisted: `work` flows into updateWorkContext
 * and `status` straight into setParticipantStatus. A single wrong type there
 * corrupts participant.json durably — `{"work":{"files":"src/App.tsx"}}` became
 * ["s","r","c",...] and emitted high-priority "same files" hints into every
 * peer's prompt. Coerce each field to its declared shape and drop the rest;
 * a malformed turn should lose its metadata, not poison the workspace.
 */
function parseTurnOutput(raw: string): RelayAgentTurnOutput {
  const json = extractJsonBlock(raw)
  const parsed: unknown = JSON.parse(json)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {} as RelayAgentTurnOutput
  }
  const value = parsed as Record<string, unknown>
  const out: Record<string, unknown> = { ...value }

  if (!isValidParticipantStatus(value.status)) delete out.status

  const work = value.work
  if (work && typeof work === 'object' && !Array.isArray(work)) {
    const w = work as Record<string, unknown>
    // Normalize ONLY keys the model actually sent. updateWorkContext resolves
    // each field as `work.x ?? participant.work?.x`, so materialising an absent
    // field as [] would clear previously-stored context instead of leaving it.
    const normalizedWork: Record<string, unknown> = { ...w }
    for (const key of ['files', 'topics', 'collaborators', 'blockers'] as const) {
      if (key in w) normalizedWork[key] = normalizeStringList(w[key])
    }
    if ('impacts' in w) normalizedWork.impacts = normalizeRelayImpacts(w.impacts)
    if ('summary' in w && typeof w.summary !== 'string') delete normalizedWork.summary
    out.work = normalizedWork
  } else if ('work' in out) {
    delete out.work
  }

  return out as RelayAgentTurnOutput
}

function isUnconfirmedProviderTermination(error: unknown): boolean {
  return (
    error instanceof Error
    && (error as Error & { reason?: unknown }).reason === 'termination'
  )
}

function throwTeardownFailures(
  failures: readonly unknown[],
  message: string,
): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

function buildPrompt(input: RelayTurnInput, task: string): string {
  const relationships = input.relationships.map(item => ({
    with: item.participants.find(id => id !== input.participant.id),
    priority: item.priority,
    summary: item.summary,
    overlappingFiles: item.overlappingFiles,
    sharedChannels: item.sharedChannels,
  }))

  return [
    `You are ${input.participant.name} in the CodeSurf relay runtime.`,
    `Your persistent task: ${sanitizeForPrompt(task, 32_000)}`,
    '',
    'You are coordinating work, surfacing dependencies, and telling others when your work could affect them.',
    'Messaging priority is NOT tied to spatial/canvas connections.',
    '',
    'Return JSON only with this schema:',
    '{',
    '  "ready": true,',
    '  "status": "ready|running|blocked|done|error",',
    '  "work": {',
    '    "summary": "what you are currently doing",',
    '    "branch": "optional git branch",',
    '    "worktreePath": "optional worktree path",',
    '    "files": ["optional file paths"],',
    '    "topics": ["optional topics"],',
    '    "collaborators": ["optional participant ids"],',
    '    "blockers": ["optional blockers"],',
    '    "impacts": [{"targetType":"agent|human|system","targetId":"optional","description":"impact","severity":"low|medium|high"}]',
    '  },',
    '  "messages": [',
    '    {"mode":"direct","to":"participantId","subject":"subject","body":"markdown body","priority":"low|normal|high|critical","kind":"request|reply|update|handoff|alert|memory|channel|system"},',
    '    {"mode":"channel","channel":"channelId","subject":"subject","body":"markdown body","priority":"low|normal|high|critical","kind":"channel|update|alert"}',
    '  ],',
    '  "memory": [{"subject":"short title","body":"markdown note"}]',
    '}',
    '',
    'Rules:',
    '- only send a message when there is a real coordination need',
    '- always mention branch/worktree/files if overlap or impact matters',
    '- if your work could affect a human or another agent, record it in work.impacts and usually send a message',
    '- use channels for shared-room updates, direct messages for targeted coordination',
    '- if nothing needs sending, return an empty messages array',
    '',
    'Current participant state:',
    JSON.stringify(input.participant, null, 2),
    '',
    'Unread direct messages:',
    '<<<BEGIN MESSAGES>>>',
    JSON.stringify(input.unreadDirectMessages.map(sanitizeMessageForPrompt), null, 2),
    '<<<END MESSAGES>>>',
    '',
    'Unread channel messages:',
    '<<<BEGIN MESSAGES>>>',
    JSON.stringify(input.unreadChannelMessages.map(sanitizeMessageForPrompt), null, 2),
    '<<<END MESSAGES>>>',
    '',
    'Relationship hints:',
    JSON.stringify(relationships, null, 2),
  ].join('\n')
}

export class RelayRuntime {
  private readonly relay: CodesurfRelay
  private readonly options: RelayRuntimeOptions
  private readonly operationContext: RelayOperationContext
  private readonly agents = new Map<string, RuntimeAgentState>()
  private readonly spawnRevisions = new Map<string, number>()
  private readonly unsubscribe: () => void
  private readonly cancelled: Promise<never>
  private cancel!: (error: Error) => void
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(relay: CodesurfRelay, options: RelayRuntimeOptions) {
    this.relay = relay
    this.options = options
    this.operationContext = {
      assertActive: () => this.assertActive(),
    }
    this.cancelled = new Promise<never>((_resolve, reject) => {
      this.cancel = reject
    })
    void this.cancelled.catch(() => {})
    this.unsubscribe = this.relay.on(event => {
      if (!this.isActive()) return
      void this.onRelayEvent(event).catch(error => {
        if (!this.isActive()) return
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.relay.events.emit('event', {
          type: 'error',
          timestamp: Date.now(),
          payload: { error: errorMessage },
        } satisfies RelayEvent)
      })
    })
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    const error = new RelayRuntimeDisposedError()
    this.destroyed = true
    const pending = new Set<Promise<void>>()
    for (const state of this.agents.values()) {
      state.running = false
      state.epoch += 1
      if (state.activeTurn) {
        state.activeTurn.controller.abort(error)
      }
      for (const providerTeardown of state.providerTeardowns) {
        pending.add(providerTeardown)
      }
      if (state.activeTick) {
        pending.add(state.activeTick.promise)
      }
    }
    this.cancel(error)
    this.unsubscribe()
    const priorFailures = [...this.agents.values()].flatMap(
      state => state.providerTeardownFailures,
    )
    this.destroyPromise = Promise.allSettled([...pending]).then(results => {
      const failures = [...new Set([
        ...priorFailures,
        ...results.flatMap(result => (
          result.status === 'rejected' ? [result.reason] : []
        )),
      ])]
      this.agents.clear()
      this.spawnRevisions.clear()
      throwTeardownFailures(
        failures,
        'Relay provider teardown failed during runtime disposal',
      )
    })
    return this.destroyPromise
  }

  async spawn(request: RelaySpawnRequest): Promise<RelayParticipant> {
    this.assertActive()
    const id = request.id ?? request.tileId ?? request.name
    const spawnRevision = (this.spawnRevisions.get(id) ?? 0) + 1
    this.spawnRevisions.set(id, spawnRevision)
    const spawnContext = this.createSpawnOperationContext(id, spawnRevision)
    const previous = this.agents.get(id)
    if (previous) {
      previous.running = false
      previous.epoch += 1
      const cancellation = new RelayTurnCancelledError(
        id,
        previous.epoch,
        'agent was replaced',
      )
      previous.activeTurn?.controller.abort(cancellation)
      await this.awaitAgentTeardown(previous)
      this.assertSpawnActive(id, spawnRevision)
      if (this.agents.get(id) === previous) this.agents.delete(id)
    }
    const participant = await this.awaitSpawnActive(
      () => this.relay.upsertParticipant({
        id,
        name: request.name,
        kind: 'agent',
        status: 'spawning',
        tileId: request.tileId,
        provider: request.provider ?? 'unknown',
        model: request.model,
        task: request.task,
        channels: request.channels ?? [],
        metadata: {
          ...(request.metadata ?? {}),
          relayMode: request.mode,
          relayThinking: request.thinking,
        },
      }, spawnContext),
      id,
      spawnRevision,
    )

    this.assertSpawnActive(id, spawnRevision)
    const executor = this.options.executorFactory(participant, { ...request, id })
    this.assertSpawnActive(id, spawnRevision)
    const state: RuntimeAgentState = {
      spawn: { ...request, id },
      running: true,
      ready: false,
      executor,
      epoch: 1,
      pendingTick: false,
      activeTurn: null,
      activeTick: null,
      providerTeardowns: new Set(),
      providerTeardownFailures: [],
    }
    this.agents.set(id, state)
    const epoch = state.epoch
    const participantContext = this.createParticipantOperationContext(
      id,
      state,
      epoch,
    )
    try {
      await this.awaitParticipantActive(
        () => this.relay.sendDirectMessage('system', {
          to: id,
          subject: 'Initial task',
          body: request.task,
          kind: 'system',
          priority: 'high',
          data: {
            relaySpawn: true,
            channels: request.channels ?? [],
            provider: request.provider,
            model: request.model,
          },
        }, participantContext),
        id,
        state,
        epoch,
      )

      await this.awaitParticipantActive(
        () => this.schedule(id),
        id,
        state,
        epoch,
        false,
      )
    } catch (error) {
      if (
        this.agents.get(id) === state
        && state.epoch === epoch
        && state.running
      ) {
        this.agents.delete(id)
      }
      throw error
    }
    this.assertParticipantActive(id, state, epoch, false)
    return participant
  }

  async stop(participantId: string): Promise<void> {
    this.assertActive()
    this.spawnRevisions.set(
      participantId,
      (this.spawnRevisions.get(participantId) ?? 0) + 1,
    )
    const state = this.agents.get(participantId)
    if (!state) return
    state.running = false
    const epoch = ++state.epoch
    state.activeTurn?.controller.abort(new RelayTurnCancelledError(
      participantId,
      epoch,
      'agent stopped',
    ))
    await this.awaitAgentTeardown(state)
    if (!this.isParticipantCurrent(participantId, state, epoch, false)) return
    const context = this.createParticipantOperationContext(
      participantId,
      state,
      epoch,
      false,
    )
    try {
      await this.relay.setParticipantStatus(
        participantId,
        'stopped',
        context,
      )
      this.assertParticipantActive(participantId, state, epoch, false)
    } catch (error) {
      if (!this.isParticipantCurrent(participantId, state, epoch, false)) return
      throw error
    }
  }

  async start(participantId: string): Promise<void> {
    this.assertActive()
    const state = this.agents.get(participantId)
    if (!state) return
    state.running = false
    const epoch = ++state.epoch
    state.activeTurn?.controller.abort(new RelayTurnCancelledError(
      participantId,
      epoch,
      'agent restarted',
    ))
    await this.awaitAgentTeardown(state)
    if (!this.isParticipantCurrent(participantId, state, epoch, false)) return
    state.ready = false
    state.running = true
    await this.awaitActive(() => this.schedule(participantId))
  }

  async schedule(participantId: string): Promise<void> {
    this.assertActive()
    const state = this.agents.get(participantId)
    if (!state || !state.running) return
    if (state.activeTick) {
      state.pendingTick = true
      await state.activeTick.promise
      return
    }
    const epoch = state.epoch
    let activeTick!: ActiveRuntimeTick
    let tickPromise!: Promise<void>
    tickPromise = (async () => {
      try {
        do {
          state.pendingTick = false
          const controller = new AbortController()
          const activeTurn: ActiveRuntimeTurn = {
            epoch,
            controller,
            providerTeardown: Promise.resolve(),
          }
          state.activeTurn = activeTurn
          try {
            await this.runAgentTickWithErrorHandling(
              participantId,
              state,
              epoch,
              activeTurn,
            )
          } finally {
            if (state.activeTurn === activeTurn) state.activeTurn = null
          }
        } while (
          state.pendingTick
          && this.isParticipantCurrent(participantId, state, epoch)
        )
      } finally {
        if (state.activeTick === activeTick) state.activeTick = null
      }
    })()
    activeTick = { epoch, promise: tickPromise }
    state.activeTick = activeTick
    await tickPromise
  }

  private async tick(
    participantId: string,
    state: RuntimeAgentState,
    epoch: number,
    activeTurn: ActiveRuntimeTurn,
  ): Promise<void> {
    const participantContext = this.createParticipantOperationContext(
      participantId,
      state,
      epoch,
    )
    const participant = await this.awaitParticipantActive(
      () => this.relay.getParticipant(participantId, this.operationContext),
      participantId,
      state,
      epoch,
    )
    if (!participant) return

    const unreadDirectMessages = await this.awaitParticipantActive(
      () => this.relay.listUnreadDirectMessages(participantId),
      participantId,
      state,
      epoch,
    )
    const unreadChannelMessages = await this.awaitParticipantActive(
      () => this.relay.listUnreadChannelMessages(participantId),
      participantId,
      state,
      epoch,
    )
    if (unreadDirectMessages.length === 0 && unreadChannelMessages.length === 0 && state.ready) return

    const relationships = (await this.awaitParticipantActive(
      () => this.relay.analyzeRelationships(),
      participantId,
      state,
      epoch,
    )).filter(hint => hint.participants.includes(participantId))
    const prompt = buildPrompt({
      participant,
      prompt: '',
      unreadDirectMessages,
      unreadChannelMessages,
      relationships,
    }, state.spawn.task)

    const input: RelayTurnInput = {
      participant,
      prompt,
      unreadDirectMessages,
      unreadChannelMessages,
      relationships,
    }
    await this.awaitParticipantActive(
      () => this.relay.setParticipantStatus(
        participantId,
        state.ready ? 'running' : 'spawning',
        participantContext,
      ),
      participantId,
      state,
      epoch,
    )

    const turnTimeoutMs = this.options.turnTimeoutMs ?? 300_000 // 5 minutes default
    const raw = await this.awaitParticipantActive(
      () => this.runTurnWithTimeout(
        participantId,
        state,
        input,
        turnTimeoutMs,
        activeTurn,
      ),
      participantId,
      state,
      epoch,
    )
    this.assertParticipantActive(participantId, state, epoch)
    const output = parseTurnOutput(raw)

    if (output.work) {
      await this.awaitParticipantActive(
        () => this.relay.updateWorkContext(
          participantId,
          output.work!,
          participantContext,
        ),
        participantId,
        state,
        epoch,
      )
    }

    if (!state.ready && (output.ready ?? true)) {
      this.assertParticipantActive(participantId, state, epoch)
      state.ready = true
      await this.awaitParticipantActive(
        () => this.relay.setParticipantStatus(
          participantId,
          output.status ?? 'ready',
          participantContext,
        ),
        participantId,
        state,
        epoch,
      )
    } else if (output.status) {
      await this.awaitParticipantActive(
        () => this.relay.setParticipantStatus(
          participantId,
          output.status!,
          participantContext,
        ),
        participantId,
        state,
        epoch,
      )
    }

    for (const message of output.messages ?? []) {
      this.assertParticipantActive(participantId, state, epoch)
      if (message.mode === 'direct') {
        const draft: RelayDirectMessageDraft = {
          to: message.to,
          subject: message.subject,
          body: message.body,
          kind: message.kind,
          priority: message.priority,
          threadId: message.threadId,
          replyToId: message.replyToId,
          data: message.data,
        }
        await this.awaitParticipantActive(
          () => this.relay.sendDirectMessage(
            participantId,
            draft,
            participantContext,
          ),
          participantId,
          state,
          epoch,
        )
      } else {
        const draft: RelayChannelMessageDraft = {
          channel: message.channel,
          subject: message.subject,
          body: message.body,
          kind: message.kind,
          priority: message.priority,
          threadId: message.threadId,
          replyToId: message.replyToId,
          data: message.data,
        }
        await this.awaitParticipantActive(
          () => this.relay.sendChannelMessage(
            participantId,
            draft,
            participantContext,
          ),
          participantId,
          state,
          epoch,
        )
      }
    }

    for (const memory of output.memory ?? []) {
      await this.awaitParticipantActive(
        () => this.relay.storeMemory(
          participantId,
          memory.subject,
          memory.body,
          memory.data,
          participantContext,
        ),
        participantId,
        state,
        epoch,
      )
    }

    if (unreadDirectMessages.length > 0) {
      await this.awaitParticipantActive(
        () => this.relay.markDirectMessagesRead(
          participantId,
          unreadDirectMessages,
          participantContext,
        ),
        participantId,
        state,
        epoch,
      )
    }
    if (unreadChannelMessages.length > 0) {
      const latestByChannel = new Map<string, number>()
      for (const message of unreadChannelMessages) {
        if (!message.meta.channel) continue
        latestByChannel.set(message.meta.channel, Math.max(latestByChannel.get(message.meta.channel) ?? 0, message.meta.createdTs))
      }
      for (const [channel, timestamp] of latestByChannel) {
        await this.awaitParticipantActive(
          () => this.relay.advanceChannelCursor(
            participantId,
            channel,
            timestamp,
            participantContext,
          ),
          participantId,
          state,
          epoch,
        )
      }
    }
  }

  private async onRelayEvent(event: RelayEvent): Promise<void> {
    this.assertActive()
    if (event.type === 'direct_message') {
      const target = (event.payload as { to: string }).to
      if (this.agents.has(target)) {
        await this.awaitActive(() => this.schedule(target))
      }
      return
    }

    if (event.type === 'channel_message') {
      const channel = (event.payload as { channel: string }).channel
      const participants = await this.awaitActive(
        () => this.relay.listParticipants(this.operationContext),
      )
      await this.awaitActive(
        () => Promise.all(participants
          .filter(participant => participant.channels.includes(channel))
          .map(participant => this.schedule(participant.id))),
      )
    }
  }

  private async runTurnWithTimeout(
    participantId: string,
    state: RuntimeAgentState,
    input: RelayTurnInput,
    timeoutMs: number,
    activeTurn: ActiveRuntimeTurn,
  ): Promise<string> {
    this.assertParticipantActive(participantId, state, activeTurn.epoch)
    const { controller } = activeTurn
    let providerTurn: Promise<string>
    try {
      providerTurn = Promise.resolve(
        state.executor.runTurn(input, controller.signal),
      )
    } catch (error) {
      providerTurn = Promise.reject(error)
    }
    const providerTeardown = providerTurn.then(
      () => undefined,
      error => {
        if (isUnconfirmedProviderTermination(error)) {
          state.providerTeardownFailures.push(error)
          throw error
        }
      },
    )
    activeTurn.providerTeardown = providerTeardown
    state.providerTeardowns.add(providerTeardown)
    void providerTeardown.then(
      () => {
        state.providerTeardowns.delete(providerTeardown)
      },
      () => {
        state.providerTeardowns.delete(providerTeardown)
      },
    )

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (
        outcome: { result: string } | { error: unknown },
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        if ('result' in outcome) {
          resolve(outcome.result)
        } else {
          reject(outcome.error)
        }
      }
      const onAbort = (): void => {
        finish({
          error: controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new RelayRuntimeDisposedError(),
        })
      }
      const timer = setTimeout(() => {
        controller.abort(new RelayTimeoutError(participantId, timeoutMs))
      }, timeoutMs)

      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
      void providerTurn.then(
        result => finish({ result }),
        error => finish({ error }),
      )
    })
  }

  private async runAgentTickWithErrorHandling(
    participantId: string,
    state: RuntimeAgentState,
    epoch: number,
    activeTurn: ActiveRuntimeTurn,
  ): Promise<void> {
    try {
      await this.awaitParticipantActive(
        () => this.tick(participantId, state, epoch, activeTurn),
        participantId,
        state,
        epoch,
      )
    } catch (error) {
      if (
        this.isExpectedTurnCancellation(error)
        || !this.isParticipantCurrent(participantId, state, epoch)
      ) {
        return
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.assertParticipantActive(participantId, state, epoch)
      this.relay.events.emit('event', {
        type: 'error',
        timestamp: Date.now(),
        payload: { participantId, error: errorMessage },
      } satisfies RelayEvent)
      // The participant may have been removed between scheduling and this tick;
      // setParticipantStatus throws on an unknown id. This handler runs detached
      // from schedule() (not awaited), so a throw here becomes an unhandled
      // rejection — guard it so error recovery can never itself reject.
      try {
        const context = this.createParticipantOperationContext(
          participantId,
          state,
          epoch,
        )
        await this.awaitParticipantActive(
          () => this.relay.setParticipantStatus(
            participantId,
            'error',
            context,
          ),
          participantId,
          state,
          epoch,
        )
      } catch {
        if (!this.isParticipantCurrent(participantId, state, epoch)) return
        // Participant gone — nothing left to mark.
      }
      if (this.isParticipantCurrent(participantId, state, epoch)) {
        state.running = false
      }
    }
  }

  private isExpectedTurnCancellation(error: unknown): boolean {
    return (
      error instanceof RelayTurnCancelledError
      || error instanceof RelayRuntimeDisposedError
    )
  }

  private isParticipantCurrent(
    participantId: string,
    state: RuntimeAgentState,
    epoch: number,
    requireRunning = true,
  ): boolean {
    if (!this.isActive()) return false
    return (
      this.agents.get(participantId) === state
      && state.epoch === epoch
      && (!requireRunning || state.running)
    )
  }

  private assertParticipantActive(
    participantId: string,
    state: RuntimeAgentState,
    epoch: number,
    requireRunning = true,
  ): void {
    this.assertActive()
    if (
      this.agents.get(participantId) !== state
      || state.epoch !== epoch
      || (requireRunning && !state.running)
    ) {
      throw new RelayTurnCancelledError(
        participantId,
        epoch,
        'participant generation is no longer current',
      )
    }
  }

  private createParticipantOperationContext(
    participantId: string,
    state: RuntimeAgentState,
    epoch: number,
    requireRunning = true,
  ): RelayOperationContext {
    return {
      assertActive: () => this.assertParticipantActive(
        participantId,
        state,
        epoch,
        requireRunning,
      ),
    }
  }

  private async awaitAgentTeardown(state: RuntimeAgentState): Promise<void> {
    const pending = new Set<Promise<void>>()
    for (const providerTeardown of state.providerTeardowns) {
      pending.add(providerTeardown)
    }
    if (state.activeTick) pending.add(state.activeTick.promise)
    await Promise.allSettled([...pending])
    const failures = [...new Set(state.providerTeardownFailures)]
    throwTeardownFailures(
      failures,
      'Relay provider teardown failed while stopping an agent',
    )
  }

  private assertSpawnActive(participantId: string, revision: number): void {
    this.assertActive()
    if (this.spawnRevisions.get(participantId) !== revision) {
      throw new RelayTurnCancelledError(
        participantId,
        revision,
        'spawn request was superseded',
      )
    }
  }

  private createSpawnOperationContext(
    participantId: string,
    revision: number,
  ): RelayOperationContext {
    return {
      assertActive: () => this.assertSpawnActive(participantId, revision),
    }
  }

  private async awaitSpawnActive<T>(
    operation: () => Promise<T>,
    participantId: string,
    revision: number,
  ): Promise<T> {
    this.assertSpawnActive(participantId, revision)
    const pending = operation()
    try {
      const result = await Promise.race([pending, this.cancelled])
      this.assertSpawnActive(participantId, revision)
      return result
    } catch (error) {
      this.assertSpawnActive(participantId, revision)
      throw error
    }
  }

  private async awaitParticipantActive<T>(
    operation: () => Promise<T>,
    participantId: string,
    state: RuntimeAgentState,
    epoch: number,
    requireRunning = true,
  ): Promise<T> {
    this.assertParticipantActive(
      participantId,
      state,
      epoch,
      requireRunning,
    )
    const controller = state.activeTurn?.epoch === epoch
      ? state.activeTurn.controller
      : null
    let onAbort: (() => void) | null = null
    const participantCancelled = controller
      ? new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new RelayTurnCancelledError(
                  participantId,
                  epoch,
                  'participant turn aborted',
                ),
          )
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        })
      : null
    try {
      const pending = operation()
      const result = await Promise.race([
        pending,
        this.cancelled,
        ...(participantCancelled ? [participantCancelled] : []),
      ])
      this.assertParticipantActive(
        participantId,
        state,
        epoch,
        requireRunning,
      )
      return result
    } catch (error) {
      this.assertParticipantActive(
        participantId,
        state,
        epoch,
        requireRunning,
      )
      throw error
    } finally {
      if (controller && onAbort) {
        controller.signal.removeEventListener('abort', onAbort)
      }
    }
  }

  private assertActive(): void {
    if (this.destroyed) throw new RelayRuntimeDisposedError()
    this.options.assertActive?.()
  }

  private isActive(): boolean {
    try {
      this.assertActive()
      return true
    } catch {
      return false
    }
  }

  private async awaitActive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    const pending = operation()
    try {
      const result = await Promise.race([pending, this.cancelled])
      this.assertActive()
      return result
    } catch (error) {
      this.assertActive()
      throw error
    }
  }
}
