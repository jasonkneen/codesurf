import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatLifecycleCoordinator } from '../src/main/chat/chat-lifecycle-coordinator.ts'
import {
  runConfirmedSessionClear,
  type ConfirmedStopResult,
} from '../src/main/chat/chat-session-lifecycle.ts'
import { codexPrelaunchBoundary } from '../src/main/chat/provider-launch-guard.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('clear retains session state while provider stop is pending and after an unconfirmed stop', async () => {
  const stop = deferred<ConfirmedStopResult>()
  const sessions = new Map([['workspace/card:codex', 'session-1']])
  const effects: string[] = []

  const clearing = runConfirmedSessionClear({
    stopExecution: () => {
      effects.push('stop')
      return stop.promise
    },
    clearPersistedState: () => { effects.push('clear persisted') },
    evictSessionState: () => {
      effects.push('evict')
      sessions.clear()
    },
  })

  assert.equal(sessions.get('workspace/card:codex'), 'session-1')
  assert.deepEqual(effects, ['stop'])

  stop.resolve({ ok: false, error: 'process tree still alive' })
  assert.deepEqual(await clearing, {
    ok: false,
    error: 'process tree still alive',
  })
  assert.equal(sessions.get('workspace/card:codex'), 'session-1')
  assert.deepEqual(effects, ['stop'])
})

test('clear evicts local session state only after confirmed stop and authoritative clear', async () => {
  const persistedClear = deferred<void>()
  const persistedClearStarted = deferred<void>()
  const sessions = new Map([['workspace/card:codex', 'session-1']])
  const effects: string[] = []

  const clearing = runConfirmedSessionClear({
    stopExecution: () => {
      effects.push('stop confirmed')
      return { ok: true }
    },
    clearPersistedState: () => {
      effects.push('clear persisted')
      persistedClearStarted.resolve()
      return persistedClear.promise
    },
    evictSessionState: () => {
      effects.push('evict')
      sessions.clear()
    },
  })

  await persistedClearStarted.promise
  assert.equal(sessions.get('workspace/card:codex'), 'session-1')
  assert.deepEqual(effects, ['stop confirmed', 'clear persisted'])

  persistedClear.resolve()
  assert.deepEqual(await clearing, { ok: true })
  assert.equal(sessions.size, 0)
  assert.deepEqual(effects, ['stop confirmed', 'clear persisted', 'evict'])
})

test('authoritative clear failure preserves local session state for retry', async () => {
  const sessions = new Map([['workspace/card:codex', 'session-1']])
  let evictions = 0

  const result = await runConfirmedSessionClear({
    stopExecution: () => ({ ok: true }),
    clearPersistedState: () => { throw new Error('daemon unavailable') },
    evictSessionState: () => {
      evictions += 1
      sessions.clear()
    },
  })

  assert.deepEqual(result, {
    ok: false,
    error: 'Could not clear persisted daemon session: daemon unavailable',
  })
  assert.equal(evictions, 0)
  assert.equal(sessions.get('workspace/card:codex'), 'session-1')
})

test('Electron lifecycle clear invalidates delayed provider setup before stop and eviction', async () => {
  const coordinator = new ChatLifecycleCoordinator()
  const scopeKey = 'workspace/card'
  const setup = deferred<{ id: string }>()
  const setupStarted = deferred<void>()
  const stop = deferred<ConfirmedStopResult>()
  const stopStarted = deferred<void>()
  const sessions = new Map([[`${scopeKey}:codex`, 'session-1']])
  const disposed: string[] = []
  let launches = 0

  const send = coordinator.runSend(scopeKey, 'foreground', lease => {
    return codexPrelaunchBoundary.run({
      guard: { isCurrent: () => coordinator.isCurrent(lease) },
      prepare: () => {
        setupStarted.resolve()
        return setup.promise
      },
      disposePrepared: prepared => { disposed.push(prepared.id) },
      launch: () => { launches += 1 },
    })
  })
  await setupStarted.promise

  const clear = coordinator.runLifecycle(scopeKey, () => runConfirmedSessionClear({
    stopExecution: () => {
      stopStarted.resolve()
      return stop.promise
    },
    clearPersistedState: () => {},
    evictSessionState: () => { sessions.clear() },
  }))

  setup.resolve({ id: 'materialized-images' })
  assert.deepEqual(await send, { ok: false })
  assert.equal(launches, 0)
  assert.deepEqual(disposed, ['materialized-images'])

  await stopStarted.promise
  assert.equal(sessions.get(`${scopeKey}:codex`), 'session-1')
  stop.resolve({ ok: true })
  assert.deepEqual(await clear, { ok: true })
  assert.equal(sessions.size, 0)
})
