// Integration test for the plugin execution broker.
//
// Spawns dist-electron/main/index.js inside the real electron binary with
// CODESURF_BROKER_TEST=1, then drives the stdio JSON-RPC harness to assert:
//   1. activate/deactivate lifecycle
//   2. capability-DENY: chat-only ext cannot call relayHost (denied in main)
//   3. crash-recovery: killing the child does not crash main
//
// Requires a prior `npm run build:main` so the bundle exists.
// Pattern mirrors test/hosts/owl-host-integration.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveElectronExecutable } from '../../e2e/helpers/electron-path.ts'
import { stopTestChild, trackTestChild } from '../helpers/child-process-shutdown.mjs'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(__filename), '../..')
const builtMain = resolve(projectRoot, 'dist-electron/main/index.js')
const electronBin = resolveElectronExecutable(projectRoot)
const fixtureBase = resolve(projectRoot, 'test/fixtures/broker')
const lockHolderFixture = resolve(projectRoot, 'test/fixtures/codesurf-single-instance-lock-holder.cjs')

function preflight() {
  if (!existsSync(builtMain)) {
    throw new Error(
      `dist-electron/main/index.js not found — run \`npm run build:main\` first.`
    )
  }
  if (!existsSync(electronBin)) {
    throw new Error(`node_modules/.bin/electron not found — \`npm install\` first.`)
  }
  if (!existsSync(lockHolderFixture)) {
    throw new Error(`single-instance lock-holder fixture not found: ${lockHolderFixture}`)
  }
  // Also require broker-child.js bundle
  const brokerChild = resolve(projectRoot, 'dist-electron/main/broker-child.js')
  if (!existsSync(brokerChild)) {
    throw new Error(
      `dist-electron/main/broker-child.js not found — run \`npm run build:main\` first.`
    )
  }
}

// Minimal JSON-RPC client (copied from the adjacent OWL host fixture)
class StdioClient {
  constructor(child, {
    killProcessGroup = false,
    profileRoot = null,
    userDataDir = null,
  } = {}) {
    this.child = child
    this.killProcessGroup = killProcessGroup
    this.profileRoot = profileRoot
    this.userDataDir = userDataDir
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
        `broker host exited before RPC completion (code=${code}, signal=${signal}; stderr tail: ${this.stderr.slice(-500)})`,
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
      return
    }
    if (typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.error) pending.reject(new Error(msg.error.message || 'rpc error'))
    else pending.resolve(msg.result ?? null)
  }

  call(method, params = {}, timeoutMs = 20000) {
    if (this.exitError) return Promise.reject(this.exitError)
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(
          new Error(
            `broker rpc timed out: ${method} after ${timeoutMs}ms (stderr tail: ${this.stderr.slice(-500)})`
          )
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolveCall(v) },
        reject: e => { clearTimeout(timer); rejectCall(e) },
      })
      this.child.stdin.write(payload + '\n')
    })
  }

  async stop() {
    let stopped = false
    try {
      const result = await stopTestChild(this.child, {
        killProcessGroup: this.killProcessGroup,
      })
      stopped = true
      return result
    } finally {
      this.child.stdout.off('data', this.onStdout)
      this.child.stderr.off('data', this.onStderr)
      this.child.off('error', this.onChildError)
      this.child.off('exit', this.onChildExit)
      this.#fail(new Error('broker host stopped'))
      if (stopped && this.profileRoot) {
        rmSync(this.profileRoot, { recursive: true, force: true })
      }
    }
  }
}

function spawnBrokerTestHost({ userDataDir } = {}) {
  const killProcessGroup = process.platform !== 'win32'
  const profileRoot = userDataDir
    ? null
    : mkdtempSync(join(tmpdir(), 'codesurf-broker-home-'))
  const profileHome = profileRoot ?? userDataDir
  const resolvedUserDataDir = userDataDir
    ?? join(profileRoot, 'electron-user-data')
  mkdirSync(resolvedUserDataDir, { recursive: true })
  const canonicalUserDataDir = realpathSync(resolvedUserDataDir)
  const canonicalProfileHome = realpathSync(profileHome)
  const args = [
    `--user-data-dir=${canonicalUserDataDir}`,
    projectRoot,
  ]
  const child = spawn(electronBin, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: canonicalProfileHome,
      USERPROFILE: canonicalProfileHome,
      CODESURF_HOME: join(canonicalProfileHome, '.codesurf'),
      CODESURF_BROKER_TEST: '1',
      ELECTRON_DISABLE_SANDBOX: '1',
      ELECTRON_ENABLE_LOGGING: '1',
      CODESURF_POWER_BROKER: '1',
    },
    detached: killProcessGroup,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new StdioClient(child, {
    killProcessGroup,
    profileRoot,
    userDataDir: canonicalUserDataDir,
  })
}

function assertIsolatedBrokerHealth(client, health) {
  assert.equal(health.ok, true, 'health.ok')
  assert.equal(
    resolve(health.userData),
    resolve(client.userDataDir),
    'broker host uses its isolated Electron profile',
  )
}

function waitForLockHolder(child, timeoutMs = 15_000) {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      cleanup()
      rejectReady(new Error(
        `single-instance lock holder timed out (stderr tail: ${stderr.slice(-500)})`,
      ))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onStdout = chunk => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try {
        resolveReady(JSON.parse(stdout.slice(0, newline)))
      } catch (error) {
        rejectReady(error)
      }
    }
    const onStderr = chunk => {
      stderr += chunk
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024)
    }
    const onError = error => {
      cleanup()
      rejectReady(error)
    }
    const onExit = (code, signal) => {
      cleanup()
      rejectReady(new Error(
        `single-instance lock holder exited before ready (code=${code}, signal=${signal}; stderr tail: ${stderr.slice(-500)})`,
      ))
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function spawnSingleInstanceLockHolder(userDataDir) {
  const killProcessGroup = process.platform !== 'win32'
  const child = spawn(electronBin, [
    lockHolderFixture,
    `--user-data-dir=${userDataDir}`,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    detached: killProcessGroup,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  trackTestChild(child)
  return { child, killProcessGroup }
}

// Helper: wait briefly then collect bus events
async function collectEvents(client, waitMs = 500) {
  await new Promise(r => setTimeout(r, waitMs))
  const res = await client.call('getBusEvents', {}, 5000)
  return res.events ?? []
}

test('Broker host bypasses a contested normal-app single-instance lock', { timeout: 60_000 }, async t => {
  preflight()
  const userDataDir = await mkdtemp(join(tmpdir(), 'codesurf-broker-lock-'))
  const lockHolder = spawnSingleInstanceLockHolder(userDataDir)
  let client
  t.after(async () => {
    try {
      await client?.stop()
    } finally {
      try {
        await stopTestChild(lockHolder.child, {
          killProcessGroup: lockHolder.killProcessGroup,
        })
      } finally {
        await rm(userDataDir, { recursive: true, force: true })
      }
    }
  })

  const ready = await waitForLockHolder(lockHolder.child)
  assert.equal(ready.locked, true, 'fixture holds the normal CodeSurf single-instance lock')

  client = spawnBrokerTestHost({ userDataDir })
  const health = await client.call('health', {}, 30_000)
  assertIsolatedBrokerHealth(client, health)
})

test('Broker host: IPC handler cleanup on deactivate (re-activate does not throw)', { timeout: 120_000 }, async t => {
  preflight()
  const client = spawnBrokerTestHost()
  t.after(() => client.stop())

  await t.test('health responds', async () => {
    const health = await client.call('health', {}, 30_000)
    assertIsolatedBrokerHealth(client, health)
  })

  // ── Activate ipc-ext (first time) ──────────────────────────────────────
  await t.test('ipc-ext activates on first attempt', async () => {
    const result = await client.call('activateFixture', {
      id: 'ipc-ext',
      name: 'IPC Extension',
      extDir: join(fixtureBase, 'ipc-ext'),
      capabilities: [],
    }, 30_000)
    assert.equal(result.activated, true, 'first activate returned true')
  })

  // ── Deactivate ────────────────────────────────────────────────────────
  await t.test('ipc-ext deactivates cleanly', async () => {
    const result = await client.call('deactivateFixture', { extId: 'ipc-ext' }, 15_000)
    assert.equal(result.ok, true, 'deactivated ok')
  })

  // ── Re-activate: must not throw "second handler" ─────────────────────
  await t.test('ipc-ext re-activates without "second handler" error', async () => {
    const result = await client.call('activateFixture', {
      id: 'ipc-ext',
      name: 'IPC Extension',
      extDir: join(fixtureBase, 'ipc-ext'),
      capabilities: [],
    }, 30_000)
    assert.equal(result.activated, true, 'second activate returned true — no duplicate handler error')
  })

  // ── Cleanup ───────────────────────────────────────────────────────────
  await t.test('ipc-ext deactivates cleanly after re-activation', async () => {
    const result = await client.call('deactivateFixture', { extId: 'ipc-ext' }, 15_000)
    assert.equal(result.ok, true, 'final deactivate ok')
  })
})

test('Broker host: lifecycle + capability-deny + crash-recovery', { timeout: 120_000 }, async t => {
  preflight()
  const client = spawnBrokerTestHost()
  t.after(() => client.stop())

  await t.test('health responds', async () => {
    const health = await client.call('health', {}, 30_000)
    assertIsolatedBrokerHealth(client, health)
    assert.equal(typeof health.pid, 'number', 'health.pid is number')
  })

  // ── 1. Lifecycle: activate + deactivate ──────────────────────────────────
  let crashyExtId
  await t.test('activate crashy-ext succeeds', async () => {
    const result = await client.call('activateFixture', {
      extDir: join(fixtureBase, 'crashy-ext'),
      capabilities: [],
    }, 30_000)
    assert.equal(result.activated, true, 'activate returned true')
    crashyExtId = result.extId
  })

  await t.test('crashy-ext publishes activated event', async () => {
    const events = await collectEvents(client, 800)
    const activatedEvent = events.find(
      e => e.channel === 'broker-test' && e.type === 'activated'
    )
    assert.ok(activatedEvent, 'activated event received on bus')
  })

  // ── 2. Capability-DENY assertion ─────────────────────────────────────────
  let chatOnlyActivated = false
  await t.test('chat-only extension activates successfully (baseline allowed)', async () => {
    const result = await client.call('activateFixture', {
      id: 'chat-only-ext',
      name: 'Chat Only',
      extDir: join(fixtureBase, 'chat-only-ext'),
      capabilities: [{ name: 'chat' }],
    }, 30_000)
    assert.equal(result.activated, true, 'chat-only-ext activated')
    chatOnlyActivated = result.activated
  })

  await t.test('chat-only extension is denied relayHost (capability-deny)', async () => {
    if (!chatOnlyActivated) return // skip if activate failed

    // Wait for the extension to attempt the relayHost calls and publish results
    const events = await collectEvents(client, 2000)
    const resultsEvent = events.find(
      e => e.channel === 'broker-test' && e.type === 'results'
    )

    assert.ok(resultsEvent, `results event received from chat-only-ext (got ${events.length} events: ${JSON.stringify(events.map(e => e.type))})`)

    // The fixture tries ctx.relayHost.install() — which requires 'relay' grant
    // but this extension only has 'chat'. Main must deny it.
    const payload = resultsEvent.payload
    assert.ok(
      payload.fs && /capability.denied|not granted|denied/i.test(String(payload.fs)),
      `fs attempt should be denied by main, got: ${payload.fs}`
    )
    assert.ok(
      payload.shell && /capability.denied|not granted|denied/i.test(String(payload.shell)),
      `shell attempt should be denied by main, got: ${payload.shell}`
    )
  })

  await t.test('chat-only extension can be deactivated', async () => {
    if (!chatOnlyActivated) return
    const result = await client.call('deactivateFixture', { extId: 'chat-only-ext' }, 15_000)
    assert.equal(result.ok, true, 'deactivated ok')
  })

  // ── 3. Crash recovery ────────────────────────────────────────────────────
  await t.test('killing crashy-ext child does not crash main', async () => {
    // Kill the crashy-ext child via SIGKILL
    await client.call('killChild', { extId: crashyExtId }, 5000)

    // Wait for crash to propagate
    await new Promise(r => setTimeout(r, 800))

    // Main should still respond
    const alive = await client.call('mainAlive', {}, 5000)
    assert.equal(alive.ok, true, 'main is still alive after child crash')
  })

  await t.test('extension-crashed event was published to bus after crash', async () => {
    const events = await collectEvents(client, 300)
    const crashEvent = events.find(e => e.type === 'extension-crashed')
    assert.ok(crashEvent, 'extension-crashed event emitted on crash')
    assert.ok(crashEvent.payload, 'crash event has payload')
  })
})

test('Broker host: IPC namespace enforcement — out-of-namespace channel is rejected', { timeout: 120_000 }, async t => {
  preflight()
  const client = spawnBrokerTestHost()
  t.after(() => client.stop())

  await t.test('health responds', async () => {
    const health = await client.call('health', {}, 30_000)
    assertIsolatedBrokerHealth(client, health)
  })

  await t.test('ipc-namespace-escape-ext activates', async () => {
    const result = await client.call('activateFixture', {
      id: 'ipc-namespace-escape-ext',
      name: 'IPC Namespace Escape Extension',
      extDir: join(fixtureBase, 'ipc-namespace-escape-ext'),
      capabilities: [],
    }, 30_000)
    assert.equal(result.activated, true, 'fixture activated')
  })

  await t.test('host rejects out-of-namespace IPC channel registration', async () => {
    // The fixture publishes broker-test:namespace-escape-result with escapeDenied=true
    // when the host correctly rejects the unauthorized channel attempt.
    const events = await collectEvents(client, 1500)
    const resultEvent = events.find(
      e => e.channel === 'broker-test' && e.type === 'namespace-escape-result'
    )
    assert.ok(
      resultEvent,
      `namespace-escape-result event not received (got ${events.length} events: ${JSON.stringify(events.map(e => e.type))})`,
    )
    assert.equal(
      resultEvent.payload.escapeDenied,
      true,
      'host must reject cross-namespace IPC handler registration with "unauthorized channel" error',
    )
  })

  await t.test('ipc-namespace-escape-ext deactivates cleanly', async () => {
    const result = await client.call('deactivateFixture', { extId: 'ipc-namespace-escape-ext' }, 15_000)
    assert.equal(result.ok, true, 'deactivated ok')
  })
})
