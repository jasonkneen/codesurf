import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonJobRegistry } from '../src/main/chat/daemon-job-registry.ts'

test('two detached jobs coexist and either can complete without deleting the other', async () => {
  const registry = new DaemonJobRegistry<string>()
  const first = registry.register('workspace-a/card-a', 'job-1', 'host-a', 'background')
  const second = registry.register('workspace-a/card-a', 'job-2', 'host-a', 'background')

  assert.deepEqual(registry.list('workspace-a/card-a').map(job => job.jobId), ['job-1', 'job-2'])
  assert.equal(registry.complete(first), true)
  await first.done
  assert.equal(registry.isActive(second), true)
  assert.deepEqual(registry.list('workspace-a/card-a').map(job => job.jobId), ['job-2'])
})

test('foreground and background jobs are all claimed and aborted for teardown', async () => {
  const registry = new DaemonJobRegistry<string>()
  const foreground = registry.register('workspace-a/card-a', 'job-fg', 'host-a', 'foreground')
  const background = registry.register('workspace-a/card-a', 'job-bg', 'host-b', 'background')
  const cancelled: string[] = []
  let cancellationSettled = false

  const cancellation = registry.cancelAll('workspace-a/card-a', async job => {
    cancelled.push(job.jobId)
  }).finally(() => { cancellationSettled = true })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(cancelled, ['job-fg', 'job-bg'])
  assert.equal(foreground.abortController.signal.aborted, true)
  assert.equal(background.abortController.signal.aborted, true)
  assert.deepEqual(registry.list('workspace-a/card-a'), [])
  assert.equal(cancellationSettled, false)

  // Teardown awaits completion for both registrations, not only remote cancel.
  assert.equal(registry.complete(foreground), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancellationSettled, false)
  assert.equal(registry.complete(background), false)
  const claimed = await cancellation
  assert.deepEqual(claimed.map(job => [job.jobId, job.kind]), [
    ['job-fg', 'foreground'],
    ['job-bg', 'background'],
  ])
  assert.equal(cancellationSettled, true)
})

test('a stale callback for the same job id cannot delete its replacement', async () => {
  const registry = new DaemonJobRegistry<string>()
  const old = registry.register('workspace-a/card-a', 'job-1', 'host-a', 'foreground')
  const replacement = registry.register('workspace-a/card-a', 'job-1', 'host-a', 'foreground')

  assert.equal(old.abortController.signal.aborted, true)
  await old.done
  assert.equal(registry.complete(old), false)
  assert.equal(registry.isActive(replacement), true)
})
