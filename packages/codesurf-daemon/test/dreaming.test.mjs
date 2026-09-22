import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDaemon, waitFor } from './helpers/spawn-daemon.mjs'

async function startDaemon(options = {}) {
  return await spawnDaemon({
    homePrefix: 'codesurfd-dreaming-test-',
    appVersion: 'dreaming-test-suite',
    env: options.env,
  })
}

test('memory loader includes workspace DREAMING.md for local execution but excludes it from cloud bundles', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'repos', 'dream-alpha')
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await writeFile(join(workspaceDir, '.codesurf', 'DREAMING.md'), '# Dream Memory\n\nRemember the daemon-owned dream context.\n', 'utf8')

  const created = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: workspaceDir },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id

  const local = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(local.status, 200)
  assert.match(local.payload.prompt ?? '', /Dream Memory/)
  assert.ok((local.payload.sections ?? []).some(section => String(section.displayPath ?? '').endsWith('.codesurf/DREAMING.md')))

  const cloud = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=cloud`)
  assert.equal(cloud.status, 200)
  assert.doesNotMatch(cloud.payload.prompt ?? '', /Dream Memory/)
  assert.ok(!(cloud.payload.includedBuckets ?? []).includes('local-only'))
  const dreamingBucket = (cloud.payload.contextBuckets?.buckets ?? []).find(bucket => bucket.bucket === 'local-only')
  assert.equal(dreamingBucket?.included, false)
})

test('daemon dreaming run writes generated workspace memory and reports status/runs', async t => {
  const daemon = await startDaemon({
    env: {
      CODESURF_DREAMING_TEST_MODE: 'stub',
      CODESURF_DREAMING_TEST_RESULT: '# Dreaming\n\n- Durable memory written from recent sessions.\n- Keep daemon ownership explicit.\n',
    },
  })
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'repos', 'dream-beta')
  await mkdir(join(workspaceDir, '.codesurf', 'sessions'), { recursive: true })
  await writeFile(join(workspaceDir, '.codesurf', 'sessions', 'session-1.json'), JSON.stringify({
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    sessionId: 'session-1',
    messages: [
      { role: 'user', content: 'Investigate daemon-owned memory consolidation.', timestamp: Date.now() - 2_000 },
      { role: 'assistant', content: 'I will review recent sessions and propose durable memory.', timestamp: Date.now() - 1_000 },
    ],
  }, null, 2), 'utf8')

  const created = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: workspaceDir },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id

  const started = await daemon.request('/dreaming/run', {
    body: { workspaceId },
  })
  assert.equal(started.status, 200)
  assert.equal(typeof started.payload.run?.id, 'string')

  const settled = await waitFor(async () => {
    const response = await daemon.request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    if (response.status !== 200) return null
    return response.payload?.running === false && response.payload?.lastRun?.status === 'completed' ? response : null
  }, 8_000, 100)

  assert.equal(settled.payload.lastRun.status, 'completed')
  assert.equal(settled.payload.lastRun.workspaceId, workspaceId)
  assert.ok(settled.payload.lastRun.sessionsReviewed >= 1)

  const dreamingPath = join(workspaceDir, '.codesurf', 'DREAMING.md')
  assert.equal(existsSync(dreamingPath), true)
  const dreamingContent = await readFile(dreamingPath, 'utf8')
  assert.match(dreamingContent, /Durable memory written from recent sessions/)

  const runs = await daemon.request(`/dreaming/runs?workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(runs.status, 200)
  assert.ok(Array.isArray(runs.payload.runs))
  assert.equal(runs.payload.runs[0]?.id, started.payload.run.id)

  const memory = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(memory.status, 200)
  assert.match(memory.payload.prompt ?? '', /Durable memory written from recent sessions/)
})

test('auto dreaming waits for the session threshold before triggering from runtime session updates', async t => {
  const daemon = await startDaemon({
    env: {
      CODESURF_DREAMING_TEST_MODE: 'stub',
      CODESURF_DREAMING_TEST_RESULT: '# Auto Dreaming\n\n- Triggered after thresholded runtime activity.\n',
      CODESURF_AUTO_DREAM_MIN_SESSIONS: '2',
      CODESURF_AUTO_DREAM_MIN_INTERVAL_MS: '0',
      CODESURF_AUTO_DREAM_DEBOUNCE_MS: '50',
      CODESURF_AUTO_DREAM_SWEEP_MS: '0',
    },
  })
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'repos', 'dream-runtime-threshold')
  const created = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: workspaceDir },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id
  const dreamingPath = join(workspaceDir, '.codesurf', 'DREAMING.md')

  let response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-one',
      state: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        sessionId: 'runtime-1',
        messages: [
          { role: 'user', content: 'First runtime session for auto dream threshold.' },
          { role: 'assistant', content: 'Still waiting for enough recent sessions.' },
        ],
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(existsSync(dreamingPath), false)

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-two',
      state: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        sessionId: 'runtime-2',
        messages: [
          { role: 'user', content: 'Second runtime session should cross the dream threshold.' },
          { role: 'assistant', content: 'Now the daemon should auto-trigger dreaming.' },
        ],
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  const settled = await waitFor(async () => {
    const status = await daemon.request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    if (status.status !== 200) return null
    return status.payload?.running === false && status.payload?.lastRun?.status === 'completed' ? status : null
  }, 8_000, 100)

  assert.equal(existsSync(dreamingPath), true)
  assert.equal(settled.payload.lastRun.sessionsReviewed >= 2, true)
  const dreamingContent = await readFile(dreamingPath, 'utf8')
  assert.match(dreamingContent, /thresholded runtime activity/)
})

test('auto dreaming follows persisted settings and exposes policy in status', async t => {
  const daemon = await startDaemon({
    env: {
      CODESURF_DREAMING_TEST_MODE: 'stub',
      CODESURF_DREAMING_TEST_RESULT: '# Disabled Dreaming\n\n- This should not be written while persisted auto-dream is disabled.\n',
      CODESURF_AUTO_DREAM_MIN_SESSIONS: '1',
      CODESURF_AUTO_DREAM_MIN_INTERVAL_MS: '0',
      CODESURF_AUTO_DREAM_DEBOUNCE_MS: '25',
      CODESURF_AUTO_DREAM_SWEEP_MS: '0',
    },
  })
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'repos', 'dream-disabled-by-settings')
  const created = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: workspaceDir },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id
  const dreamingPath = join(workspaceDir, '.codesurf', 'DREAMING.md')

  const saved = await daemon.request('/settings', {
    body: {
      settings: {
        autoDream: {
          enabled: false,
          minSessions: 1,
          minIntervalMs: 0,
          debounceMs: 25,
          sweepMs: 0,
        },
      },
    },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.autoDream.enabled, false)

  const response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-disabled',
      state: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        sessionId: 'runtime-disabled',
        messages: [
          { role: 'user', content: 'This session would trigger env-only auto dreaming.' },
          { role: 'assistant', content: 'Persisted settings should keep auto-dream disabled.' },
        ],
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(existsSync(dreamingPath), false)

  const status = await daemon.request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(status.status, 200)
  assert.equal(status.payload.auto.enabled, false)
  assert.equal(status.payload.auto.minSessions, 1)
})

test('daemon dashboard summary includes active workspace dreaming status', async t => {
  const daemon = await startDaemon({
    env: {
      CODESURF_DREAMING_TEST_MODE: 'stub',
      CODESURF_DREAMING_TEST_RESULT: '# Dashboard Dreaming\n\n- Visible in the daemon summary surface.\n',
      CODESURF_AUTO_DREAM_MIN_SESSIONS: '1',
      CODESURF_AUTO_DREAM_MIN_INTERVAL_MS: '0',
      CODESURF_AUTO_DREAM_DEBOUNCE_MS: '25',
      CODESURF_AUTO_DREAM_SWEEP_MS: '0',
    },
  })
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'repos', 'dream-dashboard-summary')
  const created = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: workspaceDir },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id

  const response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-dashboard',
      state: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        sessionId: 'runtime-dashboard',
        messages: [
          { role: 'user', content: 'Dashboard should show active workspace dream status.' },
          { role: 'assistant', content: 'The daemon summary should expose last dream metadata.' },
        ],
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  await waitFor(async () => {
    const status = await daemon.request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    return status.payload?.lastRun?.status === 'completed' ? status : null
  }, 8_000, 100)

  const dashboard = await daemon.request('/dashboard/api/jobs')
  assert.equal(dashboard.status, 200)
  assert.equal(dashboard.payload.dreaming.workspaceId, workspaceId)
  assert.equal(dashboard.payload.dreaming.auto.enabled, true)
  assert.equal(dashboard.payload.dreaming.lastRun.status, 'completed')
  assert.match(dashboard.payload.dreaming.lastRun.summary ?? '', /Visible in the daemon summary surface/)
})

test('auto dreaming periodic sweep picks up new external workspace sessions written outside daemon routes', async t => {
  const daemon = await startDaemon({
    env: {
      CODESURF_DREAMING_TEST_MODE: 'stub',
      CODESURF_DREAMING_TEST_RESULT: '# Sweep Dreaming\n\n- Triggered by periodic workspace scan.\n',
      CODESURF_AUTO_DREAM_MIN_SESSIONS: '1',
      CODESURF_AUTO_DREAM_MIN_INTERVAL_MS: '0',
      CODESURF_AUTO_DREAM_DEBOUNCE_MS: '25',
      CODESURF_AUTO_DREAM_SWEEP_MS: '100',
    },
  })
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'repos', 'dream-sweep')
  const created = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: workspaceDir },
  })
  assert.equal(created.status, 200)
  const workspaceId = created.payload.id

  const dreamingPath = join(workspaceDir, '.codesurf', 'DREAMING.md')
  assert.equal(existsSync(dreamingPath), false)

  await mkdir(join(workspaceDir, '.codesurf', 'sessions'), { recursive: true })
  await writeFile(join(workspaceDir, '.codesurf', 'sessions', 'external-auto.json'), JSON.stringify({
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    sessionId: 'external-auto',
    messages: [
      { role: 'user', content: 'External session landed after workspace creation.' },
      { role: 'assistant', content: 'Periodic auto dreaming should notice this without a direct daemon route.' },
    ],
  }, null, 2), 'utf8')

  const settled = await waitFor(async () => {
    const status = await daemon.request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    if (status.status !== 200) return null
    return status.payload?.running === false && status.payload?.lastRun?.status === 'completed' ? status : null
  }, 8_000, 100)

  assert.equal(existsSync(dreamingPath), true)
  assert.equal(settled.payload.lastRun.sessionsReviewed >= 1, true)
  const dreamingContent = await readFile(dreamingPath, 'utf8')
  assert.match(dreamingContent, /periodic workspace scan/)
})
