export interface AutoDreamSettings {
  enabled: boolean
  minSessions: number
  minIntervalMs: number
  debounceMs: number
  sweepMs: number
}

export interface DreamRunSummary {
  id: string
  workspaceId: string
  workspaceName: string | null
  workspaceDir: string
  provider: string
  model: string
  status: string
  requestedAt: string
  startedAt: string
  completedAt: string | null
  sessionsReviewed: number
  reviewedSessionIds: string[]
  latestSessionUpdatedAt: string | null
  outputPath: string | null
  artifactPath: string | null
  summary: string | null
  promptPreview: string | null
  error: string | null
}

export interface AutoDreamPolicySummary extends AutoDreamSettings {
  pending: boolean
}

export interface DashboardDreamingSummary {
  workspaceId: string
  workspaceName: string | null
  workspaceDir: string | null
  running: boolean
  activeRun: DreamRunSummary | null
  lastRun: DreamRunSummary | null
  state: {
    workspaceId: string
    lastRunId: string | null
    lastCompletedAt: string | null
    lastSuccessfulRunId: string | null
    lastSuccessfulCompletedAt: string | null
    lastReviewedAt: string | null
    latestMemoryPath: string | null
  } | null
  auto: AutoDreamPolicySummary | null
}
