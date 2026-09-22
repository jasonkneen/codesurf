import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatPreparationFence } from '../src/main/chat/chat-preparation-fence.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('a replacement foreground send prevents an older blocked preparation from launching', async () => {
  const fence = new ChatPreparationFence()
  const gate = deferred()
  const effects: string[] = []
  const oldLease = fence.begin('workspace-a/card-a', 'foreground')
  const blockedOld = (async () => {
    await gate.promise
    if (fence.isCurrent(oldLease)) effects.push('old launch')
  })()

  const replacement = fence.begin('workspace-a/card-a', 'foreground')
  gate.resolve()
  await blockedOld
  if (fence.isCurrent(replacement)) effects.push('replacement launch')

  assert.deepEqual(effects, ['replacement launch'])
})

test('stop or clear invalidates blocked prep before capability, room, or launch effects', async () => {
  const fence = new ChatPreparationFence()
  const gate = deferred()
  const effects: string[] = []
  const lease = fence.begin('workspace-a/card-a', 'foreground')
  const blocked = (async () => {
    await gate.promise
    if (!fence.isCurrent(lease)) return
    effects.push('consume capability', 'consume room', 'launch')
  })()

  fence.invalidate('workspace-a/card-a')
  gate.resolve()
  await blocked
  assert.deepEqual(effects, [])
})

test('background preparations coexist until a foreground or lifecycle invalidation', () => {
  const fence = new ChatPreparationFence()
  const first = fence.begin('workspace-a/card-a', 'background')
  const second = fence.begin('workspace-a/card-a', 'background')
  assert.equal(fence.isCurrent(first), true)
  assert.equal(fence.isCurrent(second), true)

  fence.begin('workspace-a/card-a', 'foreground')
  assert.equal(fence.isCurrent(first), false)
  assert.equal(fence.isCurrent(second), false)
})

test('a concurrent clear invalidates both an old send and its foreground replacement', () => {
  const fence = new ChatPreparationFence()
  const oldSend = fence.begin('workspace-a/card-a', 'foreground')
  const replacement = fence.begin('workspace-a/card-a', 'foreground')
  fence.invalidate('workspace-a/card-a')

  assert.equal(fence.isCurrent(oldSend), false)
  assert.equal(fence.isCurrent(replacement), false)
})
