import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexExecArgs,
  createChatJobManager,
  revalidateDaemonContextRequest,
} from '../bin/chat-jobs.mjs'
import {
  MAX_SKILLS_SUMMARY_BYTES,
  MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES,
} from '../bin/context-budget.mjs'
import { PEER_CONTEXT_LIMITS } from '@codesurf/daemon/peer-context-policy'
import { CHAT_CONTEXT_LIMITS } from '@codesurf/daemon/context-composer'
import { StableSessionContextCache } from '../bin/stable-session-context.mjs'

async function waitFor(check, timeoutMs = 5_000, intervalMs = 15) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

test('daemon revalidates inbound memory, skills, summary, and persona prompts by UTF-8 bytes', () => {
  const result = revalidateDaemonContextRequest({
    memoryPrompt: `${'m'.repeat(20_000)}é`,
    skillsPrompt: `${'s'.repeat(20_000)}é`,
    skillsSummary: `${'u'.repeat(MAX_SKILLS_SUMMARY_BYTES)}é`,
    messages: [{ role: 'user', content: 'hello' }],
    agentMode: {
      id: 'bounded',
      name: 'Bounded',
      systemPrompt: 'é'.repeat(10_000),
      tools: ['Read'],
    },
  })

  assert.ok(Buffer.byteLength(result.request.memoryPrompt, 'utf8') <= 1_000)
  assert.ok(Buffer.byteLength(result.request.skillsPrompt, 'utf8') <= 1_000)
  assert.ok(Buffer.byteLength(result.request.skillsSummary, 'utf8') <= MAX_SKILLS_SUMMARY_BYTES)
  assert.ok(Buffer.byteLength(result.request.agentMode.systemPrompt, 'utf8') <= 1_000)
  assert.match(result.request.memoryPrompt, /Context truncated: memory/)
  assert.match(result.request.skillsPrompt, /Context truncated: skills/)
  assert.match(result.request.skillsSummary, /maximum skills summary bytes/)
  assert.match(result.request.agentMode.systemPrompt, /Context truncated: persona/)
  assert.equal(result.metadata.memoryPrompt.truncated, true)
  assert.equal(result.metadata.skillsPrompt.truncated, true)
  assert.equal(result.metadata.skillsSummary.truncated, true)
  assert.equal(result.metadata.personaPrompt.truncated, true)
  assert.doesNotMatch(result.request.agentMode.systemPrompt, /\uFFFD/)
  assert.equal(result.request.contextPrompt, undefined)
  assert.ok(result.metadata.context.aggregateBytes <= CHAT_CONTEXT_LIMITS.aggregateBytes)
})

test('daemon composes room context once as bounded untrusted user data', () => {
  const roomContext = 'ROOM-CONTEXT-MUST-SURVIVE'
  const baseMemory = `MEMORY-START\n${'m'.repeat(20_000)}\nMEMORY-END`
  const result = revalidateDaemonContextRequest({
    memoryPrompt: baseMemory,
    roomContext,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.ok(Buffer.byteLength(result.request.memoryPrompt, 'utf8') <= 1_000)
  assert.equal(result.request.roomContext, undefined)
  assert.match(result.request.memoryPrompt, /Context truncated: memory/)
  assert.match(result.request.messages[0].content, /trust="untrusted"[\s\S]*ROOM-CONTEXT-MUST-SURVIVE/)
  assert.equal(result.request.messages[0].content.match(/ROOM-CONTEXT-MUST-SURVIVE/g)?.length, 1)
  assert.equal(result.metadata.memoryPrompt.truncated, true)
  assert.equal(result.metadata.roomContext.truncated, false)
})

test('daemon strips and recomposes tagged context independently for prepared message arrays', () => {
  const suffix = [
    '<codesurf_peer_context trust="untrusted" source="agent-room">',
    'ROOM-CONTEXT-ONCE-4812',
    '</codesurf_peer_context>',
    '',
    '<codesurf_file_context trust="untrusted" source="workspace-files">',
    'FILE-CONTEXT-ONCE-5934',
    '</codesurf_file_context>',
    '',
    '<codesurf_recent_edit_context trust="untrusted" source="renderer-derived-file-state">',
    'RECENT-EDIT-ONCE-7045',
    '</codesurf_recent_edit_context>',
    '',
    '<codesurf_block_notes_context trust="untrusted" source="renderer-derived-transcript">',
    'BLOCK-NOTES-ONCE-8156',
    '</codesurf_block_notes_context>',
  ].join('\n')
  const prepared = `Review the prepared context.\n\n${suffix}`
  const result = revalidateDaemonContextRequest({
    messages: [{ role: 'user', content: prepared }],
    expandedMessages: [{ role: 'user', content: prepared }],
  })

  for (const messages of [result.request.messages, result.request.expandedMessages]) {
    const content = messages?.[0]?.content ?? ''
    assert.equal(content.match(/ROOM-CONTEXT-ONCE-4812/g)?.length, 1)
    assert.equal(content.match(/FILE-CONTEXT-ONCE-5934/g)?.length, 1)
    assert.equal(content.match(/RECENT-EDIT-ONCE-7045/g)?.length, 1)
    assert.equal(content.match(/BLOCK-NOTES-ONCE-8156/g)?.length, 1)
    assert.equal(content.match(/<codesurf_peer_context /g)?.length, 1)
    assert.equal(content.match(/<codesurf_file_context /g)?.length, 1)
    assert.equal(content.match(/<codesurf_recent_edit_context /g)?.length, 1)
    assert.equal(content.match(/<codesurf_block_notes_context /g)?.length, 1)
  }
  assert.ok(result.metadata.context.aggregateBytes <= CHAT_CONTEXT_LIMITS.aggregateBytes)
})

test('daemon Codex installs stable context once while resumed turns keep fresh dynamic context', () => {
  const base = {
    provider: 'codex',
    model: 'gpt-test',
    mode: 'default',
    memoryPrompt: 'DAEMON-STABLE-MEMORY-9267',
    skillsPrompt: 'DAEMON-STABLE-SKILLS-0378',
    agentMode: {
      id: 'agent',
      name: 'Agent',
      systemPrompt: 'DAEMON-STABLE-PERSONA-1489',
      tools: null,
    },
  }
  const firstRequest = revalidateDaemonContextRequest({
    ...base,
    messages: [{ role: 'user', content: 'First user turn' }],
    recentEditContext: 'DAEMON-FIRST-RECENT-2590',
    blockNotesContext: 'DAEMON-FIRST-NOTES-3601',
    asyncExecution: {
      requestedRunMode: 'foreground',
      backend: 'daemon',
      hostType: 'local-daemon',
      hostLabel: 'DAEMON-FIRST-HOST-7045',
      providerNativeBackground: true,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: false,
    },
  }).request
  const resumedRequest = revalidateDaemonContextRequest({
    ...base,
    sessionId: 'thread-4712',
    messages: [{ role: 'user', content: 'Second user turn' }],
    recentEditContext: 'DAEMON-SECOND-RECENT-5823',
    blockNotesContext: 'DAEMON-SECOND-NOTES-6934',
    asyncExecution: {
      requestedRunMode: 'foreground',
      backend: 'daemon',
      hostType: 'local-daemon',
      hostLabel: 'DAEMON-SECOND-HOST-8156',
      providerNativeBackground: true,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: false,
    },
  }).request

  const firstPrompt = buildCodexExecArgs(firstRequest, '/workspace').at(-1) ?? ''
  assert.match(firstPrompt, /DAEMON-STABLE-PERSONA-1489/)
  assert.match(firstPrompt, /DAEMON-STABLE-MEMORY-9267/)
  assert.match(firstPrompt, /DAEMON-STABLE-SKILLS-0378/)
  assert.match(firstPrompt, /DAEMON-FIRST-RECENT-2590/)
  assert.match(firstPrompt, /DAEMON-FIRST-NOTES-3601/)
  assert.match(firstPrompt, /DAEMON-FIRST-HOST-7045/)

  const stableContexts = new StableSessionContextCache()
  const afterRestart = stableContexts.select({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    provider: 'codex',
    sessionId: 'thread-4712',
    contextPrompt: 'DAEMON-STABLE-COMPOSITE',
  })
  assert.equal(afterRestart.contextPrompt, 'DAEMON-STABLE-COMPOSITE')
  assert.equal(stableContexts.complete(afterRestart, {
    accepted: true,
    sessionId: 'thread-4712',
  }), true)
  const resumedSelection = stableContexts.select({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    provider: 'codex',
    sessionId: 'thread-4712',
    contextPrompt: 'DAEMON-STABLE-COMPOSITE',
  })
  assert.equal(resumedSelection.contextPrompt, undefined)

  const resumedArgs = buildCodexExecArgs(resumedRequest, '/workspace', '', {
    contextPrompt: resumedSelection.contextPrompt,
  })
  const resumedPrompt = resumedArgs.at(-1) ?? ''
  assert.equal(resumedArgs[resumedArgs.indexOf('resume') + 1], 'thread-4712')
  assert.doesNotMatch(
    resumedPrompt,
    /DAEMON-STABLE-(?:PERSONA|MEMORY|SKILLS)/,
  )
  assert.match(resumedPrompt, /DAEMON-SECOND-RECENT-5823/)
  assert.match(resumedPrompt, /DAEMON-SECOND-NOTES-6934/)
  assert.match(resumedPrompt, /DAEMON-SECOND-HOST-8156/)
  assert.doesNotMatch(resumedPrompt, /DAEMON-FIRST-(?:RECENT|NOTES)/)
  assert.doesNotMatch(resumedPrompt, /DAEMON-FIRST-HOST-7045/)
})

test('renderer-supplied peers never become privileged Claude or Codex context', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-peer-context-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const peers = Array.from({ length: PEER_CONTEXT_LIMITS.peers + 5 }, (_, peerIndex) => ({
    peerId: `peer-${String(peerIndex).padStart(2, '0')}`,
    peerType: 'browser',
    tools: Array.from({ length: PEER_CONTEXT_LIMITS.toolsPerPeer + 5 }, (_, toolIndex) => `browser_tool_${toolIndex}`),
    actions: Array.from({ length: PEER_CONTEXT_LIMITS.actionsPerPeer + 5 }, (_, actionIndex) => ({
      name: `action_${actionIndex}`,
      description: '界'.repeat(1_000),
    })),
    context: Object.fromEntries(Array.from(
      { length: PEER_CONTEXT_LIMITS.contextEntriesPerPeer + 5 },
      (_, contextIndex) => [
        `ctx-${contextIndex}`,
        'é'.repeat(contextIndex === 0 ? 100_000 : 4_000),
      ],
    )),
  }))
  const validated = revalidateDaemonContextRequest({ peers })
  assert.equal(validated.request.peers.length, PEER_CONTEXT_LIMITS.peers)
  assert.equal(validated.metadata.peerContext.omittedPeerCount, 5)
  assert.ok(validated.metadata.peerContext.renderedBytes <= PEER_CONTEXT_LIMITS.promptRenderedBytes)

  let claudePrompt = null
  const manager = createChatJobManager({
    homeDir,
    claudeQuery: ({ options }) => (async function* () {
      claudePrompt = options?.agents?.codesurf?.prompt ?? null
      yield {
        type: 'result',
        result: 'bounded',
        session_id: 'peer-context-bounds',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })
  const job = await manager.startJob({
    cardId: 'peer-context-bounds',
    workspaceId: 'peer-context-bounds-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'use peers' }],
    peers,
  })
  await waitFor(async () => {
    const state = await manager.getJobState(job.id)
    return state && state.status !== 'running' && state.status !== 'queued' ? state : null
  })
  assert.ok(claudePrompt)
  assert.doesNotMatch(claudePrompt, /Peer prompt truncated:|Connected peer blocks/)
  assert.ok(Buffer.byteLength(claudePrompt, 'utf8') <= CHAT_CONTEXT_LIMITS.aggregateBytes)

  let harnessContextPrompt = null
  const harnessManager = createChatJobManager({
    homeDir,
    harnessRunnerFactory: () => ({
      runHarnessJob: async (harnessJob, _request, _workspaceDir, _instructionPrompt, options) => {
        harnessContextPrompt = options.contextPrompt
        await options.appendEvent(harnessJob.id, { type: 'text', text: 'bounded' })
        await options.appendEvent(harnessJob.id, { type: 'done' })
      },
    }),
  })
  const harnessJob = await harnessManager.startJob({
    cardId: 'peer-context-harness',
    workspaceId: 'peer-context-harness-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    runMode: 'background',
    useHarness: true,
    skillsPrompt: 'HARNESS-SKILLS-CONTEXT',
    asyncExecution: {
      requestedRunMode: 'background',
      backend: 'daemon',
      hostType: 'local-daemon',
      hostLabel: 'Test daemon',
      providerNativeBackground: true,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: false,
    },
    workspaceDir,
    messages: [{ role: 'user', content: 'use peers in the background' }],
    peers,
  })
  await waitFor(async () => {
    const state = await harnessManager.getJobState(harnessJob.id)
    return state && state.status !== 'running' && state.status !== 'queued' ? state : null
  })
  assert.match(harnessContextPrompt, /## Async Execution/)
  assert.match(harnessContextPrompt, /HARNESS-SKILLS-CONTEXT/)
  assert.match(harnessContextPrompt, /HARNESS-SKILLS-CONTEXT/)
  assert.doesNotMatch(harnessContextPrompt, /## Connected peer blocks|Peer prompt truncated:/)
  assert.ok(Buffer.byteLength(harnessContextPrompt, 'utf8') <= CHAT_CONTEXT_LIMITS.aggregateBytes)

  const codexRequest = revalidateDaemonContextRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'use peers' }],
    peers,
  }).request
  const codexArgs = buildCodexExecArgs(codexRequest, workspaceDir)
  const codexPrompt = codexArgs.at(-1)
  assert.doesNotMatch(codexPrompt, /## Agent room|Peer prompt truncated:/)
  assert.ok(Buffer.byteLength(codexPrompt, 'utf8') < CHAT_CONTEXT_LIMITS.aggregateBytes + 1024)
})

test('provider and transcript context honor independent model-visible and preview ceilings', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-context-preview-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  let capturedOptions = null
  const manager = createChatJobManager({
    homeDir,
    claudeQuery: ({ options }) => (async function* () {
      capturedOptions = options
      yield {
        type: 'result',
        result: 'done',
        session_id: 'context-preview',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })
  const memoryPrompt = `MEMORY-START\n${'m'.repeat(40 * 1024)}\nMEMORY-END`
  const skillsPrompt = `SKILLS-START\n${'s'.repeat(20 * 1024)}\nSKILLS-END`
  const job = await manager.startJob({
    cardId: 'context-preview',
    workspaceId: 'context-preview-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'use the context' }],
    memoryPrompt,
    skillsPrompt,
    skillsSummary: 'Included one large test skill.',
  })

  await waitFor(async () => {
    const state = await manager.getJobState(job.id)
    return state && state.status !== 'running' && state.status !== 'queued' ? state : null
  })

  const providerPrompt = capturedOptions?.agents?.codesurf?.prompt
  assert.ok(providerPrompt)
  assert.ok(Buffer.byteLength(providerPrompt, 'utf8') <= CHAT_CONTEXT_LIMITS.aggregateBytes)
  assert.match(providerPrompt, /Context truncated: memory/)
  assert.match(providerPrompt, /Context truncated: skills/)
  assert.doesNotMatch(providerPrompt, /MEMORY-END|SKILLS-END/)

  const timeline = (await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const contextInputs = timeline.filter(event =>
    event.type === 'tool_input'
    && (event.toolId === 'codesurf-memory-context' || event.toolId === 'codesurf-skills-context'),
  )
  assert.equal(contextInputs.length, 2)
  for (const event of contextInputs) {
    assert.ok(Buffer.byteLength(event.text, 'utf8') <= MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES)
  }
})
