import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonClient } from '@codesurf/daemon/client'

function makeClient(calls) {
  return createDaemonClient({
    ensureRunning: async () => ({
      pid: 123,
      port: 4567,
      token: 'secret-token',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 1,
      appVersion: 'test',
    }),
    getStatus: async () => ({ running: true, info: null }),
    invalidate: () => {
      calls.invalidated = true
    },
    requestTimeoutMs: 25,
  })
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('typed chat-job client methods call daemon routes with bearer auth', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url))
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push({ url: String(url), path: parsed.pathname, search: parsed.search, options, body })
    assert.equal(options.headers.Authorization, 'Bearer secret-token')
    assert.equal(parsed.searchParams.has('token'), false)

    if (parsed.pathname === '/chat/job/start') return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
    if (parsed.pathname === '/chat/job/state') return jsonResponse({ id: parsed.searchParams.get('jobId'), status: 'completed', lastSequence: 2 })
    if (parsed.pathname === '/chat/job/cancel') return jsonResponse({ ok: true })
    if (parsed.pathname === '/chat/job/permission/answer') return jsonResponse({ ok: true })
    throw new Error(`unexpected path ${parsed.pathname}`)
  }

  const client = makeClient(calls)
  await client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  await client.getJobState('job-1')
  await client.cancelJob('job-1')
  await client.answerPermission({ jobId: 'job-1', toolId: 'tool-1', decision: 'once' })

  assert.deepEqual(calls.map(call => call.path), [
    '/chat/job/start',
    '/chat/job/state',
    '/chat/job/cancel',
    '/chat/job/permission/answer',
  ])
  // D1: startChatJob injects a generated startRequestId idempotency key.
  assert.equal(typeof calls[0].body.request.startRequestId, 'string')
  assert.ok(calls[0].body.request.startRequestId.length > 0)
  const { startRequestId, ...requestWithoutIdempotencyKey } = calls[0].body.request
  assert.deepEqual(requestWithoutIdempotencyKey, {
    provider: 'claude',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(calls[1].search, '?jobId=job-1')
  assert.deepEqual(calls[2].body, { jobId: 'job-1' })
  assert.deepEqual(calls[3].body, { jobId: 'job-1', toolId: 'tool-1', decision: 'once' })
})

test('streamJobEvents parses SSE without putting bearer token in the URL', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const parsed = new URL(String(url))
    assert.equal(parsed.pathname, '/chat/job/events')
    assert.equal(parsed.searchParams.get('jobId'), 'job-1')
    assert.equal(parsed.searchParams.get('since'), '3')
    assert.equal(parsed.searchParams.has('token'), false)
    assert.equal(options.headers.Authorization, 'Bearer secret-token')
    assert.equal(options.headers.Accept, 'text/event-stream')

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"jobId":"job-1","sequence":4,"timestamp":1,"type":"text","text":"hi"}\n\n'))
        controller.enqueue(encoder.encode(': ping\n\n'))
        controller.enqueue(encoder.encode('data: {"jobId":"job-1","sequence":5,"timestamp":2,"type":"done"}\n\n'))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const client = makeClient(calls)
  const events = []
  await client.streamJobEvents({
    jobId: 'job-1',
    since: 3,
    onEvent: event => {
      events.push(event)
    },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(events.map(event => event.type), ['text', 'done'])
  assert.equal(events[0].text, 'hi')
})

test('streamJobEvents cancels an oversized non-OK diagnostic body without retrying its status', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  let cancelled = false
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(256 * 1024)))
      },
      cancel() {
        cancelled = true
      },
    }), {
      status: 500,
      headers: { 'Content-Length': String(256 * 1024) },
    })
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.streamJobEvents({ jobId: 'job-1', onEvent() {} }),
    /Response body omitted: exceeds 65536 bytes/i,
  )
  assert.equal(calls.length, 1)
  assert.equal(cancelled, true)
})

test('streamJobEvents terminates instead of reconnecting after a delimiter-free frame overflow', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  let cancelled = false
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(1024 * 1024)}`))
      },
      cancel() {
        cancelled = true
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.streamJobEvents({ jobId: 'job-1', onEvent() {} }),
    /frame limit exceeded/i,
  )
  assert.equal(calls.length, 1)
  assert.equal(cancelled, true)
})

test('streamJobEvents reconnects active EOF from the last delivered sequence and deduplicates replay', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const encoder = new TextEncoder()
  let streamAttempt = 0
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url))
    calls.push({ path: parsed.pathname, since: parsed.searchParams.get('since'), options })
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 4 })
    }
    assert.equal(parsed.pathname, '/chat/job/events')
    streamAttempt += 1
    const chunks = streamAttempt === 1
      ? [
          'data: {"jobId":"job-1","sequence":4,"timestamp":1,"type":"text","text":"first"}\n\n',
        ]
      : [
          'data: {"jobId":"job-1","sequence":4,"timestamp":1,"type":"text","text":"duplicate"}\n\n',
          'data: {"jobId":"job-1","sequence":5,"timestamp":2,"type":"text","text":"second"}\n\n',
          'data: {"jobId":"job-1","sequence":6,"timestamp":3,"type":"done"}\n\n',
        ]
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  const events = []
  await client.streamJobEvents({
    jobId: 'job-1',
    since: 3,
    reconnectDelayMs: 0,
    onEvent: event => {
      events.push(event)
    },
  })

  assert.deepEqual(events.map(event => event.sequence), [4, 5, 6])
  assert.deepEqual(
    calls.filter(call => call.path === '/chat/job/events').map(call => call.since),
    ['3', '4'],
  )
  assert.equal(calls.filter(call => call.path === '/chat/job/state').length, 1)
})

test('streamJobEvents recovers a transient sequence gap from the last contiguous event', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const encoder = new TextEncoder()
  let streamAttempt = 0
  globalThis.fetch = async url => {
    const parsed = new URL(String(url))
    calls.push({ path: parsed.pathname, since: parsed.searchParams.get('since') })
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 3 })
    }
    streamAttempt += 1
    const chunks = streamAttempt === 1
      ? [
          'data: {"jobId":"job-1","sequence":1,"timestamp":1,"type":"text","text":"one"}\n\n',
          'data: {"jobId":"job-1","sequence":3,"timestamp":3,"type":"done"}\n\n',
        ]
      : [
          'data: {"jobId":"job-1","sequence":2,"timestamp":2,"type":"text","text":"two"}\n\n',
          'data: {"jobId":"job-1","sequence":3,"timestamp":3,"type":"done"}\n\n',
        ]
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  const events = []
  await client.streamJobEvents({
    jobId: 'job-1',
    reconnectDelayMs: 0,
    onEvent(event) {
      events.push(event)
    },
  })

  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3])
  assert.deepEqual(
    calls.filter(call => call.path === '/chat/job/events').map(call => call.since),
    ['0', '1'],
  )
})

test('streamJobEvents never acknowledges or delivers done across a persistent sequence gap', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const encoder = new TextEncoder()
  globalThis.fetch = async url => {
    const parsed = new URL(String(url))
    calls.push({ path: parsed.pathname, since: parsed.searchParams.get('since') })
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'completed', lastSequence: 3 })
    }
    const since = Number(parsed.searchParams.get('since') ?? 0)
    const chunks = since === 0
      ? [
          'data: {"jobId":"job-1","sequence":1,"timestamp":1,"type":"text","text":"one"}\n\n',
          'data: {"jobId":"job-1","sequence":3,"timestamp":3,"type":"done"}\n\n',
        ]
      : ['data: {"jobId":"job-1","sequence":3,"timestamp":3,"type":"done"}\n\n']
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  const events = []
  await assert.rejects(
    client.streamJobEvents({
      jobId: 'job-1',
      maxReconnectAttempts: 3,
      reconnectDelayMs: 0,
      onEvent(event) {
        events.push(event)
      },
    }),
    /sequence gap for job job-1: expected 2, received 3/i,
  )

  assert.deepEqual(events.map(event => event.sequence), [1])
  assert.equal(events.some(event => event.type === 'done'), false)
  assert.deepEqual(
    calls.filter(call => call.path === '/chat/job/events').map(call => call.since),
    ['0', '1'],
  )
})

test('streamJobEvents rejects a recorded gap when terminal metadata is stale', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const encoder = new TextEncoder()
  globalThis.fetch = async url => {
    const parsed = new URL(String(url))
    calls.push(parsed.pathname)
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'completed', lastSequence: 1 })
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"jobId":"job-1","sequence":1,"timestamp":1,"type":"text","text":"one"}\n\n',
        ))
        controller.enqueue(encoder.encode(
          'data: {"jobId":"job-1","sequence":3,"timestamp":3,"type":"done"}\n\n',
        ))
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  const events = []
  await assert.rejects(
    client.streamJobEvents({
      jobId: 'job-1',
      reconnectDelayMs: 0,
      onEvent(event) {
        events.push(event)
      },
    }),
    /sequence gap/i,
  )

  assert.deepEqual(events.map(event => event.sequence), [1])
  assert.equal(events.some(event => event.type === 'done'), false)
  assert.equal(calls.filter(path => path === '/chat/job/events').length, 1)
  assert.equal(calls.filter(path => path === '/chat/job/state').length, 1)
})

test('streamJobEvents performs one terminal catch-up replay and delivers failed error plus done', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const encoder = new TextEncoder()
  let streamAttempt = 0
  globalThis.fetch = async url => {
    const parsed = new URL(String(url))
    calls.push({ path: parsed.pathname, since: parsed.searchParams.get('since') })
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'failed', lastSequence: 6 })
    }
    streamAttempt += 1
    const chunks = streamAttempt === 1
      ? ['data: {"jobId":"job-1","sequence":4,"timestamp":1,"type":"text","text":"before failure"}\n\n']
      : [
          'data: {"jobId":"job-1","sequence":5,"timestamp":2,"type":"error","error":"provider failed"}\n\n',
          'data: {"jobId":"job-1","sequence":6,"timestamp":3,"type":"done"}\n\n',
        ]
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  const events = []
  await client.streamJobEvents({
    jobId: 'job-1',
    since: 3,
    maxReconnectAttempts: 0,
    reconnectDelayMs: 0,
    onEvent: event => {
      events.push(event)
    },
  })

  assert.deepEqual(events.map(event => event.type), ['text', 'error', 'done'])
  assert.deepEqual(events.map(event => event.sequence), [4, 5, 6])
  assert.deepEqual(
    calls.filter(call => call.path === '/chat/job/events').map(call => call.since),
    ['3', '4'],
  )
  assert.equal(calls.filter(call => call.path === '/chat/job/state').length, 1)
})

test('streamJobEvents bounds terminal catch-up to one replay when the terminal frame stays missing', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async url => {
    const parsed = new URL(String(url))
    calls.push(parsed.pathname)
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'completed', lastSequence: 1 })
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.streamJobEvents({
      jobId: 'job-1',
      maxReconnectAttempts: 10,
      reconnectDelayMs: 0,
      onEvent() {},
    }),
    /terminal replay ended before delivering the terminal event/i,
  )

  assert.equal(calls.filter(path => path === '/chat/job/events').length, 2)
  assert.equal(calls.filter(path => path === '/chat/job/state').length, 1)
})

test('streamJobEvents cancels and releases the reader when a consumer callback fails', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  let cancelCalls = 0
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const encoder = new TextEncoder()
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"jobId":"job-1","sequence":1,"timestamp":1,"type":"text","text":"hello"}\n\n',
      ))
    },
    cancel() {
      cancelCalls += 1
    },
  }), { status: 200 })

  const client = makeClient(calls)
  await assert.rejects(
    client.streamJobEvents({
      jobId: 'job-1',
      reconnectDelayMs: 0,
      onEvent() {
        throw new Error('consumer failed')
      },
    }),
    /consumer failed/,
  )
  assert.equal(cancelCalls, 1)
})

test('streamJobEvents bounds active EOF reconnect attempts and never busy-loops', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    calls.push(parsed.pathname)
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.close()
      },
    }), { status: 200 })
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.streamJobEvents({
      jobId: 'job-1',
      maxReconnectAttempts: 2,
      reconnectDelayMs: 1,
      onEvent() {},
    }),
    /ended unexpectedly/i,
  )

  assert.equal(calls.filter(path => path === '/chat/job/events').length, 3)
  assert.equal(calls.filter(path => path === '/chat/job/state').length, 3)
})

test('streamJobEvents aborts reconnect backoff without issuing another request', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    calls.push(parsed.pathname)
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.close()
      },
    }), { status: 200 })
  }

  const controller = new AbortController()
  const client = makeClient(calls)
  const streamPromise = client.streamJobEvents({
    jobId: 'job-1',
    signal: controller.signal,
    maxReconnectAttempts: 3,
    reconnectDelayMs: 10_000,
    onEvent() {},
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort()

  await assert.rejects(streamPromise, error => error?.name === 'AbortError')
  assert.equal(calls.filter(path => path === '/chat/job/events').length, 1)
})

test('streamJobEvents aborts promptly while daemon startup is slow and observes the abandoned startup rejection', async t => {
  const originalFetch = globalThis.fetch
  const fetchCalls = []
  const unhandled = []
  let rejectStartup
  const startup = new Promise((_, reject) => {
    rejectStartup = reject
  })
  const onUnhandled = reason => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    globalThis.fetch = originalFetch
    process.off('unhandledRejection', onUnhandled)
  })
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args)
    throw new Error('fetch should not run')
  }
  const client = createDaemonClient({
    ensureRunning: () => startup,
    getStatus: async () => ({ running: false, info: null }),
    invalidate() {},
  })
  const controller = new AbortController()
  const startedAt = Date.now()
  const stream = client.streamJobEvents({
    jobId: 'job-1',
    signal: controller.signal,
    onEvent() {},
  })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(stream, error => error?.name === 'AbortError')
  assert.ok(Date.now() - startedAt < 250)
  assert.equal(fetchCalls.length, 0)

  rejectStartup(new Error('late startup failure'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(unhandled, [])
})

test('request aborts promptly while daemon startup is slow', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    throw new Error('fetch should not run')
  }
  const startup = new Promise(() => {})
  const client = createDaemonClient({
    ensureRunning: () => startup,
    getStatus: async () => ({ running: false, info: null }),
    invalidate() {},
  })
  const controller = new AbortController()
  const request = client.request('/chat/job/state?jobId=job-1', {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(request, error => error?.name === 'AbortError')
  assert.equal(fetchCalled, false)
})

test('request aborts promptly while daemon status recovery is slow and observes its late rejection', async t => {
  const originalFetch = globalThis.fetch
  const unhandled = []
  let markStatusStarted
  let rejectStatus
  const statusStarted = new Promise(resolve => {
    markStatusStarted = resolve
  })
  const pendingStatus = new Promise((_, reject) => {
    rejectStatus = reject
  })
  const onUnhandled = reason => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    globalThis.fetch = originalFetch
    process.off('unhandledRejection', onUnhandled)
  })
  globalThis.fetch = async () => {
    throw new Error('transport unavailable')
  }
  const client = createDaemonClient({
    ensureRunning: async () => ({
      pid: 123,
      port: 4567,
      token: 'secret-token',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 1,
      appVersion: 'test',
    }),
    getStatus: () => {
      markStatusStarted()
      return pendingStatus
    },
    invalidate() {},
  })
  const controller = new AbortController()
  const request = client.request('/chat/job/state?jobId=job-1', {
    signal: controller.signal,
  })
  await statusStarted
  controller.abort()

  await assert.rejects(request, error => error?.name === 'AbortError')
  rejectStatus(new Error('late status failure'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(unhandled, [])
})

test('streamJobEvents aborts promptly while post-EOF status recovery is slow', async t => {
  const originalFetch = globalThis.fetch
  let markStatusStarted
  const statusStarted = new Promise(resolve => {
    markStatusStarted = resolve
  })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async url => {
    const parsed = new URL(String(url))
    if (parsed.pathname === '/chat/job/state') {
      return jsonResponse({ error: 'job state unavailable' }, 404)
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.close()
      },
    }), { status: 200 })
  }
  const client = createDaemonClient({
    ensureRunning: async () => ({
      pid: 123,
      port: 4567,
      token: 'secret-token',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 1,
      appVersion: 'test',
    }),
    getStatus: () => {
      markStatusStarted()
      return new Promise(() => {})
    },
    invalidate() {},
  })
  const controller = new AbortController()
  const stream = client.streamJobEvents({
    jobId: 'job-1',
    signal: controller.signal,
    reconnectDelayMs: 0,
    onEvent() {},
  })
  await statusStarted
  controller.abort()

  await assert.rejects(stream, error => error?.name === 'AbortError')
})

test('never-settling reader cancellation cannot block terminal or consumer-error settlement', async t => {
  const originalFetch = globalThis.fetch
  const unhandled = []
  let fetchAttempt = 0
  let rejectFirstCancel
  const firstCancel = new Promise((_, reject) => {
    rejectFirstCancel = reject
  })
  const onUnhandled = reason => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    globalThis.fetch = originalFetch
    process.off('unhandledRejection', onUnhandled)
  })

  const encoder = new TextEncoder()
  globalThis.fetch = async () => {
    fetchAttempt += 1
    const terminal = fetchAttempt === 1
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(terminal
          ? 'data: {"jobId":"job-1","sequence":1,"timestamp":1,"type":"done"}\n\n'
          : 'data: {"jobId":"job-2","sequence":1,"timestamp":1,"type":"text","text":"hello"}\n\n'))
      },
      cancel() {
        return terminal ? firstCancel : new Promise(() => {})
      },
    }), { status: 200 })
  }

  const client = makeClient([])
  await Promise.race([
    client.streamJobEvents({
      jobId: 'job-1',
      onEvent() {},
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('terminal settlement waited for reader.cancel()')),
      250,
    )),
  ])

  await assert.rejects(
    Promise.race([
      client.streamJobEvents({
        jobId: 'job-2',
        onEvent() {
          throw new Error('consumer failed promptly')
        },
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('consumer error waited for reader.cancel()')),
        250,
      )),
    ]),
    /consumer failed promptly/,
  )

  rejectFirstCancel(new Error('late cancel failure'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(unhandled, [])
})

test('read-only daemon requests retry once after a transient response', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    if (calls.length === 1) return jsonResponse({ error: 'temporarily unavailable' }, 503)
    return jsonResponse({ id: 'job-1', status: 'completed', lastSequence: 2 })
  }

  const client = makeClient(calls)
  const state = await client.getJobState('job-1')

  assert.equal(state.id, 'job-1')
  assert.equal(calls.length, 2)
  assert.equal(calls.invalidated, true)
})

test('startChatJob never retries when delivery times out', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    throw new DOMException('request timed out', 'TimeoutError')
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    /outcome is unknown.*check daemon state before retrying/i,
  )
  assert.equal(calls.length, 1)
})

test('startChatJob never retries a transient HTTP response', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    return jsonResponse({ error: 'temporarily unavailable' }, 503)
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  )
  assert.equal(calls.length, 1)
})

test('startChatJob reports an actionable unknown outcome for HTTP 408 without retrying', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    return jsonResponse({ error: 'request timed out after delivery' }, 408)
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    error => {
      assert.match(error.message, /outcome is unknown.*check daemon state before retrying/i)
      assert.equal(error.status, 408)
      assert.equal(error.cause?.status, 408)
      return true
    },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls.invalidated, true)
})

test('cancel and permission mutations use the declared no-retry policy', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url) => {
    calls.push(new URL(String(url)).pathname)
    return jsonResponse({ error: 'temporarily unavailable' }, 503)
  }

  const client = makeClient(calls)
  await assert.rejects(client.cancelJob('job-1'))
  await assert.rejects(client.answerPermission({
    jobId: 'job-1',
    toolId: 'tool-1',
    decision: 'once',
  }))

  assert.deepEqual([...calls], [
    '/chat/job/cancel',
    '/chat/job/permission/answer',
  ])
  assert.equal(calls.invalidated, true)
})

// D1: startChatJob injects a client-generated idempotency key so a caller
// that retries the mutation after an unknown outcome (lost response, manual
// retry after a timeout error) can resend the exact same startRequestId and
// have the daemon coalesce onto the job the first attempt created.
test('D1: startChatJob generates a startRequestId when the caller omits one', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push(body)
    return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
  }

  const client = makeClient(calls)
  await client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] })

  const startRequestId = calls[0].request.startRequestId
  assert.equal(typeof startRequestId, 'string')
  assert.ok(startRequestId.length > 0)
})

test('D1: a caller-supplied startRequestId is sent unchanged', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push(body)
    return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
  }

  const client = makeClient(calls)
  await client.startChatJob({
    provider: 'claude',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    startRequestId: 'caller-key-1',
  })

  assert.equal(calls[0].request.startRequestId, 'caller-key-1')
})

test('D1: separate startChatJob calls get distinct startRequestIds', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push(body)
    return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
  }

  const client = makeClient(calls)
  const requestBody = { provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] }
  await client.startChatJob(requestBody)
  await client.startChatJob(requestBody)

  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].request.startRequestId, calls[1].request.startRequestId)
})
