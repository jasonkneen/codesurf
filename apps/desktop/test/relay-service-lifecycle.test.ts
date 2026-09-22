import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RelayOperationCancelledError,
  WorkspaceRelayService,
} from '../src/main/relay/workspaceRelayService.ts'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('relay service invalidates suspended init and spawn work until a fresh generation starts', async () => {
  const initEntered = deferred()
  const releaseInit = deferred()
  const spawnEntered = deferred()
  const releaseSpawn = deferred()
  const waitEntered = deferred()
  const releaseWait = deferred()
  let blockInit = true
  let blockSpawn = true
  let relayCreations = 0
  let runtimeCreations = 0
  let liveRuntimes = 0
  let activeSubscriptions = 0
  let executorCreations = 0
  let processStarts = 0

  const service = new WorkspaceRelayService({
    createRelay: () => {
      relayCreations += 1
      return {
        async init() {
          if (!blockInit) return
          initEntered.resolve()
          await releaseInit.promise
        },
        on() {
          let subscribed = true
          activeSubscriptions += 1
          return () => {
            if (!subscribed) return
            subscribed = false
            activeSubscriptions -= 1
          }
        },
        async waitForReady() {
          waitEntered.resolve()
          await releaseWait.promise
        },
      } as any
    },
    createRuntime: (_relay, options) => {
      runtimeCreations += 1
      liveRuntimes += 1
      let destroyed = false
      return {
        async spawn(request) {
          if (blockSpawn) {
            spawnEntered.resolve()
            await releaseSpawn.promise
          }
          const id = request.id ?? request.tileId ?? request.name
          const participant = {
            id,
            name: request.name,
            kind: 'agent' as const,
            status: 'spawning' as const,
            provider: request.provider ?? 'unknown',
            channels: request.channels ?? [],
          }
          const executor = options.executorFactory(participant, {
            ...request,
            id,
          })
          await executor.runTurn({
            participant,
            prompt: request.task,
            unreadDirectMessages: [],
            unreadChannelMessages: [],
            relationships: [],
          })
          return participant
        },
        async stop() {},
        destroy() {
          if (destroyed) return
          destroyed = true
          liveRuntimes -= 1
        },
      }
    },
    createExecutor: () => {
      executorCreations += 1
      return {
        async runTurn() {
          processStarts += 1
          return '{}'
        },
      }
    },
    readTileState: async () => null,
    broadcast: () => {},
  })

  service.start()
  const firstGeneration = service.captureGeneration()
  assert.equal(typeof firstGeneration, 'number')

  const suspendedInit = service.getWorkspaceRelay('/workspace/relay-race')
  await initEntered.promise
  await service.stopAll()

  await assert.rejects(
    suspendedInit,
    error => error instanceof RelayOperationCancelledError,
  )
  blockInit = false
  releaseInit.resolve()
  assert.equal(service.activeInstanceCount(), 0)
  assert.equal(activeSubscriptions, 0)
  assert.equal(runtimeCreations, 0)
  assert.equal(liveRuntimes, 0)
  assert.equal(executorCreations, 0)
  assert.equal(processStarts, 0)

  const creationsWhileStopped = relayCreations
  await assert.rejects(
    service.getWorkspaceRelay('/workspace/relay-race'),
    error => error instanceof RelayOperationCancelledError,
  )
  await assert.rejects(
    service.spawnWorkspaceRelayAgent('/workspace/relay-race', {
      id: 'stopped-agent',
      name: 'Stopped agent',
      task: 'must not start',
    }),
    error => error instanceof RelayOperationCancelledError,
  )
  await assert.rejects(
    service.sendWorkspaceDirectRelayMessage(
      '/workspace/relay-race',
      'system',
      {
        to: 'stopped-agent',
        subject: 'must not write',
        body: 'stopped service',
      },
    ),
    error => error instanceof RelayOperationCancelledError,
  )
  assert.deepEqual(
    await service.syncWorkspaceRelayParticipants(
      'workspace-id',
      '/workspace/relay-race',
      [],
    ),
    [],
  )
  assert.equal(relayCreations, creationsWhileStopped)
  assert.equal(service.activeInstanceCount(), 0)

  service.start()
  const spawnGeneration = service.captureGeneration()
  assert.equal(spawnGeneration, (firstGeneration as number) + 1)
  await service.getWorkspaceRelay('/workspace/relay-race')
  assert.equal(service.activeInstanceCount(), 1)
  assert.equal(activeSubscriptions, 1)
  assert.equal(liveRuntimes, 1)

  const suspendedSpawn = service.spawnWorkspaceRelayAgent(
    '/workspace/relay-race',
    {
      id: 'suspended-agent',
      name: 'Suspended agent',
      provider: 'codex',
      task: 'must not reach the executor',
    },
  )
  await spawnEntered.promise
  await service.stopAll()

  await assert.rejects(
    suspendedSpawn,
    error => error instanceof RelayOperationCancelledError,
  )
  blockSpawn = false
  releaseSpawn.resolve()
  assert.equal(service.activeInstanceCount(), 0)
  assert.equal(activeSubscriptions, 0)
  assert.equal(liveRuntimes, 0)
  assert.equal(executorCreations, 0)
  assert.equal(processStarts, 0)

  const runtimesWhileStopped = runtimeCreations
  await assert.rejects(
    service.spawnWorkspaceRelayAgent('/workspace/relay-race', {
      id: 'still-stopped-agent',
      name: 'Still stopped agent',
      task: 'must remain stopped',
    }),
    error => error instanceof RelayOperationCancelledError,
  )
  assert.equal(runtimeCreations, runtimesWhileStopped)

  service.start()
  const freshGeneration = service.captureGeneration()
  assert.equal(freshGeneration, (spawnGeneration as number) + 1)
  const participant = await service.spawnWorkspaceRelayAgent(
    '/workspace/relay-race',
    {
      id: 'fresh-agent',
      name: 'Fresh agent',
      provider: 'codex',
      task: 'fresh generation only',
    },
  )

  assert.equal(participant.id, 'fresh-agent')
  assert.equal(service.activeInstanceCount(), 1)
  assert.equal(activeSubscriptions, 1)
  assert.equal(liveRuntimes, 1)
  assert.equal(executorCreations, 1)
  assert.equal(processStarts, 1)

  const suspendedWait = service.waitForWorkspaceRelayReady(
    '/workspace/relay-race',
    ['fresh-agent'],
  )
  await waitEntered.promise
  await service.stopAll()
  await assert.rejects(
    suspendedWait,
    error => error instanceof RelayOperationCancelledError,
  )
  releaseWait.resolve()
  assert.equal(service.activeInstanceCount(), 0)
  assert.equal(activeSubscriptions, 0)
  assert.equal(liveRuntimes, 0)

  service.start()
  await service.getWorkspaceRelay('/workspace/relay-race')
  const staleExistingLookup = service.getWorkspaceRelay(
    '/workspace/relay-race',
  )
  await service.stopAll()
  await assert.rejects(
    staleExistingLookup,
    error => error instanceof RelayOperationCancelledError,
  )
  assert.equal(service.activeInstanceCount(), 0)
  assert.equal(activeSubscriptions, 0)
  assert.equal(liveRuntimes, 0)
})

test('relay service awaits every runtime teardown before reporting a failure', async () => {
  const releaseSlowDestroy = deferred()
  const firstFailure = new Error('first runtime destroy failed')
  let runtimeCount = 0
  let destroyCalls = 0
  const service = new WorkspaceRelayService({
    createRelay: () => ({
      async init() {},
      on() {
        return () => {}
      },
    } as any),
    createRuntime: () => {
      runtimeCount += 1
      const runtimeNumber = runtimeCount
      return {
        async spawn() {
          throw new Error('not used')
        },
        async stop() {},
        async destroy() {
          destroyCalls += 1
          if (runtimeNumber === 1) throw firstFailure
          await releaseSlowDestroy.promise
        },
      }
    },
    createExecutor: () => ({
      async runTurn() {
        return '{}'
      },
    }),
    readTileState: async () => null,
    broadcast: () => {},
  })

  service.start()
  await Promise.all([
    service.getWorkspaceRelay('/workspace/first'),
    service.getWorkspaceRelay('/workspace/second'),
  ])

  let stopSettled = false
  const stopping = service.stopAll().finally(() => {
    stopSettled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(destroyCalls, 2)
  assert.equal(stopSettled, false)

  releaseSlowDestroy.resolve()
  await assert.rejects(stopping, error => error === firstFailure)
  assert.equal(stopSettled, true)
})
