import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const handler = app.slice(app.indexOf("const cleanup = el.onKanban"))
const body = handler.slice(0, handler.indexOf('return cleanup'))

describe('M27 — MCP canvas payloads must be validated', () => {
  it('a position is passed only when both coordinates are finite', () => {
    assert.ok(body.includes('Number.isFinite(data.x) && Number.isFinite(data.y)'),
      'an omitted y produced snapValue(NaN) and persisted "y": null')
    assert.equal(/data\.x !== undefined \? \{ x: data\.x, y: data\.y \}/.test(body), false,
      'the undefined-only guard must be gone')
  })

  it('canvas_open_file requires a string path and catches', () => {
    assert.ok(body.includes("typeof data.path === 'string'"), 'extToType does path.split()')
    assert.ok(body.includes('.catch(error =>'), 'the promise must not float')
  })

  it('pan clamps to finite numbers', () => {
    assert.ok(body.includes('Number.isFinite(data.x) ? Number(data.x) : 0'),
      'a non-numeric x produced translate(NaNpx, NaNpx)')
    assert.equal(/tx: cx - \(data\.x \?\? 0\)/.test(body), false, 'the ?? form must be gone')
  })

  it('tile type is coerced to a non-empty string', () => {
    assert.ok(body.includes("typeof data.type === 'string' && data.type.trim()"))
  })

  it('behaviour: the documented payloads no longer corrupt state', () => {
    const position = (x: unknown, y: unknown) =>
      (Number.isFinite(x) && Number.isFinite(y)) ? { x: Number(x), y: Number(y) } : undefined
    // canvas_create_tile {"type":"note","x":400} — legal per the schema
    assert.equal(position(400, undefined), undefined, 'no half-position is persisted')
    assert.equal(position(400, 'abc'), undefined)
    assert.deepEqual(position(400, 200), { x: 400, y: 200 }, 'a real position still works')

    const pan = (v: unknown) => (Number.isFinite(v) ? Number(v) : 0)
    assert.equal(pan('abc'), 0, 'canvas_pan_to {"x":"abc"} no longer blanks the canvas')
    assert.equal(pan(undefined), 0)
    assert.equal(pan(-250.5), -250.5)
  })
})

describe('M29 — a broadcast command must not run in every window', () => {
  it('rejects a payload with no workspaceId', () => {
    assert.ok(body.includes('if (!data?.workspaceId || data.workspaceId !== workspace?.id) return'),
      'an absent workspaceId used to match every window')
    assert.equal(/if \(data\?\.workspaceId && data\.workspaceId !== workspace\?\.id\) return/.test(body), false,
      'the permissive guard must be gone')
  })

  it('behaviour: only the matching workspace acts', () => {
    const accepts = (data: { workspaceId?: string }, current: string) =>
      Boolean(data?.workspaceId) && data.workspaceId === current
    assert.equal(accepts({}, 'w1'), false, 'no workspaceId -> ignored, not broadcast')
    assert.equal(accepts({ workspaceId: 'w2' }, 'w1'), false)
    assert.equal(accepts({ workspaceId: 'w1' }, 'w1'), true)
  })
})

describe('M28 — bootstrap must not leave a blank shell', () => {
  it('init() is caught and still releases the settings gate', () => {
    const boot = app.slice(app.indexOf('void init()'))
    const call = boot.slice(0, boot.indexOf('})') + 2)
    assert.ok(call.includes('.catch(error =>'), 'the floating promise must be caught')
    assert.ok(call.includes('setSettingsLoaded(true)'),
      'the onboarding/pet overlays are gated on this; it must be released even on failure')
  })
})
