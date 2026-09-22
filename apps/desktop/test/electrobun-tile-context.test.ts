import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createElectrobunTileContextStore,
  invokeElectrobunTileContext,
} from '../electrobun/bun/tile-context-runtime.ts'
import { isTileContextChangeForScope } from '../src/shared/tileContextScope.ts'

describe('Electrobun workspace-scoped tile context', () => {
  test('isolates identical tile IDs across workspaces and matches Electron entry semantics', async () => {
    const changed: unknown[] = []
    let now = 100
    const store = createElectrobunTileContextStore({
      now: () => ++now,
      onChanged: payload => changed.push(payload),
    })

    assert.equal(await invokeElectrobunTileContext(
      store,
      'tileContext:set',
      ['workspace-a', 'same-tile', 'ctx:test', 'value-a'],
    ), true)
    assert.equal(await invokeElectrobunTileContext(
      store,
      'tileContext:set',
      ['workspace-b', 'same-tile', 'ctx:test', 'value-b'],
    ), true)

    assert.deepEqual(await invokeElectrobunTileContext(
      store,
      'tileContext:get',
      ['workspace-a', 'same-tile', 'ctx:test'],
    ), {
      key: 'ctx:test',
      value: 'value-a',
      updatedAt: 101,
      source: 'same-tile',
    })
    assert.deepEqual(await invokeElectrobunTileContext(
      store,
      'tileContext:get',
      ['workspace-b', 'same-tile', 'ctx:test'],
    ), {
      key: 'ctx:test',
      value: 'value-b',
      updatedAt: 102,
      source: 'same-tile',
    })
    assert.deepEqual(await invokeElectrobunTileContext(
      store,
      'tileContext:getAll',
      ['workspace-a', 'same-tile', 'ctx:'],
    ), [{
      key: 'ctx:test',
      value: 'value-a',
      updatedAt: 101,
      source: 'same-tile',
    }])

    assert.equal(await invokeElectrobunTileContext(
      store,
      'tileContext:delete',
      ['workspace-a', 'same-tile', 'ctx:test'],
    ), true)
    assert.equal(await invokeElectrobunTileContext(
      store,
      'tileContext:get',
      ['workspace-a', 'same-tile', 'ctx:test'],
    ), null)
    assert.equal(
      ((await store.get('workspace-b', 'same-tile', 'ctx:test')) as { value: unknown }).value,
      'value-b',
    )

    assert.deepEqual(changed, [
      {
        workspaceId: 'workspace-a',
        tileId: 'same-tile',
        key: 'ctx:test',
        value: 'value-a',
      },
      {
        workspaceId: 'workspace-b',
        tileId: 'same-tile',
        key: 'ctx:test',
        value: 'value-b',
      },
      {
        workspaceId: 'workspace-a',
        tileId: 'same-tile',
        key: 'ctx:test',
        value: null,
      },
    ])
    assert.equal(isTileContextChangeForScope(changed[0], 'workspace-a', 'same-tile'), true)
    assert.equal(isTileContextChangeForScope(changed[0], 'workspace-b', 'same-tile'), false)
  })

  test('returns the full keyed context and emits no deletion event for a missing key', async () => {
    const changed: unknown[] = []
    const store = createElectrobunTileContextStore({
      now: () => 123,
      onChanged: payload => changed.push(payload),
    })
    await store.set('workspace-a', 'tile-1', 'ctx:first', 1)
    await store.set('workspace-a', 'tile-1', 'meta:second', 2)

    assert.deepEqual(await store.get('workspace-a', 'tile-1'), {
      'ctx:first': { key: 'ctx:first', value: 1, updatedAt: 123, source: 'tile-1' },
      'meta:second': { key: 'meta:second', value: 2, updatedAt: 123, source: 'tile-1' },
    })
    assert.deepEqual(await store.getAll('workspace-a', 'tile-1', 'ctx:'), [
      { key: 'ctx:first', value: 1, updatedAt: 123, source: 'tile-1' },
    ])
    assert.equal(await store.delete('workspace-a', 'tile-1', 'missing'), true)
    assert.equal(changed.length, 2)
  })

  test('reloads persisted context after a store restart without overwriting tile state', async () => {
    const tileStates = new Map<string, Record<string, unknown>>()
    const persistence = {
      load: async (workspaceId: string, tileId: string) => {
        const state = tileStates.get(`${workspaceId}:${tileId}`) ?? {}
        return (state._context ?? {}) as Record<string, {
          key: string
          value: unknown
          updatedAt: number
          source: string
        }>
      },
      save: async (workspaceId: string, tileId: string, context: Record<string, unknown>) => {
        const scope = `${workspaceId}:${tileId}`
        tileStates.set(scope, { ...tileStates.get(scope), _context: context })
      },
    }
    tileStates.set('workspace-a:tile-1', { currentUrl: 'https://example.com' })

    const firstHost = createElectrobunTileContextStore({
      now: () => 456,
      persistence,
    })
    await firstHost.set('workspace-a', 'tile-1', 'ctx:durable', { ready: true })

    const restartedHost = createElectrobunTileContextStore({ persistence })
    assert.deepEqual(await restartedHost.get('workspace-a', 'tile-1', 'ctx:durable'), {
      key: 'ctx:durable',
      value: { ready: true },
      updatedAt: 456,
      source: 'tile-1',
    })
    assert.equal(tileStates.get('workspace-a:tile-1')?.currentUrl, 'https://example.com')
  })

  test('reset tombstones an in-flight hydration before deleting persisted state', async () => {
    let releaseLoad: ((value: Record<string, {
      key: string
      value: unknown
      updatedAt: number
      source: string
    }>) => void) | null = null
    let deleted = 0
    const loaded = new Promise<Record<string, {
      key: string
      value: unknown
      updatedAt: number
      source: string
    }>>(resolve => { releaseLoad = resolve })
    const store = createElectrobunTileContextStore({
      persistence: {
        load: async () => deleted > 0 ? {} : await loaded,
        save: async () => {},
        delete: async () => { deleted += 1 },
      },
    })

    const pendingRead = store.getAll('workspace-a', 'tile-1')
    await new Promise(resolve => setImmediate(resolve))
    await store.reset('workspace-a', 'tile-1')
    releaseLoad?.({
      'ctx:deleted': {
        key: 'ctx:deleted',
        value: 'must not return',
        updatedAt: 1,
        source: 'tile-1',
      },
    })

    assert.deepEqual(await pendingRead, [])
    assert.deepEqual(await store.getAll('workspace-a', 'tile-1'), [])
    assert.equal(deleted, 1)
  })
})
