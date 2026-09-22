/**
 * Color math utilities used by the contrast slider and any future colour
 * post-processing. Pure functions, no allocations beyond one tiny object per
 * call. Stays inside the renderer because it has no main-process callers.
 *
 * Design intent: parse arbitrary CSS colour strings (hex 3/6/8, rgb, rgba),
 * convert to HSL for L-axis manipulation, then re-emit in the original
 * shape (hex stays hex, rgba stays rgba, alpha preserved). Anything we
 * can't parse is returned unchanged so the contrast pipeline can degrade
 * gracefully on color-mix() / named colors / oklch() values that should
 * stay literal.
 */

interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

interface HSLA {
  h: number
  s: number
  l: number
  a: number
}

/** Original-source kind so we can re-emit in the same shape. */
type ColorShape = 'hex3' | 'hex6' | 'hex8' | 'rgb' | 'rgba' | 'unknown'

interface ParsedColor {
  rgba: RGBA
  shape: ColorShape
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const RGB = /^rgb\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i
const RGBA = /^rgba\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i

export function parseColor(input: string): ParsedColor | null {
  if (!input) return null
  const s = input.trim()

  let m = s.match(HEX8)
  if (m) {
    return {
      rgba: {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
        a: parseInt(m[4], 16) / 255,
      },
      shape: 'hex8',
    }
  }

  m = s.match(HEX6)
  if (m) {
    return {
      rgba: {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
        a: 1,
      },
      shape: 'hex6',
    }
  }

  m = s.match(HEX3)
  if (m) {
    return {
      rgba: {
        r: parseInt(m[1] + m[1], 16),
        g: parseInt(m[2] + m[2], 16),
        b: parseInt(m[3] + m[3], 16),
        a: 1,
      },
      shape: 'hex3',
    }
  }

  m = s.match(RGBA)
  if (m) {
    return {
      rgba: {
        r: clamp255(parseFloat(m[1])),
        g: clamp255(parseFloat(m[2])),
        b: clamp255(parseFloat(m[3])),
        a: clamp01(parseFloat(m[4])),
      },
      shape: 'rgba',
    }
  }

  m = s.match(RGB)
  if (m) {
    return {
      rgba: {
        r: clamp255(parseFloat(m[1])),
        g: clamp255(parseFloat(m[2])),
        b: clamp255(parseFloat(m[3])),
        a: 1,
      },
      shape: 'rgb',
    }
  }

  return null
}

export function rgbaToHsla({ r, g, b, a }: RGBA): HSLA {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break
      case gn: h = (bn - rn) / d + 2; break
      default: h = (rn - gn) / d + 4
    }
    h *= 60
  }
  return { h, s, l, a }
}

export function hslaToRgba({ h, s, l, a }: HSLA): RGBA {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v, a }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hp = ((h % 360) + 360) % 360 / 360
  return {
    r: Math.round(hueToRgb(p, q, hp + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hp) * 255),
    b: Math.round(hueToRgb(p, q, hp - 1 / 3) * 255),
    a,
  }
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

export function formatColor({ rgba, shape }: ParsedColor): string {
  const { r, g, b, a } = rgba
  if (shape === 'rgba' || shape === 'hex8') {
    if (shape === 'hex8') return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(Math.round(a * 255))}`
    return `rgba(${r}, ${g}, ${b}, ${roundA(a)})`
  }
  if (shape === 'rgb') return `rgb(${r}, ${g}, ${b})`
  // hex3 round-trips lossily through 6 — emit hex6 so we don't quantise mid-pipeline
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

function hex2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)))
  return v.toString(16).padStart(2, '0')
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(255, n))
}

function roundA(a: number): string {
  // Two decimal places match the hand-written rgba() values in theme.ts
  // closely enough that contrast=0 produces strings indistinguishable from
  // the originals (which makes diffs smaller and avoids shader-style
  // recompiles in webview content that snapshots bg colour strings).
  const r = Math.round(a * 100) / 100
  return r === Math.floor(r) ? r.toFixed(0) : r.toString()
}

/**
 * Shift the L channel of `input` by `delta` (in HSL space, range [-1, 1]).
 * Positive values lift L (toward white), negative values drop L (toward
 * black). Saturation, hue, and alpha are preserved. Inputs we can't parse
 * (named colours, oklch(), color-mix()) round-trip unchanged.
 */
export function shiftLightness(input: string, delta: number): string {
  if (delta === 0) return input
  const parsed = parseColor(input)
  if (!parsed) return input
  const hsla = rgbaToHsla(parsed.rgba)
  hsla.l = clamp01(hsla.l + delta)
  return formatColor({ rgba: hslaToRgba(hsla), shape: parsed.shape })
}

/**
 * Push L *away from* a neutral midpoint (0.5). For dark themes, surfaces get
 * darker and text gets lighter as `factor` grows; for light themes, surfaces
 * get lighter and text gets darker. `factor` is in [-1, 1]:
 *   factor > 0 → more contrast
 *   factor < 0 → less contrast (everything compresses toward mid-grey)
 *
 * `mode` decides which way "more contrast" pushes:
 *   'darker'  — push L toward 0 (used for surfaces in dark themes, text in light themes)
 *   'lighter' — push L toward 1 (used for text in dark themes, surfaces in light themes)
 */
export function shiftLAway(input: string, factor: number, mode: 'darker' | 'lighter'): string {
  if (factor === 0) return input
  const parsed = parseColor(input)
  if (!parsed) return input
  const hsla = rgbaToHsla(parsed.rgba)
  // Distance from the target pole, scaled so factor=1 collapses ~half the
  // remaining distance and factor=-1 pulls toward mid-grey by ~half.
  // The 0.5 multiplier keeps the slider feeling responsive without being
  // cartoonish at the extremes (where text starts hitting #fff or #000
  // against surfaces that are also hitting their poles).
  if (mode === 'darker') {
    const target = factor >= 0 ? 0 : 0.5
    const d = (target - hsla.l) * Math.abs(factor) * 0.5
    hsla.l = clamp01(hsla.l + d)
  } else {
    const target = factor >= 0 ? 1 : 0.5
    const d = (target - hsla.l) * Math.abs(factor) * 0.5
    hsla.l = clamp01(hsla.l + d)
  }
  return formatColor({ rgba: hslaToRgba(hsla), shape: parsed.shape })
}
