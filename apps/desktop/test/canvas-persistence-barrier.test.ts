import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  OrderedDebouncedPersistence,
  WorkspaceOrderedPersistence,
  awaitCanvasBeforeWorkspaceSwitch,
  type PersistenceTimers,
} from '../src/renderer/src/lib/orderedCanvasPersistence.ts'
import {
  WindowPersistenceBarrier,
  type WindowPersistenceApi,
  type WindowPersistenceRequest,
} from '../src/renderer/src/lib/windowPersistenceBarrier.ts'

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

async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function controlledTimers(): PersistenceTimers & {
  fire: () => void
  active: () => boolean
  cleared: () => number
  scheduled: () => number
} {
  let callback: (() => void) | null = null
  let clearCount = 0
  let scheduleCount = 0
  return {
    setTimeout(next) {
      scheduleCount += 1
      callback = next
      return 1
    },
    clearTimeout() {
      callback = null
      clearCount += 1
    },
    fire() {
      const next = callback
      callback = null
      next?.()
    },
    active: () => callback !== null,
    cleared: () => clearCount,
    scheduled: () => scheduleCount,
  }
}

describe('ordered canvas persistence', () => {
  test('serializes a final flush behind an older async write', async () => {
    const timers = controlledTimers()
    const firstWrite = deferred()
    const writes: string[] = []
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
        if (value === 'old') await firstWrite.promise
      },
      500,
      timers,
    )

    persistence.schedule(() => 'old')
    timers.fire()
    await settle()
    assert.deepEqual(writes, ['old'])

    persistence.schedule(() => 'final')
    const flushed = persistence.flush()
    await settle()
    assert.deepEqual(writes, ['old'])

    firstWrite.resolve()
    await flushed
    assert.deepEqual(writes, ['old', 'final'])
  })

  test('clears pending timer state when the timer fires', async () => {
    const timers = controlledTimers()
    const writes: string[] = []
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
      },
      500,
      timers,
    )

    persistence.schedule(() => 'scheduled')
    assert.equal(persistence.hasPending(), true)
    assert.equal(timers.active(), true)

    timers.fire()
    assert.equal(persistence.hasPending(), false)
    assert.equal(timers.active(), false)
    await persistence.waitForIdle()
    assert.deepEqual(writes, ['scheduled'])

    persistence.schedule(() => 'cancelled')
    await persistence.flush(() => 'authoritative')
    assert.equal(timers.cleared(), 1)
    assert.deepEqual(writes, ['scheduled', 'authoritative'])
  })

  test('workspace switching waits for the outgoing canvas flush', async () => {
    const pending = deferred()
    const calls: string[] = []
    let completed = false

    const switching = awaitCanvasBeforeWorkspaceSwitch('workspace-a', async id => {
      calls.push(id)
      await pending.promise
    }).then(() => {
      completed = true
    })

    await Promise.resolve()
    assert.deepEqual(calls, ['workspace-a'])
    assert.equal(completed, false)

    pending.resolve()
    await switching
    assert.equal(completed, true)
  })

  test('retries a failed timer write once from authoritative state and clears dirty failure state', async () => {
    const timers = controlledTimers()
    const failure = new Error('write failed')
    const writes: string[] = []
    let attempts = 0
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
        attempts += 1
        if (attempts === 1) throw failure
      },
      500,
      timers,
    )

    persistence.schedule(() => 'scheduled')
    timers.fire()
    await settle()
    await assert.rejects(persistence.waitForIdle(), failure)

    assert.deepEqual(persistence.getState(), {
      dirty: true,
      dirtyGeneration: 1,
      persistedGeneration: 0,
      failedGeneration: 1,
      failure,
    })

    await persistence.flush(() => 'authoritative')
    assert.deepEqual(writes, ['scheduled', 'authoritative'])
    assert.deepEqual(persistence.getState(), {
      dirty: false,
      dirtyGeneration: 1,
      persistedGeneration: 1,
      failedGeneration: null,
      failure: null,
    })
  })

  test('surfaces a second failure after exactly one authoritative retry and remains dirty', async () => {
    const timers = controlledTimers()
    const firstFailure = new Error('timer write failed')
    const retryFailure = new Error('authoritative retry failed')
    let attempts = 0
    const persistence = new OrderedDebouncedPersistence<string>(
      async () => {
        attempts += 1
        throw attempts === 1 ? firstFailure : retryFailure
      },
      500,
      timers,
    )

    persistence.schedule(() => 'scheduled')
    timers.fire()
    await settle()

    await assert.rejects(
      persistence.flush(() => 'authoritative'),
      retryFailure,
    )
    assert.equal(attempts, 2)
    assert.equal(persistence.getState().dirty, true)
    assert.equal(persistence.getState().failedGeneration, 1)
    assert.equal(persistence.getState().failure, retryFailure)
  })

  test('coalesces a delayed 120-frame native drag to one in-flight write plus the exact final frame', async () => {
    const timers = controlledTimers()
    const firstWrite = deferred()
    const writes: string[] = []
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
        if (value === 'frame-0') await firstWrite.promise
      },
      500,
      timers,
      'immediate',
    )

    persistence.schedule(() => 'frame-0')
    await settle()
    assert.deepEqual(writes, ['frame-0'])

    for (let frame = 1; frame < 120; frame += 1) {
      persistence.schedule(() => `frame-${frame}`)
      await Promise.resolve()
    }

    assert.equal(timers.scheduled(), 0)
    assert.equal(writes.length, 1)
    assert.equal(persistence.hasPending(), true)

    firstWrite.resolve()
    await persistence.waitForIdle()
    assert.deepEqual(writes, ['frame-0', 'frame-119'])
    assert.equal(persistence.getState().dirty, false)
  })

  test('disabled canvas persistence never writes, including a forced lifecycle flush', async () => {
    const timers = controlledTimers()
    const writes: string[] = []
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
      },
      500,
      timers,
      'disabled',
    )

    persistence.schedule(() => 'mini-chat-stale-canvas')
    await persistence.flush(() => 'mini-chat-forced-canvas', { force: true })

    assert.deepEqual(writes, [])
    assert.equal(timers.scheduled(), 0)
    assert.equal(persistence.getState().dirty, false)
  })

  test('force flush writes an authoritative snapshot even when the queue is clean', async () => {
    const timers = controlledTimers()
    const writes: string[] = []
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
      },
      500,
      timers,
    )

    await persistence.flush(() => 'focused-primary', { force: true })
    assert.deepEqual(writes, ['focused-primary'])
    assert.equal(persistence.getState().dirty, false)
  })

  test('a successful workspace B save cannot clear workspace A failed state', async () => {
    const timers = controlledTimers()
    let workspaceAAttempts = 0
    const persistence = new WorkspaceOrderedPersistence<string>(
      async (workspaceId) => {
        if (workspaceId === 'workspace-a') {
          workspaceAAttempts += 1
          throw new Error(`workspace A failure ${workspaceAAttempts}`)
        }
      },
      500,
      timers,
    )
    const workspaceA = persistence.forWorkspace('workspace-a')
    const workspaceB = persistence.forWorkspace('workspace-b')

    workspaceA.schedule(() => 'a-pending')
    timers.fire()
    await settle()
    await assert.rejects(workspaceA.flush(() => 'a-authoritative'))
    assert.equal(workspaceA.getState().dirty, true)
    assert.equal(workspaceA.getState().failedGeneration, 1)

    workspaceB.schedule(() => 'b-state')
    timers.fire()
    await workspaceB.waitForIdle()
    assert.equal(workspaceB.getState().dirty, false)
    assert.equal(workspaceA.getState().dirty, true)
    assert.equal(workspaceA.getState().failedGeneration, 1)
  })

  test('evicts clean closed workspaces but retains dirty persistence state', async () => {
    const timers = controlledTimers()
    const persistence = new WorkspaceOrderedPersistence<string>(
      async () => {},
      500,
      timers,
    )
    const workspaceA = persistence.forWorkspace('workspace-a')
    workspaceA.schedule(() => 'a')
    timers.fire()
    await workspaceA.waitForIdle()

    assert.equal(persistence.entryCount(), 1)
    assert.equal(persistence.evictWorkspace('workspace-a'), true)
    assert.equal(persistence.entryCount(), 0)

    const workspaceB = persistence.forWorkspace('workspace-b')
    workspaceB.schedule(() => 'b')
    assert.equal(persistence.evictWorkspace('workspace-b'), false)
    await workspaceB.flush(() => 'b-final')
    assert.equal(persistence.evictWorkspace('workspace-b'), true)
    assert.equal(persistence.entryCount(), 0)
  })
})

describe('renderer window close persistence barrier', () => {
  test('runs joinable tasks and acknowledges each nonce only once', async () => {
    let listener: ((request: WindowPersistenceRequest) => void) | null = null
    const acknowledgements: string[] = []
    const api: WindowPersistenceApi = {
      onPersistenceRequest(callback) {
        listener = callback
        return () => {
          listener = null
        }
      },
      persistenceReady(nonce) {
        acknowledgements.push(nonce)
      },
    }
    const barrier = new WindowPersistenceBarrier()
    const pending = deferred()
    let taskRuns = 0
    barrier.register('canvas', async () => {
      taskRuns += 1
      await pending.promise
    })
    barrier.start(api)

    assert.ok(listener)
    listener({ nonce: 'close-1', reason: 'close', canvasOwner: true })
    listener({ nonce: 'close-1', reason: 'close', canvasOwner: true })
    await settle()
    assert.equal(taskRuns, 1)
    assert.deepEqual(acknowledgements, [])

    pending.resolve()
    await pending.promise
    await settle()
    assert.deepEqual(acknowledgements, ['close-1'])

    listener({ nonce: 'close-1', reason: 'close', canvasOwner: true })
    await settle()
    assert.equal(taskRuns, 1)
    assert.deepEqual(acknowledgements, ['close-1'])
  })

  test('logs rejected tasks and still acknowledges the close', async () => {
    let listener: ((request: WindowPersistenceRequest) => void) | null = null
    const acknowledgements: string[] = []
    const errors: Array<{ name: string; error: unknown }> = []
    const api: WindowPersistenceApi = {
      onPersistenceRequest(callback) {
        listener = callback
        return () => {
          listener = null
        }
      },
      persistenceReady(nonce) {
        acknowledgements.push(nonce)
      },
    }
    const barrier = new WindowPersistenceBarrier((name, error) => {
      errors.push({ name, error })
    })
    const failure = new Error('disk full')
    barrier.register('canvas', async () => {
      throw failure
    })
    barrier.start(api)

    assert.ok(listener)
    listener({ nonce: 'close-error', reason: 'close', canvasOwner: true })
    await settle()

    assert.deepEqual(errors, [{ name: 'canvas', error: failure }])
    assert.deepEqual(acknowledgements, ['close-error'])
  })

  test('recovers a timer-fired save failure through the close flush task', async () => {
    const timers = controlledTimers()
    const failure = new Error('canvas write failed')
    const writes: string[] = []
    let attempts = 0
    const persistence = new OrderedDebouncedPersistence<string>(
      async value => {
        writes.push(value)
        attempts += 1
        if (attempts === 1) throw failure
      },
      500,
      timers,
    )
    persistence.schedule(() => 'scheduled')
    timers.fire()
    await settle()

    let listener: ((request: WindowPersistenceRequest) => void) | null = null
    const acknowledgements: string[] = []
    const errors: Array<{ name: string; error: unknown }> = []
    const api: WindowPersistenceApi = {
      onPersistenceRequest(callback) {
        listener = callback
        return () => {
          listener = null
        }
      },
      persistenceReady(nonce) {
        acknowledgements.push(nonce)
      },
    }
    const barrier = new WindowPersistenceBarrier((name, error) => {
      errors.push({ name, error })
    })
    barrier.register('canvas', () => persistence.flush(() => 'authoritative'))
    barrier.start(api)

    assert.ok(listener)
    listener({
      nonce: 'close-after-write-error',
      reason: 'close',
      canvasOwner: true,
    })
    await settle()

    assert.deepEqual(errors, [])
    assert.deepEqual(writes, ['scheduled', 'authoritative'])
    assert.deepEqual(acknowledgements, ['close-after-write-error'])
  })

  test('auxiliary mini-chat close cannot overwrite the primary canvas owner', async () => {
    type Snapshot = { owner: string; tiles: string[] }
    const writes: Snapshot[] = []
    const ownerSnapshot: Snapshot = {
      owner: 'primary',
      tiles: ['owner-final'],
    }
    const staleMiniSnapshot: Snapshot = {
      owner: 'mini-chat',
      tiles: ['stale-mini'],
    }
    let miniListener: ((request: WindowPersistenceRequest) => void) | null = null
    let ownerListener: ((request: WindowPersistenceRequest) => void) | null = null
    const acknowledgements: string[] = []
    const makeApi = (
      install: (listener: (request: WindowPersistenceRequest) => void) => void,
    ): WindowPersistenceApi => ({
      onPersistenceRequest(callback) {
        install(callback)
        return () => {}
      },
      persistenceReady(nonce) {
        acknowledgements.push(nonce)
      },
    })

    const miniBarrier = new WindowPersistenceBarrier()
    miniBarrier.register('canvas', async request => {
      if (!request.canvasOwner) return
      writes.push({ ...staleMiniSnapshot, tiles: [...staleMiniSnapshot.tiles] })
    })
    miniBarrier.start(makeApi(listener => {
      miniListener = listener
    }))

    const ownerBarrier = new WindowPersistenceBarrier()
    ownerBarrier.register('canvas', async request => {
      if (!request.canvasOwner) return
      writes.push({ ...ownerSnapshot, tiles: [...ownerSnapshot.tiles] })
    })
    ownerBarrier.start(makeApi(listener => {
      ownerListener = listener
    }))

    assert.ok(miniListener)
    miniListener({
      nonce: 'mini-close',
      reason: 'close',
      canvasOwner: false,
    })
    await settle()
    assert.deepEqual(writes, [])

    // The owner mutates after the mini snapshot became stale. Its own close is
    // the only canvas-authorized lifecycle write.
    ownerSnapshot.tiles.push('owner-latest-mutation')
    assert.ok(ownerListener)
    ownerListener({
      nonce: 'owner-close',
      reason: 'close',
      canvasOwner: true,
    })
    await settle()

    assert.deepEqual(writes, [{
      owner: 'primary',
      tiles: ['owner-final', 'owner-latest-mutation'],
    }])
    assert.deepEqual(acknowledgements.sort(), ['mini-close', 'owner-close'])
  })
})
