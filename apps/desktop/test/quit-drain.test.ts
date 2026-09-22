import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createQuitDrainCoordinator,
  runQuitDrains,
  type BeforeQuitEventLike,
  type QuitDrainFailure,
} from '../src/main/quit-drain.ts'

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function event(): BeforeQuitEventLike & { prevented: number } {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1
    },
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('quit drain coordinator', () => {
  test('runs named drains without owning a second before-quit listener', async () => {
    const activity = deferred()
    const runs: string[] = []
    const draining = runQuitDrains({
      drains: [
        {
          name: 'activity',
          async run() {
            runs.push('activity')
            await activity.promise
          },
        },
        {
          name: 'main-cleanup',
          async run() {
            runs.push('main-cleanup')
          },
        },
      ],
      timeoutMs: 1_000,
    })

    await nextTurn()
    assert.deepEqual(runs.sort(), ['activity', 'main-cleanup'])
    activity.resolve()
    await draining
  })

  test('intercepts once, drains once, and permits exactly one re-entered quit', async () => {
    const gate = deferred()
    let runs = 0
    let quitRequests = 0
    const coordinator = createQuitDrainCoordinator({
      drains: [{
        name: 'activity',
        async run() {
          runs += 1
          await gate.promise
        },
      }],
      timeoutMs: 1_000,
      requestQuit() {
        quitRequests += 1
      },
    })
    const first = event()
    const repeated = event()

    assert.equal(coordinator.beforeQuit(first), 'intercepted')
    assert.equal(coordinator.beforeQuit(repeated), 'intercepted')
    assert.equal(first.prevented, 1)
    assert.equal(repeated.prevented, 1)
    assert.equal(runs, 1)
    assert.equal(quitRequests, 0)

    gate.resolve()
    await nextTurn()
    assert.equal(quitRequests, 1)
    assert.equal(coordinator.getState(), 'reentering')

    const reentered = event()
    assert.equal(coordinator.beforeQuit(reentered), 'pass-through')
    assert.equal(reentered.prevented, 0)
    assert.equal(coordinator.getState(), 'complete')
    assert.equal(coordinator.beforeQuit(event()), 'pass-through')
    assert.equal(runs, 1)
  })

  test('continues the explicit quit policy after failure without exposing causes', async () => {
    const failures: QuitDrainFailure[] = []
    let quitRequests = 0
    const coordinator = createQuitDrainCoordinator({
      drains: [{
        name: 'activity',
        async run() {
          throw new Error('/private/secret/activity.json')
        },
      }],
      timeoutMs: 1_000,
      requestQuit() {
        quitRequests += 1
      },
      onFailure: failure => failures.push(failure),
    })

    coordinator.beforeQuit(event())
    await nextTurn()
    assert.equal(quitRequests, 1)
    assert.deepEqual(failures, [{ name: 'activity', code: 'failed' }])
    assert.equal(JSON.stringify(failures).includes('/private/secret'), false)
  })

  test('times out only pending drains and ignores their later completion', async () => {
    const drainGate = deferred()
    const timeoutGate = deferred()
    const failures: QuitDrainFailure[] = []
    let quitRequests = 0
    const coordinator = createQuitDrainCoordinator({
      drains: [
        { name: 'activity', run: () => drainGate.promise },
        { name: 'canvas', run: async () => {} },
      ],
      timeoutMs: 50,
      timeout: () => timeoutGate.promise,
      requestQuit() {
        quitRequests += 1
      },
      onFailure: failure => failures.push(failure),
    })

    coordinator.beforeQuit(event())
    await nextTurn()
    timeoutGate.resolve()
    await nextTurn()
    assert.equal(quitRequests, 1)
    assert.deepEqual(failures, [{ name: 'activity', code: 'timeout' }])

    drainGate.resolve()
    await nextTurn()
    assert.equal(quitRequests, 1)
    assert.equal(failures.length, 1)
  })

  test('validates the structural drain list used for future persistence barriers', () => {
    assert.throws(() => createQuitDrainCoordinator({
      drains: [
        { name: 'activity', run: async () => {} },
        { name: 'activity', run: async () => {} },
      ],
      timeoutMs: 1,
      requestQuit() {},
    }))
  })
})
