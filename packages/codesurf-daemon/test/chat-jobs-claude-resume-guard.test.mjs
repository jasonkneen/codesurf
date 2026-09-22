import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChatJobManager } from '../bin/chat-jobs.mjs'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

async function waitFor(check, timeoutMs = 5_000, intervalMs = 25) {
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
    if (!state || state.status === 'running') return null
    return state
  })
}

// Drive a single Claude turn with an injected claudeQuery that records the
// `resume` option the daemon handed the SDK, then yields a successful result.
function claudeProjectKeyForTest(cwd) {
  const normalized = resolve(cwd).normalize('NFC')
  const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  let hash = 0
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

async function runClaudeTurn({ homeDir, sessionId, prepareWorkspace }) {
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  await prepareWorkspace?.(workspaceDir)

  const captured = { resume: 'UNSET', promptSeen: null, queryRan: false }
  const manager = createChatJobManager({
    homeDir,
    claudeQuery: ({ prompt, options }) => (async function* () {
      captured.queryRan = true
      captured.promptSeen = prompt
      captured.resume = options.resume
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'claude-thread-new',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-resume-guard',
    workspaceId: 'remote-claude-resume-guard',
    provider: 'claude',
    model: 'claude-test',
    mode: 'default',
    workspaceDir,
    sessionId,
    messages: [{ role: 'user', content: 'continue please' }],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  return { captured, completed }
}

test('daemon Claude job does NOT resume when the sessionId has no on-disk transcript', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-resume-missing-')
  const claudeConfigDir = await makeTestTempDir('chat-jobs-claude-config-missing-')
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  t.after(async () => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    await rm(homeDir, { recursive: true, force: true })
    await rm(claudeConfigDir, { recursive: true, force: true })
  })

  // A codex-style UUIDv7 thread id handed over after a provider switch — there
  // is no <id>.jsonl transcript anywhere under the Claude projects dir.
  const foreignSessionId = '019ecd2c-1234-7580-9abc-def012345678'
  const { captured, completed } = await runClaudeTurn({ homeDir, sessionId: foreignSessionId })

  // The turn must still run — fresh, not resumed.
  assert.equal(captured.queryRan, true)
  assert.equal(captured.promptSeen, 'continue please')
  assert.equal(captured.resume, undefined, 'resume must be omitted for a foreign/stale sessionId')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.error, null)
})

test('daemon Claude job resumes when the sessionId has a real on-disk transcript', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-resume-present-')
  const claudeConfigDir = await makeTestTempDir('chat-jobs-claude-config-present-')
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  t.after(async () => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    await rm(homeDir, { recursive: true, force: true })
    await rm(claudeConfigDir, { recursive: true, force: true })
  })

  const sessionId = 'claude-thread-existing-abc123'
  const { captured, completed } = await runClaudeTurn({
    homeDir,
    sessionId,
    prepareWorkspace: async workspaceDir => {
      const projectDir = join(claudeConfigDir, 'projects', claudeProjectKeyForTest(workspaceDir))
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: 'user', uuid: 'u1', sessionId }) + '\n',
        'utf8',
      )
    },
  })

  assert.equal(captured.queryRan, true)
  assert.equal(captured.resume, sessionId, 'resume must be set when the transcript exists')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.error, null)
})

test('daemon Claude job does not resume a transcript owned by another workspace', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-resume-wrong-workspace-')
  const claudeConfigDir = await makeTestTempDir('chat-jobs-claude-config-wrong-workspace-')
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  t.after(async () => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    await rm(homeDir, { recursive: true, force: true })
    await rm(claudeConfigDir, { recursive: true, force: true })
  })

  const sessionId = 'claude-thread-other-workspace'
  const otherWorkspace = join(homeDir, 'other-workspace')
  await mkdir(otherWorkspace, { recursive: true })
  const projectDir = join(claudeConfigDir, 'projects', claudeProjectKeyForTest(otherWorkspace))
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId }) + '\n',
    'utf8',
  )

  const { captured, completed } = await runClaudeTurn({ homeDir, sessionId })
  assert.equal(captured.resume, undefined)
  assert.equal(completed.status, 'completed')
})
