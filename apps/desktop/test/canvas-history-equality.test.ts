import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  groupStateEqual,
  groupsEqual,
  stringArrayEqual,
  tileStateEqual,
  buildCanvasHistoryEntry,
  applyCanvasHistoryUndo,
  applyCanvasHistoryRedo,
} from '../src/renderer/src/hooks/canvasHistory.ts'
import type { GroupState, TileState } from '../src/shared/types.ts'

function group(partial: Partial<GroupState> & { id: string }): GroupState {
  return { id: partial.id, label: partial.label, color: partial.color, parentGroupId: partial.parentGroupId, layoutMode: partial.layoutMode, layout: partial.layout, layoutBounds: partial.layoutBounds }
}

function tile(id: string, x: number, launchArgs?: string[]): TileState {
  return {
    id,
    type: 'note',
    x,
    y: 0,
    width: 200,
    height: 120,
    zIndex: 1,
    launchArgs,
  }
}

describe('canvas history structural equality (no JSON.stringify path)', () => {
  test('stringArrayEqual compares element-wise', () => {
    assert.equal(stringArrayEqual(['a', 'b'], ['a', 'b']), true)
    assert.equal(stringArrayEqual(['a'], ['a', 'b']), false)
    assert.equal(stringArrayEqual(undefined, []), true)
    assert.equal(stringArrayEqual(['a'], undefined), false)
  })

  test('groupStateEqual is true for identical fields', () => {
    const a = group({ id: 'g1', label: 'A', color: '#fff', layoutMode: true, layoutBounds: { x: 1, y: 2, w: 3, h: 4 } })
    const b = group({ id: 'g1', label: 'A', color: '#fff', layoutMode: true, layoutBounds: { x: 1, y: 2, w: 3, h: 4 } })
    assert.equal(groupStateEqual(a, b), true)
  })

  test('groupStateEqual is false when bounds or label differ', () => {
    const a = group({ id: 'g1', label: 'A', layoutBounds: { x: 0, y: 0, w: 10, h: 10 } })
    const b = group({ id: 'g1', label: 'B', layoutBounds: { x: 0, y: 0, w: 10, h: 10 } })
    const c = group({ id: 'g1', label: 'A', layoutBounds: { x: 1, y: 0, w: 10, h: 10 } })
    assert.equal(groupStateEqual(a, b), false)
    assert.equal(groupStateEqual(a, c), false)
  })

  test('groupsEqual matches equal lists and rejects unequal', () => {
    const a = [group({ id: 'g1', label: 'One' }), group({ id: 'g2', label: 'Two' })]
    const b = [group({ id: 'g2', label: 'Two' }), group({ id: 'g1', label: 'One' })]
    const c = [group({ id: 'g1', label: 'One' }), group({ id: 'g2', label: 'Changed' })]
    assert.equal(groupsEqual(a, b), true)
    assert.equal(groupsEqual(a, c), false)
    assert.equal(groupsEqual(a, [group({ id: 'g1', label: 'One' })]), false)
  })

  test('tileStateEqual uses structural launchArgs compare', () => {
    assert.equal(tileStateEqual(tile('t', 0, ['--foo']), tile('t', 0, ['--foo'])), true)
    assert.equal(tileStateEqual(tile('t', 0, ['--foo']), tile('t', 0, ['--bar'])), false)
  })

  test('buildCanvasHistoryEntry + undo still works for group label edits', () => {
    const beforeGroups: GroupState[] = [group({ id: 'g1', label: 'Before' })]
    const afterGroups: GroupState[] = [group({ id: 'g1', label: 'After' })]
    const entry = buildCanvasHistoryEntry([], [], beforeGroups, afterGroups)
    assert.ok(entry.groupsBefore)
    assert.ok(entry.groupsAfter)
    const undone = applyCanvasHistoryUndo([], afterGroups, entry)
    assert.equal(undone.groups[0]?.label, 'Before')
    const redone = applyCanvasHistoryRedo([], undone.groups, entry)
    assert.equal(redone.groups[0]?.label, 'After')
  })
})
