import assert from 'node:assert/strict'
import test from 'node:test'
import { ElectrobunCodexStableContextRuntime } from '../electrobun/bun/codex-stable-context-runtime.ts'
import type { ChatRequest } from '../src/main/chat/types.ts'

const workspaceDir = '/tmp/codesurf-electrobun-stable-context-workspace'
const scope = { workspaceId: 'workspace-a', cardId: 'card-a' }

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    cardId: scope.cardId,
    workspaceId: scope.workspaceId,
    workspaceDir,
    provider: 'codex',
    model: 'gpt-5.5',
    mode: 'full-access',
    messages: [{ role: 'user', content: 'Inspect the repository' }],
    memoryPrompt: 'ELECTROBUN-STABLE-MEMORY-4815',
    roomContext: 'ELECTROBUN-FIRST-ROOM-5926',
    ...overrides,
  }
}

test('Electrobun Codex suppresses stable context only after accepted installation in the exact thread', () => {
  const runtime = new ElectrobunCodexStableContextRuntime()

  const unprovenResume = runtime.prepare(
    request(),
    'First turn',
    workspaceDir,
    scope,
    'thread-a',
  )
  assert.match(unprovenResume.args.at(-1) ?? '', /ELECTROBUN-STABLE-MEMORY-4815/)
  assert.equal(runtime.complete(unprovenResume, {
    exitCode: 1,
    sawProviderAcceptance: false,
    sessionId: 'thread-a',
  }), false)

  const retry = runtime.prepare(request(), 'Retry turn', workspaceDir, scope, 'thread-a')
  assert.match(retry.args.at(-1) ?? '', /ELECTROBUN-STABLE-MEMORY-4815/)
  assert.equal(runtime.complete(retry, {
    exitCode: 0,
    sawProviderAcceptance: true,
    sessionId: 'thread-a',
  }), true)

  const resumed = runtime.prepare(
    request({ roomContext: 'ELECTROBUN-SECOND-ROOM-6037' }),
    'Second turn',
    workspaceDir,
    scope,
    'thread-a',
  )
  const resumedPrompt = resumed.args.at(-1) ?? ''
  assert.doesNotMatch(resumedPrompt, /ELECTROBUN-STABLE-MEMORY-4815/)
  assert.match(resumedPrompt, /ELECTROBUN-SECOND-ROOM-6037/)
  assert.doesNotMatch(resumedPrompt, /ELECTROBUN-FIRST-ROOM-5926/)

  const changed = runtime.prepare(
    request({ memoryPrompt: 'ELECTROBUN-CHANGED-MEMORY-7148' }),
    'Changed stable context',
    workspaceDir,
    scope,
    'thread-a',
  )
  assert.match(changed.args.at(-1) ?? '', /ELECTROBUN-CHANGED-MEMORY-7148/)
})

test('Electrobun Codex reinstalls stable context after process restart and explicit clear', () => {
  const beforeRestart = new ElectrobunCodexStableContextRuntime()
  const installed = beforeRestart.prepare(request(), 'Install', workspaceDir, scope, 'thread-a')
  assert.equal(beforeRestart.complete(installed, {
    exitCode: 0,
    sawProviderAcceptance: true,
    sessionId: 'thread-a',
  }), true)

  const afterRestart = new ElectrobunCodexStableContextRuntime()
  assert.match(
    afterRestart.prepare(request(), 'After restart', workspaceDir, scope, 'thread-a').args.at(-1) ?? '',
    /ELECTROBUN-STABLE-MEMORY-4815/,
  )

  beforeRestart.clear(scope)
  assert.match(
    beforeRestart.prepare(request(), 'After clear', workspaceDir, scope, 'thread-a').args.at(-1) ?? '',
    /ELECTROBUN-STABLE-MEMORY-4815/,
  )
})
