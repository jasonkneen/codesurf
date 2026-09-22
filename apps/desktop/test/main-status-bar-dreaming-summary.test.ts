import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { buildDreamingStatusSummary } from '../src/renderer/src/components/mainStatusBarDreaming.ts'

const now = Date.parse('2026-04-23T09:30:00.000Z')

describe('buildDreamingStatusSummary', () => {
  test('surfaces active dream runs as the compact chip state', () => {
    const summary = buildDreamingStatusSummary({
      workspaceId: 'ws-1',
      workspaceName: 'Demo Workspace',
      workspaceDir: '/tmp/demo',
      running: true,
      activeRun: {
        id: 'dream-1',
        workspaceId: 'ws-1',
        workspaceName: 'Demo Workspace',
        workspaceDir: '/tmp/demo',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        status: 'running',
        requestedAt: '2026-04-23T09:27:00.000Z',
        startedAt: '2026-04-23T09:28:00.000Z',
        completedAt: null,
        sessionsReviewed: 4,
        reviewedSessionIds: ['s1', 's2', 's3', 's4'],
        latestSessionUpdatedAt: '2026-04-23T09:26:00.000Z',
        outputPath: null,
        artifactPath: null,
        summary: null,
        promptPreview: null,
        error: null,
      },
      lastRun: null,
      state: null,
      auto: { enabled: true, pending: false, minSessions: 3, minIntervalMs: 1_800_000, debounceMs: 5_000, sweepMs: 300_000 },
    }, now)

    expect(summary?.chipLabel).toBe('Dreaming')
    expect(summary?.tone).toBe('active')
    expect(summary?.summaryLine).toBe('Dreaming now · 4 sessions')
    expect(summary?.detailLine).toBe('Demo Workspace · claude · claude-sonnet-4-6')
  })

  test('summarizes disabled, pending, and recently completed auto-dream states', () => {
    expect(buildDreamingStatusSummary({
      workspaceId: 'ws-1',
      workspaceName: 'Demo Workspace',
      workspaceDir: '/tmp/demo',
      running: false,
      activeRun: null,
      lastRun: null,
      state: null,
      auto: { enabled: false, pending: false, minSessions: 3, minIntervalMs: 1_800_000, debounceMs: 5_000, sweepMs: 300_000 },
    }, now)?.chipLabel).toBe('Dream off')

    expect(buildDreamingStatusSummary({
      workspaceId: 'ws-1',
      workspaceName: 'Demo Workspace',
      workspaceDir: '/tmp/demo',
      running: false,
      activeRun: null,
      lastRun: null,
      state: null,
      auto: { enabled: true, pending: true, minSessions: 3, minIntervalMs: 1_800_000, debounceMs: 5_000, sweepMs: 300_000 },
    }, now)?.summaryLine).toBe('Auto-dream pending · threshold 3 sessions')

    const recent = buildDreamingStatusSummary({
      workspaceId: 'ws-1',
      workspaceName: 'Demo Workspace',
      workspaceDir: '/tmp/demo',
      running: false,
      activeRun: null,
      lastRun: {
        id: 'dream-2',
        workspaceId: 'ws-1',
        workspaceName: 'Demo Workspace',
        workspaceDir: '/tmp/demo',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        status: 'completed',
        requestedAt: '2026-04-23T09:20:00.000Z',
        startedAt: '2026-04-23T09:21:00.000Z',
        completedAt: '2026-04-23T09:25:30.000Z',
        sessionsReviewed: 3,
        reviewedSessionIds: ['s1', 's2', 's3'],
        latestSessionUpdatedAt: '2026-04-23T09:19:00.000Z',
        outputPath: '/tmp/demo/.codesurf/DREAMING.md',
        artifactPath: null,
        summary: 'Updated workspace memory.',
        promptPreview: null,
        error: null,
      },
      state: null,
      auto: { enabled: true, pending: false, minSessions: 3, minIntervalMs: 1_800_000, debounceMs: 5_000, sweepMs: 300_000 },
    }, now)

    expect(recent?.chipLabel).toBe('Dreamt (4m)')
    expect(recent?.summaryLine).toBe('Auto-dream ready · last completed 4m ago · 3 sessions')
  })
})
