import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import {
  BoundedSubprocessError,
  runBoundedSubprocess,
} from '../src/main/relay/bounded-subprocess.ts'

const fixture = resolve(process.cwd(), 'test/fixtures/relay-process/child.mjs')

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForPidExit(pid: number, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return
    await new Promise(resolveWait => setTimeout(resolveWait, 15))
  }
  assert.fail(`PID ${pid} was still alive after ${timeoutMs}ms`)
}

function expectBoundedError(error: unknown): BoundedSubprocessError {
  assert.ok(error instanceof BoundedSubprocessError)
  return error
}

describe('bounded relay subprocess lifecycle', () => {
  test('rejects a pre-aborted turn without launching a child', async () => {
    const controller = new AbortController()
    const reason = new Error('runtime disposed')
    controller.abort(reason)

    const error = await runBoundedSubprocess({
      command: resolve(process.cwd(), 'test/fixtures/relay-process/missing-command'),
      label: 'cancelled fixture',
      timeoutMs: 2_000,
      signal: controller.signal,
    }).then(
      () => assert.fail('expected cancellation'),
      expectBoundedError,
    )

    assert.equal(error.reason, 'abort')
    assert.equal(error.pid, null)
    assert.equal(error.cause, reason)
    assert.match(error.message, /cancelled before launch/)
  })

  test('returns bounded stdout, stderr, and exit metadata on success', async () => {
    const result = await runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'normal'],
      label: 'fixture',
      timeoutMs: 2_000,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
    })

    assert.equal(result.code, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, 'normal-output')
    assert.equal(result.stderr, 'normal-diagnostic')
    assert.ok(result.pid > 0)
  })

  test('returns non-zero exits to the provider without losing diagnostics', async () => {
    const result = await runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'nonzero'],
      label: 'fixture',
      timeoutMs: 2_000,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
    })

    assert.equal(result.code, 7)
    assert.equal(result.stdout, 'partial-output')
    assert.equal(result.stderr, 'expected-failure')
  })

  test('rejects once at the stdout cap and stops accumulating output', async () => {
    let rejectionCount = 0
    const error = await runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'overflow'],
      label: 'overflow fixture',
      timeoutMs: 3_000,
      stdoutMaxBytes: 128 * 1024,
      stderrMaxBytes: 1_024,
      termGraceMs: 100,
      killWaitMs: 500,
    }).then(
      () => assert.fail('expected stdout overflow'),
      caught => {
        rejectionCount += 1
        return expectBoundedError(caught)
      },
    )

    assert.equal(rejectionCount, 1)
    assert.equal(error.reason, 'stdout-limit')
    assert.match(error.message, /stdout exceeded 131072 byte limit/)
    assert.ok(Buffer.byteLength(error.stdout) <= 128 * 1024)
    if (error.pid) await waitForPidExit(error.pid)
  })

  test('enforces the independent stderr cap without accumulating past it', async () => {
    const error = await runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'stderr-overflow'],
      label: 'stderr overflow fixture',
      timeoutMs: 3_000,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 128 * 1024,
      termGraceMs: 100,
      killWaitMs: 500,
    }).then(
      () => assert.fail('expected stderr overflow'),
      expectBoundedError,
    )

    assert.equal(error.reason, 'stderr-limit')
    assert.match(error.message, /stderr exceeded 131072 byte limit/)
    assert.ok(Buffer.byteLength(error.stderr) <= 128 * 1024)
    if (error.pid) await waitForPidExit(error.pid)
  })

  test('times out, escalates termination, and confirms the direct child closed', async () => {
    const startedAt = Date.now()
    const error = await runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'linger'],
      label: 'timeout fixture',
      timeoutMs: 100,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
      termGraceMs: 100,
      killWaitMs: 500,
    }).then(
      () => assert.fail('expected timeout'),
      expectBoundedError,
    )

    assert.equal(error.reason, 'timeout')
    assert.match(error.message, /timed out after 100ms/)
    assert.ok(Date.now() - startedAt < 1_500)
    if (error.pid) await waitForPidExit(error.pid)
  })

  test('kills a timeout child process group including its grandchild', {
    skip: process.platform === 'win32' ? 'POSIX process-group assertion' : false,
  }, async () => {
    const timeoutMs = 1_000
    const error = await runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'grandchild-parent-exits'],
      label: 'process-tree fixture',
      // This fixture starts two Node processes before announcing readiness.
      // Keep startup scheduling outside the assertion's timing margin so the
      // timeout exercises process-tree teardown, not fixture boot contention.
      timeoutMs,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
      termGraceMs: 100,
      killWaitMs: 750,
    }).then(
      () => assert.fail('expected timeout'),
      expectBoundedError,
    )

    assert.equal(error.reason, 'timeout')
    assert.match(error.message, new RegExp(`timed out after ${timeoutMs}ms`))
    // Bounded capture remains active through teardown, preserving diagnostics
    // without allowing either stream to exceed its configured byte cap.
    const match = error.stdout.match(/grandchild:(\d+)/)
    assert.ok(match, `missing grandchild pid in ${JSON.stringify(error.stdout)}`)
    const grandchildPid = Number(match[1])
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)
    assert.ok(error.pid && Number.isSafeInteger(error.pid) && error.pid > 0)
    await waitForPidExit(error.pid)
    await waitForPidExit(grandchildPid)
  })

  test('aborts an active process group including its grandchild', {
    skip: process.platform === 'win32' ? 'POSIX process-group assertion' : false,
  }, async () => {
    const controller = new AbortController()
    const reason = new Error('workspace stopped')
    const abortAfterMs = 1_000
    const turn = runBoundedSubprocess({
      command: process.execPath,
      args: [fixture, 'grandchild-parent-exits'],
      label: 'cancelled process-tree fixture',
      timeoutMs: 5_000,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
      termGraceMs: 100,
      killWaitMs: 750,
      signal: controller.signal,
    })
    // Match the timeout-tree test's startup margin: this fixture must start
    // two Node processes and announce the grandchild before cancellation.
    // A 150ms timer races fixture boot under the aggregate suite's load.
    const abortHandle = setTimeout(() => controller.abort(reason), abortAfterMs)

    const error = await turn.then(
      () => assert.fail('expected cancellation'),
      expectBoundedError,
    ).finally(() => clearTimeout(abortHandle))

    assert.equal(error.reason, 'abort')
    assert.equal(error.cause, reason)
    const match = error.stdout.match(/grandchild:(\d+)/)
    assert.ok(match, `missing grandchild pid in ${JSON.stringify(error.stdout)}`)
    const grandchildPid = Number(match[1])
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)
    if (error.pid) await waitForPidExit(error.pid)
    await waitForPidExit(grandchildPid)
  })

  test('a spawn error settles within the bounded termination window', async () => {
    const startedAt = Date.now()
    const error = await runBoundedSubprocess({
      command: resolve(process.cwd(), 'test/fixtures/relay-process/missing-command'),
      label: 'missing fixture',
      timeoutMs: 3_000,
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
      termGraceMs: 100,
      killWaitMs: 250,
    }).then(
      () => assert.fail('expected spawn error'),
      expectBoundedError,
    )

    assert.equal(error.reason, 'spawn')
    assert.match(error.message, /failed to start/)
    assert.ok(Date.now() - startedAt < 1_000)
  })
})
