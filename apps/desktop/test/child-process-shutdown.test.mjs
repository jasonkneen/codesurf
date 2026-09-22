import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import {
  isIgnorablePostCloseProcessGroupError,
  signalTestChild,
  stopTestChild,
  sweepRemainingTestProcessGroup,
  trackTestChild,
} from './helpers/child-process-shutdown.mjs'

async function spawnFixture(setup = '') {
  const child = spawn(process.execPath, [
    '-e',
    `${setup}; process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`,
  ], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  trackTestChild(child)
  await once(child.stdout, 'data')
  return child
}

async function forceCleanup(child) {
  await stopTestChild(child, { graceMs: 50, killMs: 1_000 })
}

function assertDrained(child) {
  assert.equal(child.stdin.destroyed, true)
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
}

function isProcessAlive(pid, signal = process.kill) {
  try {
    signal(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    // POSIX kill(pid, 0) uses EPERM to report an existing process that the
    // caller cannot currently signal. Keep waiting instead of treating that
    // existence result as an unexpected test failure.
    if (error?.code === 'EPERM') return true
    throw error
  }
}

async function waitForProcessGone(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`process ${pid} remained alive after process-group shutdown`)
    }
    await delay(10)
  }
}

test('process liveness probes treat EPERM as an existing process', () => {
  const permissionError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  assert.equal(isProcessAlive(123, () => { throw permissionError }), true)
})

test('group EPERM falls back to the exact owned child through TERM and KILL', {
  timeout: 5_000,
  skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, async (t) => {
  const child = await spawnFixture("process.on('SIGTERM', () => {})")
  const originalKill = child.kill.bind(child)
  const directSignals = []
  const groupSignals = []
  child.kill = (signal) => {
    directSignals.push(signal)
    return originalKill(signal)
  }
  const signalProcess = (pid, signal) => {
    groupSignals.push({ pid, signal })
    throw Object.assign(new Error('group is not signalable'), { code: 'EPERM' })
  }
  t.after(() => forceCleanup(child))

  const result = await stopTestChild(child, {
    graceMs: 100,
    killMs: 1_000,
    killProcessGroup: true,
    signalProcess,
  })

  assert.equal(result.escalated, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.groupSwept, false)
  assert.deepEqual(directSignals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(groupSignals, [
    { pid: -child.pid, signal: 'SIGTERM' },
    { pid: -child.pid, signal: 'SIGKILL' },
    { pid: -child.pid, signal: 'SIGKILL' },
  ])
  assertDrained(child)
})

test('persistent direct-child EPERM remains fail-closed', {
  skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, () => {
  const permissionError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  const child = {
    pid: 123,
    kill() {
      throw permissionError
    },
  }
  assert.throws(
    () => signalTestChild(child, 'SIGTERM', true, () => { throw permissionError }),
    error => error === permissionError,
  )
})

test('post-close sweep EPERM never retries an unsafe process-group id', {
  skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, () => {
  let groupSignalCount = 0
  let directSignalCount = 0
  const child = {
    pid: 456,
    kill() {
      directSignalCount += 1
      return true
    },
  }
  const swept = sweepRemainingTestProcessGroup(child, true, () => {
    groupSignalCount += 1
    throw Object.assign(new Error('group id may have been reused'), { code: 'EPERM' })
  })

  assert.equal(swept, false)
  assert.equal(groupSignalCount, 1)
  assert.equal(directSignalCount, 0)
})

test('post-close group sweeps tolerate missing and inaccessible stale groups only', () => {
  assert.equal(isIgnorablePostCloseProcessGroupError({ code: 'ESRCH' }), true)
  assert.equal(isIgnorablePostCloseProcessGroupError({ code: 'EPERM' }), true)
  assert.equal(isIgnorablePostCloseProcessGroupError({ code: 'EINVAL' }), false)
})

test('stopTestChild awaits graceful SIGTERM exit', { timeout: 5_000 }, async (t) => {
  const child = await spawnFixture()
  child.stdout.on('data', () => {})
  t.after(() => {
    return forceCleanup(child)
  })

  const result = await stopTestChild(child, { graceMs: 1_000, killMs: 1_000 })

  assert.equal(result.escalated, false)
  assert.equal(result.signal, 'SIGTERM')
  assert.notEqual(child.signalCode, null)
  assertDrained(child)
})

test('stopTestChild escalates a SIGTERM-resistant child and awaits SIGKILL', {
  timeout: 5_000,
  skip: process.platform === 'win32' ? 'Windows does not support catchable SIGTERM child semantics' : false,
}, async (t) => {
  const child = await spawnFixture("process.on('SIGTERM', () => {})")
  t.after(() => {
    return forceCleanup(child)
  })

  const result = await stopTestChild(child, { graceMs: 100, killMs: 1_000 })

  assert.equal(result.escalated, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.notEqual(child.signalCode, null)
  assertDrained(child)
})

test('stopTestChild kills a detached POSIX child group without orphaning descendants', {
  timeout: 5_000,
  skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, async (t) => {
  const grandchildSource = [
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leaderSource = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGTERM', () => {})",
    `const worker = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "worker.stdout.once('data', () => process.stdout.write(String(worker.pid) + '\\n'))",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leader = spawn(process.execPath, ['-e', leaderSource], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  trackTestChild(leader)
  const [pidChunk] = await once(leader.stdout, 'data')
  const grandchildPid = Number.parseInt(String(pidChunk).trim(), 10)
  assert.equal(Number.isSafeInteger(grandchildPid), true)
  t.after(() => {
    return stopTestChild(leader, {
      graceMs: 50,
      killMs: 1_000,
      killProcessGroup: true,
    })
  })

  const result = await stopTestChild(leader, {
    graceMs: 100,
    killMs: 1_000,
    killProcessGroup: true,
  })

  assert.equal(result.escalated, true)
  await waitForProcessGone(grandchildPid)
  assertDrained(leader)
})
