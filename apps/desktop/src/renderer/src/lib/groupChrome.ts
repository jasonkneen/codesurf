/**
 * Group/layout frame chrome: dim the theme color at rest, restore it when
 * the group is the selection (a member tile is selected, or the group is
 * being dragged).
 */

export const LAYOUT_FRAME_RADIUS_PX = 12
export const LAYOUT_FRAME_BORDER_PX = 2
export const LAYOUT_FRAME_INNER_RADIUS_PX = LAYOUT_FRAME_RADIUS_PX - LAYOUT_FRAME_BORDER_PX

export type FrameCornerRadii = {
  topLeft: number
  topRight: number
  bottomRight: number
  bottomLeft: number
}

/** Inner clip radius so a nested pane sits flush against this frame's border. */
export function innerRadiiForFrame(
  outerRadius: number,
  borderWidth: number,
  roundTop = true,
): FrameCornerRadii {
  const inner = Math.max(0, outerRadius - borderWidth)
  const top = roundTop ? inner : 0
  return {
    topLeft: top,
    topRight: top,
    bottomRight: inner,
    bottomLeft: inner,
  }
}

export const LAYOUT_FRAME_LEAF_RADII = innerRadiiForFrame(
  LAYOUT_FRAME_RADIUS_PX,
  LAYOUT_FRAME_BORDER_PX,
  false,
)

export type GroupChromeColors = {
  border: string
  label: string
  fill: string
  headerFill: string
}

function hexRgb(color: string): string {
  const raw = color.trim()
  if (/^#[0-9a-f]{8}$/i.test(raw)) return raw.slice(0, 7)
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
  }
  return raw
}

function withHexAlpha(color: string, alpha: string): string {
  const rgb = hexRgb(color)
  if (!/^#[0-9a-f]{6}$/i.test(rgb)) return color
  return `${rgb}${alpha}`
}

export function isGroupChromeActive(input: {
  memberIds: readonly string[]
  selectedTileId: string | null
  selectedTileIds: ReadonlySet<string>
  dragging: boolean
}): boolean {
  if (input.dragging) return true
  if (input.selectedTileId && input.memberIds.includes(input.selectedTileId)) return true
  for (const id of input.memberIds) {
    if (input.selectedTileIds.has(id)) return true
  }
  return false
}

/** Idle = muted theme tint. Active = the current "selected" blue/color. */
export function groupChromeColors(color: string, active: boolean): GroupChromeColors {
  if (active) {
    return {
      border: withHexAlpha(color, 'bb'),
      label: withHexAlpha(color, 'ee'),
      fill: withHexAlpha(color, '14'),
      headerFill: withHexAlpha(color, '22'),
    }
  }
  return {
    border: withHexAlpha(color, '55'),
    label: withHexAlpha(color, '88'),
    fill: withHexAlpha(color, '0a'),
    headerFill: withHexAlpha(color, '12'),
  }
}

export type TileFrameChrome = {
  border: string
  titlebarFill: string | undefined
  titlebarBorder: string | undefined
  label: string | undefined
}

/** Canvas tile frame: idle stays the grey hairline; selected uses the theme color. */
export function tileFrameChrome(accent: string, selected: boolean): TileFrameChrome {
  if (!selected) {
    return {
      border: 'transparent',
      titlebarFill: undefined,
      titlebarBorder: undefined,
      label: undefined,
    }
  }
  const chrome = groupChromeColors(accent, true)
  return {
    border: chrome.border,
    titlebarFill: chrome.headerFill,
    titlebarBorder: chrome.border,
    label: chrome.label,
  }
}
