import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  computeAlignmentGuides,
  filterTilesForAlignmentGuides,
} from '../src/renderer/src/hooks/canvasAlignment.ts'
import type { TileState } from '../src/shared/types.ts'

function tile(id: string, x: number, y: number): TileState {
  return { id, type: 'note', x, y, width: 200, height: 120, zIndex: 1 }
}

describe('filterTilesForAlignmentGuides', () => {
  test('keeps only tiles near the dragged bounds', () => {
    const tiles = [
      tile('near', 204, 0),
      tile('far', 5000, 5000),
    ]
    const nearby = filterTilesForAlignmentGuides(0, 0, 200, 120, tiles)
    assert.deepEqual(nearby.map(t => t.id), ['near'])
  })
})

describe('computeAlignmentGuides', () => {
  test('finds a vertical alignment guide', () => {
    const guides = computeAlignmentGuides(0, 0, 200, 120, [tile('other', 0, 300)])
    assert.ok(guides.some(guide => guide.x === 0))
  })
})