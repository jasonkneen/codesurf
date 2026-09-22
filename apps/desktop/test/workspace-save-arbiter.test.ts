import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { WorkspaceSaveArbiter } from '../src/main/storage/workspaceSaveArbiter.ts'

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

describe('workspace save arbiter', () => {
  test('serializes writes to the same workspace in arrival order', async () => {
    const arbiter = new WorkspaceSaveArbiter()
    const firstGate = deferred()
    const events: string[] = []

    const first = arbiter.run('workspace-a', async () => {
      events.push('first:start')
      await firstGate.promise
      events.push('first:end')
      return 'first'
    })
    const second = arbiter.run('workspace-a', async () => {
      events.push('second:start')
      return 'second'
    })

    await settle()
    assert.deepEqual(events, ['first:start'])
    firstGate.resolve()
    assert.equal(await first, 'first')
    assert.equal(await second, 'second')
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
  })

  test('lets another workspace proceed independently', async () => {
    const arbiter = new WorkspaceSaveArbiter()
    const blocked = deferred()
    const events: string[] = []

    const workspaceA = arbiter.run('workspace-a', async () => {
      events.push('a:start')
      await blocked.promise
    })
    const workspaceB = arbiter.run('workspace-b', async () => {
      events.push('b:start')
    })

    await workspaceB
    assert.deepEqual(events, ['a:start', 'b:start'])
    blocked.resolve()
    await workspaceA
  })

  test('does not let a failed write poison the next save', async () => {
    const arbiter = new WorkspaceSaveArbiter()
    const failure = new Error('disk full')
    const events: string[] = []

    const failed = arbiter.run('workspace-a', async () => {
      events.push('failed')
      throw failure
    })
    const recovered = arbiter.run('workspace-a', async () => {
      events.push('recovered')
      return 42
    })

    await assert.rejects(failed, failure)
    assert.equal(await recovered, 42)
    assert.deepEqual(events, ['failed', 'recovered'])
  })

  test('drops a settled lane instead of retaining workspace keys', async () => {
    const arbiter = new WorkspaceSaveArbiter()
    const running = arbiter.run('workspace-a', async () => 'saved')

    assert.equal(arbiter.activeLaneCount, 1)
    assert.equal(await running, 'saved')
    await settle()
    assert.equal(arbiter.activeLaneCount, 0)
  })
})
