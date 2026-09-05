import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

const bridge = readFileSync(new URL('../src/renderer/src/platform/daemonBridge.ts', import.meta.url), 'utf8')
const transport = readFileSync(new URL('../src/renderer/src/platform/terminalTransport.ts', import.meta.url), 'utf8')

describe('M39 — homedir/platform must be real scalars, not a stringifying proxy', () => {
  it('the api literal defines both explicitly', () => {
    const api = bridge.slice(bridge.indexOf('const api = {'))
    const head = api.slice(0, api.indexOf('appearance: {'))
    assert.ok(head.includes("homedir: ''"), 'homedir must be a real (falsy) string')
    assert.ok(head.includes('platform: detectHostPlatform()'), 'platform must be derived')
  })

  it('an empty homedir lets the documented fallbacks engage', () => {
    // useChatTileWorkspaceSkills: `homedir ?? ''`; KanbanCard: `homedir || process.env.HOME`
    const homedir: string = ''
    assert.equal(homedir ?? 'fallback', '', '?? keeps the empty string')
    assert.equal(homedir || 'fallback', 'fallback', '|| falls through, as intended')
    // The old value was a truthy Proxy that stringified instead:
    const proxyLike = new Proxy({}, { get: () => () => undefined })
    assert.equal(Boolean(proxyLike), true, 'the proxy was truthy, defeating both fallbacks')
    assert.equal(`${{}}`, '[object Object]', 'and stringified into paths')
  })

  it('platform detection returns process.platform vocabulary', () => {
    const fn = bridge.slice(bridge.indexOf('function detectHostPlatform'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    for (const p of ['darwin', 'win32', 'linux']) {
      assert.ok(body.includes(`'${p}'`), `${p} must be produced`)
    }
  })
})

describe('M40 — the job stream must be released on every exit path', () => {
  it('aborts in finally, not only on the deliberate stop path', () => {
    // Use the LAST occurrence: an earlier activeJobStreams.get(key) belongs to
    // the deliberate stopJobStream path, which already aborted.
    const at = bridge.lastIndexOf('const active = activeJobStreams.get(key)')
    const finallyBlock = bridge.slice(bridge.lastIndexOf('} finally {', at), at)
    assert.ok(finallyBlock.includes('controller.abort()'), 'the fetch must be aborted on every exit')
    assert.ok(finallyBlock.includes('} finally {'), 'and it must be in a finally, not a catch')
  })
})

describe('M41 — concurrent create() must not orphan a gateway session', () => {
  it('serializes per tileId through a pending map', () => {
    assert.ok(transport.includes('pendingCreates'), 'a per-tile lane must exist')
    const fn = transport.slice(transport.indexOf('async create(tileId'))
    const body = fn.slice(0, fn.indexOf('private async createSession'))
    assert.ok(body.includes('this.pendingCreates.get(tileId)'), 'waits on the in-flight create')
    assert.ok(body.includes('this.pendingCreates.set(tileId, run)'), 'records its own')
    assert.ok(body.includes('createSession'), 'the real work moved behind the lane')
  })

  it('a failed create does not poison the lane', () => {
    const fn = transport.slice(transport.indexOf('async create(tileId'))
    const body = fn.slice(0, fn.indexOf('private async createSession'))
    assert.ok(/previous\.catch\(\(\) => undefined\)/.test(body))
  })

  it('behaviour: two overlapping creates yield one live session', async () => {
    const pending = new Map<string, Promise<string>>()
    const sessions = new Map<string, string>()
    let created = 0
    const createSession = async (tileId: string, tag: string) => {
      const existing = sessions.get(tileId)
      await new Promise(r => setTimeout(r, 5))
      if (existing) return 'reused'
      created += 1
      sessions.set(tileId, tag)
      return 'created'
    }
    const create = (tileId: string, tag: string) => {
      const previous = pending.get(tileId)
      const run = (previous ? previous.catch(() => undefined) : Promise.resolve())
        .then(() => createSession(tileId, tag))
      pending.set(tileId, run)
      return run
    }
    const [a, b] = await Promise.all([create('t1', 'A'), create('t1', 'B')])
    assert.equal(created, 1, 'exactly one gateway session — the loser cannot leak')
    assert.equal(a, 'created')
    assert.equal(b, 'reused')
  })

  it('behaviour: different tiles still create in parallel', async () => {
    const pending = new Map<string, Promise<void>>()
    let concurrent = 0, peak = 0
    const op = async () => {
      concurrent += 1; peak = Math.max(peak, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent -= 1
    }
    const create = (tileId: string) => {
      const previous = pending.get(tileId)
      const run = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(op)
      pending.set(tileId, run)
      return run
    }
    await Promise.all([create('a'), create('b'), create('c')])
    assert.equal(peak, 3)
  })
})
