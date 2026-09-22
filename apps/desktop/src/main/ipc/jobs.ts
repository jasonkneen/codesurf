/**
 * Jobs IPC surface.
 *
 * Reads from the SQLite projection (job_index) maintained by job-indexer.ts.
 * The canonical source is still jobs/{id}.json + timelines/{id}.jsonl on
 * disk; these handlers never touch the filesystem — they exist purely to
 * give the renderer a fast, filterable, paginated view of "what jobs have
 * run on this machine".
 *
 * Registered channels:
 *   jobs:recent — paginated recent-activity list, optional workspace filter.
 */
import { ipcMain } from 'electron'
import { getDb } from '../db'
import type {
  RecentJob,
  RecentJobsRequest,
  RecentJobsResponse,
} from '../../shared/job-types'

interface RecentJobRow {
  job_id: string
  task_label: string | null
  initial_prompt: string | null
  status: string | null
  provider: string | null
  model: string | null
  run_mode: string | null
  workspace_id: string | null
  workspace_dir: string | null
  card_id: string | null
  requested_at_ms: number | null
  completed_at_ms: number | null
  duration_ms: number | null
  last_activity_at_ms: number | null
  last_event_type: string | null
  event_count: number
  error_count: number
  is_starred: number
  is_archived: number
}

function rowToRecentJob(row: RecentJobRow): RecentJob {
  return {
    jobId: row.job_id,
    taskLabel: row.task_label,
    initialPrompt: row.initial_prompt,
    status: row.status,
    provider: row.provider,
    model: row.model,
    runMode: row.run_mode,
    workspaceId: row.workspace_id,
    workspaceDir: row.workspace_dir,
    cardId: row.card_id,
    requestedAtMs: row.requested_at_ms,
    completedAtMs: row.completed_at_ms,
    durationMs: row.duration_ms,
    lastActivityAtMs: row.last_activity_at_ms,
    lastEventType: row.last_event_type,
    eventCount: row.event_count,
    errorCount: row.error_count,
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
  }
}

function clampLimit(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Math.floor(raw as number) : 50
  if (n < 1) return 1
  if (n > 500) return 500
  return n
}

function clampOffset(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Math.floor(raw as number) : 0
  return n < 0 ? 0 : n
}

function normalizeWorkspace(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  return s.length > 0 ? s : null
}

export function registerJobsIPC(): void {
  ipcMain.handle(
    'jobs:recent',
    async (_, req: RecentJobsRequest | undefined): Promise<RecentJobsResponse> => {
      const db = getDb()
      const workspaceId = normalizeWorkspace(req?.workspaceId)
      const includeArchived = req?.includeArchived === true
      const limit = clampLimit(req?.limit)
      const offset = clampOffset(req?.offset)

      // Build WHERE clause — stay within partial index coverage
      // (idx_ji_live_activity / idx_ji_ws_activity) so the planner can
      // skip the temp b-tree sort.
      const clauses: string[] = ['deleted_at IS NULL']
      const params: Array<string | number> = []
      if (workspaceId) {
        clauses.push('workspace_id = ?')
        params.push(workspaceId)
      }
      if (!includeArchived) {
        clauses.push('is_archived = 0')
      }
      const whereSql = clauses.join(' AND ')

      const countStmt = db.prepare(
        `SELECT COUNT(*) AS n FROM job_index WHERE ${whereSql}`,
      )
      const total = (countStmt.get(...params) as { n: number } | undefined)?.n ?? 0

      const listStmt = db.prepare(
        `SELECT
           job_id, task_label, initial_prompt, status, provider, model,
           run_mode, workspace_id, workspace_dir, card_id,
           requested_at_ms, completed_at_ms, duration_ms,
           last_activity_at_ms, last_event_type,
           event_count, error_count, is_starred, is_archived
         FROM job_index
         WHERE ${whereSql}
         ORDER BY last_activity_at_ms DESC
         LIMIT ? OFFSET ?`,
      )
      const rows = listStmt.all(...params, limit, offset) as RecentJobRow[]

      return {
        jobs: rows.map(rowToRecentJob),
        total,
        limit,
        offset,
      }
    },
  )
}
