import assert from 'node:assert/strict'
import test from 'node:test'

import { DaemonRendererStreamBoundary } from '../src/main/chat/daemon-stream-boundary.ts'

const encoder = new TextEncoder()

function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('Electron daemon boundary sanitizes valid frames and stops at the first terminal event', () => {
  const boundary = new DaemonRendererStreamBoundary('job-1')
  const first = frame({
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'tool_summary',
    toolId: 'tool-1',
    text: 'changed',
    fileChangesTrusted: true,
    fileChangesOrigin: { source: 'forged' },
    unexpected: 'drop',
    fileChanges: [{
      path: 'src/a.ts',
      changeType: 'update',
      additions: 1,
      deletions: 0,
      diff: '+ok',
      hidden: true,
    }],
  })
  const terminal = frame({
    jobId: 'job-1',
    sequence: 2,
    timestamp: 2,
    type: 'done',
  })
  const afterTerminal = frame({
    jobId: 'job-1',
    sequence: 3,
    timestamp: 3,
    type: 'text',
    text: 'must not escape',
  })

  assert.deepEqual(boundary.push(encoder.encode(first.slice(0, 24))).events, [])
  const batch = boundary.push(encoder.encode(`${first.slice(24)}${terminal}${afterTerminal}`))

  assert.equal(batch.terminal, true)
  assert.deepEqual(batch.events.map(event => event.type), ['tool_summary', 'done'])
  assert.deepEqual(batch.events[0], {
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'tool_summary',
    toolId: 'tool-1',
    text: 'changed',
    fileChanges: [{
      path: 'src/a.ts',
      changeType: 'update',
      additions: 1,
      deletions: 0,
      diff: '+ok',
    }],
  })
})

test('Electron daemon boundary rejects partial-frame, aggregate, and sequence overflow paths', () => {
  const partial = new DaemonRendererStreamBoundary('job-1', 0, {
    maxFrameBytes: 32,
    maxWireBytes: 256,
  })
  assert.throws(
    () => partial.push(encoder.encode(`data: ${'x'.repeat(40)}`)),
    /frame limit exceeded/i,
  )

  const aggregate = new DaemonRendererStreamBoundary('job-1', 0, {
    maxFrameBytes: 512,
    maxWireBytes: 2_048,
    maxEventPayloadBytes: 180,
  })
  aggregate.push(encoder.encode(frame({
    jobId: 'job-1',
    sequence: 1,
    timestamp: 1,
    type: 'text',
    text: 'a'.repeat(40),
  })))
  assert.throws(
    () => aggregate.push(encoder.encode(frame({
      jobId: 'job-1',
      sequence: 2,
      timestamp: 2,
      type: 'text',
      text: 'b'.repeat(40),
    }))),
    /event-payload limit exceeded/i,
  )

  const gap = new DaemonRendererStreamBoundary('job-1')
  assert.throws(
    () => gap.push(encoder.encode(frame({
      jobId: 'job-1',
      sequence: 2,
      timestamp: 2,
      type: 'done',
    }))),
    /expected 1, received 2/i,
  )
})
