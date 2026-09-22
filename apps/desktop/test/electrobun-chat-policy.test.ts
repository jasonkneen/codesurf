import assert from 'node:assert/strict'
import test from 'node:test'
import { electrobunCodexPermissionArgs } from '../electrobun/bun/chat-policy.ts'

test('Electrobun Codex only bypasses sandbox and approvals for explicit full-access', () => {
  for (const mode of [undefined, null, 'default', 'unexpected-renderer-mode']) {
    const args = electrobunCodexPermissionArgs(mode)
    assert.deepEqual(args, ['--sandbox', 'workspace-write', '-c', 'approval_policy=on-request'])
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
  }
  assert.deepEqual(
    electrobunCodexPermissionArgs('full-access'),
    ['--dangerously-bypass-approvals-and-sandbox'],
  )
})
