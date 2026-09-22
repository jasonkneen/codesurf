import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDaemon } from './helpers/spawn-daemon.mjs'

async function startDaemon() {
  return await spawnDaemon({
    homePrefix: 'codesurfd-checkpoints-',
    appVersion: 'checkpoint-test',
  })
}

test('daemon checkpoints reject symlink escapes outside workspace roots', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const projectDir = join(daemon.homeDir, 'project-symlink')
  const outsideDir = join(daemon.homeDir, 'outside-target')
  const outsideFile = join(outsideDir, 'secret.txt')
  const linkDir = join(projectDir, 'linked')

  await mkdir(projectDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(outsideFile, 'outside\n', 'utf8')
  await symlink(outsideDir, linkDir)

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Symlink Workspace',
      projectPath: projectDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-symlink',
      state: {
        provider: 'claude',
        model: 'sonnet',
        sessionId: 'claude-session-symlink',
        messages: [
          { role: 'user', content: 'Try the symlink path.' },
        ],
        executionTarget: 'local',
        jobId: null,
        jobSequence: 0,
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)

  response = await daemon.request('/checkpoint/create', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-symlink',
      label: 'Symlink escape',
      files: [join(linkDir, 'secret.txt')],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.error, /workspace/i)
})

test('daemon checkpoints create, list, and restore runtime session snapshots', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const projectDir = join(daemon.homeDir, 'project-alpha')
  const existingFile = join(projectDir, 'notes.txt')
  const newFile = join(projectDir, 'scratch.txt')
  await mkdir(projectDir, { recursive: true })
  await writeFile(existingFile, 'before checkpoint\n', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Checkpoint Workspace',
      projectPath: projectDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id
  assert.ok(workspaceId)

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-123',
      state: {
        provider: 'claude',
        model: 'sonnet',
        sessionId: 'claude-session-123',
        messages: [
          { role: 'user', content: 'Please edit notes.txt safely.' },
          { role: 'assistant', content: 'I will checkpoint before editing.' },
        ],
        executionTarget: 'local',
        jobId: null,
        jobSequence: 0,
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  response = await daemon.request('/checkpoint/create', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-123',
      label: 'Before editing notes.txt',
      reason: 'tool:Write',
      files: [existingFile, newFile],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.ok(response.payload.checkpoint?.id)
  assert.equal(response.payload.checkpoint.fileCount, 2)
  const checkpointId = response.payload.checkpoint.id

  response = await daemon.request('/checkpoint/list', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-123',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].id, checkpointId)
  assert.equal(response.payload[0].fileCount, 2)
  assert.equal(response.payload[0].sessionEntryId, 'codesurf-runtime:chat-123')

  await writeFile(existingFile, 'after checkpoint\n', 'utf8')
  await writeFile(newFile, 'created after checkpoint\n', 'utf8')

  response = await daemon.request('/checkpoint/restore', {
    body: {
      workspaceId,
      checkpointId,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.filesRestored, 1)
  assert.equal(response.payload.filesDeleted, 1)

  assert.equal(await readFile(existingFile, 'utf8'), 'before checkpoint\n')
  assert.equal(existsSync(newFile), false)

  response = await daemon.request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent('codesurf-runtime:chat-123')}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.checkpoints.count, 1)
  assert.equal(response.payload.checkpoints.latestCheckpointId, checkpointId)
  assert.equal(response.payload.checkpoints.lastRestoredCheckpointId, checkpointId)
  const restoredNotice = response.payload.messages.find(message => Array.isArray(message?.toolBlocks) && message.toolBlocks.some(block => block?.name === 'Checkpoint restored'))
  assert.ok(restoredNotice)

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-123',
      state: {
        provider: 'claude',
        model: 'sonnet',
        sessionId: 'claude-session-123',
        messages: [
          { role: 'user', content: 'Please edit notes.txt safely.' },
          { role: 'assistant', content: 'Checkpoint metadata should survive later upserts.' },
        ],
        executionTarget: 'local',
        jobId: null,
        jobSequence: 1,
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  response = await daemon.request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent('codesurf-runtime:chat-123')}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.checkpoints.count, 1)
  assert.equal(response.payload.checkpoints.latestCheckpointId, checkpointId)
  assert.equal(response.payload.checkpoints.lastRestoredCheckpointId, checkpointId)

  response = await daemon.request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(response.status, 200)
  const restoredRuntimeEntry = response.payload.find(entry => entry.id === 'codesurf-runtime:chat-123')
  assert.ok(restoredRuntimeEntry)
  assert.equal(restoredRuntimeEntry.checkpointCount, 1)
})
