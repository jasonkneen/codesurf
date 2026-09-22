import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  collectPanelLeaves,
  createLeaf,
  findFirstLeafId,
  findLeafIdContainingTile,
  replaceLeafInPanelTree,
  sanitizePanelLayout,
  splitLeaf,
} from '../src/renderer/src/components/panelLayoutTree.ts'

describe('panelLayoutTree helpers', () => {
  test('findFirstLeafId returns the left-most leaf id', () => {
    const left = createLeaf(['tile-a'])
    const right = createLeaf(['tile-b'])
    const root = splitLeaf(left, left.id, 'tile-b', 'right')
    expect(findFirstLeafId(root)).toBe(left.id)
  })

  test('findLeafIdContainingTile resolves a tab to its leaf', () => {
    const leaf = createLeaf(['tile-a', 'tile-b'])
    expect(findLeafIdContainingTile(leaf, 'tile-b')).toBe(leaf.id)
    expect(findLeafIdContainingTile(leaf, 'missing')).toBeNull()
  })

  test('collectPanelLeaves flattens split trees', () => {
    const left = createLeaf(['tile-a'])
    const root = splitLeaf(left, left.id, 'tile-b', 'right')
    expect(collectPanelLeaves(root).length).toBe(2)
  })

  test('replaceLeafInPanelTree swaps a target leaf', () => {
    const original = createLeaf(['tile-a'])
    const replacement = createLeaf(['tile-b'])
    const next = replaceLeafInPanelTree(original, original.id, replacement)
    expect(next).toEqual(replacement)
  })

  test('sanitizePanelLayout drops stale tabs and keeps valid ones', () => {
    const leaf = createLeaf(['tile-a', 'tile-b'])
    const sanitized = sanitizePanelLayout(leaf, ['tile-a'])
    expect(sanitized.layout?.type).toBe('leaf')
    if (sanitized.layout?.type === 'leaf') {
      expect(sanitized.layout.tabs).toEqual(['tile-a'])
    }
    expect(sanitized.fallbackActivePanelId).toBe(leaf.id)
  })
})