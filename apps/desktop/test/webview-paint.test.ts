import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyWebviewPaintFrameRate,
  frameRateForPaintActive,
  resolveWebviewPaintCommand,
  WEBVIEW_PAINT_ACTIVE_FPS,
  WEBVIEW_PAINT_CULLED_FPS,
} from '../src/shared/webview-paint-bridge.ts'

describe('frameRateForPaintActive', () => {
  test('returns full FPS when paint is active (on-screen)', () => {
    assert.equal(frameRateForPaintActive(true), WEBVIEW_PAINT_ACTIVE_FPS)
    assert.equal(WEBVIEW_PAINT_ACTIVE_FPS, 60)
  })

  test('returns near-frozen FPS when paint is inactive (culled)', () => {
    assert.equal(frameRateForPaintActive(false), WEBVIEW_PAINT_CULLED_FPS)
    assert.equal(WEBVIEW_PAINT_CULLED_FPS, 1)
  })
})

describe('resolveWebviewPaintCommand (Electron 41 WebviewTag path)', () => {
  test('uses getWebContentsId (not getWebContents) and maps culled → fps 1', () => {
    const cmd = resolveWebviewPaintCommand(() => 42, false)
    assert.deepEqual(cmd, { webContentsId: 42, fps: 1 })
  })

  test('maps visible → fps 60', () => {
    const cmd = resolveWebviewPaintCommand(() => 7, true)
    assert.deepEqual(cmd, { webContentsId: 7, fps: 60 })
  })

  test('returns null when getWebContentsId is missing / returns non-positive', () => {
    assert.equal(resolveWebviewPaintCommand(() => undefined, true), null)
    assert.equal(resolveWebviewPaintCommand(() => 0, true), null)
    assert.equal(resolveWebviewPaintCommand(() => -1, false), null)
  })

  test('returns null when getWebContentsId throws (destroyed guest)', () => {
    assert.equal(
      resolveWebviewPaintCommand(() => { throw new Error('destroyed') }, true),
      null,
    )
  })
})

describe('applyWebviewPaintFrameRate (main fromId adapter)', () => {
  test('calls setFrameRate on the WebContents returned by fromId', () => {
    const rates: number[] = []
    const fromIdCalls: number[] = []
    const ok = applyWebviewPaintFrameRate(99, 1, (id) => {
      fromIdCalls.push(id)
      return {
        setFrameRate: (fps: number) => { rates.push(fps) },
        isDestroyed: () => false,
      }
    })
    assert.equal(ok, true)
    assert.deepEqual(fromIdCalls, [99])
    assert.deepEqual(rates, [1])
  })

  test('restores full rate via fromId when fps=60', () => {
    const rates: number[] = []
    applyWebviewPaintFrameRate(3, 60, () => ({
      setFrameRate: (fps: number) => { rates.push(fps) },
    }))
    assert.deepEqual(rates, [60])
  })

  test('fails closed when fromId returns null (dead webContentsId)', () => {
    assert.equal(applyWebviewPaintFrameRate(1, 1, () => null), false)
  })

  test('fails closed when WebContents has no setFrameRate', () => {
    assert.equal(applyWebviewPaintFrameRate(1, 1, () => ({})), false)
  })

  test('fails closed when WebContents is destroyed', () => {
    let called = false
    const ok = applyWebviewPaintFrameRate(1, 1, () => ({
      isDestroyed: () => true,
      setFrameRate: () => { called = true },
    }))
    assert.equal(ok, false)
    assert.equal(called, false)
  })

  test('end-to-end: resolve command then apply via fromId (shipped path)', () => {
    // Simulates renderer: getWebContentsId() → IPC payload → main fromId → setFrameRate
    const guest = { getWebContentsId: () => 555 }
    const rates: Array<{ id: number, fps: number }> = []

    const cmd = resolveWebviewPaintCommand(() => guest.getWebContentsId(), false)
    assert.ok(cmd)
    const applied = applyWebviewPaintFrameRate(cmd!.webContentsId, cmd!.fps, (id) => ({
      setFrameRate: (fps: number) => { rates.push({ id, fps }) },
    }))
    assert.equal(applied, true)
    assert.deepEqual(rates, [{ id: 555, fps: 1 }])

    const restore = resolveWebviewPaintCommand(() => guest.getWebContentsId(), true)
    assert.ok(restore)
    applyWebviewPaintFrameRate(restore!.webContentsId, restore!.fps, (id) => ({
      setFrameRate: (fps: number) => { rates.push({ id, fps }) },
    }))
    assert.deepEqual(rates, [{ id: 555, fps: 1 }, { id: 555, fps: 60 }])
  })

  test('dead path: getWebContents() is NOT required — only getWebContentsId + fromId', () => {
    // Regression guard for the Electron 41 bug: if someone reintroduces
    // webview.getWebContents(), this guest object would "work" incorrectly in
    // a unit that called it. The shipped helpers must succeed with ONLY
    // getWebContentsId + fromId.
    const guest = {
      getWebContentsId: () => 12,
      // intentionally no getWebContents
    }
    const cmd = resolveWebviewPaintCommand(() => guest.getWebContentsId(), false)
    assert.ok(cmd)
    let usedFromId = false
    const ok = applyWebviewPaintFrameRate(cmd!.webContentsId, cmd!.fps, (id) => {
      usedFromId = true
      assert.equal(id, 12)
      return { setFrameRate: () => {} }
    })
    assert.equal(ok, true)
    assert.equal(usedFromId, true)
    assert.equal('getWebContents' in guest, false)
  })
})
