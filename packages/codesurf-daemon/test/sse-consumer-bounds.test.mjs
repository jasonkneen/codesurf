import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BoundedSseJsonDecoder,
  DaemonChatEventBudget,
  readBoundedResponseDiagnostic,
  sanitizeDaemonChatJobEvent,
} from '../dist/sse.js'

test('bounded daemon decoder rejects completed and delimiter-free oversized frames', () => {
  const encoder = new TextEncoder()
  const partial = new BoundedSseJsonDecoder({ maxFrameBytes: 32, maxWireBytes: 512 })
  assert.throws(
    () => partial.push(encoder.encode(`data: ${'x'.repeat(40)}`)),
    /frame limit exceeded/i,
  )

  const complete = new BoundedSseJsonDecoder({ maxFrameBytes: 32, maxWireBytes: 512 })
  assert.throws(
    () => complete.push(encoder.encode(`data: ${JSON.stringify({ text: 'x'.repeat(40) })}\n\n`)),
    /frame limit exceeded/i,
  )
})

test('daemon event budget accepts known shapes, strips trust flags, and rejects aggregate overflow', () => {
  const event = sanitizeDaemonChatJobEvent({
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'tool_summary',
    text: 'ok',
    fileChangesTrusted: true,
    unknown: 'drop',
  }, { expectedJobId: 'job-1' })
  assert.deepEqual(event, {
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'tool_summary',
    text: 'ok',
  })

  const budget = new DaemonChatEventBudget({
    expectedJobId: 'job-1',
    maxEventPayloadBytes: 180,
  })
  budget.accept({
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'text',
    text: 'a'.repeat(40),
  })
  assert.throws(() => budget.accept({
    jobId: 'job-1',
    sequence: 2,
    timestamp: 2,
    type: 'text',
    text: 'b'.repeat(40),
  }), /event-payload limit exceeded/i)
})

test('bounded HTTP diagnostic reader drains small bodies and cancels oversized bodies', async () => {
  assert.equal(
    await readBoundedResponseDiagnostic(new Response('small failure'), 64),
    'small failure',
  )

  let cancelled = false
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(128)))
    },
    cancel() {
      cancelled = true
    },
  }), { status: 500 })
  const diagnostic = await readBoundedResponseDiagnostic(oversized, 32)
  assert.match(diagnostic, /Response body omitted: exceeds 32 bytes/)
  assert.ok(diagnostic.length < 128)
  assert.equal(cancelled, true)
})
