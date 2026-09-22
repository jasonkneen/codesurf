import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatLifecycleCoordinator } from '../src/main/chat/chat-lifecycle-coordinator.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('teardown invalidates blocked preparation immediately, then stops in FIFO order', async () => {
  const coordinator = new ChatLifecycleCoordinator()
  const releasePreparation = deferred()
  const preparationStarted = deferred()
  const order: string[] = []

  const send = coordinator.runSend('workspace-a/card-a', 'foreground', async lease => {
    order.push('prepare:start')
    preparationStarted.resolve()
    await releasePreparation.promise
    if (coordinator.isCurrent(lease)) order.push('dispatch')
    else order.push('prepare:cancelled')
  })
  await preparationStarted.promise

  const teardown = coordinator.runLifecycle('workspace-a/card-a', async () => {
    order.push('teardown')
  })
  assert.deepEqual(order, ['prepare:start'])

  releasePreparation.resolve()
  await Promise.all([send, teardown])
  assert.deepEqual(order, ['prepare:start', 'prepare:cancelled', 'teardown'])
})

test('send arriving during teardown waits and receives a fresh preparation lease', async () => {
  const coordinator = new ChatLifecycleCoordinator()
  const releaseTeardown = deferred()
  const teardownStarted = deferred()
  const order: string[] = []

  const teardown = coordinator.runLifecycle('workspace-a/card-a', async () => {
    order.push('teardown:start')
    teardownStarted.resolve()
    await releaseTeardown.promise
    order.push('teardown:end')
  })
  await teardownStarted.promise

  const send = coordinator.runSend('workspace-a/card-a', 'foreground', lease => {
    order.push(coordinator.isCurrent(lease) ? 'fresh:dispatch' : 'stale:dispatch')
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['teardown:start'])

  releaseTeardown.resolve()
  await Promise.all([teardown, send])
  assert.deepEqual(order, ['teardown:start', 'teardown:end', 'fresh:dispatch'])
})

test('different workspace/card lanes remain independent', async () => {
  const coordinator = new ChatLifecycleCoordinator()
  const releaseFirst = deferred()
  const order: string[] = []

  const first = coordinator.runSend('workspace-a/card-a', 'foreground', async () => {
    order.push('a:start')
    await releaseFirst.promise
    order.push('a:end')
  })
  const second = coordinator.runSend('workspace-b/card-a', 'foreground', () => {
    order.push('b:dispatch')
  })

  await second
  assert.deepEqual(order, ['a:start', 'b:dispatch'])
  releaseFirst.resolve()
  await first
})
