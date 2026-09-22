import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  isLargeMessage,
  previewText,
  splitRawDiffText,
} from '../src/renderer/src/components/chat/largeContent.ts'

describe('large conversation rendering helpers', () => {
  test('folds oversized message bodies by size', () => {
    expect(isLargeMessage('short message')).toBe(false)
    expect(isLargeMessage('x'.repeat(40_001))).toBe(true)
  })

  test('builds bounded previews', () => {
    const preview = previewText(Array.from({ length: 220 }, (_, index) => `line ${index}`).join('\n'))
    expect(preview.includes('Preview truncated')).toBe(true)
    expect(preview.split('\n').length <= 183).toBe(true)
  })

  test('extracts raw multi-file diffs from assistant text', () => {
    const split = splitRawDiffText([
      'Here are the changes:',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n'))

    expect(split?.prefix).toBe('Here are the changes:')
    expect(split?.files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(split?.files[0].additions).toBe(1)
    expect(split?.files[0].deletions).toBe(1)
  })
})
