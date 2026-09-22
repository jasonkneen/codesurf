import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { createChatJobManager } from '../bin/chat-jobs.mjs'

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function timeline(homeDir, jobId) {
  const raw = await readFile(join(homeDir, 'timelines', `${jobId}.jsonl`), 'utf8')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function deferred() {
  let resolve
  const promise = new Promise(settle => { resolve = settle })
  return { promise, resolve }
}

test('daemon cancel waits for a TERM-resistant CLI tree before publishing done', {
  timeout: 15_000,
  skip: process.platform === 'win32'
    ? 'SIGTERM-resistant POSIX group escalation is not portable to Windows'
    : false,
}, async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-daemon-tree-'))
  const workspaceDir = join(homeDir, 'workspace')
  const binDir = join(homeDir, 'bin')
  const pidPath = join(homeDir, 'pids.json')
  const markerPath = join(homeDir, 'writes.log')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(binDir, { recursive: true })

  const fakeCodexPath = join(binDir, 'codex')
  const descendantSource = `
    const { appendFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    setInterval(() => appendFileSync(process.env.CODESURF_TREE_MARKER, 'old\\n'), 10);
  `
  const fakeCodexSource = `#!/usr/bin/env node
    const { spawn } = require('node:child_process');
    const { appendFileSync, writeFileSync } = require('node:fs');
    if (process.env.CODESURF_TREE_MODE === 'replacement') {
      appendFileSync(process.env.CODESURF_TREE_MARKER, 'new\\n');
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'replacement' } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
      process.exit(0);
    }
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });
    writeFileSync(process.env.CODESURF_TREE_PIDS, JSON.stringify({ leaderPid: process.pid, childPid: child.pid }));
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'old-thread' }) + '\\n');
    setInterval(() => {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stale-old-output' } }) + '\\n');
    }, 10);
  `
  await writeFile(fakeCodexPath, fakeCodexSource, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const originalPath = process.env.PATH
  const originalPidPath = process.env.CODESURF_TREE_PIDS
  const originalMarkerPath = process.env.CODESURF_TREE_MARKER
  const originalMode = process.env.CODESURF_TREE_MODE
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
  process.env.CODESURF_TREE_PIDS = pidPath
  process.env.CODESURF_TREE_MARKER = markerPath
  delete process.env.CODESURF_TREE_MODE

  const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  let oldPids = null
  t.after(async () => {
    process.env.PATH = originalPath
    if (originalPidPath === undefined) delete process.env.CODESURF_TREE_PIDS
    else process.env.CODESURF_TREE_PIDS = originalPidPath
    if (originalMarkerPath === undefined) delete process.env.CODESURF_TREE_MARKER
    else process.env.CODESURF_TREE_MARKER = originalMarkerPath
    if (originalMode === undefined) delete process.env.CODESURF_TREE_MODE
    else process.env.CODESURF_TREE_MODE = originalMode
    await manager.shutdown().catch(() => {})
    if (oldPids?.leaderPid && pidIsAlive(oldPids.leaderPid)) {
      try { process.kill(-oldPids.leaderPid, 'SIGKILL') } catch {}
    }
    await rm(homeDir, { recursive: true, force: true })
  })

  const oldJob = await manager.startJob({
    provider: 'codex',
    model: 'test',
    mode: 'default',
    workspaceDir,
    messages: [{ role: 'user', content: 'run until cancelled' }],
  })
  oldPids = await waitFor(async () => {
    try { return JSON.parse(await readFile(pidPath, 'utf8')) } catch { return null }
  })
  await waitFor(async () => (await timeline(homeDir, oldJob.id))
    .some(event => event.type === 'text'))
  await waitFor(async () => {
    try { return (await readFile(markerPath, 'utf8')).includes('old') } catch { return false }
  })

  const cancelStartedAt = Date.now()
  const cancellation = manager.cancelJob(oldJob.id)
  await new Promise(resolve => setTimeout(resolve, 100))
  const textEventsAfterCancellationOwned = (await timeline(homeDir, oldJob.id))
    .filter(event => event.type === 'text').length
  const cancelled = await cancellation
  assert.deepEqual(cancelled, { ok: true })
  assert.ok(Date.now() - cancelStartedAt >= 900, 'TERM grace must elapse before SIGKILL confirmation')
  assert.equal(pidIsAlive(oldPids.leaderPid), false)
  assert.equal(pidIsAlive(oldPids.childPid), false)

  const cancelledTimeline = await timeline(homeDir, oldJob.id)
  assert.equal(cancelledTimeline.at(-1)?.type, 'done')
  assert.equal(cancelledTimeline.filter(event => event.type === 'done').length, 1)
  assert.equal(cancelledTimeline.filter(event => event.type === 'error').at(-1)?.error, 'Job cancelled')
  assert.equal(
    cancelledTimeline.filter(event => event.type === 'text').length,
    textEventsAfterCancellationOwned,
    'old provider output must be suppressed after cancellation takes ownership',
  )

  const oldWrites = (await readFile(markerPath, 'utf8')).split('\n').filter(Boolean)
  process.env.CODESURF_TREE_MODE = 'replacement'
  const replacementJob = await manager.startJob({
    provider: 'codex',
    model: 'test',
    mode: 'default',
    workspaceDir,
    messages: [{ role: 'user', content: 'replacement' }],
  })
  await waitFor(async () => {
    const state = await manager.getJobState(replacementJob.id)
    return state?.status === 'completed' || state?.status === 'failed'
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  const writesAfterReplacement = (await readFile(markerPath, 'utf8')).split('\n').filter(Boolean)
  assert.deepEqual(writesAfterReplacement.slice(0, oldWrites.length), oldWrites)
  assert.deepEqual(writesAfterReplacement.slice(oldWrites.length), ['new'])
})

test('daemon cancellation during async provider preparation prevents a late launch', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-daemon-prelaunch-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const factoryStarted = deferred()
  const releaseFactory = deferred()
  let threadStarts = 0
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    codexSdkFactory: async () => {
      factoryStarted.resolve()
      await releaseFactory.promise
      return {
        startThread() {
          threadStarts += 1
          throw new Error('a cancelled preparation must never start a thread')
        },
      }
    },
  })
  t.after(async () => {
    releaseFactory.resolve()
    await manager.shutdown().catch(() => {})
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'codex',
    useCodexSdk: true,
    model: 'test',
    mode: 'default',
    workspaceDir,
    messages: [{ role: 'user', content: 'do not launch after cancellation' }],
  })
  await factoryStarted.promise
  const cancellation = manager.cancelJob(job.id)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await timeline(homeDir, job.id)).some(event => event.type === 'done'), false)
  releaseFactory.resolve()
  assert.deepEqual(await cancellation, { ok: true })
  const cancelledTimeline = await timeline(homeDir, job.id)
  assert.equal(cancelledTimeline.at(-1)?.type, 'done')

  await waitFor(() => !manager.listLiveJobIds().includes(job.id))
  assert.equal(threadStarts, 0)
  assert.deepEqual(await timeline(homeDir, job.id), cancelledTimeline)
})
