import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  runCleanupSteps,
  runIsolatedElectronCleanup,
  withCleanupTimeout,
  type CleanupTimers,
} from '../e2e/helpers/cleanup-steps.ts'

function controlledTimers(): CleanupTimers & {
  fire: () => void
  cleared: () => number
} {
  let callback: (() => void) | null = null
  let clearCount = 0
  return {
    setTimeout(next) {
      callback = next
      return 1
    },
    clearTimeout() {
      callback = null
      clearCount += 1
    },
    fire() {
      const next = callback
      callback = null
      next?.()
    },
    cleared: () => clearCount,
  }
}

describe('Electron E2E cleanup helpers', () => {
  test('runs daemon and home cleanup after an application close failure', async () => {
    const calls: string[] = []
    const failure = new Error('app close failed')

    await assert.rejects(
      runCleanupSteps([
        {
          label: 'app',
          run: async () => {
            calls.push('app')
            throw failure
          },
        },
        {
          label: 'daemon',
          run: async () => {
            calls.push('daemon')
          },
        },
        {
          label: 'home',
          run: async () => {
            calls.push('home')
          },
        },
      ]),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.match(error.message, /app: app close failed/)
        assert.match(error.errors[0].message, /app: app close failed/)
        return true
      },
    )
    assert.deepEqual(calls, ['app', 'daemon', 'home'])
  })

  test('rejects a hung cleanup operation at its configured bound', async () => {
    const timers = controlledTimers()
    const pending = new Promise<void>(() => {})
    const bounded = withCleanupTimeout(pending, 250, 'daemon cleanup', timers)

    timers.fire()

    await assert.rejects(bounded, /daemon cleanup timed out after 250 ms/)
    assert.equal(timers.cleared(), 0)
  })

  test('clears the timeout after a cleanup operation succeeds', async () => {
    const timers = controlledTimers()

    await withCleanupTimeout(Promise.resolve(), 250, 'daemon cleanup', timers)

    assert.equal(timers.cleared(), 1)
  })

  test('preserves the isolated home when daemon shutdown is not confirmed', async () => {
    let removeHomeCalls = 0
    const homeDir = '/tmp/codesurf-e2e-home-preserved'

    await assert.rejects(
      runIsolatedElectronCleanup({
        homeDir,
        stopDaemon: async () => {
          throw new Error('daemon did not stop')
        },
        removeHome: async () => {
          removeHomeCalls += 1
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.match(error.message, /preserved \S*codesurf-e2e-home-preserved/)
        assert.match(error.errors[0].message, /daemon did not stop/)
        return true
      },
    )
    assert.equal(removeHomeCalls, 0)
  })
})
