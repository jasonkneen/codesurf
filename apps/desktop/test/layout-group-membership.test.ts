import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GroupState, TileState } from '../src/shared/types.ts'
import {
  addTabToLeaf,
  closeOthersInLeaf,
  createLeaf,
  dockTileInTree,
  findFirstLeafId,
  getAllTileIds,
  splitLeaf,
  type PanelNode,
} from '../src/renderer/src/components/panelLayoutTree.ts'
import { computePanelTileIds } from '../src/renderer/src/lib/canvasVisibility.ts'
import { generateLayoutFromTemplate } from '../src/renderer/src/lib/layoutTemplateLaunch.ts'
import {
  appendTileAndCommitSplit,
  applyPanelTabEject,
  aspectRatioFromPanelNode,
  assignTileToGroup,
  correctLayoutBoundsOrientation,
  fitBoundsToAspect,
  assignTilesToGroup,
  attachLayoutGroupToGenerated,
  commitGroupLayout,
  convertGroupToLayoutGroup,
  ejectTileFromLayout,
  ensureLayoutGroup,
  findLayoutGroupIdForTile,
  findReusableArrangementGroupId,
  pointerEjectPosition,
  removeTileFromAllGroupLayouts,
  resolveExpandFromTile,
  resolveWorkspaceTabArrangement,
  syncTilesToLayoutGroup,
  tileIdsInLayout,
} from '../src/renderer/src/lib/layoutGroupMembership.ts'
import { computeCanvasGroupBounds } from '../src/renderer/src/hooks/useCanvasGroupManager.ts'

function tile(id: string, extra: Partial<TileState> = {}): TileState {
  return {
    id,
    type: 'note',
    x: extra.x ?? 0,
    y: extra.y ?? 0,
    width: extra.width ?? 100,
    height: extra.height ?? 100,
    zIndex: 1,
    ...extra,
  }
}

function group(id: string, extra: Partial<GroupState> = {}): GroupState {
  return { id, ...extra }
}

describe('layout group canvas aspect follows the fullscreen arrangement', () => {
  test('a column split is landscape, not a stack of tall tiles', () => {
    const left = createLeaf(['chat'])
    const layout = splitLeaf(left, left.id, 'code', 'right')
    assert.ok(aspectRatioFromPanelNode(layout) > 1)
    const tiles = [
      tile('chat', { x: 0, y: 0, width: 400, height: 800 }),
      tile('code', { x: 0, y: 0, width: 400, height: 800 }),
    ]
    const result = ensureLayoutGroup({
      tiles,
      groups: [],
      layout,
      createId: 'g-ide',
    })
    const bounds = result.groups[0].layoutBounds!
    assert.ok(bounds.w > bounds.h)
  })

  test('commitGroupLayout keeps an existing landscape frame', () => {
    const layout = createLeaf(['a', 'b'])
    const groups = [group('g1', {
      layoutMode: true,
      layout,
      layoutBounds: { x: 10, y: 20, w: 1200, h: 700 },
    })]
    const tiles = [tile('a', { groupId: 'g1', width: 400, height: 900 }), tile('b', { groupId: 'g1', width: 400, height: 900 })]
    const next = commitGroupLayout(tiles, groups, 'g1', layout)
    assert.deepEqual(next.groups[0].layoutBounds, { x: 10, y: 20, w: 1200, h: 700 })
  })

  test('a portrait frame around a column IDE is shown landscape', () => {
    const left = createLeaf(['chat'])
    const layout = splitLeaf(left, left.id, 'files', 'right')
    const groups = [group('g1', {
      layoutMode: true,
      layout,
      layoutBounds: { x: 100, y: 50, w: 420, h: 900 },
    })]
    const tiles = [tile('chat', { groupId: 'g1' }), tile('files', { groupId: 'g1' })]
    const shown = computeCanvasGroupBounds(tiles, groups, 'g1')
    assert.ok(shown)
    assert.ok(shown!.w > shown!.h)
    assert.equal(shown!.x, 100)
    assert.equal(shown!.y, 50)
  })

  test('fitBoundsToAspect flips a tall box to the fullscreen ratio', () => {
    const fitted = fitBoundsToAspect({ x: 0, y: 0, w: 400, h: 900 }, 16 / 10)
    assert.ok(fitted.w > fitted.h)
    const left = createLeaf(['a'])
    const corrected = correctLayoutBoundsOrientation(
      { x: 0, y: 0, w: 400, h: 900 },
      splitLeaf(left, left.id, 'b', 'right'),
    )
    assert.ok(corrected.w > corrected.h)
  })
})

describe('syncTilesToLayoutGroup', () => {
  test('stamps groupId onto tiles in the layout and ungroups the rest', () => {
    const layout = createLeaf(['a', 'b'])
    const tiles = [
      tile('a'),
      tile('b', { groupId: 'other' }),
      tile('c', { groupId: 'g1' }),
    ]
    const next = syncTilesToLayoutGroup(tiles, 'g1', layout)
    assert.equal(next.find(t => t.id === 'a')?.groupId, 'g1')
    assert.equal(next.find(t => t.id === 'b')?.groupId, 'g1')
    assert.equal(next.find(t => t.id === 'c')?.groupId, undefined)
  })
})

describe('computePanelTileIds hides only tiles actually in a layout tree', () => {
  test('a layoutMode groupId without a layout entry stays visible', () => {
    const groups = [group('g1', { layoutMode: true, layout: createLeaf(['a']) })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('b', { groupId: 'g1' })]
    const ids = computePanelTileIds([], groups, tiles)
    assert.equal(ids.has('a'), true)
    assert.equal(ids.has('b'), false)
  })
})

describe('ejectTileFromLayout', () => {
  test('pulls one tab out of a two-tab layout onto the canvas', () => {
    const layout = createLeaf(['chat', 'note'])
    const groups = [group('g1', { layoutMode: true, layout, color: '#4a9eff' })]
    const tiles = [
      tile('chat', { groupId: 'g1', x: 0, y: 0, width: 400, height: 300 }),
      tile('note', { groupId: 'g1', x: 10, y: 10, width: 400, height: 300 }),
    ]
    const next = ejectTileFromLayout({
      tiles,
      groups,
      groupId: 'g1',
      tileId: 'note',
      position: { x: 900, y: 80 },
      zIndex: 12,
    })
    const note = next.tiles.find(t => t.id === 'note')
    const chat = next.tiles.find(t => t.id === 'chat')
    assert.equal(note?.groupId, undefined)
    assert.equal(note?.x, 900)
    assert.equal(note?.y, 80)
    assert.equal(note?.zIndex, 12)
    assert.equal(chat?.groupId, 'g1')
    assert.equal(next.groups[0].layoutMode, true)
    assert.deepEqual(tileIdsInLayout(next.groups[0].layout), ['chat'])
  })

  test('last tab tears down the layout and removes the empty group', () => {
    const layout = createLeaf(['note'])
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('note', { groupId: 'g1' })]
    const next = ejectTileFromLayout({
      tiles,
      groups,
      groupId: 'g1',
      tileId: 'note',
      position: { x: 40, y: 50 },
      zIndex: 3,
    })
    assert.equal(next.tiles[0].groupId, undefined)
    assert.equal(next.tiles[0].x, 40)
    assert.equal(next.groups.length, 0)
  })

  test('pulls one pane out of a split and leaves the other in the layout', () => {
    const left = createLeaf(['chat'])
    const layout = splitLeaf(left, left.id, 'term', 'right')
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [
      tile('chat', { groupId: 'g1', type: 'chat' }),
      tile('term', { groupId: 'g1', type: 'terminal' }),
    ]
    const next = ejectTileFromLayout({
      tiles,
      groups,
      groupId: 'g1',
      tileId: 'term',
      position: { x: 640, y: 120 },
      zIndex: 8,
    })
    const term = next.tiles.find(entry => entry.id === 'term')
    const chat = next.tiles.find(entry => entry.id === 'chat')
    assert.equal(term?.groupId, undefined)
    assert.equal(term?.x, 640)
    assert.equal(chat?.groupId, 'g1')
    assert.deepEqual(tileIdsInLayout(next.groups[0].layout), ['chat'])
    const hidden = computePanelTileIds([], next.groups, next.tiles)
    assert.equal(hidden.has('chat'), true)
    assert.equal(hidden.has('term'), false)
  })
})

describe('pointerEjectPosition', () => {
  test('offsets from the pointer toward the titlebar and snaps', () => {
    const pos = pointerEjectPosition({ x: 400, y: 90 }, 400, value => Math.round(value / 10) * 10)
    assert.equal(pos.x, 330)
    assert.equal(pos.y, 70)
  })
})

describe('applyPanelTabEject', () => {
  test('fullscreen undock keeps leftover tabs in the layout group', () => {
    const layout = createLeaf(['chat', 'note'])
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [
      tile('chat', { groupId: 'g1' }),
      tile('note', { groupId: 'g1' }),
    ]
    const next = applyPanelTabEject({
      tiles,
      groups,
      panelLayout: layout,
      expandLayoutGroupId: 'g1',
      tileId: 'note',
      position: { x: 500, y: 40 },
      zIndex: 9,
    })
    assert.equal(next.expandLayoutGroupId, 'g1')
    assert.ok(next.panelLayout)
    assert.deepEqual(tileIdsInLayout(next.panelLayout), ['chat'])
    assert.equal(next.tiles.find(entry => entry.id === 'note')?.groupId, undefined)
    assert.equal(next.tiles.find(entry => entry.id === 'chat')?.groupId, 'g1')
  })

  test('last fullscreen tab leaves the canvas and closes the layout', () => {
    const layout = createLeaf(['note'])
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('note', { groupId: 'g1' })]
    const next = applyPanelTabEject({
      tiles,
      groups,
      panelLayout: layout,
      expandLayoutGroupId: 'g1',
      tileId: 'note',
      position: { x: 20, y: 30 },
      zIndex: 2,
    })
    assert.equal(next.panelLayout, null)
    assert.equal(next.expandLayoutGroupId, null)
    assert.equal(next.groups.length, 0)
    assert.equal(next.tiles[0].groupId, undefined)
    assert.equal(next.tiles[0].x, 20)
  })
})

describe('assignTileToGroup', () => {
  test('dropping onto a layout group adds the tile to the tree', () => {
    const layout = createLeaf(['a'])
    const groups = [group('g1', { layoutMode: true, layout, color: '#4a9eff' })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('b')]
    const next = assignTileToGroup(tiles, groups, 'b', 'g1')
    assert.equal(next.tiles.find(t => t.id === 'b')?.groupId, 'g1')
    assert.ok(tileIdsInLayout(next.groups[0].layout).includes('b'))
  })

  test('removing from a layout group takes the tile out of the tree', () => {
    const layout = createLeaf(['a', 'b'])
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('b', { groupId: 'g1' })]
    const next = assignTileToGroup(tiles, groups, 'b', undefined)
    assert.equal(next.tiles.find(t => t.id === 'b')?.groupId, undefined)
    assert.deepEqual(tileIdsInLayout(next.groups[0].layout), ['a'])
  })
})

describe('removeTileFromAllGroupLayouts', () => {
  test('clears layoutMode when the last tab leaves', () => {
    const groups = [group('g1', { layoutMode: true, layout: createLeaf(['a']) })]
    const next = removeTileFromAllGroupLayouts(groups, 'a')
    assert.equal(next[0].layoutMode, false)
    assert.equal(next[0].layout, undefined)
  })
})

describe('commitGroupLayout', () => {
  test('closing a tab ungroups that tile instead of hiding it', () => {
    const layout = createLeaf(['a', 'b'])
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('b', { groupId: 'g1' })]
    const nextLayout = createLeaf(['a'])
    const next = commitGroupLayout(tiles, groups, 'g1', nextLayout)
    assert.equal(next.tiles.find(t => t.id === 'b')?.groupId, undefined)
    assert.equal(next.tiles.find(t => t.id === 'a')?.groupId, 'g1')
    assert.deepEqual(tileIdsInLayout(next.groups[0].layout), ['a'])
  })
})

describe('ensureLayoutGroup', () => {
  test('creates a layout group and stamps every tree member', () => {
    const layout = createLeaf(['a', 'b'])
    const result = ensureLayoutGroup({
      tiles: [tile('a'), tile('b'), tile('c')],
      groups: [],
      layout,
      createId: 'g-new',
    })
    assert.equal(result.groupId, 'g-new')
    assert.equal(result.groups[0].layoutMode, true)
    assert.equal(result.tiles.find(t => t.id === 'a')?.groupId, 'g-new')
    assert.equal(result.tiles.find(t => t.id === 'b')?.groupId, 'g-new')
    assert.equal(result.tiles.find(t => t.id === 'c')?.groupId, undefined)
  })

  test('reuses a dashed group and flattens nested children', () => {
    const tiles = [
      tile('a', { groupId: 'root', x: 0, y: 0 }),
      tile('b', { groupId: 'child', x: 120, y: 0 }),
    ]
    const groups = [
      group('root'),
      group('child', { parentGroupId: 'root' }),
    ]
    const layout = createLeaf(['a', 'b'])
    const result = ensureLayoutGroup({ tiles, groups, layout, reuseGroupId: 'root' })
    assert.equal(result.groupId, 'root')
    assert.equal(result.groups.some(g => g.id === 'child'), false)
    assert.equal(result.tiles.find(t => t.id === 'b')?.groupId, 'root')
    assert.equal(result.groups[0].layoutMode, true)
  })
})

describe('resolveExpandFromTile', () => {
  test('expands the existing layout group instead of a sibling-capped leaf', () => {
    const left = createLeaf(['a'])
    const root = splitLeaf(left, left.id, 'b', 'right') as PanelNode
    const groups = [group('g1', { layoutMode: true, layout: root })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('b', { groupId: 'g1' }), tile('c')]
    const resolved = resolveExpandFromTile({ tileId: 'b', tiles, groups })
    assert.equal(resolved.reuseGroupId, 'g1')
    assert.deepEqual(new Set(resolved.tileIds), new Set(['a', 'b']))
    assert.ok(resolved.layout.type === 'split' || getAllTileIds(resolved.layout).includes('a'))
  })

  test('includes every nested dashed-group member with no sibling cap', () => {
    const tiles = [
      tile('a', { groupId: 'root', x: 0, y: 0 }),
      ...Array.from({ length: 10 }, (_, i) => tile(`n${i}`, { groupId: 'child', x: (i + 1) * 120, y: 0 })),
    ]
    const groups = [group('root'), group('child', { parentGroupId: 'root' })]
    const resolved = resolveExpandFromTile({ tileId: 'a', tiles, groups })
    assert.equal(resolved.reuseGroupId, 'root')
    assert.equal(resolved.tileIds.length, 11)
  })

  test('a lone ungrouped tile still becomes a one-tile arrangement', () => {
    const resolved = resolveExpandFromTile({
      tileId: 'solo',
      tiles: [tile('solo')],
      groups: [],
    })
    assert.deepEqual(resolved.tileIds, ['solo'])
    assert.equal(resolved.reuseGroupId, null)
  })
})

describe('resolveWorkspaceTabArrangement', () => {
  test('does not steal tiles from another layout group', () => {
    const other = createLeaf(['kept'])
    const saved = createLeaf(['free', 'kept'])
    const groups = [group('g1', { layoutMode: true, layout: other })]
    const tiles = [tile('free'), tile('kept', { groupId: 'g1' })]
    const resolved = resolveWorkspaceTabArrangement({
      tiles,
      groups,
      savedLayout: saved,
    })
    const next = ensureLayoutGroup({
      tiles,
      groups,
      layout: resolved.layout,
      reuseGroupId: resolved.reuseGroupId,
      createId: 'g-tab',
    })
    const still = next.groups.find(g => g.id === 'g1')
    assert.ok(still)
    assert.deepEqual(tileIdsInLayout(still!.layout), ['kept'])
    assert.equal(next.tiles.find(t => t.id === 'kept')?.groupId, 'g1')
    assert.notEqual(next.tiles.find(t => t.id === 'free')?.groupId, 'g1')
  })

  test('selected tile in a layout group expands that group', () => {
    const layout = createLeaf(['a', 'b'])
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('b', { groupId: 'g1' }), tile('loose')]
    const resolved = resolveWorkspaceTabArrangement({
      tiles,
      groups,
      savedLayout: null,
      selectedTileId: 'b',
    })
    assert.equal(resolved.reuseGroupId, 'g1')
    assert.deepEqual(new Set(resolved.tileIds), new Set(['a', 'b']))
  })

  test('with no saved layout, only free tiles enter the new arrangement', () => {
    const groups = [group('g1', { layoutMode: true, layout: createLeaf(['hid']) })]
    const tiles = [tile('hid', { groupId: 'g1' }), tile('free-a'), tile('free-b')]
    const resolved = resolveWorkspaceTabArrangement({ tiles, groups, savedLayout: null })
    assert.deepEqual(new Set(resolved.tileIds), new Set(['free-a', 'free-b']))
    assert.equal(resolved.reuseGroupId, null)
  })
})

describe('convertGroupToLayoutGroup', () => {
  test('flattens nested members into one layout tree', () => {
    const tiles = [
      tile('a', { groupId: 'root', x: 0, y: 0, width: 100, height: 100 }),
      tile('b', { groupId: 'child', x: 140, y: 0, width: 100, height: 100 }),
    ]
    const groups = [group('root'), group('child', { parentGroupId: 'root' })]
    const next = convertGroupToLayoutGroup(tiles, groups, 'root')
    assert.ok(next)
    assert.equal(next!.groups.some(g => g.id === 'child'), false)
    assert.equal(next!.groups[0].layoutMode, true)
    assert.deepEqual(new Set(tileIdsInLayout(next!.groups[0].layout)), new Set(['a', 'b']))
    assert.equal(next!.tiles.find(t => t.id === 'b')?.groupId, 'root')
  })
})

describe('attachLayoutGroupToGenerated', () => {
  test('template tiles become one layout group', () => {
    const tiles = [tile('t1'), tile('t2')]
    const left = createLeaf(['t1'])
    const panelLayout = splitLeaf(left, left.id, 't2', 'right')
    const attached = attachLayoutGroupToGenerated({
      tiles,
      panelLayout,
      groupId: 'g-template',
    })
    assert.equal(attached.expandLayoutGroupId, 'g-template')
    assert.equal(attached.groups[0].layoutMode, true)
    assert.equal(attached.tiles.every(t => t.groupId === 'g-template'), true)
  })
})

describe('findLayoutGroupIdForTile', () => {
  test('resolves ownership from the layout tree, not only groupId', () => {
    const groups = [group('g1', { layoutMode: true, layout: createLeaf(['a']) })]
    assert.equal(findLayoutGroupIdForTile(groups, 'a'), 'g1')
    assert.equal(findLayoutGroupIdForTile(groups, 'missing'), null)
  })
})

describe('generateLayoutFromTemplate', () => {
  test('launches as a layout group, not ungrouped tiles', () => {
    const generated = generateLayoutFromTemplate({
      id: 'tpl',
      name: 'IDE',
      created_at: '2026-01-01',
      tree: {
        type: 'split',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', slots: [{ tileType: 'chat', label: 'Chat' }] },
          { type: 'leaf', slots: [{ tileType: 'code', label: 'Code' }] },
        ],
      },
    }, 1)
    assert.ok(generated)
    assert.equal(generated!.groups.length, 1)
    assert.equal(generated!.groups[0].layoutMode, true)
    assert.equal(generated!.expandLayoutGroupId, generated!.groups[0].id)
    assert.ok(generated!.tiles.every(t => t.groupId === generated!.expandLayoutGroupId))
  })
})

describe('fullscreen enter/exit is one canvas layout group', () => {
  test('leaving fullscreen keeps the same tiles in the layout tree, not a second free pile', () => {
    const tiles = [tile('chat'), tile('code'), tile('note'), tile('stray')]
    const live = createLeaf(['chat', 'code', 'note'], 'chat')
    const entered = ensureLayoutGroup({
      tiles,
      groups: [],
      layout: live,
      createId: 'g-ide',
    })
    assert.equal(entered.groupId, 'g-ide')
    assert.deepEqual(new Set(tileIdsInLayout(entered.groups[0].layout)), new Set(['chat', 'code', 'note']))

    const exited = commitGroupLayout(entered.tiles, entered.groups, entered.groupId, live)
    assert.deepEqual(new Set(tileIdsInLayout(exited.groups[0].layout)), new Set(['chat', 'code', 'note']))
    assert.equal(exited.tiles.find(t => t.id === 'chat')?.groupId, 'g-ide')
    assert.equal(exited.tiles.find(t => t.id === 'code')?.groupId, 'g-ide')
    assert.equal(exited.tiles.find(t => t.id === 'note')?.groupId, 'g-ide')
    assert.equal(exited.tiles.find(t => t.id === 'stray')?.groupId, undefined)

    const hidden = computePanelTileIds([], exited.groups, exited.tiles)
    assert.equal(hidden.has('chat'), true)
    assert.equal(hidden.has('stray'), false)
  })

  test('a tile added while fullscreen stays in the group after exit', () => {
    const start = createLeaf(['chat', 'code'], 'chat')
    const entered = ensureLayoutGroup({
      tiles: [tile('chat'), tile('code')],
      groups: [],
      layout: start,
      createId: 'g-ide',
    })
    const leafId = findFirstLeafId(entered.layout)
    assert.ok(leafId)
    const live = addTabToLeaf(entered.layout, leafId!, 'term')
    const withTerm = [...entered.tiles, tile('term')]
    const exited = commitGroupLayout(withTerm, entered.groups, entered.groupId, live)
    assert.ok(tileIdsInLayout(exited.groups[0].layout).includes('term'))
    assert.equal(exited.tiles.find(t => t.id === 'term')?.groupId, 'g-ide')
    assert.equal(computePanelTileIds([], exited.groups, exited.tiles).has('term'), true)
  })

  test('tab toggle after exit reopens the same arrangement, not another layout group', () => {
    const other = createLeaf(['kept'])
    const groups = [group('other', { layoutMode: true, layout: other })]
    const tiles = [tile('chat'), tile('code'), tile('kept', { groupId: 'other' })]
    const entered = ensureLayoutGroup({
      tiles,
      groups,
      layout: createLeaf(['chat', 'code'], 'chat'),
      createId: 'g-ide',
    })
    const exited = commitGroupLayout(entered.tiles, entered.groups, entered.groupId, entered.layout)
    const saved = exited.groups.find(g => g.id === 'g-ide')?.layout
    const reopened = resolveWorkspaceTabArrangement({
      tiles: exited.tiles,
      groups: exited.groups,
      savedLayout: saved as PanelNode,
    })
    assert.equal(reopened.reuseGroupId, 'g-ide')
    assert.deepEqual(new Set(reopened.tileIds), new Set(['chat', 'code']))
    assert.ok(!reopened.tileIds.includes('kept'))
  })
})

describe('stale savedLayout vs current group.layout', () => {
  test('grown group reopens the current tile set, not a stale subset snapshot', () => {
    const current = createLeaf(['a', 'b', 'c'], 'c')
    const stale = createLeaf(['a', 'b'], 'a')
    const groups = [group('g1', { layoutMode: true, layout: current })]
    const tiles = [
      tile('a', { groupId: 'g1' }),
      tile('b', { groupId: 'g1' }),
      tile('c', { groupId: 'g1' }),
    ]
    const resolved = resolveWorkspaceTabArrangement({
      tiles,
      groups,
      savedLayout: stale,
    })
    assert.equal(resolved.reuseGroupId, 'g1')
    assert.deepEqual(new Set(resolved.tileIds), new Set(['a', 'b', 'c']))
    const reopened = ensureLayoutGroup({
      tiles,
      groups,
      layout: resolved.layout,
      reuseGroupId: resolved.reuseGroupId,
    })
    assert.deepEqual(new Set(tileIdsInLayout(reopened.groups[0].layout)), new Set(['a', 'b', 'c']))
    assert.equal(reopened.tiles.every(t => t.groupId === 'g1'), true)
  })

  test('shrunk group reopens the current tree and does not re-hide a close-tabbed tile', () => {
    const current = createLeaf(['a'], 'a')
    const stale = createLeaf(['a', 'b'], 'a')
    const groups = [group('g1', { layoutMode: true, layout: current })]
    const tiles = [
      tile('a', { groupId: 'g1' }),
      tile('b'),
    ]
    const resolved = resolveWorkspaceTabArrangement({
      tiles,
      groups,
      savedLayout: stale,
    })
    assert.equal(resolved.reuseGroupId, 'g1')
    assert.deepEqual(resolved.tileIds, ['a'])
    const reopened = ensureLayoutGroup({
      tiles,
      groups,
      layout: resolved.layout,
      reuseGroupId: resolved.reuseGroupId,
    })
    assert.deepEqual(tileIdsInLayout(reopened.groups[0].layout), ['a'])
    assert.equal(reopened.tiles.find(t => t.id === 'b')?.groupId, undefined)
    assert.equal(computePanelTileIds([], reopened.groups, reopened.tiles).has('b'), false)
  })
})

describe('leftover layout groupId is not a reuse target', () => {
  test('tab view of leftover C plus free D does not overwrite layout group [A,B]', () => {
    const g1Layout = createLeaf(['a', 'b'], 'a')
    const groups = [group('g1', { layoutMode: true, layout: g1Layout })]
    const tiles = [
      tile('a', { groupId: 'g1' }),
      tile('b', { groupId: 'g1' }),
      tile('c', { groupId: 'g1' }),
      tile('d'),
    ]
    const resolved = resolveWorkspaceTabArrangement({
      tiles,
      groups,
      savedLayout: null,
    })
    assert.notEqual(resolved.reuseGroupId, 'g1')
    assert.equal(findReusableArrangementGroupId(tiles, groups, resolved.tileIds), null)
    const next = ensureLayoutGroup({
      tiles,
      groups,
      layout: resolved.layout,
      reuseGroupId: resolved.reuseGroupId,
      createId: 'g-free',
    })
    const still = next.groups.find(g => g.id === 'g1')
    assert.ok(still)
    assert.deepEqual(new Set(tileIdsInLayout(still!.layout)), new Set(['a', 'b']))
    assert.equal(next.tiles.find(t => t.id === 'a')?.groupId, 'g1')
    assert.equal(next.tiles.find(t => t.id === 'b')?.groupId, 'g1')
  })
})

describe('fullscreen close others commits membership immediately', () => {
  test('close others ungroups siblings so they are not hidden', () => {
    const layout = createLeaf(['a', 'b', 'c'], 'a')
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [
      tile('a', { groupId: 'g1' }),
      tile('b', { groupId: 'g1' }),
      tile('c', { groupId: 'g1' }),
    ]
    const closed = closeOthersInLeaf(layout, layout.id, 'a')
    const next = commitGroupLayout(tiles, groups, 'g1', closed)
    assert.deepEqual(tileIdsInLayout(next.groups[0].layout), ['a'])
    assert.equal(next.tiles.find(t => t.id === 'b')?.groupId, undefined)
    assert.equal(next.tiles.find(t => t.id === 'c')?.groupId, undefined)
    const hidden = computePanelTileIds(tileIdsInLayout(closed), next.groups, next.tiles)
    assert.equal(hidden.has('a'), true)
    assert.equal(hidden.has('b'), false)
    assert.equal(hidden.has('c'), false)
  })
})

describe('tab dock commits layout membership', () => {
  test('snapping a tab left keeps both tiles in the group tree', () => {
    const tiles = [
      tile('chat', { type: 'chat' }),
      tile('term', { type: 'terminal', x: 400 }),
    ]
    const leaf = createLeaf(['chat', 'term'])
    const entered = ensureLayoutGroup({ tiles, groups: [], layout: leaf, createId: 'g1' })
    const nextLayout = dockTileInTree(entered.layout, 'term', leaf.id, leaf.id, 'left')
    const next = commitGroupLayout(entered.tiles, entered.groups, entered.groupId, nextLayout)
    const layoutGroup = next.groups.find(entry => entry.id === entered.groupId)
    assert.equal(layoutGroup?.layoutMode, true)
    assert.deepEqual(getAllTileIds(layoutGroup?.layout as PanelNode).sort(), ['chat', 'term'])
    assert.equal(next.tiles.every(entry => entry.groupId === entered.groupId), true)
    assert.equal(nextLayout.type, 'split')
  })
})

describe('appendTileAndCommitSplit', () => {
  test('fullscreen panel split updates tiles before layout commit', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/AppCanvasPanelRegion.tsx'), 'utf8')
    assert.match(source, /appendTileAndCommitSplit/)
    assert.match(source, /tilesRef/)
    assert.match(source, /onTabDropOutside/)
    assert.doesNotMatch(source, /setTiles\(prev => \[\.\.\.prev, newTile\]\)/)
  })

  test('dragging a tab off a layout undocks it onto the canvas', () => {
    const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const frames = readFileSync(join(process.cwd(), 'src/renderer/src/components/canvas/CanvasGroupFrames.tsx'), 'utf8')
    const panel = readFileSync(join(process.cwd(), 'src/renderer/src/components/PanelLayout.tsx'), 'utf8')
    const framesBlock = app.slice(app.indexOf('<CanvasGroupFrames'), app.indexOf('<AppCanvasWorldOverlays'))
    assert.match(framesBlock, /screenToWorld=\{screenToWorld\}/)
    assert.match(framesBlock, /snapValue=\{snapValue\}/)
    assert.match(app, /ejectPanelTab/)
    assert.match(frames, /ejectTileFromLayout/)
    assert.match(frames, /onTabDropOutside/)
    assert.match(panel, /resolveTabDrop/)
    assert.match(panel, /onTabDropOutsideRef\.current\?\.\(tileId/)
  })

  test('commits the appended tile so a split pane is not clobbered', () => {
    const layout = createLeaf(['a'], 'a')
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('a', { groupId: 'g1' })]
    const newTile = tile('term', { x: 120, width: 80 })
    const result = appendTileAndCommitSplit({
      tiles,
      groups,
      layout,
      groupId: 'g1',
      newTile,
      panelId: layout.id,
      zone: 'right',
    })
    assert.ok(result.tiles.some(t => t.id === 'term'))
    assert.equal(result.tiles.find(t => t.id === 'term')?.groupId, 'g1')
    assert.ok(tileIdsInLayout(result.layout).includes('term'))
    assert.ok(tileIdsInLayout(result.groups[0].layout).includes('term'))
    assert.equal(computePanelTileIds(tileIdsInLayout(result.layout), result.groups, result.tiles).has('term'), true)
  })

  test('committing a split from a stale tiles array drops the new pane', () => {
    const layout = createLeaf(['a'], 'a')
    const groups = [group('g1', { layoutMode: true, layout })]
    const tiles = [tile('a', { groupId: 'g1' })]
    const nextLayout = splitLeaf(layout, layout.id, 'term', 'right')
    const stale = commitGroupLayout(tiles, groups, 'g1', nextLayout)
    assert.equal(stale.tiles.some(t => t.id === 'term'), false)
    assert.ok(tileIdsInLayout(stale.groups[0].layout).includes('term'))
  })
})

describe('assignTilesToGroup paste into layout', () => {
  test('pasted tiles join the layout tree', () => {
    const groups = [group('g1', { layoutMode: true, layout: createLeaf(['a']) })]
    const tiles = [tile('a', { groupId: 'g1' }), tile('p1'), tile('p2')]
    const next = assignTilesToGroup(tiles, groups, ['p1', 'p2'], 'g1')
    assert.deepEqual(new Set(tileIdsInLayout(next.groups[0].layout)), new Set(['a', 'p1', 'p2']))
    assert.equal(next.tiles.find(t => t.id === 'p1')?.groupId, 'g1')
  })
})
