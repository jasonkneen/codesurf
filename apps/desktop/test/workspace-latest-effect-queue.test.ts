import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { WorkspaceLatestEffectQueue } from '../src/main/storage/workspaceLatestEffectQueue.ts'

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

describe('workspace latest effect queue', () => {
  test('prevents an older reverse-resolving effect from becoming final state', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const started: string[] = []
    let projected = ''
    const queue = new WorkspaceLatestEffectQueue<string>(async (_workspaceId, value) => {
      started.push(value)
      await (value === 'first' ? firstGate.promise : secondGate.promise)
      projected = value
    })

    queue.schedule('workspace-a', 'first')
    await settle()
    queue.schedule('workspace-a', 'second')

    // Resolve the newer operation first. It cannot overlap the older effect;
    // after the older one settles, the queued newer value still wins.
    secondGate.resolve()
    await settle()
    assert.deepEqual(started, ['first'])

    firstGate.resolve()
    await queue.waitForIdle('workspace-a')
    assert.deepEqual(started, ['first', 'second'])
    assert.equal(projected, 'second')
  })

  test('coalesces pending effects to the latest workspace value', async () => {
    const firstGate = deferred()
    const applied: string[] = []
    const queue = new WorkspaceLatestEffectQueue<string>(async (_workspaceId, value) => {
      if (value === 'first') await firstGate.promise
      applied.push(value)
    })

    queue.schedule('workspace-a', 'first')
    await settle()
    queue.schedule('workspace-a', 'second')
    queue.schedule('workspace-a', 'third')
    firstGate.resolve()

    await queue.waitForIdle('workspace-a')
    assert.deepEqual(applied, ['first', 'third'])
  })

  test('isolates workspaces and recovers after an effect failure', async () => {
    const errors: Array<{ workspaceId: string; error: unknown }> = []
    const applied: string[] = []
    const queue = new WorkspaceLatestEffectQueue<string>(
      async (workspaceId, value) => {
        if (value === 'failed') throw new Error('relay unavailable')
        applied.push(`${workspaceId}:${value}`)
      },
      (workspaceId, error) => {
        errors.push({ workspaceId, error })
      },
    )

    queue.schedule('workspace-a', 'failed')
    queue.schedule('workspace-b', 'ready')
    await Promise.all([
      queue.waitForIdle('workspace-a'),
      queue.waitForIdle('workspace-b'),
    ])
    queue.schedule('workspace-a', 'recovered')
    await queue.waitForIdle('workspace-a')

    assert.equal(errors.length, 1)
    assert.equal(errors[0].workspaceId, 'workspace-a')
    assert.deepEqual(applied.sort(), ['workspace-a:recovered', 'workspace-b:ready'])
  })

  test('deactivation cancels pending work and invalidates a suspended effect before resources are recreated', async () => {
    const suspended = deferred()
    const started: string[] = []
    let runtimes = 0
    let subscriptions = 0
    let processes = 0
    const queue = new WorkspaceLatestEffectQueue<string>(
      async (_workspaceId, value, context) => {
        started.push(value)
        if (value === 'suspended') await suspended.promise
        if (!context.isActive()) return
        runtimes += 1
        subscriptions += 1
        processes += 1
      },
    )

    queue.schedule('workspace-a', 'suspended')
    await settle()
    queue.schedule('workspace-a', 'must-be-cancelled')
    queue.deactivate()
    suspended.resolve()
    await queue.waitForIdle('workspace-a')

    assert.deepEqual(started, ['suspended'])
    assert.equal(runtimes, 0)
    assert.equal(subscriptions, 0)
    assert.equal(processes, 0)

    assert.equal(queue.schedule('workspace-a', 'ignored-while-stopped'), false)
    assert.deepEqual(started, ['suspended'])

    queue.activate()
    assert.equal(queue.schedule('workspace-a', 'fresh-generation'), true)
    await queue.waitForIdle('workspace-a')
    assert.deepEqual(started, ['suspended', 'fresh-generation'])
    assert.equal(runtimes, 1)
    assert.equal(subscriptions, 1)
    assert.equal(processes, 1)
  })
})
