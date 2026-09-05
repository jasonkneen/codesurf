import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  createStableContextLoadCache,
  DEFAULT_STABLE_CONTEXT_TTL_MS,
} from '../../packages/codesurf-daemon/bin/stable-context-load-cache.mjs'

function fakeClock() {
  let t = 1_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('M1 — stable context cache must not outlive an edit', () => {
  it('serves a hit inside the TTL', () => {
    const clock = fakeClock()
    const cache = createStableContextLoadCache(64, { now: clock.now, ttlMs: 1000 })
    const key = cache.key('memory', { workspaceId: 'w1', cardId: 'c1' })
    cache.set(key, 'prompt-v1')
    clock.advance(500)
    assert.deepEqual(cache.get(key), { hit: true, value: 'prompt-v1' })
  })

  it('expires once the TTL passes, so an edit is picked up', () => {
    const clock = fakeClock()
    const cache = createStableContextLoadCache(64, { now: clock.now, ttlMs: 1000 })
    const key = cache.key('memory', { workspaceId: 'w1' })
    cache.set(key, 'prompt-v1')
    clock.advance(1000)
    assert.deepEqual(cache.get(key), { hit: false }, 'a stale prompt must not be replayed forever')
  })

  it('has a bounded default TTL rather than none at all', () => {
    assert.ok(DEFAULT_STABLE_CONTEXT_TTL_MS > 0)
    assert.ok(DEFAULT_STABLE_CONTEXT_TTL_MS <= 60_000, 'must be short enough to follow a user edit')
  })

  it('invalidate() drops everything', () => {
    const cache = createStableContextLoadCache()
    const a = cache.key('memory', { workspaceId: 'w1' })
    const b = cache.key('skills', { workspaceId: 'w2' })
    cache.set(a, 1); cache.set(b, 2)
    cache.invalidate()
    assert.equal(cache.get(a).hit, false)
    assert.equal(cache.get(b).hit, false)
  })

  it('invalidate(workspaceId) drops only that workspace', () => {
    const cache = createStableContextLoadCache()
    const a = cache.key('memory', { workspaceId: 'w1' })
    const b = cache.key('skills', { workspaceId: 'w1' })
    const c = cache.key('memory', { workspaceId: 'w2' })
    cache.set(a, 1); cache.set(b, 2); cache.set(c, 3)
    cache.invalidate('w1')
    assert.equal(cache.get(a).hit, false, 'memory for w1 dropped')
    assert.equal(cache.get(b).hit, false, 'skills for w1 dropped')
    assert.equal(cache.get(c).hit, true, 'another workspace is untouched')
  })

  it('still behaves as an LRU with a bound', () => {
    const cache = createStableContextLoadCache(2)
    const k = (n) => cache.key('memory', { workspaceId: `w${n}` })
    cache.set(k(1), 1); cache.set(k(2), 2); cache.set(k(3), 3)
    assert.equal(cache.size, 2, 'the bound still holds')
    assert.equal(cache.get(k(1)).hit, false, 'oldest evicted')
  })
})

describe('M1 — the write paths invalidate', () => {
  const daemon = readFileSync(
    new URL('../../packages/codesurf-daemon/bin/codesurfd.mjs', import.meta.url), 'utf8')

  it('skills install drops the cache', () => {
    const handler = daemon.slice(daemon.indexOf("url.pathname === '/skills/install'"))
    const body = handler.slice(0, handler.indexOf('/file-references/selections/issue'))
    assert.ok(body.includes('stableContextLoads.invalidate('), 'a new skill must reach the next job')
  })

  it('settings write drops the cache', () => {
    const handler = daemon.slice(daemon.indexOf("method === 'POST' && url.pathname === '/settings'"))
    const body = handler.slice(0, handler.indexOf('/settings/raw'))
    assert.ok(body.includes('stableContextLoads.invalidate()'))
  })
})
