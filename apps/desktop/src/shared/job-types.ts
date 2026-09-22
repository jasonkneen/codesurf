/**
 * Shared types for the job index IPC surface.
 *
 * Mirrors the subset of `job_index` columns that list/detail UIs need.
 * Everything is serializable JSON (numbers/strings/booleans/null) so it
 * crosses the main<->renderer bridge cleanly.
 */

export interface RecentJobsRequest {
  /** Limit to a single workspace. null/undefined = every workspace. */
  workspaceId?: string | null
  /** Page size. Clamped to [1, 500]. Default 50. */
  limit?: number
  /** Offset for pagination. Default 0. */
  offset?: number
  /** Include archived jobs in the result. Default false. */
  includeArchived?: boolean
}

export interface RecentJob {
  jobId: string
  taskLabel: string | null
  initialPrompt: string | null
  status: string | null
  provider: string | null
  model: string | null
  runMode: string | null
  workspaceId: string | null
  workspaceDir: string | null
  cardId: string | null
  requestedAtMs: number | null
  completedAtMs: number | null
  durationMs: number | null
  lastActivityAtMs: number | null
  lastEventType: string | null
  eventCount: number
  errorCount: number
  isStarred: boolean
  isArchived: boolean
}

export interface RecentJobsResponse {
  jobs: RecentJob[]
  total: number
  limit: number
  offset: number
}
