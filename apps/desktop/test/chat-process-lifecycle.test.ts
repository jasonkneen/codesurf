import assert from 'node:assert/strict'
import { daemonUrl, daemonFile, daemonSource } from './helpers/daemon-path.mjs'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const { __test: processTreeTest,
  processTreeSpawnOptions,
  terminateProcessTree, } = await import(daemonUrl('bin/process-tree.mjs'))
import { ChatProcessLifecycle } from '../src/main/chat/chat-process-lifecycle.ts'

async function waitForFirstJsonLine(proc: ChildProcess): Promise<{ childPid: number }> {
  return await new Promise((resolve, reject) => {
    let pending = ''
    const timeout = setTimeout(() => reject(new Error('fixture did not announce its descendant')), 3_000)
    proc.once('error', reject)
    proc.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const boundary = pending.indexOf('\n')
      if (boundary < 0) return
      clearTimeout(timeout)
      resolve(JSON.parse(pending.slice(0, boundary)) as { childPid: number })
    })
  })
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}

test('chat replacement awaits SIGKILL of a TERM-resistant descendant and fences stale events', {
  timeout: 10_000,
  skip: process.platform === 'win32'
    ? 'POSIX process-group semantics are covered here; Windows uses taskkill /T /F'
    : false,
}, async t => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'codesurf-chat-tree-'))
  const markerPath = join(fixtureDir, 'writes.log')
  const descendantSource = `
    const { appendFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    setInterval(() => appendFileSync(${JSON.stringify(markerPath)}, 'old\\n'), 10);
  `
  const leaderSource = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
      stdio: 'ignore',
    });
    child.unref();
    process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\\n');
    setInterval(() => process.stdout.write('old-event\\n'), 10);
  `
  const leader = spawn(process.execPath, ['-e', leaderSource], processTreeSpawnOptions({
    stdio: ['ignore', 'pipe', 'ignore'],
  }))
  const cleanup = async (): Promise<void> => {
    await terminateProcessTree(leader, { termGraceMs: 50, killWaitMs: 1_000 }).catch(() => {})
    await rm(fixtureDir, { recursive: true, force: true })
  }
  t.after(cleanup)

  const { childPid } = await waitForFirstJsonLine(leader)
  assert.ok(leader.pid)
  assert.equal(isPidAlive(childPid), true)

  const lifecycle = new ChatProcessLifecycle({ termGraceMs: 120, killWaitMs: 2_000 })
  assert.equal(lifecycle.register('workspace/card', leader), true)
  const acceptedEvents: string[] = []
  leader.stdout?.on('data', (chunk: Buffer) => {
    if (lifecycle.isCurrent('workspace/card', leader)) {
      acceptedEvents.push(chunk.toString())
    }
  })

  const stopPromise = lifecycle.stop('workspace/card')
  assert.equal(lifecycle.isCurrent('workspace/card', leader), false)
  assert.equal(lifecycle.processes.get('workspace/card'), leader)
  const acceptedAtStop = acceptedEvents.length

  const result = await stopPromise
  assert.equal(result?.confirmed, true, result?.detail)
  assert.equal(result?.stage, 'sigkill')
  assert.equal(lifecycle.processes.has('workspace/card'), false)
  assert.equal(isPidAlive(leader.pid!), false)
  assert.equal(isPidAlive(childPid), false)
  assert.equal(acceptedEvents.length, acceptedAtStop, 'old output must be fenced during TERM grace')

  const writesAfterStop = await readLines(markerPath)
  const replacement = spawn(process.execPath, [
    '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(markerPath)}, 'new\\n')`,
  ], processTreeSpawnOptions({ stdio: 'ignore' }))
  assert.equal(lifecycle.register('workspace/card', replacement), true)
  await new Promise<void>((resolve, reject) => {
    replacement.once('close', () => resolve())
    replacement.once('error', reject)
  })
  lifecycle.release('workspace/card', replacement)
  await new Promise(resolve => setTimeout(resolve, 100))
  const writesAfterReplacement = await readLines(markerPath)
  assert.deepEqual(writesAfterReplacement.slice(0, writesAfterStop.length), writesAfterStop)
  assert.deepEqual(writesAfterReplacement.slice(writesAfterStop.length), ['new'])
})

test('Windows tree cancellation invokes taskkill /PID <pid> /T /F and awaits close', async () => {
  const calls: Array<{ command: string, args: string[] }> = []
  const fakeTaskkill = new EventEmitter() as EventEmitter & { kill: () => void }
  fakeTaskkill.kill = () => {}
  const resultPromise = processTreeTest.runWindowsTaskkill(
    4242,
    500,
    ((command: string, args: string[]) => {
      calls.push({ command, args })
      setImmediate(() => fakeTaskkill.emit('close', 0, null))
      return fakeTaskkill
    }) as typeof spawn,
  )
  const result = await resultPromise
  assert.equal(result.confirmed, true)
  assert.deepEqual(calls, [{
    command: 'taskkill',
    args: ['/PID', '4242', '/T', '/F'],
  }])
})

test('Windows tree cancellation stays unconfirmed when the leader exits while a descendant lives', {
  timeout: 5_000,
}, async t => {
  const descendantSource = 'setInterval(() => {}, 1_000)'
  const leaderSource = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
      stdio: 'ignore',
    });
    child.unref();
    process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\\n');
  `
  const leader = spawn(process.execPath, ['-e', leaderSource], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const { childPid } = await waitForFirstJsonLine(leader)
  await new Promise<void>((resolve, reject) => {
    if (leader.exitCode !== null || leader.signalCode !== null) {
      resolve()
      return
    }
    leader.once('close', () => resolve())
    leader.once('error', reject)
  })
  assert.equal(isPidAlive(childPid), true, 'fixture descendant must outlive its leader')
  t.after(() => {
    try { process.kill(childPid, 'SIGKILL') } catch { /* already exited */ }
  })

  let taskkillCalls = 0
  const result = await processTreeTest.terminateWindowsProcessTree(
    leader,
    leader.pid!,
    500,
    (() => {
      taskkillCalls += 1
      throw new Error('taskkill cannot target a reaped leader')
    }) as typeof spawn,
  )

  assert.equal(result.confirmed, false)
  assert.equal(result.stage, 'failed')
  assert.match(result.detail, /descendant exit is unconfirmed/i)
  assert.equal(taskkillCalls, 0, 'a reaped leader PID must not be reused as a taskkill target')
})
