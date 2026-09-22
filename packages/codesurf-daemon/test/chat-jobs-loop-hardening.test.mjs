import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChatJobManager } from '../bin/chat-jobs.mjs'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

async function waitFor(check, timeoutMs = 5_000, intervalMs = 15) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function waitForCompletedJob(manager, jobId) {
  return await waitFor(async () => {
    const state = await manager.getJobState(jobId)
    if (!state || state.status === 'running' || state.status === 'queued') return null
    return state
  })
}

async function readTimeline(homeDir, jobId) {
  return (await readFile(join(homeDir, 'timelines', `${jobId}.jsonl`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function textDelta(text) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }
}

// daemon-07: the full metadata file is debounced during a streaming turn, but
// terminal/session events flush immediately. This test proves the debounce
// never drops the durable final state: status, sessionId, and a lastSequence
// that exactly matches the timeline are all correct after completion.
test('daemon-07: debounced metadata stays consistent with the timeline after a multi-delta stream', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-loop-07-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({
    homeDir,
    claudeQuery: () => (async function* () {
      for (const chunk of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        yield { ...textDelta(chunk), session_id: 'thread-07' }
      }
      yield { type: 'result', result: 'ok', session_id: 'thread-07', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'card-07',
    workspaceId: 'ws-07',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'stream please' }],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.error, null)
  assert.equal(completed.sessionId, 'thread-07')

  const timeline = await readTimeline(homeDir, job.id)
  const lastSeq = timeline.at(-1)?.sequence
  // The debounced final flush (forced by the terminal 'done') must equal the
  // timeline's last sequence — i.e. no event was lost from the metadata.
  assert.equal(completed.lastSequence, lastSeq)
  assert.equal(timeline.filter(e => e.type === 'text').length, 8)
  assert.equal(timeline.some(e => e.type === 'done'), true)
})

test('daemon emits Workspace Instructions once per unchanged conversation', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-memory-once-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({
    homeDir,
    claudeQuery: () => (async function* () {
      yield { ...textDelta('ok'), session_id: 'thread-stable' }
      yield { type: 'result', result: 'ok', session_id: 'thread-stable', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const base = {
    cardId: 'card-stable',
    workspaceId: 'ws-stable',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    memoryPrompt: '## Workspace Instructions\nKeep replies terse.',
    skillsPrompt: '## Skills\nverify-before-done',
    skillsSummary: 'Included 1 skill.',
  }

  const first = await manager.startJob({
    ...base,
    messages: [{ role: 'user', content: 'first turn' }],
  })
  assert.equal((await waitForCompletedJob(manager, first.id)).status, 'completed')

  const second = await manager.startJob({
    ...base,
    sessionId: 'thread-stable',
    messages: [{ role: 'user', content: 'second turn' }],
  })
  assert.equal((await waitForCompletedJob(manager, second.id)).status, 'completed')

  const changed = await manager.startJob({
    ...base,
    sessionId: 'thread-stable',
    memoryPrompt: '## Workspace Instructions\nNow prefer detailed answers.',
    messages: [{ role: 'user', content: 'third turn' }],
  })
  assert.equal((await waitForCompletedJob(manager, changed.id)).status, 'completed')

  const firstTimeline = await readTimeline(homeDir, first.id)
  const secondTimeline = await readTimeline(homeDir, second.id)
  const changedTimeline = await readTimeline(homeDir, changed.id)
  const memoryStarts = timeline => timeline.filter(event =>
    event.type === 'tool_start' && event.toolId === 'codesurf-memory-context',
  )
  const skillStarts = timeline => timeline.filter(event =>
    event.type === 'tool_start' && event.toolId === 'codesurf-skills-context',
  )

  assert.equal(memoryStarts(firstTimeline).length, 1)
  assert.equal(skillStarts(firstTimeline).length, 1)
  assert.equal(memoryStarts(secondTimeline).length, 0)
  assert.equal(skillStarts(secondTimeline).length, 0)
  assert.equal(memoryStarts(changedTimeline).length, 1)
  assert.equal(skillStarts(changedTimeline).length, 0)
})

test('daemon: empty Claude result after context preflight fails instead of completing a blank assistant turn', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-empty-claude-result-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(workspaceDir, 'AGENTS.md'), 'Workspace preflight instructions', 'utf8')
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({
    homeDir,
    claudeQuery: () => (async function* () {
      yield { type: 'result', result: '', session_id: 'empty-result', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'card-empty-result',
    workspaceId: 'ws-empty-result',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'please continue' }],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error, /Claude finished without assistant output/)

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'tool_start' && event.toolId === 'codesurf-memory-context'), true)
  const errorIndex = timeline.findIndex(event => event.type === 'error')
  const doneIndex = timeline.findIndex(event => event.type === 'done')
  assert.notEqual(errorIndex, -1)
  assert.notEqual(doneIndex, -1)
  assert.ok(errorIndex < doneIndex)
  assert.match(timeline[errorIndex].error, /Claude finished without assistant output/)
})

test('daemon: Claude final result text is emitted when partial text deltas are missing', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-result-text-fallback-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({
    homeDir,
    claudeQuery: () => (async function* () {
      yield { type: 'result', result: 'fallback answer', session_id: 'result-text', total_cost_usd: 0.001, num_turns: 1 }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'card-result-text',
    workspaceId: 'ws-result-text',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'answer from result only' }],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.error, null)

  const timeline = await readTimeline(homeDir, job.id)
  const textIndex = timeline.findIndex(event => event.type === 'text' && event.text === 'fallback answer')
  const doneIndex = timeline.findIndex(event => event.type === 'done')
  assert.notEqual(textIndex, -1)
  assert.notEqual(doneIndex, -1)
  assert.ok(textIndex < doneIndex)
})

// daemon-01: the manager caps how many jobs execute concurrently; the overflow
// sits in status 'queued' and drains FIFO as slots free. This test holds every
// in-flight query open on a gate, proves only `maxConcurrentJobs` run at once
// (the rest are 'queued'), then releases and proves all of them complete and
// the cap was never exceeded.
test('daemon-01: concurrency cap bounds running jobs and queues the overflow', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-loop-01-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })

  let running = 0
  let maxObserved = 0
  let released = false
  const pendingResolvers = []
  const gate = () => new Promise(resolve => {
    if (released) resolve()
    else pendingResolvers.push(resolve)
  })
  const releaseAll = () => {
    released = true
    pendingResolvers.splice(0).forEach(r => r())
  }
  t.after(async () => {
    releaseAll()
    await rm(homeDir, { recursive: true, force: true })
  })

  const manager = createChatJobManager({
    homeDir,
    maxConcurrentJobs: 2,
    claudeQuery: () => (async function* () {
      running += 1
      maxObserved = Math.max(maxObserved, running)
      await gate()
      running -= 1
      yield { type: 'result', result: 'ok', session_id: 'cap', total_cost_usd: 0, num_turns: 1 }
    })(),
  })

  const jobs = []
  for (let i = 0; i < 5; i += 1) {
    jobs.push(await manager.startJob({
      cardId: `cap-${i}`,
      workspaceId: 'ws-cap',
      provider: 'claude',
      model: 'claude-test',
      mode: 'bypassPermissions',
      workspaceDir,
      messages: [{ role: 'user', content: `go ${i}` }],
    }))
  }

  // Exactly two queries enter; the cap holds the other three back.
  await waitFor(() => running >= 2)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(running, 2)
  assert.equal(maxObserved, 2)

  const midStates = await Promise.all(jobs.map(j => manager.getJobState(j.id)))
  assert.equal(midStates.filter(s => s.status === 'running').length, 2)
  assert.equal(midStates.filter(s => s.status === 'queued').length, 3)

  // Drain: every job must complete, and the cap must never have been exceeded.
  releaseAll()
  for (const job of jobs) {
    const done = await waitForCompletedJob(manager, job.id)
    assert.equal(done.status, 'completed')
  }
  assert.equal(maxObserved, 2)
})

// daemon-05: the retention sweep prunes old terminal jobs (metadata + timeline)
// while protecting recent ones, never-expired ones, and live/active jobs.
test('daemon-05: sweepJobRetention prunes old terminal jobs but keeps recent/active ones', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-loop-05-')
  await mkdir(join(homeDir, 'jobs'), { recursive: true })
  await mkdir(join(homeDir, 'timelines'), { recursive: true })
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const manager = createChatJobManager({ homeDir })

  const writeJob = async (id, status, completedAt) => {
    await writeFile(join(homeDir, 'jobs', `${id}.json`), JSON.stringify({ id, status, completedAt }), 'utf8')
    await writeFile(join(homeDir, 'timelines', `${id}.jsonl`), '{"type":"done"}\n', 'utf8')
  }
  const old = '2020-01-01T00:00:00.000Z'
  const now = new Date().toISOString()
  await writeJob('old-completed', 'completed', old)
  await writeJob('old-failed', 'failed', old)
  await writeJob('fresh-completed', 'completed', now)
  await writeJob('still-running', 'running', null)

  const jobExists = id => existsSync(join(homeDir, 'jobs', `${id}.json`))
  const timelineExists = id => existsSync(join(homeDir, 'timelines', `${id}.jsonl`))

  // keepRecent 0 → recency protection off; only the age filter applies.
  const result = await manager.sweepJobRetention({ maxAgeMs: 60_000, keepRecent: 0 })

  assert.equal(result.pruned, 2)
  // Old terminal jobs are gone, with their timelines.
  assert.equal(jobExists('old-completed'), false)
  assert.equal(timelineExists('old-completed'), false)
  assert.equal(jobExists('old-failed'), false)
  // Fresh terminal job is within the TTL → kept.
  assert.equal(jobExists('fresh-completed'), true)
  // Active (non-terminal) job is never prunable, regardless of age.
  assert.equal(jobExists('still-running'), true)

  // keepRecent protects the N newest terminal jobs even when they are old.
  await writeJob('old-completed', 'completed', old)
  const protectedSweep = await manager.sweepJobRetention({ maxAgeMs: 60_000, keepRecent: 10 })
  assert.equal(protectedSweep.pruned, 0)
  assert.equal(jobExists('old-completed'), true)
})
