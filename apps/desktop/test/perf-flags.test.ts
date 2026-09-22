import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parsePerfFlags } from '../src/renderer/src/perfFlags.ts'

describe('parsePerfFlags', () => {
  test('all flags default ON with empty env', () => {
    const flags = parsePerfFlags({})
    assert.deepEqual(flags, {
      imperativePan: true,
      dragRafCoalesce: true,
      viewportCulling: true,
      zoomLod: true,
    })
  })

  test('individual flags disable via falsy values', () => {
    assert.equal(parsePerfFlags({ CODESURF_PERF_IMPERATIVE_PAN: '0' }).imperativePan, false)
    assert.equal(parsePerfFlags({ CODESURF_PERF_DRAG_RAF: 'false' }).dragRafCoalesce, false)
    assert.equal(parsePerfFlags({ CODESURF_PERF_CULLING: 'OFF' }).viewportCulling, false)
    assert.equal(parsePerfFlags({ CODESURF_PERF_ZOOM_LOD: 'no' }).zoomLod, false)
  })

  test('disabling one flag leaves the others on', () => {
    const flags = parsePerfFlags({ CODESURF_PERF_CULLING: '0' })
    assert.equal(flags.viewportCulling, false)
    assert.equal(flags.imperativePan, true)
    assert.equal(flags.dragRafCoalesce, true)
    assert.equal(flags.zoomLod, true)
  })

  test('truthy-looking values stay ON', () => {
    assert.equal(parsePerfFlags({ CODESURF_PERF_CULLING: '1' }).viewportCulling, true)
    assert.equal(parsePerfFlags({ CODESURF_PERF_CULLING: 'true' }).viewportCulling, true)
    assert.equal(parsePerfFlags({ CODESURF_PERF_CULLING: '' }).viewportCulling, true)
  })

  test('master switch CODESURF_PERF_ALL=0 disables everything', () => {
    const flags = parsePerfFlags({ CODESURF_PERF_ALL: '0', CODESURF_PERF_CULLING: '1' })
    assert.deepEqual(flags, {
      imperativePan: false,
      dragRafCoalesce: false,
      viewportCulling: false,
      zoomLod: false,
    })
  })
})
