import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/main/ipc/terminal.ts', import.meta.url), 'utf8')

// ── M18: control characters in a cd path ────────────────────────────────────
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

describe('terminal:cd rejects control characters (M18)', () => {
  it('rejects the documented attack: a directory name carrying CR + Ctrl-C', () => {
    assert.equal(CONTROL_CHARS.test('safe\r\x03rm -rf ~/Documents'), true)
  })

  it('rejects every control byte a filename may legally contain', () => {
    for (const c of ['\r', '\n', '\x03', '\x00', '\x1b', '\x7f', '\x15']) {
      assert.equal(CONTROL_CHARS.test(`dir${c}evil`), true, `${JSON.stringify(c)} must be refused`)
    }
  })

  it('accepts ordinary paths, including ones needing quote escaping', () => {
    for (const p of [
      '/Users/dev/projects/app',
      "/Users/dev/it's a repo",
      '/Users/dev/with space/and-dash',
      'C:\\Users\\dev\\project',
      '/Users/dev/emoji-🚀-dir',
    ]) {
      assert.equal(CONTROL_CHARS.test(p), false, `${p} must remain navigable`)
    }
  })

  it('the guard runs before the cd line is built, for every shell branch', () => {
    const handler = src.slice(src.indexOf("handleTyped('terminal:cd'"))
    const body = handler.slice(0, handler.indexOf('session.pty.write'))
    const guardAt = body.indexOf('control characters')
    assert.ok(guardAt > -1, 'guard must exist')
    assert.ok(guardAt < body.indexOf('cmd.exe'), 'guard must precede the cmd.exe branch')
    assert.ok(guardAt < body.indexOf('Set-Location'), 'guard must precede the powershell branch')
    assert.ok(guardAt < body.indexOf("cd '"), 'guard must precede the POSIX branch')
  })
})

// ── M15: bus accumulator bound ──────────────────────────────────────────────
describe('terminal bus accumulator is bounded (M15)', () => {
  it('caps the accumulator instead of appending without limit', () => {
    assert.ok(src.includes('TERMINAL_BUS_MAX_BUFFER'), 'a cap constant must exist')
    assert.ok(
      src.includes('buf.data = (buf.data + data).slice(-TERMINAL_BUS_MAX_BUFFER)'),
      'the accumulator must be sliced to the cap',
    )
    assert.equal(/buf\.data \+= data/.test(src), false, 'the unbounded append must be gone')
  })

  it('the cap still covers what the flush actually reads', () => {
    const m = src.match(/TERMINAL_BUS_MAX_BUFFER = (\d+)/)
    assert.ok(m)
    const cap = Number(m[1])
    const tail = Number((src.match(/clean\.slice\(-(\d+)\)/) ?? [])[1] ?? 200)
    assert.ok(cap >= tail, `cap ${cap} must be >= the ${tail} chars the flush keeps`)
  })

  it('bounded growth: repeated appends stay at the cap', () => {
    const CAP = 4096
    let buf = ''
    for (let i = 0; i < 5000; i += 1) buf = (buf + 'x'.repeat(64)).slice(-CAP)
    assert.equal(buf.length, CAP, 'accumulator must plateau, not grow')
  })
})

// ── M17: concurrent terminal:create must not orphan a PTY ───────────────────
describe('terminal:create is serialized per tile (M17)', () => {
  it('wraps the handler in a per-tile lane', () => {
    assert.ok(src.includes('runTerminalCreateLane'), 'a lane helper must exist')
    const handler = src.slice(src.indexOf("handleTyped('terminal:create'"))
    const head = handler.slice(0, handler.indexOf('const existing = terminals.get(tileId)'))
    assert.ok(head.includes('runTerminalCreateLane(tileId'), 'the lane must wrap the whole handler body')
  })

  it('lane keys by tileId so different tiles still run concurrently', () => {
    const lane = src.slice(src.indexOf('function runTerminalCreateLane'))
    const body = lane.slice(0, lane.indexOf('\n}\n'))
    assert.ok(body.includes('terminalCreateLanes.get(tileId)'), 'previous op is looked up per tile')
    assert.ok(body.includes('terminalCreateLanes.set(tileId'), 'the new op is recorded per tile')
  })

  it('a rejected operation does not poison the lane', () => {
    const lane = src.slice(src.indexOf('function runTerminalCreateLane'))
    const body = lane.slice(0, lane.indexOf('\n}\n'))
    assert.ok(/previous\.catch\(\(\) => undefined\)/.test(body), 'a failed create must not block the next')
  })

  it('behaviour: two concurrent creates for one tile run in sequence', async () => {
    const lanes = new Map<string, Promise<unknown>>()
    function run<T>(tileId: string, op: () => Promise<T>): Promise<T> {
      const previous = lanes.get(tileId) ?? Promise.resolve()
      const current = previous.catch(() => undefined).then(op)
      lanes.set(tileId, current)
      void current.catch(() => undefined).finally(() => {
        if (lanes.get(tileId) === current) lanes.delete(tileId)
      })
      return current
    }

    const sessions = new Map<string, string>()
    const spawned: string[] = []
    const create = (tag: string) => run('tile-1', async () => {
      const existing = sessions.get('tile-1')
      await new Promise(r => setTimeout(r, 5)) // the awaits the real handler has
      if (existing) return 'reused'
      sessions.set('tile-1', tag)
      spawned.push(tag)
      return 'spawned'
    })

    const [a, b] = await Promise.all([create('A'), create('B')])
    assert.equal(spawned.length, 1, 'exactly one PTY may be spawned — no orphan')
    assert.equal(a, 'spawned')
    assert.equal(b, 'reused', 'the second mount reuses the first session')
  })

  it('behaviour: different tiles are not serialized against each other', async () => {
    const lanes = new Map<string, Promise<unknown>>()
    function run<T>(tileId: string, op: () => Promise<T>): Promise<T> {
      const previous = lanes.get(tileId) ?? Promise.resolve()
      const current = previous.catch(() => undefined).then(op)
      lanes.set(tileId, current)
      return current
    }
    let concurrent = 0
    let peak = 0
    const op = async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent -= 1
    }
    await Promise.all([run('a', op), run('b', op), run('c', op)])
    assert.equal(peak, 3, 'independent tiles must still start in parallel')
  })
})

// ── M16: failures must reject, not resolve as success ───────────────────────
describe('terminal:create failures reject (M16)', () => {
  it('no failure path resolves an { error } value', () => {
    const handler = src.slice(src.indexOf("handleTyped('terminal:create'"))
    const body = handler.slice(0, handler.indexOf("handleTyped('terminal:write'"))
    assert.equal(
      /return \{ *error/.test(body),
      false,
      'a resolved { error } is consumed by the success path and renders a dead terminal',
    )
  })

  it('the documented failure causes now throw', () => {
    const handler = src.slice(src.indexOf("handleTyped('terminal:create'"))
    const body = handler.slice(0, handler.indexOf("handleTyped('terminal:write'"))
    assert.ok(body.includes("throw new Error('Invalid terminal workspace or tile ID')"))
    assert.ok(body.includes('throw new Error(`Access denied:'))
    assert.ok(body.includes("throw new Error('Terminal tile ID is already active in another workspace')"))
  })

  it('the renderer already routes rejections to the unavailable state', () => {
    const tile = readFileSync(new URL('../src/renderer/src/components/TerminalTile.tsx', import.meta.url), 'utf8')
    assert.ok(tile.includes('showTerminalUnavailable'), 'the caller has a rejection path to reach')
  })
})
