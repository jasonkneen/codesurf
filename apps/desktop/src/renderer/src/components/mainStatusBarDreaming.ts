import type { DashboardDreamingSummary, DreamRunSummary, AutoDreamPolicySummary } from '../../../shared/types'

export type { DashboardDreamingSummary }

export type DreamingStatusTone = 'active' | 'pending' | 'ready' | 'disabled' | 'failed' | 'idle'

export type DreamingStatusSummary = {
  chipLabel: string
  tone: DreamingStatusTone
  summaryLine: string
  detailLine: string
  title: string
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function pluralSessions(count: number): string {
  return `${count} session${count === 1 ? '' : 's'}`
}

function thresholdText(auto: AutoDreamPolicySummary | null | undefined): string | null {
  const threshold = Number(auto?.minSessions ?? 0)
  return Number.isFinite(threshold) && threshold > 0 ? `threshold ${Math.round(threshold)} sessions` : null
}

function relativeTime(value: string | null | undefined, nowMs: number): string | null {
  const timestamp = Date.parse(clean(value))
  if (!Number.isFinite(timestamp)) return null
  const diffSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000))
  if (diffSeconds < 5) return 'just now'
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  const minutes = Math.floor(diffSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function ageToken(value: string | null | undefined, nowMs: number): string | null {
  const relative = relativeTime(value, nowMs)
  return relative?.replace(/ ago$/, '') ?? null
}

function runTime(run: DreamRunSummary | null | undefined): string | null {
  return run?.completedAt ?? run?.startedAt ?? run?.requestedAt ?? null
}

function workspaceLabel(dreaming: DashboardDreamingSummary, run: DreamRunSummary | null | undefined): string {
  return clean(dreaming.workspaceName) || clean(run?.workspaceName) || clean(dreaming.workspaceDir) || 'Active workspace'
}

function runDetail(dreaming: DashboardDreamingSummary, run: DreamRunSummary | null | undefined): string {
  const parts = [
    workspaceLabel(dreaming, run),
    clean(run?.provider),
    clean(run?.model),
  ].filter(Boolean)
  return parts.join(' · ')
}

export function buildDreamingStatusSummary(
  dreaming: DashboardDreamingSummary | null | undefined,
  nowMs = Date.now(),
): DreamingStatusSummary | null {
  if (!dreaming) return null

  const auto = dreaming.auto
  const activeRun = dreaming.activeRun
  const lastRun = dreaming.lastRun

  if (dreaming.running || activeRun) {
    const run = activeRun ?? lastRun
    const sessionCount = Number(run?.sessionsReviewed ?? 0)
    return {
      chipLabel: 'Dreaming',
      tone: 'active',
      summaryLine: ['Dreaming now', sessionCount > 0 ? pluralSessions(sessionCount) : null].filter(Boolean).join(' · '),
      detailLine: runDetail(dreaming, run),
      title: `Auto-dream is consolidating ${workspaceLabel(dreaming, run)}`,
    }
  }

  if (auto?.enabled === false) {
    return {
      chipLabel: 'Dream off',
      tone: 'disabled',
      summaryLine: 'Auto-dream disabled',
      detailLine: workspaceLabel(dreaming, lastRun),
      title: `Auto-dream is disabled for ${workspaceLabel(dreaming, lastRun)}`,
    }
  }

  if (auto?.pending) {
    const threshold = thresholdText(auto)
    return {
      chipLabel: 'Dream pending',
      tone: 'pending',
      summaryLine: ['Auto-dream pending', threshold].filter(Boolean).join(' · '),
      detailLine: workspaceLabel(dreaming, lastRun),
      title: `Auto-dream evaluation is pending for ${workspaceLabel(dreaming, lastRun)}`,
    }
  }

  if (lastRun?.status === 'failed') {
    const when = relativeTime(runTime(lastRun), nowMs)
    return {
      chipLabel: 'Dream failed',
      tone: 'failed',
      summaryLine: ['Last dream failed', when, clean(lastRun.error)].filter(Boolean).join(' · '),
      detailLine: runDetail(dreaming, lastRun),
      title: `Last auto-dream failed for ${workspaceLabel(dreaming, lastRun)}`,
    }
  }

  if (lastRun) {
    const when = relativeTime(runTime(lastRun), nowMs)
    const token = ageToken(runTime(lastRun), nowMs)
    const sessionCount = Number(lastRun.sessionsReviewed ?? 0)
    const status = clean(lastRun.status) || 'completed'
    return {
      chipLabel: token ? `Dreamt (${token})` : 'Dream ready',
      tone: 'ready',
      summaryLine: [
        'Auto-dream ready',
        when ? `last ${status} ${when}` : `last ${status}`,
        sessionCount > 0 ? pluralSessions(sessionCount) : null,
      ].filter(Boolean).join(' · '),
      detailLine: runDetail(dreaming, lastRun),
      title: `Auto-dream ready for ${workspaceLabel(dreaming, lastRun)}`,
    }
  }

  const threshold = thresholdText(auto)
  return {
    chipLabel: 'Dream ready',
    tone: 'idle',
    summaryLine: ['Auto-dream ready', threshold].filter(Boolean).join(' · '),
    detailLine: workspaceLabel(dreaming, null),
    title: `Auto-dream ready for ${workspaceLabel(dreaming, null)}`,
  }
}
