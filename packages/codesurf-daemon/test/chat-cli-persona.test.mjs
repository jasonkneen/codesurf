// #cli-persona: `codesurf chat` persona selection. The CLI sends ONLY the persona
// id (request.agentId) and NEVER a trusted agentMode — the daemon resolves
// tools/permissions authoritatively. These tests cover flag parsing, the start
// request shape (agentId present, agentMode ABSENT), the model-precedence ladder,
// and the persona-aware session identity (resume never crosses a persona change).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  parseChatArgs,
  resolveChatArgs,
  buildStartRequest,
} from '@codesurf/daemon/chat-cli'
import {
  upsertChatCliSession,
  chatCliSessionKey,
} from '@codesurf/daemon/chat-session-store'

async function makeHomeDir() {
  return await mkdtempP(join(tmpdir(), 'chat-cli-persona-'))
}

// ─── flag parsing ─────────────────────────────────────────────────────────────

test('parseChatArgs: --persona selects a persona and keeps the message', () => {
  const parsed = parseChatArgs(['--persona', 'polly', 'review', 'this'])
  assert.equal(parsed.persona, 'polly')
  assert.equal(parsed.message, 'review this')
  assert.equal(parsed.listPersonas, false)
})

test('parseChatArgs: --agent is an alias for --persona; --persona=/--agent= forms work', () => {
  assert.equal(parseChatArgs(['--agent', 'gemma']).persona, 'gemma')
  assert.equal(parseChatArgs(['--persona=ask']).persona, 'ask')
  assert.equal(parseChatArgs(['--agent=plan']).persona, 'plan')
})

test('parseChatArgs: --list-personas (and --list-agents alias) sets the list flag', () => {
  assert.equal(parseChatArgs(['--list-personas']).listPersonas, true)
  assert.equal(parseChatArgs(['--list-agents']).listPersonas, true)
})

test('parseChatArgs: no persona flags → persona null, list flag false', () => {
  const parsed = parseChatArgs(['hello'])
  assert.equal(parsed.persona, null)
  assert.equal(parsed.listPersonas, false)
})

// ─── start request shape: agentId present, agentMode ABSENT (security core) ─────

test('buildStartRequest: carries agentId and NEVER an agentMode', () => {
  const args = resolveChatArgs(parseChatArgs(['--persona', 'ask']), '/no/such/home')
  const request = buildStartRequest({ args, prior: null, message: 'go', workspaceId: 'ws-cli' })
  assert.equal(request.agentId, 'ask', 'the persona id is sent as agentId')
  assert.equal(request.workspaceId, 'ws-cli', 'chat starts against a registered workspace id')
  assert.ok(!('agentMode' in request), 'the CLI must NEVER send a trusted agentMode payload')
  assert.deepEqual(request.messages, [{ role: 'user', content: 'go' }])
})

test('buildStartRequest: no persona → no agentId key and still no agentMode', () => {
  const args = resolveChatArgs(parseChatArgs(['hi']), '/no/such/home')
  const request = buildStartRequest({ args, prior: null, message: 'go', workspaceId: 'ws-cli' })
  assert.ok(!('agentId' in request), 'no persona selected → no agentId field')
  assert.ok(!('agentMode' in request), 'never an agentMode')
})

// ─── model precedence ladder ──────────────────────────────────────────────────

test('precedence: a persona soft default seeds provider AND model', async t => {
  const homeDir = await makeHomeDir()
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })
  const args = resolveChatArgs(
    parseChatArgs(['--persona', 'polly']),
    homeDir,
    { provider: 'claude', model: 'claude-opus-4-8' },
  )
  assert.equal(args.provider, 'claude')
  assert.equal(args.model, 'claude-opus-4-8')
  assert.equal(args.agentId, 'polly')
})

test('precedence: explicit --provider/--model OVERRIDE the persona soft default', async t => {
  const homeDir = await makeHomeDir()
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })
  const args = resolveChatArgs(
    parseChatArgs(['--persona', 'polly', '--provider', 'codex', '--model', 'gpt-5.5']),
    homeDir,
    { provider: 'claude', model: 'claude-opus-4-8' },
  )
  assert.equal(args.provider, 'codex', 'explicit provider wins over the soft default')
  assert.equal(args.model, 'gpt-5.5', 'explicit model wins over the soft default')
})

test('precedence: no persona seed and no flags → built-in defaults', async t => {
  const homeDir = await makeHomeDir()
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })
  const args = resolveChatArgs(parseChatArgs([]), homeDir, null)
  assert.equal(args.provider, 'claude')
  assert.equal(args.model, 'claude-sonnet-4-6')
  assert.equal(args.agentId, '')
})

// ─── session identity is persona-aware (resume never crosses a persona change) ──

test('session identity: the key includes the persona id', () => {
  const workspaceDir = resolve('/tmp/ws')
  const base = { provider: 'claude', model: 'claude-sonnet-4-6', workspaceDir }
  const keyNone = chatCliSessionKey(base)
  const keyA = chatCliSessionKey({ ...base, agentId: 'persona-a' })
  const keyB = chatCliSessionKey({ ...base, agentId: 'persona-b' })
  assert.notEqual(keyA, keyB, 'different personas → different session keys')
  assert.notEqual(keyA, keyNone, 'a persona key differs from the no-persona key')
})

test('precedence: a saved session is inherited ONLY when the persona matches', async t => {
  const homeDir = await makeHomeDir()
  const workspaceDir = await mkdtempP(join(tmpdir(), 'chat-cli-persona-ws-'))
  t.after(async () => {
    await rmP(homeDir, { recursive: true, force: true })
    await rmP(workspaceDir, { recursive: true, force: true })
  })

  // A saved session for persona 'alpha' with a non-default provider/model.
  upsertChatCliSession(homeDir, {
    provider: 'codex',
    model: 'gpt-5.5',
    workspaceDir,
    agentId: 'alpha',
    sessionId: 'thread-alpha',
    jobId: 'job-alpha',
    lastSequence: 1,
  })

  // Re-selecting 'alpha' (no explicit flags, no seed) inherits the saved pair.
  const samePersona = resolveChatArgs(
    parseChatArgs(['--persona', 'alpha', '--workspace', workspaceDir]),
    homeDir,
    null,
  )
  assert.equal(samePersona.provider, 'codex', 'same persona inherits the saved provider')
  assert.equal(samePersona.model, 'gpt-5.5', 'same persona inherits the saved model')

  // Switching to 'beta' must NOT inherit alpha's provider/model — falls to defaults.
  const otherPersona = resolveChatArgs(
    parseChatArgs(['--persona', 'beta', '--workspace', workspaceDir]),
    homeDir,
    null,
  )
  assert.equal(otherPersona.provider, 'claude', 'a persona switch does not inherit the prior persona session')
  assert.equal(otherPersona.model, 'claude-sonnet-4-6')
})
