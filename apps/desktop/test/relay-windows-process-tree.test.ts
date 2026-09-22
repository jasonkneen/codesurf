import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import {
  BoundedSubprocessError,
  runBoundedSubprocess,
  runWindowsTaskkill,
  type WindowsTaskkillProcess,
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

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  assert.fail(`PID ${pid} was still alive after ${timeoutMs}ms`)
}

function expectBoundedError(error: unknown): BoundedSubprocessError {
  assert.ok(error instanceof BoundedSubprocessError)
  return error
}

function closingTaskkill(
  code: number | null,
  signal: NodeJS.Signals | null = null,
): WindowsTaskkillProcess {
  return {
    onError() {},
    onClose(listener) {
      queueMicrotask(() => listener(code, signal))
    },
    kill() {},
  }
}

describe('Windows relay process-tree termination contract', () => {
  test('accepts taskkill /T only when it exits successfully', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => closingTaskkill(0),
    })

    assert.deepEqual(result, {
      confirmed: true,
      outcome: 'success',
      detail: 'taskkill /T exited successfully',
    })
  })

  test('fails closed when taskkill cannot be spawned', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => {
        throw new Error('ENOENT')
      },
    })

    assert.equal(result.confirmed, false)
    assert.equal(result.outcome, 'spawn-error')
    assert.match(result.detail, /ENOENT/)
  })

  test('fails closed on a non-zero taskkill exit', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => closingTaskkill(5),
    })

    assert.equal(result.confirmed, false)
    assert.equal(result.outcome, 'nonzero-exit')
    assert.match(result.detail, /code 5/)
  })

  test('fails closed when taskkill itself times out', async () => {
    let killCalls = 0
    const result = await runWindowsTaskkill(123, 10, {
      spawnTaskkill: () => ({
        onError() {},
        onClose() {},
        kill() {
          killCalls += 1
        },
      }),
    })

    assert.equal(result.confirmed, false)
    assert.equal(result.outcome, 'timeout')
    assert.equal(killCalls, 1)
  })

  test('allows an explicit descendant-death verifier to confirm fallback', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => closingTaskkill(1),
      verifyProcessTreeExited: async (pid) => pid === 123,
    })

    assert.equal(result.confirmed, true)
    assert.equal(result.outcome, 'verified')
    assert.match(result.detail, /independently verified dead/)
  })

  test(
    'production timeout containment kills a real nested Windows process tree',
    { skip: process.platform !== 'win32' ? 'Windows process-tree assertion' : false },
    async () => {
      let leaderPid = 0
      let grandchildPid = 0
      try {
        const timeoutMs = 1_500
        const error = await runBoundedSubprocess({
          command: process.execPath,
          args: [fixture, 'grandchild'],
          label: 'Windows process-tree fixture',
          timeoutMs,
          stdoutMaxBytes: 1_024,
          stderrMaxBytes: 1_024,
          termGraceMs: 100,
          killWaitMs: 5_000,
        }).then(() => assert.fail('expected timeout'), expectBoundedError)

        leaderPid = error.pid ?? 0
        const match = error.stdout.match(/grandchild:(\d+)/)
        assert.ok(match, `missing grandchild pid in ${JSON.stringify(error.stdout)}`)
        grandchildPid = Number(match[1])

        assert.equal(error.reason, 'timeout')
        assert.match(error.message, new RegExp(`timed out after ${timeoutMs}ms`))
        assert.ok(Number.isSafeInteger(leaderPid) && leaderPid > 0)
        assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)
        await waitForPidExit(leaderPid)
        await waitForPidExit(grandchildPid)
      } finally {
        for (const pid of [leaderPid, grandchildPid]) {
          if (!pid || !isPidAlive(pid)) continue
          await runWindowsTaskkill(pid, 5_000)
          await waitForPidExit(pid)
        }
      }
    },
  )
})
