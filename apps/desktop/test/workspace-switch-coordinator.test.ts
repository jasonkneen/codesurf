import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  commitWorkspaceCanvasOwnership,
  LatestWorkspaceSwitchCoordinator,
  transitionToWorkspacePicker,
} from '../src/renderer/src/lib/workspaceSwitchCoordinator.ts'
import {
  OrderedDebouncedPersistence,
  type PersistenceTimers,
} from '../src/renderer/src/lib/orderedCanvasPersistence.ts'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function controlledTimers(): PersistenceTimers & { fire: () => void } {
  let callback: (() => void) | null = null
  return {
    setTimeout(next) {
      callback = next
      return 1
    },
    clearTimeout() {
      callback = null
    },
    fire() {
      const next = callback
      callback = null
      next?.()
    },
  }
}

describe('latest workspace switch coordinator', () => {
  test('ignores a stale load that resolves after the newer workspace', async () => {
    const coordinator = new LatestWorkspaceSwitchCoordinator()
    const workspaceB = deferred<string>()
    const workspaceC = deferred<string>()
    const applied: string[] = []

    const tokenB = coordinator.begin()
    const switchingToB = workspaceB.promise.then(async loaded => {
      await coordinator.commitLatest(tokenB, async isCurrent => {
        if (isCurrent()) applied.push(loaded)
      })
    })

    const tokenC = coordinator.begin()
    const switchingToC = workspaceC.promise.then(async loaded => {
      await coordinator.commitLatest(tokenC, async isCurrent => {
        if (isCurrent()) applied.push(loaded)
      })
    })

    workspaceC.resolve('workspace-c')
    await switchingToC
    workspaceB.resolve('workspace-b')
    await switchingToB

    assert.deepEqual(applied, ['workspace-c'])
  })

  test('serializes current commits and rechecks freshness after awaited work', async () => {
    const coordinator = new LatestWorkspaceSwitchCoordinator()
    const firstCommit = deferred<void>()
    const applied: string[] = []

    const tokenB = coordinator.begin()
    const committingB = coordinator.commitLatest(tokenB, async isCurrent => {
      await firstCommit.promise
      if (isCurrent()) applied.push('workspace-b')
    })
    const tokenC = coordinator.begin()
    const committingC = coordinator.commitLatest(tokenC, async isCurrent => {
      if (isCurrent()) applied.push('workspace-c')
    })

    firstCommit.resolve()
    await Promise.all([committingB, committingC])

    assert.deepEqual(applied, ['workspace-c'])
  })

  test('picker and last-tab transition flush dirty A before clearing refs and cancel its stale debounce', async () => {
    const coordinator = new LatestWorkspaceSwitchCoordinator()
    const timers = controlledTimers()
    const writes: Array<{ workspaceId: string; tiles: string[] }> = []
    const owner = { current: 'workspace-a' as string | null }
    const refs = { tiles: ['a-final'] }
    const persistence = new OrderedDebouncedPersistence<{ workspaceId: string; tiles: string[] }>(
      async value => {
        writes.push(value)
      },
      500,
      timers,
    )

    persistence.schedule(() => ({
      workspaceId: 'workspace-a',
      tiles: [...refs.tiles],
    }))

    const committed = await transitionToWorkspacePicker({
      coordinator,
      outgoingWorkspaceId: owner.current,
      flushOutgoing: async workspaceId => {
        await persistence.flush(() => ({
          workspaceId,
          tiles: [...refs.tiles],
        }))
      },
      commitPicker: () => {
        commitWorkspaceCanvasOwnership(
          null,
          owner,
          () => {},
          () => {
            refs.tiles = []
          },
        )
      },
    })

    assert.equal(committed, true)
    assert.equal(owner.current, null)
    assert.deepEqual(refs.tiles, [])
    assert.deepEqual(writes, [{
      workspaceId: 'workspace-a',
      tiles: ['a-final'],
    }])

    // A canceled debounce callback cannot later persist the picker's empty
    // refs into workspace A. This is the same transition used by the plus tab
    // and closing the final workspace tab.
    timers.fire()
    await persistence.waitForIdle()
    assert.deepEqual(writes, [{
      workspaceId: 'workspace-a',
      tiles: ['a-final'],
    }])

    // A subsequent switch to B and immediate quit challenge writes B only;
    // workspace A remains the exact pre-picker snapshot.
    const bTimers = controlledTimers()
    const workspaceB = new OrderedDebouncedPersistence<{
      workspaceId: string
      tiles: string[]
    }>(
      async value => {
        writes.push(value)
      },
      500,
      bTimers,
    )
    commitWorkspaceCanvasOwnership(
      'workspace-b',
      owner,
      () => {},
      () => {
        refs.tiles = ['b-final']
      },
    )
    workspaceB.schedule(() => ({
      workspaceId: owner.current!,
      tiles: [...refs.tiles],
    }))
    await workspaceB.flush(() => ({
      workspaceId: owner.current!,
      tiles: [...refs.tiles],
    }), { force: true })
    assert.deepEqual(writes, [
      {
        workspaceId: 'workspace-a',
        tiles: ['a-final'],
      },
      {
        workspaceId: 'workspace-b',
        tiles: ['b-final'],
      },
    ])
  })

  test('synchronous ownership transfer makes an immediate lifecycle flush write only B refs', async () => {
    const writes: Array<{ workspaceId: string; tiles: string[] }> = []
    const owner = { current: 'workspace-a' as string | null }
    const internalOwners: Array<string | null> = []
    const refs = { tiles: ['a-stale'] }

    commitWorkspaceCanvasOwnership(
      'workspace-b',
      owner,
      workspaceId => {
        internalOwners.push(workspaceId)
      },
      () => {
        refs.tiles = ['b-loaded']
      },
    )

    const persistence = new OrderedDebouncedPersistence<{ workspaceId: string; tiles: string[] }>(
      async value => {
        writes.push(value)
      },
      500,
    )
    await persistence.flush(() => ({
      workspaceId: owner.current!,
      tiles: [...refs.tiles],
    }), { force: true })

    assert.equal(owner.current, 'workspace-b')
    assert.deepEqual(internalOwners, ['workspace-b'])
    assert.deepEqual(writes, [{
      workspaceId: 'workspace-b',
      tiles: ['b-loaded'],
    }])
  })
})
