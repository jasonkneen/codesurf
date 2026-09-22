import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { spawnDaemon, waitFor } from './helpers/spawn-daemon.mjs'

function chatRequest(overrides = {}) {
  return {
    cardId: 'policy-card',
    provider: 'unsupported-provider',
    model: 'configured-model',
    messages: [{ role: 'user', content: 'policy boundary test' }],
    ...overrides,
  }
}

async function waitForFailedJob(daemon, jobId) {
  return await waitFor(async () => {
    const response = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    return response.payload?.status === 'failed' ? response.payload : null
  }, 5_000, 25)
}

test('real daemon chat boundary canonicalizes workspaces and discards caller persona objects', async t => {
  const daemon = await spawnDaemon({ homePrefix: 'chat-policy-boundary-' })
  t.after(async () => { await daemon.stop() })

  const workspaceRoot = join(daemon.homeDir, 'repos', 'trusted')
  const otherRoot = join(daemon.homeDir, 'repos', 'other')
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(otherRoot, { recursive: true })
  const created = await daemon.request('/workspace/create-with-path', {
    body: { name: 'Trusted', projectPath: workspaceRoot },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id

  let response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceDir: otherRoot,
      }),
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'CHAT_WORKSPACE_REQUIRED')

  response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId: 'missing-workspace',
        workspaceDir: workspaceRoot,
      }),
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'CHAT_WORKSPACE_UNKNOWN')

  response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId,
        workspaceDir: otherRoot,
      }),
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'CHAT_WORKSPACE_MISMATCH')

  response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId,
        projectContext: {
          workspaceDir: otherRoot,
          gitRemoteUrl: 'https://attacker.invalid/injected.git',
          gitBranch: 'injected',
        },
        memoryPrompt: 'CALLER-MEMORY-INJECTION',
        contextBuckets: { inspect: { summary: 'CALLER-CONTEXT-INJECTION' } },
        skillsPrompt: 'CALLER-SKILLS-INJECTION',
        skillsSummary: 'CALLER-SKILLS-SUMMARY-INJECTION',
        roomContext: 'CALLER-ROOM-INJECTION',
        roomAckSequence: 999,
        contextPrompt: 'CALLER-COMPOSED-INJECTION',
        fileReferencePrompt: 'CALLER-FILE-INJECTION',
      }),
    },
  })
  assert.equal(response.status, 200)
  const canonicalJob = await waitForFailedJob(daemon, response.payload.id)
  assert.equal(canonicalJob.workspaceDir, resolve(workspaceRoot))
  const canonicalTimeline = await readFile(
    join(daemon.homeDir, 'timelines', `${response.payload.id}.jsonl`),
    'utf8',
  )
  assert.doesNotMatch(
    canonicalTimeline,
    /CALLER-(?:MEMORY|CONTEXT|SKILLS|ROOM|COMPOSED|FILE)/,
    'daemon-owned prompt sections must be rebuilt instead of trusting caller text',
  )

  // A renderer-supplied restricted object with no selected id is data only. If
  // the daemon trusted it, this unsupported backend would be rejected by the
  // persona enforcement gate instead of creating the job.
  response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId,
        agentMode: {
          id: 'ask',
          name: 'Spoofed Ask',
          systemPrompt: 'spoofed',
          tools: ['Read'],
        },
      }),
    },
  })
  assert.equal(response.status, 200)
  await waitForFailedJob(daemon, response.payload.id)

  // Conversely, a selected Ask persona remains read-only even when the caller
  // supplies a forged unrestricted object. An unsupported backend must fail
  // before a provider process can launch.
  response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId,
        provider: 'opencode',
        agentId: 'ask',
        agentMode: {
          id: 'agent',
          name: 'Forged Agent',
          systemPrompt: '',
          tools: null,
        },
      }),
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'CHAT_PERSONA_PROVIDER_UNSUPPORTED')

  const fileRoot = join(daemon.homeDir, 'repos', 'not-a-directory')
  await writeFile(fileRoot, 'not a workspace directory')
  const fileWorkspace = await daemon.request('/workspace/create-with-path', {
    body: { name: 'File root', projectPath: fileRoot },
  })
  assert.equal(fileWorkspace.status, 200)
  response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId: fileWorkspace.payload.id,
        workspaceDir: fileRoot,
      }),
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'CHAT_WORKSPACE_UNKNOWN')
})

test('real daemon chat boundary rejects malformed authoritative persona files', async t => {
  const daemon = await spawnDaemon({ homePrefix: 'chat-policy-persona-' })
  t.after(async () => { await daemon.stop() })

  const workspaceRoot = join(daemon.homeDir, 'repos', 'persona')
  await mkdir(join(workspaceRoot, '.codesurf', 'customisation'), { recursive: true })
  const created = await daemon.request('/workspace/create-with-path', {
    body: { name: 'Persona', projectPath: workspaceRoot },
  })
  assert.equal(created.status, 200)

  await writeFile(
    join(workspaceRoot, '.codesurf', 'customisation', 'agents.json'),
    JSON.stringify([
      {
        id: 'reader',
        name: 'Reader',
        description: '',
        systemPrompt: 'read',
        tools: 'Read',
        icon: 'help',
        color: '#123456',
        isBuiltin: false,
      },
    ]),
  )

  const response = await daemon.request('/chat/job/start', {
    body: {
      request: chatRequest({
        workspaceId: created.payload.id,
        agentId: 'reader',
        agentMode: { id: 'reader', tools: null },
      }),
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.payload.code, 'CHAT_PERSONA_DENIED')
  assert.match(response.payload.error, /could not be verified/i)
})
