import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { buildFooterExtensions } from '../src/renderer/src/components/sidebar/footerExtensions.ts'

describe('buildFooterExtensions', () => {
  test('only returns actionable extensions that have a tile type', () => {
    const result = buildFooterExtensions(
      [
        { extId: 'rewind-lite', type: 'ext:rewind-lite', label: 'Rewind Lite', icon: 'history' },
        { extId: 'builder', type: 'ext:builder', label: 'Builder', icon: 'sparkles' },
      ],
      [
        { id: 'rewind-lite', name: 'Rewind Lite', icon: 'history', enabled: true },
        { id: 'context-deck', name: 'Context Deck', icon: 'layers-3', enabled: true },
        { id: 'builder', name: 'Builder', icon: 'sparkles', enabled: false },
      ],
    )

    expect(result).toEqual([
      {
        id: 'rewind-lite',
        label: 'Rewind Lite',
        icon: 'history',
        tileType: 'ext:rewind-lite',
      },
    ])
  })

  test('falls back to extension tiles when entry summaries are unavailable', () => {
    const result = buildFooterExtensions(
      [
        { extId: 'sketch', type: 'ext:sketch', label: 'Sketch', icon: 'pencil' },
      ],
      [],
    )

    expect(result).toEqual([
      {
        id: 'sketch',
        label: 'Sketch',
        icon: 'pencil',
        tileType: 'ext:sketch',
      },
    ])
  })
})
