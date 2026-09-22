import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  RelayAgentExecutor,
  RelayEvent,
  RelayMessage,
  RelayOperationContext,
  RelayParticipant,
  RelayTurnInput,
} from './types'
import type { CodesurfRelay } from './relay'
import {
  RelayRuntime,
  RelayRuntimeDisposedError,
  RelayTimeoutError,
  RelayTurnCancelledError,
} from './runtime'

// Mock relay that properly handles events
function createMockRelay(): CodesurfRelay {
  const eventHandlers: Array<(event: RelayEvent) => void> = []
  
  return {
    init: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((handler: (event: RelayEvent) => void) => {
      eventHandlers.push(handler)
      return () => {
        const idx = eventHandlers.indexOf(handler)
        if (idx > -1) eventHandlers.splice(idx, 1)
      }
    }),
    events: { 
      emit: vi.fn().mockImplementation((type: string, event: RelayEvent) => {
        if (type === 'event') {
          eventHandlers.forEach(h => h(event))
        }
      })
    },
    workspacePath: '/tmp/test',
    paths: {
      root: '/tmp/test/.codesurf/relay',
      participants: '/tmp/test/.codesurf/relay/participants',
      channels: '/tmp/test/.codesurf/relay/channels',
      archive: '/tmp/test/.codesurf/relay/archive/all',
      relationships: '/tmp/test/.codesurf/relay/relationships',
    },
    upsertParticipant: vi.fn().mockImplementation((p) => Promise.resolve(p as RelayParticipant)),
    getParticipant: vi.fn(),
    setParticipantStatus: vi.fn().mockImplementation((id, status) => 
      Promise.resolve({ id, status } as RelayParticipant)),
    updateWorkContext: vi.fn().mockImplementation((id, work) => 
      Promise.resolve({ id, work } as RelayParticipant)),
    sendDirectMessage: vi.fn().mockResolvedValue({}),
    sendChannelMessage: vi.fn().mockResolvedValue({}),
    listUnreadDirectMessages: vi.fn().mockResolvedValue([]),
    listUnreadChannelMessages: vi.fn().mockResolvedValue([]),
    markDirectMessagesRead: vi.fn().mockResolvedValue(undefined),
    advanceChannelCursor: vi.fn().mockResolvedValue(undefined),
    analyzeRelationships: vi.fn().mockResolvedValue([]),
    storeMemory: vi.fn().mockResolvedValue({}),
  } as unknown as CodesurfRelay
}

describe('runtime', () => {
  describe('RelayRuntime', () => {
    let mockRelay: CodesurfRelay
    let mockExecutor: RelayAgentExecutor

    beforeEach(() => {
      vi.clearAllMocks()
      mockRelay = createMockRelay()
      mockExecutor = {
        runTurn: vi.fn().mockResolvedValue('{"ready": true, "status": "ready"}'),
      }
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should spawn agent and send initial task message', async () => {
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => mockExecutor,
      })

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Do something',
        provider: 'claude',
      })

      expect(mockRelay.upsertParticipant).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-1',
          name: 'Test Agent',
          kind: 'agent',
          status: 'spawning',
        }),
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      expect(mockRelay.sendDirectMessage).toHaveBeenCalledWith(
        'system',
        expect.objectContaining({
          to: 'agent-1',
          subject: 'Initial task',
          body: 'Do something',
          kind: 'system',
        }),
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      runtime.destroy()
    })

    it('should run agent turn when messages arrive', async () => {
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => mockExecutor,
      })

      const mockMessage: RelayMessage = {
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test message',
      }

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([mockMessage])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test task',
      })

      // Wait for async scheduling
      await new Promise(r => setTimeout(r, 10))

      expect(mockExecutor.runTurn).toHaveBeenCalled()
      const callArg = vi.mocked(mockExecutor.runTurn).mock.calls[0][0] as RelayTurnInput
      expect(callArg.unreadDirectMessages).toHaveLength(1)
      expect(callArg.unreadDirectMessages[0].meta.from).toBe('agent-2')

      runtime.destroy()
    })

    it('queues another turn when a direct message arrives during an active turn', async () => {
      let markFirstTurnStarted!: () => void
      const firstTurnStarted = new Promise<void>(resolve => {
        markFirstTurnStarted = resolve
      })
      let releaseFirstTurn!: () => void
      const firstTurnReleased = new Promise<void>(resolve => {
        releaseFirstTurn = resolve
      })
      let turnCount = 0
      const executor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(async () => {
          turnCount += 1
          if (turnCount === 1) {
            markFirstTurnStarted()
            await firstTurnReleased
          }
          return '{"ready": true, "status": "ready"}'
        }),
      }
      const queuedMessage: RelayMessage = {
        mailbox: 'inbox',
        filename: 'queued.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'queued-message',
          threadId: 'queued-message',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Arrived during turn',
          status: 'unread',
          createdAt: '2026-07-31T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2026-07-31T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Process me in the next turn',
      }
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)
      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([])

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executor,
      })
      const spawning = runtime.spawn({
        id: 'agent-1',
        name: 'Agent 1',
        task: 'Process every direct message',
      })

      await firstTurnStarted
      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([
        queuedMessage,
      ])
      mockRelay.events.emit('event', {
        type: 'direct_message',
        timestamp: Date.now(),
        payload: {
          from: 'agent-2',
          to: 'agent-1',
          message: queuedMessage,
        },
      })
      releaseFirstTurn()

      await spawning
      expect(executor.runTurn).toHaveBeenCalledTimes(2)
      const secondTurn = vi.mocked(executor.runTurn).mock.calls[1][0]
      expect(secondTurn.unreadDirectMessages).toEqual([queuedMessage])
      expect(mockRelay.markDirectMessagesRead).toHaveBeenCalledWith(
        'agent-1',
        [queuedMessage],
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )
      await runtime.destroy()
    })

    it('should emit error event when agent fails', async () => {
      const failingExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockRejectedValue(new Error('Agent crashed')),
      }

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => failingExecutor,
      })

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([{
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test',
      }])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test',
      })

      // Wait for async operations
      await new Promise(r => setTimeout(r, 50))

      expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith(
        'agent-1',
        'error',
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )
      expect(mockRelay.events.emit).toHaveBeenCalledWith(
        'event',
        expect.objectContaining({
          type: 'error',
          payload: expect.objectContaining({
            participantId: 'agent-1',
            error: 'Agent crashed',
          }),
        })
      )

      runtime.destroy()
    })

    it('aborts an active executor turn when the runtime is destroyed', async () => {
      let markTurnEntered!: () => void
      const turnEntered = new Promise<void>(resolve => {
        markTurnEntered = resolve
      })
      let receivedSignal: AbortSignal | undefined
      const blockingExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation((
          _input: RelayTurnInput,
          signal?: AbortSignal,
        ) => {
          receivedSignal = signal
          markTurnEntered()
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason)
            }, { once: true })
          })
        }),
      }
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => blockingExecutor,
      })

      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-active',
        name: 'Active Agent',
        kind: 'agent',
        status: 'spawning',
        channels: [],
      })
      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.analyzeRelationships).mockResolvedValue([])

      const spawning = runtime.spawn({
        id: 'agent-active',
        name: 'Active Agent',
        task: 'Keep working until cancelled',
      })
      await turnEntered
      runtime.destroy()

      await expect(spawning).rejects.toBeInstanceOf(
        RelayRuntimeDisposedError,
      )
      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBeInstanceOf(
        RelayRuntimeDisposedError,
      )
    })

    it('propagates an unconfirmed provider-tree termination from destroy', async () => {
      let markTurnEntered!: () => void
      const turnEntered = new Promise<void>(resolve => {
        markTurnEntered = resolve
      })
      const terminationError = Object.assign(
        new Error('process tree exit could not be confirmed'),
        { reason: 'termination' },
      )
      const executor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(async (
          _input: RelayTurnInput,
          signal?: AbortSignal,
        ) => {
          markTurnEntered()
          await new Promise<void>(resolve => {
            signal?.addEventListener('abort', resolve, { once: true })
          })
          throw terminationError
        }),
      }
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executor,
      })
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-unconfirmed',
        name: 'Unconfirmed Agent',
        kind: 'agent',
        status: 'spawning',
        channels: [],
      })

      const spawning = runtime.spawn({
        id: 'agent-unconfirmed',
        name: 'Unconfirmed Agent',
        task: 'Expose an unconfirmed process-tree termination',
      })
      await turnEntered
      const spawningOutcome = expect(spawning).rejects.toBeInstanceOf(
        RelayRuntimeDisposedError,
      )
      await expect(runtime.destroy()).rejects.toBe(terminationError)
      await spawningOutcome
    })

    it('stop aborts and awaits provider teardown without emitting a generic error', async () => {
      let markTurnEntered!: () => void
      const turnEntered = new Promise<void>(resolve => {
        markTurnEntered = resolve
      })
      let releaseProvider!: () => void
      const providerReleased = new Promise<void>(resolve => {
        releaseProvider = resolve
      })
      let observedSignal: AbortSignal | undefined
      const executor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(async (
          _input: RelayTurnInput,
          signal?: AbortSignal,
        ) => {
          observedSignal = signal
          markTurnEntered()
          await providerReleased
          return JSON.stringify({
            ready: true,
            status: 'ready',
            work: { summary: 'stale work' },
            memory: [{ subject: 'stale', body: 'must not persist' }],
          })
        }),
      }
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executor,
      })
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-stop',
        name: 'Stopped Agent',
        kind: 'agent',
        status: 'spawning',
        channels: [],
      })

      const spawning = runtime.spawn({
        id: 'agent-stop',
        name: 'Stopped Agent',
        task: 'Stop this turn',
      })
      await turnEntered

      let stopSettled = false
      const stopping = runtime.stop('agent-stop').then(() => {
        stopSettled = true
      })
      await Promise.resolve()
      expect(observedSignal?.aborted).toBe(true)
      expect(stopSettled).toBe(false)

      releaseProvider()
      await stopping
      await expect(spawning).rejects.toBeInstanceOf(
        RelayTurnCancelledError,
      )

      expect(mockRelay.updateWorkContext).not.toHaveBeenCalled()
      expect(mockRelay.storeMemory).not.toHaveBeenCalled()
      expect(mockRelay.events.emit).not.toHaveBeenCalledWith(
        'event',
        expect.objectContaining({ type: 'error' }),
      )
      expect(vi.mocked(mockRelay.setParticipantStatus).mock.calls
        .map(call => call[1])).not.toContain('error')
      expect(vi.mocked(mockRelay.setParticipantStatus).mock.calls
        .map(call => call[1])).toContain('stopped')
      await runtime.destroy()
    })

    it('destroy awaits provider teardown retained after a turn timeout', async () => {
      let markTurnEntered!: () => void
      const turnEntered = new Promise<void>(resolve => {
        markTurnEntered = resolve
      })
      let releaseProvider!: () => void
      const providerReleased = new Promise<void>(resolve => {
        releaseProvider = resolve
      })
      const executor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(async () => {
          markTurnEntered()
          await providerReleased
          return '{"ready":true,"status":"ready"}'
        }),
      }
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executor,
        turnTimeoutMs: 10,
      })
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-timeout',
        name: 'Timed Out Agent',
        kind: 'agent',
        status: 'spawning',
        channels: [],
      })

      const spawning = runtime.spawn({
        id: 'agent-timeout',
        name: 'Timed Out Agent',
        task: 'Remain alive past the runtime timeout',
      })
      await turnEntered
      await spawning

      let destroySettled = false
      const destroying = runtime.destroy().then(() => {
        destroySettled = true
      })
      await Promise.resolve()
      expect(destroySettled).toBe(false)

      releaseProvider()
      await destroying
      expect(destroySettled).toBe(true)
    })

    it('supersedes a concurrent same-id spawn before it can create an executor', async () => {
      let markFirstUpsertEntered!: () => void
      const firstUpsertEntered = new Promise<void>(resolve => {
        markFirstUpsertEntered = resolve
      })
      let releaseFirstUpsert!: () => void
      const firstUpsertReleased = new Promise<void>(resolve => {
        releaseFirstUpsert = resolve
      })
      let upsertCount = 0
      vi.mocked(mockRelay.upsertParticipant).mockImplementation(async (
        participant,
        context?: RelayOperationContext,
      ) => {
        upsertCount += 1
        if (upsertCount === 1) {
          markFirstUpsertEntered()
          await firstUpsertReleased
        }
        context?.assertActive()
        return participant as RelayParticipant
      })
      const executorFactory = vi.fn(() => mockExecutor)
      const runtime = new RelayRuntime(mockRelay, { executorFactory })

      const firstSpawn = runtime.spawn({
        id: 'shared-agent',
        name: 'First Agent',
        task: 'First task must be superseded',
      })
      await firstUpsertEntered
      const secondParticipant = await runtime.spawn({
        id: 'shared-agent',
        name: 'Second Agent',
        task: 'Second task owns the participant',
      })
      releaseFirstUpsert()

      await expect(firstSpawn).rejects.toBeInstanceOf(
        RelayTurnCancelledError,
      )
      expect(secondParticipant.name).toBe('Second Agent')
      expect(executorFactory).toHaveBeenCalledTimes(1)
      expect(executorFactory).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Second Agent' }),
        expect.objectContaining({ task: 'Second task owns the participant' }),
      )
      await runtime.destroy()
    })

    it('revalidates the participant epoch at every post-turn mutation boundary', async () => {
      const boundaries = [
        'work',
        'status',
        'direct',
        'channel',
        'memory',
        'direct-read',
        'cursor',
      ] as const
      const directMessage: RelayMessage = {
        mailbox: 'inbox',
        filename: 'direct.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'direct',
          threadId: 'direct',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-peer',
          to: 'agent-fenced',
          subject: 'Direct',
          status: 'unread',
          createdAt: '2026-01-01T00:00:00.000Z',
          createdTs: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
          updatedTs: 1,
          bcc: 'central',
        },
        body: 'Direct body',
      }
      const channelMessage: RelayMessage = {
        ...directMessage,
        mailbox: 'channel',
        filename: 'channel.md',
        meta: {
          ...directMessage.meta,
          id: 'channel',
          threadId: 'channel',
          scope: 'channel',
          from: 'agent-peer',
          to: undefined,
          channel: 'review',
          subject: 'Channel',
          createdTs: 2,
          updatedTs: 2,
        },
      }

      for (const boundary of boundaries) {
        const relay = createMockRelay()
        const invoked: string[] = []
        const committed: string[] = []
        let markEntered!: () => void
        const entered = new Promise<void>(resolve => {
          markEntered = resolve
        })
        let release!: () => void
        const released = new Promise<void>(resolve => {
          release = resolve
        })
        const mutate = async (
          name: typeof boundaries[number],
          context?: RelayOperationContext,
        ): Promise<void> => {
          invoked.push(name)
          if (name === boundary) {
            markEntered()
            await released
          }
          context?.assertActive()
          committed.push(name)
        }

        vi.mocked(relay.getParticipant).mockResolvedValue({
          id: 'agent-fenced',
          name: 'Fenced Agent',
          kind: 'agent',
          status: 'spawning',
          channels: ['review'],
        })
        vi.mocked(relay.listUnreadDirectMessages)
          .mockResolvedValue([directMessage])
        vi.mocked(relay.listUnreadChannelMessages)
          .mockResolvedValue([channelMessage])
        vi.mocked(relay.updateWorkContext).mockImplementation(
          async (_id, _work, context) => {
            await mutate('work', context)
            return {} as RelayParticipant
          },
        )
        vi.mocked(relay.setParticipantStatus).mockImplementation(
          async (id, status, context) => {
            if (status === 'ready') await mutate('status', context)
            return { id, status } as RelayParticipant
          },
        )
        vi.mocked(relay.sendDirectMessage).mockImplementation(
          async (from, _draft, context) => {
            if (from !== 'system') await mutate('direct', context)
            return {} as RelayMessage
          },
        )
        vi.mocked(relay.sendChannelMessage).mockImplementation(
          async (_from, _draft, context) => {
            await mutate('channel', context)
            return {} as RelayMessage
          },
        )
        vi.mocked(relay.storeMemory).mockImplementation(
          async (_id, _subject, _body, _data, context) => {
            await mutate('memory', context)
            return {} as RelayMessage
          },
        )
        vi.mocked(relay.markDirectMessagesRead).mockImplementation(
          async (_id, _messages, context) => {
            await mutate('direct-read', context)
          },
        )
        vi.mocked(relay.advanceChannelCursor).mockImplementation(
          async (_id, _channel, _timestamp, context) => {
            await mutate('cursor', context)
          },
        )
        const runtime = new RelayRuntime(relay, {
          executorFactory: () => ({
            runTurn: vi.fn().mockResolvedValue(JSON.stringify({
              ready: true,
              status: 'ready',
              work: { summary: 'Post-turn work' },
              messages: [{
                mode: 'direct',
                to: 'agent-peer',
                subject: 'Direct output',
                body: 'Direct output body',
              }, {
                mode: 'channel',
                channel: 'review',
                subject: 'Channel output',
                body: 'Channel output body',
              }],
              memory: [{
                subject: 'Memory output',
                body: 'Memory output body',
              }],
            })),
          }),
        })

        const spawning = runtime.spawn({
          id: 'agent-fenced',
          name: 'Fenced Agent',
          task: 'Fence every mutation',
        })
        await entered
        await runtime.stop('agent-fenced')
        release()
        await expect(spawning).rejects.toBeInstanceOf(
          RelayTurnCancelledError,
        )
        await Promise.resolve()

        expect(invoked).toContain(boundary)
        expect(committed).not.toContain(boundary)
        expect(invoked.slice(invoked.indexOf(boundary) + 1)).toEqual([])
        expect(relay.events.emit).not.toHaveBeenCalledWith(
          'event',
          expect.objectContaining({ type: 'error' }),
        )
        await runtime.destroy()
      }
    })

    it('restart allocates a fresh participant epoch and executor turn', async () => {
      let firstSignal: AbortSignal | undefined
      let secondSignal: AbortSignal | undefined
      let releaseFirst!: () => void
      const firstReleased = new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      let markFirstEntered!: () => void
      const firstEntered = new Promise<void>(resolve => {
        markFirstEntered = resolve
      })
      let turnCount = 0
      const executor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(async (
          _input: RelayTurnInput,
          signal?: AbortSignal,
        ) => {
          turnCount += 1
          if (turnCount === 1) {
            firstSignal = signal
            markFirstEntered()
            await firstReleased
            return '{"ready":true,"status":"ready"}'
          }
          secondSignal = signal
          return '{"ready":true,"status":"ready"}'
        }),
      }
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-restart',
        name: 'Restarted Agent',
        kind: 'agent',
        status: 'spawning',
        channels: [],
      })
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executor,
      })
      const spawning = runtime.spawn({
        id: 'agent-restart',
        name: 'Restarted Agent',
        task: 'Restart cleanly',
      })
      await firstEntered
      const stopping = runtime.stop('agent-restart')
      releaseFirst()
      await stopping
      await expect(spawning).rejects.toBeInstanceOf(
        RelayTurnCancelledError,
      )

      await runtime.start('agent-restart')

      expect(turnCount).toBe(2)
      expect(firstSignal?.aborted).toBe(true)
      expect(secondSignal).not.toBe(firstSignal)
      expect(secondSignal?.aborted).toBe(false)
      await runtime.destroy()
    })

    it('restart reruns an already-ready agent and leaves stopped status behind', async () => {
      let turnCount = 0
      const executor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(async () => {
          turnCount += 1
          return '{"ready":true,"status":"ready"}'
        }),
      }
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-ready-restart',
        name: 'Ready Restart Agent',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executor,
      })

      await runtime.spawn({
        id: 'agent-ready-restart',
        name: 'Ready Restart Agent',
        task: 'Run again after a successful ready turn',
      })
      expect(turnCount).toBe(1)
      await runtime.stop('agent-ready-restart')
      await runtime.start('agent-ready-restart')

      expect(turnCount).toBe(2)
      const statuses = vi.mocked(mockRelay.setParticipantStatus).mock.calls
        .map(call => call[1])
      expect(statuses).toContain('stopped')
      expect(statuses.slice(statuses.lastIndexOf('stopped') + 1))
        .toContain('ready')
      await runtime.destroy()
    })

    it('should timeout long-running agent turns', async () => {
      const slowExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(() => 
          new Promise(resolve => setTimeout(resolve, 10000))
        ),
      }

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => slowExecutor,
        turnTimeoutMs: 50, // Very short for testing
      })

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([{
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test',
      }])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test',
      })

      // Wait for timeout
      await new Promise(r => setTimeout(r, 100))

      expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith(
        'agent-1',
        'error',
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      runtime.destroy()
    })

    it('should parse agent output and send messages', async () => {
      const executorWithOutput: RelayAgentExecutor = {
        runTurn: vi.fn().mockResolvedValue(JSON.stringify({
          ready: true,
          status: 'running',
          work: {
            summary: 'Working on auth',
            files: ['src/auth.ts'],
          },
          messages: [
            {
              mode: 'direct',
              to: 'agent-2',
              subject: 'Coordination needed',
              body: 'I need to discuss the auth changes',
              priority: 'high',
            },
          ],
        })),
      }

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executorWithOutput,
      })

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([{
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test',
      }])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test',
      })

      await new Promise(r => setTimeout(r, 10))

      expect(mockRelay.updateWorkContext).toHaveBeenCalledWith('agent-1', {
        summary: 'Working on auth',
        files: ['src/auth.ts'],
      }, expect.objectContaining({
        assertActive: expect.any(Function),
      }))

      expect(mockRelay.sendDirectMessage).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          to: 'agent-2',
          subject: 'Coordination needed',
          body: 'I need to discuss the auth changes',
          priority: 'high',
        }),
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      runtime.destroy()
    })

    it('cancels deferred spawn boundaries before later publication or provider work', async () => {
      for (const deferredBoundary of ['upsert', 'send', 'schedule'] as const) {
        let release!: () => void
        const released = new Promise<void>(resolve => {
          release = resolve
        })
        let markEntered!: () => void
        const entered = new Promise<void>(resolve => {
          markEntered = resolve
        })
        const listeners = new Set<(event: RelayEvent) => void>()
        const participants = new Map<string, RelayParticipant>()
        let stopped = false
        let postStopPublishInvocations = 0
        let postStopBackingCommits = 0
        let postStopMutationCalls = 0
        let executorCreations = 0
        let processStarts = 0
        let sendCalls = 0
        let scheduleReads = 0

        const publish = (event: RelayEvent) => {
          if (stopped) postStopPublishInvocations += 1
          for (const listener of listeners) {
            listener(event)
          }
        }
        const recordMutation = () => {
          if (stopped) postStopMutationCalls += 1
        }

        const relay = {
          events: {
            emit(_type: string, event: RelayEvent) {
              publish(event)
            },
          },
          on(listener: (event: RelayEvent) => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          async upsertParticipant(
            input: RelayParticipant,
            context?: RelayOperationContext,
          ) {
            recordMutation()
            if (deferredBoundary === 'upsert') {
              markEntered()
              await released
            }
            context?.assertActive()
            if (stopped) postStopBackingCommits += 1
            const participant = {
              ...input,
              channels: input.channels ?? [],
            }
            participants.set(input.id, participant)
            publish({
              type: 'participant_upserted',
              timestamp: Date.now(),
              payload: { participant },
            })
            return participant
          },
          async sendDirectMessage(
            from: string,
            draft: { to: string; body: string },
            context?: RelayOperationContext,
          ) {
            recordMutation()
            sendCalls += 1
            if (deferredBoundary === 'send') {
              markEntered()
              await released
            }
            context?.assertActive()
            if (stopped) postStopBackingCommits += 1
            const message = {
              mailbox: 'sent' as const,
              filename: 'initial-task.md',
              meta: {
                protocol: 'codesurf-relay/v1' as const,
                id: 'initial-task',
                threadId: 'initial-task',
                scope: 'system' as const,
                kind: 'system' as const,
                priority: 'high' as const,
                from,
                to: draft.to,
                subject: 'Initial task',
                status: 'sent' as const,
                createdAt: new Date().toISOString(),
                createdTs: Date.now(),
                updatedAt: new Date().toISOString(),
                updatedTs: Date.now(),
                bcc: 'central' as const,
              },
              body: draft.body,
            }
            publish({
              type: 'direct_message',
              timestamp: Date.now(),
              payload: { from, to: draft.to, message },
            })
            return message
          },
          async getParticipant(id: string) {
            scheduleReads += 1
            if (deferredBoundary === 'schedule') {
              markEntered()
              await released
            }
            return participants.get(id) ?? null
          },
          async listUnreadDirectMessages() {
            return []
          },
          async listUnreadChannelMessages() {
            return []
          },
          async analyzeRelationships() {
            return []
          },
          async setParticipantStatus(
            id: string,
            status: RelayParticipant['status'],
            context?: RelayOperationContext,
          ) {
            recordMutation()
            context?.assertActive()
            if (stopped) postStopBackingCommits += 1
            const participant = { ...participants.get(id)!, status }
            participants.set(id, participant)
            publish({
              type: 'participant_status',
              timestamp: Date.now(),
              payload: { participantId: id, status },
            })
            return participant
          },
          async updateWorkContext() {
            recordMutation()
          },
          async sendChannelMessage() {
            recordMutation()
          },
          async storeMemory() {
            recordMutation()
          },
          async markDirectMessagesRead() {
            recordMutation()
          },
          async advanceChannelCursor() {
            recordMutation()
          },
          async listParticipants() {
            return Array.from(participants.values())
          },
        } as unknown as CodesurfRelay

        const runtime = new RelayRuntime(relay, {
          executorFactory: () => {
            executorCreations += 1
            return {
              async runTurn() {
                processStarts += 1
                return '{}'
              },
            }
          },
          assertActive: () => {
            if (stopped) throw new Error('stale runtime generation')
          },
        })

        let spawnSettled = false
        const spawn = runtime.spawn({
          id: `agent-${deferredBoundary}`,
          name: `Agent ${deferredBoundary}`,
          provider: 'codex',
          task: 'must stop at the deferred boundary',
        })
        void spawn.then(
          () => { spawnSettled = true },
          () => { spawnSettled = true },
        )

        await entered
        expect(spawnSettled).toBe(false)
        stopped = true
        runtime.destroy()

        await expect(spawn).rejects.toBeInstanceOf(
          RelayRuntimeDisposedError,
        )

        release()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(postStopPublishInvocations).toBe(0)
        expect(postStopBackingCommits).toBe(0)
        expect(postStopMutationCalls).toBe(0)
        expect(processStarts).toBe(0)
        expect(listeners.size).toBe(0)

        if (deferredBoundary === 'upsert') {
          expect(sendCalls).toBe(0)
          expect(executorCreations).toBe(0)
          expect(scheduleReads).toBe(0)
        } else if (deferredBoundary === 'send') {
          expect(sendCalls).toBe(1)
          expect(executorCreations).toBe(1)
          expect(scheduleReads).toBe(0)
        } else {
          expect(sendCalls).toBe(1)
          expect(executorCreations).toBe(1)
          expect(scheduleReads).toBeGreaterThanOrEqual(1)
        }
      }
    })
  })

  describe('RelayTimeoutError', () => {
    it('should have correct error message', () => {
      const error = new RelayTimeoutError('agent-1', 300000)
      expect(error.message).toBe('Agent agent-1 turn timed out after 300000ms')
      expect(error.name).toBe('RelayTimeoutError')
    })
  })
})
