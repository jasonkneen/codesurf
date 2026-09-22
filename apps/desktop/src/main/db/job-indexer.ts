/**
 * Job + timeline indexer.
 *
 * Pattern mirrors thread-indexer.ts: JSONL/JSON files on disk are canonical,
 * SQLite is a derived index. Scan is incremental via (mtime, size) diff and
 * coalesces concurrent callers onto the in-flight scan.
 *
 * On each scan we:
 *   1. Walk JOBS_DIR, parse jobs/{id}.json, upsert a job_index row.
 *   2. For jobs whose timeline file mtime/size changed, re-ingest the JSONL
 *      into timeline_event_index (UPSERT by (job_id, sequence)) and update
 *      the roll-up counters on the job row.
 *   3. Tombstone jobs whose JSON file has disappeared.
 *
 * What lives in SQLite:
 *   - job_index           : hot columns for list views + filters
 *   - timeline_event_index: every timeline event, payload kept as blob
 *   - job_search / timeline_search: FTS5 mirrors (auto-maintained by triggers)
 *
 * What stays on disk:
 *   - jobs/{id}.json, timelines/{id}.jsonl (canonical, agent-writable)
 */
import { randomUUID } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { JOBS_DIR, TIMELINES_DIR } from '../paths'
import { getDb, getDeviceId } from './index'
import { log } from '../utils/logger.ts'

const jobsLog = log.scope('jobs')

// ─── Types ────────────────────────────────────────────────────────────────

export interface JobExtraction {
  /** REQUIRED - must match the jobs/{id}.json filename stem. */
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
  sessionId: string | null
  requestedAtMs: number | null
  completedAtMs: number | null
  errorText: string | null
  /** Any additional fields you want to preserve verbatim for later promotion. */
  extraJson: string | null
}

interface TimelineEvent {
  sequence: number
  timestampMs: number
  eventType: string
  errorText: string | null
  payloadJson: string
}

interface TimelineSummary {
  eventCount: number
  errorCount: number
  lastEventType: string | null
  lastEventAtMs: number | null
  lastSequence: number
}

interface IndexerStatus {
  initialIndexDone: boolean
  lastScanStartedAt: number
  lastScanFinishedAt: number
  lastScanDurationMs: number
  lastScanInserts: number
  lastScanUpdates: number
  lastScanTombstoned: number
  lastScanSkipped: number
  lastScanTimelineEvents: number
  scanningInFlight: boolean
  lastError: string | null
}

const status: IndexerStatus = {
  initialIndexDone: false,
  lastScanStartedAt: 0,
  lastScanFinishedAt: 0,
  lastScanDurationMs: 0,
  lastScanInserts: 0,
  lastScanUpdates: 0,
  lastScanTombstoned: 0,
  lastScanSkipped: 0,
  lastScanTimelineEvents: 0,
  scanningInFlight: false,
  lastError: null,
}

let currentScan: Promise<void> | null = null

// ─────────────────────────────────────────────────────────────────────────
// USER CONTRIBUTION POINT
// ─────────────────────────────────────────────────────────────────────────
//
// This function decides which fields from jobs/{id}.json become queryable
// columns. Everything you DON'T return here is either dropped or stored in
// `extraJson` for later promotion.
//
// The default below indexes the obvious fields. You may want to:
//   - truncate `taskLabel` to a sensible display length
//   - normalize `status` values into a controlled vocabulary
//   - decide whether `initialPrompt` should join `taskLabel` for FTS
//   - parse `workspaceDir` into a project-relative path for grouping
//   - add custom derived fields (e.g. `priority`, `tags`) your UI needs
//
// Contract: must return a well-formed `JobExtraction` or throw. Thrown
// errors are caught per-file so one malformed job doesn't kill the scan.
//
export function extractJobRow(raw: unknown): JobExtraction {
  if (!raw || typeof raw !== 'object') {
    throw new Error('job JSON is not an object')
  }
  const j = raw as Record<string, unknown>
  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null
  const asMs = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Date.parse(v)
      return Number.isFinite(n) ? n : null
    }
    return null
  }

  const jobId = asString(j.id)
  if (!jobId) throw new Error('job JSON missing id')

  // Keys we promote to columns; everything else goes to extraJson.
  const promoted = new Set([
    'id', 'taskLabel', 'initialPrompt', 'status', 'provider', 'model', 'runMode',
    'workspaceId', 'workspaceDir', 'cardId', 'sessionId',
    'requestedAt', 'updatedAt', 'completedAt', 'error',
    // roll-up derived from timeline scan, not needed in extra_json
    'lastSequence',
  ])
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(j)) {
    if (!promoted.has(k)) extra[k] = v
  }

  return {
    jobId,
    taskLabel: asString(j.taskLabel),
    initialPrompt: asString(j.initialPrompt),
    status: asString(j.status),
    provider: asString(j.provider),
    model: asString(j.model),
    runMode: asString(j.runMode),
    workspaceId: asString(j.workspaceId),
    workspaceDir: asString(j.workspaceDir),
    cardId: asString(j.cardId),
    sessionId: asString(j.sessionId),
    requestedAtMs: asMs(j.requestedAt),
    completedAtMs: asMs(j.completedAt),
    errorText: asString(j.error),
    extraJson: Object.keys(extra).length ? JSON.stringify(extra) : null,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString()
}

function safeStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path)
    return { mtimeMs: Math.floor(s.mtimeMs), size: s.size }
  } catch {
    return null
  }
}

function parseTimeline(jsonl: string): TimelineEvent[] {
  const out: TimelineEvent[] = []
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const sequence = typeof obj.sequence === 'number' ? obj.sequence : -1
    const timestamp = typeof obj.timestamp === 'number' ? obj.timestamp : 0
    const type = typeof obj.type === 'string' ? obj.type : 'unknown'
    const errorText = typeof obj.error === 'string' ? obj.error : null
    if (sequence < 0) continue
    out.push({
      sequence,
      timestampMs: timestamp,
      eventType: type,
      errorText,
      payloadJson: trimmed,
    })
  }
  return out
}

function summarizeTimeline(events: TimelineEvent[]): TimelineSummary {
  if (events.length === 0) {
    return { eventCount: 0, errorCount: 0, lastEventType: null, lastEventAtMs: null, lastSequence: 0 }
  }
  let errorCount = 0
  let last = events[0]
  for (const e of events) {
    if (e.errorText) errorCount += 1
    if (e.sequence > last.sequence) last = e
  }
  return {
    eventCount: events.length,
    errorCount,
    lastEventType: last.eventType,
    lastEventAtMs: last.timestampMs,
    lastSequence: last.sequence,
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────

export function countJobsInDb(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS c FROM job_index WHERE deleted_at IS NULL`,
  ).get() as { c: number }).c
}

export function getJobIndexerStatus(): IndexerStatus & { totalRows: number } {
  return {
    ...status,
    totalRows: (() => { try { return countJobsInDb() } catch { return 0 } })(),
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────

export function indexAllJobs(): Promise<void> {
  if (currentScan) return currentScan
  const promise = runScan()
  currentScan = promise
  promise.finally(() => { currentScan = null })
  return promise
}

async function runScan(): Promise<void> {
  status.scanningInFlight = true
  status.lastScanStartedAt = Date.now()
  status.lastError = null

  try {
    const db = getDb()
    const deviceId = getDeviceId()
    const now = nowIso()

    // Snapshot existing freshness keys.
    const existing = new Map<string, {
      source_mtime_ms: number
      source_size_bytes: number
      timeline_mtime_ms: number
      timeline_size_bytes: number
      rowid: number
    }>()
    for (const row of db.prepare(`
      SELECT rowid, job_id, source_mtime_ms, source_size_bytes,
             timeline_mtime_ms, timeline_size_bytes
        FROM job_index WHERE deleted_at IS NULL
    `).all() as Array<{
      rowid: number; job_id: string
      source_mtime_ms: number; source_size_bytes: number
      timeline_mtime_ms: number; timeline_size_bytes: number
    }>) {
      existing.set(row.job_id, {
        source_mtime_ms: row.source_mtime_ms,
        source_size_bytes: row.source_size_bytes,
        timeline_mtime_ms: row.timeline_mtime_ms,
        timeline_size_bytes: row.timeline_size_bytes,
        rowid: row.rowid,
      })
    }

    // List jobs/*.json.
    let jobFiles: string[] = []
    try {
      jobFiles = readdirSync(JOBS_DIR).filter(n => n.endsWith('.json'))
    } catch {
      // jobs dir may not exist yet - fine, just means no jobs
    }

    const upsertJob = db.prepare(`
      INSERT INTO job_index (
        id, device_id, job_id, file_path,
        task_label, initial_prompt, status, provider, model, run_mode,
        workspace_id, workspace_dir, card_id, session_id,
        requested_at_ms, completed_at_ms, duration_ms, error_text,
        event_count, error_count, last_event_type, last_event_at_ms, last_sequence,
        last_activity_at_ms,
        source_mtime_ms, source_size_bytes, timeline_mtime_ms, timeline_size_bytes,
        extra_json
      ) VALUES (
        @id, @device_id, @job_id, @file_path,
        @task_label, @initial_prompt, @status, @provider, @model, @run_mode,
        @workspace_id, @workspace_dir, @card_id, @session_id,
        @requested_at_ms, @completed_at_ms, @duration_ms, @error_text,
        @event_count, @error_count, @last_event_type, @last_event_at_ms, @last_sequence,
        @last_activity_at_ms,
        @source_mtime_ms, @source_size_bytes, @timeline_mtime_ms, @timeline_size_bytes,
        @extra_json
      )
      ON CONFLICT(job_id) DO UPDATE SET
        file_path            = excluded.file_path,
        task_label           = excluded.task_label,
        initial_prompt       = excluded.initial_prompt,
        status               = excluded.status,
        provider             = excluded.provider,
        model                = excluded.model,
        run_mode             = excluded.run_mode,
        workspace_id         = excluded.workspace_id,
        workspace_dir        = excluded.workspace_dir,
        card_id              = excluded.card_id,
        session_id           = excluded.session_id,
        requested_at_ms      = excluded.requested_at_ms,
        completed_at_ms      = excluded.completed_at_ms,
        duration_ms          = excluded.duration_ms,
        error_text           = excluded.error_text,
        event_count          = excluded.event_count,
        error_count          = excluded.error_count,
        last_event_type      = excluded.last_event_type,
        last_event_at_ms     = excluded.last_event_at_ms,
        last_sequence        = excluded.last_sequence,
        last_activity_at_ms  = excluded.last_activity_at_ms,
        source_mtime_ms      = excluded.source_mtime_ms,
        source_size_bytes    = excluded.source_size_bytes,
        timeline_mtime_ms    = excluded.timeline_mtime_ms,
        timeline_size_bytes  = excluded.timeline_size_bytes,
        extra_json           = excluded.extra_json,
        deleted_at           = NULL,
        updated_at           = @now,
        version              = version + 1
    `)

    const tombstone = db.prepare(`
      UPDATE job_index
         SET deleted_at = @now, updated_at = @now, version = version + 1
       WHERE job_id = @job_id AND deleted_at IS NULL
    `)

    const deleteTimelineEvents = db.prepare(
      `DELETE FROM timeline_event_index WHERE job_id = @job_id`,
    )
    const insertTimelineEvent = db.prepare(`
      INSERT INTO timeline_event_index (
        id, device_id, job_id, sequence, timestamp_ms, event_type,
        error_text, payload_json
      ) VALUES (
        @id, @device_id, @job_id, @sequence, @timestamp_ms, @event_type,
        @error_text, @payload_json
      )
    `)

    let inserts = 0, updates = 0, skipped = 0, timelineEvents = 0

    const txn = db.transaction(() => {
      const seen = new Set<string>()

      for (const fname of jobFiles) {
        const jobId = fname.replace(/\.json$/, '')
        const jobPath = join(JOBS_DIR, fname)
        const jobStat = safeStat(jobPath)
        if (!jobStat) continue

        const timelinePath = join(TIMELINES_DIR, `${jobId}.jsonl`)
        const timelineStat = safeStat(timelinePath)

        const prev = existing.get(jobId)
        const jobUnchanged = prev
          && prev.source_mtime_ms === jobStat.mtimeMs
          && prev.source_size_bytes === jobStat.size
        const timelineUnchanged = prev
          && prev.timeline_mtime_ms === (timelineStat?.mtimeMs ?? 0)
          && prev.timeline_size_bytes === (timelineStat?.size ?? 0)

        if (jobUnchanged && timelineUnchanged) {
          seen.add(jobId)
          skipped += 1
          continue
        }

        // Parse the job JSON via the user-owned extractor.
        let extracted: JobExtraction
        try {
          extracted = extractJobRow(JSON.parse(readFileSync(jobPath, 'utf8')))
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[jobs] extract failed for ${fname}:`, err)
          continue
        }

        // Parse + summarize timeline if it changed.
        let summary: TimelineSummary = {
          eventCount: 0, errorCount: 0, lastEventType: null,
          lastEventAtMs: null, lastSequence: 0,
        }
        let events: TimelineEvent[] = []
        if (timelineStat) {
          if (timelineUnchanged && prev) {
            // Keep existing timeline rows + roll-up values unchanged.
            const row = db.prepare(`
              SELECT event_count, error_count, last_event_type,
                     last_event_at_ms, last_sequence
                FROM job_index WHERE rowid = ?
            `).get(prev.rowid) as {
              event_count: number; error_count: number
              last_event_type: string | null
              last_event_at_ms: number | null
              last_sequence: number
            }
            summary = {
              eventCount: row.event_count,
              errorCount: row.error_count,
              lastEventType: row.last_event_type,
              lastEventAtMs: row.last_event_at_ms,
              lastSequence: row.last_sequence,
            }
          } else {
            try {
              events = parseTimeline(readFileSync(timelinePath, 'utf8'))
              summary = summarizeTimeline(events)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(`[jobs] timeline parse failed for ${jobId}:`, err)
            }
          }
        }

        const durationMs = extracted.requestedAtMs != null && extracted.completedAtMs != null
          ? Math.max(0, extracted.completedAtMs - extracted.requestedAtMs)
          : null

        // "Recent" = last activity. Falls back to requestedAt for jobs whose
        // timeline never produced an event (e.g. failed before first emit).
        const lastActivityAtMs = summary.lastEventAtMs ?? extracted.requestedAtMs ?? null

        upsertJob.run({
          // Always bind a valid id: better-sqlite3 rejects `undefined` named
          // params, and on the ON CONFLICT(job_id) update path `id` is never
          // in the SET list, so the bound value is ignored for existing rows.
          id: randomUUID(),
          device_id: deviceId,
          job_id: extracted.jobId,
          file_path: jobPath,
          task_label: extracted.taskLabel,
          initial_prompt: extracted.initialPrompt,
          status: extracted.status,
          provider: extracted.provider,
          model: extracted.model,
          run_mode: extracted.runMode,
          workspace_id: extracted.workspaceId,
          workspace_dir: extracted.workspaceDir,
          card_id: extracted.cardId,
          session_id: extracted.sessionId,
          requested_at_ms: extracted.requestedAtMs,
          completed_at_ms: extracted.completedAtMs,
          duration_ms: durationMs,
          error_text: extracted.errorText,
          event_count: summary.eventCount,
          error_count: summary.errorCount,
          last_event_type: summary.lastEventType,
          last_event_at_ms: summary.lastEventAtMs,
          last_sequence: summary.lastSequence,
          last_activity_at_ms: lastActivityAtMs,
          source_mtime_ms: jobStat.mtimeMs,
          source_size_bytes: jobStat.size,
          timeline_mtime_ms: timelineStat?.mtimeMs ?? 0,
          timeline_size_bytes: timelineStat?.size ?? 0,
          extra_json: extracted.extraJson,
          now,
        })

        if (events.length > 0) {
          // Rewrite timeline events for this job - simpler than diffing and
          // the FTS DELETE trigger keeps search in sync.
          deleteTimelineEvents.run({ job_id: extracted.jobId })
          for (const e of events) {
            insertTimelineEvent.run({
              id: randomUUID(),
              device_id: deviceId,
              job_id: extracted.jobId,
              sequence: e.sequence,
              timestamp_ms: e.timestampMs,
              event_type: e.eventType,
              error_text: e.errorText,
              payload_json: e.payloadJson,
            })
            timelineEvents += 1
          }
        }

        seen.add(extracted.jobId)
        if (prev) updates += 1
        else inserts += 1
      }

      // Tombstone jobs whose file is gone.
      let tombstoned = 0
      for (const jobId of existing.keys()) {
        if (!seen.has(jobId)) {
          tombstone.run({ job_id: jobId, now })
          tombstoned += 1
        }
      }
      return tombstoned
    })

    const tombstoned = txn() as unknown as number
    const finishedAt = Date.now()

    status.lastScanFinishedAt = finishedAt
    status.lastScanDurationMs = finishedAt - status.lastScanStartedAt
    status.lastScanInserts = inserts
    status.lastScanUpdates = updates
    status.lastScanTombstoned = tombstoned
    status.lastScanSkipped = skipped
    status.lastScanTimelineEvents = timelineEvents
    status.initialIndexDone = true
    status.scanningInFlight = false

    jobsLog.info(
      `scan: inserts=${inserts} updates=${updates} `
      + `tombstoned=${tombstoned} skipped=${skipped} `
      + `timeline_events=${timelineEvents} in ${status.lastScanDurationMs}ms`,
    )
  } catch (err) {
    status.scanningInFlight = false
    status.lastError = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error('[jobs] scan failed:', err)
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

export async function ensureInitialJobIndex(): Promise<void> {
  try {
    if (countJobsInDb() > 0) {
      status.initialIndexDone = true
      // eslint-disable-next-line no-console
      jobsLog.info('index already populated, skipping initial scan')
      return
    }
  } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  jobsLog.info('index empty, running one-time initial scan')
  await indexAllJobs()
}

// ─── Overlay mutations (user-owned columns) ──────────────────────────────

export function toggleJobStarred(jobId: string, starred: boolean): boolean {
  const info = getDb().prepare(
    `UPDATE job_index
        SET is_starred = @starred, updated_at = @now, version = version + 1
      WHERE job_id = @job_id`,
  ).run({ starred: starred ? 1 : 0, job_id: jobId, now: nowIso() })
  return info.changes > 0
}

export function setJobNotes(jobId: string, notes: string | null): boolean {
  const info = getDb().prepare(
    `UPDATE job_index
        SET notes = @notes, updated_at = @now, version = version + 1
      WHERE job_id = @job_id`,
  ).run({ notes, job_id: jobId, now: nowIso() })
  return info.changes > 0
}
