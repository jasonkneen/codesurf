// Verifies the agent-definition (AgentMode) wiring end-to-end on the daemon:
//  - harness path: AgentMode.systemPrompt reaches makeAgent({ instructions }),
//    AgentMode.tools allow-list denies a disallowed tool (and a downgrade of an
//    allow-all permission mode so the deny can fire), an allowed tool still asks.
//  - claude SDK path: AgentMode.systemPrompt reaches options.agents.contex.prompt
//    and AgentMode.tools reaches options.tools (the SDK's built-in restriction).
//  - isToolAllowedByAgent casing/normalization.
import { test } from 'node:test'
import { daemonUrl, daemonFile, daemonSource } from '../helpers/daemon-path.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdtemp as mkdtempP, mkdir as mkdirP, rm as rmP, writeFile as writeFileP } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const { createHarnessRunner,
  isToolAllowedByAgent, } = await import(daemonUrl('bin/harness-runtime.mjs'))
const { PI_HARNESS_UNAVAILABLE_ERROR } = await import(daemonUrl('bin/harness-policy.mjs'))
const { createChatJobManager,
  buildCodexExecArgs,
  hermesToolsetsForRequest,
  revalidateDaemonContextRequest,
  shouldUseHarness, } = await import(daemonUrl('bin/chat-jobs.mjs'))
const { CODEX_SDK_CONFIG_ISOLATION_GAP,
  buildCodexSdkThreadOptions,
  shouldUseCodexSdkProvider,
  startCodexSdkThread, } = await import(daemonUrl('bin/codex-sdk-provider.mjs'))
const { isCodexSdkEnabled } = await import(daemonUrl('bin/codex-sdk-settings.mjs'))
import { CHAT_CONTEXT_LIMITS } from '@codesurf/daemon/context-composer'
// Daemon-side AgentMode→tool mapping (Codex sandbox / Hermes toolsets).
const daemonAgentTools = await import(daemonUrl('bin/agent-mode-tools.mjs'))
// Runtime providers' shared mapping module (the SAME code chatClaude/chatCodex/
// chatHermes import). Pure + type-only, so node's type-stripping loads it here.
import * as runtimeAgentTools from '../../src/main/chat/agent-mode-tools.ts'
// Pure runtime helpers extracted so the constructed-payload behavior (not just
// the helper math) is testable: the Hermes turn-prompt builder and the renderer
// permission-mode resolver.
import { buildHermesTurnPrompt } from '../../src/main/chat/providers/hermes-prompt.ts'
import { resolveActiveChatMode } from '../../src/renderer/src/hooks/chatModeResolution.ts'
// Pure renderer resolver for the SEND-time AgentMode (closes the built-in
// seeding load-race). Dependency-injected loader, no window/JSX, so node's
// type-stripping loads it here.
import { resolveDispatchAgentMode } from '../../src/renderer/src/hooks/agentModeDispatch.ts'
const { CODEX_DENY_ALL_ERROR,
  HARNESS_READS_UNENFORCEABLE_ERROR,
  agentModeUnresolved: daemonAgentModeUnresolved,
  AGENT_MODE_UNRESOLVED_ERROR: DAEMON_AGENT_MODE_UNRESOLVED_ERROR, } = await import(daemonUrl('bin/agent-mode-tools.mjs'))
// Runtime provider payload builders — the SAME pure functions chatClaude/
// chatCodex/chatHermes call. Importing them lets the suite assert the REAL
// constructed payload + fail-closed throws (not a source regex). Dependency-free,
// so node's type-stripping loads them.
import {
  buildHermesSpawnArgs,
  buildCodexSpawnArgs,
  buildClaudeAgentModeOptions,
} from '../../src/main/chat/providers/agent-mode-payloads.ts'
// ROOT FIX: the authoritative SEND-time resolver. We import the REAL main-process
// resolver (production path) so the fail-closed tests exercise actual node:fs
// reads + parse failures — not an injected throwing loader. The daemon .mjs mirror
// + the shared .ts data are imported for the drift guard.
import {
  resolveAuthoritativeAgentMode as resolveAuthoritativeMain,
  AGENT_MODE_RESOLUTION_DENIED_ERROR as MAIN_DENIED,
} from '../../src/main/chat/agent-mode-resolver.ts'
// Persona rename: these now import the primary export names (DEFAULT_PERSONAS /
// overlayPersonas); the local aliases keep the existing assertions unchanged.
import {
  DEFAULT_PERSONAS as SHARED_DEFAULT_AGENT_MODES,
  overlayPersonas as sharedOverlayAgentModes,
} from '../../src/shared/agentModes.ts'
const { resolveAuthoritativeAgentMode: resolveAuthoritativeDaemon,
  AGENT_MODE_RESOLUTION_DENIED_ERROR: DAEMON_DENIED,
  DEFAULT_PERSONAS: DAEMON_DEFAULT_AGENT_MODES,
  overlayPersonas: daemonOverlayAgentModes,
  listPersonas: daemonListPersonas, } = await import(daemonUrl('bin/agent-mode-resolver.mjs'))

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')

async function makeTestTempDir(prefix) {
  await mkdirP(TEST_TMP_ROOT, { recursive: true })
  return await mkdtempP(join(TEST_TMP_ROOT, prefix))
}

async function waitForCompletedJob(manager, jobId, timeoutMs = 5_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await manager.getJobState(jobId)
    if (state && state.status !== 'running') return state
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('job did not complete')
}

async function* scriptedStream(parts) {
  for (const p of parts) yield p
}

// ─── isToolAllowedByAgent (pure) ─────────────────────────────────────────────

test('isToolAllowedByAgent: null/undefined = unrestricted, [] = explicit deny-all', () => {
  // null/undefined (unset) → unrestricted.
  assert.equal(isToolAllowedByAgent('Write', null), true)
  assert.equal(isToolAllowedByAgent('Write', undefined), true)
  // [] → explicit deny-all (consistent with the claude SDK's tools:[] and the
  // harness approval-loop deny). This is the #5 semantic fix.
  assert.equal(isToolAllowedByAgent('Write', []), false)
  assert.equal(isToolAllowedByAgent('Read', []), false)
})

test('isToolAllowedByAgent: matches across PascalCase/lowercase normalization', () => {
  const list = ['Read', 'Glob', 'Grep', 'WebSearch']
  // harness builtins are lowercase (read, webSearch); allow-list is PascalCase.
  assert.equal(isToolAllowedByAgent('read', list), true)
  assert.equal(isToolAllowedByAgent('webSearch', list), true)
  assert.equal(isToolAllowedByAgent('WebSearch', list), true)
  assert.equal(isToolAllowedByAgent('write', list), false)
  assert.equal(isToolAllowedByAgent('bash', list), false)
})

// ─── harness path ────────────────────────────────────────────────────────────

test('harness consumes the one host-composed context prompt', async () => {
  const captured = {}
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const createAgent = opts => {
    captured.opts = opts
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() { return { fullStream: scriptedStream([{ type: 'text-delta', id: 't', text: 'ok' }, { type: 'finish', finishReason: 'stop' }]) } },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'persona-job' },
    {
      provider: 'claude',
      mode: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      agentMode: { id: 'zebra', name: 'Zebra', systemPrompt: 'ZEBRA-PERSONA-9921 You only speak in haiku.', tools: null },
    },
    '', // no workspace → bind path is the raw instructionPrompt + persona
    'MEMORY-PROMPT-CONTEXT',
    {
      appendEvent: async () => {},
      contextPrompt: 'ZEBRA-PERSONA-9921 You only speak in haiku.\n\nMEMORY-PROMPT-CONTEXT\n\nBOUNDED-PEER-CONTEXT',
    },
  )
  assert.ok(captured.opts.instructions.includes('ZEBRA-PERSONA-9921'), 'persona systemPrompt must reach instructions')
  assert.ok(captured.opts.instructions.includes('MEMORY-PROMPT-CONTEXT'), 'memory prompt must still be present')
  assert.ok(captured.opts.instructions.includes('BOUNDED-PEER-CONTEXT'), 'bounded peer prompt must reach harness instructions')
  // persona leads the instructions
  assert.ok(captured.opts.instructions.indexOf('ZEBRA-PERSONA-9921') < captured.opts.instructions.indexOf('MEMORY-PROMPT-CONTEXT'))
  assert.ok(captured.opts.instructions.indexOf('MEMORY-PROMPT-CONTEXT') < captured.opts.instructions.indexOf('BOUNDED-PEER-CONTEXT'))
})

test('harness model instructions exclude even an oversized workspace bind path', async () => {
  const captured = {}
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const contextPrompt = 'HOST-COMPOSED-CONTEXT'
  const oversizedBindPath = `/${'oversized-bind-segment/'.repeat(800)}`
  const runner = createHarnessRunner({
    homeDir: home,
    bindWorkspace: () => {},
    createAgent: opts => {
      captured.opts = opts
      return {
        async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
        async stream() { return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]) } },
      }
    },
  })

  await runner.runHarnessJob(
    { id: 'oversized-bind-path' },
    {
      provider: 'claude',
      mode: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    },
    oversizedBindPath,
    '',
    { appendEvent: async () => {}, contextPrompt },
  )

  assert.equal(captured.opts.instructions, contextPrompt)
  assert.ok(Buffer.byteLength(captured.opts.instructions, 'utf8') <= CHAT_CONTEXT_LIMITS.aggregateBytes)
  assert.doesNotMatch(captured.opts.instructions, /oversized-bind-segment/)
})

test('harness workspace bind failure stops before agent launch with one terminal pair', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const events = []
  let makeAgentCalled = false
  const runner = createHarnessRunner({
    homeDir: home,
    bindWorkspace: () => {
      throw new Error('BIND-FAIL-SENTINEL')
    },
    createAgent: () => {
      makeAgentCalled = true
      throw new Error('agent must not be constructed')
    },
  })

  await runner.runHarnessJob(
    { id: 'bind-failure' },
    {
      provider: 'claude',
      mode: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    },
    join(home, 'non-git-workspace'),
    '',
    {
      appendEvent: async (_jobId, event) => { events.push(event) },
      contextPrompt: 'HOST-COMPOSED-CONTEXT',
    },
  )

  assert.equal(makeAgentCalled, false)
  assert.deepEqual(events.map(event => event.type), ['error', 'done'])
  assert.match(events[0].error, /BIND-FAIL-SENTINEL/)
})

test('harness: tools allow-list denies a disallowed tool without prompting, allows a listed one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const events = []
  const asked = []
  const awaitToolPermission = async (approvalId, req) => { asked.push(req.toolName); return 'once' }

  // One stream pauses on two approvals: 'write' (NOT in allow-list) and 'bash'
  // (in allow-list). continueStream finishes the turn.
  const createAgent = opts => {
    void opts
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() {
        return {
          fullStream: scriptedStream([
            { type: 'tool-approval-request', approvalId: 'ap-write', toolCall: { type: 'tool-call', toolCallId: 'tc-w', toolName: 'write', input: { file_path: 'x' } } },
            { type: 'tool-approval-request', approvalId: 'ap-bash', toolCall: { type: 'tool-call', toolCallId: 'tc-b', toolName: 'bash', input: { command: 'ls' } } },
          ]),
          response: Promise.resolve({ messages: [] }),
        }
      },
      async continueStream() {
        return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]), response: Promise.resolve({ messages: [] }) }
      },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'allowlist-job' },
    {
      provider: 'claude',
      mode: 'default',
      messages: [{ role: 'user', content: 'go' }],
      agentMode: { id: 'restricted', name: 'Restricted', systemPrompt: '', tools: ['Read', 'Glob', 'Grep', 'Bash'] },
    },
    '',
    '',
    { appendEvent: async (_j, e) => events.push(e), awaitToolPermission },
  )

  // 'write' was auto-denied by the allow-list — the user was NEVER asked for it.
  assert.ok(!asked.includes('write'), 'disallowed tool must not be sent to the user prompt')
  assert.ok(events.some(e => e.type === 'tool_permission_resolved' && e.toolName === 'write' && e.decision === 'deny'))
  assert.ok(events.some(e => e.type === 'tool_summary' && e.toolName === 'write' && /Blocked by agent definition/.test(e.text)))
  // 'bash' IS in the allow-list, so it surfaced to the user as normal.
  assert.ok(asked.includes('bash'), 'allowed tool must still go through the normal approval prompt')
})

test('harness: an allow-list downgrades allow-all to a gated mode so denies can fire', async () => {
  const captured = {}
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const createAgent = opts => {
    captured.opts = opts
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() { return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]) } },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  // bypassPermissions would normally map to allow-all; with an allow-list present
  // it must downgrade to allow-reads so disallowed tools surface for denial.
  await runner.runHarnessJob(
    { id: 'downgrade-job' },
    { provider: 'claude', mode: 'bypassPermissions', messages: [{ role: 'user', content: 'hi' }], agentMode: { id: 'r', name: 'r', systemPrompt: '', tools: ['Read'] } },
    '',
    '',
    { appendEvent: async () => {} },
  )
  assert.equal(captured.opts.permissionMode, 'allow-reads')
})

test('harness: bypassPermissions stays allow-all when no allow-list is set', async () => {
  const captured = {}
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const createAgent = opts => {
    captured.opts = opts
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() { return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]) } },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'noagent-job' },
    { provider: 'claude', mode: 'bypassPermissions', messages: [{ role: 'user', content: 'hi' }] },
    '',
    '',
    { appendEvent: async () => {} },
  )
  assert.equal(captured.opts.permissionMode, 'allow-all')
})

// ─── claude SDK path ─────────────────────────────────────────────────────────

test('claude SDK: AgentMode.systemPrompt + tools reach the query options', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-agentmode-claude-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  let capturedOptions = null
  const manager = createChatJobManager({
    homeDir,
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
    claudeQuery: ({ options }) => (async function* () {
      capturedOptions = options
      yield { type: 'result', result: 'done', session_id: 'claude-agentmode', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-agentmode',
    workspaceId: 'agentmode-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'do the thing' }],
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: 'PERSONA-TOKEN-7788 read-only mode.', tools: ['Read', 'Glob', 'Grep'] },
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.ok(capturedOptions, 'claudeQuery should have been invoked')
  // tools allow-list → SDK top-level `tools` restriction (governs with no custom agent)...
  assert.deepEqual(capturedOptions.tools, ['Read', 'Glob', 'Grep'])
  // systemPrompt → custom agent prompt, which makes `agent` active...
  assert.equal(capturedOptions.agent, 'codesurf')
  assert.ok(capturedOptions.agents?.codesurf?.prompt?.includes('PERSONA-TOKEN-7788'), 'persona must reach the claude agent prompt')
  // ...and the allow-list MUST also be on the active agent definition, since the
  // active agent's own `tools` field governs its toolset when `agent` is set.
  assert.deepEqual(capturedOptions.agents?.codesurf?.tools, ['Read', 'Glob', 'Grep'])
})

test('claude SDK: no agentMode leaves tools unrestricted', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-agentmode-claude-none-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  let capturedOptions = null
  const manager = createChatJobManager({
    homeDir,
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
    claudeQuery: ({ options }) => (async function* () {
      capturedOptions = options
      yield { type: 'result', result: 'done', session_id: 's', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-noagent',
    workspaceId: 'noagent-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'hi' }],
  })

  await waitForCompletedJob(manager, job.id)
  assert.equal(capturedOptions.tools, undefined)
})

// ─── harness: allow-edits downgrade + [] deny-all (#3, #5) ────────────────────

test('harness: an allow-list downgrades acceptEdits (allow-edits) to allow-reads', async () => {
  const captured = {}
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const createAgent = opts => {
    captured.opts = opts
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() { return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]) } },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  // acceptEdits → allow-edits would auto-approve edits; with an allow-list it must
  // downgrade to allow-reads so an excluded Write/Edit surfaces for the deny.
  await runner.runHarnessJob(
    { id: 'downgrade-edits-job' },
    { provider: 'claude', mode: 'acceptEdits', messages: [{ role: 'user', content: 'hi' }], agentMode: { id: 'r', name: 'r', systemPrompt: '', tools: ['Read'] } },
    '',
    '',
    { appendEvent: async () => {} },
  )
  assert.equal(captured.opts.permissionMode, 'allow-reads')
})

test('harness: tools:[] (deny-all) is REFUSED — the agent never launches (#BLOCKING-2)', async () => {
  // Regression proof: the OLD behavior launched under `allow-reads` (which
  // AUTO-APPROVES the adapter's built-in reads) and only the approval loop could
  // deny a *pausing* tool like bash — so tools:[] still read the whole workspace
  // while claiming deny-all. The Claude harness cannot deny reads, so deny-all
  // must now FAIL CLOSED: no agent created, no stream, an error + done emitted.
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const events = []
  let agentCreated = false
  let streamStarted = false
  const createAgent = () => {
    agentCreated = true
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() {
        streamStarted = true
        return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]), response: Promise.resolve({ messages: [] }) }
      },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'denyall-job' },
    { provider: 'claude', mode: 'bypassPermissions', messages: [{ role: 'user', content: 'go' }], agentMode: { id: 'none', name: 'None', systemPrompt: '', tools: [] } },
    '',
    '',
    { appendEvent: async (_j, e) => events.push(e) },
  )
  assert.equal(agentCreated, false, 'deny-all must refuse to launch — no agent created (would otherwise read-capable)')
  assert.equal(streamStarted, false, 'deny-all must not start a stream')
  assert.equal(events.find(e => e.type === 'error')?.error, HARNESS_READS_UNENFORCEABLE_ERROR, 'must surface the read-unenforceable reason')
  assert.ok(events.some(e => e.type === 'done'), 'must still terminate the job with done')
})

test('harness: a Read-excluding allow-list is also REFUSED (reads auto-approve, unenforceable) (#BLOCKING-2)', async () => {
  // The leak is broader than []: ANY list that excludes Read is unenforceable on
  // the harness (reads auto-approve regardless of the list). e.g. ['Bash'] would
  // run read-capable while the definition forbids reads → fail closed.
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const events = []
  let agentCreated = false
  const createAgent = () => {
    agentCreated = true
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() { return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]), response: Promise.resolve({ messages: [] }) } },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'noread-job' },
    { provider: 'claude', mode: 'bypassPermissions', messages: [{ role: 'user', content: 'go' }], agentMode: { id: 'w', name: 'W', systemPrompt: '', tools: ['Bash'] } },
    '',
    '',
    { appendEvent: async (_j, e) => events.push(e) },
  )
  assert.equal(agentCreated, false, 'a Read-excluding allow-list must refuse to launch on the harness')
  assert.equal(events.find(e => e.type === 'error')?.error, HARNESS_READS_UNENFORCEABLE_ERROR)
})

test('harness: a Read-INCLUSIVE allow-list still launches (reads are honestly enforceable)', async () => {
  // Guard the other side: ['Read','Bash'] permits reads, so the harness CAN honor
  // the definition (auto-approve reads, deny the rest via the loop). It must NOT
  // fail closed — the agent launches as before.
  const home = mkdtempSync(join(tmpdir(), 'codesurf-agentmode-'))
  const events = []
  let agentCreated = false
  const createAgent = () => {
    agentCreated = true
    return {
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() { return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]), response: Promise.resolve({ messages: [] }) } },
    }
  }
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'readok-job' },
    { provider: 'claude', mode: 'bypassPermissions', messages: [{ role: 'user', content: 'go' }], agentMode: { id: 'dev', name: 'Dev', systemPrompt: '', tools: ['Read', 'Bash'] } },
    '',
    '',
    { appendEvent: async (_j, e) => events.push(e) },
  )
  assert.equal(agentCreated, true, 'a Read-inclusive allow-list must still launch (enforceable)')
  assert.ok(!events.some(e => e.type === 'error'), 'no fail-closed error for an enforceable list')
})

// ─── daemon Codex: AgentMode.tools → sandbox (#2) ─────────────────────────────

// Helper: read the `-s/--sandbox` value and the `-c approval_policy=` value out
// of a constructed `codex exec` argv. Asserts the REAL payload, not the helper.
function codexSandboxAndApproval(args) {
  const sIdx = args.indexOf('-s')
  const sandbox = sIdx >= 0 ? args[sIdx + 1] : null
  const cfg = args.find(a => typeof a === 'string' && a.startsWith('approval_policy='))
  const approval = cfg ? cfg.split('=')[1] : null
  return { sandbox, approval }
}

test('daemon Codex: each UI mode maps to the correct sandbox + approval policy (#2c)', () => {
  const base = { provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'do it' }] }
  const expected = {
    'default': { sandbox: 'workspace-write', approval: 'on-request' },
    'auto': { sandbox: 'workspace-write', approval: 'on-failure' },
    'read-only': { sandbox: 'read-only', approval: 'on-request' },
    'full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  for (const [mode, want] of Object.entries(expected)) {
    const args = buildCodexExecArgs({ ...base, mode }, '/ws')
    assert.deepEqual(codexSandboxAndApproval(args), want, `mode ${mode} must map to ${JSON.stringify(want)}`)
  }
})

test('daemon Codex: a write-free allow-list forces a read-only sandbox', () => {
  const base = { provider: 'codex', model: 'gpt-test', mode: 'default', messages: [{ role: 'user', content: 'do it' }] }

  // No agentMode → default mode keeps workspace-write.
  assert.equal(codexSandboxAndApproval(buildCodexExecArgs({ ...base }, '/ws')).sandbox, 'workspace-write')

  // Allow-list with NO write/exec tool → forced read-only (reads still allowed —
  // honest, NOT deny-all). Approval policy still reflects the mode.
  const readOnly = buildCodexExecArgs({ ...base, agentMode: { id: 'ask', name: 'Ask', systemPrompt: '', tools: ['Read', 'Glob', 'Grep'] } }, '/ws')
  assert.deepEqual(codexSandboxAndApproval(readOnly), { sandbox: 'read-only', approval: 'on-request' }, 'write-free allow-list must force read-only sandbox')
  assert.ok(!readOnly.includes('workspace-write'))

  // Allow-list that includes Bash (write-capable) → stays workspace-write.
  const withBash = buildCodexExecArgs({ ...base, agentMode: { id: 'dev', name: 'Dev', systemPrompt: '', tools: ['Read', 'Bash'] } }, '/ws')
  assert.equal(codexSandboxAndApproval(withBash).sandbox, 'workspace-write', 'a write-capable tool keeps the writable sandbox')
})

test('daemon Codex: an explicit deny-all ([]) FAILS CLOSED instead of silently allowing reads (#1b)', () => {
  const base = { provider: 'codex', model: 'gpt-test', mode: 'default', messages: [{ role: 'user', content: 'do it' }] }
  // Regression proof: the old behavior downgraded deny-all to a read-capable
  // `--sandbox read-only`, overclaiming deny-all. It must now THROW so the caller
  // refuses to launch.
  assert.throws(
    () => buildCodexExecArgs({ ...base, agentMode: { id: 'none', name: 'None', systemPrompt: '', tools: [] } }, '/ws'),
    err => {
      assert.equal(err.message, CODEX_DENY_ALL_ERROR)
      return true
    },
    'Codex deny-all must fail closed (throw), not produce a read-capable sandbox',
  )
})

test('daemon Codex: AgentMode.systemPrompt is injected into the prompt arg', () => {
  const validated = revalidateDaemonContextRequest({
    provider: 'codex', model: 'gpt-test', mode: 'default',
    messages: [{ role: 'user', content: 'hello' }],
    agentMode: { id: 'z', name: 'Z', systemPrompt: 'CODEX-PERSONA-5512 stay terse.', tools: null },
  }).request
  const args = buildCodexExecArgs(validated, '/ws')
  // The prompt is the final positional arg.
  assert.ok(args[args.length - 1].includes('CODEX-PERSONA-5512'), 'persona must reach the codex prompt')
})

// ─── daemon Codex: multi-turn continuity (resume) ────────────────────────────

test('daemon Codex: a request with sessionId resumes the thread (`exec [OPTIONS] resume <id>`), first turn does NOT', () => {
  const base = { provider: 'codex', model: 'gpt-test', mode: 'default', messages: [{ role: 'user', content: 'do it' }] }

  // Continuation turn: the Codex thread id from a prior turn is echoed back as
  // request.sessionId. Codex's CLI grammar is `codex exec [OPTIONS] resume
  // <SESSION_ID> [PROMPT]` — ALL exec-level options (--json, --model,
  // --ignore-user-config, --skip-git-repo-check, -C <dir>,
  // sandbox/approval flags) MUST precede the
  // `resume` subcommand; only the SESSION_ID and PROMPT follow it. Emitting
  // `resume` before the options makes codex reject the trailing flags
  // (`error: unexpected argument '-C' found`), which broke multi-turn resume.
  const resumed = buildCodexExecArgs({ ...base, sessionId: 'thread-1' }, '/ws')
  const execIdx = resumed.indexOf('exec')
  const resumeIdx = resumed.indexOf('resume')
  // `resume` must NOT sit immediately after `exec` — it comes AFTER the options.
  assert.notEqual(resumed[execIdx + 1], 'resume', '`resume` must NOT immediately follow `exec` (options come first)')
  assert.equal(resumed[execIdx + 1], '--json', 'exec-level options lead the argv')
  assert.equal(resumed[resumeIdx + 1], 'thread-1', 'the thread id must immediately follow `resume`')
  // The thread id and the prompt are the only args after `resume`.
  assert.equal(resumeIdx, resumed.length - 3, '`resume` must be third-from-last (resume, <id>, <prompt>)')
  assert.match(resumed.at(-1), /do it/, 'the prompt is the final positional arg')
  // Every exec-level option/flag must appear BEFORE `resume`.
  for (const flag of ['--json', '--model', 'gpt-test', '--ignore-user-config', '--skip-git-repo-check', '-C', '/ws', '-s', 'workspace-write', '-c', 'approval_policy=on-request']) {
    assert.ok(resumed.indexOf(flag) > -1 && resumed.indexOf(flag) < resumeIdx, `${flag} must precede resume`)
  }
  // `-C <dir>` must never appear after `resume` (the exact bug codex rejected).
  assert.ok(resumed.lastIndexOf('-C') < resumeIdx, '`-C` must never follow `resume`')

  // First turn (no sessionId): a fresh thread, NO resume subcommand.
  const fresh = buildCodexExecArgs({ ...base }, '/ws')
  assert.ok(!fresh.includes('resume'), 'first turn (no sessionId) must NOT resume')
  assert.equal(fresh[fresh.indexOf('exec') + 1], '--json', 'first turn keeps the flag order after exec')

  // Empty-string sessionId is falsy → treated as a first turn (no resume).
  assert.ok(!buildCodexExecArgs({ ...base, sessionId: '' }, '/ws').includes('resume'))

  // Resume must not disturb the sandbox/approval flags (continuity is orthogonal
  // to permission enforcement).
  assert.deepEqual(codexSandboxAndApproval(resumed), { sandbox: 'workspace-write', approval: 'on-request' })
})

test('daemon Codex argv keeps the runtime builder option prefix exactly aligned', () => {
  const request = {
    provider: 'codex',
    model: 'gpt-test',
    mode: 'default',
    sessionId: 'thread-parity',
    messages: [{ role: 'user', content: 'do it' }],
  }
  const daemonArgs = buildCodexExecArgs(request, '/ws')
  const runtimeArgs = buildCodexSpawnArgs({
    agentMode: null,
    mode: 'default',
    model: 'gpt-test',
    resumeThreadId: 'thread-parity',
    userContent: 'do it',
    workspaceDir: '/ws',
  })

  assert.deepEqual(
    daemonArgs.slice(0, -1),
    runtimeArgs.slice(0, -1),
    'daemon and Electron Codex launches must apply the same exec options in the same order',
  )
})

// ─── runtime Codex: multi-turn continuity (resume) — buildCodexSpawnArgs ──────

test('runtime Codex: buildCodexSpawnArgs places exec-level options before `resume <id>`, first turn does NOT resume', () => {
  const base = { agentMode: null, mode: 'default', model: 'gpt-test', userContent: 'do it', workspaceDir: '/ws' }

  // Same Codex CLI grammar invariant as the daemon builder: `codex exec
  // [OPTIONS] resume <SESSION_ID> [PROMPT]`. buildCodexSpawnArgs is the function
  // chatCodex actually spawns (the runtime path); BUG 1 was that it pushed
  // `resume <id>` before the option flags, so codex rejected `-C` on resume.
  const resumed = buildCodexSpawnArgs({ ...base, resumeThreadId: 'thread-9' })
  const execIdx = resumed.indexOf('exec')
  const resumeIdx = resumed.indexOf('resume')
  assert.equal(resumed[execIdx + 1], '--json', 'exec-level options must lead the argv (not `resume`)')
  assert.notEqual(resumed[execIdx + 1], 'resume', '`resume` must NOT immediately follow `exec`')
  assert.equal(resumed[resumeIdx + 1], 'thread-9', 'the thread id must immediately follow `resume`')
  assert.equal(resumeIdx, resumed.length - 3, '`resume` must be third-from-last (resume, <id>, <prompt>)')
  // Prompt is the final positional; `resume <id>` are the two args before it.
  assert.equal(resumed[resumed.length - 2], 'thread-9', '<id> precedes the prompt')
  assert.match(resumed.at(-1), /do it/, 'the prompt is the final positional arg')
  // Every exec-level option/flag must precede `resume`, and `-C` must not follow it.
  for (const flag of ['--json', '--model', 'gpt-test', '--ignore-user-config', '--skip-git-repo-check', '-C', '/ws', '-s', 'workspace-write', '-c', 'approval_policy=on-request']) {
    assert.ok(resumed.indexOf(flag) > -1 && resumed.indexOf(flag) < resumeIdx, `${flag} must precede resume`)
  }
  assert.ok(resumed.lastIndexOf('-C') < resumeIdx, '`-C` must never follow `resume`')

  // First turn (no resumeThreadId): no resume subcommand, prompt stays last.
  const fresh = buildCodexSpawnArgs({ ...base })
  assert.ok(!fresh.includes('resume'), 'first turn must NOT resume')
  assert.equal(fresh[fresh.indexOf('exec') + 1], '--json', 'first turn keeps the flag order after exec')
  assert.match(fresh.at(-1), /do it/, 'prompt is last on a fresh turn too')
})

// ─── daemon Codex SDK provider: opt-in mapping + resume ──────────────────────

test('daemon Codex SDK: each UI mode maps to SDK sandboxMode + approvalPolicy', () => {
  const base = { provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'do it' }] }
  const expected = {
    'default': { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    'auto': { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' },
    'read-only': { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
    'full-access': { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
  }
  for (const [mode, want] of Object.entries(expected)) {
    assert.deepEqual(
      buildCodexSdkThreadOptions({ ...base, mode }, '/ws'),
      { model: 'gpt-test', skipGitRepoCheck: true, workingDirectory: '/ws', ...want },
      `mode ${mode} must map to ${JSON.stringify(want)}`,
    )
  }
})

test('daemon Codex SDK: write-free allow-list forces read-only and deny-all fails closed', () => {
  const base = { provider: 'codex', model: 'gpt-test', mode: 'full-access', messages: [{ role: 'user', content: 'do it' }] }

  const readOnly = buildCodexSdkThreadOptions({
    ...base,
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: '', tools: ['Read', 'Glob'] },
  }, '/ws')
  assert.deepEqual(
    { sandboxMode: readOnly.sandboxMode, approvalPolicy: readOnly.approvalPolicy },
    { sandboxMode: 'read-only', approvalPolicy: 'never' },
    'write-free allow-list must override the SDK sandbox without loosening approval policy',
  )

  assert.throws(
    () => buildCodexSdkThreadOptions({ ...base, agentMode: { id: 'none', name: 'None', systemPrompt: '', tools: [] } }, '/ws'),
    err => { assert.equal(err.message, CODEX_DENY_ALL_ERROR); return true },
    'SDK deny-all must fail closed before starting a thread',
  )
})

test('daemon Codex SDK: sessionId resumes the SDK thread, first turn starts a new thread', () => {
  const calls = []
  const fakeCodex = {
    startThread(options) {
      calls.push({ type: 'start', options })
      return { kind: 'started' }
    },
    resumeThread(id, options) {
      calls.push({ type: 'resume', id, options })
      return { kind: 'resumed' }
    },
  }
  const options = buildCodexSdkThreadOptions({ provider: 'codex', model: 'gpt-test', mode: 'default' }, '/ws')

  const resumed = startCodexSdkThread(fakeCodex, { provider: 'codex', sessionId: 'thread-1' }, options)
  assert.deepEqual(calls[0], { type: 'resume', id: 'thread-1', options })
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.sessionId, 'thread-1')
  assert.equal(resumed.thread.kind, 'resumed')

  const fresh = startCodexSdkThread(fakeCodex, { provider: 'codex', sessionId: '' }, options)
  assert.deepEqual(calls[1], { type: 'start', options })
  assert.equal(fresh.resumed, false)
  assert.equal(fresh.sessionId, null)
  assert.equal(fresh.thread.kind, 'started')
})

test('daemon Codex SDK: fake SDK provider streams into the same job event shape', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-codex-sdk-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  const captured = {}
  const fakeCodex = {
    resumeThread(id, options) {
      captured.resumeId = id
      captured.options = options
      return {
        async runStreamed(input, turnOptions) {
          captured.input = input
          captured.signal = turnOptions.signal
          return {
            events: scriptedStream([
              { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'sdk ok' } },
              { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
            ]),
          }
        },
      }
    },
    startThread() {
      throw new Error('resumeThread should be used when request.sessionId is set')
    },
  }
  const manager = createChatJobManager({
    homeDir,
    codexSdkFactory: () => fakeCodex,
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
  })

  const job = await manager.startJob({
    cardId: 'codex-sdk-card',
    workspaceId: 'codex-sdk-workspace',
    provider: 'codex',
    model: 'gpt-test',
    mode: 'read-only',
    useCodexSdk: true,
    sessionId: 'thread-sdk-1',
    workspaceDir,
    messages: [{ role: 'user', content: 'continue' }],
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: 'SDK-PERSONA-7781', tools: ['Read'] },
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.sessionId, 'thread-sdk-1')
  assert.equal(captured.resumeId, 'thread-sdk-1')
  assert.deepEqual(
    {
      sandboxMode: captured.options.sandboxMode,
      approvalPolicy: captured.options.approvalPolicy,
      workingDirectory: captured.options.workingDirectory,
      skipGitRepoCheck: captured.options.skipGitRepoCheck,
    },
    {
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true,
    },
  )
  assert.ok(captured.input.includes('SDK-PERSONA-7781'), 'persona must reach the SDK prompt')
})

test('daemon Codex SDK selection is opt-in; CLI stays the default/config-isolated fallback', () => {
  assert.equal(shouldUseCodexSdkProvider({ provider: 'codex' }), false, 'Codex defaults to the CLI provider')
  assert.equal(shouldUseCodexSdkProvider({ provider: 'codex', useCodexSdk: true }), true)
  assert.equal(shouldUseCodexSdkProvider({ provider: 'codex', codexExecutionProvider: 'sdk' }), true)
  assert.equal(shouldUseCodexSdkProvider({ provider: 'claude', useCodexSdk: true }), false)

  assert.equal(isCodexSdkEnabled({ provider: 'codex', settings: {}, env: {} }), false)
  assert.equal(isCodexSdkEnabled({ provider: 'codex', settings: { codex: { executionProvider: 'sdk' } }, env: {} }), true)
  assert.equal(isCodexSdkEnabled({ provider: 'codex', settings: { codex: { executionProvider: 'sdk' } }, env: { CODESURF_CODEX_PROVIDER: 'cli' } }), false)
  assert.equal(isCodexSdkEnabled({ provider: 'codex', settings: {}, env: { CODESURF_CODEX_PROVIDER: 'sdk' } }), true)

  const cliArgs = buildCodexSpawnArgs({ mode: 'default', model: 'm', userContent: 'go' })
  assert.ok(cliArgs.includes('--ignore-user-config'), 'runtime CLI path keeps config isolation')
  assert.match(CODEX_SDK_CONFIG_ISOLATION_GAP, /--ignore-user-config/, 'SDK config isolation gap must stay documented in code')
})

// ─── daemon routing: harness vs native (continuity stopgap) ──────────────────

test('shouldUseHarness: FOREGROUND Claude falls back to native (continuity); background keeps the harness', () => {
  // Foreground Claude (interactive multi-turn): MUST NOT use the harness — its
  // destroy()-without-resume path loses conversation history. runJob falls
  // through to runClaudeJob, which resumes via { resume: request.sessionId }.
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'claude' }), false, 'foreground claude (runMode absent) → native')
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'claude', runMode: 'foreground' }), false, 'explicit foreground claude → native')
  // A continuation turn (has sessionId) is exactly the case the harness breaks.
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'claude', runMode: 'foreground', sessionId: 'abc' }), false, 'foreground claude continuation → native (never the destroy()-discards-resume path)')

  // Background dispatched Claude: single-shot autonomous task — keep the
  // harness's worktree isolation.
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'claude', runMode: 'background' }), true, 'background claude keeps the harness')

  // Codex is always excluded (its adapter can't honor the 4 permission modes).
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'codex' }), false)
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'codex', runMode: 'background' }), false)

  // Pi is unavailable until its published adapter dependency chain is safe.
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'pi' }), false)
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'pi', runMode: 'foreground' }), false)

  // Harness off / non-harness providers → never the harness.
  assert.equal(shouldUseHarness({ useHarness: false, provider: 'claude', runMode: 'background' }), false)
  assert.equal(shouldUseHarness({ provider: 'claude', runMode: 'background' }), false, 'useHarness unset → false')
  assert.equal(shouldUseHarness({ useHarness: true, provider: 'hermes' }), false)
})

test('daemon rejects Pi consistently without loading or launching the removed harness adapter', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-pi-unavailable-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({ homeDir })
  for (const useHarness of [undefined, false, true]) {
    const request = {
      cardId: `pi-${String(useHarness)}`,
      workspaceId: 'pi-workspace',
      provider: 'pi',
      model: 'pi-test',
      mode: 'default',
      workspaceDir,
      messages: [{ role: 'user', content: 'hi' }],
      ...(useHarness === undefined ? {} : { useHarness }),
    }
    const job = await manager.startJob(request)
    const completed = await waitForCompletedJob(manager, job.id)
    assert.equal(completed.status, 'failed')
    assert.equal(completed.error, PI_HARNESS_UNAVAILABLE_ERROR)

    const timeline = readFileSync(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(event => event.type === 'error' || event.type === 'done')
      .map(({ type, error }) => ({ type, ...(error ? { error } : {}) }))
    assert.deepEqual(timeline, [
      { type: 'error', error: PI_HARNESS_UNAVAILABLE_ERROR },
      { type: 'done' },
    ])
  }
})

// ─── daemon Hermes: AgentMode.tools → toolsets (#2) ───────────────────────────

test('daemon Hermes: AgentMode.tools constrains the toolset categories', () => {
  // file-only allow-list → file toolset.
  assert.equal(
    hermesToolsetsForRequest({ provider: 'hermes', mode: 'full', agentMode: { tools: ['Read', 'Glob'] } }),
    'file',
  )
  // mixed allow-list → canonical terminal,file,web.
  assert.equal(
    hermesToolsetsForRequest({ provider: 'hermes', mode: 'query', agentMode: { tools: ['Read', 'Bash', 'WebSearch'] } }),
    'terminal,file,web',
  )
  // [] deny-all → empty toolset (query-only), overriding mode 'full'.
  assert.equal(
    hermesToolsetsForRequest({ provider: 'hermes', mode: 'full', agentMode: { tools: [] } }),
    '',
  )
  // No agentMode → falls back to the mode mapping.
  assert.equal(
    hermesToolsetsForRequest({ provider: 'hermes', mode: 'full' }),
    'terminal,file,web,browser',
  )
})

// ─── runtime providers: AgentMode mapping (#1) ────────────────────────────────
// The runtime providers (chatClaude/chatCodex/chatHermes) live in Electron-coupled
// .ts and can't be launched under node --test, but they all funnel AgentMode
// through src/main/chat/agent-mode-tools.ts. We exercise that shared module (the
// real code path) plus assert each provider actually imports & wires it.

test('runtime mapping: claude tools option reflects allow-list (#1)', () => {
  const { resolveAgentToolAllowList, claudeToolsForAllowList } = runtimeAgentTools
  // unset → undefined (option left off → SDK default preset)
  assert.equal(claudeToolsForAllowList(resolveAgentToolAllowList({ tools: null })), undefined)
  assert.equal(claudeToolsForAllowList(resolveAgentToolAllowList({})), undefined)
  // [] → deny-all passed through verbatim
  assert.deepEqual(claudeToolsForAllowList(resolveAgentToolAllowList({ tools: [] })), [])
  // names → restricted
  assert.deepEqual(claudeToolsForAllowList(resolveAgentToolAllowList({ tools: ['Read', 'Glob'] })), ['Read', 'Glob'])
})

test('runtime mapping: codex sandbox + hermes toolsets reflect allow-list (#1)', () => {
  const { resolveAgentToolAllowList, codexShouldForceReadOnly, hermesToolsetsFromAllowList } = runtimeAgentTools
  // codex read-only forcing
  assert.equal(codexShouldForceReadOnly(resolveAgentToolAllowList({ tools: ['Read'] })), true)
  assert.equal(codexShouldForceReadOnly(resolveAgentToolAllowList({ tools: ['Read', 'Bash'] })), false)
  assert.equal(codexShouldForceReadOnly(resolveAgentToolAllowList({ tools: null })), false)
  assert.equal(codexShouldForceReadOnly(resolveAgentToolAllowList({ tools: [] })), true)
  // hermes toolset categories
  assert.equal(hermesToolsetsFromAllowList(resolveAgentToolAllowList({ tools: ['Read', 'WebSearch'] })), 'file,web')
  assert.equal(hermesToolsetsFromAllowList(resolveAgentToolAllowList({ tools: [] })), '')
  assert.equal(hermesToolsetsFromAllowList(resolveAgentToolAllowList({ tools: null })), null)
})

test('contract #1: constructed payloads (not just helpers) reflect AgentMode (#1c)', () => {
  // Codex: the actual `codex exec` argv carries the persona in the prompt AND the
  // sandbox the allow-list dictates — assert the built command, not the helper.
  const codexRequest = revalidateDaemonContextRequest({
    provider: 'codex', model: 'gpt-test', mode: 'default',
    messages: [{ role: 'user', content: 'go' }],
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: 'PERSONA-1C-CODEX read-only.', tools: ['Read', 'Glob'] },
  }).request
  const codexArgs = buildCodexExecArgs(codexRequest, '/ws')
  assert.equal(codexSandboxAndApproval(codexArgs).sandbox, 'read-only', 'write-free allow-list → read-only in the real argv')
  assert.ok(codexArgs[codexArgs.length - 1].includes('PERSONA-1C-CODEX'), 'persona must be in the real codex prompt arg')

  // Hermes: the constructed turn prompt carries the persona on the FIRST turn and
  // on a RESUMED turn (the #1a fix), and the toolset reflects the allow-list.
  const firstTurn = buildHermesTurnPrompt({ userContent: 'go', contextPrompt: 'PERSONA-1C-HERMES.' })
  assert.ok(firstTurn.includes('PERSONA-1C-HERMES'), 'persona present on first Hermes turn')
  const resumed = buildHermesTurnPrompt({ userContent: 'go', contextPrompt: 'PERSONA-1C-HERMES.' })
  assert.ok(resumed.includes('PERSONA-1C-HERMES'), 'persona present on RESUMED Hermes turn (#1a)')
  assert.equal(
    hermesToolsetsForRequest({ provider: 'hermes', mode: 'full', agentMode: { tools: ['Read', 'Glob'] } }),
    'file',
    'hermes toolset reflects the allow-list in the constructed request',
  )
})

test('runtime ↔ daemon mapping agree (drift guard)', () => {
  const cases = [null, [], ['Read'], ['Read', 'Bash'], ['Read', 'WebSearch'], ['Write', 'Edit']]
  for (const tools of cases) {
    const agentMode = { tools }
    const rt = runtimeAgentTools.resolveAgentToolAllowList(agentMode)
    const dn = daemonAgentTools.resolveAgentToolAllowList(agentMode)
    assert.equal(
      runtimeAgentTools.codexShouldForceReadOnly(rt),
      daemonAgentTools.codexShouldForceReadOnly(dn),
      `codex read-only mapping must agree for ${JSON.stringify(tools)}`,
    )
    assert.equal(
      runtimeAgentTools.hermesToolsetsFromAllowList(rt),
      daemonAgentTools.hermesToolsetsFromAllowList(dn),
      `hermes toolset mapping must agree for ${JSON.stringify(tools)}`,
    )
    // Codex deny-all + per-mode sandbox/approval must agree across the twin
    // modules (the Electron codex.ts and the daemon chat-jobs.mjs both depend on
    // them) — otherwise the two Codex launch paths could silently diverge.
    assert.equal(
      runtimeAgentTools.codexDenyAllUnsupported(rt),
      daemonAgentTools.codexDenyAllUnsupported(dn),
      `codex deny-all detection must agree for ${JSON.stringify(tools)}`,
    )
    for (const mode of ['default', 'auto', 'read-only', 'full-access']) {
      const rtFlags = (() => { try { return runtimeAgentTools.codexSandboxApprovalFlags(mode, rt) } catch (e) { return `THROW:${e.message}` } })()
      const dnFlags = (() => { try { return daemonAgentTools.codexSandboxApprovalFlags(mode, dn) } catch (e) { return `THROW:${e.message}` } })()
      assert.deepEqual(rtFlags, dnFlags, `codex sandbox/approval flags must agree for mode ${mode}, tools ${JSON.stringify(tools)}`)
    }
  }
})

// A-PR1 BLOCKING-3: the OLD wiring guard was a SOURCE REGEX — it passed even if a
// provider dropped its actual call path while leaving the helper imported. These
// replacements assert the REAL constructed payload from the SAME builder the
// provider calls, so a regression in the wiring fails the test.

test('runtime Hermes: buildHermesSpawnArgs (the chatHermes call path) reflects AgentMode in the real argv (#1c)', () => {
  // file-only allow-list → --toolsets file (NOT the mode's terminal,file,web,browser),
  // and the persona rides inside the --query prompt.
  const args = buildHermesSpawnArgs({
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: 'PERSONA-RT-HERMES.', tools: ['Read', 'Glob'] },
    mode: 'full', model: 'm', userContent: 'go', contextPrompt: 'PERSONA-RT-HERMES.\n\nBOUNDED-PEER-RT-HERMES',
  })
  const tsIdx = args.indexOf('--toolsets')
  assert.ok(tsIdx >= 0, '--toolsets must be present for a non-empty allow-list')
  assert.equal(args[tsIdx + 1], 'file', 'file-only allow-list → --toolsets file in the real argv')
  const queryIdx = args.indexOf('--query')
  assert.ok(args[queryIdx + 1].includes('PERSONA-RT-HERMES'), 'persona must be in the real --query prompt')
  assert.ok(args[queryIdx + 1].includes('BOUNDED-PEER-RT-HERMES'), 'bounded peers must be in the real --query prompt')
  assert.ok(args[queryIdx + 1].indexOf('PERSONA-RT-HERMES') < args[queryIdx + 1].indexOf('BOUNDED-PEER-RT-HERMES'), 'stable persona must precede volatile peer context')
  assert.ok(args.includes('--quiet'), 'chatHermes uses --quiet unless this Hermes build advertises --stream-json')
  assert.ok(!args.includes('--stream-json'), 'do not pass --stream-json to Hermes Agent 0.20.x (argparse rejects it)')

  // deny-all [] → query-only: empty toolset is dropped (no --toolsets flag).
  const denyAll = buildHermesSpawnArgs({ agentMode: { tools: [] }, mode: 'full', model: 'm', userContent: 'go' })
  assert.ok(!denyAll.includes('--toolsets'), 'deny-all → no toolsets flag (query-only)')
})

test('runtime Codex: buildCodexSpawnArgs (the chatCodex call path) reflects AgentMode in the real argv (#1c)', () => {
  const args = buildCodexSpawnArgs({
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: 'PERSONA-RT-CODEX.', tools: ['Read', 'Glob'] },
    mode: 'default', model: 'm', userContent: 'go', workspaceDir: '/ws', contextPrompt: 'PERSONA-RT-CODEX.',
  })
  assert.equal(codexSandboxAndApproval(args).sandbox, 'read-only', 'write-free allow-list → read-only sandbox in the real runtime argv')
  assert.ok(args[args.length - 1].includes('PERSONA-RT-CODEX'), 'persona must be in the real codex prompt arg')

  // deny-all [] FAILS CLOSED (throws) — same honest contract as the daemon path.
  assert.throws(
    () => buildCodexSpawnArgs({ agentMode: { tools: [] }, mode: 'default', model: 'm', userContent: 'go' }),
    err => { assert.equal(err.message, CODEX_DENY_ALL_ERROR); return true },
    'runtime Codex deny-all must fail closed (throw), not build a read-capable argv',
  )
})

test('runtime Claude: buildClaudeAgentModeOptions (the chatClaude call path) reflects AgentMode (#1c)', () => {
  const restricted = buildClaudeAgentModeOptions({ agentMode: { id: 'ask', name: 'Ask', systemPrompt: 'PERSONA-RT-CLAUDE.', tools: ['Read', 'Glob'] } })
  assert.deepEqual(restricted.tools, ['Read', 'Glob'], 'allow-list → SDK tools restriction')
  assert.equal(restricted.persona, 'PERSONA-RT-CLAUDE.', 'persona → systemPrompt')
  // unset → tools undefined (option omitted → SDK default preset)
  assert.equal(buildClaudeAgentModeOptions({ agentMode: { tools: null } }).tools, undefined)
  // [] → deny-all passed through verbatim (SDK disables all built-ins)
  assert.deepEqual(buildClaudeAgentModeOptions({ agentMode: { tools: [] } }).tools, [])
})

test('runtime providers delegate to the shared payload builders (thin wiring guard)', () => {
  // Substance is behaviorally tested above; this only ensures the providers route
  // through the tested builders (so a revert to inline construction is caught).
  const read = rel => readFileSync(join(ROOT_DIR, rel), 'utf8')
  // claude.ts passes `req` wholesale → can't drop a field.
  assert.match(read('src/main/chat/providers/claude.ts'), /buildClaudeAgentModeOptions\(req\)/, 'chatClaude must call buildClaudeAgentModeOptions')
  // codex.ts / hermes.ts pass object literals — pin agentMode: req.agentMode so a
  // silent drop of the field (the only way to bypass the in-builder fail-closed
  // without throwing on a kept agentId) is caught.
  const codex = read('src/main/chat/providers/codex.ts')
  assert.match(codex, /buildCodexSpawnArgs\(/, 'chatCodex must call buildCodexSpawnArgs')
  assert.match(codex, /agentMode:\s*req\.agentMode/, 'chatCodex must forward req.agentMode to the builder')
  const hermes = read('src/main/chat/providers/hermes.ts')
  assert.match(hermes, /buildHermesSpawnArgs\(/, 'chatHermes must call buildHermesSpawnArgs')
  assert.match(hermes, /agentMode:\s*req\.agentMode/, 'chatHermes must forward req.agentMode to the builder')
})

// ─── BLOCKING-1: agentId set + agentMode unresolved must FAIL CLOSED ───────────

test('runtime builders FAIL CLOSED when agentId is set but agentMode is unresolved (#BLOCKING-1)', () => {
  // The vulnerability: the renderer restores agentId synchronously but loads the
  // definition async, so a request can carry agentId (incl. a deny-all agent) with
  // agentMode still null. Every builder must throw rather than build an
  // unrestricted payload.
  const dangling = { agentId: 'restored-deny-all-agent', agentMode: null }
  const isUnresolvedErr = err => { assert.equal(err.message, runtimeAgentTools.AGENT_MODE_UNRESOLVED_ERROR); return true }
  assert.throws(() => buildHermesSpawnArgs({ ...dangling, mode: 'full', model: 'm', userContent: 'go' }), isUnresolvedErr)
  assert.throws(() => buildCodexSpawnArgs({ ...dangling, mode: 'default', model: 'm', userContent: 'go' }), isUnresolvedErr)
  assert.throws(() => buildClaudeAgentModeOptions(dangling), isUnresolvedErr)

  // No false positives: a RESOLVED agent launches; no agentId launches.
  assert.doesNotThrow(() => buildClaudeAgentModeOptions({ agentId: 'x', agentMode: { tools: ['Read'] } }))
  assert.doesNotThrow(() => buildClaudeAgentModeOptions({ agentMode: null }))
})

test('daemon: an UNKNOWN agentId with no agentMode FAILS CLOSED — claudeQuery never runs (#BLOCKING-1, #cli-persona)', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-agent-unresolved-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  let claudeInvoked = false
  const manager = createChatJobManager({
    homeDir,
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
    claudeQuery: () => (async function* () {
      claudeInvoked = true
      yield { type: 'result', result: 'done', session_id: 's', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  // A request carrying ONLY an agentId (no agentMode) — the shape the CLI sends,
  // and the GUI load-race shape. The daemon now PRE-START resolves it from trusted
  // local sources (#cli-persona): with no agents.json (ENOENT) only BUILT-INS are
  // authoritative, so an UNKNOWN id fails closed with the authoritative DENIED
  // error rather than launching unrestricted.
  const job = await manager.startJob({
    cardId: 'unresolved', workspaceId: 'unresolved-ws',
    provider: 'claude', model: 'claude-test', mode: 'bypassPermissions',
    workspaceDir, messages: [{ role: 'user', content: 'do the thing' }],
    agentId: 'restored-codex-deny-all',
    agentMode: null,
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'failed', 'an unknown agentId must fail the job, not launch')
  assert.equal(completed.error, DAEMON_DENIED, 'fails closed via authoritative resolution (unknown id), not an unrestricted launch')
  assert.equal(claudeInvoked, false, 'claudeQuery must NEVER run for an unresolvable agent (no unrestricted launch)')
})

test('daemon: a RESOLVED agent still launches (no false positive on the BLOCKING-1 guard)', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-agent-resolved-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  let claudeInvoked = false
  const manager = createChatJobManager({
    homeDir,
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
    claudeQuery: () => (async function* () {
      claudeInvoked = true
      yield { type: 'result', result: 'done', session_id: 's', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'resolved', workspaceId: 'resolved-ws',
    provider: 'claude', model: 'claude-test', mode: 'bypassPermissions',
    workspaceDir, messages: [{ role: 'user', content: 'hi' }],
    agentId: 'ask',
    agentMode: { id: 'ask', name: 'Ask', systemPrompt: '', tools: ['Read', 'Glob', 'Grep'] },
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(claudeInvoked, true, 'a resolved agent must launch normally')
})

test('runtime ↔ daemon agentModeUnresolved + error agree (drift guard)', () => {
  assert.equal(
    runtimeAgentTools.AGENT_MODE_UNRESOLVED_ERROR,
    DAEMON_AGENT_MODE_UNRESOLVED_ERROR,
    'the unresolved-agent error string must match across the twin modules',
  )
  const cases = [
    { agentId: 'x', agentMode: null },
    { agentId: 'x', agentMode: undefined },
    { agentId: 'x' },
    { agentId: '', agentMode: null },
    { agentId: '   ', agentMode: null },
    { agentId: 'x', agentMode: { tools: [] } },
    { agentMode: null },
    {},
  ]
  for (const req of cases) {
    assert.equal(
      runtimeAgentTools.agentModeUnresolved(req),
      daemonAgentModeUnresolved(req),
      `agentModeUnresolved must agree for ${JSON.stringify(req)}`,
    )
  }
})

test('renderer: dispatchMessageContent resolves the agent via resolveDispatchAgentMode and dispatches the RESOLVED value, failing closed (#BLOCKING-1 + load-race wiring guard)', () => {
  // No React/DOM runner in this repo (see #4 note), so a source-slice guard stands
  // in. The behavioral contract of resolveDispatchAgentMode is proved separately
  // below; this guard proves the call SITE actually (a) routes through it, (b)
  // short-circuits BEFORE chat.send when it returns ok:false, and (c) dispatches
  // the RESOLVED agentMode — not the seeded `resolvedAgentMode` directly. Reverting
  // line 356 back to `agentMode: resolvedAgentMode` reopens the race while the
  // pure-function test stays green, so this site guard is what catches that.
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileMessaging.ts'), 'utf8')
  const start = src.indexOf('const dispatchMessageContent = useCallback(')
  assert.ok(start >= 0, 'dispatchMessageContent useCallback must exist')
  const next = src.indexOf('\n  const ', start + 1)
  const block = src.slice(start, next > start ? next : undefined)

  const resolveIdx = block.search(/await\s+resolveDispatchAgentMode\(/)
  assert.ok(resolveIdx >= 0, 'must resolve the agent via resolveDispatchAgentMode')
  const failClosedIdx = block.search(/if\s*\(\s*!agentResolution\.ok\s*\)/)
  assert.ok(failClosedIdx >= 0, 'must fail closed when resolution is not ok')
  const sendIdx = block.indexOf('window.electron?.chat?.send')
  assert.ok(sendIdx >= 0, 'chat.send dispatch must exist')
  assert.ok(resolveIdx < sendIdx && failClosedIdx < sendIdx, 'resolution + fail-closed must precede the chat.send dispatch')

  // The dispatched agentMode field must be the RESOLVED value, not the raw seed.
  const payload = block.slice(sendIdx)
  assert.match(payload, /agentMode:\s*dispatchAgentMode\b/, 'chat.send must dispatch the resolved dispatchAgentMode')
  assert.doesNotMatch(payload, /agentMode:\s*resolvedAgentMode/, 'chat.send must NOT dispatch the seeded resolvedAgentMode directly (reopens the load race)')
})

// ─── load-race: a STRICTER agents.json override must win over the seeded built-in ─
// The vulnerability: ChatTile seeds DEFAULT_AGENT_MODES synchronously, then
// overlays agents.json async. If a workspace OVERRIDES a built-in id (agent/ask/
// plan) to be STRICTER, a send in the pre-load window resolves the agentId to the
// LOOSER seeded default — non-null, so every downstream fail-closed guard (which
// only trips on null/unresolved) is bypassed, and the turn runs with the default's
// tools (for `agent`, tools:null = UNRESTRICTED). resolveDispatchAgentMode closes
// the window: during the load it IGNORES the seed and re-resolves from disk.
test('renderer: a send during the load window dispatches the STRICTER agents.json override, NEVER the looser default built-in (#load-race)', async () => {
  // Built-in `agent` default is unrestricted (tools:null). The workspace overrides
  // it to a strict read-only allow-list in agents.json.
  const looserDefaultAgent = { id: 'agent', name: 'Agent', description: '', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: true }
  const stricterOverride = { id: 'agent', name: 'Agent', description: '', systemPrompt: 'read only', tools: ['Read', 'Glob', 'Grep'], icon: 'robot', color: '#3568ff', isBuiltin: true }
  let loadCalls = 0
  const loadFinalModes = async () => { loadCalls++; return [stricterOverride] }

  // Send fires while definitions are still loading; `resolvedAgentMode` is the
  // seeded LOOSER default (what the composer shows for snappy UX).
  const res = await resolveDispatchAgentMode({
    agentId: 'agent',
    resolvedAgentMode: looserDefaultAgent,
    agentModesLoaded: false,
    loadFinalModes,
  })

  assert.equal(res.ok, true, 'a resolvable override must dispatch, not drop the turn')
  assert.equal(loadCalls, 1, 'the pre-load send must AWAIT the authoritative load (not trust the seed)')
  assert.deepEqual(res.agentMode.tools, ['Read', 'Glob', 'Grep'], 'the STRICTER override tools must be dispatched')
  assert.notEqual(res.agentMode.tools, null, 'the looser default (tools:null = UNRESTRICTED) must NEVER be dispatched')
  assert.equal(res.agentMode.systemPrompt, 'read only', 'the override persona must be dispatched')
})

test('renderer: resolveDispatchAgentMode fails closed when a pre-load load fails or the id is unknown (#load-race fail-closed)', async () => {
  // Load throws → fail closed (do not fall back to the seeded looser default).
  const throwOnLoad = async () => { throw new Error('agents.json unreadable') }
  const failed = await resolveDispatchAgentMode({
    agentId: 'agent',
    resolvedAgentMode: { id: 'agent', tools: null }, // looser seed present
    agentModesLoaded: false,
    loadFinalModes: throwOnLoad,
  })
  assert.equal(failed.ok, false, 'a failed authoritative load must fail closed, not use the seed')

  // Loaded list lacks the selected id → fail closed (dangling agentId).
  const unknown = await resolveDispatchAgentMode({
    agentId: 'ghost', resolvedAgentMode: null, agentModesLoaded: false,
    loadFinalModes: async () => [{ id: 'agent', tools: ['Read'] }],
  })
  assert.equal(unknown.ok, false, 'an unknown agentId must fail closed')
})

test('renderer: resolveDispatchAgentMode preserves r2 behavior — loaded path + no-agent path (#BLOCKING-1 / no false positives)', async () => {
  const neverLoad = async () => { throw new Error('must not load when already loaded') }

  // Loaded: trust the resolved mode (the loaded list already reflects overrides);
  // it must NOT re-read disk.
  const loaded = await resolveDispatchAgentMode({
    agentId: 'agent',
    resolvedAgentMode: { id: 'agent', tools: ['Read'] },
    agentModesLoaded: true,
    loadFinalModes: neverLoad,
  })
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.agentMode.tools, ['Read'], 'loaded path dispatches the resolved override')

  // Loaded but unresolved (dangling restored agentId) → fail closed (the r2 #BLOCKING-1 case).
  const loadedNull = await resolveDispatchAgentMode({
    agentId: 'agent', resolvedAgentMode: null, agentModesLoaded: true, loadFinalModes: neverLoad,
  })
  assert.equal(loadedNull.ok, false, 'a loaded-but-unresolved selected agent must still fail closed (#BLOCKING-1)')

  // No agent selected → dispatch unrestricted-by-design (agentMode: null), never fail-closed.
  const none = await resolveDispatchAgentMode({
    agentId: null, resolvedAgentMode: null, agentModesLoaded: false, loadFinalModes: neverLoad,
  })
  assert.equal(none.ok, true)
  assert.equal(none.agentMode, null, 'no selected agent dispatches a null agentMode (no fail-closed regression)')
})

test('renderer: ChatTile wires a LIFECYCLED agentModesLoaded into useChatTileMessaging (#load-race wiring)', () => {
  // The pure resolver + call-site guards above prove the hook does the right thing
  // GIVEN a correct agentModesLoaded. They do NOT prove ChatTile feeds a correctly
  // lifecycled flag. Hardcoding `agentModesLoaded={true}` (or dropping the state)
  // makes every load-window send take the "loaded" path and trust the seeded looser
  // default — reopening the race while the other four tests stay green. This guard
  // closes that vector: the flag must start false, flip true ONLY after the load
  // resolves, and be passed through as the state variable (never a literal true).
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileAgentModes.ts'), 'utf8')
  assert.match(src, /const \[agentModesLoaded, setAgentModesLoaded\] = useState\(false\)/, 'agentModesLoaded must initialize false')
  assert.match(src, /setAgentModes\(list\);?\s*setAgentModesLoaded\(true\)/, 'loaded flag must flip true only after persona loading resolves')
  assert.match(src, /\n\s*agentModesLoaded,\n/, 'agentModesLoaded must be passed through to the messaging hook as the state var')
  assert.doesNotMatch(src, /agentModesLoaded=\{true\}|agentModesLoaded:\s*true/, 'must NOT hardcode the loaded flag true (would reopen the load race)')
})

// ─── Hermes persona on resume (#1a) ───────────────────────────────────────────

test('Hermes: persona is RE-INJECTED on resumed turns, not dropped (#1a)', () => {
  const persona = 'HERMES-PERSONA-9911 act as a security auditor.'

  // First turn: persona present (alongside the output convention).
  const first = buildHermesTurnPrompt({ userContent: 'scan the repo', contextPrompt: persona })
  assert.ok(first.includes(persona), 'persona must lead the first Hermes turn')
  assert.ok(first.includes('scan the repo'))

  // RESUMED turn: regression proof. The OLD code returned bare userContent on
  // resume (persona dropped → agent reverted to default mid-session). It must now
  // re-inject the persona so the agent definition stays enforced.
  const resumed = buildHermesTurnPrompt({ userContent: 'now fix it', contextPrompt: persona })
  assert.ok(resumed.includes(persona), 'persona MUST be present on a resumed Hermes turn (the #1a fix)')
  assert.ok(resumed.includes('now fix it'))

  // No persona configured → resumed turn is exactly the user content (no noise).
  assert.equal(buildHermesTurnPrompt({ userContent: 'plain' }), 'plain')
})

// ─── permission mode persistence round-trip (#2b) ─────────────────────────────

test('daemon: the chosen permission mode round-trips through job metadata (#2b)', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-mode-roundtrip-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({
    homeDir,
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
    claudeQuery: () => (async function* () {
      yield { type: 'result', result: 'done', session_id: 's', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  // WRITE side: startJob persists request.mode (was NEVER stored before #2b).
  const job = await manager.startJob({
    cardId: 'mode-rt', workspaceId: 'mode-rt-ws',
    provider: 'claude', model: 'claude-test', mode: 'read-only',
    workspaceDir, messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(job.mode, 'read-only', 'startJob must persist request.mode into job metadata')

  await waitForCompletedJob(manager, job.id)
  const state = await manager.getJobState(job.id)
  assert.equal(state.mode, 'read-only', 'persisted job metadata retains the chosen mode')

  // READ side: codesurfd.reconstructSessionState restores the mode with this
  // fallback (mirrors codesurfd.mjs). A stored mode restores; a legacy job → default.
  const restore = metadata => (typeof metadata.mode === 'string' && metadata.mode ? metadata.mode : 'default')
  assert.equal(restore(state), 'read-only', 'reopening a session restores the stored mode (not hardcoded default)')
  assert.equal(restore({ provider: 'claude' }), 'default', 'a legacy job without a stored mode falls back to default')

  // Guard the read-back SITE: codesurfd must read metadata.mode, not hardcode it.
  const codesurfd = daemonSource('bin/codesurfd.mjs')
  assert.match(codesurfd, /mode:\s*typeof metadata\.mode === 'string'/, 'codesurfd must reconstruct mode from metadata.mode')
})

// ─── renderer permission-mode resolution (#2a) ────────────────────────────────

test('renderer: a change-then-send uses the LIVE mode, not the stale state ref (#2a)', () => {
  const codexModeIds = ['default', 'auto', 'read-only', 'full-access']

  // The regression scenario: the user switched to 'full-access' (live `mode`),
  // but the persisted-state ref still holds the previous 'default'. The send must
  // launch with the CHOSEN (live) mode.
  assert.equal(
    resolveActiveChatMode('full-access', 'default', codexModeIds, 'default'),
    'full-access',
    'live mode must win over the stale persisted-state mode',
  )

  // Live mode absent → fall back to persisted state mode.
  assert.equal(resolveActiveChatMode(undefined, 'read-only', codexModeIds, 'default'), 'read-only')

  // A mode invalid for the active provider (e.g. carried over from a provider
  // switch) is rejected in favor of the next valid candidate / the fallback.
  assert.equal(resolveActiveChatMode('plan', 'auto', codexModeIds, 'default'), 'auto')
  assert.equal(resolveActiveChatMode('plan', 'acceptEdits', codexModeIds, 'default'), 'default')
})

test('renderer: useChatTileMessaging passes the LIVE mode FIRST to resolveActiveChatMode (#2a wiring)', () => {
  // The resolver is order-sensitive: live mode must be the FIRST argument. Wire
  // it as resolveActiveChatMode(state?.mode, mode, …) and the stale-send bug
  // returns silently — this static guard fails if the live `mode` isn't first.
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileMessaging.ts'), 'utf8')
  assert.match(src, /resolveActiveChatMode\(\s*\n?\s*mode\s*,/, 'live `mode` must be the first arg to resolveActiveChatMode')
})

// ─── renderer: stale-closure deps guard (#4) ──────────────────────────────────
// The repo has no React/DOM test runner (no vitest/RTL/jsdom) and no eslint
// config, so a true render-and-resend test or react-hooks/exhaustive-deps lint
// can't run here. This static guard stands in for exhaustive-deps: it asserts the
// dispatchMessageContent useCallback dependency array lists both identifiers it
// reads when building the send payload. Drop either from deps (the #4 regression)
// and a stale/null agent could be sent — this test fails.

test('renderer: dispatchMessageContent deps include agentId + resolvedAgentMode (#4)', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileMessaging.ts'), 'utf8')

  const start = src.indexOf('const dispatchMessageContent = useCallback(')
  assert.ok(start >= 0, 'dispatchMessageContent useCallback must exist')
  // Slice from the callback start to the next top-level `const ` declaration; the
  // block then ends at this useCallback's closing `}, [ ...deps ])`.
  const next = src.indexOf('\n  const ', start + 1)
  const block = src.slice(start, next > start ? next : undefined)
  // The dependency array is the final `}, [ ... ]` of the block. `}, [` only
  // appears as the callback-body close, so lastIndexOf isolates the deps array.
  const depsOpen = block.lastIndexOf('}, [')
  assert.ok(depsOpen >= 0, 'must find the useCallback dependency array open')
  const depsClose = block.lastIndexOf(']')
  const deps = block.slice(depsOpen + '}, ['.length, depsClose)
  // The payload sends `agentId` and `resolvedAgentMode`; both must be deps.
  assert.match(deps, /\bagentId\b/, 'agentId must be in the dependency array')
  assert.match(deps, /\bresolvedAgentMode\b/, 'resolvedAgentMode must be in the dependency array')
})

// ─── ROOT FIX: server-side authoritative agent resolution ─────────────────────
// The recurring bug class: prior guards only REJECTED a NULL agentMode; they
// never verified that a NON-null mode is the CORRECT mode for the agentId. So any
// renderer race (or a compromised renderer) shipping a non-null-but-LOOSER mode
// passed every guard. The fix re-resolves the agentId AUTHORITATIVELY in main from
// the TRUSTED workspace root's agents.json and overrides what the renderer sent.
// These tests exercise the REAL production resolver (node:fs) — not an injected
// loader — and prove it fails closed on real load/parse failures.

async function writeAgentsJson(root, content) {
  const dir = join(root, '.codesurf', 'customisation')
  await mkdirP(dir, { recursive: true })
  await writeFileP(join(dir, 'agents.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

const STRICT_AGENT_OVERRIDE = {
  id: 'agent', name: 'Agent', description: '', systemPrompt: 'read only',
  tools: ['Read'], icon: 'robot', color: '#3568ff', isBuiltin: true,
}

test('resolver PRODUCTION: an override-then-CORRUPTED agents.json fails closed — never the looser built-in (#root-fix, the singled-out test)', async t => {
  const root = await makeTestTempDir('agent-resolve-corrupt-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })

  // A REAL stricter override of the unrestricted built-in `agent` exists on disk.
  await writeAgentsJson(root, [STRICT_AGENT_OVERRIDE])
  const valid = await resolveAuthoritativeMain({ agentId: 'agent', resolveWorkspaceRoot: () => root })
  assert.equal(valid.ok, true, 'sanity: a valid override resolves')
  assert.deepEqual(valid.agentMode.tools, ['Read'], 'sanity: the stricter override tools are used')

  // Now CORRUPT the file (truncated JSON). The override EXISTED — so we must NOT
  // fall back to the unrestricted built-in `agent` (tools:null). A corrupt file
  // with no override couldn't distinguish "fell back to built-in" from "failed
  // closed"; corrupting a file that DID override is what proves no fallback.
  await writeAgentsJson(root, '[{ "id": "agent", "tools": ["Read"')
  const corrupt = await resolveAuthoritativeMain({ agentId: 'agent', resolveWorkspaceRoot: () => root })
  assert.equal(corrupt.ok, false, 'a corrupt agents.json must fail closed, never resolve the unrestricted built-in')
  assert.equal(corrupt.error, MAIN_DENIED)
})

test('resolver: parse error never yields DEFAULT_AGENT_MODES (#vector-c)', async t => {
  const root = await makeTestTempDir('agent-resolve-parse-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  await writeAgentsJson(root, 'not json at all {{{')
  // Even a built-in id must fail closed: a present-but-unparseable file could be
  // masking a stricter override of that built-in.
  const r = await resolveAuthoritativeMain({ agentId: 'ask', resolveWorkspaceRoot: () => root })
  assert.equal(r.ok, false, 'a parse error must fail closed, not resolve the built-in ask')
})

test('resolver: a present-but-non-array agents.json fails closed (#vector-c)', async t => {
  const root = await makeTestTempDir('agent-resolve-nonarray-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  await writeAgentsJson(root, '{"id":"agent"}') // valid JSON, wrong shape
  const r = await resolveAuthoritativeMain({ agentId: 'agent', resolveWorkspaceRoot: () => root })
  assert.equal(r.ok, false, 'a non-array agents.json could mask an override → fail closed')
})

test('resolver: a STRICTER override is dispatched, never a looser default — and the server reads disk, not a renderer seed (#vector-a + #vector-b)', async t => {
  const root = await makeTestTempDir('agent-resolve-stricter-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  // Workspace overrides the unrestricted built-in `agent` to read-only.
  await writeAgentsJson(root, [{ ...STRICT_AGENT_OVERRIDE, tools: ['Read', 'Glob', 'Grep'] }])

  // The resolver takes ONLY agentId + a trusted-root thunk — it has no parameter
  // for a renderer-supplied agentMode/seed, so the (a) empty-modes-first-load and
  // (b) stale-looser-cache races structurally cannot influence it: it re-reads disk
  // every send and returns the STRICTER override.
  const r = await resolveAuthoritativeMain({ agentId: 'agent', resolveWorkspaceRoot: () => root })
  assert.equal(r.ok, true)
  assert.deepEqual(r.agentMode.tools, ['Read', 'Glob', 'Grep'], 'the on-disk stricter override governs')
  assert.notEqual(r.agentMode.tools, null, 'the looser built-in (tools:null = UNRESTRICTED) must never be dispatched')
  assert.equal(r.agentMode.systemPrompt, 'read only', 'the override persona is dispatched')
})

test('resolver: only the TRUSTED root is consulted — a req.workspaceDir spoof cannot redirect resolution (#spoof)', async t => {
  const trusted = await makeTestTempDir('agent-resolve-trusted-')
  const spoof = await makeTestTempDir('agent-resolve-spoof-')
  t.after(async () => {
    await rmP(trusted, { recursive: true, force: true })
    await rmP(spoof, { recursive: true, force: true })
  })
  // Trusted root = strict; the attacker's spoof dir = permissive (unrestricted).
  await writeAgentsJson(trusted, [STRICT_AGENT_OVERRIDE])
  await writeAgentsJson(spoof, [{ ...STRICT_AGENT_OVERRIDE, systemPrompt: '', tools: null }])

  // The resolver's ONLY path source is resolveWorkspaceRoot (the trusted
  // registry). There is no parameter through which a renderer-supplied workspaceDir
  // could redirect it, so the permissive spoof file is never read.
  const r = await resolveAuthoritativeMain({ agentId: 'agent', resolveWorkspaceRoot: () => trusted })
  assert.equal(r.ok, true)
  assert.deepEqual(r.agentMode.tools, ['Read'], 'the trusted root governs')
  assert.notEqual(r.agentMode.tools, null, 'the permissive spoof agents.json must never be consulted')
})

test('resolver: missing agents.json resolves a BUILT-IN id (no regression) but fails closed on a custom id', async t => {
  const root = await makeTestTempDir('agent-resolve-missing-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  // No agents.json written → genuinely absent (the common fresh-workspace state;
  // ensureCodeSurfStructure does NOT seed it). Built-ins are the authoritative
  // truth — there is no override on disk to bypass.
  const builtin = await resolveAuthoritativeMain({ agentId: 'ask', resolveWorkspaceRoot: () => root })
  assert.equal(builtin.ok, true, 'a built-in agent is authoritative without a file (no regression)')
  assert.equal(builtin.agentMode.id, 'ask')
  assert.deepEqual(builtin.agentMode.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])
  // A custom agentId with no file cannot be confirmed → fail closed.
  const custom = await resolveAuthoritativeMain({ agentId: 'deny-all-auditor', resolveWorkspaceRoot: () => root })
  assert.equal(custom.ok, false, 'a custom agentId with no agents.json must fail closed')
})

test('resolver: a present file lacking the selected id fails closed (built-ins still overlaid)', async t => {
  const root = await makeTestTempDir('agent-resolve-absent-id-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  await writeAgentsJson(root, [{ id: 'ask', name: 'Ask', description: '', systemPrompt: '', tools: ['Read'], icon: 'help', color: '#56c288', isBuiltin: true }])
  // Built-ins are overlaid, so agent/ask/plan still resolve from a partial file...
  assert.equal((await resolveAuthoritativeMain({ agentId: 'plan', resolveWorkspaceRoot: () => root })).ok, true)
  // ...but an id that is neither built-in nor present fails closed.
  const ghost = await resolveAuthoritativeMain({ agentId: 'ghost', resolveWorkspaceRoot: () => root })
  assert.equal(ghost.ok, false, 'an unknown id in a present file fails closed')
})

test('resolver: no agentId selected resolves to null (unrestricted-by-design), no disk read; no trusted root fails closed', async () => {
  // No selected agent → null mode (matches the "None" UI state); must NOT touch disk.
  const none = await resolveAuthoritativeMain({ agentId: null, resolveWorkspaceRoot: () => { throw new Error('must not read disk when no agent is selected') } })
  assert.equal(none.ok, true)
  assert.equal(none.agentMode, null)
  // A selected agent with no resolvable trusted root cannot be confirmed → fail closed.
  const noRoot = await resolveAuthoritativeMain({ agentId: 'ask', resolveWorkspaceRoot: () => null })
  assert.equal(noRoot.ok, false, 'a selected agent with no trusted root fails closed')
})

test('agent-mode-resolver drift guard: shared .ts data + daemon .mjs data + resolution all agree', async t => {
  // (1) The built-in DATA must be byte-identical — the daemon copy is now
  // security-load-bearing (it re-resolves locally), so a silent drift (e.g. the
  // daemon's `ask` carrying different tools) would make the two paths enforce
  // differently.
  assert.deepEqual(DAEMON_DEFAULT_AGENT_MODES, SHARED_DEFAULT_AGENT_MODES, 'daemon DEFAULT_AGENT_MODES must match the shared constant')
  assert.equal(DAEMON_DENIED, MAIN_DENIED, 'the denied-error string must match across the resolvers')

  // (2) The pure overlay must agree on representative inputs.
  const overlayCases = [null, 42, [], [{ id: 'agent', tools: ['Read'] }], [{ id: 'discovered-x', tools: [] }], [{ id: 'new', tools: ['Bash'] }]]
  for (const c of overlayCases) {
    assert.deepEqual(daemonOverlayAgentModes(c), sharedOverlayAgentModes(c), `overlay must agree for ${JSON.stringify(c)}`)
  }

  // (3) The two RESOLVERS (main .ts + daemon .mjs) must produce identical results
  // against the SAME real fixtures, covering ENOENT / valid override / unknown id /
  // corrupt.
  const root = await makeTestTempDir('agent-resolve-drift-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  const agree = async (agentId, label) => {
    const m = await resolveAuthoritativeMain({ agentId, resolveWorkspaceRoot: () => root })
    const d = await resolveAuthoritativeDaemon({ agentId, resolveWorkspaceRoot: () => root })
    assert.deepEqual(m, d, `main + daemon resolvers must agree: ${label}`)
    return m
  }
  // ENOENT (no file yet)
  await agree('ask', 'ENOENT built-in')
  await agree('custom-x', 'ENOENT custom')
  // valid override present
  await writeAgentsJson(root, [STRICT_AGENT_OVERRIDE])
  await agree('agent', 'valid override')
  await agree('ghost', 'present file, unknown id')
  // corrupt
  await writeAgentsJson(root, '[broken json')
  const corrupt = await agree('agent', 'corrupt → fail closed')
  assert.equal(corrupt.ok, false)
})

test('chat:send wires authoritative resolution as a chokepoint above the runtime/daemon split (#root-fix wiring)', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/main/ipc/chat.ts'), 'utf8')
  const canonicalIdx = src.indexOf('canonicalizeElectronChatRequest(req, getWorkspacePathById)')
  const callIdx = src.indexOf('resolveAuthoritativeAgentMode({')
  assert.ok(canonicalIdx >= 0 && canonicalIdx < callIdx, 'chat:send must bind the request through the trusted workspace lookup first')
  assert.ok(callIdx >= 0, 'chat:send must call resolveAuthoritativeAgentMode')
  const failIdx = src.indexOf('if (!authoritativeResolution.ok)')
  assert.ok(failIdx > callIdx, 'must fail closed when resolution is not ok')
  assert.match(src, /agentMode:\s*authoritativeAgentMode/, 'effectiveRequest must override agentMode with the authoritative value')
  // Must precede BOTH dispatch paths (daemon + runtime switch) so both are covered.
  const daemonIdx = src.indexOf('return await sendChatToDaemon(')
  const switchIdx = src.indexOf('switch (requestWithFileReferences.provider)')
  assert.ok(daemonIdx > callIdx && switchIdx > callIdx, 'resolution must be above the runtime/daemon split')
  // Trusted root only — never req.workspaceDir (the renderer-supplied spoof vector).
  const bindingBlock = src.slice(canonicalIdx, callIdx)
  assert.match(bindingBlock, /getWorkspacePathById/, 'must resolve the trusted root via getWorkspacePathById')
  const resolutionBlock = src.slice(callIdx, failIdx)
  assert.match(resolutionBlock, /canonicalRequest\.workspaceDir/, 'persona resolution must use the already-bound canonical root')
  assert.doesNotMatch(resolutionBlock, /req\.workspaceDir/, 'must NOT consult req.workspaceDir for resolution')
})

test('daemon runJob adds gated defense-in-depth re-resolution (#root-fix daemon)', () => {
  const src = daemonSource('bin/chat-jobs.mjs')
  assert.match(src, /resolveAuthoritativeAgentMode\(/, 'runJob must re-resolve authoritatively (defense in depth)')
  // Gated on a PRESENT local agents.json so the cloud (no .codesurf) trusts main's
  // shipped value rather than failing closed on a custom id.
  assert.match(src, /existsSync\(join\(workspaceDir, '\.codesurf', 'customisation', 'agents\.json'\)\)/, 'must gate re-resolution on a present local agents.json')
  assert.match(src, /request = \{ \.\.\.request, agentMode: authoritative\.agentMode \}/, 'must override request.agentMode with the re-resolved value')
})

// ─── #cli-persona: PRE-START authoritative resolution for agentId-only requests ─
// The `codesurf chat --persona` CLI sends ONLY an agentId (never a trusted
// agentMode). Before the fail-closed unresolved check, runJob resolves the persona
// authoritatively from trusted local sources: ENOENT → built-ins; present file →
// agents.json overlay; corrupt/unknown → fail closed. Tools/permissions therefore
// come ONLY from trusted disk, never from any caller-supplied payload.

test('daemon runJob PRE-START resolves an agentId-only request before the unresolved fail-close (#cli-persona wiring)', () => {
  const src = daemonSource('bin/chat-jobs.mjs')
  const preStartIdx = src.indexOf('if (request.agentId && request.agentMode == null) {')
  assert.ok(preStartIdx >= 0, 'runJob must pre-start resolve when agentId is present and agentMode is absent')
  const unresolvedIdx = src.indexOf('if (agentModeUnresolved(request)) {')
  assert.ok(unresolvedIdx > preStartIdx, 'pre-start resolution must run BEFORE the fail-closed unresolved check')
  // It must reuse the shared authoritative resolver (no duplicated resolution logic)
  // and fail closed when resolution is not ok.
  const block = src.slice(preStartIdx, unresolvedIdx)
  assert.match(block, /resolveAuthoritativeAgentMode\(\{/, 'must reuse resolveAuthoritativeAgentMode')
  assert.match(block, /if \(!preStart\.ok\)/, 'must fail closed when resolution is not ok')
  assert.match(block, /request = \{ \.\.\.request, agentMode: preStart\.agentMode \}/, 'must attach the trusted resolved agentMode')
})

function makeCapturingCodexSdk(captured) {
  return {
    resumeThread(id, options) {
      captured.resumeId = id
      captured.options = options
      return {
        async runStreamed(input) {
          captured.input = input
          return {
            events: scriptedStream([
              { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'ok' } },
              { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
            ]),
          }
        },
      }
    },
    startThread() { throw new Error('resumeThread should be used when request.sessionId is set') },
  }
}

test('daemon #cli-persona: agentId-only + ENOENT resolves the BUILT-IN persona tools (read-only, NOT unrestricted)', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-persona-builtin-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })

  const captured = {}
  const manager = createChatJobManager({
    homeDir,
    codexSdkFactory: () => makeCapturingCodexSdk(captured),
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
  })

  // No agents.json on disk (ENOENT). The built-in `ask` has a write-free allow-list
  // (Read/Glob/Grep/WebSearch/WebFetch). Sent with mode 'default' (which would map to
  // workspace-write if unrestricted) — resolving to the built-in forces read-only.
  const job = await manager.startJob({
    cardId: 'persona-builtin', workspaceId: 'persona-ws',
    provider: 'codex', model: 'gpt-test', mode: 'default', useCodexSdk: true,
    sessionId: 'thread-builtin', workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
    agentId: 'ask', agentMode: null,
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed', 'a known built-in agentId must launch')
  assert.equal(captured.options.sandboxMode, 'read-only', 'the built-in write-free allow-list forces read-only (NOT unrestricted)')
  assert.ok(captured.input.includes('read-only mode'), 'the resolved built-in persona systemPrompt must reach the prompt')
})

test('daemon #cli-persona: agentId-only + agents.json present resolves the CUSTOM persona from disk', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-persona-custom-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })
  await writeAgentsJson(workspaceDir, [
    { id: 'reader', name: 'Reader', description: '', systemPrompt: 'CUSTOM-READER-PROMPT-7781', tools: ['Read'], icon: 'help', color: '#111', isBuiltin: false },
  ])

  const captured = {}
  const manager = createChatJobManager({
    homeDir,
    codexSdkFactory: () => makeCapturingCodexSdk(captured),
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
  })

  const job = await manager.startJob({
    cardId: 'persona-custom', workspaceId: 'persona-ws',
    provider: 'codex', model: 'gpt-test', mode: 'default', useCodexSdk: true,
    sessionId: 'thread-custom', workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
    agentId: 'reader', agentMode: null,
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed', 'a custom agents.json persona must resolve and launch')
  assert.ok(captured.input.includes('CUSTOM-READER-PROMPT-7781'), 'the custom persona systemPrompt (from agents.json) must reach the prompt')
  assert.equal(captured.options.sandboxMode, 'read-only', 'the custom write-free allow-list forces read-only')
})

test('daemon #cli-persona: agentId-only + CORRUPT agents.json FAILS CLOSED (provider never runs)', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-persona-corrupt-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdirP(workspaceDir, { recursive: true })
  t.after(async () => { await rmP(homeDir, { recursive: true, force: true }) })
  await writeAgentsJson(workspaceDir, '[broken json')

  const captured = {}
  let codexInvoked = false
  const manager = createChatJobManager({
    homeDir,
    codexSdkFactory: () => { codexInvoked = true; return makeCapturingCodexSdk(captured) },
    checkpointStore: { createCheckpoint() { return { ok: true, checkpoint: { id: 'c' } } } },
  })

  const job = await manager.startJob({
    cardId: 'persona-corrupt', workspaceId: 'persona-ws',
    provider: 'codex', model: 'gpt-test', mode: 'default', useCodexSdk: true,
    sessionId: 'thread-corrupt', workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
    agentId: 'reader', agentMode: null,
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'failed', 'a corrupt agents.json must fail the job closed')
  assert.equal(completed.error, DAEMON_DENIED, 'must fail closed with the authoritative denied error')
  assert.equal(codexInvoked, false, 'the provider must NEVER run when resolution fails closed')
})

test('listPersonas (read-only): built-ins + agents.json overlay, never the discovered-* set (#cli-persona)', async t => {
  const root = await makeTestTempDir('persona-list-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })

  // ENOENT → built-ins exactly.
  const builtins = await daemonListPersonas({ resolveWorkspaceRoot: () => root })
  assert.deepEqual(builtins, daemonOverlayAgentModes(null), 'no agents.json → built-ins (overlay of null)')
  assert.ok(builtins.some(p => p.id === 'ask'), 'built-ins include ask')

  // Present file: overlays a custom persona, overrides a built-in, and DROPS a
  // discovered-* scan entry.
  await writeAgentsJson(root, [
    { id: 'custom-x', name: 'Custom X', tools: ['Read'], isBuiltin: false },
    { id: 'ask', name: 'Ask Overridden', tools: ['Read'], isBuiltin: true },
    { id: 'discovered-zzz', name: 'Ephemeral', tools: [], isBuiltin: false },
  ])
  const listed = await daemonListPersonas({ resolveWorkspaceRoot: () => root })
  assert.deepEqual(
    listed.find(p => p.id === 'custom-x'),
    {
      id: 'custom-x',
      name: 'Custom X',
      description: '',
      systemPrompt: '',
      tools: ['Read'],
      icon: 'robot',
      color: '#3568ff',
      isBuiltin: false,
    },
    'listing returns the same complete strict persona shape used by resolution',
  )
  assert.ok(listed.some(p => p.id === 'custom-x'), 'overlay includes the custom persona')
  assert.equal(listed.find(p => p.id === 'ask')?.name, 'Ask Overridden', 'overlay applies a built-in override')
  assert.ok(!listed.some(p => String(p.id).startsWith('discovered-')), 'the discovered-* scan set must NEVER be listed')

  // Corrupt → built-ins (advisory listing; resolution still fails closed at start).
  await writeAgentsJson(root, '[broken json')
  const corruptListed = await daemonListPersonas({ resolveWorkspaceRoot: () => root })
  assert.deepEqual(corruptListed, daemonOverlayAgentModes(null), 'a corrupt file lists built-ins (advisory)')
})

// ─── Persona `extends` inheritance + fail-closed tool rule (NEW) ──────────────
// A Persona may declare `extends: <basePersonaId>`. Resolution merges the base,
// then overlays the child's EXPLICITLY-DEFINED fields. FAIL-CLOSED TOOL RULE:
// inheritance must NEVER widen tools beyond what the child explicitly grants — if
// the child defines `tools`, the child's list wins outright; if the child omits
// `tools`, it inherits the base's. The pure `overlayPersonas` (sharedOverlay…)
// performs the merge; we assert against it AND through the production resolver.

const personaById = (list, id) => list.find(p => p.id === id) ?? null

test('persona extends: inherits base soul/icon, child-defined fields overlay the base', () => {
  const resolved = sharedOverlayAgentModes([
    { id: 'base', name: 'Base', description: 'base desc', systemPrompt: 'BASE-SOUL', tools: ['Read', 'Glob'], icon: 'map', color: '#111111', isBuiltin: false },
    { id: 'child', name: 'Child', extends: 'base', description: 'child desc', tools: ['Read'], isBuiltin: false },
  ])
  const child = personaById(resolved, 'child')
  assert.equal(child.systemPrompt, 'BASE-SOUL', 'omitted systemPrompt inherits the base soul')
  assert.equal(child.icon, 'map', 'omitted icon inherits the base')
  assert.equal(child.color, '#111111', 'omitted color inherits the base')
  assert.equal(child.name, 'Child', 'defined name overlays the base')
  assert.equal(child.description, 'child desc', 'defined description overlays the base')
  assert.equal(child.id, 'child', 'the child keeps its own id')
  assert.deepEqual(child.tools, ['Read'], 'child-defined tools win outright')
  // The base itself is untouched.
  assert.deepEqual(personaById(resolved, 'base').tools, ['Read', 'Glob'])
})

test('persona extends FAIL-CLOSED: an omitted child `tools` inherits the base (never widened)', () => {
  const resolved = sharedOverlayAgentModes([
    { id: 'base', name: 'Base', description: '', systemPrompt: 'S', tools: ['Read', 'Glob'], icon: 'help', color: '#222', isBuiltin: false },
    { id: 'child', name: 'Child', extends: 'base', isBuiltin: false }, // no `tools` key
  ])
  assert.deepEqual(personaById(resolved, 'child').tools, ['Read', 'Glob'], 'omitted tools inherits the base list verbatim')
})

test('persona extends FAIL-CLOSED: a restricted child is NEVER widened by a permissive base', () => {
  // Base is unrestricted (tools:null = all tools). The child explicitly narrows to
  // ['Read']. Inheritance must NOT let the base widen the child back to null.
  const resolved = sharedOverlayAgentModes([
    { id: 'wide', name: 'Wide', description: '', systemPrompt: '', tools: null, icon: 'robot', color: '#333', isBuiltin: false },
    { id: 'narrow', name: 'Narrow', extends: 'wide', tools: ['Read'], isBuiltin: false },
  ])
  const narrow = personaById(resolved, 'narrow')
  assert.deepEqual(narrow.tools, ['Read'], 'child-defined restriction wins — base null must not widen it')
  assert.notEqual(narrow.tools, null, 'inheritance must never widen a restricted child to unrestricted')
})

test('persona extends FAIL-CLOSED: a deny-all ([]) child is honored over a permissive base', () => {
  const resolved = sharedOverlayAgentModes([
    { id: 'wide', name: 'Wide', description: '', systemPrompt: '', tools: ['Read', 'Bash'], icon: 'robot', color: '#333', isBuiltin: false },
    { id: 'locked', name: 'Locked', extends: 'wide', tools: [], isBuiltin: false }, // explicit deny-all
  ])
  assert.deepEqual(personaById(resolved, 'locked').tools, [], 'explicit deny-all child wins; base tools must not leak in')
})

test('persona extends: a child may extend a BUILT-IN, inheriting its tools while overriding the soul', () => {
  // Built-in `ask` carries tools ['Read','Glob','Grep','WebSearch','WebFetch'].
  const resolved = sharedOverlayAgentModes([
    { id: 'ask-plus', name: 'Ask Plus', extends: 'ask', systemPrompt: 'CUSTOM-ASK-SOUL', isBuiltin: false },
  ])
  const askPlus = personaById(resolved, 'ask-plus')
  assert.deepEqual(askPlus.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], 'omitted tools inherits the built-in base')
  assert.equal(askPlus.systemPrompt, 'CUSTOM-ASK-SOUL', 'defined systemPrompt overlays the built-in soul')
  // Built-in `ask` itself is unchanged by the overlay.
  assert.equal(personaById(resolved, 'ask').systemPrompt, SHARED_DEFAULT_AGENT_MODES.find(p => p.id === 'ask').systemPrompt)
})

test('persona extends: a dangling/cyclic base resolves the child UNCHANGED (no widening)', () => {
  // Dangling: child points at a base that does not exist → child stands alone.
  const dangling = sharedOverlayAgentModes([
    { id: 'orphan', name: 'Orphan', extends: 'does-not-exist', tools: ['Read'], systemPrompt: 'O', icon: 'robot', color: '#444', isBuiltin: false },
  ])
  assert.deepEqual(personaById(dangling, 'orphan').tools, ['Read'], 'a dangling extends never inherits (cannot widen)')

  // Self-cycle: extends itself → resolves to itself, no infinite loop, no widening.
  const selfCycle = sharedOverlayAgentModes([
    { id: 'loop', name: 'Loop', extends: 'loop', tools: ['Read'], systemPrompt: 'L', icon: 'robot', color: '#555', isBuiltin: false },
  ])
  assert.deepEqual(personaById(selfCycle, 'loop').tools, ['Read'], 'a self-cycle resolves safely without widening')
})

test('persona extends FAIL-CLOSED: a dangling base + child OMITS tools → DENY-ALL (not unrestricted)', () => {
  // Regression for the fail-OPEN bug: a missing base with no explicit child tools
  // must normalize to deny-all `[]`, NEVER leave tools undefined (= unrestricted
  // downstream in agent-mode-tools).
  for (const overlay of [sharedOverlayAgentModes, daemonOverlayAgentModes]) {
    const resolved = overlay([
      { id: 'orphan', name: 'Orphan', extends: 'does-not-exist', systemPrompt: 'O', icon: 'robot', color: '#444', isBuiltin: false }, // no tools key
    ])
    assert.deepEqual(personaById(resolved, 'orphan').tools, [], 'dangling extends + omitted tools must fail closed to []')
    assert.notEqual(personaById(resolved, 'orphan').tools, null, 'must NOT be unrestricted')
  }
})

test('persona extends FAIL-CLOSED: a self-cycle + child OMITS tools → DENY-ALL', () => {
  for (const overlay of [sharedOverlayAgentModes, daemonOverlayAgentModes]) {
    const resolved = overlay([
      { id: 'loop', name: 'Loop', extends: 'loop', systemPrompt: 'L', icon: 'robot', color: '#555', isBuiltin: false }, // no tools key
    ])
    assert.deepEqual(personaById(resolved, 'loop').tools, [], 'self-cycle + omitted tools must fail closed to []')
  }
})

test('persona extends FAIL-CLOSED: a TWO-NODE cycle + child OMITS tools must NOT inherit the permissive partner', () => {
  // A extends B, B extends A. `child` omits tools while its cycle partner `wideman`
  // is permissive (tools:null). The cycle is unresolvable → child must deny-all,
  // NEVER inherit the permissive partner's tools.
  for (const overlay of [sharedOverlayAgentModes, daemonOverlayAgentModes]) {
    const resolved = overlay([
      { id: 'child', name: 'Child', extends: 'wideman', systemPrompt: 'C', icon: 'robot', color: '#666', isBuiltin: false }, // no tools key
      { id: 'wideman', name: 'Wideman', extends: 'child', tools: null, systemPrompt: 'W', icon: 'robot', color: '#777', isBuiltin: false },
    ])
    assert.deepEqual(personaById(resolved, 'child').tools, [], 'cyclic child omitting tools must fail closed to [], not inherit the permissive partner')
    assert.notEqual(personaById(resolved, 'child').tools, null, 'must never widen to unrestricted via a cycle')
  }
})

test('persona extends: a TWO-NODE cycle where the child DEFINES tools:[] stays [] (explicit deny-all honored)', () => {
  for (const overlay of [sharedOverlayAgentModes, daemonOverlayAgentModes]) {
    const resolved = overlay([
      { id: 'child', name: 'Child', extends: 'wideman', tools: [], systemPrompt: 'C', icon: 'robot', color: '#666', isBuiltin: false },
      { id: 'wideman', name: 'Wideman', extends: 'child', tools: ['Read', 'Bash'], systemPrompt: 'W', icon: 'robot', color: '#777', isBuiltin: false },
    ])
    assert.deepEqual(personaById(resolved, 'child').tools, [], 'explicit deny-all child in a cycle stays []')
  }
})

test('persona extends FAIL-CLOSED: the production resolver rejects a dangling extends target', async t => {
  const root = await makeTestTempDir('persona-failclosed-resolve-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  await writeAgentsJson(root, [
    { id: 'orphan', name: 'Orphan', extends: 'ghost-base', systemPrompt: 'O', icon: 'robot', color: '#444', isBuiltin: false },
  ])
  const m = await resolveAuthoritativeMain({ agentId: 'orphan', resolveWorkspaceRoot: () => root })
  const d = await resolveAuthoritativeDaemon({ agentId: 'orphan', resolveWorkspaceRoot: () => root })
  assert.equal(m.ok, false)
  assert.equal(m.error, MAIN_DENIED)
  assert.deepEqual(m, d, 'main + daemon must agree on the fail-closed result')
})

test('persona extends: main + daemon resolvers agree on an extends fixture (drift guard)', async t => {
  const root = await makeTestTempDir('persona-extends-drift-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })
  await writeAgentsJson(root, [
    { id: 'base', name: 'Base', description: '', systemPrompt: 'BASE', tools: ['Read', 'Glob'], icon: 'map', color: '#111', isBuiltin: false },
    { id: 'child', name: 'Child', extends: 'base', tools: ['Read'], isBuiltin: false },
    { id: 'inheritor', name: 'Inheritor', extends: 'base', isBuiltin: false },
  ])
  for (const agentId of ['base', 'child', 'inheritor']) {
    const m = await resolveAuthoritativeMain({ agentId, resolveWorkspaceRoot: () => root })
    const d = await resolveAuthoritativeDaemon({ agentId, resolveWorkspaceRoot: () => root })
    assert.deepEqual(m, d, `main + daemon must agree resolving extends for ${agentId}`)
  }
  // Spot-check the resolved values through the production resolver.
  const child = await resolveAuthoritativeMain({ agentId: 'child', resolveWorkspaceRoot: () => root })
  assert.deepEqual(child.agentMode.tools, ['Read'], 'child-defined tools win through the production resolver')
  assert.equal(child.agentMode.systemPrompt, 'BASE', 'child inherits the base soul through the production resolver')
  const inheritor = await resolveAuthoritativeMain({ agentId: 'inheritor', resolveWorkspaceRoot: () => root })
  assert.deepEqual(inheritor.agentMode.tools, ['Read', 'Glob'], 'omitted child tools inherit the base through the production resolver')
})

// ─── Seeded built-in Personas: Polly + Gemma (NEW) ────────────────────────────

test('seeded personas: Polly and Gemma are built-ins and resolve correctly with no agents.json', async t => {
  const root = await makeTestTempDir('persona-seeds-')
  t.after(async () => { await rmP(root, { recursive: true, force: true }) })

  for (const id of ['polly', 'gemma']) {
    // Present in the shared + daemon built-in constants (byte-identical).
    const sharedDef = SHARED_DEFAULT_AGENT_MODES.find(p => p.id === id)
    const daemonDef = DAEMON_DEFAULT_AGENT_MODES.find(p => p.id === id)
    assert.ok(sharedDef, `${id} must be a shared built-in persona`)
    assert.deepEqual(sharedDef, daemonDef, `${id} built-in must be byte-identical across shared + daemon`)
    assert.equal(sharedDef.isBuiltin, true, `${id} must be flagged built-in`)
    assert.ok(sharedDef.name && sharedDef.description && sharedDef.icon && sharedDef.color, `${id} must carry name/description/icon/color`)
    assert.ok(typeof sharedDef.systemPrompt === 'string' && sharedDef.systemPrompt.length > 0, `${id} must carry a soul (systemPrompt)`)

    // Resolve authoritatively with NO agents.json (ENOENT → built-ins authoritative).
    const m = await resolveAuthoritativeMain({ agentId: id, resolveWorkspaceRoot: () => root })
    const d = await resolveAuthoritativeDaemon({ agentId: id, resolveWorkspaceRoot: () => root })
    assert.equal(m.ok, true, `${id} resolves from the built-ins without a file`)
    assert.deepEqual(m, d, `${id} main + daemon resolution must agree`)
    assert.equal(m.agentMode.id, id)
    assert.equal(m.agentMode.name, sharedDef.name)
  }

  // Sanity on the placeholder identities (refine the souls later, not the wiring).
  assert.equal(SHARED_DEFAULT_AGENT_MODES.find(p => p.id === 'polly').name, 'Polly')
  assert.equal(SHARED_DEFAULT_AGENT_MODES.find(p => p.id === 'gemma').name, 'Gemma')
})
