import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatLifecycleCoordinator } from '../src/main/chat/chat-lifecycle-coordinator.ts'
import { ChatPreparationFence } from '../src/main/chat/chat-preparation-fence.ts'
import {
  codexPrelaunchBoundary,
  csagentPrelaunchBoundary,
  openCodePrelaunchBoundary,
  type ProviderPrelaunchBoundary,
} from '../src/main/chat/provider-launch-guard.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const adapters: Array<{
  name: string
  boundary: ProviderPrelaunchBoundary
  launchEffect: string
}> = [
  { name: 'Codex', boundary: codexPrelaunchBoundary, launchEffect: 'child spawn' },
  { name: 'OpenCode', boundary: openCodePrelaunchBoundary, launchEffect: 'server start' },
  { name: 'csagent', boundary: csagentPrelaunchBoundary, launchEffect: 'session prompt' },
]

const invalidations: Array<{
  name: string
  invalidate(fence: ChatPreparationFence, scopeKey: string): void
}> = [
  {
    name: 'foreground replacement',
    invalidate: (fence, scopeKey) => { fence.begin(scopeKey, 'foreground') },
  },
  {
    name: 'session clear',
    invalidate: (fence, scopeKey) => { fence.invalidate(scopeKey) },
  },
]

for (const adapter of adapters) {
  for (const invalidation of invalidations) {
    test(`${adapter.name} disposes delayed setup and prevents ${adapter.launchEffect} after ${invalidation.name}`, async () => {
      const scopeKey = `workspace/${adapter.name.toLowerCase()}`
      const fence = new ChatPreparationFence()
      const lease = fence.begin(scopeKey, 'foreground')
      const setup = deferred<{ id: string }>()
      const disposed: string[] = []
      let preparationCalls = 0
      let launches = 0

      const pending = adapter.boundary.run({
        guard: { isCurrent: () => fence.isCurrent(lease) },
        prepare: () => {
          preparationCalls += 1
          return setup.promise
        },
        disposePrepared: async prepared => {
          await Promise.resolve()
          disposed.push(prepared.id)
        },
        launch: () => {
          launches += 1
          return { launched: true }
        },
      })

      assert.equal(preparationCalls, 1, 'the adapter must be suspended in setup')
      invalidation.invalidate(fence, scopeKey)
      setup.resolve({ id: `${adapter.name}-prepared` })

      assert.deepEqual(await pending, { ok: false })
      assert.equal(launches, 0)
      assert.deepEqual(disposed, [`${adapter.name}-prepared`])
    })
  }

  test(`${adapter.name} disposes prepared state when ${adapter.launchEffect} throws`, async () => {
    const launchError = new Error(`${adapter.name} launch failed`)
    const disposed: string[] = []

    await assert.rejects(
      adapter.boundary.run({
        prepare: () => ({ id: `${adapter.name}-prepared` }),
        disposePrepared: async prepared => {
          await Promise.resolve()
          disposed.push(prepared.id)
        },
        launch: () => { throw launchError },
      }),
      error => error === launchError,
    )

    assert.deepEqual(disposed, [`${adapter.name}-prepared`])
  })
}

test('an already superseded adapter does not begin setup or launch', async () => {
  const fence = new ChatPreparationFence()
  const lease = fence.begin('workspace/card', 'foreground')
  fence.invalidate('workspace/card')
  let preparations = 0
  let launches = 0

  const result = await codexPrelaunchBoundary.run({
    guard: { isCurrent: () => fence.isCurrent(lease) },
    prepare: () => {
      preparations += 1
      return { id: 'unreachable' }
    },
    launch: () => {
      launches += 1
      return { launched: true }
    },
  })

  assert.deepEqual(result, { ok: false })
  assert.equal(preparations, 0)
  assert.equal(launches, 0)
})

test('Electron replacement invalidates a delayed adapter before the replacement reaches the FIFO', async () => {
  const coordinator = new ChatLifecycleCoordinator()
  const scopeKey = 'workspace/card'
  const setup = deferred<{ id: string }>()
  const setupStarted = deferred<void>()
  const disposed: string[] = []
  const launches: string[] = []

  const original = coordinator.runSend(scopeKey, 'foreground', lease => {
    return codexPrelaunchBoundary.run({
      guard: { isCurrent: () => coordinator.isCurrent(lease) },
      prepare: () => {
        setupStarted.resolve()
        return setup.promise
      },
      disposePrepared: prepared => { disposed.push(prepared.id) },
      launch: () => { launches.push('original') },
    })
  })
  await setupStarted.promise

  const replacement = coordinator.runSend(scopeKey, 'foreground', lease => {
    return openCodePrelaunchBoundary.run({
      guard: { isCurrent: () => coordinator.isCurrent(lease) },
      prepare: () => ({ id: 'replacement-ready' }),
      launch: () => { launches.push('replacement') },
    })
  })

  setup.resolve({ id: 'original-prepared' })
  assert.deepEqual(await original, { ok: false })
  assert.deepEqual(await replacement, { ok: true, value: undefined })
  assert.deepEqual(disposed, ['original-prepared'])
  assert.deepEqual(launches, ['replacement'])
})
