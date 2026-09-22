import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OrderedDebouncedPersistence } from '../src/renderer/src/lib/orderedCanvasPersistence.ts'
import {
  resolveCanvasPersistenceMode,
  supportsWindowPersistenceBarrier,
} from '../src/renderer/src/lib/windowPersistenceBarrier.ts'
import { createDaemonBackedElectronApi } from '../src/renderer/src/platform/daemonBridge.ts'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('daemon-backed canvas persistence is immediate and coalesces a slow write to the latest state', async () => {
  const daemonApi = createDaemonBackedElectronApi()

  assert.equal(daemonApi.window.onPersistenceRequest, undefined)
  assert.equal(daemonApi.window.persistenceReady, undefined)
  assert.equal(supportsWindowPersistenceBarrier(daemonApi.window), false)

  const mode = resolveCanvasPersistenceMode(daemonApi.window, false)
  assert.equal(mode, 'immediate')
  assert.equal(resolveCanvasPersistenceMode(daemonApi.window, true), 'disabled')

  const firstWrite = deferred()
  const writes: number[] = []
  let activeWrites = 0
  let maximumActiveWrites = 0
  const persistence = new OrderedDebouncedPersistence<number>(
    async value => {
      activeWrites += 1
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
      writes.push(value)
      try {
        if (value === 0) await firstWrite.promise
      } finally {
        activeWrites -= 1
      }
    },
    500,
    undefined,
    mode,
  )

  persistence.schedule(() => 0)
  await settle()
  assert.deepEqual(writes, [0])

  for (let frame = 1; frame < 120; frame += 1) {
    persistence.schedule(() => frame)
    await Promise.resolve()
  }

  assert.equal(maximumActiveWrites, 1)
  assert.deepEqual(writes, [0])

  firstWrite.resolve()
  await persistence.waitForIdle()

  assert.equal(maximumActiveWrites, 1)
  assert.deepEqual(writes, [0, 119])
  assert.equal(persistence.getState().dirty, false)
})
