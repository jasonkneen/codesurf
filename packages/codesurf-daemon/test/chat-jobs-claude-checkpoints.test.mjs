import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

async function readTimeline(homeDir, jobId) {
  return (await readFile(join(homeDir, 'timelines', `${jobId}.jsonl`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('daemon Claude bypass mode still creates a checkpoint before allowing Write', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-checkpoint-')
  const workspaceDir = join(homeDir, 'workspace')
  const targetFile = join(workspaceDir, 'notes.txt')
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(targetFile, 'before claude write\n', 'utf8')
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const checkpointCalls = []
  const checkpointStore = {
    createCheckpoint(workspaceId, sessionEntryId, options) {
      const file = options.files[0]
      checkpointCalls.push({
        workspaceId,
        sessionEntryId,
        files: options.files,
        workspaceRoots: options.workspaceRoots,
        reason: options.reason,
        source: options.source,
        metadata: options.metadata,
        snapshot: existsSync(file) ? readFileSyncUtf8(file) : null,
      })
      return {
        ok: true,
        checkpoint: {
          id: 'checkpoint-claude-write',
        },
      }
    },
  }

  const manager = createChatJobManager({
    homeDir,
    checkpointStore,
    claudeQuery: ({ prompt, options }) => (async function* () {
      assert.equal(prompt, 'write notes')
      assert.equal(options.permissionMode, 'bypassPermissions')
      assert.equal(options.allowDangerouslySkipPermissions, true)
      assert.equal(typeof options.canUseTool, 'function')

      const decision = await options.canUseTool('Write', { file_path: 'notes.txt', content: 'after claude write\n' }, { toolUseID: 'toolu-write' })
      assert.equal(decision.behavior, 'allow')
      await writeFile(targetFile, 'after claude write\n', 'utf8')
      yield {
        type: 'result',
        result: 'done',
        session_id: 'claude-thread-write',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-checkpoint',
    workspaceId: 'remote-claude-checkpoint-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [
      { role: 'user', content: 'write notes' },
    ],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.error, null)
  assert.equal(completed.sessionId, 'claude-thread-write')
  assert.equal(await readFile(targetFile, 'utf8'), 'after claude write\n')

  assert.equal(checkpointCalls.length, 1)
  assert.equal(checkpointCalls[0].workspaceId, 'remote-claude-checkpoint-workspace')
  assert.equal(checkpointCalls[0].sessionEntryId, 'codesurf-runtime:chat-claude-checkpoint')
  assert.deepEqual(checkpointCalls[0].files, [targetFile])
  assert.deepEqual(checkpointCalls[0].workspaceRoots, [workspaceDir])
  assert.equal(checkpointCalls[0].reason, 'tool:Write')
  assert.equal(checkpointCalls[0].source, 'daemon-chat-job')
  assert.equal(checkpointCalls[0].metadata.toolName, 'Write')
  assert.equal(checkpointCalls[0].metadata.toolUseID, 'toolu-write')
  assert.equal(checkpointCalls[0].snapshot, 'before claude write\n')

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'tool_start' && event.toolName === 'Checkpoint saved'), true)
  assert.equal(timeline.some(event => event.type === 'tool_summary' && event.toolName === 'Checkpoint saved' && /before Write/.test(event.text)), true)
})

test('daemon Claude foreground jobs ask for tool permission and persist scoped approvals', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-permission-prompt-')
  const workspaceDir = join(homeDir, 'workspace')
  const targetFile = join(workspaceDir, 'notes.txt')
  await mkdir(workspaceDir, { recursive: true })
  if (process.platform !== 'win32') await chmod(homeDir, 0o755)
  await writeFile(targetFile, 'before prompt write\n', 'utf8')
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const manager = createChatJobManager({
    homeDir,
    checkpointStore: {
      createCheckpoint() {
        return { ok: true, checkpoint: { id: 'checkpoint-after-permission' } }
      },
    },
    claudeQuery: ({ options }) => (async function* () {
      assert.equal(options.permissionMode, 'default')
      const decision = await options.canUseTool('Write', { file_path: 'notes.txt', content: 'after prompt write\n' }, { toolUseID: 'toolu-prompt-write' })
      assert.equal(decision.behavior, 'allow')
      await writeFile(targetFile, 'after prompt write\n', 'utf8')
      yield {
        type: 'result',
        result: 'done',
        session_id: 'claude-thread-permission-prompt',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-permission-prompt',
    workspaceId: 'remote-claude-permission-prompt-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'default',
    workspaceDir,
    messages: [
      { role: 'user', content: 'write notes with prompt' },
    ],
  })

  await waitFor(async () => {
    const timeline = await readTimeline(homeDir, job.id).catch(() => [])
    return timeline.find(event => event.type === 'tool_permission_request')
  })

  assert.deepEqual(manager.answerToolPermission(job.id, 'toolu-prompt-write', 'today'), { ok: true })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(await readFile(targetFile, 'utf8'), 'after prompt write\n')

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'tool_permission_request' && event.toolName === 'Write'), true)
  assert.equal(timeline.some(event => event.type === 'tool_permission_resolved' && event.decision === 'today'), true)

  const permissionsFile = join(homeDir, 'permissions.json')
  const permissionStore = JSON.parse(await readFile(permissionsFile, 'utf8'))
  assert.equal(permissionStore.grants.length, 1)
  assert.equal(permissionStore.grants[0].provider, 'claude')
  assert.equal(permissionStore.grants[0].toolName, 'Write')
  assert.equal(permissionStore.grants[0].action, 'allow')
  assert.equal(permissionStore.grants[0].scope, 'today')
  assert.equal(permissionStore.grants[0].workspaceDir, workspaceDir)
  if (process.platform !== 'win32') {
    assert.equal((await stat(homeDir)).mode & 0o777, 0o700)
    assert.equal((await stat(permissionsFile)).mode & 0o777, 0o600)
  }
})

test('daemon Claude grant-only mode denies ungranted tools without prompting', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-grant-only-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const manager = createChatJobManager({
    homeDir,
    checkpointStore: {
      createCheckpoint() {
        return { ok: true, checkpoint: { id: 'checkpoint-should-not-run' } }
      },
    },
    claudeQuery: ({ options }) => (async function* () {
      assert.equal(options.permissionMode, 'default')
      const decision = await options.canUseTool('Write', { file_path: 'notes.txt', content: 'after\n' }, { toolUseID: 'toolu-grant-only-write' })
      assert.equal(decision.behavior, 'deny')
      assert.match(decision.message, /Permission required for Write/)
      yield {
        type: 'result',
        result: 'denied',
        session_id: 'claude-thread-grant-only',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-grant-only',
    workspaceId: 'remote-claude-grant-only-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'dontAsk',
    workspaceDir,
    messages: [
      { role: 'user', content: 'write notes without a stored grant' },
    ],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'tool_permission_request'), false)
  assert.equal(timeline.some(event => event.type === 'tool_start' && event.toolName === 'Checkpoint saved'), false)
})

test('daemon Claude workspace jobs honor persisted global permission grants', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-global-permission-')
  const workspaceDir = join(homeDir, 'workspace')
  const targetFile = join(workspaceDir, 'notes.txt')
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(targetFile, 'before global grant write\n', 'utf8')
  await writeFile(join(homeDir, 'permissions.json'), `${JSON.stringify({
    version: 1,
    grants: [
      {
        id: 'perm-global-write',
        provider: 'claude',
        toolName: 'Write',
        action: 'allow',
        scope: 'forever',
        workspaceDir: null,
        title: null,
        description: null,
        blockedPath: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      },
    ],
  }, null, 2)}\n`, 'utf8')
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const manager = createChatJobManager({
    homeDir,
    checkpointStore: {
      createCheckpoint() {
        return { ok: true, checkpoint: { id: 'checkpoint-global-permission' } }
      },
    },
    claudeQuery: ({ options }) => (async function* () {
      const decision = await options.canUseTool('Write', { file_path: 'notes.txt', content: 'after global grant write\n' }, { toolUseID: 'toolu-global-write' })
      assert.equal(decision.behavior, 'allow')
      await writeFile(targetFile, 'after global grant write\n', 'utf8')
      yield {
        type: 'result',
        result: 'done',
        session_id: 'claude-thread-global-permission',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-global-permission',
    workspaceId: 'remote-claude-global-permission-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'default',
    workspaceDir,
    messages: [
      { role: 'user', content: 'write notes with global grant' },
    ],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(await readFile(targetFile, 'utf8'), 'after global grant write\n')

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'tool_permission_request'), false)
  assert.equal(timeline.some(event => event.type === 'tool_start' && event.toolName === 'Checkpoint saved'), true)
})

test('daemon Claude denies a risky Write when no checkpointable file path is provided', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-checkpoint-missing-path-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  let checkpointCalls = 0
  const manager = createChatJobManager({
    homeDir,
    checkpointStore: {
      createCheckpoint() {
        checkpointCalls += 1
        return { ok: true, checkpoint: { id: 'checkpoint-should-not-exist' } }
      },
    },
    claudeQuery: ({ options }) => (async function* () {
      const decision = await options.canUseTool('Write', { content: 'no path\n' }, { toolUseID: 'toolu-missing-path' })
      assert.equal(decision.behavior, 'deny')
      assert.match(decision.message, /no checkpointable file path/i)
      yield {
        type: 'result',
        result: 'denied',
        session_id: 'claude-thread-missing-path',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-missing-path',
    workspaceId: 'remote-claude-missing-path-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [
      { role: 'user', content: 'write without path' },
    ],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error, /no checkpointable file path/i)
  assert.equal(checkpointCalls, 0)

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'error' && /Checkpoint creation failed before Write/.test(event.error)), true)
  assert.equal(timeline.some(event => event.type === 'tool_start' && event.toolName === 'Checkpoint saved'), false)
})

test('daemon Claude denies a risky edit when checkpoint creation fails', async t => {
  const homeDir = await makeTestTempDir('chat-jobs-claude-checkpoint-failure-')
  const workspaceDir = join(homeDir, 'workspace')
  const targetFile = join(workspaceDir, 'notes.txt')
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(targetFile, 'before failed claude edit\n', 'utf8')
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const manager = createChatJobManager({
    homeDir,
    checkpointStore: {
      createCheckpoint() {
        return { ok: false, error: 'synthetic checkpoint failure' }
      },
    },
    claudeQuery: ({ options }) => (async function* () {
      const decision = await options.canUseTool('Edit', {
        file_path: 'notes.txt',
        old_string: 'before failed claude edit',
        new_string: 'after failed claude edit',
      }, { toolUseID: 'toolu-edit' })
      assert.equal(decision.behavior, 'deny')
      assert.match(decision.message, /synthetic checkpoint failure/)
      yield {
        type: 'result',
        result: 'denied',
        session_id: 'claude-thread-denied',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })

  const job = await manager.startJob({
    cardId: 'chat-claude-checkpoint-failure',
    workspaceId: 'remote-claude-checkpoint-failure-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [
      { role: 'user', content: 'edit notes' },
    ],
  })

  const completed = await waitForCompletedJob(manager, job.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error, /synthetic checkpoint failure/)
  assert.equal(await readFile(targetFile, 'utf8'), 'before failed claude edit\n')

  const timeline = await readTimeline(homeDir, job.id)
  assert.equal(timeline.some(event => event.type === 'error' && /Checkpoint creation failed before Edit/.test(event.error)), true)
  assert.equal(timeline.some(event => event.type === 'tool_start' && event.toolName === 'Checkpoint saved'), false)
})

function readFileSyncUtf8(filePath) {
  return String(readFileSync(filePath, 'utf8'))
}
