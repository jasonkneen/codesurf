import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeSessionPersistenceCoordinator } from '../src/main/chat/runtime-session-persistence.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('clear is ordered after an in-flight old upsert and late old callbacks cannot restore state', async () => {
  const upsertStarted = deferred()
  const releaseUpsert = deferred()
  let persisted: unknown = null
  let upsertCalls = 0
  let clearCalls = 0
  const coordinator = new RuntimeSessionPersistenceCoordinator<unknown>({
    async upsertRuntimeSession(_workspaceId, _cardId, state) {
      upsertCalls += 1
      upsertStarted.resolve()
      await releaseUpsert.promise
      persisted = state
    },
    async clearRuntimeSession() {
      clearCalls += 1
      persisted = null
    },
  })
  const oldRequest = { workspaceId: 'workspace-a', cardId: 'card-a' }
  coordinator.beginRequest(oldRequest)

  const oldWrite = coordinator.upsert(oldRequest, { value: 'old' })
  await upsertStarted.promise
  const clear = coordinator.clear(oldRequest)
  assert.equal(clearCalls, 0, 'clear waits for the already-running write lane')
  releaseUpsert.resolve()
  await Promise.all([oldWrite, clear])

  assert.equal(clearCalls, 1)
  assert.equal(persisted, null)
  await coordinator.upsert(oldRequest, { value: 'late old callback' })
  assert.equal(upsertCalls, 1)
  assert.equal(persisted, null)
})

test('entry-time lease stays tombstoned across slow prep and derived request binding', async () => {
  const writes: unknown[] = []
  const coordinator = new RuntimeSessionPersistenceCoordinator<unknown>({
    async upsertRuntimeSession(_workspaceId, _cardId, state) {
      writes.push(state)
    },
    async clearRuntimeSession() {},
  })
  const entryRequest = { workspaceId: 'workspace-a', cardId: 'card-a' }
  const oldLease = coordinator.beginRequest(entryRequest)

  // Represents clear while canonicalization/memory/skills prep is blocked.
  await coordinator.clear(entryRequest)
  const derivedAfterPrep = { ...entryRequest, prepared: true }
  assert.equal(coordinator.bindRequest(derivedAfterPrep, oldLease), true)
  await coordinator.upsert(derivedAfterPrep, { value: 'must stay cleared' })
  assert.deepEqual(writes, [])

  const freshRequest = { ...entryRequest, fresh: true }
  coordinator.beginRequest(freshRequest)
  await coordinator.upsert(freshRequest, { value: 'fresh' })
  assert.deepEqual(writes, [{ value: 'fresh' }])
})

test('unbound and mismatched derived requests fail closed instead of auto-enrolling', async () => {
  let writes = 0
  const coordinator = new RuntimeSessionPersistenceCoordinator<unknown>({
    async upsertRuntimeSession() { writes += 1 },
    async clearRuntimeSession() {},
  })
  const entryRequest = { workspaceId: 'workspace-a', cardId: 'card-a' }
  const lease = coordinator.beginRequest(entryRequest)

  await coordinator.upsert({ ...entryRequest }, { value: 'unbound' })
  assert.equal(
    coordinator.bindRequest({ workspaceId: 'workspace-b', cardId: 'card-a' }, lease),
    false,
  )
  assert.equal(writes, 0)
})
