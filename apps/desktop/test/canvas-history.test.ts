import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyCanvasHistoryRedo,
  applyCanvasHistoryUndo,
  buildCanvasHistoryEntry,
  isEmptyCanvasHistoryEntry,
} from '../src/renderer/src/hooks/canvasHistory.ts'
import type { GroupState, TileState } from '../src/shared/types.ts'

function tile(id: string, x: number, y = 0): TileState {
  return { id, type: 'note', x, y, width: 200, height: 120, zIndex: 1 }
}

describe('buildCanvasHistoryEntry', () => {
  test('captures a single moved tile as a delta', () => {
    const before = [tile('a', 0), tile('b', 100)]
    const after = [tile('a', 40), tile('b', 100)]
    const entry = buildCanvasHistoryEntry(before, after, [], [])
    assert.equal(entry.addedTiles.length, 0)
    assert.equal(entry.removedTiles.length, 0)
    assert.equal(entry.beforeModified.length, 1)
    assert.equal(entry.afterModified.length, 1)
    assert.equal(entry.beforeModified[0]?.x, 0)
    assert.equal(entry.afterModified[0]?.x, 40)
    assert.equal(isEmptyCanvasHistoryEntry(entry), false)
  })

  test('captures added and removed tiles', () => {
    const before = [tile('a', 0)]
    const after = [tile('b', 10)]
    const entry = buildCanvasHistoryEntry(before, after, [], [])
    assert.equal(entry.removedTiles[0]?.id, 'a')
    assert.equal(entry.addedTiles[0]?.id, 'b')
  })
})

describe('applyCanvasHistoryUndo/Redo', () => {
  test('round-trips a drag change', () => {
    const before = [tile('a', 0), tile('b', 100)]
    const after = [tile('a', 40), tile('b', 100)]
    const entry = buildCanvasHistoryEntry(before, after, [], [])

    const undone = applyCanvasHistoryUndo(after, [], entry)
    assert.deepEqual(undone.tiles.map(t => t.x), [0, 100])

    const redone = applyCanvasHistoryRedo(undone.tiles, undone.groups, entry)
    assert.deepEqual(redone.tiles.map(t => t.x), [40, 100])
  })

  test('restores group changes', () => {
    const beforeGroups: GroupState[] = [{ id: 'g1', label: 'Before' }]
    const afterGroups: GroupState[] = [{ id: 'g1', label: 'After' }]
    const entry = buildCanvasHistoryEntry([], [], beforeGroups, afterGroups)
    const undone = applyCanvasHistoryUndo([], afterGroups, entry)
    assert.equal(undone.groups[0]?.label, 'Before')
    const redone = applyCanvasHistoryRedo(undone.tiles, undone.groups, entry)
    assert.equal(redone.groups[0]?.label, 'After')
  })
})