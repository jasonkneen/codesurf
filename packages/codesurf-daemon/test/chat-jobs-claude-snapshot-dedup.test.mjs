import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createChatJobManager,
  remainingAssistantSnapshotText,
} from '../bin/chat-jobs.mjs'

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

function streamDelta(text, index) {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    },
  }
}

test('remainingAssistantSnapshotText does not re-emit a snapshot already streamed under another index', () => {
  const full = "Hello. The CodeSurf peer-registration tools aren't available.\n\nReady to work — what do you need?"
  const prefix = 'Hello. The CodeSurf pe'
  const rest = full.slice(prefix.length)
  assert.equal(remainingAssistantSnapshotText(full, prefix, prefix), rest)
  assert.equal(remainingAssistantSnapshotText(full, '', prefix + rest), '')
  assert.equal(remainingAssistantSnapshotText(full, '', full), '')
  assert.equal(remainingAssistantSnapshotText('Found 3 files.', '', "I'll read the file."), 'Found 3 files.')
})

test('daemon does not duplicate assistant text when thinking occupies stream index 0', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-snapshot-dedup-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const prefix = 'Hello. The CodeSurf pe'
  const rest = "er-registration tools aren't available in this session.\n\nReady to work — what do you need?"
  const full = prefix + rest

  const manager = createChatJobManager({
    homeDir,
    claudeQuery: () => (async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        session_id: 'thread-dedup',
      }
      yield {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        session_id: 'thread-dedup',
      }
      yield streamDelta(prefix, 1)
      yield streamDelta(rest, 1)
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: full }] },
        session_id: 'thread-dedup',
      }
      yield {
        type: 'result',
        result: full,
        session_id: 'thread-dedup',
        total_cost_usd: 0.12,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'card-dedup',
    workspaceId: 'ws-dedup',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'hello' }],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  const timeline = await readTimeline(homeDir, job.id)
  const texts = timeline.filter(event => event.type === 'text').map(event => event.text)
  assert.deepEqual(texts, [prefix, rest])
  assert.equal(texts.join(''), full)
})
