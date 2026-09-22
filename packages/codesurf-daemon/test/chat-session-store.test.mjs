import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatCliSessionKey,
  chatCliSessionStorePath,
  clearChatCliSession,
  readChatCliSession,
  readChatCliSessionStore,
  upsertChatCliSession,
} from '@codesurf/daemon/chat-session-store'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

test('chat CLI session store persists and resumes by provider/model/workspace', async t => {
  const homeDir = await makeTestTempDir('chat-cli-session-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const saved = upsertChatCliSession(homeDir, {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    workspaceDir,
    sessionId: 'thread-1',
    jobId: 'job-1',
    lastSequence: 7,
  })

  assert.equal(saved.key, chatCliSessionKey({ provider: 'claude', model: 'claude-sonnet-4-6', workspaceDir }))
  assert.equal(saved.workspaceDir, resolve(workspaceDir))

  const loaded = readChatCliSession(homeDir, {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    workspaceDir,
  })
  assert.equal(loaded?.sessionId, 'thread-1')
  assert.equal(loaded?.jobId, 'job-1')
  assert.equal(loaded?.lastSequence, 7)

  const store = readChatCliSessionStore(homeDir)
  assert.equal(store.activeKey, saved.key)
  assert.deepEqual(Object.keys(store.sessions), [saved.key])

  const fileMode = (await stat(chatCliSessionStorePath(homeDir))).mode & 0o777
  assert.equal(fileMode, 0o600)
})

test('chat CLI session store ignores corrupt files and can clear a session', async t => {
  const homeDir = await makeTestTempDir('chat-cli-session-corrupt-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(dirname(chatCliSessionStorePath(homeDir)), { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await chmod(dirname(chatCliSessionStorePath(homeDir)), 0o700)
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await import('node:fs/promises').then(fs => fs.writeFile(chatCliSessionStorePath(homeDir), 'not json', 'utf8'))
  assert.deepEqual(readChatCliSessionStore(homeDir), { version: 1, activeKey: null, sessions: {} })

  upsertChatCliSession(homeDir, {
    provider: 'codex',
    model: 'gpt-5.5',
    workspaceDir,
    sessionId: 'thread-2',
    jobId: 'job-2',
    lastSequence: 3,
  })
  clearChatCliSession(homeDir, { provider: 'codex', model: 'gpt-5.5', workspaceDir })

  const content = JSON.parse(await readFile(chatCliSessionStorePath(homeDir), 'utf8'))
  assert.equal(content.activeKey, null)
  assert.deepEqual(content.sessions, {})
})
