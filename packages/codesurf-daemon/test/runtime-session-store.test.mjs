import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDaemon } from './helpers/spawn-daemon.mjs'

async function startDaemon() {
  return await spawnDaemon({
    homePrefix: 'codesurfd-runtime-session-',
    appVersion: 'runtime-session-test',
  })
}

test('daemon runtime session store upserts, lists, reads, and deletes local chat sessions', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceId = 'ws-runtime'
  const workspaceDir = join(daemon.homeDir, 'workspaces', workspaceId)
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await writeFile(join(daemon.homeDir, 'workspaces.json'), JSON.stringify({
    workspaces: [{ id: workspaceId, name: 'Runtime', path: workspaceDir }],
    activeWorkspaceId: workspaceId,
  }, null, 2))

  const state = {
    provider: 'claude',
    model: 'sonnet',
    sessionId: 'claude-session-123',
    messages: [
      { role: 'user', content: 'Build a daemon-owned session store.' },
      { role: 'assistant', content: 'Sure — I can do that.' },
    ],
    executionTarget: 'local',
    jobId: null,
    jobSequence: 0,
    isStreaming: false,
  }

  let response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-123',
      state,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  response = await daemon.request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(response.status, 200)
  const runtimeEntry = response.payload.find(entry => entry.id === 'codesurf-runtime:chat-123')
  assert.ok(runtimeEntry)
  assert.equal(runtimeEntry.provider, 'claude')
  assert.equal(runtimeEntry.model, 'sonnet')
  assert.equal(runtimeEntry.sessionId, 'claude-session-123')
  assert.equal(runtimeEntry.messageCount, 2)
  assert.match(runtimeEntry.lastMessage, /sure/i)

  response = await daemon.request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent('codesurf-runtime:chat-123')}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.provider, 'claude')
  assert.equal(response.payload.model, 'sonnet')
  assert.equal(response.payload.sessionId, 'claude-session-123')
  assert.equal(response.payload.messages.length, 2)

  response = await daemon.request('/session/local/delete', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-123',
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(join(workspaceDir, '.codesurf', 'runtime-session-chat-123.json')), false)
  assert.equal(existsSync(join(workspaceDir, '.codesurf', 'deleted', 'runtime-session-chat-123.json')), true)
})
