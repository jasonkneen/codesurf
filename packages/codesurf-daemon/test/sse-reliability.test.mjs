import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createChatJobManager,
  createSseSubscriberRegistry,
} from '../bin/chat-jobs.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(check, timeoutMs = 3_000, intervalMs = 10) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function textDelta(text) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }
}

class FakeResponse extends EventEmitter {
  constructor(writeBehavior = () => true) {
    super()
    this.writeBehavior = writeBehavior
    this.writes = []
    this.endCalls = 0
    this.destroyCalls = 0
    this.destroyed = false
    this.writableEnded = false
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) throw new Error('write after close')
    const text = String(chunk)
    this.writes.push(text)
    const result = this.writeBehavior(text, this.writes.length)
    if (result instanceof Error) throw result
    return result
  }

  end() {
    this.endCalls += 1
    this.writableEnded = true
  }

  destroy() {
    this.destroyCalls += 1
    this.destroyed = true
    this.emit('close')
  }
}

function writtenEvents(response) {
  return response.writes
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => JSON.parse(chunk.slice('data: '.length).trim()))
}

function hasTerminalPair(events) {
  const terminalTypes = events.slice(-2).map(event => event.type)
  return terminalTypes[0] === 'error' && terminalTypes[1] === 'done'
}

async function waitForDurableTerminal(timelinePath) {
  return await waitFor(async () => {
    const text = await readFile(timelinePath, 'utf8')
    if (!text.endsWith('\n')) return null
    try {
      const events = text.trim().split('\n').map(line => JSON.parse(line))
      return hasTerminalPair(events) ? text : null
    } catch {
      return null
    }
  })
}

function payload(sequence, text = `event-${sequence}`) {
  return {
    jobId: 'job-1',
    sequence,
    timestamp: sequence,
    type: 'text',
    text,
  }
}

test('subscriber backpressure waits for drain without starving or duplicating sibling delivery', () => {
  const registry = createSseSubscriberRegistry({ heartbeatMs: 0 })
  const slow = new FakeResponse((_chunk, writeNumber) => writeNumber !== 1)
  const fast = new FakeResponse()
  const throwing = new FakeResponse(() => new Error('socket failed'))

  registry.register('job-1', slow, { replaying: false })
  registry.register('job-1', fast, { replaying: false })
  registry.register('job-1', throwing, { replaying: false })

  registry.publish('job-1', payload(1))
  registry.publish('job-1', payload(2))

  assert.deepEqual(writtenEvents(slow).map(event => event.sequence), [1])
  assert.deepEqual(writtenEvents(fast).map(event => event.sequence), [1, 2])
  assert.equal(throwing.destroyCalls, 1)
  assert.equal(throwing.listenerCount('drain'), 0)
  assert.equal(throwing.listenerCount('close'), 0)
  assert.equal(throwing.listenerCount('error'), 0)

  slow.emit('drain')
  assert.deepEqual(writtenEvents(slow).map(event => event.sequence), [1, 2])

  registry.shutdown()
})

test('subscriber event and byte caps deterministically evict only the slow subscriber', () => {
  const eventRegistry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    maxQueuedEvents: 2,
    maxQueuedBytes: 1_000_000,
  })
  const eventSlow = new FakeResponse(() => false)
  const eventFast = new FakeResponse()
  eventRegistry.register('job-1', eventSlow, { replaying: false })
  eventRegistry.register('job-1', eventFast, { replaying: false })

  for (let sequence = 1; sequence <= 4; sequence += 1) {
    eventRegistry.publish('job-1', payload(sequence))
  }

  assert.equal(eventSlow.destroyCalls, 1)
  assert.deepEqual(writtenEvents(eventFast).map(event => event.sequence), [1, 2, 3, 4])
  assert.equal(eventRegistry.count('job-1'), 1)
  eventRegistry.shutdown()

  const byteRegistry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    maxQueuedEvents: 10,
    maxQueuedBytes: 120,
  })
  const byteSlow = new FakeResponse(() => false)
  byteRegistry.register('job-1', byteSlow, { replaying: false })
  byteRegistry.publish('job-1', payload(1, 'accepted'))
  byteRegistry.publish('job-1', payload(2, 'x'.repeat(200)))

  assert.equal(byteSlow.destroyCalls, 1)
  assert.equal(byteRegistry.count('job-1'), 0)
  byteRegistry.shutdown()
})

test('subscriber byte cap rejects oversized direct and replay entries before writing', async () => {
  const directRegistry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    maxQueuedBytes: 128,
  })
  const direct = new FakeResponse()
  directRegistry.register('job-1', direct, { replaying: false })
  directRegistry.publish('job-1', payload(1, 'x'.repeat(256)))

  assert.equal(direct.writes.length, 0)
  assert.equal(direct.destroyCalls, 1)
  assert.equal(directRegistry.count('job-1'), 0)
  directRegistry.shutdown()

  const replayRegistry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    maxQueuedBytes: 128,
  })
  const replay = new FakeResponse()
  const record = replayRegistry.register('job-1', replay, { replaying: true })
  assert.equal(await replayRegistry.sendReplay(record, payload(1, 'x'.repeat(256))), false)
  assert.equal(replay.writes.length, 0)
  assert.equal(replay.destroyCalls, 1)
  assert.equal(replayRegistry.count('job-1'), 0)
  replayRegistry.shutdown()
})

test('blocked terminal writes retain their destroy deadline and shutdown destroys blocked responses', async () => {
  const registry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    drainTimeoutMs: 20,
    maxQueuedBytes: 1_000_000,
  })
  const response = new FakeResponse(() => false)
  registry.register('job-1', response, { replaying: false })
  registry.publish('job-1', {
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'done',
  })

  assert.equal(response.endCalls, 1)
  assert.equal(registry.count('job-1'), 1)
  await waitFor(() => response.destroyCalls === 1)
  assert.equal(registry.count('job-1'), 0)

  const shutdownRegistry = createSseSubscriberRegistry({ heartbeatMs: 0 })
  const shutdownBlocked = new FakeResponse(() => false)
  shutdownRegistry.register('job-1', shutdownBlocked, { replaying: false })
  shutdownRegistry.publish('job-1', payload(1))
  shutdownRegistry.shutdown()
  assert.equal(shutdownBlocked.destroyCalls, 1)
  assert.equal(shutdownRegistry.count(), 0)
})

test('registry shutdown lets a real HTTP server close when a client never drains a terminal frame', async t => {
  const registry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    drainTimeoutMs: 10_000,
    maxQueuedBytes: 16 * 1024 * 1024,
  })
  const requestHandled = deferred()
  let terminalWriteReturned
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const originalWrite = response.write.bind(response)
    response.write = (...args) => {
      terminalWriteReturned = originalWrite(...args)
      return terminalWriteReturned
    }
    registry.register('job-1', response, { replaying: false })
    registry.publish('job-1', {
      jobId: 'job-1',
      sequence: 1,
      timestamp: 1,
      type: 'done',
      padding: 'x'.repeat(8 * 1024 * 1024),
    })
    requestHandled.resolve()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const socket = createConnection({ host: '127.0.0.1', port: address.port })
  t.after(() => {
    registry.shutdown()
    socket.destroy()
    server.closeAllConnections?.()
    server.close()
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
  socket.pause()
  await requestHandled.promise

  assert.equal(terminalWriteReturned, false)
  assert.equal(registry.count('job-1'), 1)
  registry.shutdown()

  await Promise.race([
    new Promise(resolve => server.close(resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('HTTP server close remained blocked by the SSE response')),
      500,
    )),
  ])
})

test('heartbeat skips blocked subscribers, resumes after drain, and shutdown removes every listener', () => {
  const registry = createSseSubscriberRegistry({ heartbeatMs: 0 })
  const blocked = new FakeResponse((_chunk, writeNumber) => writeNumber !== 1)
  const writable = new FakeResponse()
  registry.register('job-1', blocked, { replaying: false })
  registry.register('job-1', writable, { replaying: false })

  registry.publish('job-1', payload(1))
  registry.pulseHeartbeat()
  assert.equal(blocked.writes.some(chunk => chunk === ': ping\n\n'), false)
  assert.equal(writable.writes.some(chunk => chunk === ': ping\n\n'), true)

  blocked.emit('drain')
  registry.pulseHeartbeat()
  assert.equal(blocked.writes.some(chunk => chunk === ': ping\n\n'), true)

  registry.shutdown()
  for (const response of [blocked, writable]) {
    assert.equal(response.endCalls, 1)
    assert.equal(response.listenerCount('drain'), 0)
    assert.equal(response.listenerCount('close'), 0)
    assert.equal(response.listenerCount('error'), 0)
  }
  assert.equal(registry.count(), 0)
})

test('replay includes an event that was enqueued but not yet persisted', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-pending-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const appendStarted = deferred()
  const releaseAppend = deferred()
  const finishQuery = deferred()
  let heldPendingAppend = false

  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (!heldPendingAppend && event.type === 'text' && event.text === 'pending') {
        heldPendingAppend = true
        appendStarted.resolve()
        await releaseAppend.promise
      }
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('pending')
      await finishQuery.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseAppend.resolve()
    finishQuery.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await appendStarted.promise

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  const replayed = writtenEvents(response)
  assert.equal(replayed.filter(event => event.type === 'text' && event.text === 'pending').length, 1)

  releaseAppend.resolve()
  finishQuery.resolve()
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'completed')
})

test('timeline append retry recovers transient failure without poisoning later writes', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-transient-append-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  let appendAttempts = 0

  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 3,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      appendAttempts += 1
      if (appendAttempts === 1) throw new Error('simulated transient append failure')
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('one')
      yield textDelta('two')
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'completed')

  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  const events = (await readFile(timelinePath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1))
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.text), ['one', 'two'])
  assert.equal(events.at(-1)?.type, 'done')
  assert.ok(appendAttempts > events.length)
  assert.deepEqual(manager.getPersistenceState(job.id), {
    failed: false,
    queuedEvents: 0,
    queuedBytes: 0,
  })
})

test('outcome-uncertain timeline append is verified instead of duplicating the sequence', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-uncertain-append-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  let firstAppend = true
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 3,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      await appendFile(path, data, 'utf8')
      if (firstAppend) {
        firstAppend = false
        throw new Error('simulated uncertain append outcome')
      }
    },
    claudeQuery: () => (async function* () {
      yield textDelta('only once')
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'completed')

  const events = (await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1))
  assert.equal(events.filter(event => event.type === 'text' && event.text === 'only once').length, 1)
})

test('outcome-uncertain partial terminal append never concatenates or publishes success', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-partial-terminal-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseProvider = deferred()
  let partialDoneInjected = false
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 2,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (event.type === 'done' && !partialDoneInjected) {
        partialDoneInjected = true
        await appendFile(path, data.slice(0, -1), 'utf8')
        throw new Error('simulated partial append without newline')
      }
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('before partial terminal')
      await releaseProvider.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseProvider.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(async () => (
    await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8')
  ).includes('before partial terminal'))

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  releaseProvider.resolve()
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'failed')
  await waitFor(() => (
    response.endCalls === 1
    && hasTerminalPair(writtenEvents(response))
  ))

  const streamed = writtenEvents(response)
  assert.deepEqual(streamed.slice(-2).map(event => event.type), ['error', 'done'])
  assert.match(streamed.at(-2)?.error, /partial append without newline|timeline persistence/i)
  assert.equal(streamed.filter(event => event.type === 'done').length, 1)

  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  const timelineText = await waitForDurableTerminal(timelinePath)
  assert.equal(timelineText.endsWith('\n'), true)
  const durable = timelineText.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(durable.map(event => event.sequence), durable.map((_, index) => index + 1))
  assert.deepEqual(durable.slice(-2).map(event => event.type), ['error', 'done'])
  assert.equal(durable.filter(event => event.type === 'done').length, 1)
})

test('outcome-uncertain append rejects a different record at the same sequence', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-conflicting-terminal-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseProvider = deferred()
  let conflictInjected = false
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 2,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (event.type === 'done' && !conflictInjected) {
        conflictInjected = true
        await appendFile(path, `${JSON.stringify({ ...event, type: 'text', text: 'wrong record' })}\n`, 'utf8')
        throw new Error('simulated conflicting append outcome')
      }
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('before conflicting terminal')
      await releaseProvider.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseProvider.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(async () => (
    await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8')
  ).includes('before conflicting terminal'))

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  releaseProvider.resolve()
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))
  await waitFor(() => (
    response.endCalls === 1
    && hasTerminalPair(writtenEvents(response))
  ))

  const streamed = writtenEvents(response)
  assert.deepEqual(streamed.slice(-2).map(event => event.type), ['error', 'done'])
  assert.equal(streamed.filter(event => event.type === 'done').length, 1)
  assert.equal((await manager.getJobState(job.id))?.status, 'failed')

  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  const timelineText = await waitForDurableTerminal(timelinePath)
  assert.equal(timelineText.endsWith('\n'), true)
  const durable = timelineText.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(durable.map(event => event.sequence), durable.map((_, index) => index + 1))
  assert.deepEqual(durable.slice(-2).map(event => event.type), ['error', 'done'])
  assert.equal(durable.filter(event => event.type === 'done').length, 1)
})

test('permanent timeline failure bounds pending state and stops a long provider stream fail-closed', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-permanent-append-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  let yielded = 0
  let providerFinalized = false
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineMaxQueuedEvents: 6,
    timelineMaxQueuedBytes: 2_048,
    timelineAppendMaxAttempts: 2,
    timelineAppendRetryDelayMs: 1,
    timelineAppend: async () => {
      throw new Error('simulated permanent append failure')
    },
    claudeQuery: () => (async function* () {
      try {
        for (let index = 0; index < 1_000; index += 1) {
          yielded += 1
          yield textDelta(`chunk-${index}`)
        }
      } finally {
        providerFinalized = true
      }
    })(),
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))

  const persistence = manager.getPersistenceState(job.id)
  assert.equal(persistence.failed, true)
  assert.match(persistence.error, /permanent append failure|queue limit/i)
  assert.equal(persistence.queuedEvents, 0)
  assert.equal(persistence.queuedBytes, 0)
  assert.ok(yielded < 1_000)
  assert.equal(providerFinalized, true)

  const state = await manager.getJobState(job.id)
  assert.equal(state.status, 'failed')
  assert.match(state.error, /timeline persistence/i)
  const durable = JSON.parse(await readFile(join(homeDir, 'jobs', `${job.id}.json`), 'utf8'))
  assert.notEqual(durable.status, 'completed')
})

test('done remains invisible until durable and append failure streams only the failure terminal', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-terminal-barrier-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseProvider = deferred()
  const doneAppendStarted = deferred()
  const releaseDoneAppend = deferred()
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 1,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (event.type === 'done') {
        doneAppendStarted.resolve()
        await releaseDoneAppend.promise
        throw new Error('simulated done persistence failure')
      }
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('before terminal')
      await releaseProvider.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseProvider.resolve()
    releaseDoneAppend.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  await waitFor(async () => (await readFile(timelinePath, 'utf8')).includes('"text":"before terminal"'))

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  releaseProvider.resolve()
  await doneAppendStarted.promise

  assert.equal(writtenEvents(response).some(event => event.type === 'done'), false)
  assert.equal(response.endCalls, 0)

  releaseDoneAppend.resolve()
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))
  const events = writtenEvents(response)
  assert.deepEqual(events.slice(-2).map(event => event.type), ['error', 'done'])
  assert.match(events.at(-2)?.error, /timeline persistence failed/i)
  assert.equal(events.filter(event => event.type === 'done').length, 1)
  assert.equal(response.endCalls, 1)

  const durableEvents = (await readFile(timelinePath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  assert.equal(durableEvents.some(event => event.type === 'done'), false)
  assert.equal((await manager.getJobState(job.id))?.status, 'failed')
})

test('terminal metadata failure prevents success publication and remains restart-recoverable', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-terminal-metadata-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseProvider = deferred()
  const terminalMetadataStarted = deferred()
  const releaseTerminalMetadata = deferred()
  let rejectCompletedMetadata = true
  const metadataWrites = []
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    metadataWrite: async (path, data) => {
      const metadata = JSON.parse(data)
      metadataWrites.push(metadata.status)
      if (rejectCompletedMetadata && metadata.status === 'completed') {
        rejectCompletedMetadata = false
        terminalMetadataStarted.resolve()
        await releaseTerminalMetadata.promise
        throw new Error('simulated terminal metadata failure')
      }
      await writeFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('before metadata failure')
      await releaseProvider.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  let restartedManager = null
  t.after(async () => {
    releaseProvider.resolve()
    releaseTerminalMetadata.resolve()
    await manager.shutdown()
    await restartedManager?.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(async () => (
    await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8')
  ).includes('before metadata failure'))

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  releaseProvider.resolve()
  await terminalMetadataStarted.promise
  assert.equal(writtenEvents(response).some(event => event.type === 'done'), false)
  assert.equal(response.endCalls, 0)
  const timelineBeforeMetadataFailure = await readFile(
    join(homeDir, 'timelines', `${job.id}.jsonl`),
    'utf8',
  )
  assert.equal(timelineBeforeMetadataFailure.includes('"type":"done"'), false)

  releaseTerminalMetadata.resolve()
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'failed')
  await waitFor(() => metadataWrites.includes('failed'))

  const streamed = writtenEvents(response)
  assert.deepEqual(streamed.slice(-2).map(event => event.type), ['error', 'done'])
  assert.match(streamed.at(-2)?.error, /terminal metadata failure|timeline persistence/i)
  assert.equal(streamed.filter(event => event.type === 'done').length, 1)
  assert.ok(metadataWrites.includes('completed'))
  assert.ok(metadataWrites.includes('failed'))

  const durableBeforeRestart = (await readFile(
    join(homeDir, 'timelines', `${job.id}.jsonl`),
    'utf8',
  )).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(durableBeforeRestart.slice(-2).map(event => event.type), ['error', 'done'])
  assert.equal(durableBeforeRestart.filter(event => event.type === 'done').length, 1)

  await manager.shutdown()
  restartedManager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  const replay = new FakeResponse()
  assert.equal(await restartedManager.streamJob(job.id, 0, replay), false)
  assert.deepEqual(writtenEvents(replay), durableBeforeRestart)
  assert.equal((await restartedManager.getJobState(job.id))?.status, 'failed')
})

test('terminal metadata rename failure removes the uncommitted success terminal before failure replay', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-terminal-rename-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseProvider = deferred()
  const appendedTypes = []
  let removeCompletedStage = true
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    metadataWrite: async (path, data) => {
      const metadata = JSON.parse(data)
      await writeFile(path, data, 'utf8')
      if (removeCompletedStage && metadata.status === 'completed') {
        removeCompletedStage = false
        await unlink(path)
      }
    },
    timelineAppend: async (path, data) => {
      appendedTypes.push(JSON.parse(data).type)
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('before terminal rename failure')
      await releaseProvider.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  let restartedManager = null
  t.after(async () => {
    releaseProvider.resolve()
    await manager.shutdown()
    await restartedManager?.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await waitFor(async () => (
    await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8')
  ).includes('before terminal rename failure'))

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  releaseProvider.resolve()
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))
  await waitFor(() => response.endCalls === 1)
  await waitFor(async () => {
    const events = (await readFile(
      join(homeDir, 'timelines', `${job.id}.jsonl`),
      'utf8',
    )).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    return events.at(-2)?.type === 'error' && events.at(-1)?.type === 'done'
  })

  assert.deepEqual(appendedTypes.slice(-3), ['done', 'error', 'done'])
  const streamed = writtenEvents(response)
  assert.deepEqual(streamed.slice(-2).map(event => event.type), ['error', 'done'])
  assert.match(streamed.at(-2)?.error, /terminal metadata commit failed/i)
  assert.equal(streamed.filter(event => event.type === 'done').length, 1)

  const durable = (await readFile(
    join(homeDir, 'timelines', `${job.id}.jsonl`),
    'utf8',
  )).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(durable.map(event => event.sequence), durable.map((_, index) => index + 1))
  assert.deepEqual(durable.slice(-2).map(event => event.type), ['error', 'done'])
  assert.equal(durable.filter(event => event.type === 'done').length, 1)
  assert.equal((await manager.getJobState(job.id))?.status, 'failed')

  await manager.shutdown()
  restartedManager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  const replay = new FakeResponse()
  assert.equal(await restartedManager.streamJob(job.id, 0, replay), false)
  assert.deepEqual(writtenEvents(replay), durable)
  assert.equal((await restartedManager.getJobState(job.id))?.status, 'failed')
})

test('restart replaces an active metadata record paired with an uncommitted success terminal', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-uncommitted-terminal-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'uncommitted-success-terminal'
  const old = new Date(0).toISOString()
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'running',
    lastSequence: 1,
    requestedAt: old,
    updatedAt: old,
    completedAt: null,
    error: null,
  }), 'utf8')
  const textEvent = {
    jobId,
    sequence: 1,
    timestamp: 1,
    type: 'text',
    text: 'before crash',
  }
  const uncommittedDone = {
    jobId,
    sequence: 2,
    timestamp: 2,
    type: 'done',
  }
  await writeFile(
    join(timelinesDir, `${jobId}.jsonl`),
    `${JSON.stringify(textEvent)}\n${JSON.stringify(uncommittedDone)}\n`,
    'utf8',
  )

  const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  let restartedManager = null
  t.after(async () => {
    await manager.shutdown()
    await restartedManager?.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(jobId, 0, response), false)
  const recovered = writtenEvents(response)
  assert.deepEqual(recovered.map(event => event.sequence), [1, 2, 3])
  assert.deepEqual(recovered.map(event => event.type), ['text', 'error', 'done'])
  assert.match(recovered[1].error, /terminal event was not committed by terminal metadata/i)
  const state = await manager.getJobState(jobId)
  assert.equal(state.status, 'failed')
  assert.equal(state.lastSequence, 3)

  const durable = (await readFile(
    join(timelinesDir, `${jobId}.jsonl`),
    'utf8',
  )).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(durable, recovered)
  assert.equal(durable.filter(event => event.type === 'done').length, 1)

  await manager.shutdown()
  restartedManager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  const replay = new FakeResponse()
  assert.equal(await restartedManager.streamJob(jobId, 0, replay), false)
  assert.deepEqual(writtenEvents(replay), durable)
})

test('failed-record cap evicts oldest payload state after durable fail-closed finalization', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-many-failures-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const retainedLimit = 3
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    maxConcurrentJobs: 1,
    timelineMaxQueuedEvents: 4,
    timelineMaxQueuedBytes: 1_024,
    timelineMaxFailedRecords: retainedLimit,
    timelineAppendMaxAttempts: 1,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async () => {
      throw new Error('storage unavailable')
    },
    claudeQuery: () => (async function* () {
      for (let index = 0; index < 100; index += 1) {
        yield textDelta(`chunk-${index}`)
      }
    })(),
  })
  let restartedManager = null
  t.after(async () => {
    await manager.shutdown()
    await restartedManager?.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const jobs = []
  for (let index = 0; index < 12; index += 1) {
    jobs.push(await manager.startJob({
      provider: 'claude',
      model: 'test',
      mode: 'bypassPermissions',
      workspaceDir,
      messages: [{ role: 'user', content: `go-${index}` }],
    }))
  }
  await waitFor(() => manager.listLiveJobIds().length === 0)

  const evicted = jobs.slice(0, -retainedLimit)
  const retained = jobs.slice(-retainedLimit)
  await waitFor(async () => (
    await Promise.all(evicted.map(job => manager.getJobState(job.id)))
  ).every(state => state?.status === 'failed' && state.timelinePersistenceFailed === true))

  for (const job of evicted) {
    assert.deepEqual(manager.getPersistenceState(job.id), {
      failed: false,
      queuedEvents: 0,
      queuedBytes: 0,
    })
    const state = await manager.getJobState(job.id)
    assert.equal(state.status, 'failed')
    assert.equal(state.timelinePersistenceFailed, true)
  }
  for (const job of retained) {
    const persistence = manager.getPersistenceState(job.id)
    assert.equal(persistence.failed, true)
    assert.equal(persistence.queuedEvents, 0)
    assert.equal(persistence.queuedBytes, 0)
    assert.equal((await manager.getJobState(job.id))?.status, 'failed')
  }

  await manager.shutdown()
  restartedManager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  for (const job of jobs) {
    const response = new FakeResponse()
    assert.equal(await restartedManager.streamJob(job.id, 0, response), false)
    assert.deepEqual(writtenEvents(response).slice(-2).map(event => event.type), ['error', 'done'])
    const state = await restartedManager.getJobState(job.id)
    assert.equal(state.status, 'failed')
    assert.match(state.error, /timeline persistence/i)
    assert.equal(state.timelinePersistenceFailed, false)
    const durableEvents = (await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.deepEqual(durableEvents.map(event => event.type), ['error', 'done'])
  }
})

test('failed-record cap remains bounded when best-effort finalization also fails', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-finalization-failures-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseTimelineFailure = deferred()
  const retainedLimit = 3
  let rejectMetadataWrites = false
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    maxConcurrentJobs: 1,
    timelineMaxFailedRecords: retainedLimit,
    timelineAppendMaxAttempts: 1,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async () => {
      await releaseTimelineFailure.promise
      throw new Error('timeline storage unavailable')
    },
    metadataWrite: async (path, data) => {
      if (rejectMetadataWrites) throw new Error('metadata storage unavailable')
      await writeFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('will fail persistence')
    })(),
  })
  let restartedManager = null
  t.after(async () => {
    releaseTimelineFailure.resolve()
    rejectMetadataWrites = false
    await manager.shutdown()
    await restartedManager?.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const jobs = []
  for (let index = 0; index < 12; index += 1) {
    jobs.push(await manager.startJob({
      provider: 'claude',
      model: 'test',
      mode: 'bypassPermissions',
      workspaceDir,
      messages: [{ role: 'user', content: `go-${index}` }],
    }))
  }

  rejectMetadataWrites = true
  releaseTimelineFailure.resolve()
  await waitFor(() => manager.listLiveJobIds().length === 0)
  const evicted = jobs.slice(0, -retainedLimit)
  const retained = jobs.slice(-retainedLimit)
  await waitFor(() => evicted.every(
    job => manager.getPersistenceState(job.id).failed === false,
  ))

  for (const job of evicted) {
    assert.deepEqual(manager.getPersistenceState(job.id), {
      failed: false,
      queuedEvents: 0,
      queuedBytes: 0,
    })
    const durable = JSON.parse(await readFile(join(homeDir, 'jobs', `${job.id}.json`), 'utf8'))
    assert.ok(durable.status === 'running' || durable.status === 'queued')
    assert.notEqual(durable.status, 'completed')
  }
  for (const job of retained) {
    assert.equal(manager.getPersistenceState(job.id).failed, true)
    assert.equal((await manager.getJobState(job.id))?.status, 'failed')
  }

  // Recovery starts from the truthful active metadata left behind when the
  // failure marker could not be written. No evicted job is resurrected active.
  await manager.shutdown()
  rejectMetadataWrites = false
  restartedManager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  for (const job of jobs) {
    const response = new FakeResponse()
    assert.equal(await restartedManager.streamJob(job.id, 0, response), false)
    assert.deepEqual(writtenEvents(response).slice(-2).map(event => event.type), ['error', 'done'])
    const recovered = await restartedManager.getJobState(job.id)
    assert.equal(recovered.status, 'failed')
    assert.match(recovered.error, /interrupted/i)
  }
})

test('failed-record eviction never removes the current live failure or its subscriber terminal', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-live-failure-cap-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseSecondProvider = deferred()
  let invocation = 0
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    maxConcurrentJobs: 1,
    timelineMaxFailedRecords: 1,
    timelineAppendMaxAttempts: 1,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async () => {
      throw new Error('storage unavailable')
    },
    claudeQuery: () => {
      invocation += 1
      const currentInvocation = invocation
      return (async function* () {
        if (currentInvocation === 2) await releaseSecondProvider.promise
        yield textDelta(`failure-${currentInvocation}`)
      })()
    },
  })
  t.after(async () => {
    releaseSecondProvider.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const first = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'first' }],
  })
  await waitFor(() => !manager.listLiveJobIds().includes(first.id))
  assert.equal(manager.getPersistenceState(first.id).failed, true)

  const second = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'second' }],
  })
  const response = new FakeResponse()
  assert.equal(await manager.streamJob(second.id, 0, response), true)
  assert.equal(manager.listLiveJobIds().includes(second.id), true)

  releaseSecondProvider.resolve()
  await waitFor(() => !manager.listLiveJobIds().includes(second.id))
  await waitFor(() => manager.getPersistenceState(first.id).failed === false)

  assert.deepEqual(writtenEvents(response).slice(-2).map(event => event.type), ['error', 'done'])
  assert.equal(manager.getPersistenceState(second.id).failed, true)
  assert.equal((await manager.getJobState(second.id))?.status, 'failed')
  const evictedState = await manager.getJobState(first.id)
  assert.equal(evictedState.status, 'failed')
  assert.equal(evictedState.timelinePersistenceFailed, true)
})

test('queued cancellation retains live failure context and participates in failed-record eviction', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-queued-cancel-failure-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseRunningProvider = deferred()
  const failedTimelinePaths = new Set()
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    maxConcurrentJobs: 1,
    timelineMaxFailedRecords: 1,
    timelineAppendMaxAttempts: 1,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      if (failedTimelinePaths.has(path)) throw new Error('queued cancellation storage failure')
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('occupying the only slot')
      await releaseRunningProvider.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  let running = null
  t.after(async () => {
    releaseRunningProvider.resolve()
    await waitFor(() => !manager.listLiveJobIds().includes(running?.id))
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  running = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'running' }],
  })
  await waitFor(async () => (
    await readFile(join(homeDir, 'timelines', `${running.id}.jsonl`), 'utf8')
  ).includes('occupying the only slot'))

  const queued = []
  for (const content of ['queued-one', 'queued-two']) {
    const job = await manager.startJob({
      provider: 'claude',
      model: 'test',
      mode: 'bypassPermissions',
      workspaceDir,
      messages: [{ role: 'user', content }],
    })
    assert.equal(job.status, 'queued')
    failedTimelinePaths.add(join(homeDir, 'timelines', `${job.id}.jsonl`))
    queued.push(job)
  }

  const responses = queued.map(() => new FakeResponse())
  for (let index = 0; index < queued.length; index += 1) {
    assert.equal(await manager.streamJob(queued[index].id, 0, responses[index]), true)
    assert.deepEqual(await manager.cancelJob(queued[index].id), { ok: true })
  }
  await waitFor(() => manager.getPersistenceState(queued[0].id).failed === false)

  for (const response of responses) {
    assert.deepEqual(writtenEvents(response).slice(-2).map(event => event.type), ['error', 'done'])
    assert.equal(response.endCalls, 1)
  }
  assert.equal(manager.listLiveJobIds().includes(queued[0].id), false)
  assert.equal(manager.listLiveJobIds().includes(queued[1].id), false)
  assert.equal(manager.getPersistenceState(queued[1].id).failed, true)
  assert.equal((await manager.getJobState(queued[1].id))?.status, 'failed')
  const evicted = await manager.getJobState(queued[0].id)
  assert.equal(evicted.status, 'failed')
  assert.equal(evicted.timelinePersistenceFailed, true)
})

test('replay buffers live and terminal events until drain, then emits each sequence exactly once', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-race-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseQuery = deferred()

  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    claudeQuery: () => (async function* () {
      yield textDelta('one')
      await releaseQuery.promise
      yield textDelta('two')
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseQuery.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  await waitFor(async () => (await readFile(timelinePath, 'utf8')).includes('"text":"one"'))

  let blockedData = false
  const response = new FakeResponse(chunk => {
    if (chunk.startsWith('data: ') && !blockedData) {
      blockedData = true
      return false
    }
    return true
  })
  const streamPromise = manager.streamJob(job.id, 0, response)
  await waitFor(() => writtenEvents(response).length === 1)

  releaseQuery.resolve()
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'completed')
  assert.deepEqual(writtenEvents(response).map(event => event.sequence), [1])

  response.emit('drain')
  assert.equal(await streamPromise, false)
  const events = writtenEvents(response)
  const sequences = events.map(event => event.sequence)
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  )
  assert.equal(new Set(sequences).size, sequences.length)
  assert.equal(events.filter(event => event.type === 'text' && event.text === 'one').length, 1)
  assert.equal(events.filter(event => event.type === 'text' && event.text === 'two').length, 1)
  assert.equal(events.filter(event => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(response.endCalls, 1)
})

test('completed timeline replay streams progressively under writable backpressure without truncation', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-history-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'history-job'
  const events = Array.from({ length: 50 }, (_, index) => ({
    jobId,
    sequence: index + 1,
    timestamp: index + 1,
    type: index === 49 ? 'done' : 'text',
    ...(index === 49 ? {} : { text: `line-${index + 1}` }),
  }))
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'completed',
    lastSequence: 50,
  }), 'utf8')
  await writeFile(
    join(timelinesDir, `${jobId}.jsonl`),
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )

  const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  let blockedData = false
  const response = new FakeResponse(chunk => {
    if (chunk.startsWith('data: ') && !blockedData) {
      blockedData = true
      return false
    }
    return true
  })
  const streamPromise = manager.streamJob(jobId, 0, response)
  await waitFor(() => writtenEvents(response).length === 1)
  assert.deepEqual(writtenEvents(response).map(event => event.sequence), [1])

  response.emit('drain')
  assert.equal(await streamPromise, false)
  assert.deepEqual(writtenEvents(response).map(event => event.sequence), events.map(event => event.sequence))
})

test('replay repairs strict timeline integrity violations into contiguous failure semantics', async t => {
  for (const scenario of [
    {
      name: 'malformed',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          '{"jobId":"broken"',
          JSON.stringify({ jobId, sequence: 3, timestamp: 3, type: 'done' }),
          '',
        ].join('\n')
      },
    },
    {
      name: 'gap',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          JSON.stringify({ jobId, sequence: 3, timestamp: 3, type: 'done' }),
          '',
        ].join('\n')
      },
    },
    {
      name: 'wrong-job',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          JSON.stringify({ jobId: 'different-job', sequence: 2, timestamp: 2, type: 'done' }),
          '',
        ].join('\n')
      },
    },
    {
      name: 'invalid-sequence',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          JSON.stringify({ jobId, sequence: 0, timestamp: 2, type: 'done' }),
          '',
        ].join('\n')
      },
    },
    {
      name: 'empty-record',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          '',
          JSON.stringify({ jobId, sequence: 3, timestamp: 3, type: 'done' }),
          '',
        ].join('\n')
      },
    },
    {
      name: 'post-terminal',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          JSON.stringify({ jobId, sequence: 2, timestamp: 2, type: 'done' }),
          JSON.stringify({ jobId, sequence: 3, timestamp: 3, type: 'text', text: 'late' }),
          '',
        ].join('\n')
      },
    },
    {
      name: 'incomplete-residue',
      lines(jobId) {
        return [
          JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
          '{"jobId":"incomplete"',
        ].join('\n')
      },
    },
  ]) {
    await t.test(scenario.name, async t => {
      const homeDir = await mkdtemp(join(tmpdir(), `codesurf-sse-${scenario.name}-replay-`))
      const jobsDir = join(homeDir, 'jobs')
      const timelinesDir = join(homeDir, 'timelines')
      await mkdir(jobsDir, { recursive: true })
      await mkdir(timelinesDir, { recursive: true })
      const jobId = `${scenario.name}-history-job`
      await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
        id: jobId,
        status: 'completed',
        lastSequence: 3,
        updatedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        error: null,
      }), 'utf8')
      await writeFile(join(timelinesDir, `${jobId}.jsonl`), scenario.lines(jobId), 'utf8')

      const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
      t.after(async () => {
        await manager.shutdown()
        await rm(homeDir, { recursive: true, force: true })
      })

      const response = new FakeResponse()
      assert.equal(await manager.streamJob(jobId, 0, response), false)
      const events = writtenEvents(response)
      assert.deepEqual(events.map(event => event.sequence), [1, 2, 3])
      assert.deepEqual(events.map(event => event.type), ['text', 'error', 'done'])
      assert.match(events[1].error, /timeline integrity/i)
      const state = await manager.getJobState(jobId)
      assert.equal(state.status, 'failed')
      assert.equal(state.lastSequence, 3)
      assert.match(state.error, /timeline integrity/i)

      const durable = (await readFile(join(timelinesDir, `${jobId}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      assert.deepEqual(durable, events)
    })
  }
})

test('blocked terminal history replay keeps its deadline and cannot hang real HTTP shutdown', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-http-replay-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'blocked-history-job'
  const doneEvent = {
    jobId,
    sequence: 1,
    timestamp: 1,
    type: 'done',
    padding: 'x'.repeat(8 * 1024 * 1024),
  }
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'completed',
    lastSequence: 1,
  }), 'utf8')
  await writeFile(join(timelinesDir, `${jobId}.jsonl`), `${JSON.stringify(doneEvent)}\n`, 'utf8')
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    subscriberMaxQueuedBytes: 16 * 1024 * 1024,
    subscriberDrainTimeoutMs: 10_000,
  })
  const requestHandled = deferred()
  let terminalWriteReturned
  const server = createServer(async (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const originalWrite = response.write.bind(response)
    response.write = (...args) => {
      const result = originalWrite(...args)
      if (String(args[0]).startsWith('data: ')) terminalWriteReturned = result
      return result
    }
    const keepOpen = await manager.streamJob(jobId, 0, response)
    if (!keepOpen) response.end()
    requestHandled.resolve()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const socket = createConnection({ host: '127.0.0.1', port: address.port })
  t.after(async () => {
    await manager.shutdown()
    socket.destroy()
    server.closeAllConnections?.()
    server.close()
    await rm(homeDir, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
  socket.pause()
  await requestHandled.promise

  assert.equal(terminalWriteReturned, false)
  await manager.shutdown()
  await Promise.race([
    new Promise(resolve => server.close(resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('HTTP server close remained blocked by replayed terminal history')),
      500,
    )),
  ])
})

test('restart reconciliation persists one terminal pair exactly once across concurrent and repeated opens', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-reconcile-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'interrupted-job'
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'running',
    lastSequence: 2,
    updatedAt: new Date(0).toISOString(),
    completedAt: null,
    error: null,
  }), 'utf8')
  await writeFile(join(timelinesDir, `${jobId}.jsonl`), [
    JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
    JSON.stringify({ jobId, sequence: 2, timestamp: 2, type: 'text', text: 'two' }),
    '',
  ].join('\n'), 'utf8')

  const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const first = new FakeResponse()
  const second = new FakeResponse()
  await Promise.all([
    manager.streamJob(jobId, 0, first),
    manager.streamJob(jobId, 0, second),
  ])

  const durableState = JSON.parse(await readFile(join(jobsDir, `${jobId}.json`), 'utf8'))
  assert.equal(durableState.status, 'failed')
  assert.equal(durableState.lastSequence, 4)
  assert.match(durableState.error, /daemon restarted/i)
  const durableEvents = (await readFile(join(timelinesDir, `${jobId}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(durableEvents.map(event => event.sequence), [1, 2, 3, 4])
  assert.equal(durableEvents.filter(event => event.type === 'error').length, 1)
  assert.equal(durableEvents.filter(event => event.type === 'done').length, 1)
  assert.deepEqual(writtenEvents(first), durableEvents)
  assert.deepEqual(writtenEvents(second), durableEvents)

  const repeated = new FakeResponse()
  await manager.streamJob(jobId, 0, repeated)
  assert.deepEqual(writtenEvents(repeated), durableEvents)

  const farAhead = new FakeResponse()
  await manager.streamJob(jobId, 999_999, farAhead)
  assert.deepEqual(writtenEvents(farAhead), [])
  const stateAfterFarAhead = JSON.parse(await readFile(join(jobsDir, `${jobId}.json`), 'utf8'))
  assert.equal(stateAfterFarAhead.lastSequence, 4)
})

test('restart reconciliation preserves an existing provider error when only done was lost', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-real-error-reconcile-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'provider-error-job'
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'running',
    lastSequence: 2,
    completedAt: null,
    error: 'provider exploded',
  }), 'utf8')
  await writeFile(join(timelinesDir, `${jobId}.jsonl`), [
    JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' }),
    JSON.stringify({ jobId, sequence: 2, timestamp: 2, type: 'error', error: 'provider exploded' }),
    '',
  ].join('\n'), 'utf8')
  const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const response = new FakeResponse()
  await manager.streamJob(jobId, 0, response)
  const events = (await readFile(join(timelinesDir, `${jobId}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.type), ['text', 'error', 'done'])
  assert.equal(events.filter(event => event.type === 'error').length, 1)
  assert.equal(events[1].error, 'provider exploded')
  const metadata = JSON.parse(await readFile(join(jobsDir, `${jobId}.json`), 'utf8'))
  assert.equal(metadata.status, 'failed')
  assert.equal(metadata.error, 'provider exploded')
  assert.equal(metadata.lastSequence, 3)
})

test('restart reconciliation resumes after a partial terminal append without duplicating its error', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-partial-reconcile-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'partially-reconciled-job'
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'running',
    lastSequence: 1,
    completedAt: null,
    error: null,
  }), 'utf8')
  await writeFile(
    join(timelinesDir, `${jobId}.jsonl`),
    `${JSON.stringify({ jobId, sequence: 1, timestamp: 1, type: 'text', text: 'one' })}\n`,
    'utf8',
  )
  let blockDone = true
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 2,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (blockDone && event.type === 'done') throw new Error('done append unavailable')
      await appendFile(path, data, 'utf8')
    },
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  await assert.rejects(
    manager.streamJob(jobId, 0, new FakeResponse()),
    /done append unavailable/,
  )
  const stillActive = JSON.parse(await readFile(join(jobsDir, `${jobId}.json`), 'utf8'))
  assert.equal(stillActive.status, 'running')

  blockDone = false
  const recovered = new FakeResponse()
  await manager.streamJob(jobId, 0, recovered)
  const durableEvents = (await readFile(join(timelinesDir, `${jobId}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(durableEvents.map(event => event.type), ['text', 'error', 'done'])
  assert.deepEqual(durableEvents.map(event => event.sequence), [1, 2, 3])
  assert.deepEqual(writtenEvents(recovered), durableEvents)
  const terminal = JSON.parse(await readFile(join(jobsDir, `${jobId}.json`), 'utf8'))
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.lastSequence, 3)
})

test('startup retention reconciles stale active artifacts without opening SSE and preserves live jobs', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-startup-retention-'))
  const workspaceDir = join(homeDir, 'workspace')
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const old = new Date(0).toISOString()
  for (let index = 0; index < 6; index += 1) {
    const id = `stale-active-${index}`
    await writeFile(join(jobsDir, `${id}.json`), JSON.stringify({
      id,
      status: index % 2 === 0 ? 'running' : 'queued',
      lastSequence: 0,
      requestedAt: old,
      updatedAt: old,
      completedAt: null,
      error: null,
    }), 'utf8')
    await writeFile(join(timelinesDir, `${id}.jsonl`), '', 'utf8')
  }
  const reconciledId = 'stale-active-reconciled'
  const recent = new Date().toISOString()
  await writeFile(join(jobsDir, `${reconciledId}.json`), JSON.stringify({
    id: reconciledId,
    status: 'running',
    lastSequence: 0,
    requestedAt: recent,
    updatedAt: recent,
    completedAt: null,
    error: null,
  }), 'utf8')
  await writeFile(join(timelinesDir, `${reconciledId}.jsonl`), '', 'utf8')

  const releaseLive = deferred()
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    claudeQuery: () => (async function* () {
      yield textDelta('still live')
      await releaseLive.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  let liveJob = null
  t.after(async () => {
    releaseLive.resolve()
    if (liveJob) await waitFor(() => !manager.listLiveJobIds().includes(liveJob.id))
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  liveJob = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'stay live' }],
  })
  await waitFor(async () => (
    await readFile(join(timelinesDir, `${liveJob.id}.jsonl`), 'utf8')
  ).includes('still live'))

  const result = await manager.sweepJobRetention({ maxAgeMs: 1, keepRecent: 1 })
  assert.equal(result.pruned, 6)
  for (let index = 0; index < 6; index += 1) {
    const id = `stale-active-${index}`
    await assert.rejects(readFile(join(jobsDir, `${id}.json`), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(join(timelinesDir, `${id}.jsonl`), 'utf8'), { code: 'ENOENT' })
  }
  const reconciledMetadata = JSON.parse(
    await readFile(join(jobsDir, `${reconciledId}.json`), 'utf8'),
  )
  assert.equal(reconciledMetadata.status, 'failed')
  const reconciledTimeline = (await readFile(
    join(timelinesDir, `${reconciledId}.jsonl`),
    'utf8',
  )).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(reconciledTimeline.map(event => event.sequence), [1, 2])
  assert.deepEqual(reconciledTimeline.map(event => event.type), ['error', 'done'])
  assert.equal(manager.listLiveJobIds().includes(liveJob.id), true)
  assert.equal((await manager.getJobState(liveJob.id))?.status, 'running')
})

test('startup retention prunes old non-live active artifacts when reconciliation storage fails', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-retention-failed-reconcile-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'stale-active-storage-failure'
  const old = new Date(0).toISOString()
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'running',
    lastSequence: 0,
    requestedAt: old,
    updatedAt: old,
    completedAt: null,
    error: null,
  }), 'utf8')
  await writeFile(join(timelinesDir, `${jobId}.jsonl`), '', 'utf8')
  let appendAttempts = 0
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppendMaxAttempts: 2,
    timelineAppendRetryDelayMs: 0,
    timelineAppend: async () => {
      appendAttempts += 1
      throw new Error('reconciliation storage unavailable')
    },
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const result = await manager.sweepJobRetention({ maxAgeMs: 1, keepRecent: 0 })
  assert.equal(result.pruned, 1)
  assert.equal(appendAttempts, 2)
  await assert.rejects(readFile(join(jobsDir, `${jobId}.json`), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(timelinesDir, `${jobId}.jsonl`), 'utf8'), { code: 'ENOENT' })
})

test('startup retention does not scan healthy terminal timeline history', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-retention-no-terminal-scan-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'healthy-terminal'
  const doneEvent = {
    jobId,
    sequence: 1,
    timestamp: 1,
    type: 'done',
  }
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'completed',
    lastSequence: 1,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: null,
  }), 'utf8')
  await writeFile(join(timelinesDir, `${jobId}.jsonl`), `${JSON.stringify(doneEvent)}\n`, 'utf8')
  let timelineScans = 0
  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineReadStream() {
      timelineScans += 1
      throw new Error('healthy terminal timeline should not be scanned by retention')
    },
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const result = await manager.sweepJobRetention({
    maxAgeMs: 24 * 60 * 60 * 1000,
    keepRecent: 0,
  })
  assert.equal(result.pruned, 0)
  assert.equal(timelineScans, 0)
  assert.equal((await manager.getJobState(jobId))?.status, 'completed')
})
