import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildPeerAwareTurnPrompt } from '../src/main/chat/prompt-builders.ts'
import { createChatStreamScope } from '../src/main/chat/room-stream-scope.ts'
import {
  hasNonEmptyProviderResult,
  MAX_STABLE_SESSION_CONTEXTS,
  StableContextAnnouncementCache,
  StableSessionContextCache,
} from '../src/main/chat/stable-session-context.ts'

const STABLE_CONTEXT = [
  'PERSONA: careful maintainer',
  'MEMORY: preserve workspace conventions',
  'SKILLS: use focused verification',
  'CONVENTION: report concise outcomes',
].join('\n')

const providersWithoutSystemChannel = [
  'codex',
  'hermes',
  'opencode',
  'openclaw',
  'csagent',
]

test('non-system providers install stable context once while volatile turn context remains current', () => {
  const cache = new StableSessionContextCache()

  for (const provider of providersWithoutSystemChannel) {
    const scope = createChatStreamScope('workspace-a', `card-${provider}`)
    const first = cache.select({
      scope,
      provider,
      contextPrompt: STABLE_CONTEXT,
    })
    const firstPrompt = buildPeerAwareTurnPrompt(
      'FIRST USER TURN\nROOM: first volatile event',
      first.contextPrompt,
    )
    assert.match(firstPrompt, /PERSONA: careful maintainer/)
    assert.match(firstPrompt, /ROOM: first volatile event/)

    const sessionId = `${provider}-session-1`
    cache.bindSession(first, sessionId)
    const resumed = cache.select({
      scope,
      provider,
      sessionId,
      contextPrompt: STABLE_CONTEXT,
    })
    const resumedPrompt = buildPeerAwareTurnPrompt(
      'SECOND USER TURN\nROOM: second volatile event',
      resumed.contextPrompt,
    )
    assert.equal(resumed.contextPrompt, undefined, `${provider} repeated stable context`)
    assert.doesNotMatch(resumedPrompt, /PERSONA: careful maintainer/)
    assert.match(resumedPrompt, /ROOM: second volatile event/)
    assert.doesNotMatch(resumedPrompt, /ROOM: first volatile event/)
  }
})

test('resume after process restart and fresh no-id turns reinstall stable context', () => {
  const scope = createChatStreamScope('workspace-a', 'card-a')
  const beforeRestart = new StableSessionContextCache()
  const first = beforeRestart.select({
    scope,
    provider: 'codex',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  })
  assert.equal(first.contextPrompt, STABLE_CONTEXT)
  beforeRestart.bindSession(first, 'session-a')
  assert.equal(beforeRestart.select({
    scope,
    provider: 'codex',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  }).contextPrompt, undefined)

  const afterRestart = new StableSessionContextCache()
  assert.equal(afterRestart.select({
    scope,
    provider: 'codex',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  }).contextPrompt, STABLE_CONTEXT)

  const noSession = new StableSessionContextCache()
  assert.equal(noSession.select({
    scope,
    provider: 'hermes',
    contextPrompt: STABLE_CONTEXT,
  }).contextPrompt, STABLE_CONTEXT)
  assert.equal(noSession.select({
    scope,
    provider: 'hermes',
    contextPrompt: STABLE_CONTEXT,
  }).contextPrompt, STABLE_CONTEXT)
})

test('clear, content hash changes, and session replacement each reinstall context', () => {
  const cache = new StableSessionContextCache()
  const scope = createChatStreamScope('workspace-a', 'card-a')
  const input = {
    scope,
    provider: 'openclaw',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  }

  const first = cache.select(input)
  assert.equal(first.contextPrompt, STABLE_CONTEXT)
  assert.equal(first.contextHash.length, 64)
  assert.notEqual(first.contextHash, STABLE_CONTEXT)
  cache.bindSession(first, 'session-a')
  assert.equal(cache.select(input).contextPrompt, undefined)

  const changed = cache.select({ ...input, contextPrompt: `${STABLE_CONTEXT}\nVERSION: 2` })
  assert.match(changed.contextPrompt ?? '', /VERSION: 2/)
  cache.bindSession(changed, 'session-a')
  assert.equal(cache.select({ ...input, contextPrompt: `${STABLE_CONTEXT}\nVERSION: 2` }).contextPrompt, undefined)

  const replacement = cache.select({
    ...input,
    sessionId: 'session-b',
    contextPrompt: `${STABLE_CONTEXT}\nVERSION: 2`,
  })
  assert.match(replacement.contextPrompt ?? '', /VERSION: 2/)
  cache.bindSession(replacement, 'session-b')
  assert.equal(cache.select({
    ...input,
    sessionId: 'session-b',
    contextPrompt: `${STABLE_CONTEXT}\nVERSION: 2`,
  }).contextPrompt, undefined)

  cache.clear(scope, 'openclaw')
  assert.match(cache.select({
    ...input,
    sessionId: 'session-b',
    contextPrompt: `${STABLE_CONTEXT}\nVERSION: 2`,
  }).contextPrompt ?? '', /VERSION: 2/)
})

test('unexpected provider session replacement invalidates a suppressed selection', () => {
  const cache = new StableSessionContextCache()
  const scope = createChatStreamScope('workspace-a', 'card-a')
  const first = cache.select({
    scope,
    provider: 'hermes',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  })
  cache.bindSession(first, 'session-a')

  const suppressed = cache.select({
    scope,
    provider: 'hermes',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  })
  assert.equal(suppressed.contextPrompt, undefined)
  cache.bindSession(suppressed, 'replacement-session')

  assert.equal(cache.select({
    scope,
    provider: 'hermes',
    sessionId: 'replacement-session',
    contextPrompt: STABLE_CONTEXT,
  }).contextPrompt, STABLE_CONTEXT)
})

test('failed or silent first launch does not commit context before acceptance', () => {
  const cache = new StableSessionContextCache()
  const scope = createChatStreamScope('workspace-a', 'card-a')
  const firstAttempt = cache.select({
    scope,
    provider: 'codex',
    contextPrompt: STABLE_CONTEXT,
  })
  assert.equal(firstAttempt.contextPrompt, STABLE_CONTEXT)
  cache.invalidate(firstAttempt)

  const retry = cache.select({
    scope,
    provider: 'codex',
    contextPrompt: STABLE_CONTEXT,
  })
  assert.equal(retry.contextPrompt, STABLE_CONTEXT)

  const accepted = cache.select({
    scope,
    provider: 'codex',
    sessionId: 'session-a',
    contextPrompt: STABLE_CONTEXT,
  })
  cache.bindSession(accepted, 'session-a')
  const failedUpdate = cache.select({
    scope,
    provider: 'codex',
    sessionId: 'session-a',
    contextPrompt: `${STABLE_CONTEXT}\nVERSION: retry-me`,
  })
  assert.match(failedUpdate.contextPrompt ?? '', /retry-me/)
  cache.invalidate(failedUpdate)
  assert.match(cache.select({
    scope,
    provider: 'codex',
    sessionId: 'session-a',
    contextPrompt: `${STABLE_CONTEXT}\nVERSION: retry-me`,
  }).contextPrompt ?? '', /retry-me/)
})

test('session-only successful exit does not commit before real provider acceptance', () => {
  const cache = new StableSessionContextCache()
  const scope = createChatStreamScope('workspace-a', 'card-a')
  const pending = cache.select({
    scope,
    provider: 'hermes',
    contextPrompt: STABLE_CONTEXT,
  })

  // The adapter observed a session and exited zero, but emitted no content,
  // tool activity, or explicit completion acceptance.
  const observedSessionId = 'issued-before-error'
  assert.equal(hasNonEmptyProviderResult(''), false)
  assert.equal(hasNonEmptyProviderResult('   '), false)
  assert.equal(hasNonEmptyProviderResult('real result'), true)
  assert.equal(cache.completeCli(pending, {
    exitCode: 0,
    sawProviderAcceptance: false,
    sessionId: observedSessionId,
  }), false)

  const retry = cache.select({
    scope,
    provider: 'hermes',
    sessionId: observedSessionId,
    contextPrompt: STABLE_CONTEXT,
  })
  assert.equal(retry.contextPrompt, STABLE_CONTEXT)
  assert.equal(cache.completeCli(retry, {
    exitCode: 0,
    sawProviderAcceptance: true,
    sessionId: observedSessionId,
  }), true)
  assert.equal(cache.select({
    scope,
    provider: 'hermes',
    sessionId: observedSessionId,
    contextPrompt: STABLE_CONTEXT,
  }).contextPrompt, undefined)
})

test('same card id stays isolated across workspaces and providers', () => {
  const cache = new StableSessionContextCache()
  const workspaceA = createChatStreamScope('workspace-a', 'same-card')
  const workspaceB = createChatStreamScope('workspace-b', 'same-card')
  const install = (scope: ReturnType<typeof createChatStreamScope>, provider: string) => {
    const selection = cache.select({
      scope,
      provider,
      sessionId: 'same-provider-session-id',
      contextPrompt: STABLE_CONTEXT,
    })
    assert.equal(selection.contextPrompt, STABLE_CONTEXT)
    assert.equal(cache.complete(selection, {
      accepted: true,
      sessionId: 'same-provider-session-id',
    }), true)
  }

  install(workspaceA, 'codex')
  install(workspaceB, 'codex')
  install(workspaceA, 'hermes')

  for (const [scope, provider] of [
    [workspaceA, 'codex'],
    [workspaceB, 'codex'],
    [workspaceA, 'hermes'],
  ] as const) {
    assert.equal(cache.select({
      scope,
      provider,
      sessionId: 'same-provider-session-id',
      contextPrompt: STABLE_CONTEXT,
    }).contextPrompt, undefined)
  }
})

test('cache uses bounded LRU eviction and evicted sessions reinstall context', () => {
  const cache = new StableSessionContextCache(2)
  const scopeA = createChatStreamScope('workspace-a', 'card-a')
  const scopeB = createChatStreamScope('workspace-a', 'card-b')
  const scopeC = createChatStreamScope('workspace-a', 'card-c')
  const select = (scope: ReturnType<typeof createChatStreamScope>, sessionId: string) => {
    const selection = cache.select({
      scope,
      provider: 'codex',
      sessionId,
      contextPrompt: STABLE_CONTEXT,
    })
    cache.bindSession(selection, sessionId)
    return selection
  }

  select(scopeA, 'a')
  select(scopeB, 'b')
  assert.equal(select(scopeA, 'a').contextPrompt, undefined) // touch A; B is oldest
  select(scopeC, 'c')
  assert.equal(cache.size, 2)
  assert.equal(select(scopeB, 'b').contextPrompt, STABLE_CONTEXT)
  assert.equal(cache.size, 2)
  assert.ok(MAX_STABLE_SESSION_CONTEXTS >= cache.size)
})

test('workspace instruction chips announce once until content or session changes', () => {
  const cache = new StableContextAnnouncementCache()
  const input = {
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    kind: 'memory',
    content: '## Workspace Instructions\nFollow AGENTS.md',
  }

  assert.equal(cache.consume(input), true)
  assert.equal(cache.consume({ ...input, sessionId: 'session-a' }), false)
  assert.equal(cache.consume({ ...input, sessionId: 'session-a' }), false)
  assert.equal(cache.consume({
    ...input,
    sessionId: 'session-a',
    content: '## Workspace Instructions\nUpdated rules',
  }), true)
  assert.equal(cache.consume({
    ...input,
    sessionId: 'session-b',
    content: '## Workspace Instructions\nUpdated rules',
  }), true)
  cache.clear('workspace-a', 'card-a')
  assert.equal(cache.consume({
    ...input,
    sessionId: 'session-b',
    content: '## Workspace Instructions\nUpdated rules',
  }), true)
  assert.equal(cache.consume({ ...input, kind: 'skills', sessionId: 'session-b' }), true)
})

test('runtime provider wiring uses the cache and Claude retains its true system channel', () => {
  const root = process.cwd()
  const cachedProviderFiles = [
    'src/main/chat/providers/codex.ts',
    'src/main/chat/providers/hermes.ts',
    'src/main/chat/providers/opencode.ts',
    'src/main/chat/providers/openclaw.ts',
    'src/main/chat/pi-runtime.ts',
  ]
  for (const file of cachedProviderFiles) {
    const source = readFileSync(resolve(root, file), 'utf8')
    assert.match(source, /selectStableContextForTurn/, `${file} bypasses stable context lifecycle`)
  }
  for (const file of [
    'src/main/chat/providers/codex.ts',
    'src/main/chat/providers/hermes.ts',
    'src/main/chat/providers/openclaw.ts',
  ]) {
    const source = readFileSync(resolve(root, file), 'utf8')
    assert.match(source, /completeStableContextCliTurn/, `${file} bypasses acceptance-gated commit`)
  }

  const codex = readFileSync(resolve(root, 'src/main/chat/providers/codex.ts'), 'utf8')
  const codexSessionEvent = codex.match(/if \(evt\.type === 'thread\.started'[\s\S]*?\n    }/)?.[0] ?? ''
  assert.ok(codexSessionEvent)
  assert.doesNotMatch(codexSessionEvent, /bindStableContextSession/)

  const hermes = readFileSync(resolve(root, 'src/main/chat/providers/hermes.ts'), 'utf8')
  const hermesSessionEvent = hermes.match(/case 'session':[\s\S]*?\n          break/)?.[0] ?? ''
  assert.ok(hermesSessionEvent)
  assert.doesNotMatch(hermesSessionEvent, /bindStableContextSession/)

  const claude = readFileSync(resolve(root, 'src/main/chat/providers/claude.ts'), 'utf8')
  assert.doesNotMatch(claude, /selectStableContextForTurn/)
  assert.match(claude, /const systemPrompt = req\.contextPrompt\?\.trim\(\) \|\| undefined/)

  const runtime = readFileSync(resolve(root, 'src/main/chat/runtime.ts'), 'utf8')
  assert.match(runtime, /deleteCardSessionIds[\s\S]*clearStableSessionContext\(scope\)/)
})
