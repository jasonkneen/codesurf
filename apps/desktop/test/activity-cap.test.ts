import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  capActivityRecords,
  MAX_ACTIVITY_RECORDS,
  MAX_ACTIVITY_AGE_MS,
} from '../src/main/activity-cap.ts'

function rec(id: string, updatedAt: number) {
  return { id, updatedAt }
}

describe('capActivityRecords', () => {
  test('returns the same array when under both caps', () => {
    const now = 1_000_000
    const input = [rec('a', now - 1000), rec('b', now - 500)]
    const out = capActivityRecords(input, now)
    assert.equal(out, input)
    assert.equal(out.length, 2)
  })

  test('drops records older than MAX_ACTIVITY_AGE_MS', () => {
    const now = 10_000_000
    const fresh = rec('fresh', now - 1000)
    const stale = rec('stale', now - MAX_ACTIVITY_AGE_MS - 1)
    const out = capActivityRecords([fresh, stale], now)
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'fresh')
  })

  test('keeps only the newest MAX_ACTIVITY_RECORDS by updatedAt', () => {
    const now = 1_000_000
    const input = []
    for (let i = 0; i < MAX_ACTIVITY_RECORDS + 50; i++) {
      input.push(rec(`r${i}`, now - (MAX_ACTIVITY_RECORDS + 50 - i)))
    }
    const out = capActivityRecords(input, now)
    assert.equal(out.length, MAX_ACTIVITY_RECORDS)
    // Newest must be retained.
    assert.ok(out.some(r => r.id === `r${MAX_ACTIVITY_RECORDS + 49}`))
    // Oldest of the oversized batch must be gone.
    assert.equal(out.some(r => r.id === 'r0'), false)
  })

  test('honours custom maxRecords option (used by tests of the real helper)', () => {
    const now = 5000
    const input = [rec('a', 1), rec('b', 2), rec('c', 3), rec('d', 4)]
    const out = capActivityRecords(input, now, { maxRecords: 2, maxAgeMs: 0 })
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(r => r.id).sort(), ['c', 'd'].sort())
  })
})
