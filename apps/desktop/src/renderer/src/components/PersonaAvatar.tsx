import type { JSX } from 'react'
import { Blobatar } from 'blobatar/react'
import 'blobatar/motion.css'
import type { Persona } from '../../../shared/types'

// ─── Persona avatar ──────────────────────────────────────────────────────────
// A deterministic blobatar per persona: the shape comes from the persona, the
// hue comes from the colour the persona already carries everywhere else in the
// UI, so the face and the accent dot never drift apart. Nothing is stored — the
// same persona always renders the same face.

/**
 * Below this HSL saturation a colour is a grey, and the hue you can read off it
 * is noise. `#8f96a0` — what every auto-discovered persona carries — sits at
 * 0.08: pinning its hue would paint that whole half of the list one flat
 * blue-grey. Returning undefined instead lets the name pick the hue, so those
 * personas differ by colour as well as by shape.
 */
const GREY_FLOOR = 0.15

/**
 * `#rgb` / `#rrggbb` → hue in degrees, or undefined when the colour is grey or
 * unparseable (blobatar then derives the hue from the name, which is a better
 * answer than pinning everything to 0° red).
 */
export function hexToHue(hex: string | undefined): number | undefined {
  if (!hex) return undefined
  const raw = hex.trim().replace('#', '')
  const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return undefined
  const l = (max + min) / 2
  if (d / (1 - Math.abs(2 * l - 1)) < GREY_FLOOR) return undefined
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/**
 * The blob is drawn a little over its nominal box so it fills the space a
 * backdrop plate would have taken; the negative margin keeps the surrounding
 * layout on the box it was built for.
 */
const OVERSIZE = 1.3

export function PersonaAvatar({
  persona,
  size = 24,
  animate = 'hover',
  className,
  style,
}: {
  persona: Pick<Persona, 'id' | 'name' | 'color'>
  size?: number
  /** 'always' for the persona that is answering right now; false to opt out. */
  animate?: 'hover' | 'always' | false
  className?: string
  style?: React.CSSProperties
}): JSX.Element {
  // Both parts matter: the id so two personas sharing a name still differ, the
  // name so the editor preview reacts while you type.
  const seed = `${persona.id}:${persona.name}`
  const common = {
    name: seed,
    hue: hexToHue(persona.color),
    size,
    background: false as const,
    title: persona.name || undefined,
    className,
    style: {
      width: size * OVERSIZE,
      height: size * OVERSIZE,
      margin: (size * (OVERSIZE - 1)) / -2,
      flexShrink: 0,
      overflow: 'visible' as const,
      ...style,
    },
  }
  return animate === false
    ? <Blobatar {...common} />
    : <Blobatar {...common} animate={animate} />
}
