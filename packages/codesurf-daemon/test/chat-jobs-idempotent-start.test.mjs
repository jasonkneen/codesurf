// Regression tests for the 2026-09-05 daemon review port:
//   D1 — idempotent job start (client startRequestId dedup)
//   D3 — closing-flag shutdown ownership (new starts rejected once shutdown begins)
//
// D2 (cancellation during preparation) and D4 (serialized metadata commits)
// are intentionally NOT covered here: this codebase's chat-jobs.mjs already
// has its own native mechanisms for both (cancelRequested checked inside
// runJob's preparation awaits, and metadataWriteChains-based serialization in
// writeJobMetadata), so no port was needed for those two findings.
//
// Run: node --test packages/codesurf-daemon/test/chat-jobs-idempotent-start.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChatJobManager } from '../bin/chat-jobs.mjs'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 5_000, intervalMs = 15) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function waitForJobExit(manager, jobId) {
  await waitFor(() => !manager.listLiveJobIds().includes(jobId))
}

async function readMeta(homeDir, jobId) {
  return JSON.parse(await readFile(join(homeDir, 'jobs', `${jobId}.json`), 'utf8'))
}

function baseRequest(workspaceDir, extra = {}) {
  return {
    provider: 'claude',
    model: 'test-model',
    workspaceDir,
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  }
}

// Scripted stand-in for the Claude SDK `query`: every launch is a push-driven
// async iterator the test feeds explicitly and ends explicitly. It does not
// react to AbortController cancellation itself, so a test controls exactly
// when a job unwinds — mirroring how the real SDK's query() would eventually
// settle once its own internal process exits.
function createScriptedProvider() {
  const launches = []
  const wake = launch => {
    for (const resolve of launch.waiters.splice(0)) resolve()
  }
  const claudeQuery = ({ prompt, options }) => {
    const launch = { prompt, options, queue: [], waiters: [], ended: false }
    launches.push(launch)
    return {
      async next() {
        while (true) {
          if (launch.queue.length > 0) return { value: launch.queue.shift(), done: false }
          if (launch.ended) return { value: undefined, done: true }
          await new Promise(resolve => launch.waiters.push(resolve))
        }
      },
      return() {
        launch.ended = true
        return Promise.resolve({ value: undefined, done: true })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
  return {
    claudeQuery,
    launches,
    end(launch) {
      launch.ended = true
      wake(launch)
    },
    // Emits a terminal 'result' message (so runClaudeJob marks the job
    // 'completed' with the given reply) and ends the iterator.
    complete(launch, resultText = 'ok') {
      launch.queue.push({ type: 'result', result: resultText, session_id: 'thread-test', total_cost_usd: 0, num_turns: 1 })
      launch.ended = true
      wake(launch)
    },
    async waitForLaunch(count) {
      await waitFor(() => launches.length >= count)
      return launches[count - 1]
    },
  }
}

test('D1: a repeated startRequestId after completion returns the existing job and executes once', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-d1-repeat-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const provider = createScriptedProvider()
  const manager = createChatJobManager({ homeDir, claudeQuery: provider.claudeQuery })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const request = baseRequest(workspaceDir, { startRequestId: 'req-1' })
  const first = await manager.startJob(request)
  const launch = await provider.waitForLaunch(1)
  provider.complete(launch)
  await waitForJobExit(manager, first.id)

  const second = await manager.startJob(request)
  assert.equal(second.id, first.id, 'retry must resolve to the job the first attempt created')
  await sleep(20)
  assert.equal(provider.launches.length, 1, 'the prompt must execute exactly once')
  assert.equal((await readMeta(homeDir, first.id)).status, 'completed')
})

test('D1: a duplicate that arrives while the first start is still pending coalesces onto it', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-d1-coalesce-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const provider = createScriptedProvider()
  const manager = createChatJobManager({ homeDir, claudeQuery: provider.claudeQuery })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const request = baseRequest(workspaceDir, { startRequestId: 'req-2' })
  // Both calls are issued in the same tick: the first runs synchronously up to
  // its first await (workspace provisioning) before yielding, by which point
  // it has already registered its pending promise under the startRequestId —
  // so the second call observes it and coalesces instead of starting a
  // second job.
  const [first, second] = await Promise.all([manager.startJob(request), manager.startJob(request)])
  assert.equal(second.id, first.id)

  const launch = await provider.waitForLaunch(1)
  provider.end(launch)
  await waitForJobExit(manager, first.id)
  await sleep(20)
  assert.equal(provider.launches.length, 1)
})

test('D1: distinct or absent startRequestIds still create distinct jobs', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-d1-distinct-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const provider = createScriptedProvider()
  const manager = createChatJobManager({ homeDir, claudeQuery: provider.claudeQuery })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const a = await manager.startJob(baseRequest(workspaceDir, { startRequestId: 'req-a' }))
  const b = await manager.startJob(baseRequest(workspaceDir, { startRequestId: 'req-b' }))
  const c = await manager.startJob(baseRequest(workspaceDir))
  const d = await manager.startJob(baseRequest(workspaceDir))
  assert.equal(new Set([a.id, b.id, c.id, d.id]).size, 4)
  await provider.waitForLaunch(4)
  for (const launch of provider.launches) provider.end(launch)
  for (const job of [a, b, c, d]) await waitForJobExit(manager, job.id)
})

test('D1: a failed start is not remembered, so the retry can start the job', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-d1-failed-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const provider = createScriptedProvider()
  const manager = createChatJobManager({ homeDir, claudeQuery: provider.claudeQuery })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const bad = baseRequest(join(homeDir, 'does-not-exist'), { startRequestId: 'req-fail' })
  await assert.rejects(manager.startJob(bad), /Workspace path is unavailable/)
  const job = await manager.startJob({ ...bad, workspaceDir })
  assert.ok(job.id)
  const launch = await provider.waitForLaunch(1)
  provider.end(launch)
  await waitForJobExit(manager, job.id)
})

test('D3: shutdown irreversibly rejects new starts and the queued job never launches', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-d3-shutdown-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const provider = createScriptedProvider()
  const manager = createChatJobManager({ homeDir, claudeQuery: provider.claudeQuery, maxConcurrentJobs: 1 })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const a = await manager.startJob(baseRequest(workspaceDir))
  const launchA = await provider.waitForLaunch(1)
  const b = await manager.startJob(baseRequest(workspaceDir))
  assert.equal((await readMeta(homeDir, b.id)).status, 'queued')

  const shutdownDone = manager.shutdown()
  await assert.rejects(manager.startJob(baseRequest(workspaceDir)), /shutting down/)

  provider.end(launchA) // A unwinds; pumpJobQueue must not use this to launch B
  await shutdownDone
  await waitForJobExit(manager, a.id)
  await sleep(20)

  assert.equal(provider.launches.length, 1, 'the queued job must never start')
  assert.deepEqual(manager.listLiveJobIds(), [])
  const metaB = await readMeta(homeDir, b.id)
  assert.equal(metaB.status, 'failed')

  // Closing is irreversible: still rejected after shutdown has resolved.
  await assert.rejects(manager.startJob(baseRequest(workspaceDir)), /shutting down/)
  assert.equal(provider.launches.length, 1)
})
