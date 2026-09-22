import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mergeTileState } from '../src/main/storage/workspaceArtifacts.ts'
import { TileStateSaveCoordinator } from '../src/main/storage/tileStateSaveCoordinator.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('tile state save coordinator', () => {
  test('preserves concurrent state and context patches in one artifact', async () => {
    const coordinator = new TileStateSaveCoordinator()
    const firstRead = deferred()
    const releaseFirstWrite = deferred()
    let state: unknown = { addressBar: '/start', currentUrl: '/start' }

    const savePatch = (patch: unknown, pauseAfterRead = false) =>
      coordinator.run('workspace-a', 'browser-a', async () => {
        const existing = structuredClone(state)
        if (pauseAfterRead) {
          firstRead.resolve()
          await releaseFirstWrite.promise
        }
        state = mergeTileState(existing, patch)
      })

    const navigationSave = savePatch({ addressBar: '/next', currentUrl: '/next' }, true)
    await firstRead.promise
    const contextSave = savePatch({
      _context: {
        'ctx:browser:navigation': {
          value: { currentUrl: '/next', title: 'Next page' },
        },
      },
    })

    await settle()
    assert.deepEqual(state, { addressBar: '/start', currentUrl: '/start' })
    releaseFirstWrite.resolve()
    await Promise.all([navigationSave, contextSave])

    assert.deepEqual(state, {
      addressBar: '/next',
      currentUrl: '/next',
      _context: {
        'ctx:browser:navigation': {
          value: { currentUrl: '/next', title: 'Next page' },
        },
      },
    })
  })

  test('keeps collision-prone tuple keys independent and recovers after failure', async () => {
    const coordinator = new TileStateSaveCoordinator()
    const blocked = deferred()
    const events: string[] = []

    const first = coordinator.run('workspace:a', 'tile', async () => {
      events.push('first:start')
      await blocked.promise
      events.push('first:end')
    })
    const independent = coordinator.run('workspace', 'a:tile', async () => {
      events.push('independent')
    })

    await independent
    assert.deepEqual(events, ['first:start', 'independent'])
    blocked.resolve()
    await first

    await assert.rejects(
      coordinator.run('workspace:a', 'tile', async () => {
        throw new Error('write failed')
      }),
      /write failed/,
    )
    await coordinator.run('workspace:a', 'tile', async () => {
      events.push('recovered')
    })
    assert.equal(events.at(-1), 'recovered')
    await settle()
    assert.equal(coordinator.activeLaneCount, 0)
  })
})
