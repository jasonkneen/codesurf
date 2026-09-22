import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ChatPolicyError,
  DEFAULT_PERSONAS,
  MAX_PERSONA_INHERITANCE_DEPTH,
  MAX_PERSONA_PROMPT_BYTES,
  assertProviderPersonaEnforceable,
  bindChatRequestToWorkspace,
  codexExecPermissionArgs,
  listAuthoritativePersonas,
  overlayAuthoritativePersonas,
  resolveAuthoritativePersona,
} from '@codesurf/daemon/chat-policy'
import {
  applyAuthoritativePersonaPolicy,
  canonicalizeElectronChatRequest,
} from '../src/main/chat/request-policy.ts'
import type { ChatRequest } from '../src/main/chat/types.ts'

function persona(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'reader',
    name: 'Reader',
    description: '',
    systemPrompt: 'Read carefully.',
    tools: ['Read'],
    icon: 'help',
    color: '#123456',
    isBuiltin: false,
    ...overrides,
  }
}

function expectInvalid(document: unknown, pattern: RegExp): void {
  assert.throws(
    () => overlayAuthoritativePersonas(document),
    error => error instanceof ChatPolicyError
      && error.code === 'CHAT_PERSONA_INVALID'
      && pattern.test(error.message),
  )
}

test('strict persona policy rejects malformed, ambiguous, and unbounded documents', () => {
  expectInvalid([persona({ tools: 'Read' })], /tools must be null or an array/)
  expectInvalid([persona({ surprise: true })], /unknown field surprise/)
  expectInvalid([persona({ defaultBinding: { provider: 'codex', typo: true } })], /unknown field typo/)
  expectInvalid([persona(), persona({ name: 'Duplicate' })], /duplicate persona id/)
  expectInvalid([persona({ id: '../reader' })], /id is invalid/)
  expectInvalid([persona({ name: '   ' })], /name must not be empty/)
  expectInvalid([persona({ skills: [''] })], /empty or duplicate/)
  expectInvalid([persona({ systemPrompt: 'x'.repeat(MAX_PERSONA_PROMPT_BYTES + 1) })], /systemPrompt exceeds/)
  expectInvalid([persona({ extends: 'missing' })], /extends missing persona/)
})

test('strict persona inheritance is bounded, acyclic, and cannot widen tools', () => {
  expectInvalid([
    persona({ id: 'a', extends: 'b' }),
    persona({ id: 'b', extends: 'a' }),
  ], /inheritance cycle/)

  const deep = Array.from({ length: MAX_PERSONA_INHERITANCE_DEPTH + 2 }, (_, index) =>
    persona({
      id: `depth-${index}`,
      ...(index < MAX_PERSONA_INHERITANCE_DEPTH + 1 ? { extends: `depth-${index + 1}` } : {}),
    }))
  expectInvalid(deep, /inheritance exceeds depth/)

  expectInvalid([
    persona({ id: 'none', tools: [] }),
    persona({ id: 'none-child', extends: 'none', tools: null }),
  ], /cannot widen/)
  expectInvalid([
    { id: 'ask', tools: null },
  ], /cannot widen/)

  const narrowed = overlayAuthoritativePersonas([
    { id: 'ask', name: 'Safer Ask', tools: ['Read'] },
  ]).find(entry => entry.id === 'ask')
  assert.deepEqual(narrowed?.tools, ['Read'])
  assert.equal(narrowed?.name, 'Safer Ask')
})

test('default persona listings do not expose mutable policy arrays', async () => {
  const first = await listAuthoritativePersonas('')
  const ask = first.find(entry => entry.id === 'ask')!
  ask.tools!.push('Write')

  const second = await listAuthoritativePersonas('')
  assert.deepEqual(second.find(entry => entry.id === 'ask')?.tools, [
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
  ])
})

test('provider policy refuses restrictions a backend cannot honestly enforce', () => {
  const ask = DEFAULT_PERSONAS.find(entry => entry.id === 'ask')!
  const unrestricted = DEFAULT_PERSONAS.find(entry => entry.id === 'agent')!
  const denyAll = { ...ask, id: 'none', tools: [] }

  assert.doesNotThrow(() => assertProviderPersonaEnforceable('claude', ask))
  assert.doesNotThrow(() => assertProviderPersonaEnforceable('codex', ask))
  assert.doesNotThrow(() => assertProviderPersonaEnforceable('anything', unrestricted))
  assert.doesNotThrow(() => assertProviderPersonaEnforceable('hermes', denyAll))
  assert.throws(
    () => assertProviderPersonaEnforceable('opencode', ask),
    /cannot enforce persona ask/,
  )
  assert.throws(
    () => assertProviderPersonaEnforceable('codex', denyAll),
    /cannot enforce persona none/,
  )
  assert.throws(
    () => assertProviderPersonaEnforceable('codex', { ...ask, id: 'developer', tools: ['Read', 'Bash'] }),
    /cannot enforce persona developer/,
  )
})

test('Codex default and unknown modes keep sandboxing and approvals enabled', () => {
  for (const mode of [undefined, null, '', 'default', 'renderer-typo']) {
    const args = codexExecPermissionArgs(mode)
    assert.deepEqual(args, ['--sandbox', 'workspace-write', '-c', 'approval_policy=on-request'])
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
  }
  assert.deepEqual(
    codexExecPermissionArgs('read-only'),
    ['--sandbox', 'read-only', '-c', 'approval_policy=on-request'],
  )
  assert.deepEqual(
    codexExecPermissionArgs('full-access'),
    ['--dangerously-bypass-approvals-and-sandbox'],
  )
})

test('workspace binding resolves aliases once and overwrites untrusted request fields', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-chat-policy-'))
  t.after(async () => { await rm(temp, { recursive: true, force: true }) })
  const canonicalRoot = join(temp, 'workspace')
  const replacementRoot = join(temp, 'replacement')
  const alias = join(temp, 'workspace-alias')
  const fileRoot = join(temp, 'not-a-directory')
  await mkdir(canonicalRoot)
  await mkdir(replacementRoot)
  await writeFile(fileRoot, 'not a directory')
  await symlink(canonicalRoot, alias)

  const bound = await bindChatRequestToWorkspace({
    workspaceId: 'ws-1',
    workspaceDir: alias,
    agentMode: { id: 'spoofed', tools: null },
    projectContext: { workspaceDir: alias, gitBranch: 'main' },
  }, {
    id: 'ws-1',
    path: alias,
  })
  const canonicalRealRoot = await realpath(canonicalRoot)
  assert.equal(bound.workspaceDir, canonicalRealRoot)
  assert.equal(bound.agentMode, null)
  assert.deepEqual(bound.projectContext, {
    workspaceDir: canonicalRealRoot,
    gitBranch: 'main',
  })

  await unlink(alias)
  await symlink(replacementRoot, alias)
  assert.equal(bound.workspaceDir, canonicalRealRoot, 'a later alias replacement cannot retarget the bound request')

  await assert.rejects(
    bindChatRequestToWorkspace(
      { workspaceId: 'ws-1', workspaceDir: replacementRoot },
      { id: 'ws-1', path: canonicalRoot },
    ),
    /does not match the registered workspace root/,
  )
  await assert.rejects(
    bindChatRequestToWorkspace(
      { workspaceId: 'ws-file', workspaceDir: fileRoot },
      { id: 'ws-file', path: fileRoot },
    ),
    error => error instanceof ChatPolicyError && error.code === 'CHAT_WORKSPACE_UNKNOWN',
  )
})

test('Electron request policy uses the trusted lookup and rejects unknown workspaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electron-policy-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const request: ChatRequest = {
    cardId: 'card-1',
    workspaceId: 'ws-1',
    workspaceDir: root,
    provider: 'codex',
    model: 'configured-model',
    messages: [{ role: 'user', content: 'hello' }],
    agentMode: DEFAULT_PERSONAS.find(entry => entry.id === 'agent') as never,
    memoryPrompt: 'renderer memory injection',
    contextBuckets: { version: 1, includedBuckets: [], buckets: [] },
    skillsPrompt: 'renderer skills injection',
    skillsSummary: 'renderer skills summary',
    roomContext: 'renderer room injection',
    roomAckSequence: 99,
    contextPrompt: 'renderer composed injection',
    fileReferencePrompt: 'renderer file injection',
  }
  const canonical = await canonicalizeElectronChatRequest(request, id => id === 'ws-1' ? root : null)
  assert.equal(canonical.workspaceDir, await realpath(root))
  assert.equal(canonical.agentMode, null)
  assert.equal(canonical.memoryPrompt, undefined)
  assert.equal(canonical.contextBuckets, undefined)
  assert.equal(canonical.skillsPrompt, undefined)
  assert.equal(canonical.skillsSummary, undefined)
  assert.equal(canonical.roomContext, undefined)
  assert.equal(canonical.roomAckSequence, undefined)
  assert.equal(canonical.contextPrompt, undefined)
  assert.equal(canonical.fileReferencePrompt, undefined)

  await assert.rejects(
    canonicalizeElectronChatRequest({ ...request, workspaceId: 'missing' }, () => null),
    /Workspace not found: missing/,
  )
  assert.throws(
    () => applyAuthoritativePersonaPolicy(
      { ...request, provider: 'opencode' },
      DEFAULT_PERSONAS.find(entry => entry.id === 'ask') as never,
    ),
    /cannot enforce persona ask/,
  )
})

test('authoritative persona reads reject symlinked policy files and ancestors', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-persona-links-'))
  t.after(async () => { await rm(temp, { recursive: true, force: true }) })
  const workspace = join(temp, 'workspace')
  const outside = join(temp, 'outside')
  await mkdir(join(workspace, '.codesurf', 'customisation'), { recursive: true })
  await mkdir(join(outside, 'customisation'), { recursive: true })
  const document = JSON.stringify([persona()])
  await writeFile(join(outside, 'agents.json'), document)
  await symlink(join(outside, 'agents.json'), join(workspace, '.codesurf', 'customisation', 'agents.json'))

  let result = await resolveAuthoritativePersona({ agentId: 'reader', workspaceRoot: workspace })
  assert.equal(result.ok, false)

  await unlink(join(workspace, '.codesurf', 'customisation', 'agents.json'))
  await rm(join(workspace, '.codesurf'), { recursive: true, force: true })
  await symlink(outside, join(workspace, '.codesurf'))
  await writeFile(join(outside, 'customisation', 'agents.json'), document)
  result = await resolveAuthoritativePersona({ agentId: 'reader', workspaceRoot: workspace })
  assert.equal(result.ok, false)
})
