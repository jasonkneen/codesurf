import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, lstatSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHarnessRunner,
  pumpHarnessStream,
  PI_HARNESS_UNAVAILABLE_ERROR,
  HARNESS_SUPPORTED_PROVIDERS,
} from '../bin/harness-runtime.mjs'

// A fake AI SDK StreamTextResult.fullStream: an async iterable of scripted parts.
async function* scriptedStream(parts) {
  for (const p of parts) yield p
}

// Builds a fake HarnessAgent whose stream() yields the given parts, so we can
// test runHarnessJob's mapping with no sandbox/bridge/model.
function fakeAgentFactory(parts, captured = {}) {
  return opts => {
    captured.opts = opts
    return {
      async createSession(sessionOpts) {
        captured.sessionOpts = sessionOpts
        return { sessionId: sessionOpts?.sessionId ?? 'fake-session', destroy: async () => { captured.destroyed = true } }
      },
      async stream(streamOpts) {
        captured.streamOpts = streamOpts
        return { fullStream: scriptedStream(parts) }
      },
    }
  }
}

function collectRunner(parts, captured) {
  const homeDir = mkdtempSync(join(tmpdir(), 'codesurf-harness-test-'))
  const events = []
  const appendEvent = async (_jobId, evt) => { events.push(evt) }
  const runner = createHarnessRunner({ homeDir, createAgent: fakeAgentFactory(parts, captured) })
  return { runner, events, appendEvent, homeDir }
}

test('runHarnessJob maps fullStream parts to the daemon event vocabulary and ends with done', async () => {
  const captured = {}
  const { runner, events, appendEvent, homeDir } = collectRunner([
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', text: 'planning' },
    { type: 'text-delta', id: 't1', text: 'Hello ' },
    { type: 'text-delta', id: 't1', text: 'world' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'Write', input: { path: 'x.txt' } },
    { type: 'tool-result', toolCallId: 'c1', toolName: 'Write', output: 'ok' },
    { type: 'finish', finishReason: 'stop' },
  ], captured)

  const workspace = mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-'))
  const job = { id: 'job-1' }
  await runner.runHarnessJob(
    job,
    { provider: 'claude', mode: 'acceptEdits', messages: [{ role: 'user', content: 'hi' }] },
    workspace,
    '',
    { appendEvent },
  )

  const types = events.map(e => e.type)
  assert.deepEqual(types, [
    'session', 'thinking_start', 'thinking', 'text', 'text',
    'tool_start', 'tool_input', 'tool_summary', 'done',
  ])
  assert.equal(events.find(e => e.type === 'thinking').text, 'planning')
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello world')
  assert.equal(events.find(e => e.type === 'tool_start').toolName, 'Write')
  assert.equal(events.find(e => e.type === 'tool_summary').text, 'ok')
  // session destroyed in finally
  assert.equal(captured.destroyed, true)
  // permissionMode mapping: acceptEdits -> allow-edits (edits auto, exec asks)
  assert.equal(captured.opts.permissionMode, 'allow-edits')
  void homeDir
})

test('default permission mode is read-only (allow-reads) when no edit mode requested', async () => {
  const captured = {}
  const { runner, appendEvent } = collectRunner([{ type: 'finish', finishReason: 'stop' }], captured)
  await runner.runHarnessJob(
    { id: 'job-2' },
    { provider: 'claude', messages: [{ role: 'user', content: 'hi' }] },
    mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-')),
    '',
    { appendEvent },
  )
  assert.equal(captured.opts.permissionMode, 'allow-reads')
})

test('runHarnessJob deterministically binds the workspace via a symlink at the composed cwd', async () => {
  const captured = {}
  const homeDir = mkdtempSync(join(tmpdir(), 'codesurf-harness-test-'))
  const workspace = mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-'))
  const events = []
  const appendEvent = async (_j, e) => { events.push(e) }
  const runner = createHarnessRunner({ homeDir, createAgent: fakeAgentFactory([{ type: 'finish', finishReason: 'stop' }], captured) })
  await runner.runHarnessJob(
    { id: 'job-3' },
    { provider: 'claude', mode: 'acceptEdits', messages: [{ role: 'user', content: 'hi' }] },
    workspace,
    '',
    { appendEvent },
  )
  // composed cwd = <baseDir>/<harnessId>-<sessionId>; harnessId for claude = 'claude-code'
  const composed = join(homeDir, 'harness', 'sessions', 'claude-job-3', 'claude-code-job-3')
  assert.ok(existsSync(composed), 'composed cwd should exist')
  assert.ok(lstatSync(composed).isSymbolicLink(), 'composed cwd should be a symlink to the workspace')
})

test('no user message yields an error then done', async () => {
  const captured = {}
  const { runner, events, appendEvent } = collectRunner([], captured)
  await runner.runHarnessJob(
    { id: 'job-4' },
    { provider: 'claude', messages: [] },
    mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-')),
    '',
    { appendEvent },
  )
  assert.deepEqual(events.map(e => e.type), ['error', 'done'])
})

test('unsupported provider is rejected with error then done', async () => {
  const captured = {}
  const { runner, events, appendEvent } = collectRunner([], captured)
  await runner.runHarnessJob(
    { id: 'job-5' },
    { provider: 'opencode', messages: [{ role: 'user', content: 'hi' }] },
    mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-')),
    '',
    { appendEvent },
  )
  assert.deepEqual(events.map(e => e.type), ['error', 'done'])
  assert.match(events[0].error, /does not support provider/)
})

test('an explicit Pi harness request fails closed with a stable remediation message', async () => {
  const captured = {}
  const { runner, events, appendEvent } = collectRunner([], captured)
  await runner.runHarnessJob(
    { id: 'job-pi-unavailable' },
    { provider: 'pi', messages: [{ role: 'user', content: 'hi' }] },
    mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-')),
    '',
    { appendEvent },
  )
  assert.deepEqual(events, [
    { type: 'error', error: PI_HARNESS_UNAVAILABLE_ERROR },
    { type: 'done' },
  ])
  assert.equal(captured.opts, undefined, 'the vulnerable Pi adapter must never launch')
})

test('pumpHarnessStream maps an error part to an error event', async () => {
  const events = []
  const appendEvent = async (_j, e) => { events.push(e) }
  await pumpHarnessStream(scriptedStream([{ type: 'error', error: new Error('boom') }]), 'jx', appendEvent)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
  assert.match(events[0].error, /boom/)
})

test('the harness asks the user for tool approval and resumes the turn after they answer', async () => {
  const captured = {}
  const home = mkdtempSync(join(tmpdir(), 'codesurf-harness-test-'))
  const events = []
  const asked = []
  const appendEvent = async (_j, e) => { events.push(e) }
  const awaitToolPermission = async (approvalId, req) => { asked.push({ approvalId, toolName: req.toolName }); return 'once' }

  // First stream pauses on an approval request; continueStream finishes the turn.
  const createAgent = () => ({
    async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
    async stream() {
      return {
        fullStream: scriptedStream([
          { type: 'tool-approval-request', approvalId: 'ap-1', toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'Bash', input: { command: 'ls' } } },
        ]),
        response: Promise.resolve({ messages: [] }),
      }
    },
    async continueStream(opts) {
      captured.continued = true
      captured.continuationsArg = opts.toolApprovalContinuations
      return { fullStream: scriptedStream([{ type: 'text-delta', id: 't', text: 'done' }, { type: 'finish', finishReason: 'stop' }]), response: Promise.resolve({ messages: [] }) }
    },
  })

  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob(
    { id: 'ap-job' },
    { provider: 'claude', mode: 'default', messages: [{ role: 'user', content: 'run ls' }] },
    '', // no workspace → no worktree, isolates the approval flow
    '',
    { appendEvent, awaitToolPermission },
  )

  // It asked the user for the exact tool/approval the agent requested...
  assert.deepEqual(asked, [{ approvalId: 'ap-1', toolName: 'Bash' }])
  // ...surfaced the resolution...
  assert.ok(events.some(e => e.type === 'tool_permission_resolved' && e.toolId === 'ap-1' && e.decision === 'once'))
  // ...resumed the turn via continueStream...
  assert.equal(captured.continued, true)
  // ...and finished.
  assert.ok(events.some(e => e.type === 'done'))
})

test('without an approval handler, pending approvals are denied and the turn still completes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codesurf-harness-test-'))
  const events = []
  const createAgent = () => ({
    async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
    async stream() {
      return {
        fullStream: scriptedStream([{ type: 'tool-approval-request', approvalId: 'ap-x', toolCall: { type: 'tool-call', toolCallId: 'tc', toolName: 'Bash', input: {} } }]),
        response: Promise.resolve({ messages: [] }),
      }
    },
    async continueStream() {
      return { fullStream: scriptedStream([{ type: 'finish', finishReason: 'stop' }]), response: Promise.resolve({ messages: [] }) }
    },
  })
  const runner = createHarnessRunner({ homeDir: home, createAgent })
  await runner.runHarnessJob({ id: 'ap-job2' }, { provider: 'claude', mode: 'default', messages: [{ role: 'user', content: 'x' }] }, '', '', { appendEvent: async (_j, e) => events.push(e) })
  assert.ok(events.some(e => e.type === 'tool_permission_resolved' && e.decision === 'deny'))
  assert.ok(events.some(e => e.type === 'done'))
})

test('HARNESS_SUPPORTED_PROVIDERS excludes Pi until its dependency chain is safe', () => {
  assert.deepEqual([...HARNESS_SUPPORTED_PROVIDERS].sort(), ['claude', 'codex'])
})

// A fake agent whose stream() writes files into the bound worktree (the path is
// deterministic from daemonHome + sessionId), then yields a finishing stream.
function gitWorktreeFakeFactory(worktreePath, edits) {
  return () => ({
    async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
    async stream() {
      for (const [name, content] of Object.entries(edits)) {
        writeFileSync(join(worktreePath, name), content)
      }
      return { fullStream: scriptedStream([{ type: 'text-delta', id: 't', text: 'done' }, { type: 'finish', finishReason: 'stop' }]) }
    },
  })
}

test('git workspace: turn runs in a worktree, checkpoints pre-edit state, then applies to live workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codesurf-harness-gitws-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 't@codesurf.local'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: workspace })
  writeFileSync(join(workspace, 'committed.txt'), 'v1\n')
  execFileSync('git', ['add', '-A'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: workspace })

  const daemonHome = mkdtempSync(join(tmpdir(), 'codesurf-harness-home-'))
  const sessionId = 'wt-job' // sanitizeSessionId(job.id)
  const worktreePath = join(daemonHome, 'harness', 'worktrees', `ws-${sessionId}`)

  const checkpoints = []
  const createCheckpoint = async (toolName, files) => {
    // Capture the live content at checkpoint time to prove it's PRE-edit.
    checkpoints.push({ toolName, files, liveAtCheckpoint: readFileSync(join(workspace, 'committed.txt'), 'utf8') })
  }
  const events = []
  const appendEvent = async (_j, e) => { events.push(e) }

  const runner = createHarnessRunner({
    homeDir: daemonHome,
    createAgent: gitWorktreeFakeFactory(worktreePath, { 'committed.txt': 'edited-by-agent\n', 'created.txt': 'new\n' }),
  })

  try {
    await runner.runHarnessJob(
      { id: 'wt-job' },
      { provider: 'claude', mode: 'acceptEdits', messages: [{ role: 'user', content: 'edit' }] },
      workspace,
      '',
      { appendEvent, createCheckpoint },
    )

    // Live workspace received the agent's changes (applied from the worktree).
    assert.equal(readFileSync(join(workspace, 'committed.txt'), 'utf8'), 'edited-by-agent\n')
    assert.equal(readFileSync(join(workspace, 'created.txt'), 'utf8'), 'new\n')

    // Checkpoint ran BEFORE apply, capturing pre-edit content.
    assert.equal(checkpoints.length, 1)
    assert.equal(checkpoints[0].toolName, 'harness-turn')
    assert.equal(checkpoints[0].liveAtCheckpoint, 'v1\n')
    assert.ok(checkpoints[0].files.some(f => f.endsWith('committed.txt')))
    assert.ok(checkpoints[0].files.some(f => f.endsWith('created.txt')))

    // A workspace-updated event was surfaced.
    assert.ok(events.some(e => e.type === 'tool_summary' && e.toolName === 'Workspace updated'))

    // Worktree cleaned up.
    assert.equal(existsSync(worktreePath), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(daemonHome, { recursive: true, force: true })
  }
})

test('git workspace: a failed turn discards the worktree and leaves the live workspace untouched', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codesurf-harness-gitws-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 't@codesurf.local'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: workspace })
  writeFileSync(join(workspace, 'committed.txt'), 'v1\n')
  execFileSync('git', ['add', '-A'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: workspace })

  const daemonHome = mkdtempSync(join(tmpdir(), 'codesurf-harness-home-'))
  const sessionId = 'wt-fail'
  const worktreePath = join(daemonHome, 'harness', 'worktrees', `ws-${sessionId}`)

  let checkpointed = false
  const events = []
  const runner = createHarnessRunner({
    homeDir: daemonHome,
    createAgent: () => ({
      async createSession(o) { return { sessionId: o?.sessionId ?? 'fake', destroy: async () => {} } },
      async stream() {
        writeFileSync(join(worktreePath, 'committed.txt'), 'edited-in-worktree\n')
        throw new Error('turn blew up')
      },
    }),
  })

  try {
    await runner.runHarnessJob(
      { id: 'wt-fail' },
      { provider: 'claude', mode: 'acceptEdits', messages: [{ role: 'user', content: 'edit' }] },
      workspace,
      '',
      { appendEvent: async (_j, e) => events.push(e), createCheckpoint: async () => { checkpointed = true } },
    )

    // Live workspace untouched, no checkpoint, error surfaced, worktree gone.
    assert.equal(readFileSync(join(workspace, 'committed.txt'), 'utf8'), 'v1\n')
    assert.equal(checkpointed, false)
    assert.ok(events.some(e => e.type === 'error'))
    assert.equal(existsSync(worktreePath), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(daemonHome, { recursive: true, force: true })
  }
})
