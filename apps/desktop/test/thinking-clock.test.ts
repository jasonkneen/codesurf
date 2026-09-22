import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  THINKING_CLOCK_TICK_MS,
  computeThinkingElapsedSec,
  finalizeThinkingElapsedSec,
  resolveThinkingDisplayedElapsed,
  subscribeThinkingClock,
  tickThinkingClockForTests,
} from '../src/renderer/src/components/chat/thinkingClock.ts'

describe('thinkingClock pure helpers', () => {
  test('computeThinkingElapsedSec floors to whole seconds', () => {
    const start = 1_000_000
    assert.equal(computeThinkingElapsedSec(start, start + 999), 0)
    assert.equal(computeThinkingElapsedSec(start, start + 1000), 1)
    assert.equal(computeThinkingElapsedSec(start, start + 2500), 2)
  })

  test('finalizeThinkingElapsedSec is at least 1 second', () => {
    const start = 5_000
    assert.equal(finalizeThinkingElapsedSec(start, start + 100), 1)
    assert.equal(finalizeThinkingElapsedSec(start, start + 1500), 2)
  })

  test('resolveThinkingDisplayedElapsed freezes final value when done', () => {
    const start = 10_000
    const live = resolveThinkingDisplayedElapsed(start, start + 3200, false, null)
    assert.equal(live, 3)
    const done = resolveThinkingDisplayedElapsed(start, start + 99999, true, 4)
    assert.equal(done, 4)
  })

  test('inactive / missing start yields 0 while live', () => {
    assert.equal(resolveThinkingDisplayedElapsed(null, Date.now(), false, null), 0)
  })

  test('tick interval constant is the shared clock period', () => {
    assert.equal(THINKING_CLOCK_TICK_MS, 250)
  })

  test('inactive subscribers receive no shared clock ticks', () => {
    let inactiveTicks = 0
    let activeTicks = 0
    const unsubscribeInactive = subscribeThinkingClock(false, () => { inactiveTicks += 1 })
    const unsubscribeActive = subscribeThinkingClock(true, () => { activeTicks += 1 })

    tickThinkingClockForTests()

    assert.equal(inactiveTicks, 0)
    assert.equal(activeTicks, 1)
    unsubscribeInactive()
    unsubscribeActive()
  })
})
