import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChatJobManager, resolveClaudeExecutable } from '../bin/chat-jobs.mjs'

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

test('resolveClaudeExecutable finds the SDK native binary or agent-paths fallback', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-exe-resolve-')
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const resolved = resolveClaudeExecutable(homeDir)
  assert.equal(typeof resolved, 'string')
  assert.equal(existsSync(resolved), true, `expected an on-disk claude executable, got ${resolved}`)
})

test('daemon Claude jobs pass pathToClaudeCodeExecutable into the SDK', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-exe-options-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => { await rm(homeDir, { recursive: true, force: true }) })

  const captured = { options: null }
  const manager = createChatJobManager({
    homeDir,
    claudeQuery: ({ options }) => (async function* () {
      captured.options = options
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'thread-exe',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'card-exe',
    workspaceId: 'ws-exe',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'ping' }],
  })

  const completed = await waitFor(async () => {
    const state = await manager.getJobState(job.id)
    if (!state || state.status === 'running' || state.status === 'queued') return null
    return state
  })

  assert.equal(completed.status, 'completed')
  assert.equal(typeof captured.options?.pathToClaudeCodeExecutable, 'string')
  assert.equal(existsSync(captured.options.pathToClaudeCodeExecutable), true)
})
