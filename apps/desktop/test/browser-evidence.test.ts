import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  BROWSER_EVIDENCE_DEFAULT_LIMIT,
  appendBrowserEvidence,
  createBrowserEvidenceEvent,
  createBrowserEvidenceSnapshot,
  formatBrowserEvidenceReport,
  summarizeBrowserEvidence,
} from '../src/shared/browserEvidence.ts'

describe('browser evidence helpers', () => {
  test('keeps newest browser evidence entries within the configured limit', () => {
    const evidence = [
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'console', message: 'first', timestamp: 1000 }),
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'console', message: 'second', timestamp: 1001 }),
    ]

    const next = appendBrowserEvidence(evidence, {
      tileId: 'browser-1',
      kind: 'load-failure',
      message: 'third',
      timestamp: 1002,
    }, 2)

    expect(next.map(entry => entry.message)).toEqual(['second', 'third'])
    expect(evidence.map(entry => entry.message)).toEqual(['first', 'second'])
  })

  test('normalizes evidence ids and severity for console and load failures', () => {
    const consoleEvent = createBrowserEvidenceEvent({
      tileId: 'browser-1',
      kind: 'console',
      level: 'warning',
      message: 'layout shifted',
      timestamp: 2000,
      url: 'https://example.test',
    })
    const loadFailure = createBrowserEvidenceEvent({
      tileId: 'browser-1',
      kind: 'load-failure',
      errorCode: -105,
      message: 'ERR_NAME_NOT_RESOLVED',
      timestamp: 2001,
    })

    expect(consoleEvent.id).toBe('browser-1:2000:console:layout-shifted')
    expect(consoleEvent.severity).toBe('warning')
    expect(loadFailure.id).toBe('browser-1:2001:load-failure:err-name-not-resolved')
    expect(loadFailure.severity).toBe('error')
  })

  test('summarizes browser evidence counts by severity and kind', () => {
    const events = [
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'console', level: 'info', message: 'ready', timestamp: 1 }),
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'console', level: 'error', message: 'boom', timestamp: 2 }),
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'load-failure', message: 'failed', timestamp: 3 }),
    ]

    expect(summarizeBrowserEvidence(events)).toEqual({
      total: 3,
      byKind: { console: 2, 'load-failure': 1 },
      bySeverity: { info: 1, error: 2 },
      errorCount: 2,
      warningCount: 0,
      newestTimestamp: 3,
    })
  })

  test('uses a bounded default evidence limit', () => {
    expect(BROWSER_EVIDENCE_DEFAULT_LIMIT).toBeGreaterThan(20)
    expect(BROWSER_EVIDENCE_DEFAULT_LIMIT <= 500).toBe(true)
  })

  test('builds a browser evidence snapshot with page health status', () => {
    const events = [
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'console', level: 'info', message: 'ready', timestamp: 1 }),
      createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'console', level: 'warning', message: 'deprecated api', timestamp: 2 }),
    ]

    const snapshot = createBrowserEvidenceSnapshot({
      tileId: 'browser-1',
      url: 'https://example.test/app',
      title: 'Example App',
      mode: 'desktop',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
      isLoading: false,
      capturedAt: 99,
      events,
    })

    expect(snapshot.summary.warningCount).toBe(1)
    expect(snapshot.health.status).toBe('warning')
    expect(snapshot.health.label).toBe('1 warning')
    expect(snapshot.page.title).toBe('Example App')
    expect(snapshot.viewport).toEqual({ width: 1280, height: 720, deviceScaleFactor: 2 })
    expect(snapshot.capturedAt).toBe(99)
  })

  test('formats a markdown browser QA report from real evidence', () => {
    const snapshot = createBrowserEvidenceSnapshot({
      tileId: 'browser-1',
      url: 'https://example.test/app',
      title: 'Example App',
      isLoading: false,
      capturedAt: 99,
      events: [
        createBrowserEvidenceEvent({ tileId: 'browser-1', kind: 'load-failure', message: 'ERR_NAME_NOT_RESOLVED', timestamp: 10, url: 'https://bad.invalid' }),
      ],
    })

    const report = formatBrowserEvidenceReport(snapshot)

    expect(report).toContain('# Browser QA Evidence')
    expect(report).toContain('URL: https://example.test/app')
    expect(report).toContain('Status: error')
    expect(report).toContain('ERR_NAME_NOT_RESOLVED')
  })
})
