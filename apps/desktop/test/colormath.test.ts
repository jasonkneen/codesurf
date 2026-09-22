import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseColor,
  formatColor,
  rgbaToHsla,
  hslaToRgba,
  shiftLightness,
  shiftLAway,
} from '../src/renderer/src/colorMath.ts'

const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol

test('parseColor reads hex6 / hex8 / rgb / rgba and tags the shape', () => {
  const hex6 = parseColor('#ff0000')
  assert.ok(hex6)
  assert.deepEqual(hex6.rgba, { r: 255, g: 0, b: 0, a: 1 })
  assert.equal(hex6.shape, 'hex6')

  const hex8 = parseColor('#ff000080')
  assert.ok(hex8)
  assert.equal(hex8.rgba.r, 255)
  assert.ok(near(hex8.rgba.a * 255, 128))
  assert.equal(hex8.shape, 'hex8')

  const rgb = parseColor('rgb(0, 128, 255)')
  assert.ok(rgb)
  assert.deepEqual(rgb.rgba, { r: 0, g: 128, b: 255, a: 1 })
  assert.equal(rgb.shape, 'rgb')

  const rgba = parseColor('rgba(0, 0, 0, 0.5)')
  assert.ok(rgba)
  assert.equal(rgba.rgba.a, 0.5)
  assert.equal(rgba.shape, 'rgba')
})

test('parseColor returns null for values it should leave literal', () => {
  assert.equal(parseColor(''), null)
  assert.equal(parseColor('oklch(0.5 0.1 200)'), null)
  assert.equal(parseColor('color-mix(in srgb, red, blue)'), null)
  assert.equal(parseColor('rebeccapurple'), null)
})

test('parse -> format -> parse round-trips rgba and preserves shape', () => {
  for (const input of ['#abcdef', '#abcdef80', 'rgb(12, 200, 7)', 'rgba(9, 9, 9, 0.3)']) {
    const a = parseColor(input)
    assert.ok(a, `parse ${input}`)
    const out = formatColor(a)
    const b = parseColor(out)
    assert.ok(b, `re-parse ${out}`)
    assert.equal(b.shape, a.shape)
    assert.ok(near(b.rgba.r, a.rgba.r))
    assert.ok(near(b.rgba.g, a.rgba.g))
    assert.ok(near(b.rgba.b, a.rgba.b))
    assert.ok(near(b.rgba.a * 255, a.rgba.a * 255))
  }
})

test('rgbaToHsla <-> hslaToRgba round-trips within rounding tolerance', () => {
  const rgba = { r: 128, g: 64, b: 200, a: 0.8 }
  const back = hslaToRgba(rgbaToHsla(rgba))
  assert.ok(near(back.r, rgba.r))
  assert.ok(near(back.g, rgba.g))
  assert.ok(near(back.b, rgba.b))
  assert.equal(back.a, rgba.a)
})

test('shiftLightness: zero delta and unparseable inputs are identity', () => {
  assert.equal(shiftLightness('#808080', 0), '#808080')
  assert.equal(shiftLightness('oklch(0.5 0.1 200)', 0.3), 'oklch(0.5 0.1 200)')
})

test('shiftLightness clamps to the [0,1] L axis and actually moves colour', () => {
  const lighter = parseColor(shiftLightness('#000000', 0.5))
  assert.ok(lighter)
  assert.ok(lighter.rgba.r + lighter.rgba.g + lighter.rgba.b > 0, 'black lightened')

  // Already-white cannot exceed the pole; output stays a valid colour.
  const capped = parseColor(shiftLightness('#ffffff', 0.5))
  assert.ok(capped)
  assert.ok(capped.rgba.r <= 255 && capped.rgba.g <= 255 && capped.rgba.b <= 255)
})

test('shiftLAway: identity cases, and mode controls direction', () => {
  assert.equal(shiftLAway('#808080', 0, 'darker'), '#808080')
  assert.equal(shiftLAway('not-a-color', 0.5, 'lighter'), 'not-a-color')

  const sum = (hex: string): number => {
    const p = parseColor(hex)
    assert.ok(p)
    return p.rgba.r + p.rgba.g + p.rgba.b
  }
  const base = sum('#808080')
  assert.ok(sum(shiftLAway('#808080', 1, 'darker')) < base, 'darker reduces lightness')
  assert.ok(sum(shiftLAway('#808080', 1, 'lighter')) > base, 'lighter raises lightness')
})
