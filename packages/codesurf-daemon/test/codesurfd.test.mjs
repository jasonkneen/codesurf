import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import {
  makeDaemonTestTempDir as makeTestTempDir,
  spawnDaemon,
  spawnManagedChild,
  waitFor,
} from './helpers/spawn-daemon.mjs'

const TEST_MAX_REQUEST_BODY_BYTES = 1024 * 1024
const TEST_DAEMON_ENTRYPOINT_TIMEOUT_MS = 30_000

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'CodeSurf Test',
      GIT_AUTHOR_EMAIL: 'codesurf-test@example.com',
      GIT_COMMITTER_NAME: 'CodeSurf Test',
      GIT_COMMITTER_EMAIL: 'codesurf-test@example.com',
    },
  }).trim()
}

async function startDaemon(options = {}) {
  return await spawnDaemon({
    homePrefix: 'codesurfd-test-',
    appVersion: 'test-suite',
    env: options.env,
  })
}

async function registerChatWorkspace(daemon, projectPath = daemon.homeDir, name = 'Chat Test') {
  const response = await daemon.request('/workspace/create-with-path', {
    body: { name, projectPath },
  })
  assert.equal(response.status, 200)
  assert.equal(typeof response.payload?.id, 'string')
  return response.payload
}

function makeJsonBodyAtSize(name, size) {
  const empty = JSON.stringify({ name, padding: '' })
  const paddingBytes = size - Buffer.byteLength(empty)
  assert.ok(paddingBytes >= 0)
  const body = JSON.stringify({ name, padding: 'x'.repeat(paddingBytes) })
  assert.equal(Buffer.byteLength(body), size)
  return body
}

async function requestChunkedBeforeEnd(daemon, path, chunks) {
  return await new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      request.destroy()
      reject(new Error('Daemon did not reject a chunked oversized body before request end'))
    }, 3_000)
    timeout.unref()
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: daemon.pidInfo.port,
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.pidInfo.token}`,
        'Content-Type': 'application/json',
      },
    }, response => {
      const responseChunks = []
      response.on('data', chunk => responseChunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        settled = true
        clearTimeout(timeout)
        request.end()
        const body = Buffer.concat(responseChunks).toString('utf8')
        resolve({
          status: response.statusCode,
          payload: body.trim() ? JSON.parse(body) : null,
        })
      })
    })
    request.on('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    })

    for (const chunk of chunks) request.write(chunk)
  })
}

async function runDaemonEntrypointOnce(daemon, appVersion) {
  const managed = spawnManagedChild({
    command: process.execPath,
    args: [daemon.daemonEntry],
    env: {
      ...process.env,
      HOME: daemon.homeDir,
      CODESURF_HOME: daemon.homeDir,
      CODESURF_DAEMON_PID_PATH: join(daemon.homeDir, 'daemon', 'pid.json'),
      CODESURF_APP_VERSION: appVersion,
    },
  })
  try {
    return await managed.waitForExit(TEST_DAEMON_ENTRYPOINT_TIMEOUT_MS)
  } catch (error) {
    await managed.stop()
    throw error
  }
}

test('daemon health endpoint requires auth and returns metadata', async t => {
  const daemon = await startDaemon({
    env: {
      NODE_ENV: 'test',
      CODESURF_TEST_SHUTDOWN_DELAY_MS: '350',
    },
  })
  t.after(async () => {
    await daemon.stop()
  })

  const unauth = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/health`)
  assert.equal(unauth.status, 401)

  const { status, payload } = await daemon.request('/health')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.protocolVersion, 1)
  assert.equal(payload.appVersion, 'test-suite')

  const pidPath = join(daemon.homeDir, 'daemon', 'pid.json')
  const lockPath = join(daemon.homeDir, 'daemon', 'daemon.lock')
  daemon.child.kill('SIGTERM')

  const shutdownHealth = await waitFor(async () => {
    try {
      const result = await daemon.request('/health')
      return result.payload?.shuttingDown === true ? result : null
    } catch {
      return null
    }
  })
  assert.equal(shutdownHealth.status, 200)
  assert.equal(shutdownHealth.payload.pid, daemon.pidInfo.pid)
  assert.equal(existsSync(pidPath), true)
  assert.equal(existsSync(lockPath), true)
  assert.equal(Number((await readFile(lockPath, 'utf8')).trim()), daemon.pidInfo.pid)

  await waitFor(() => daemon.child.exitCode !== null || daemon.child.signalCode !== null)
  assert.equal(existsSync(pidPath), false)
  assert.equal(existsSync(lockPath), false)
})

test('daemon serves the chat model catalog itself, whichever host launched it', async t => {
  const daemon = await startDaemon({ env: { NODE_ENV: 'test' } })
  t.after(async () => {
    await daemon.stop()
  })

  const unauth = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/chat/model-catalog`)
  assert.equal(unauth.status, 401)

  const { status, payload } = await daemon.request('/chat/model-catalog')
  assert.equal(status, 200)
  assert.equal(payload.version, 1)
  assert.deepEqual(
    payload.providers.map(p => p.id),
    ['claude', 'codex', 'opencode', 'hermes'],
  )
  for (const provider of payload.providers) {
    assert.ok(provider.models.length > 0, `${provider.id} has models`)
  }
})

test('create-from-folder with activate:false registers a folder without switching the active workspace', async t => {
  const daemon = await startDaemon({ env: { NODE_ENV: 'test' } })
  t.after(async () => {
    await daemon.stop()
  })

  const current = await registerChatWorkspace(daemon, join(daemon.homeDir, 'current-project'), 'Current')
  const folder = join(daemon.homeDir, 'cli-project')
  await mkdir(folder, { recursive: true })

  const first = await daemon.request('/workspace/create-from-folder', { body: { folderPath: folder, activate: false } })
  assert.equal(first.status, 200)
  assert.equal(typeof first.payload?.id, 'string')
  assert.notEqual(first.payload.id, current.id)

  const active = await daemon.request('/workspace/active')
  assert.equal(active.payload?.id ?? active.payload?.workspace?.id, current.id)

  // Registering the same folder again reuses its workspace, still without switching.
  const again = await daemon.request('/workspace/create-from-folder', { body: { folderPath: folder, activate: false } })
  assert.equal(again.payload?.id, first.payload.id)
  const stillActive = await daemon.request('/workspace/active')
  assert.equal(stillActive.payload?.id ?? stillActive.payload?.workspace?.id, current.id)
})

test('daemon startup selectively sweeps stale strict owned attachments', async t => {
  const homeDir = await makeTestTempDir('codesurfd-owned-attachment-sweep-')
  const attachmentDir = join(homeDir, 'chat-attachments')
  await mkdir(attachmentDir, { mode: 0o700 })
  const staleTime = Date.now() - 6 * 60 * 1000
  const stale = join(
    attachmentDir,
    `codesurf-owned-v1-${staleTime}-00000000-0000-4000-8000-000000000000-stale.txt`,
  )
  const ordinary = join(attachmentDir, 'user-owned-note.txt')
  await writeFile(stale, 'STALE\n', { mode: 0o600 })
  await writeFile(ordinary, 'USER\n', { mode: 0o600 })
  const staleDate = new Date(staleTime)
  await utimes(stale, staleDate, staleDate)

  const daemon = await spawnDaemon({ homeDir })
  t.after(async () => {
    await daemon.stop()
  })

  assert.equal(existsSync(stale), false)
  assert.equal(await readFile(ordinary, 'utf8'), 'USER\n')
})

test('daemon owned attachment flag deletes generated bytes but preserves picker files', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })
  const projectDir = join(daemon.homeDir, 'workspace-project')
  const pickedDir = join(daemon.homeDir, 'picked')
  const attachmentDir = join(daemon.homeDir, 'chat-attachments')
  await mkdir(projectDir, { recursive: true })
  await mkdir(pickedDir, { recursive: true })
  await mkdir(attachmentDir, { recursive: true, mode: 0o700 })
  const workspace = await registerChatWorkspace(daemon, projectDir, 'Attachment Workspace')
  const picked = join(pickedDir, 'picked.txt')
  const owned = join(
    attachmentDir,
    `codesurf-owned-v1-${Date.now()}-11111111-1111-4111-8111-111111111111-generated.txt`,
  )
  await writeFile(picked, 'PICKED\n', { mode: 0o600 })
  await writeFile(owned, 'GENERATED\n', { mode: 0o600 })

  const pickedIssue = await daemon.request('/file-references/capabilities/issue', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      paths: [picked],
    },
  })
  assert.equal(pickedIssue.status, 200)
  const ownedIssue = await daemon.request('/file-references/capabilities/issue', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      paths: [owned],
      ownedTemporary: true,
    },
  })
  assert.equal(ownedIssue.status, 200)

  const inspection = await daemon.request('/file-references/capabilities/inspect', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      capabilities: [
        pickedIssue.payload.attachments[0].capability,
        ownedIssue.payload.attachments[0].capability,
      ],
    },
  })
  assert.deepEqual(inspection, { status: 200, payload: { hasAttachments: true } })

  const message = `Attached file capabilities:\n${pickedIssue.payload.attachments[0].capability}\tpicked.txt\n${ownedIssue.payload.attachments[0].capability}\tgenerated.txt`
  const expanded = await daemon.request('/file-references/expand', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      workspaceDir: projectDir,
      message,
    },
  })
  assert.equal(expanded.status, 200)
  assert.match(expanded.payload.contextText, /PICKED/)
  assert.match(expanded.payload.contextText, /GENERATED/)
  assert.equal(await readFile(picked, 'utf8'), 'PICKED\n')
  assert.equal(existsSync(owned), false)
})

test('daemon durable attachment selection routes issue, expand, and revoke', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })
  const projectDir = join(daemon.homeDir, 'selection-workspace')
  const pickedDir = join(daemon.homeDir, 'picked-selections')
  const attachmentDir = join(daemon.homeDir, 'chat-attachments')
  await mkdir(projectDir, { recursive: true })
  await mkdir(pickedDir, { recursive: true })
  await mkdir(attachmentDir, { recursive: true, mode: 0o700 })
  const workspace = await registerChatWorkspace(daemon, projectDir, 'Selection Workspace')
  const picked = join(pickedDir, 'picked.txt')
  const owned = join(
    attachmentDir,
    `codesurf-owned-v1-${Date.now()}-22222222-2222-4222-8222-222222222222-generated.txt`,
  )
  await writeFile(picked, 'DURABLE PICKED\n', { mode: 0o600 })
  await writeFile(owned, 'DURABLE OWNED\n', { mode: 0o600 })

  const pickedIssue = await daemon.request('/file-references/selections/issue', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      paths: [picked],
    },
  })
  assert.equal(pickedIssue.status, 200)
  const pickedSelection = pickedIssue.payload.attachments[0]
  assert.match(pickedSelection.selectionReceipt, /^csr1_/)
  assert.match(pickedSelection.hostCleanupToken, /^hct1_/)
  assert.equal(pickedSelection.displayPath, 'picked.txt')

  const expanded = await daemon.request('/file-references/expand', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      workspaceDir: projectDir,
      message: 'Review the selected file.',
      attachmentSelections: [{ selectionReceipt: pickedSelection.selectionReceipt }],
    },
  })
  assert.equal(expanded.status, 200)
  assert.match(expanded.payload.contextText, /DURABLE PICKED/)
  assert.equal(await readFile(picked, 'utf8'), 'DURABLE PICKED\n')

  const ownedIssue = await daemon.request('/file-references/selections/issue', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      paths: [owned],
      ownedTemporary: true,
    },
  })
  assert.equal(ownedIssue.status, 200)
  const ownedSelection = ownedIssue.payload.attachments[0]
  assert.equal(ownedSelection.ownedTemporary, true)

  const revoked = await daemon.request('/file-references/selections/revoke', {
    body: {
      workspaceId: workspace.id,
      cardId: 'card-a',
      selectionReceipts: [ownedSelection.selectionReceipt],
    },
  })
  assert.deepEqual(revoked, { status: 200, payload: { ok: true, revoked: 1 } })
  assert.equal(existsSync(owned), false)
})

test('daemon child reuse requires a matching configured app version', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const sameVersion = await runDaemonEntrypointOnce(daemon, 'test-suite')
  assert.equal(sameVersion.exitCode, 0)
  assert.equal(sameVersion.stderr, '')

  const mismatchedVersion = await runDaemonEntrypointOnce(daemon, 'next-version')
  assert.equal(mismatchedVersion.exitCode, 0)
  assert.match(mismatchedVersion.stderr, /Another daemon is starting up/)

  const currentPid = await readJson(join(daemon.homeDir, 'daemon', 'pid.json'))
  assert.equal(currentPid.pid, daemon.pidInfo.pid)
})

test('daemon request bodies enforce the 1 MiB limit and deterministic JSON errors', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const exactBody = makeJsonBodyAtSize('Exact limit workspace', TEST_MAX_REQUEST_BODY_BYTES)
  const exact = await daemon.requestRaw('/workspace/create', { body: exactBody })
  assert.equal(exact.status, 200)
  assert.equal(exact.payload.name, 'Exact limit workspace')

  const oversizedBody = makeJsonBodyAtSize('Oversized workspace', TEST_MAX_REQUEST_BODY_BYTES + 1)
  const oversized = await daemon.requestRaw('/workspace/create', { body: oversizedBody })
  assert.equal(oversized.status, 413)
  assert.deepEqual(oversized.payload, {
    error: 'Request body too large',
    code: 'REQUEST_BODY_TOO_LARGE',
    maxBytes: TEST_MAX_REQUEST_BODY_BYTES,
  })

  const malformed = await daemon.requestRaw('/workspace/create', { body: '{"name":' })
  assert.equal(malformed.status, 400)
  assert.deepEqual(malformed.payload, {
    error: 'Malformed JSON request body',
    code: 'INVALID_JSON',
  })

  const empty = await daemon.requestRaw('/session/external/invalidate')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.payload, { ok: true })

  const workspaces = await daemon.request('/workspace/list')
  assert.equal(workspaces.payload.some(workspace => workspace.name === 'Oversized workspace'), false)
})

test('daemon rejects chunked oversized bodies before the request stream ends', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const prefix = Buffer.from('{"name":"Chunked oversized workspace","padding":"')
  const overflow = Buffer.alloc(TEST_MAX_REQUEST_BODY_BYTES + 1 - prefix.byteLength, 'x')
  const response = await requestChunkedBeforeEnd(
    daemon,
    '/workspace/create',
    [prefix, overflow],
  )

  assert.equal(response.status, 413)
  assert.equal(response.payload.code, 'REQUEST_BODY_TOO_LARGE')

  const workspaces = await daemon.request('/workspace/list')
  assert.equal(workspaces.payload.some(workspace => workspace.name === 'Chunked oversized workspace'), false)
})

test('daemon dashboard serves html and query-token auth works', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const unauth = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/dashboard`)
  assert.equal(unauth.status, 401)

  const queryAuth = await fetch(
    `http://127.0.0.1:${daemon.pidInfo.port}/dashboard?token=${encodeURIComponent(daemon.pidInfo.token)}`,
  )
  assert.equal(queryAuth.status, 200)
  const html = await queryAuth.text()
  assert.match(queryAuth.headers.get('content-type') ?? '', /text\/html/)
  assert.match(html, /CodeSurf Daemon Jobs/)
  assert.match(html, /\/dashboard\/api\/jobs/)
})

test('daemon permission routes persist, resolve, replace, and clear grants', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceA = join(daemon.homeDir, 'repos', 'alpha')
  const workspaceB = join(daemon.homeDir, 'repos', 'beta')
  await mkdir(workspaceA, { recursive: true })
  await mkdir(workspaceB, { recursive: true })

  let response = await daemon.request('/permissions')
  assert.equal(response.status, 200)
  assert.equal(response.payload.path, join(daemon.homeDir, 'permissions.json'))
  assert.deepEqual(response.payload.grants, [])

  response = await daemon.request('/permissions/grant', {
    body: {
      provider: 'claude',
      toolName: 'Write',
      action: 'allow',
      scope: 'today',
      workspaceDir: workspaceA,
      title: 'Write file',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.grant.provider, 'claude')
  assert.equal(response.payload.grant.toolName, 'Write')
  assert.equal(response.payload.grant.action, 'allow')
  assert.equal(response.payload.grant.scope, 'today')
  assert.equal(response.payload.grant.workspaceDir, resolve(workspaceA))
  assert.match(response.payload.grant.expiresAt, /^\d{4}-\d{2}-\d{2}T/)

  response = await daemon.request('/permissions/resolve', {
    body: { provider: 'claude', toolName: 'Write', workspaceDir: workspaceA },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.decision, 'allow')
  assert.equal(response.payload.grant.workspaceDir, resolve(workspaceA))

  response = await daemon.request('/permissions/resolve', {
    body: { provider: 'claude', toolName: 'Write', workspaceDir: workspaceB },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.decision, null)
  assert.equal(response.payload.grant, null)

  response = await daemon.request('/permissions/grant', {
    body: {
      provider: 'claude',
      toolName: 'Write',
      action: 'deny',
      workspaceDir: workspaceA,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.grants.length, 1)
  assert.equal(response.payload.grant.action, 'deny')
  assert.equal(response.payload.grant.scope, 'never')

  response = await daemon.request('/permissions/grant', {
    body: {
      provider: 'claude',
      toolName: 'Bash',
      action: 'allow',
      scope: 'forever',
      workspaceDir: null,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.grant.workspaceDir, null)

  response = await daemon.request('/permissions/resolve', {
    body: { provider: 'claude', toolName: 'Bash', workspaceDir: workspaceB },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.decision, 'allow')
  assert.equal(response.payload.grant.workspaceDir, null)

  const store = await readJson(join(daemon.homeDir, 'permissions.json'))
  assert.equal(store.version, 1)
  assert.equal(store.grants.length, 2)

  response = await daemon.request('/permissions/clear', {
    body: { id: response.payload.grant.id },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.grants.length, 1)

  response = await daemon.request('/permissions/clear', {
    body: { all: true },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.grants, [])
})

test('daemon permission routes ignore expired persisted grants', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  await writeJson(join(daemon.homeDir, 'permissions.json'), {
    version: 1,
    grants: [
      {
        id: 'perm-expired',
        provider: 'claude',
        toolName: 'Write',
        action: 'allow',
        scope: 'today',
        workspaceDir: null,
        title: null,
        description: null,
        blockedPath: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:01.000Z',
      },
    ],
  })

  let response = await daemon.request('/permissions')
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.grants, [])

  response = await daemon.request('/permissions/resolve', {
    body: { provider: 'claude', toolName: 'Write', workspaceDir: daemon.homeDir },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.decision, null)
  assert.equal(response.payload.grant, null)
})

test('daemon manages workspace and project lifecycle through persisted json state', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const folderA = join(daemon.homeDir, 'repos', 'alpha')
  const folderB = join(daemon.homeDir, 'repos', 'beta')

  let response = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: folderA },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.name, 'alpha')
  assert.equal(response.payload.path, folderA)
  assert.deepEqual(response.payload.projectPaths, [folderA])

  response = await daemon.request('/workspace/projects')
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].name, 'alpha')
  assert.equal(response.payload[0].path, folderA)

  response = await daemon.request('/workspace/add-project-folder', {
    body: {
      workspaceId: (await daemon.request('/workspace/active')).payload.id,
      folderPath: folderB,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.projectPaths, [folderA, folderB])

  response = await daemon.request('/workspace/projects')
  assert.equal(response.payload.length, 2)
  assert.deepEqual(response.payload.map(project => project.name), ['alpha', 'beta'])

  response = await daemon.request('/workspace/remove-project-folder', {
    body: {
      workspaceId: (await daemon.request('/workspace/active')).payload.id,
      folderPath: folderA,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.projectPaths, [folderB])
  assert.equal(response.payload.path, folderB)

  const workspacesDoc = await readJson(join(daemon.homeDir, 'workspaces', 'workspaces.json'))
  const projectsDoc = await readJson(join(daemon.homeDir, 'projects', 'projects.json'))
  assert.equal(workspacesDoc.workspaces.length, 1)
  assert.equal(projectsDoc.projects.length, 1)
  assert.equal(projectsDoc.projects[0].path, folderB)
})

test('daemon renames projects and creates sibling git worktrees', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const sourceRepo = join(daemon.homeDir, 'repos', 'alpha')
  await mkdir(sourceRepo, { recursive: true })
  git(['init'], sourceRepo)
  await writeFile(join(sourceRepo, 'README.md'), '# Alpha\n', 'utf8')
  git(['add', 'README.md'], sourceRepo)
  git(['commit', '-m', 'initial'], sourceRepo)

  let response = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: sourceRepo },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request('/workspace/projects')
  const sourceProject = response.payload.find(project => project.path === sourceRepo)
  assert.ok(sourceProject)

  response = await daemon.request('/workspace/project/rename', {
    body: {
      projectId: sourceProject.id,
      name: 'Alpha Renamed',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.project.name, 'Alpha Renamed')

  response = await daemon.request('/workspace/project/worktree', {
    body: {
      projectId: sourceProject.id,
      name: 'feature/test-branch',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.branch, 'feature/test-branch')
  assert.equal(response.payload.path, join(daemon.homeDir, 'repos', 'alpha-feature-test-branch'))
  assert.equal(existsSync(join(response.payload.path, '.git')), true)

  const workspace = await daemon.request('/workspace/active')
  assert.equal(workspace.payload.id, workspaceId)
  assert.deepEqual(workspace.payload.projectPaths, [sourceRepo, response.payload.path])

  response = await daemon.request('/workspace/projects')
  const byPath = new Map(response.payload.map(project => [project.path, project]))
  assert.equal(byPath.get(sourceRepo).name, 'Alpha Renamed')
  assert.equal(byPath.get(join(daemon.homeDir, 'repos', 'alpha-feature-test-branch')).name, 'feature/test-branch')
})

test('daemon creates, switches, and deletes workspaces while maintaining the active workspace', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const alpha = await daemon.request('/workspace/create', { body: { name: 'Alpha' } })
  const beta = await daemon.request('/workspace/create-with-path', {
    body: { name: 'Beta', projectPath: join(daemon.homeDir, 'repos', 'beta') },
  })

  assert.equal(alpha.status, 200)
  assert.equal(beta.status, 200)
  assert.equal(beta.payload.name, 'Beta')
  assert.equal(beta.payload.projectPaths.length, 1)

  let active = await daemon.request('/workspace/active')
  assert.equal(active.status, 200)
  assert.equal(active.payload.id, beta.payload.id)

  let switched = await daemon.request('/workspace/set-active', { body: { id: alpha.payload.id } })
  assert.equal(switched.status, 200)
  assert.deepEqual(switched.payload, { ok: true })

  active = await daemon.request('/workspace/active')
  assert.equal(active.payload.id, alpha.payload.id)

  const listed = await daemon.request('/workspace/list')
  assert.equal(listed.status, 200)
  assert.equal(listed.payload.length, 2)

  const deleted = await daemon.request(`/workspace/${encodeURIComponent(alpha.payload.id)}`, {
    method: 'DELETE',
  })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.payload, { ok: true })

  active = await daemon.request('/workspace/active')
  assert.equal(active.payload.id, beta.payload.id)
})

test('daemon manages agent kanban board state in ~/.codesurf storage', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/agent-kanban/board?workspacePath=/tmp/project-alpha')
  assert.equal(response.status, 200)
  assert.equal(response.payload.columns.length, 4)
  assert.equal(response.payload.columns[0].id, 'backlog')

  response = await daemon.request('/agent-kanban/task/create', {
    body: {
      workspacePath: '/tmp/project-alpha',
      prompt: 'Implement daemon-backed kanban task persistence',
      agentId: 'codex',
      baseRef: 'main',
      columnId: 'backlog',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.task.agentId, 'codex')
  const taskId = response.payload.task.id

  response = await daemon.request('/agent-kanban/dependency/add', {
    body: {
      workspacePath: '/tmp/project-alpha',
      fromTaskId: taskId,
      toTaskId: taskId,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)

  response = await daemon.request('/agent-kanban/task/move', {
    body: {
      workspacePath: '/tmp/project-alpha',
      taskId,
      columnId: 'in_progress',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.toColumnId, 'in_progress')

  response = await daemon.request('/agent-kanban/summary?workspacePath=/tmp/project-alpha')
  assert.equal(response.status, 200)
  assert.equal(response.payload.counts.active, 1)
  assert.equal(response.payload.counts.total, 1)

  const boardFile = join(daemon.homeDir, 'agent-kanban', '_tmp_project-alpha.json')
  const boardDoc = await readJson(boardFile)
  assert.equal(boardDoc.columns[1].cards.length, 1)
  assert.equal(boardDoc.columns[1].cards[0].id, taskId)
})

test('daemon lists, reads, and deletes local session state while maintaining summary files', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceId = 'ws-test'
  const tileId = 'alpha'
  const contexDir = join(daemon.homeDir, 'workspaces', workspaceId, '.codesurf')
  const tileStateFile = join(contexDir, `tile-state-${tileId}.json`)
  const summaryFile = join(contexDir, `tile-session-${tileId}.json`)
  const state = {
    sessionId: 'sess-1',
    provider: 'codex',
    model: 'gpt-5.4',
    messages: [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'latest assistant reply' },
    ],
  }

  await writeJson(tileStateFile, state)

  let response = await daemon.request(`/session/local/list?workspaceId=${workspaceId}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].id, `codesurf-tile:tile-state-${tileId}.json`)
  assert.equal(response.payload[0].provider, 'codex')
  assert.equal(response.payload[0].model, 'gpt-5.4')
  assert.equal(response.payload[0].messageCount, 2)
  assert.equal(response.payload[0].lastMessage, 'latest assistant reply')
  assert.equal(response.payload[0].title, 'first message')

  const summaryStat = await stat(summaryFile)
  assert.ok(summaryStat.isFile())

  await writeJson(tileStateFile, {
    ...state,
    messages: [],
  })

  response = await daemon.request(`/session/local/list?workspaceId=${workspaceId}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 0)
  assert.equal(existsSync(summaryFile), false)

  await writeJson(tileStateFile, state)
  response = await daemon.request(`/session/local/list?workspaceId=${workspaceId}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)

  response = await daemon.request(`/session/local/state?workspaceId=${workspaceId}&sessionEntryId=${encodeURIComponent(`codesurf-tile:tile-state-${tileId}.json`)}`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, state)

  response = await daemon.request('/session/local/delete', {
    body: {
      workspaceId,
      sessionEntryId: `codesurf-tile:tile-state-${tileId}.json`,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(tileStateFile), false)
  assert.equal(existsSync(summaryFile), false)
  assert.equal(existsSync(join(contexDir, 'deleted', `tile-state-${tileId}.json`)), true)
})

test('daemon runtime clear is idempotent and removes the authoritative runtime session file', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceId = 'ws-runtime-clear'
  const cardId = 'card-runtime-clear'
  const runtimeFile = join(
    daemon.homeDir,
    'workspaces',
    workspaceId,
    '.codesurf',
    `runtime-session-${cardId}.json`,
  )
  let response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId,
      state: {
        provider: 'codex',
        sessionId: 'session-runtime-clear',
        messages: [{ role: 'user', content: 'persist me briefly' }],
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(existsSync(runtimeFile), true)

  response = await daemon.request('/session/runtime/clear', {
    body: { workspaceId, cardId },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(runtimeFile), false)

  response = await daemon.request('/session/runtime/clear', {
    body: { workspaceId, cardId },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
})

test('daemon hides local tile sessions for tiles no longer present on the canvas', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceId = 'ws-orphaned-tile'
  const liveTileId = 'live-chat'
  const staleTileId = 'stale-chat'
  const contexDir = join(daemon.homeDir, 'workspaces', workspaceId, '.codesurf')
  const liveStateFile = join(contexDir, `tile-state-${liveTileId}.json`)
  const staleStateFile = join(contexDir, `tile-state-${staleTileId}.json`)
  const staleSummaryFile = join(contexDir, `tile-session-${staleTileId}.json`)

  await writeJson(join(contexDir, 'canvas-state.json'), {
    version: 1,
    tiles: [{ id: liveTileId, type: 'chat' }],
  })
  await writeJson(liveStateFile, {
    provider: 'codex',
    messages: [
      { role: 'user', content: 'live session' },
      { role: 'assistant', content: 'still on the canvas' },
    ],
  })
  await writeJson(staleStateFile, {
    provider: 'codex',
    messages: [
      { role: 'user', content: 'stale session' },
      { role: 'assistant', content: 'not on the canvas' },
    ],
  })
  await writeJson(staleSummaryFile, {
    version: 1,
    tileId: staleTileId,
    provider: 'codex',
    title: 'stale session',
    messageCount: 2,
    updatedAt: Date.now(),
  })

  const response = await daemon.request(`/session/local/list?workspaceId=${workspaceId}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].id, `codesurf-tile:tile-state-${liveTileId}.json`)
  assert.equal(response.payload[0].title, 'live session')
  assert.equal(existsSync(staleStateFile), true)
  assert.equal(existsSync(staleSummaryFile), false)
})

test('daemon settings routes round-trip settings and raw json', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/settings')
  assert.equal(response.status, 200)
  assert.equal(typeof response.payload, 'object')

  response = await daemon.request('/settings', {
    body: {
      settings: {
        appearance: 'light',
        linkOpenMode: 'browser-block',
        execution: {
          mode: 'specific-host',
          hostId: 'macmini',
        },
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.appearance, 'light')
  assert.equal(response.payload.linkOpenMode, 'browser-block')
  assert.equal(response.payload.execution.mode, 'specific-host')
  assert.equal(response.payload.execution.hostId, 'macmini')

  response = await daemon.request('/settings/raw')
  assert.equal(response.status, 200)
  assert.match(response.payload.path, /settings\.json$/)
  assert.match(response.payload.content, /"appearance": "light"/)
  assert.match(response.payload.content, /"mode": "specific-host"/)

  response = await daemon.request('/settings/raw', {
    body: {
      json: JSON.stringify({ someFlag: true, nested: { value: 2 } }),
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.settings.someFlag, true)
  assert.equal(response.payload.settings.nested.value, 2)

  response = await daemon.request('/settings/raw', {
    body: { json: '[]' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.error, /Root must be a JSON object/)
})

test('daemon persists execution hosts separately from settings and preserves built-in hosts', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/host/list')
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.map(host => host.id), ['local-runtime', 'local-daemon'])

  response = await daemon.request('/host/upsert', {
    body: {
      host: {
        id: 'macmini',
        type: 'remote-daemon',
        label: 'Mac Mini',
        url: 'https://daemon.example.com',
        authToken: 'secret-token',
        enabled: true,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.map(host => host.id), ['local-runtime', 'local-daemon', 'macmini'])

  let hostsDoc = await readJson(join(daemon.homeDir, 'hosts', 'hosts.json'))
  assert.equal(hostsDoc.hosts.length, 3)
  assert.equal(hostsDoc.hosts[2].label, 'Mac Mini')
  assert.equal(hostsDoc.hosts[2].url, 'https://daemon.example.com')

  response = await daemon.request('/host/upsert', {
    body: {
      host: {
        id: 'macmini',
        type: 'remote-daemon',
        label: 'Mac Mini Updated',
        url: 'https://daemon-2.example.com',
        enabled: false,
      },
    },
  })
  assert.equal(response.status, 200)
  const updated = response.payload.find(host => host.id === 'macmini')
  assert.equal(updated.label, 'Mac Mini Updated')
  assert.equal(updated.enabled, false)
  assert.equal(updated.url, 'https://daemon-2.example.com')

  response = await daemon.request('/host/local-runtime', { method: 'DELETE' })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /cannot be deleted/i)

  response = await daemon.request('/host/macmini', { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.deepEqual(response.payload.hosts.map(host => host.id), ['local-runtime', 'local-daemon'])

  hostsDoc = await readJson(join(daemon.homeDir, 'hosts', 'hosts.json'))
  assert.deepEqual(hostsDoc.hosts.map(host => host.id), ['local-runtime', 'local-daemon'])
})

test('daemon migrates legacy config.json into split workspace, project, and settings files', async t => {
  const homeDir = await makeTestTempDir('codesurfd-legacy-')
  const legacyConfigPath = join(homeDir, 'config.json')
  await writeJson(legacyConfigPath, {
    settings: {
      themeMode: 'dark',
      openLinksIn: 'external',
    },
    activeWorkspaceIndex: 0,
    workspaces: [
      {
        id: 'legacy-ws-1',
        name: 'Legacy Workspace',
        projectPaths: [
          join(homeDir, 'repos', 'one'),
          join(homeDir, 'repos', 'two'),
        ],
      },
    ],
  })

  const daemon = await spawnDaemon({
    homeDir,
    appVersion: 'test-suite',
  })

  t.after(async () => {
    await daemon.stop()
  })

  const response = await daemon.request('/workspace/projects')
  assert.equal(response.status, 200)
  const projects = response.payload
  assert.equal(projects.length, 2)
  assert.deepEqual(projects.map(project => project.name), ['one', 'two'])

  const workspacesDoc = await readJson(join(homeDir, 'workspaces', 'workspaces.json'))
  const projectsDoc = await readJson(join(homeDir, 'projects', 'projects.json'))
  const settingsDoc = await readJson(join(homeDir, 'settings.json'))
  const hostsDoc = await readJson(join(homeDir, 'hosts', 'hosts.json'))
  assert.equal(workspacesDoc.activeWorkspaceId, 'legacy-ws-1')
  assert.equal(workspacesDoc.workspaces.length, 1)
  assert.equal(projectsDoc.projects.length, 2)
  assert.equal(settingsDoc.settings.themeMode, 'dark')
  assert.equal(settingsDoc.settings.openLinksIn, 'external')
  assert.deepEqual(hostsDoc.hosts.map(host => host.id), ['local-runtime', 'local-daemon'])
})

test('daemon chat jobs persist detached background mode in job metadata', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspace = await registerChatWorkspace(daemon)
  const response = await daemon.request('/chat/job/start', {
    body: {
      request: {
        cardId: 'chat-1',
        workspaceId: workspace.id,
        provider: 'unsupported-provider',
        model: 'test-model',
        runMode: 'background',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'Do this in the background' },
        ],
      },
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.runMode, 'background')
  assert.equal(response.payload.status, 'running')

  const completed = await waitFor(async () => {
    const current = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(response.payload.id)}`)
    return current.payload?.status === 'failed' ? current.payload : null
  }, 5_000, 50)

  assert.equal(completed.runMode, 'background')
  assert.match(String(completed.error ?? ''), /only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway/i)
})

test('daemon lists external CodeSurf sessions and invalidates the external-session cache route', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspacePath = join(daemon.homeDir, 'repos', 'gamma')
  const projectSessionPath = join(workspacePath, '.codesurf', 'sessions', 'project-chat.json')
  const userSessionPath = join(daemon.homeDir, 'sessions', 'user-chat.json')

  await writeJson(projectSessionPath, {
    sessionId: 'project-session',
    provider: 'claude',
    model: 'sonnet',
    messages: [
      { role: 'assistant', content: 'project level session' },
    ],
  })
  await writeJson(userSessionPath, {
    sessionId: 'user-session',
    provider: 'codex',
    model: 'gpt-5.4',
    title: 'User Chat',
    messages: [
      { role: 'assistant', content: 'user level session' },
    ],
  })

  let response = await daemon.request(`/session/external/list?workspacePath=${encodeURIComponent(workspacePath)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 2)
  const byId = new Map(response.payload.map(entry => [entry.sessionId, entry]))
  assert.equal(byId.get('project-session').scope, 'project')
  assert.equal(byId.get('project-session').projectPath, workspacePath)
  assert.equal(byId.get('user-session').scope, 'user')
  assert.equal(byId.get('user-session').title, 'User Chat')

  response = await daemon.request(`/session/external/state?workspacePath=${encodeURIComponent(workspacePath)}&sessionEntryId=${encodeURIComponent(byId.get('project-session').id)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.provider, 'claude')
  assert.equal(response.payload.model, 'sonnet')
  assert.equal(response.payload.sessionId, 'project-session')
  assert.equal(response.payload.messages.length, 1)
  assert.equal(response.payload.messages[0].content, 'project level session')

  response = await daemon.request('/session/external/invalidate', {
    body: { workspacePath },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })

  response = await daemon.request(`/session/external/list?workspacePath=${encodeURIComponent(workspacePath)}&force=1`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 2)

  response = await daemon.request('/session/external/delete', {
    body: {
      workspacePath,
      sessionEntryId: byId.get('project-session').id,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(projectSessionPath), false)
  assert.equal(existsSync(join(workspacePath, '.codesurf', 'sessions', 'deleted', 'project-chat.json')), true)
})

test('daemon refreshes cached external transcript state when the source file changes', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const transcriptPath = join(daemon.homeDir, '.claude', 'transcripts', 'cached-refresh.jsonl')
  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(transcriptPath, `${JSON.stringify({
    type: 'user',
    content: 'initial prompt',
    timestamp: '2026-04-21T12:00:00.000Z',
  })}\n`, 'utf8')

  let response = await daemon.request('/session/external/list')
  assert.equal(response.status, 200)
  const entry = response.payload.find(item => item.id === `claude:${transcriptPath}`)
  assert.ok(entry)

  response = await daemon.request(`/session/external/state?sessionEntryId=${encodeURIComponent(entry.id)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.messages.length, 1)
  assert.equal(response.payload.messages[0].content, 'initial prompt')

  await new Promise(resolve => setTimeout(resolve, 25))
  await writeFile(transcriptPath, `${JSON.stringify({
    type: 'user',
    content: 'updated prompt',
    timestamp: '2026-04-21T12:00:01.000Z',
  })}\n`, 'utf8')

  response = await daemon.request(`/session/external/state?sessionEntryId=${encodeURIComponent(entry.id)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.messages.length, 1)
  assert.equal(response.payload.messages[0].content, 'updated prompt')
})

test('daemon trims oversized Claude transcripts to recent history for faster loading', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const transcriptPath = join(daemon.homeDir, '.claude', 'transcripts', 'huge-session.jsonl')
  await mkdir(dirname(transcriptPath), { recursive: true })

  const filler = 'x'.repeat(800)
  const lines = Array.from({ length: 9000 }, (_, index) => JSON.stringify({
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 0 ? 'first prompt' : index === 8999 ? 'latest reply' : `line-${index}-${filler}`,
    timestamp: `2026-04-21T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
  }))
  await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8')

  let response = await daemon.request('/session/external/list')
  assert.equal(response.status, 200)
  const entry = response.payload.find(item => item.id === `claude:${transcriptPath}`)
  assert.ok(entry)

  response = await daemon.request(`/session/external/state?sessionEntryId=${encodeURIComponent(entry.id)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.provider, 'claude')
  assert.equal(response.payload.messages[0].content, 'first prompt')
  assert.match(response.payload.messages[1].content, /trimmed for faster loading/i)
  assert.equal(response.payload.messages.at(-1).content, 'latest reply')
  assert.ok(response.payload.messages.length < 9000)
})

test('daemon validates local session route inputs', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/session/local/list')
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /workspaceId is required/)

  response = await daemon.request('/session/local/delete', {
    body: { workspaceId: 'ws-only' },
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /workspaceId and sessionEntryId are required/)

  response = await daemon.request('/session/local/delete', {
    body: {
      workspaceId: 'ws-only',
      sessionEntryId: 'codesurf-tile:tile-state-missing.json',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.error, /Session file missing/)
})

test('daemon validates chat job route inputs', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/chat/job/start', {
    body: {},
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /request is required/)

  response = await daemon.request('/chat/job/state')
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /jobId is required/)

  response = await daemon.request('/chat/job/cancel', {
    body: {},
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /jobId is required/)

  response = await daemon.request('/chat/job/state?jobId=missing-job')
  assert.equal(response.status, 404)
  assert.match(response.payload.error, /Job not found/)
})

test('daemon runs a persisted chat job timeline and replays events for completed jobs', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspace = await registerChatWorkspace(daemon)
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        workspaceId: workspace.id,
        provider: 'unsupported-provider',
        model: 'test-model',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test daemon execution' },
        ],
      },
    },
  })
  assert.equal(start.status, 200)
  assert.equal(typeof start.payload.id, 'string')
  assert.equal(start.payload.taskLabel, 'test daemon execution')
  const jobId = start.payload.id

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.id, jobId)
  assert.equal(state.payload.status, 'failed')
  assert.match(state.payload.error, /only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway/i)

  const timelineResponse = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/chat/job/events?jobId=${encodeURIComponent(jobId)}&since=0`, {
    headers: {
      Authorization: `Bearer ${daemon.pidInfo.token}`,
    },
  })
  assert.equal(timelineResponse.status, 200)
  const rawTimeline = await timelineResponse.text()
  const replayedEvents = rawTimeline
    .split(/\n\n+/)
    .map(chunk => chunk
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line))

  assert.ok(replayedEvents.length >= 2)
  assert.equal(state.payload.lastSequence, replayedEvents.at(-1)?.sequence)

  const workspaceInstructionSummary = replayedEvents.find(event => event.type === 'tool_summary' && event.toolName === 'Workspace Instructions')
  assert.ok(workspaceInstructionSummary)

  const errorEvent = replayedEvents.at(-2)
  assert.equal(errorEvent?.jobId, jobId)
  assert.equal(errorEvent?.type, 'error')
  assert.match(errorEvent?.error ?? '', /only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway/i)

  const doneEvent = replayedEvents.at(-1)
  assert.equal(doneEvent?.jobId, jobId)
  assert.equal(doneEvent?.type, 'done')

  const timelineFile = join(daemon.homeDir, 'timelines', `${jobId}.jsonl`)
  const metadataFile = join(daemon.homeDir, 'jobs', `${jobId}.json`)
  assert.equal(existsSync(timelineFile), true)
  assert.equal(existsSync(metadataFile), true)
})

test('daemon codex jobs ignore benign stderr and still complete successfully', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-bin-')
  const fakeCodexPath = join(fakeBinDir, 'codex')
  await writeFile(fakeCodexPath, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-test"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"TEST OK"}}'
printf '%s\n' 'Reading additional input from stdin...' >&2
exit 0
`, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const workspace = await registerChatWorkspace(daemon)
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        workspaceId: workspace.id,
        provider: 'codex',
        model: 'gpt-5.4',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test daemon execution' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  assert.equal(start.payload.taskLabel, 'test daemon execution')

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'completed')
  assert.equal(state.payload.error, null)
  assert.equal(state.payload.sessionId, 'thread-test')

  const timelineFile = join(daemon.homeDir, 'timelines', `${jobId}.jsonl`)
  const rawTimeline = await readFile(timelineFile, 'utf8')
  assert.match(rawTimeline, /"type":"session"/)
  assert.match(rawTimeline, /"type":"text","text":"TEST OK"/)
  assert.match(rawTimeline, /"type":"done"/)
  assert.doesNotMatch(rawTimeline, /Reading additional input from stdin/)
})

test('daemon hermes jobs run through hermes chat with split provider/model args', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-hermes-bin-')
  const fakeHermesPath = join(fakeBinDir, 'hermes')
  await writeFile(fakeHermesPath, `#!/bin/sh
set -eu
if [ "\${1:-}" != "chat" ]; then
  printf '%s\n' "expected hermes chat" >&2
  exit 2
fi
shift
model=""
provider=""
source=""
toolsets=""
stream_json=0
query_seen=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --query)
      query_seen=1
      shift 2
      ;;
    --quiet|--stream-json)
      stream_json=1
      shift
      ;;
    --source)
      source="$2"
      shift 2
      ;;
    --model)
      model="$2"
      shift 2
      ;;
    --provider)
      provider="$2"
      shift 2
      ;;
    --toolsets)
      toolsets="$2"
      shift 2
      ;;
    --resume)
      shift 2
      ;;
    --ignore-rules|--yolo)
      shift
      ;;
    *)
      printf '%s\n' "unexpected arg: $1" >&2
      exit 3
      ;;
  esac
done
if [ "$query_seen" != "1" ] || [ "$stream_json" != "1" ] || [ "$source" != "tool" ]; then
  printf '%s\n' "missing hermes programmatic chat flags" >&2
  exit 4
fi
if [ "$provider" != "openai-codex" ] || [ "$model" != "gpt-5.5" ]; then
  printf '%s\n' "expected split openai-codex/gpt-5.5 got provider=$provider model=$model" >&2
  exit 5
fi
if [ "$toolsets" != "terminal,file" ]; then
  printf '%s\n' "expected terminal,file toolsets got $toolsets" >&2
  exit 6
fi
printf '%s\n' '{"type":"session","sessionId":"hermes-session-test"}'
printf '%s\n' '{"type":"text","text":"HERMES OK"}'
exit 0
`, 'utf8')
  await chmod(fakeHermesPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const workspace = await registerChatWorkspace(daemon)
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        workspaceId: workspace.id,
        provider: 'hermes',
        model: 'openai-codex/gpt-5.5',
        mode: 'terminal',
        cardId: 'chat-hermes-daemon',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test hermes daemon execution' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  assert.equal(start.payload.taskLabel, 'test hermes daemon execution')

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'completed')
  assert.equal(state.payload.error, null)
  assert.equal(state.payload.sessionId, 'hermes-session-test')

  const rawTimeline = await readFile(join(daemon.homeDir, 'timelines', `${jobId}.jsonl`), 'utf8')
  assert.match(rawTimeline, /"type":"session","sessionId":"hermes-session-test"/)
  assert.match(rawTimeline, /"type":"text","text":"HERMES OK"/)
  assert.match(rawTimeline, /"type":"done"/)
  assert.doesNotMatch(rawTimeline, /only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway/i)
})

test('daemon hermes failures sanitize credential-looking diagnostics', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-hermes-fail-bin-')
  const fakeHermesPath = join(fakeBinDir, 'hermes')
  await writeFile(fakeHermesPath, `#!/bin/sh
printf '%s\n' 'HERMES_API_KEY=sk-test-secret' >&2
printf '%s\n' 'Authorization: Bearer raw-secret-token' >&2
printf '%s\n' 'TOKEN=stdout-secret'
exit 7
`, 'utf8')
  await chmod(fakeHermesPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const workspace = await registerChatWorkspace(daemon)
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        workspaceId: workspace.id,
        provider: 'hermes',
        model: 'openai-codex/gpt-5.5',
        mode: 'terminal',
        cardId: 'chat-hermes-daemon-failure',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test hermes daemon failure sanitization' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'failed')
  assert.match(state.payload.error, /HERMES_API_KEY=\[REDACTED\]/)
  assert.match(state.payload.error, /Authorization: Bearer \[REDACTED\]/i)
  assert.doesNotMatch(state.payload.error, /sk-test-secret|raw-secret-token|stdout-secret/)

  const rawTimeline = await readFile(join(daemon.homeDir, 'timelines', `${jobId}.jsonl`), 'utf8')
  assert.match(rawTimeline, /"type":"error"/)
  assert.doesNotMatch(rawTimeline, /sk-test-secret|raw-secret-token|stdout-secret/)
})

test('daemon opencode jobs run through opencode run json output', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-opencode-bin-')
  const fakeOpenCodePath = join(fakeBinDir, 'opencode')
  await writeFile(fakeOpenCodePath, `#!/bin/sh
set -eu
if [ "\${1:-}" != "run" ]; then
  printf '%s\n' "expected opencode run" >&2
  exit 2
fi
has_format=0
has_json=0
for arg in "$@"; do
  if [ "$arg" = "--format" ]; then has_format=1; fi
  if [ "$arg" = "json" ]; then has_json=1; fi
done
if [ "$has_format" != "1" ] || [ "$has_json" != "1" ]; then
  printf '%s\n' "expected --format json" >&2
  exit 3
fi
printf '%s\n' '{"type":"session","sessionID":"opencode-session-test"}'
printf '%s\n' '{"type":"message","role":"assistant","content":[{"type":"text","text":"OPENCODE OK"}]}'
exit 0
`, 'utf8')
  await chmod(fakeOpenCodePath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const workspace = await registerChatWorkspace(daemon)
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        workspaceId: workspace.id,
        provider: 'opencode',
        model: 'anthropic/claude-sonnet-4-6',
        cardId: 'chat-opencode-daemon',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test opencode daemon execution' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  assert.equal(start.payload.taskLabel, 'test opencode daemon execution')

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'completed')
  assert.equal(state.payload.error, null)
  assert.equal(state.payload.sessionId, 'opencode-session-test')

  const rawTimeline = await readFile(join(daemon.homeDir, 'timelines', `${jobId}.jsonl`), 'utf8')
  assert.match(rawTimeline, /"type":"session","sessionId":"opencode-session-test"/)
  assert.match(rawTimeline, /"type":"text","text":"OPENCODE OK"/)
  assert.match(rawTimeline, /"type":"done"/)
  assert.doesNotMatch(rawTimeline, /only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway/i)
})

test('daemon codex file changes create restorable checkpoint with daemon-local workspace roots', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-bin-checkpoint-')
  const fakeCodexPath = join(fakeBinDir, 'codex')
  await writeFile(fakeCodexPath, `#!/bin/sh
set -eu
workspace=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then
    workspace="$arg"
    break
  fi
  prev="$arg"
done
if [ -n "$workspace" ]; then
  cd "$workspace"
fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-checkpoint"}'
printf '%s\n' '{"type":"item.started","item":{"type":"file_change","changes":[{"path":"notes.txt","kind":"update"}]}}'
sleep 0.2
printf '%s\n' 'after daemon codex' > notes.txt
printf '%s\n' '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"notes.txt","kind":"update"}]}}'
exit 0
`, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const projectDir = join(daemon.homeDir, 'repos', 'checkpoint-project')
  const targetFile = join(projectDir, 'notes.txt')
  await mkdir(projectDir, { recursive: true })
  await writeFile(targetFile, 'before daemon codex\n', 'utf8')

  let response = null
  const workspaceId = (await registerChatWorkspace(
    daemon,
    projectDir,
    'Remote checkpoint workspace',
  )).id
  const cardId = 'chat-codex-checkpoint'
  const sessionEntryId = `codesurf-runtime:${cardId}`

  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        cardId,
        workspaceId,
        provider: 'codex',
        model: 'gpt-5.4',
        workspaceDir: projectDir,
        messages: [
          { role: 'user', content: 'edit notes.txt' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'completed')
  assert.equal(await readFile(targetFile, 'utf8'), 'after daemon codex\n')

  response = await daemon.request('/checkpoint/list', {
    body: {
      workspaceId,
      sessionEntryId,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].fileCount, 1)
  assert.deepEqual(response.payload[0].files, ['notes.txt'])
  const checkpointId = response.payload[0].id

  const timelineFile = join(daemon.homeDir, 'timelines', `${jobId}.jsonl`)
  const rawTimeline = await readFile(timelineFile, 'utf8')
  assert.match(rawTimeline, /"toolName":"Checkpoint saved"/)
  assert.match(rawTimeline, /"toolName":"Edited 1 file"/)

  response = await daemon.request('/checkpoint/restore', {
    body: {
      workspaceId,
      checkpointId,
      sessionEntryId,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(await readFile(targetFile, 'utf8'), 'before daemon codex\n')
})

test('daemon codex file changes abort when checkpoint paths are missing', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-bin-checkpoint-missing-path-')
  const fakeCodexPath = join(fakeBinDir, 'codex')
  await writeFile(fakeCodexPath, `#!/bin/sh
set -eu
workspace=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then
    workspace="$arg"
    break
  fi
  prev="$arg"
done
if [ -n "$workspace" ]; then
  cd "$workspace"
fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-missing-path"}'
printf '%s\n' '{"type":"item.started","item":{"type":"file_change","changes":[{"kind":"update"}]}}'
sleep 0.2
printf '%s\n' 'unsafe write should not happen' > notes.txt
exit 0
`, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const projectDir = join(daemon.homeDir, 'repos', 'checkpoint-missing-path-project')
  const targetFile = join(projectDir, 'notes.txt')
  await mkdir(projectDir, { recursive: true })
  await writeFile(targetFile, 'before missing path\n', 'utf8')

  const workspaceId = (await registerChatWorkspace(
    daemon,
    projectDir,
    'Remote missing-path workspace',
  )).id
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        cardId: 'chat-codex-missing-path',
        workspaceId,
        provider: 'codex',
        model: 'gpt-5.4',
        workspaceDir: projectDir,
        messages: [
          { role: 'user', content: 'edit notes.txt without a path' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    if (next.status === 404) return null
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'failed')
  assert.match(state.payload.error, /no checkpointable file paths/i)
  assert.equal(await readFile(targetFile, 'utf8'), 'before missing path\n')

  const rawTimeline = await readFile(join(daemon.homeDir, 'timelines', `${jobId}.jsonl`), 'utf8')
  assert.match(rawTimeline, /Checkpoint creation failed before Codex file change/)
  assert.doesNotMatch(rawTimeline, /"toolName":"Edited 1 file"/)
})

test('daemon dashboard job endpoints return recorded jobs and timelines', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-dashboard-bin-')
  const fakeCodexPath = join(fakeBinDir, 'codex')
  await writeFile(fakeCodexPath, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-dashboard"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"DASHBOARD OK"}}'
exit 0
`, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const workspace = await registerChatWorkspace(daemon)
  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        workspaceId: workspace.id,
        provider: 'codex',
        model: 'gpt-5.4',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'dashboard inspection test' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  assert.equal(start.payload.taskLabel, 'dashboard inspection test')

  await waitFor(async () => {
    const state = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    return state.payload?.status === 'completed' ? state : null
  })

  const jobsResponse = await daemon.request('/dashboard/api/jobs')
  assert.equal(jobsResponse.status, 200)
  assert.equal(Array.isArray(jobsResponse.payload.jobs), true)
  assert.equal(jobsResponse.payload.summary.total > 0, true)
  assert.equal(jobsResponse.payload.daemon.appVersion, 'test-suite')
  assert.equal(jobsResponse.payload.jobs.some(job => job.id === jobId), true)
  assert.equal(
    jobsResponse.payload.jobs.some(job => job.id === jobId && job.taskLabel === 'dashboard inspection test'),
    true,
  )

  const detailResponse = await daemon.request(`/dashboard/api/job?jobId=${encodeURIComponent(jobId)}`)
  assert.equal(detailResponse.status, 200)
  assert.equal(detailResponse.payload.job.id, jobId)
  assert.equal(detailResponse.payload.job.taskLabel, 'dashboard inspection test')
  assert.equal(detailResponse.payload.job.status, 'completed')
  assert.equal(Array.isArray(detailResponse.payload.timeline), true)
  assert.equal(detailResponse.payload.timeline.some(event => event.type === 'text' && event.text === 'DASHBOARD OK'), true)

  const htmlResponse = await daemon.requestText('/dashboard')
  assert.equal(htmlResponse.status, 200)
  assert.match(htmlResponse.body, /CodeSurf Daemon Jobs/)
  assert.match(htmlResponse.body, /refreshAll\(\)/)
})

test('GET /personas/list returns built-ins + agents.json overlay, never the discovered-* set', async t => {
  const daemon = await startDaemon()
  t.after(async () => { await daemon.stop() })

  // Auth required.
  const unauth = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/personas/list`)
  assert.equal(unauth.status, 401)

  // No workspace → built-ins only.
  const builtins = await daemon.request('/personas/list')
  assert.equal(builtins.status, 200)
  const builtinIds = builtins.payload.personas.map(p => p.id)
  for (const id of ['agent', 'ask', 'plan', 'polly', 'gemma']) {
    assert.ok(builtinIds.includes(id), `built-ins must include ${id}`)
  }
  assert.ok(!builtinIds.some(id => String(id).startsWith('discovered-')), 'no discovered-* in built-ins')

  // With a workspace whose agents.json adds a custom persona, overrides a built-in,
  // and contains an ephemeral discovered-* entry.
  const workspaceDir = join(daemon.homeDir, 'repos', 'personas-ws')
  await mkdir(join(workspaceDir, '.codesurf', 'customisation'), { recursive: true })
  await writeFile(
    join(workspaceDir, '.codesurf', 'customisation', 'agents.json'),
    JSON.stringify([
      { id: 'custom-y', name: 'Custom Y', description: 'c', tools: ['Read'], isBuiltin: false },
      { id: 'ask', name: 'Ask Overridden', tools: ['Read'], isBuiltin: true },
      { id: 'discovered-abc', name: 'Ephemeral', tools: [], isBuiltin: false },
    ]),
    'utf8',
  )

  const overlaid = await daemon.request(`/personas/list?workspaceDir=${encodeURIComponent(workspaceDir)}`)
  assert.equal(overlaid.status, 200)
  const overlaidById = new Map(overlaid.payload.personas.map(p => [p.id, p]))
  assert.ok(overlaidById.has('custom-y'), 'overlay includes the custom persona')
  assert.equal(overlaidById.get('ask')?.name, 'Ask Overridden', 'overlay applies a built-in override')
  assert.ok(!overlaid.payload.personas.some(p => String(p.id).startsWith('discovered-')), 'the discovered-* set must never be listed')
})

test('card SSE requires auth and cardId, flushes headers immediately and stays idle-open', async t => {
  const daemon = await startDaemon()
  t.after(() => daemon.stop())
  const missing = await daemon.request('/chat/card/events')
  assert.equal(missing.status, 400)
  const unauthorized = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/chat/card/events?cardId=card`)
  assert.equal(unauthorized.status, 401)
  await unauthorized.text()
  await new Promise((resolve, reject) => {
    let response
    const timeout = setTimeout(() => {
      request.destroy()
      reject(new Error('Card SSE headers did not flush immediately'))
    }, 2_000)
    const request = httpRequest({
      hostname: '127.0.0.1', port: daemon.pidInfo.port,
      path: '/chat/card/events?cardId=idle-card',
      headers: { Authorization: `Bearer ${daemon.pidInfo.token}` },
    }, incoming => {
      response = incoming
      try {
        assert.equal(incoming.statusCode, 200)
        assert.match(incoming.headers['content-type'], /text\/event-stream/)
        assert.equal(incoming.headers['x-accel-buffering'], 'no')
      } catch (error) {
        clearTimeout(timeout)
        request.destroy()
        reject(error)
        return
      }
      incoming.resume()
      setTimeout(() => {
        clearTimeout(timeout)
        try {
          assert.equal(response.complete, false)
          request.destroy()
          resolve()
        } catch (error) { request.destroy(); reject(error) }
      }, 50)
    })
    request.on('error', error => { clearTimeout(timeout); reject(error) })
    request.end()
  })
})
