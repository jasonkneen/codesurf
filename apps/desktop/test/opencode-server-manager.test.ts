import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { OpenCodeServerManager } from '../src/main/chat/providers/opencode-server-manager.ts'

interface FakeChildProcess extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

function fakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  return child
}

test('silent OpenCode startup is terminated and never reused as a ready server', async () => {
  const children: FakeChildProcess[] = []
  let spawnCount = 0
  let terminationCount = 0
  const manager = new OpenCodeServerManager({
    resolveBinary: () => '/test/opencode',
    findAvailablePort: async () => 41_000 + spawnCount,
    spawnServer: () => {
      spawnCount += 1
      const child = fakeChildProcess()
      children.push(child)
      if (spawnCount === 2) {
        queueMicrotask(() => child.stdout.write('opencode listening on 127.0.0.1'))
      }
      return child as unknown as ChildProcess
    },
    terminateProcessTree: async process => {
      terminationCount += 1
      const child = process as unknown as FakeChildProcess
      child.exitCode = 0
      child.emit('exit', 0, null)
      return { confirmed: true, detail: 'test process tree stopped' }
    },
    startupTimeoutMs: 10,
  })

  await assert.rejects(
    manager.ensureRunning(),
    /OpenCode server startup timeout \(10ms\)/,
  )
  assert.equal(spawnCount, 1)
  assert.equal(terminationCount, 1)
  assert.equal(manager.isRunning(), false)

  const restarted = await manager.ensureRunning()
  assert.equal(spawnCount, 2)
  assert.equal(restarted.port, 41_001)
  assert.equal(manager.isRunning(), true)
  assert.notEqual(children[0], children[1])

  await manager.shutdown()
  assert.equal(terminationCount, 2)
  assert.equal(manager.isRunning(), false)
})

test('shutdown invalidates a blocked port lookup before a server is spawned', async () => {
  let releasePort!: (port: number) => void
  let spawnCount = 0
  const manager = new OpenCodeServerManager({
    resolveBinary: () => '/test/opencode',
    findAvailablePort: () => new Promise(resolve => { releasePort = resolve }),
    spawnServer: () => {
      spawnCount += 1
      return fakeChildProcess() as unknown as ChildProcess
    },
    terminateProcessTree: async () => ({ confirmed: true, detail: 'test process tree stopped' }),
    startupTimeoutMs: 10,
  })

  const start = manager.ensureRunning()
  await new Promise(resolve => setImmediate(resolve))
  const shutdown = manager.shutdown()
  releasePort(45_000)

  await assert.rejects(start, /superseded|shutting down/)
  await shutdown
  assert.equal(spawnCount, 0)
  assert.equal(manager.isRunning(), false)
})
