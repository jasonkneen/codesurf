import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isTileOffscreen, isHeavyTileType, CULL_MARGIN_PX } from '../src/renderer/src/lib/canvasCulling.ts'

const SCREEN_W = 1000
const SCREEN_H = 800

describe('isTileOffscreen', () => {
  const vp = { tx: 0, ty: 0, zoom: 1 }

  test('tile inside the viewport is not culled', () => {
    assert.equal(isTileOffscreen({ x: 100, y: 100, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), false)
  })

  test('tile just past the margin on each side is culled', () => {
    const m = CULL_MARGIN_PX
    assert.equal(isTileOffscreen({ x: -m - 250, y: 100, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), true) // left
    assert.equal(isTileOffscreen({ x: SCREEN_W + m + 50, y: 100, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), true) // right
    assert.equal(isTileOffscreen({ x: 100, y: -m - 250, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), true) // top
    assert.equal(isTileOffscreen({ x: 100, y: SCREEN_H + m + 50, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), true) // bottom
  })

  test('tile inside the margin band stays live', () => {
    assert.equal(isTileOffscreen({ x: -CULL_MARGIN_PX - 100, y: 100, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), false)
  })

  test('pan offset (tx/ty) shifts the visible window', () => {
    const panned = { tx: -5000, ty: 0, zoom: 1 }
    // World x=100 is now far off the left edge.
    assert.equal(isTileOffscreen({ x: 100, y: 100, width: 200, height: 200 }, panned, SCREEN_W, SCREEN_H), true)
    // World x=5100 lands on screen.
    assert.equal(isTileOffscreen({ x: 5100, y: 100, width: 200, height: 200 }, panned, SCREEN_W, SCREEN_H), false)
  })

  test('zoom scales world size — a distant tile comes on screen when zoomed out', () => {
    const tile = { x: 3000, y: 100, width: 200, height: 200 }
    assert.equal(isTileOffscreen(tile, { tx: 0, ty: 0, zoom: 1 }, SCREEN_W, SCREEN_H), true)
    assert.equal(isTileOffscreen(tile, { tx: 0, ty: 0, zoom: 0.25 }, SCREEN_W, SCREEN_H), false)
  })

  test('tile overlapping the viewport edge is never culled', () => {
    assert.equal(isTileOffscreen({ x: -100, y: -100, width: 200, height: 200 }, vp, SCREEN_W, SCREEN_H), false)
  })

  test('canvas rect smaller than window: tiles under sidebar chrome stay unculled when still in canvas', () => {
    // Simulate a canvas that is only the right portion of a 1920x1080 window
    // (sidebar ~280px). Culling must use canvas size (1640), not window size.
    const canvasW = 1640
    const canvasH = 1080
    // Tile fully inside the canvas surface.
    assert.equal(
      isTileOffscreen({ x: 100, y: 100, width: 200, height: 200 }, vp, canvasW, canvasH),
      false,
    )
    // Tile whose screen-space right edge is past the canvas width (+margin) is culled
    // even if it would still be inside a full window width.
    const m = CULL_MARGIN_PX
    assert.equal(
      isTileOffscreen(
        { x: canvasW + m + 50, y: 100, width: 200, height: 200 },
        vp,
        canvasW,
        canvasH,
      ),
      true,
    )
  })
})

describe('isHeavyTileType', () => {
  test('editors / terminals / webviews are heavy', () => {
    for (const t of ['terminal', 'code', 'browser', 'chat', 'kanban', 'files', 'file', 'customisation', 'ext:my-extension']) {
      assert.equal(isHeavyTileType(t), true, t)
    }
  })

  test('cheap visual tiles are not', () => {
    for (const t of ['note', 'image', 'media']) {
      assert.equal(isHeavyTileType(t), false, t)
    }
  })
})
