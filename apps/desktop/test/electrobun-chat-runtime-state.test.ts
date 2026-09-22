import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import {
  ElectrobunChatRuntimeState,
  forceTerminateElectrobunProcessTree,
  terminateElectrobunProcessTree,
} from '../electrobun/bun/chat-runtime-state.ts'
import { createClaudeStreamParser } from '../electrobun/bun/chat-streams.ts'
import type { ChatRequest } from '../src/main/chat/types.ts'

function request(workspaceId: string): ChatRequest {
  return {
    workspaceId,
    cardId: 'same-card',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hello' }],
    roomAckSequence: 7,
  }
}

function fakeProcess(label: string): ChildProcess & { label: string } {
  const process = new EventEmitter() as ChildProcess & { label: string }
  process.label = label
  process.stdout = new PassThrough()
  process.stderr = new PassThrough()
  process.kill = () => true
  Object.defineProperty(process, 'exitCode', { value: null, writable: true })
  return process
}

describe('Electrobun scoped chat runtime state', () => {
  test('isolates events and sessions for identical card IDs across workspaces', async () => {
    const events: unknown[] = []
    const acknowledgements: unknown[] = []
    const runtime = new ElectrobunChatRuntimeState(
      (...args) => acknowledgements.push(args),
      (scope, event) => events.push({ ...scope, ...event }),
    )
    const first = await runtime.start(request('workspace-a'))
    const second = await runtime.start(request('workspace-b'))
    runtime.setSession(first, 'claude', 'session-a')
    runtime.setSession(second, 'claude', 'session-b')
    runtime.send(first, { type: 'text', text: 'A' })
    runtime.send(second, { type: 'text', text: 'B' })

    assert.equal(runtime.getSession(first, 'claude'), 'session-a')
    assert.equal(runtime.getSession(second, 'claude'), 'session-b')
    assert.deepEqual(events, [
      { workspaceId: 'workspace-a', cardId: 'same-card', type: 'text', text: 'A' },
      { workspaceId: 'workspace-b', cardId: 'same-card', type: 'text', text: 'B' },
    ])
    assert.deepEqual(acknowledgements, [
      ['workspace-a', 'same-card', 7],
      ['workspace-b', 'same-card', 7],
    ])
  })

  test('stop and generic setup/completion events do not consume a room cursor', async () => {
    const events: unknown[] = []
    const acknowledgements: unknown[] = []
    let killed = 0
    const runtime = new ElectrobunChatRuntimeState(
      (...args) => acknowledgements.push(args),
      (scope, event) => events.push({ ...scope, ...event }),
      {
        terminateProcessTree: async process => {
          process.kill('SIGTERM')
          killed += 1
          return { confirmed: true, hadProcess: true }
        },
      },
    )
    const stopped = await runtime.start(request('workspace-a'))
    const survivor = await runtime.start(request('workspace-b'))
    await runtime.registerProcess(stopped, fakeProcess('stopped'))
    assert.equal((await runtime.stop(stopped)).confirmed, true)
    runtime.send(stopped, { type: 'done' })
    runtime.send(survivor, { type: 'session', sessionId: 'setup-only' })
    runtime.send(survivor, { type: 'done' })

    assert.equal(killed, 1)
    assert.deepEqual(events, [
      { workspaceId: 'workspace-b', cardId: 'same-card', type: 'session', sessionId: 'setup-only' },
      { workspaceId: 'workspace-b', cardId: 'same-card', type: 'done' },
    ])
    assert.deepEqual(acknowledgements, [])
  })

  test('a delayed stale process cannot replace current process ownership', async () => {
    const terminated: string[] = []
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      {
        terminateProcessTree: async process => {
          terminated.push((process as ChildProcess & { label: string }).label)
          return { confirmed: true, hadProcess: true }
        },
      },
    )
    const oldTurn = await runtime.start(request('workspace-a'))
    const currentTurn = await runtime.start(request('workspace-a'))
    const currentProcess = fakeProcess('current')
    const staleProcess = fakeProcess('stale')
    assert.equal(await runtime.registerProcess(currentTurn, currentProcess), true)
    assert.equal(await runtime.registerProcess(oldTurn, staleProcess), false)
    assert.equal((await runtime.stop(currentTurn)).confirmed, true)
    assert.deepEqual(terminated, ['stale', 'current'])
  })

  test('stale stdout and session writes are ignored after replacement', async () => {
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      { terminateProcessTree: async () => ({ confirmed: true, hadProcess: true }) },
    )
    const oldTurn = await runtime.start(request('workspace-a'))
    const oldProcess = fakeProcess('old')
    await runtime.registerProcess(oldTurn, oldProcess)
    runtime.streamProcess(oldTurn, oldProcess, {
      missingBinaryMessage: 'missing',
      onStdoutLine: line => {
        const session = line.match(/^session:(.+)$/)?.[1]
        if (session) runtime.setSession(oldTurn, 'claude', session)
      },
    })

    const currentTurn = await runtime.start(request('workspace-a'))
    runtime.setSession(currentTurn, 'claude', 'current-session')
    oldProcess.stdout?.emit('data', Buffer.from('session:stale-session\n'))
    runtime.setSession(oldTurn, 'claude', 'also-stale')
    assert.equal(runtime.getSession(currentTurn, 'claude'), 'current-session')
  })

  test('stop waits for a pending launch and terminates its late process before confirming', async () => {
    const terminated: string[] = []
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      {
        launchWaitMs: 1_000,
        terminateProcessTree: async process => {
          terminated.push((process as ChildProcess & { label: string }).label)
          return { confirmed: true, hadProcess: true }
        },
      },
    )
    const turn = await runtime.start(request('workspace-a'))
    let releaseLaunch: (() => void) | null = null
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    const lateProcess = fakeProcess('late')
    const launch = runtime.runLaunch(turn, async () => {
      await launchGate
      return await runtime.registerProcess(turn, lateProcess)
    })
    await new Promise(resolve => setImmediate(resolve))

    const stopping = runtime.stop(turn)
    releaseLaunch?.()
    assert.equal(await launch, false)
    assert.equal((await stopping).confirmed, true)
    assert.deepEqual(terminated, ['late'])
  })

  test('replacement start waits for confirmed termination', async () => {
    let confirmStop: (() => void) | null = null
    const termination = new Promise<void>(resolve => { confirmStop = resolve })
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      {
        terminateProcessTree: async () => {
          await termination
          return { confirmed: true, hadProcess: true }
        },
      },
    )
    const oldTurn = await runtime.start(request('workspace-a'))
    await runtime.registerProcess(oldTurn, fakeProcess('old'))
    let replacementReady = false
    const replacement = runtime.start(request('workspace-a')).then(turn => {
      replacementReady = true
      return turn
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(replacementReady, false)
    confirmStop?.()
    assert.equal((await replacement).workspaceId, 'workspace-a')
    assert.equal(replacementReady, true)
  })

  test('session clearing is fenced by confirmed process termination', async () => {
    const blocked = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      {
        terminateProcessTree: async () => ({
          confirmed: false,
          hadProcess: true,
          error: 'still running',
        }),
      },
    )
    const blockedTurn = await blocked.start(request('workspace-a'))
    blocked.setSession(blockedTurn, 'claude', 'keep-until-stopped')
    await blocked.registerProcess(blockedTurn, fakeProcess('blocked'))
    const blockedResult = await blocked.stopAndClearSessions(blockedTurn)
    assert.equal(blockedResult.confirmed, false)
    assert.equal(blocked.getSession(blockedTurn, 'claude'), 'keep-until-stopped')

    const confirmed = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      { terminateProcessTree: async () => ({ confirmed: true, hadProcess: true }) },
    )
    const confirmedTurn = await confirmed.start(request('workspace-b'))
    confirmed.setSession(confirmedTurn, 'claude', 'clear-after-stop')
    await confirmed.registerProcess(confirmedTurn, fakeProcess('confirmed'))
    assert.equal((await confirmed.stopAndClearSessions(confirmedTurn)).confirmed, true)
    assert.equal(confirmed.getSession(confirmedTurn, 'claude'), null)
  })

  test('an unconfirmed stop can be retried and later confirmed', async () => {
    let attempts = 0
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      () => {},
      {
        terminateProcessTree: async () => {
          attempts += 1
          return attempts === 1
            ? { confirmed: false, hadProcess: true, error: 'still running' }
            : { confirmed: true, hadProcess: true }
        },
      },
    )
    const turn = await runtime.start(request('workspace-a'))
    await runtime.registerProcess(turn, fakeProcess('retryable'))

    assert.equal((await runtime.stop(turn)).confirmed, false)
    assert.equal((await runtime.stop(turn)).confirmed, true)
    assert.equal(attempts, 2)
  })

  test('Claude result errors never advance a room acknowledgement', async () => {
    const acknowledgements: unknown[] = []
    const runtime = new ElectrobunChatRuntimeState(
      (...args) => acknowledgements.push(args),
      () => {},
    )
    const turn = await runtime.start(request('workspace-a'))
    const parser = createClaudeStreamParser()
    for (const event of parser.parseLine(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['provider failed'],
    }))) runtime.send(turn, event)
    runtime.send(turn, { type: 'done' })
    assert.deepEqual(acknowledgements, [])
  })

  test('an output-limit race emits one error/done sequence and terminates once', async () => {
    const events: Array<Record<string, unknown>> = []
    let terminations = 0
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      (_scope, event) => events.push(event),
      {
        outputLimits: {
          maxStdoutBytes: 128,
          maxStderrBytes: 128,
          maxLineBytes: 32,
          maxAggregateBytes: 192,
        },
        terminateProcessTree: async () => {
          terminations += 1
          return { confirmed: true, hadProcess: true }
        },
      },
    )
    const turn = await runtime.start(request('workspace-output-race'))
    const child = fakeProcess('output-race')
    await runtime.registerProcess(turn, child)
    runtime.streamProcess(turn, child, {
      missingBinaryMessage: 'missing',
      onStdoutLine: () => {},
    })

    child.stdout?.emit('data', Buffer.from('x'.repeat(64)))
    child.emit('error', new Error('late child error'))
    child.emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(terminations, 1)
    assert.deepEqual(events.map(event => event.type), ['error', 'done'])
    assert.match(String(events[0]?.error), /line.*limit/i)
  })

  test('the first fatal event seals the turn until its single done event', async () => {
    const events: Array<Record<string, unknown>> = []
    const runtime = new ElectrobunChatRuntimeState(
      () => {},
      (_scope, event) => events.push(event),
    )
    const turn = await runtime.start(request('workspace-terminal-sequence'))
    runtime.send(turn, { type: 'error', error: 'first failure' })
    runtime.send(turn, { type: 'text', text: 'late text' })
    runtime.send(turn, { type: 'error', error: 'duplicate failure' })
    runtime.send(turn, { type: 'done' })
    runtime.send(turn, { type: 'done' })

    assert.deepEqual(events, [
      { type: 'error', error: 'first failure' },
      { type: 'done' },
    ])
  })
})

test('output limits terminate a real process tree before one terminal sequence', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-output-cap-'))
  const descendantPath = join(root, 'descendant.pid')
  const descendantScript = `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `
  const parentScript = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));
    setTimeout(() => process.stdout.write('x'.repeat(4096)), 50);
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', parentScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true })
  })

  const events: Array<Record<string, unknown>> = []
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  const runtime = new ElectrobunChatRuntimeState(
    () => {},
    (_scope, event) => {
      events.push(event)
      if (event.type === 'done') resolveDone?.()
    },
    {
      termGraceMs: 50,
      killWaitMs: 2_000,
      outputLimits: {
        maxStdoutBytes: 8_192,
        maxStderrBytes: 1_024,
        maxLineBytes: 256,
        maxAggregateBytes: 8_192,
      },
    },
  )
  const turn = await runtime.start(request('workspace-real-output-cap'))
  await runtime.registerProcess(turn, child)
  runtime.streamProcess(turn, child, {
    missingBinaryMessage: 'missing',
    onStdoutLine: () => {},
  })

  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for bounded process termination')), 4_000)),
  ])
  const descendantPid = Number(await readFile(descendantPath, 'utf8'))
  assert.deepEqual(events.map(event => event.type), ['error', 'done'])
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' })
})

test('Windows emergency containment invokes synchronous taskkill for the full tree', () => {
  const calls: Array<{ file: string, args: string[], options: Record<string, unknown> }> = []
  let directKills = 0
  const child = fakeProcess('windows-emergency')
  Object.defineProperty(child, 'pid', { value: 4242 })
  child.kill = () => {
    directKills += 1
    return true
  }

  const contained = forceTerminateElectrobunProcessTree(child, {
    platform: 'win32',
    runWindowsTreeKillSync: (file, args, options) => {
      calls.push({ file, args, options })
    },
  })

  assert.equal(contained, true)
  assert.equal(directKills, 0)
  assert.match(String(calls[0]?.file), /[\\/]System32[\\/]taskkill\.exe$/i)
  assert.deepEqual(calls[0]?.args, ['/PID', '4242', '/T', '/F'])
  assert.equal(calls[0]?.options.shell, false)
})

test('process-tree termination escalates and kills a SIGTERM-ignoring descendant', {
  skip: process.platform === 'win32',
}, async t => {
  const childScript = `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `
  const parentScript = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `
  const parent = spawn(process.execPath, ['-e', parentScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (!parent.pid) return
    try { process.kill(-parent.pid, 'SIGKILL') } catch { /* already gone */ }
  })
  const descendantPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for descendant PID')), 2_000)
    parent.stdout?.once('data', chunk => {
      clearTimeout(timer)
      resolve(Number(chunk.toString().trim()))
    })
    parent.once('error', reject)
  })

  const stopped = await terminateElectrobunProcessTree(parent, {
    termGraceMs: 50,
    killWaitMs: 2_000,
  })
  assert.equal(stopped.confirmed, true)
  assert.equal(Number.isSafeInteger(descendantPid), true)
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' })
})
