import { describe, it, before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  assertNoSymlinkPath,
  projectRegistryPath,
} from '../../scripts/web-host.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOST_PORT = 18477
const HOST = `http://127.0.0.1:${HOST_PORT}`
const HOST_TOKEN = 'web-host-route-test-token-which-is-long-enough'
const hostHeaders = { 'X-Codesurf-Host': HOST_TOKEN }

test('web-host trust helpers use the canonical registry and reject canonical path escapes', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codesurf-webhost-trust-'))
  const projectRoot = join(fixtureRoot, 'project')
  const outsideRoot = join(fixtureRoot, 'outside')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(outsideRoot, { recursive: true })
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  assert.equal(
    projectRegistryPath(join(fixtureRoot, 'home')),
    join(fixtureRoot, 'home', 'projects', 'projects.json'),
  )
  assert.doesNotThrow(() => assertNoSymlinkPath(projectRoot, join(projectRoot, 'new', 'file.txt')))

  const escape = join(projectRoot, 'escape')
  symlinkSync(outsideRoot, escape, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(
    () => assertNoSymlinkPath(projectRoot, join(escape, 'secret.txt')),
    /symlink|junction|escape/i,
  )
})

describe('web-host routes', () => {
  let child
  let home
  let projectRoot
  let outsideRoot
  let runtimeConfigPath

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'codesurf-webhost-'))
    projectRoot = join(home, 'registered-project')
    outsideRoot = mkdtempSync(join(tmpdir(), 'codesurf-webhost-outside-'))
    runtimeConfigPath = join(home, 'runtime-config.json')
    mkdirSync(join(home, 'daemon'), { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(join(home, 'projects'), { recursive: true })
    writeFileSync(
      join(home, 'projects', 'projects.json'),
      JSON.stringify({ projects: [{ id: 'registered-project', path: projectRoot }] }),
      'utf8',
    )
    // Minimal fake daemon pid so ensureDaemon can fail health and spawn real daemon —
    // for unit test we only need /health which doesn't require daemon.
    // Start web-host with isolated home; it will try to start real codesurfd.
    child = spawn(process.execPath, [resolve(root, 'scripts/web-host.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CODESURF_HOME: home,
        CODESURF_WEB_HOST_PORT: String(HOST_PORT),
        CODESURF_WEB_HOST_TOKEN: HOST_TOKEN,
        CODESURF_RUNTIME_CONFIG_PATH: runtimeConfigPath,
        CODESURF_APP_VERSION: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const start = Date.now()
    let lastErr
    while (Date.now() - start < 30_000) {
      try {
        const res = await fetch(`${HOST}/health`)
        if (res.ok) return
      } catch (err) {
        lastErr = err
      }
      await new Promise(r => setTimeout(r, 200))
    }
    const stderr = child.stderr?.read?.()?.toString?.() || ''
    throw new Error(`web-host failed to start: ${lastErr}\n${stderr}`)
  })

  after(async () => {
    if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      try { await once(child, 'exit') } catch { /* ignore */ }
    }
    try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(outsideRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('serves /health', async () => {
    const res = await fetch(`${HOST}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.service, 'codesurf-web-host')
  })

  it('serves /host/health with capability info', async () => {
    const res = await fetch(`${HOST}/host/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.host, 'codesurf-web-host')
    assert.ok(body.daemon)
    assert.equal('home' in body, false)
    assert.equal('port' in body, false)
  })

  it('requires the per-launch host token for stateful routes', async () => {
    const denied = await fetch(`${HOST}/host/config`)
    assert.equal(denied.status, 401)

    const allowed = await fetch(`${HOST}/host/config`, { headers: hostHeaders })
    assert.equal(allowed.status, 200)
    const body = await allowed.json()
    assert.equal(body.capabilities.workspace, true)
  })

  it('writes the Native runtime configuration with the bound host and token', () => {
    const runtime = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'))
    assert.equal(runtime.hostBase, HOST)
    assert.equal(runtime.hostToken, HOST_TOKEN)
    assert.deepEqual(runtime.terminal, { endpoint: null, token: null })
  })

  it('allows only explicit browser origins', async () => {
    const denied = await fetch(`${HOST}/host/config`, {
      headers: { ...hostHeaders, Origin: 'https://attacker.example' },
    })
    assert.equal(denied.status, 403)

    const allowed = await fetch(`${HOST}/host/config`, {
      headers: { ...hostHeaders, Origin: 'http://127.0.0.1:5173' },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')

    const preflight = await fetch(`${HOST}/host/config`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-codesurf-host',
      },
    })
    assert.equal(preflight.status, 204)
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Codesurf-Host/i)
  })

  it('round-trips settings', async () => {
    const payload = { theme: 'dark', testKey: 'web-host' }
    const put = await fetch(`${HOST}/host/settings`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(put.status, 200)
    const get = await fetch(`${HOST}/host/settings`, { headers: hostHeaders })
    const body = await get.json()
    assert.equal(body.theme, 'dark')
    assert.equal(body.testKey, 'web-host')
  })

  it('round-trips canvas state', async () => {
    const workspaceId = 'ws-test-1'
    const state = { tiles: [{ id: 't1', x: 0, y: 0 }], zoom: 1 }
    const put = await fetch(`${HOST}/host/canvas/save`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, state }),
    })
    assert.equal(put.status, 200)
    const get = await fetch(`${HOST}/host/canvas/load?workspaceId=${workspaceId}`, { headers: hostHeaders })
    const body = await get.json()
    assert.equal(body.zoom, 1)
    assert.equal(body.tiles[0].id, 't1')
  })

  it('does not expose arbitrary filesystem paths', async () => {
    const res = await fetch(`${HOST}/host/fs/readFile?path=${encodeURIComponent('/etc/passwd')}`, {
      headers: hostHeaders,
    })
    assert.equal(res.status, 403)
  })

  it('round-trips the exact layout-template UI state path without exposing CodeSurf secrets', async () => {
    const compatibilityPath = '~/.codesurf/layout-templates.json'
    const missing = await fetch(
      `${HOST}/host/fs/stat?path=${encodeURIComponent(compatibilityPath)}`,
      { headers: hostHeaders },
    )
    assert.equal(missing.status, 200)
    assert.equal(await missing.json(), null)

    const content = JSON.stringify({ templates: [{ id: 'test-layout' }] })
    const write = await fetch(`${HOST}/host/fs/writeFile`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: compatibilityPath, content }),
    })
    assert.equal(write.status, 200)

    const read = await fetch(
      `${HOST}/host/fs/readFile?path=${encodeURIComponent(compatibilityPath)}`,
      { headers: hostHeaders },
    )
    assert.equal(read.status, 200)
    assert.deepEqual(await read.json(), { content, missing: false })

    const sensitive = await fetch(
      `${HOST}/host/fs/readFile?path=${encodeURIComponent('~/.codesurf/daemon/pid.json')}`,
      { headers: hostHeaders },
    )
    assert.equal(sensitive.status, 403)
  })

  it('creates, writes, and reads files under a canonically registered project', async () => {
    const createdDir = join(projectRoot, 'created-by-web-host')
    const createdFile = join(createdDir, 'round-trip.txt')
    const mkdir = await fetch(`${HOST}/host/fs/mkdir`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: createdDir }),
    })
    assert.equal(mkdir.status, 200, await mkdir.text())

    const content = 'registered project round trip'
    const write = await fetch(`${HOST}/host/fs/writeFile`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: createdFile, content }),
    })
    assert.equal(write.status, 200, await write.text())

    const read = await fetch(
      `${HOST}/host/fs/readFile?path=${encodeURIComponent(createdFile)}`,
      { headers: hostHeaders },
    )
    assert.equal(read.status, 200)
    assert.deepEqual(await read.json(), { content, missing: false })
  })

  it('rejects collab tile and nested-directory symlink or junction escapes', async () => {
    const codesurfDir = join(projectRoot, '.codesurf')
    mkdirSync(codesurfDir, { recursive: true })

    const escapedTile = join(codesurfDir, 'escaped-tile')
    symlinkSync(outsideRoot, escapedTile, process.platform === 'win32' ? 'junction' : 'dir')
    const ensureEscapedTile = await fetch(`${HOST}/host/collab/ensureDir`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: projectRoot, tileId: 'escaped-tile' }),
    })
    assert.equal(ensureEscapedTile.status, 400)
    assert.match((await ensureEscapedTile.json()).error, /symlink|junction|escape/i)
    assert.equal(existsSync(join(outsideRoot, 'context')), false)

    const ensureSafeTile = await fetch(`${HOST}/host/collab/ensureDir`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: projectRoot, tileId: 'safe-tile' }),
    })
    assert.equal(ensureSafeTile.status, 200, await ensureSafeTile.text())

    writeFileSync(join(outsideRoot, 'secret.txt'), 'outside secret', 'utf8')
    const nestedEscape = join(codesurfDir, 'safe-tile', 'messages', 'escape')
    symlinkSync(outsideRoot, nestedEscape, process.platform === 'win32' ? 'junction' : 'dir')

    const escapedRead = await fetch(`${HOST}/host/collab/read`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspacePath: projectRoot,
        tileId: 'safe-tile',
        file: 'messages/escape/secret.txt',
      }),
    })
    assert.equal(escapedRead.status, 400)
    assert.match((await escapedRead.json()).error, /symlink|junction|escape/i)

    const escapedWrite = await fetch(`${HOST}/host/collab/write`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspacePath: projectRoot,
        tileId: 'safe-tile',
        file: 'messages/escape/created.txt',
        content: 'must stay contained',
      }),
    })
    assert.equal(escapedWrite.status, 400)
    assert.match((await escapedWrite.json()).error, /symlink|junction|escape/i)
    assert.equal(existsSync(join(outsideRoot, 'created.txt')), false)
  })

  it('does not turn the daemon bearer into a generic browser proxy', async () => {
    const res = await fetch(`${HOST}/d/host/list`, { headers: hostHeaders })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /not available to web clients/i)
  })

  it('does not expose host-only attachment capability issuance to browsers', async () => {
    const res = await fetch(`${HOST}/d/file-references/capabilities/issue`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-test-1',
        cardId: 'card-forged',
        paths: ['/etc/hosts'],
      }),
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /not available to web clients/i)
  })
})
