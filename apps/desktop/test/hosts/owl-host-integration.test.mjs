// Integration test for the OWL Electron host process.
//
// Spawns dist-electron/main/index.js inside the real electron binary with
// CODESURF_OWL_HOST=1, then drives it via stdio JSON-RPC and asserts on
// responses for the documented method surface (health, session.create,
// profile.create, webview.create/navigate/capture/destroy, plugin.list).
//
// Requires a prior `npm run build:main` (or full `npm run build`) so the
// bundle exists. The test fails fast with a clear hint if it's missing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stopTestChild, trackTestChild } from '../helpers/child-process-shutdown.mjs'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(__filename), '../..')
const builtMain = resolve(projectRoot, 'dist-electron/main/index.js')
const electronBin = resolve(projectRoot, 'node_modules/.bin/electron')

function preflight() {
  if (!existsSync(builtMain)) {
    throw new Error(
      `dist-electron/main/index.js not found — run \`npm run build:main\` first.`
    )
  }
  if (!existsSync(electronBin)) {
    throw new Error(`node_modules/.bin/electron not found — \`npm install\` first.`)
  }
}

// Minimal JSON-RPC client over a child stdio pair.
class StdioClient {
  constructor(child, { killProcessGroup = false } = {}) {
    this.child = child
    this.killProcessGroup = killProcessGroup
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderr = ''
    this.exitError = null
    trackTestChild(child)
    child.stdout.setEncoding('utf8')
    this.onStdout = chunk => {
      this.buffer += chunk
      let idx
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line) this.#deliver(line)
      }
    }
    child.stdout.on('data', this.onStdout)
    child.stderr.setEncoding('utf8')
    this.onStderr = chunk => {
      this.stderr += chunk
      if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-64 * 1024)
    }
    child.stderr.on('data', this.onStderr)
    this.onChildError = error => this.#fail(error)
    this.onChildExit = (code, signal) => {
      this.#fail(new Error(
        `OWL host exited before RPC completion (code=${code}, signal=${signal}; stderr tail: ${this.stderr.slice(-400)})`,
      ))
    }
    child.once('error', this.onChildError)
    child.once('exit', this.onChildExit)
  }

  #fail(error) {
    this.exitError = error
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.reject(error)
  }

  #deliver(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // non-JSON stdout (logs, banners) ignored
    }
    if (typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.error) pending.reject(new Error(msg.error.message || 'rpc error'))
    else pending.resolve(msg.result ?? null)
  }

  call(method, params = {}, timeoutMs = 15000) {
    if (this.exitError) return Promise.reject(this.exitError)
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(
          new Error(
            `OWL rpc timed out: ${method} after ${timeoutMs}ms (stderr tail: ${this.stderr.slice(-400)})`
          )
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolveCall(v)
        },
        reject: e => {
          clearTimeout(timer)
          rejectCall(e)
        },
      })
      this.child.stdin.write(payload + '\n')
    })
  }

  async stop() {
    try {
      return await stopTestChild(this.child, {
        killProcessGroup: this.killProcessGroup,
      })
    } finally {
      this.child.stdout.off('data', this.onStdout)
      this.child.stderr.off('data', this.onStderr)
      this.child.off('error', this.onChildError)
      this.child.off('exit', this.onChildExit)
      this.#fail(new Error('OWL host stopped'))
    }
  }
}

function spawnOwlHost() {
  const killProcessGroup = process.platform !== 'win32'
  const child = spawn(electronBin, [projectRoot], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODESURF_OWL_HOST: '1',
      // Keep BrowserWindows offscreen — defaults already do, but be explicit.
      CODESURF_OWL_HOST_SHOW_WINDOWS: '0',
      // Headless-friendly on CI.
      ELECTRON_DISABLE_SANDBOX: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    detached: killProcessGroup,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new StdioClient(child, { killProcessGroup })
}

test('OWL host: smoke + full webview lifecycle', { timeout: 60000 }, async t => {
  preflight()
  const client = spawnOwlHost()
  t.after(() => client.stop())

  await t.test('health responds with runtime + pid', async () => {
    const health = await client.call('health', {}, 20000)
    assert.equal(health.ok, true, 'health.ok')
    assert.equal(health.runtime, 'electron', 'health.runtime')
    assert.equal(typeof health.pid, 'number', 'health.pid is number')
  })

  let sessionId
  await t.test('session.create returns a record with appName + id', async () => {
    const record = await client.call('session.create', {
      appName: 'integration-test',
      buildFlavor: 'test',
    })
    assert.equal(record.appName, 'integration-test')
    assert.equal(record.buildFlavor, 'test')
    assert.match(record.id, /^session_/)
    sessionId = record.id
  })

  await t.test('session.create rejects missing appName', async () => {
    await assert.rejects(() => client.call('session.create', {}), /appName/)
  })

  let profilePersistent, profileEphemeral
  await t.test('profile.create persistent uses persist: partition', async () => {
    profilePersistent = await client.call('profile.create', {
      sessionId,
      name: 'persistent-profile',
      persistent: true,
      storageKey: 'integration-persistent',
    })
    assert.equal(profilePersistent.persistent, true)
    assert.equal(profilePersistent.partition, 'persist:owl:integration-persistent')
    assert.match(profilePersistent.id, /^profile_/)
  })

  await t.test('profile.create isolateForAgent forces ephemeral partition', async () => {
    profileEphemeral = await client.call('profile.create', {
      sessionId,
      persistent: true, // requested persistent...
      isolateForAgent: true, // ...but agent-isolated wins -> ephemeral
      storageKey: 'integration-ephemeral',
    })
    assert.equal(profileEphemeral.persistent, false)
    assert.match(profileEphemeral.partition, /^owl:memory:/)
  })

  await t.test('profile.create rejects unknown session', async () => {
    await assert.rejects(
      () => client.call('profile.create', { sessionId: 'session_unknown', name: 'x' }),
      /Unknown session/
    )
  })

  let webviewId
  await t.test('webview.create loads about:blank and returns record', async () => {
    const webview = await client.call(
      'webview.create',
      {
        profileId: profileEphemeral.id,
        initialUrl: 'about:blank',
        width: 640,
        height: 480,
        deviceScaleFactor: 1,
      },
      30000
    )
    assert.match(webview.id, /^webview_/)
    assert.equal(webview.profileId, profileEphemeral.id)
    assert.equal(webview.url, 'about:blank')
    assert.equal(webview.width, 640)
    assert.equal(webview.height, 480)
    webviewId = webview.id
  })

  await t.test('webview.setGeometry updates bounds', async () => {
    const updated = await client.call('webview.setGeometry', {
      webViewId: webviewId,
      width: 800,
      height: 600,
    })
    assert.equal(updated.width, 800)
    assert.equal(updated.height, 600)
  })

  await t.test('webview.capture returns a base64 PNG', async () => {
    const cap = await client.call('webview.capture', { webViewId: webviewId }, 30000)
    assert.equal(cap.mimeType, 'image/png')
    assert.equal(cap.webViewId, webviewId)
    assert.ok(cap.dataBase64.length > 100, 'PNG payload should be non-trivial')
    const header = Buffer.from(cap.dataBase64.slice(0, 16), 'base64')
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(header[0], 0x89, 'PNG byte 0')
    assert.equal(header[1], 0x50, 'PNG byte 1 (P)')
    assert.equal(header[2], 0x4e, 'PNG byte 2 (N)')
    assert.equal(header[3], 0x47, 'PNG byte 3 (G)')
  })

  await t.test('webview.dispatchInput route=browser is no-op', async () => {
    const res = await client.call('webview.dispatchInput', {
      webViewId: webviewId,
      route: 'browser',
      event: { type: 'mouseMove', x: 1, y: 1 },
    })
    assert.equal(res.accepted, false)
    assert.equal(res.returnedToClient, true)
  })

  await t.test('webview.dispatchInput route=content forwards', async () => {
    const res = await client.call('webview.dispatchInput', {
      webViewId: webviewId,
      event: { type: 'mouseMove', x: 10, y: 20 },
    })
    assert.equal(res.accepted, true)
    assert.equal(res.returnedToClient, false)
  })

  await t.test('webview.dispatchInput rejects non-object event', async () => {
    await assert.rejects(
      () => client.call('webview.dispatchInput', { webViewId: webviewId, event: 'nope' }),
      /event must be an object/
    )
  })

  await t.test('plugin.list returns empty plugins array', async () => {
    const res = await client.call('plugin.list', {})
    assert.deepEqual(res, { plugins: [] })
  })

  await t.test('webview.destroy succeeds, then capture fails', async () => {
    const ok = await client.call('webview.destroy', { webViewId: webviewId })
    assert.deepEqual(ok, { ok: true })
    await assert.rejects(
      () => client.call('webview.capture', { webViewId: webviewId }),
      /Unknown webView/
    )
  })

  await t.test('unknown method is rejected', async () => {
    await assert.rejects(() => client.call('does.not.exist', {}), /Unknown OWL method/)
  })
})
