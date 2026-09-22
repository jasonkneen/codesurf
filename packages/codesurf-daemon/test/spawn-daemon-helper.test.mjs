import test from 'node:test'
import assert from 'node:assert/strict'
import { access, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  makeDaemonTestTempDir,
  spawnDaemon,
  spawnManagedChild,
  waitFor,
} from './helpers/spawn-daemon.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const IGNORE_SIGTERM_FIXTURE = join(TEST_DIR, 'fixtures', 'ignore-sigterm.mjs')

test('managed child escalates SIGTERM to SIGKILL and settles every lifecycle listener', {
  skip: process.platform === 'win32',
}, async t => {
  const managed = spawnManagedChild({
    command: process.execPath,
    args: [IGNORE_SIGTERM_FIXTURE],
  })
  t.after(async () => {
    await managed.stop({
      termTimeoutMs: 50,
      killTimeoutMs: 2_000,
    })
  })

  await waitFor(
    () => managed.stdout.includes(`ready:${managed.child.pid}`),
    2_000,
    10,
  )

  const pid = managed.child.pid
  const result = await managed.stop({
    termTimeoutMs: 50,
    killTimeoutMs: 2_000,
  })

  assert.equal(result.escalated, true)
  assert.equal(result.signalCode, 'SIGKILL')
  assert.equal(managed.child.exitCode, null)
  assert.equal(managed.child.signalCode, 'SIGKILL')
  assert.equal(managed.child.listenerCount('error'), 0)
  assert.equal(managed.child.listenerCount('exit'), 0)
  assert.equal(managed.child.listenerCount('close'), 0)
  assert.equal(managed.child.stdout.listenerCount('data'), 0)
  assert.equal(managed.child.stderr.listenerCount('data'), 0)
  assert.equal(managed.child.stdout.readableEnded, true)
  assert.equal(managed.child.stderr.readableEnded, true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('spawnDaemon isolates home, serves requests, and removes it during teardown', async t => {
  const daemon = await spawnDaemon({
    homePrefix: 'spawn-daemon-helper-',
    appVersion: 'spawn-daemon-helper-test',
  })
  t.after(async () => {
    await daemon.stop()
  })
  const homeDir = daemon.homeDir

  assert.equal(daemon.pidInfo.pid, daemon.child.pid)
  assert.ok(daemon.pidInfo.port > 0)
  const health = await daemon.request('/health')
  assert.equal(health.status, 200)
  assert.equal(health.payload.appVersion, 'spawn-daemon-helper-test')

  const result = await daemon.stop()
  assert.equal(result.escalated, false)
  assert.notEqual(result.exitCode, null)
  await assert.rejects(access(homeDir, constants.F_OK), { code: 'ENOENT' })
})

test('spawnDaemon keeps its home until an uncooperative child reaches final exit', {
  skip: process.platform === 'win32',
}, async t => {
  const daemon = await spawnDaemon({
    daemonEntry: IGNORE_SIGTERM_FIXTURE,
    homePrefix: 'spawn-daemon-ordering-',
    env: {
      CODESURF_TEST_FIXTURE_PUBLISH_DAEMON_PID: '1',
    },
    termTimeoutMs: 500,
    killTimeoutMs: 2_000,
  })
  t.after(async () => {
    await daemon.stop()
  })
  const homeDir = daemon.homeDir
  const pid = daemon.child.pid

  const stopPromise = daemon.stop()
  await waitFor(
    () => daemon.managed.stdout.includes('sigterm-ignored'),
    1_000,
    10,
  )

  await access(homeDir, constants.F_OK)
  assert.doesNotThrow(() => process.kill(pid, 0))

  const result = await stopPromise
  assert.equal(result.escalated, true)
  assert.equal(result.signalCode, 'SIGKILL')
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(access(homeDir, constants.F_OK), { code: 'ENOENT' })
})

test('spawnDaemon bounds failed startup, reaches final exit, and cleans its home', {
  skip: process.platform === 'win32',
}, async t => {
  // The child still needs enough time to enter userland and publish its audit
  // PID before this test intentionally withholds daemon startup state.
  const startupTimeoutMs = 1_000
  const termTimeoutMs = 50
  const killTimeoutMs = 2_000
  const homeDir = await makeDaemonTestTempDir('spawn-daemon-startup-home-')
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })
  const startedAt = Date.now()
  let fixturePid

  await assert.rejects(
    spawnDaemon({
      daemonEntry: IGNORE_SIGTERM_FIXTURE,
      homeDir,
      startupTimeoutMs,
      termTimeoutMs,
      killTimeoutMs,
    }),
    error => {
      assert.match(error.message, /Timed out after 1000ms/)
      fixturePid = error.childPid
      return true
    },
  )

  assert.ok(Date.now() - startedAt < startupTimeoutMs + termTimeoutMs + killTimeoutMs + 500)
  assert.ok(Number.isInteger(fixturePid) && fixturePid > 0)
  assert.throws(() => process.kill(fixturePid, 0), { code: 'ESRCH' })
  await assert.rejects(access(homeDir, constants.F_OK), { code: 'ENOENT' })
})

test('managed child settles spawn errors and removes lifecycle listeners', async () => {
  const managed = spawnManagedChild({
    command: join(TEST_DIR, 'fixtures', 'missing-executable'),
  })

  const result = await managed.waitForExit(2_000)

  assert.equal(result.spawnError?.code, 'ENOENT')
  assert.equal(managed.child.listenerCount('error'), 0)
  assert.equal(managed.child.listenerCount('exit'), 0)
  assert.equal(managed.child.listenerCount('close'), 0)
  assert.equal(managed.child.stdout.listenerCount('data'), 0)
  assert.equal(managed.child.stderr.listenerCount('data'), 0)
})

test('daemon temp homes reject traversal and cleanup targets outside the test root', async () => {
  await assert.rejects(makeDaemonTestTempDir('..'), /safe path segment/)
  await assert.rejects(
    spawnDaemon({ homeDir: dirname(dirname(TEST_DIR)) }),
    /must be inside/,
  )
})
