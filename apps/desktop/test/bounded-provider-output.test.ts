import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  BoundedLineDecoder,
  BoundedTextAccumulator,
  EARLIER_OUTPUT_TRUNCATED,
  appendBoundedSuffix,
  boundProviderHistoryText,
  boundRecentText,
} from '../src/main/chat/bounded-output.ts'
import {
  estimateTokenCount,
  MAX_PROMPT_BYTES,
  MAX_PROMPT_ESTIMATED_TOKENS,
} from '../src/main/agent-room/validation.ts'

describe('bounded provider output', () => {
  test('retains the newest UTF-8-safe output under a fixed byte ceiling', () => {
    const output = new BoundedTextAccumulator(96)
    for (let index = 0; index < 100; index += 1) {
      output.append(`chunk-${index}-😀\n`)
    }

    assert.equal(output.truncated, true)
    assert.ok(Buffer.byteLength(output.value, 'utf8') <= 96)
    assert.ok(output.value.startsWith(EARLIER_OUTPUT_TRUNCATED))
    assert.ok(output.value.endsWith('chunk-99-😀\n'))
    assert.equal(output.value.includes('\ufffd'), false)
  })

  test('bounds persisted assistant history to the shared prompt budget', () => {
    const recentTail = 'RECENT-ANSWER'
    const bounded = boundProviderHistoryText(`${'!'.repeat(50_000)}${recentTail}`)

    assert.ok(Buffer.byteLength(bounded, 'utf8') <= MAX_PROMPT_BYTES)
    assert.ok(estimateTokenCount(bounded) <= MAX_PROMPT_ESTIMATED_TOKENS)
    assert.ok(bounded.startsWith(EARLIER_OUTPUT_TRUNCATED))
    assert.ok(bounded.endsWith(recentTail))
  })

  test('enforces token ceilings even when the byte ceiling would allow more', () => {
    const bounded = boundRecentText(`${'!'.repeat(1_000)}tail`, 4_096, 32)

    assert.ok(Buffer.byteLength(bounded, 'utf8') <= 4_096)
    assert.ok(estimateTokenCount(bounded) <= 32)
    assert.ok(bounded.endsWith('tail'))
  })

  test('keeps bounded dedup suffixes without adding a display marker', () => {
    const suffix = appendBoundedSuffix('old-'.repeat(100), 'new-tail', 24)

    assert.ok(Buffer.byteLength(suffix, 'utf8') <= 24)
    assert.ok(suffix.endsWith('new-tail'))
    assert.equal(suffix.includes(EARLIER_OUTPUT_TRUNCATED), false)
  })

  test('drops oversized partial frames and recovers at the next newline', () => {
    const decoder = new BoundedLineDecoder(32)

    assert.deepEqual(decoder.push('x'.repeat(40)), [])
    assert.deepEqual(decoder.push('still-discarded\n{"ok":true}\n'), ['{"ok":true}'])
    assert.equal(decoder.droppedFrames, 1)
  })

  test('reassembles ordinary split frames and flushes a final partial frame', () => {
    const decoder = new BoundedLineDecoder(64)

    assert.deepEqual(decoder.push('{"first":'), [])
    assert.deepEqual(decoder.push('1}\n{"second":2}\npartial'), [
      '{"first":1}',
      '{"second":2}',
    ])
    assert.equal(decoder.flush(), 'partial')
  })
})
