import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalProxyTurnFence } from '../src/main/chat/local-proxy-turn-fence.ts'

test('replacement and stop permanently invalidate older local-proxy turns', () => {
  const fence = new LocalProxyTurnFence()
  const first = fence.begin('workspace-a/card-a')
  assert.equal(fence.isCurrent('workspace-a/card-a', first), true)

  const replacement = fence.begin('workspace-a/card-a')
  assert.equal(fence.isCurrent('workspace-a/card-a', first), false)
  assert.equal(fence.finish('workspace-a/card-a', first), false)
  assert.equal(fence.isCurrent('workspace-a/card-a', replacement), true)

  fence.invalidate('workspace-a/card-a')
  assert.equal(fence.isCurrent('workspace-a/card-a', replacement), false)

  const afterStop = fence.begin('workspace-a/card-a')
  assert.notEqual(afterStop, first)
  assert.notEqual(afterStop, replacement)
  assert.equal(fence.finish('workspace-a/card-a', afterStop), true)
  assert.equal(fence.isCurrent('workspace-a/card-a', afterStop), false)
})

test('local-proxy turn generations are isolated by full scope key', () => {
  const fence = new LocalProxyTurnFence()
  const workspaceA = fence.begin('workspace-a/same-card')
  const workspaceB = fence.begin('workspace-b/same-card')

  assert.equal(fence.isCurrent('workspace-a/same-card', workspaceA), true)
  assert.equal(fence.isCurrent('workspace-b/same-card', workspaceB), true)
  assert.equal(fence.finish('workspace-a/same-card', workspaceA), true)
  assert.equal(fence.isCurrent('workspace-b/same-card', workspaceB), true)
})
