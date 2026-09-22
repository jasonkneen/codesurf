import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  collectPanelLeaves,
  createLeaf,
  dockTileInTree,
  getAllTileIds,
  splitLeaf,
} from '../src/renderer/src/components/panelLayoutTree.ts'
import { dockZoneFromRect, pickInnermostRect, resolveTabDrop } from '../src/renderer/src/lib/panelDock.ts'

const rect = { left: 0, top: 0, width: 400, height: 200 }

describe('dockZoneFromRect', () => {
  test('maps the 25% edges to left/right/top/bottom and the middle to center', () => {
    expect(dockZoneFromRect(rect, 20, 100, { minEdgePx: 0 })).toBe('left')
    expect(dockZoneFromRect(rect, 390, 100, { minEdgePx: 0 })).toBe('right')
    expect(dockZoneFromRect(rect, 200, 10, { minEdgePx: 0 })).toBe('top')
    expect(dockZoneFromRect(rect, 200, 195, { minEdgePx: 0 })).toBe('bottom')
    expect(dockZoneFromRect(rect, 200, 100, { minEdgePx: 0 })).toBe('center')
  })

  test('keeps edge zones hittable on a zoomed-out canvas panel', () => {
    const small = { left: 0, top: 0, width: 80, height: 60 }
    expect(dockZoneFromRect(small, 10, 30)).toBe('left')
    expect(dockZoneFromRect(small, 70, 30)).toBe('right')
    expect(dockZoneFromRect(small, 40, 8)).toBe('top')
    expect(dockZoneFromRect(small, 40, 55)).toBe('bottom')
    expect(dockZoneFromRect(small, 40, 30)).toBe('center')
  })

  test('left wins over top in the corner (same as fullscreen)', () => {
    expect(dockZoneFromRect(rect, 10, 10, { minEdgePx: 0 })).toBe('left')
  })
})

describe('resolveTabDrop', () => {
  test('a miss on this layout ejects when undock is wired', () => {
    expect(resolveTabDrop(null, true)).toBe('eject')
    expect(resolveTabDrop(null, false)).toBe('ignore')
  })

  test('a hit on a panel still docks', () => {
    expect(resolveTabDrop('panel-1', true)).toBe('dock')
    expect(resolveTabDrop('panel-1', false)).toBe('dock')
  })
})

describe('pickInnermostRect', () => {
  test('prefers the nested panel under the pointer', () => {
    const id = pickInnermostRect([
      { id: 'outer', rect: { left: 0, top: 0, width: 400, height: 200 } },
      { id: 'inner', rect: { left: 200, top: 0, width: 200, height: 200 } },
    ], 300, 100)
    expect(id).toBe('inner')
  })

  test('returns null when the pointer is outside every panel', () => {
    expect(pickInnermostRect([{ id: 'a', rect }], 500, 100)).toBeNull()
  })
})

describe('dockTileInTree', () => {
  test('snaps a tab to the left of its own leaf', () => {
    const leaf = createLeaf(['chat', 'term'])
    const next = dockTileInTree(leaf, 'term', leaf.id, leaf.id, 'left')
    expect(next.type).toBe('split')
    if (next.type !== 'split') return
    expect(next.direction).toBe('horizontal')
    const leaves = collectPanelLeaves(next)
    expect(leaves[0]?.tabs).toEqual(['term'])
    expect(leaves[1]?.tabs).toEqual(['chat'])
  })

  test('snaps a tab to the bottom of another leaf', () => {
    const left = createLeaf(['chat'])
    const root = splitLeaf(left, left.id, 'term', 'right')
    const termLeaf = collectPanelLeaves(root).find(leaf => leaf.tabs.includes('term'))
    expect(termLeaf != null).toBe(true)
    if (!termLeaf) return
    const next = dockTileInTree(root, 'chat', left.id, termLeaf.id, 'bottom')
    expect(next.type).toBe('split')
    if (next.type !== 'split') return
    expect(next.direction).toBe('vertical')
    const leaves = collectPanelLeaves(next)
    expect(leaves.some(leaf => leaf.tabs.includes('term') && !leaf.tabs.includes('chat'))).toBe(true)
    expect(leaves.some(leaf => leaf.tabs[0] === 'chat')).toBe(true)
    expect(getAllTileIds(next).sort()).toEqual(['chat', 'term'])
  })

  test('does not drop a tab when the target panel is from another layout', () => {
    const leaf = createLeaf(['chat', 'term'])
    const next = dockTileInTree(leaf, 'term', leaf.id, 'panel-from-other-group', 'right')
    expect(next).toBe(leaf)
  })

  test('center-dock onto the same leaf is a no-op', () => {
    const leaf = createLeaf(['chat', 'term'])
    expect(dockTileInTree(leaf, 'term', leaf.id, leaf.id, 'center')).toBe(leaf)
  })
})

describe('splitLeaf solo tab', () => {
  test('does not duplicate the only tab when dragged to an edge of itself', () => {
    const leaf = createLeaf(['only'])
    const next = splitLeaf(leaf, leaf.id, 'only', 'right')
    expect(next).toBe(leaf)
  })
})
