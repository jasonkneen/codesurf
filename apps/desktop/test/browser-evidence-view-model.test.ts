import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { createBrowserEvidenceEvent } from '../src/shared/browserEvidence.ts'
import {
  filterBrowserEvidence,
  type BrowserEvidenceFilter,
} from '../src/renderer/src/components/browser/browserEvidenceViewModel.ts'

const events = [
  createBrowserEvidenceEvent({
    tileId: 'browser-1',
    kind: 'lifecycle',
    message: 'ready',
    timestamp: 1,
  }),
  createBrowserEvidenceEvent({
    tileId: 'browser-1',
    kind: 'console',
    level: 'warning',
    message: 'deprecated',
    timestamp: 2,
  }),
  createBrowserEvidenceEvent({
    tileId: 'browser-1',
    kind: 'load-failure',
    message: 'failed',
    timestamp: 3,
  }),
]

describe('browser evidence drawer view model', () => {
  test('filters issue and kind views while keeping newest events first', () => {
    expect(filterBrowserEvidence(events, 'issues').map(event => event.message)).toEqual([
      'failed',
      'deprecated',
    ])
    expect(filterBrowserEvidence(events, 'console').map(event => event.message)).toEqual([
      'deprecated',
    ])
    expect(filterBrowserEvidence(events, 'lifecycle').map(event => event.message)).toEqual([
      'ready',
    ])
  })

  test('limits rendered evidence without mutating the source event order', () => {
    expect(filterBrowserEvidence(events, 'all', 2).map(event => event.message)).toEqual([
      'failed',
      'deprecated',
    ])
    expect(events.map(event => event.message)).toEqual(['ready', 'deprecated', 'failed'])
  })

  test('supports every drawer filter with an empty result when the limit is non-positive', () => {
    const filters: BrowserEvidenceFilter[] = ['all', 'issues', 'console', 'load-failure', 'lifecycle']

    for (const filter of filters) {
      expect(filterBrowserEvidence(events, filter, 0)).toEqual([])
    }
  })
})
