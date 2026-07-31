import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ActivityRecord } from '../src/shared/activity-types.ts'
import type {
  ActivityPersistence,
  LoadedActivityRecords,
} from '../src/main/activity-persistence.ts'
import {
  ActivityStore,
  ActivityStoreCapacityError,
  ActivityStoreClosedError,
  type ActivityScheduler,
} from '../src/main/activity-store-core.ts'
import { MAX_ACTIVITY_RECORDS } from '../src/main/activity-cap.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function cloneRecords(records: ActivityRecord[]): ActivityRecord[] {
  return JSON.parse(JSON.stringify(records)) as ActivityRecord[]
}

function activity(
  id: string,
  overrides: Partial<ActivityRecord> = {},
): ActivityRecord {
  return {
    id,
    tileId: 'tile-1',
    workspaceId: 'workspace-1',
    type: 'task',
    status: 'running',
    title: `Activity ${id}`,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

class MemoryPersistence implements ActivityPersistence {
  readonly data = new Map<string, ActivityRecord[]>()
  readonly saves: Array<{ workspaceId: string, records: ActivityRecord[] }> = []
  loadCount = 0
  loadOverride: ((workspaceId: string) => Promise<LoadedActivityRecords>) | null = null
  saveOverride: ((workspaceId: string, records: ActivityRecord[]) => Promise<void>) | null = null

  async load(workspaceId: string): Promise<LoadedActivityRecords> {
    this.loadCount += 1
    if (this.loadOverride) return this.loadOverride(workspaceId)
    return {
      records: cloneRecords(this.data.get(workspaceId) ?? []),
      needsRewrite: false,
    }
  }

  async save(workspaceId: string, records: ActivityRecord[]): Promise<void> {
    const snapshot = cloneRecords(records)
    this.saves.push({ workspaceId, records: snapshot })
    if (this.saveOverride) return this.saveOverride(workspaceId, snapshot)
    this.data.set(workspaceId, snapshot)
  }
}

interface ManualTimer {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

class ManualScheduler implements ActivityScheduler {
  readonly timers: ManualTimer[] = []

  set(callback: () => void, delayMs: number): ManualTimer {
    const timer = { callback, delayMs, cancelled: false }
    this.timers.push(timer)
    return timer
  }

  clear(handle: unknown): void {
    ;(handle as ManualTimer).cancelled = true
  }

  runNext(): ManualTimer {
    const timer = this.timers.find(candidate => !candidate.cancelled)
    assert.ok(timer, 'expected a pending activity timer')
    timer.cancelled = true
    timer.callback()
    return timer
  }

  pending(): ManualTimer[] {
    return this.timers.filter(timer => !timer.cancelled)
  }
}

function upsertInput(tileId: string, id: string, title = id): Record<string, unknown> {
  return {
    id,
    tileId,
    type: 'task',
    status: 'running',
    title,
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('ActivityStore identity and query behavior', () => {
  test('scopes duplicate activity ids by tile for upsert and delete', async () => {
    const persistence = new MemoryPersistence()
    let now = 100
    const store = new ActivityStore({ persistence, now: () => now })

    await store.upsert('workspace-1', upsertInput('tile-a', 'shared', 'A'))
    await store.upsert('workspace-1', upsertInput('tile-b', 'shared', 'B'))
    now = 200
    await store.upsert('workspace-1', upsertInput('tile-a', 'shared', 'A updated'))

    assert.deepEqual(
      (await store.byTile('workspace-1', 'tile-a')).map(record => record.title),
      ['A updated'],
    )
    assert.deepEqual(
      (await store.byTile('workspace-1', 'tile-b')).map(record => record.title),
      ['B'],
    )
    assert.equal(await store.delete('workspace-1', 'tile-a', 'shared'), true)
    assert.equal((await store.byTile('workspace-1', 'tile-a')).length, 0)
    assert.equal((await store.byTile('workspace-1', 'tile-b')).length, 1)

    await store.flushAll()
    assert.deepEqual(
      persistence.data.get('workspace-1')?.map(record => `${record.tileId}:${record.id}`),
      ['tile-b:shared'],
    )
  })

  test('queries are pure, cloned, ordered, filtered, and bounded', async () => {
    const persistence = new MemoryPersistence()
    persistence.data.set('workspace-1', [
      activity('older', { metadata: { value: 'original' } }),
      activity('newer', { updatedAt: 200, title: 'x'.repeat(300) }),
    ])
    const store = new ActivityStore({
      persistence,
      maxQueryResponseBytes: 700,
    })

    const first = await store.query({ workspaceId: 'workspace-1' })
    assert.deepEqual(first.map(record => record.id), ['newer', 'older'])
    first[1].metadata!.value = 'mutated'
    first.reverse()

    const second = await store.query({ workspaceId: 'workspace-1' })
    assert.deepEqual(second.map(record => record.id), ['newer', 'older'])
    assert.equal(
      second[1].metadata!.value,
      'original',
    )
    assert.ok(Buffer.byteLength(JSON.stringify(second), 'utf8') <= 700)
    await store.flushAll()
    assert.equal(persistence.saves.length, 0)
  })

  test('groups hostile agent names without prototype collisions or oversized output', async () => {
    const persistence = new MemoryPersistence()
    persistence.data.set('workspace-1', [
      activity('proto', { agent: '__proto__', title: 'x'.repeat(200) }),
      activity('constructor', { agent: 'constructor', title: 'x'.repeat(200) }),
      activity('fallback', { tileId: 'tile-fallback', title: 'x'.repeat(200) }),
    ])
    const store = new ActivityStore({
      persistence,
      maxQueryResponseBytes: 900,
    })

    const groups = await store.byAgent('workspace-1')
    assert.equal(Object.hasOwn(groups, '__proto__'), true)
    assert.equal(Object.hasOwn(groups, 'constructor'), true)
    assert.equal(Object.hasOwn(groups, 'tile:tile-fallback'), false)
    assert.ok(Buffer.byteLength(JSON.stringify(groups), 'utf8') <= 900)
    await store.flushAll()
  })

  test('retains the just-upserted identity at an exact timestamp-tied cap', async () => {
    const persistence = new MemoryPersistence()
    persistence.data.set('workspace-1', Array.from(
      { length: MAX_ACTIVITY_RECORDS },
      (_, index) => activity(`old-${index}`),
    ))
    const store = new ActivityStore({
      persistence,
      now: () => 100,
    })

    const inserted = await store.upsert(
      'workspace-1',
      upsertInput('new-tile', 'new-at-cap', 'Newest'),
    )
    assert.equal(inserted.id, 'new-at-cap')
    assert.equal((await store.byTile('workspace-1', 'new-tile'))[0]?.id, 'new-at-cap')
    await store.flushAll()
    const saved = persistence.data.get('workspace-1') ?? []
    assert.equal(saved.length, MAX_ACTIVITY_RECORDS)
    assert.equal(saved.some(record => record.id === 'new-at-cap'), true)
  })

  test('rejects an aggregate that exceeds its serialized store budget before mutation', async () => {
    const persistence = new MemoryPersistence()
    const store = new ActivityStore({
      persistence,
      maxFileBytes: 150,
    })
    await assert.rejects(store.upsert(
      'workspace-1',
      upsertInput('tile-1', 'too-large', 'x'.repeat(100)),
    ), /exceeds 150 bytes/)
    assert.deepEqual(await store.query({ workspaceId: 'workspace-1' }), [])
    await store.flushAll()
    assert.equal(persistence.saves.length, 0)
  })

  test('measures only the changed record on hot mutations after initial accounting', async () => {
    const persistence = new MemoryPersistence()
    persistence.data.set('workspace-1', Array.from(
      { length: 1_000 },
      (_, index) => activity(`existing-${index}`, { updatedAt: 100 + index }),
    ))
    let measurements = 0
    const store = new ActivityStore({
      persistence,
      measureRecordBytes(record) {
        measurements += 1
        return Buffer.byteLength(JSON.stringify(record), 'utf8')
      },
    })

    await store.query({ workspaceId: 'workspace-1' })
    const afterLoad = measurements
    assert.equal(afterLoad, 1_000)
    await store.upsert('workspace-1', upsertInput('new-tile', 'new-record'))
    assert.equal(measurements - afterLoad, 1)
    await store.delete('workspace-1', 'new-tile', 'new-record')
    assert.equal(measurements - afterLoad, 1)
    await store.flushAll()
  })

  test('rejects metadata patches whose merged record exceeds metadata limits', async () => {
    const persistence = new MemoryPersistence()
    persistence.data.set('workspace-1', [
      activity('bounded', {
        metadata: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [`existing${index}`, index]),
        ),
      }),
    ])
    const store = new ActivityStore({ persistence })

    await assert.rejects(
      store.upsert('workspace-1', {
        ...upsertInput('tile-1', 'bounded', 'Rejected update'),
        metadata: { extra: true },
      }),
      /metadata exceeds 16 fields/,
    )
    const [record] = await store.byTile('workspace-1', 'tile-1')
    assert.equal(record.title, 'Activity bounded')
    assert.equal(Object.hasOwn(record.metadata!, 'extra'), false)
    await store.flushAll()
    assert.equal(persistence.saves.length, 0)
  })
})

describe('ActivityStore concurrency and lifecycle', () => {
  test('single-flights first load and flush waits for concurrent first mutations', async () => {
    const persistence = new MemoryPersistence()
    const loadGate = deferred<LoadedActivityRecords>()
    persistence.loadOverride = async () => loadGate.promise
    const store = new ActivityStore({ persistence, now: () => 100 })

    const first = store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    const second = store.upsert('workspace-1', upsertInput('tile-b', 'b'))
    await nextTurn()
    assert.equal(persistence.loadCount, 1)

    const flush = store.flushAll()
    await assert.rejects(
      store.query({ workspaceId: 'workspace-1' }),
      ActivityStoreClosedError,
    )
    loadGate.resolve({ records: [], needsRewrite: false })
    await Promise.all([first, second, flush])

    assert.deepEqual(
      persistence.data.get('workspace-1')?.map(record => record.id).sort(),
      ['a', 'b'],
    )
    assert.deepEqual(store.getStats().dirtyWorkspaceIds, [])
  })

  test('serializes generations created while an older save is in flight', async () => {
    const persistence = new MemoryPersistence()
    const scheduler = new ManualScheduler()
    const firstSaveGate = deferred<void>()
    persistence.saveOverride = async (_workspaceId, records) => {
      if (records.length === 1) await firstSaveGate.promise
      persistence.data.set('workspace-1', cloneRecords(records))
    }
    const store = new ActivityStore({ persistence, scheduler })

    await store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    scheduler.runNext()
    await nextTurn()
    await store.upsert('workspace-1', upsertInput('tile-b', 'b'))
    const flush = store.flushAll()
    firstSaveGate.resolve()
    await flush

    assert.deepEqual(persistence.saves.map(save => save.records.length), [1, 2])
    assert.deepEqual(
      persistence.data.get('workspace-1')?.map(record => record.id).sort(),
      ['a', 'b'],
    )
  })

  test('automatically retries failed background persistence without another mutation', async () => {
    const persistence = new MemoryPersistence()
    const scheduler = new ManualScheduler()
    let attempts = 0
    persistence.saveOverride = async (workspaceId, records) => {
      attempts += 1
      if (attempts === 1) throw new Error('simulated disk failure')
      persistence.data.set(workspaceId, cloneRecords(records))
    }
    const store = new ActivityStore({
      persistence,
      scheduler,
      saveDebounceMs: 10,
      saveRetryMs: 25,
    })

    await store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    assert.equal(scheduler.runNext().delayMs, 10)
    await nextTurn()
    assert.equal(attempts, 1)
    assert.equal(scheduler.pending()[0]?.delayMs, 25)

    scheduler.runNext()
    await nextTurn()
    assert.equal(attempts, 2)
    assert.equal(persistence.data.get('workspace-1')?.[0]?.id, 'a')
    await store.flushAll()
  })

  test('backs repeated save failures off exponentially, caps delay, and reports sanitized health', async () => {
    const persistence = new MemoryPersistence()
    const scheduler = new ManualScheduler()
    const events: unknown[] = []
    let attempts = 0
    let now = 1_000
    persistence.saveOverride = async (workspaceId, records) => {
      attempts += 1
      if (attempts <= 3) throw new Error(`/private/secret failure ${attempts}`)
      persistence.data.set(workspaceId, cloneRecords(records))
    }
    const store = new ActivityStore({
      persistence,
      scheduler,
      now: () => now,
      saveDebounceMs: 10,
      saveRetryMs: 25,
      maxSaveRetryMs: 60,
      healthEventIntervalMs: 100,
      onHealthEvent: event => events.push(event),
    })

    await store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    assert.equal(scheduler.runNext().delayMs, 10)
    await nextTurn()
    assert.equal(scheduler.pending()[0]?.delayMs, 25)
    now += 50
    scheduler.runNext()
    await nextTurn()
    assert.equal(scheduler.pending()[0]?.delayMs, 50)
    now += 100
    scheduler.runNext()
    await nextTurn()
    assert.equal(scheduler.pending()[0]?.delayMs, 60)
    assert.deepEqual(events, [
      {
        workspaceId: 'workspace-1',
        operation: 'save',
        code: 'operation_failed',
        occurredAt: 1_000,
      },
      {
        workspaceId: 'workspace-1',
        operation: 'save',
        code: 'operation_failed',
        occurredAt: 1_150,
      },
    ])
    assert.deepEqual(store.getHealth('workspace-1'), {
      available: true,
      status: 'degraded',
      lastIssue: {
        operation: 'save',
        code: 'operation_failed',
        occurredAt: 1_150,
      },
    })

    scheduler.runNext()
    await nextTurn()
    assert.equal(attempts, 4)
    assert.deepEqual(store.getHealth('workspace-1'), {
      available: true,
      status: 'healthy',
    })
    await store.flushAll()
  })

  test('rewrites migrated data even when no mutation follows the load', async () => {
    const persistence = new MemoryPersistence()
    persistence.loadOverride = async () => ({
      records: [activity('legacy')],
      needsRewrite: true,
    })
    const store = new ActivityStore({ persistence })
    assert.equal((await store.query({ workspaceId: 'workspace-1' })).length, 1)
    await store.flushAll()
    assert.equal(persistence.saves.length, 1)
    assert.equal(persistence.saves[0].records[0].id, 'legacy')
  })

  test('evicts the least-recently-used clean workspace and flushes dirty victims', async () => {
    const persistence = new MemoryPersistence()
    const store = new ActivityStore({
      persistence,
      maxLoadedWorkspaces: 2,
    })

    await store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    await store.query({ workspaceId: 'workspace-2' })
    await store.query({ workspaceId: 'workspace-3' })
    await store.settleMaintenance()

    assert.deepEqual(store.getStats().loadedWorkspaceIds.sort(), [
      'workspace-2',
      'workspace-3',
    ])
    assert.equal(persistence.data.get('workspace-1')?.[0]?.id, 'a')
    await store.flushAll()
  })

  test('bounds concurrent first loads without calling persistence beyond capacity', async () => {
    const persistence = new MemoryPersistence()
    const gates = new Map<string, Deferred<LoadedActivityRecords>>()
    persistence.loadOverride = async workspaceId => {
      const gate = deferred<LoadedActivityRecords>()
      gates.set(workspaceId, gate)
      return gate.promise
    }
    const store = new ActivityStore({ persistence, maxLoadedWorkspaces: 2 })

    const first = store.query({ workspaceId: 'workspace-1' })
    const second = store.query({ workspaceId: 'workspace-2' })
    const rejected = store.query({ workspaceId: 'workspace-3' })
    await assert.rejects(rejected, ActivityStoreCapacityError)
    assert.equal(persistence.loadCount, 2)
    gates.get('workspace-1')!.resolve({ records: [], needsRewrite: false })
    gates.get('workspace-2')!.resolve({ records: [], needsRewrite: false })
    await Promise.all([first, second])
    assert.equal(store.getStats().loadedWorkspaceIds.length, 2)
    await store.flushAll()
  })

  test('sweeps past a failing dirty victim and admits after another safe eviction', async () => {
    const persistence = new MemoryPersistence()
    const scheduler = new ManualScheduler()
    persistence.saveOverride = async workspaceId => {
      if (workspaceId === 'workspace-1') throw new Error('disk unavailable')
    }
    const store = new ActivityStore({
      persistence,
      scheduler,
      maxLoadedWorkspaces: 2,
    })

    await store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    await store.query({ workspaceId: 'workspace-2' })
    await store.query({ workspaceId: 'workspace-3' })
    assert.deepEqual(store.getStats().loadedWorkspaceIds.sort(), [
      'workspace-1',
      'workspace-3',
    ])
    assert.equal(scheduler.pending().length, 1)
    persistence.saveOverride = null
    scheduler.runNext()
    await nextTurn()
    await store.flushAll()
  })

  test('rejects admission when every victim is pinned, then recovers after retry succeeds', async () => {
    const persistence = new MemoryPersistence()
    const scheduler = new ManualScheduler()
    let saveFails = true
    persistence.saveOverride = async (workspaceId, records) => {
      if (saveFails) throw new Error('disk unavailable')
      persistence.data.set(workspaceId, cloneRecords(records))
    }
    const store = new ActivityStore({
      persistence,
      scheduler,
      maxLoadedWorkspaces: 1,
    })

    await store.upsert('workspace-1', upsertInput('tile-a', 'a'))
    await assert.rejects(
      store.query({ workspaceId: 'workspace-2' }),
      ActivityStoreCapacityError,
    )
    assert.equal(persistence.loadCount, 1)
    saveFails = false
    scheduler.runNext()
    await nextTurn()
    await store.query({ workspaceId: 'workspace-2' })
    assert.deepEqual(store.getStats().loadedWorkspaceIds, ['workspace-2'])
    await store.flushAll()
  })

  test('does not cache failed loads, allowing a corrected artifact to load later', async () => {
    const persistence = new MemoryPersistence()
    let fail = true
    persistence.loadOverride = async () => {
      if (fail) throw new Error('corrupt document')
      return { records: [activity('repaired')], needsRewrite: false }
    }
    const store = new ActivityStore({ persistence, now: () => 100 })

    await assert.rejects(store.query({ workspaceId: 'workspace-1' }), /corrupt document/)
    assert.deepEqual(store.getHealth('workspace-1'), {
      available: true,
      status: 'degraded',
      lastIssue: {
        operation: 'load',
        code: 'operation_failed',
        occurredAt: 100,
      },
    })
    fail = false
    assert.equal((await store.query({ workspaceId: 'workspace-1' }))[0].id, 'repaired')
    assert.equal(persistence.loadCount, 2)
    await store.flushAll()
  })
})
