import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BoundedSseJsonDecoder,
  DaemonChatEventBudget,
  sanitizeDaemonChatJobEvent,
  parseSseJsonBuffer,
} from '@codesurf/daemon/sse'

test('SSE parser preserves existing daemon chat data-line behavior', () => {
  const input = [
    ': ping',
    '',
    'event: ignored',
    'data: {"type":"text","text":"hello"}',
    '',
    'data: {bad json}',
    '',
    'data: {"type":"tool_summary",',
    'data: "text":"ok"}',
    '',
    'data: {"type":"partial"}',
  ].join('\n')

  const parsed = parseSseJsonBuffer(input)

  assert.deepEqual(parsed.events, [
    { type: 'text', text: 'hello' },
    { type: 'tool_summary', text: 'ok' },
  ])
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.remaining, 'data: {"type":"partial"}')
})

test('SSE parser keeps split chunks resumable', () => {
  const first = parseSseJsonBuffer('data: {"type":"text"')
  assert.deepEqual(first.events, [])
  assert.equal(first.remaining, 'data: {"type":"text"')

  const second = parseSseJsonBuffer(`${first.remaining},"text":"hi"}\n\n`)
  assert.deepEqual(second.events, [{ type: 'text', text: 'hi' }])
  assert.equal(second.remaining, '')
})

test('SSE parser rejects delimiter-free and complete frames above the byte limit', () => {
  assert.throws(
    () => parseSseJsonBuffer(`data: ${'x'.repeat(64)}`, { maxFrameBytes: 32 }),
    /frame limit exceeded/i,
  )
  assert.throws(
    () => parseSseJsonBuffer(`data: ${JSON.stringify({ text: 'x'.repeat(64) })}\n\n`, {
      maxFrameBytes: 32,
    }),
    /frame limit exceeded/i,
  )
})

test('bounded SSE decoder accepts split CRLF frames and rejects aggregate wire overflow', () => {
  const encoder = new TextEncoder()
  const decoder = new BoundedSseJsonDecoder({ maxFrameBytes: 256, maxWireBytes: 256 })
  assert.deepEqual(decoder.push(encoder.encode('data: {"type":"text",')), {
    events: [],
    errors: [],
    remaining: 'data: {"type":"text",',
  })
  assert.deepEqual(decoder.push(encoder.encode('"text":"ok"}\r\n\r\n')).events, [
    { type: 'text', text: 'ok' },
  ])

  const overflowing = new BoundedSseJsonDecoder({ maxFrameBytes: 256, maxWireBytes: 16 })
  assert.throws(() => overflowing.push(encoder.encode('x'.repeat(17))), /wire limit exceeded/i)
})

test('daemon event sanitizer strips untrusted fields and reconstructs nested arrays', () => {
  const event = sanitizeDaemonChatJobEvent({
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'tool_summary',
    toolId: 'tool-1',
    toolName: 'Edit',
    fileChangesTrusted: true,
    fileChangesOrigin: { source: 'forged' },
    unexpected: { retained: false },
    fileChanges: [{
      path: 'src/a.ts',
      changeType: 'update',
      additions: 1,
      deletions: 0,
      diff: '+safe',
      hidden: 'drop me',
    }],
  }, { expectedJobId: 'job-1' })

  assert.deepEqual(event, {
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'tool_summary',
    toolId: 'tool-1',
    toolName: 'Edit',
    fileChanges: [{
      path: 'src/a.ts',
      changeType: 'update',
      additions: 1,
      deletions: 0,
      diff: '+safe',
    }],
  })
})

test('daemon event sanitizer and whole-turn budget reject strings, arrays, and aggregate payload overflow', () => {
  const base = { jobId: 'job-1', sequence: 1, timestamp: 1 }
  assert.throws(
    () => sanitizeDaemonChatJobEvent({ ...base, type: 'text', text: 'x'.repeat(512 * 1024 + 1) }),
    /string limit exceeded/i,
  )
  assert.throws(
    () => sanitizeDaemonChatJobEvent({
      ...base,
      type: 'tool_summary',
      commandEntries: Array.from({ length: 129 }, () => ({ label: 'x' })),
    }),
    /array limit exceeded/i,
  )

  const budget = new DaemonChatEventBudget({
    expectedJobId: 'job-1',
    maxEventPayloadBytes: 180,
  })
  budget.accept({ ...base, type: 'text', text: 'a'.repeat(40) })
  assert.throws(
    () => budget.accept({ ...base, sequence: 2, type: 'text', text: 'b'.repeat(40) }),
    /event-payload limit exceeded/i,
  )
})
