import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  clampCanvasZoom,
  connectionSnapPadding,
  zoomAtPoint,
  computeFitViewport,
  computePanToTileViewport,
  screenToWorldPoint,
  worldToScreenPoint,
  MIN_CANVAS_ZOOM,
  MAX_CANVAS_ZOOM,
  SNAP_THRESHOLD,
  HISTORY_MAX_ENTRIES,
  shouldSpawnTileOnCanvasDoubleClick,
} from '../src/renderer/src/hooks/canvasEngineMath.ts'
import type { TileState } from '../src/shared/types.ts'

describe('clampCanvasZoom', () => {
  test('clamps below minimum', () => {
    assert.equal(clampCanvasZoom(0.1), MIN_CANVAS_ZOOM)
  })

  test('clamps above maximum', () => {
    assert.equal(clampCanvasZoom(4), MAX_CANVAS_ZOOM)
  })

  test('passes through values in range', () => {
    assert.equal(clampCanvasZoom(1), 1)
  })
})

describe('connectionSnapPadding', () => {
  test('scales inversely with zoom', () => {
    assert.equal(connectionSnapPadding(1), SNAP_THRESHOLD)
    assert.equal(connectionSnapPadding(2), SNAP_THRESHOLD / 2)
  })

  test('does not divide by zoom below minimum clamp', () => {
    assert.equal(connectionSnapPadding(0.01), SNAP_THRESHOLD / MIN_CANVAS_ZOOM)
  })
})

describe('zoomAtPoint', () => {
  test('keeps the world point under the cursor fixed', () => {
    const viewport = { tx: 100, ty: 50, zoom: 1 }
    const next = zoomAtPoint(viewport, 200, 150, 1.5)
    const worldBefore = screenToWorldPoint(200, 150, { left: 0, top: 0, width: 800, height: 600 } as DOMRect, viewport)
    const worldAfter = screenToWorldPoint(200, 150, { left: 0, top: 0, width: 800, height: 600 } as DOMRect, next)
    assert.ok(Math.abs(worldBefore.x - worldAfter.x) < 0.001)
    assert.ok(Math.abs(worldBefore.y - worldAfter.y) < 0.001)
  })
})

describe('computeFitViewport', () => {
  test('centers bounds in the available screen area', () => {
    const fit = computeFitViewport({ x: 100, y: 200, w: 400, h: 300 }, { w: 1000, h: 800 })
    assert.ok(fit.zoom > 0 && fit.zoom <= 1.5)
    const centerX = (100 + 400 / 2) * fit.zoom + fit.tx
    const centerY = (200 + 300 / 2) * fit.zoom + fit.ty
    assert.ok(Math.abs(centerX - 500) < 2)
    assert.ok(Math.abs(centerY - 400) < 2)
  })
})

describe('computePanToTileViewport', () => {
  test('centers tile in screen space at current zoom', () => {
    const pan = computePanToTileViewport(
      { x: 200, y: 300, width: 400, height: 200 },
      { w: 1200, h: 900 },
      1.25,
    )
    const tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'> = { x: 200, y: 300, width: 400, height: 200 }
    const screen = worldToScreenPoint(
      { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 },
      { tx: pan.tx, ty: pan.ty, zoom: 1.25 },
    )
    assert.ok(Math.abs(screen.x - 600) < 0.001)
    assert.ok(Math.abs(screen.y - 450) < 0.001)
  })
})

describe('canvas history limits', () => {
  test('documents the undo stack cap used by useCanvasEngine', () => {
    assert.equal(HISTORY_MAX_ENTRIES, 50)
  })
})

describe('shouldSpawnTileOnCanvasDoubleClick', () => {
  function mockTarget(matches: string[]): { closest: (selector: string) => Element | null } {
    return {
      closest(selector: string) {
        return matches.includes(selector) ? ({} as Element) : null
      },
    }
  }

  test('allows empty canvas background', () => {
    assert.equal(shouldSpawnTileOnCanvasDoubleClick(mockTarget([])), true)
  })

  test('rejects tile chrome', () => {
    assert.equal(shouldSpawnTileOnCanvasDoubleClick(mockTarget(['[data-tile-chrome]'])), false)
  })

  test('rejects group frames', () => {
    assert.equal(shouldSpawnTileOnCanvasDoubleClick(mockTarget(['[data-canvas-group-frame]'])), false)
  })
})