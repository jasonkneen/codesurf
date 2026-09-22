import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  groupChromeColors,
  innerRadiiForFrame,
  isGroupChromeActive,
  LAYOUT_FRAME_BORDER_PX,
  LAYOUT_FRAME_INNER_RADIUS_PX,
  LAYOUT_FRAME_LEAF_RADII,
  LAYOUT_FRAME_RADIUS_PX,
  tileFrameChrome,
} from '../src/renderer/src/lib/groupChrome.ts'

describe('isGroupChromeActive', () => {
  test('lights up when dragging or when a member tile is selected', () => {
    expect(isGroupChromeActive({
      memberIds: ['a', 'b'],
      selectedTileId: null,
      selectedTileIds: new Set(),
      dragging: true,
    })).toBe(true)
    expect(isGroupChromeActive({
      memberIds: ['a', 'b'],
      selectedTileId: 'b',
      selectedTileIds: new Set(),
      dragging: false,
    })).toBe(true)
    expect(isGroupChromeActive({
      memberIds: ['a', 'b'],
      selectedTileId: null,
      selectedTileIds: new Set(['a']),
      dragging: false,
    })).toBe(true)
  })

  test('stays dim when nothing in the group is selected', () => {
    expect(isGroupChromeActive({
      memberIds: ['a', 'b'],
      selectedTileId: 'other',
      selectedTileIds: new Set(['x']),
      dragging: false,
    })).toBe(false)
  })
})

describe('groupChromeColors', () => {
  test('active chrome is the current full theme tint; idle is dimmer', () => {
    const color = '#4a9eff'
    const active = groupChromeColors(color, true)
    const idle = groupChromeColors(color, false)
    expect(active.border).toBe('#4a9effbb')
    expect(active.label).toBe('#4a9effee')
    expect(idle.border).toBe('#4a9eff55')
    expect(idle.label).toBe('#4a9eff88')
  })
})

describe('layout frame inner radii', () => {
  test('nested pane radius sits flush inside the 2px frame border', () => {
    expect(LAYOUT_FRAME_INNER_RADIUS_PX).toBe(LAYOUT_FRAME_RADIUS_PX - LAYOUT_FRAME_BORDER_PX)
    expect(innerRadiiForFrame(12, 2, false)).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 10,
      bottomLeft: 10,
    })
    expect(LAYOUT_FRAME_LEAF_RADII.bottomLeft).toBe(10)
    expect(LAYOUT_FRAME_LEAF_RADII.topLeft).toBe(0)
  })
})

describe('tileFrameChrome', () => {
  test('idle tiles have no theme-color border; selected tiles use the full accent tint', () => {
    expect(tileFrameChrome('#4a9eff', false)).toEqual({
      border: 'transparent',
      titlebarFill: undefined,
      titlebarBorder: undefined,
      label: undefined,
    })
    expect(tileFrameChrome('#4a9eff', true)).toEqual({
      border: '#4a9effbb',
      titlebarFill: '#4a9eff22',
      titlebarBorder: '#4a9effbb',
      label: '#4a9effee',
    })
  })
})

describe('layout group nested chrome', () => {
  test('embedded panel layout is flush to the frame — no inset, hairline, or oversized inner radius', () => {
    const frames = readFileSync(join(process.cwd(), 'src/renderer/src/components/canvas/CanvasGroupFrames.tsx'), 'utf8')
    const panel = readFileSync(join(process.cwd(), 'src/renderer/src/components/PanelLayout.tsx'), 'utf8')
    expect(frames).toContain('insetBottom={0}')
    expect(frames).toContain('outerRadii={LAYOUT_FRAME_LEAF_RADII}')
    expect(frames).toContain('flushLeafChrome')
    expect(panel).toContain("border: flushLeafChrome ? 'none' : '0.5px solid transparent'")
    expect(panel).toContain("boxShadow: flushLeafChrome ? 'none' : 'var(--cs-edge-shadow-strong)'")
    expect(panel).toContain('insetBottom = 0')
  })
})
