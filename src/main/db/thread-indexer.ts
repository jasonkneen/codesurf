/**
 * Thread index — lightweight SQLite-backed pointer table for sessions living
 * in external provider folders (~/.claude, ~/.codex, ~/.cursor, ~/.openclaw,
 * ~/.opencode) plus our own CodeSurf-native sessions.
 *
 * Model:
 *   - Each row is a POINTER to a file on disk (or a daemon-owned native
 *     session). Row holds only the metadata the sidebar renders: title,
 *     preview, message_count, project_path, mtime.
 *   - No content mirror. Clicking a thread re-parses the file live.
 *   - The index is populated once on first launch. After that we do cheap
 *     mtime-diff scans on demand (user focus / explicit refresh). Files
 *     whose mtime + size haven't changed are skipped entirely.
 *
 * Exports:
 *   - `indexAllSources()`   - run the diff scan and upsert/tombstone as needed
 *   - `listThreadsFromDb()` - read for a given workspace/project path
 *   - `ensureInitialIndex()` - first-time population on startup (no-op if DB populated)
 *   - `renameIndexedThread()` / `togglePinned()` / etc. - overlay mutations
 */
import { randomUUID } from 'crypto'
import type { AggregatedSessionEntry } from '../../shared/session-types'
import { getDb, getDeviceId } from './index'
import { listExternalSessionEntries, invalidateExternalSessionCache } from '../session-sources'
import { broadcastToRenderer } from '../utils/broadcast'

// ─── Types ────────────────────────────────────────────────────────────────

interface IndexerStatus {
  initialIndexDone: boolean
  lastScanStartedAt: number
  lastScanFinishedAt: number
  lastScanDurationMs: number
  lastScanInserts: number
  lastScanUpdates: number
  lastScanTombstoned: number
  lastScanSkipped: number
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
  scanningInFlight: false,
  lastError: null,
}

let currentScan: Promise<void> | null = null

// ─── Row helpers ──────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString()
}

function rowToEntry(row: Record<string, unknown>): AggregatedSessionEntry {
  let resumeArgs: string[] | undefined
  if (typeof row.resume_args_json === 'string' && row.resume_args_json.length) {
    try { resumeArgs = JSON.parse(row.resume_args_json as string) as string[] } catch { /* ignore */ }
  }
  return {
    id: row.entry_id as string,
    source: row.source as AggregatedSessionEntry['source'],
    scope: row.scope as AggregatedSessionEntry['scope'],
    tileId: (row.tile_id as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    provider: (row.provider as string) ?? '',
    model: (row.model as string) ?? '',
    messageCount: (row.message_count as number) ?? 0,
    lastMessage: (row.preview as string | null) ?? null,
    updatedAt: (row.source_updated_ms as number) ?? 0,
    filePath: (row.file_path as string | undefined) ?? undefined,
    title: (row.title_override as string | null) ?? (row.title as string),
    projectPath: (row.project_path as string | null) ?? undefined,
    sourceLabel: (row.source_label as string) ?? '',
    sourceDetail: (row.source_detail as string | undefined) ?? undefined,
    canOpenInChat: !!row.can_open_in_chat,
    canOpenInApp: !!row.can_open_in_app,
    resumeBin: (row.resume_bin as string | undefined) ?? undefined,
    resumeArgs,
    relatedGroupId: (row.related_group_id as string | null) ?? undefined,
    nestingLevel: (row.nesting_level as number) ?? 0,
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────

/**
 * Return every live index row whose project_path matches the given workspace
 * path, plus user-scope entries (no project) that belong to every workspace.
 */
export function listThreadsFromDb(workspacePath: string | null): AggregatedSessionEntry[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT * FROM thread_index
     WHERE deleted_at IS NULL
       AND (project_path IS @workspace_path OR scope = 'user')
     ORDER BY source_updated_ms DESC
  `).all({ workspace_path: workspacePath }) as Record<string, unknown>[]
  return rows.map(rowToEntry)
}

export function countThreadsInDb(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS c FROM thread_index WHERE deleted_at IS NULL`,
  ).get() as { c: number }).c
}

export function getIndexerStatus(): IndexerStatus & { totalRows: number } {
  return {
    ...status,
    totalRows: (() => { try { return countThreadsInDb() } catch { return 0 } })(),
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────

/**
 * Full source scan. Pulls all entries from the aggregator, diffs against the
 * current DB rows by entry_id + mtime, and applies inserts / targeted updates
 * / tombstones. Rows whose file hasn't changed are NOT rewritten.
 *
 * Coalesces concurrent callers onto the in-flight scan.
 */
export function indexAllSources(): Promise<void> {
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
    // Bust the aggregator's own 15s cache so we see fresh files.
    invalidateExternalSessionCache()
    const entries = await listExternalSessionEntries(null, { force: true }).catch(() => [])

    const db = getDb()
    const deviceId = getDeviceId()
    const now = nowIso()

    // Snapshot the current index keyed by entry_id.
    const existing = new Map<string, { source_mtime_ms: number; source_size_bytes: number }>()
    for (const row of db.prepare(
      `SELECT entry_id, source_mtime_ms, source_size_bytes FROM thread_index WHERE deleted_at IS NULL`,
    ).all() as Array<{ entry_id: string; source_mtime_ms: number; source_size_bytes: number }>) {
      existing.set(row.entry_id, { source_mtime_ms: row.source_mtime_ms, source_size_bytes: row.source_size_bytes })
    }

    const insert = db.prepare(`
      INSERT INTO thread_index (
        id, device_id, entry_id, source, scope, session_id, file_path, provider, model,
        source_label, source_detail, tile_id,
        title, preview, message_count,
        project_path, related_group_id, nesting_level,
        can_open_in_chat, can_open_in_app, resume_bin, resume_args_json,
        source_mtime_ms, source_size_bytes, source_updated_ms
      ) VALUES (
        @id, @device_id, @entry_id, @source, @scope, @session_id, @file_path, @provider, @model,
        @source_label, @source_detail, @tile_id,
        @title, @preview, @message_count,
        @project_path, @related_group_id, @nesting_level,
        @can_open_in_chat, @can_open_in_app, @resume_bin, @resume_args_json,
        @source_mtime_ms, @source_size_bytes, @source_updated_ms
      )
    `)

    const update = db.prepare(`
      UPDATE thread_index SET
        source             = @source,
        scope              = @scope,
        session_id         = @session_id,
        file_path          = @file_path,
        provider           = @provider,
        model              = @model,
        source_label       = @source_label,
        source_detail      = @source_detail,
        tile_id            = @tile_id,
        title              = @title,
        preview            = @preview,
        message_count      = @message_count,
        project_path       = @project_path,
        related_group_id   = @related_group_id,
        nesting_level      = @nesting_level,
        can_open_in_chat   = @can_open_in_chat,
        can_open_in_app    = @can_open_in_app,
        resume_bin         = @resume_bin,
        resume_args_json   = @resume_args_json,
        source_mtime_ms    = @source_mtime_ms,
        source_size_bytes  = @source_size_bytes,
        source_updated_ms  = @source_updated_ms,
        updated_at         = @now,
        version            = version + 1
      WHERE entry_id = @entry_id
    `)

    const tombstone = db.prepare(`
      UPDATE thread_index
         SET deleted_at = @now, updated_at = @now, version = version + 1
       WHERE entry_id = @entry_id AND deleted_at IS NULL
    `)

    let inserts = 0, updates = 0, skipped = 0

    const txn = db.transaction(() => {
      const seenIds = new Set<string>()
      for (const entry of entries) {
        seenIds.add(entry.id)
        const prev = existing.get(entry.id)
        const mtime = Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
        const params = {
          id: randomUUID(),
          device_id: deviceId,
          entry_id: entry.id,
          source: entry.source,
          scope: entry.scope,
          session_id: entry.sessionId ?? null,
          file_path: entry.filePath ?? null,
          provider: entry.provider ?? '',
          model: entry.model ?? '',
          source_label: entry.sourceLabel ?? '',
          source_detail: entry.sourceDetail ?? null,
          tile_id: entry.tileId ?? null,
          title: entry.title,
          preview: entry.lastMessage ?? null,
          message_count: entry.messageCount ?? 0,
          project_path: entry.projectPath ?? null,
          related_group_id: entry.relatedGroupId ?? null,
          nesting_level: entry.nestingLevel ?? 0,
          can_open_in_chat: entry.canOpenInChat ? 1 : 0,
          can_open_in_app: entry.canOpenInApp ? 1 : 0,
          resume_bin: entry.resumeBin ?? null,
          resume_args_json: entry.resumeArgs ? JSON.stringify(entry.resumeArgs) : null,
          source_mtime_ms: mtime,
          source_size_bytes: 0, // aggregator doesn't expose size yet
          source_updated_ms: mtime,
          now,
        }
        if (!prev) {
          insert.run(params)
          inserts += 1
        } else if (prev.source_mtime_ms !== mtime) {
          update.run(params)
          updates += 1
        } else {
          skipped += 1
        }
      }

      // Tombstone entries that were indexed before but didn't reappear.
      let tombstoned = 0
      for (const entry_id of existing.keys()) {
        if (!seenIds.has(entry_id)) {
          tombstone.run({ entry_id, now })
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
    status.initialIndexDone = true
    status.scanningInFlight = false

    // eslint-disable-next-line no-console
    console.log(`[threads] scan: inserts=${inserts} updates=${updates} tombstoned=${tombstoned} skipped=${skipped} in ${status.lastScanDurationMs}ms`)

    // Only broadcast when the SIDEBAR would actually render something
    // different. Pure-skip scans (nothing changed) fire no event.
    if (inserts > 0 || tombstoned > 0 || updates > 0) {
      broadcastToRenderer('canvas:sessionsChanged', { workspaceId: '*' })
    }
  } catch (err) {
    status.scanningInFlight = false
    status.lastError = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error('[threads] scan failed:', err)
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Run the initial scan ONLY if the DB is empty. On every subsequent app
 * launch this is a no-op — rows persist from the previous session.
 */
export async function ensureInitialIndex(): Promise<void> {
  try {
    if (countThreadsInDb() > 0) {
      status.initialIndexDone = true
      // eslint-disable-next-line no-console
      console.log('[threads] index already populated, skipping initial scan')
      return
    }
  } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log('[threads] index empty, running one-time initial scan')
  await indexAllSources()
}

// ─── Overlay mutations (user-owned columns) ──────────────────────────────

export function renameIndexedThread(entryId: string, newTitle: string): boolean {
  const info = getDb().prepare(
    `UPDATE thread_index
        SET title_override = @title, updated_at = @now, version = version + 1
      WHERE entry_id = @entry_id`,
  ).run({ title: newTitle, entry_id: entryId, now: nowIso() })
  return info.changes > 0
}

export function togglePinned(entryId: string, pinned: boolean): boolean {
  const info = getDb().prepare(
    `UPDATE thread_index
        SET is_pinned = @pinned, updated_at = @now, version = version + 1
      WHERE entry_id = @entry_id`,
  ).run({ pinned: pinned ? 1 : 0, entry_id: entryId, now: nowIso() })
  return info.changes > 0
}

// ─── Back-compat stubs so the rest of the code keeps linking ─────────────

export function startThreadWatchers(_workspacePath: string | null): void { /* no filesystem watchers */ }
export function stopThreadWatchers(): void { /* no-op */ }
export function isThreadIndexerActive(): boolean { return status.initialIndexDone }

/**
 * Compat: old code paths called seedThreadsIndex / ensureThreadIndexer.
 * Route them through indexAllSources / ensureInitialIndex so nothing breaks.
 */
export async function seedThreadsIndex(_workspacePath: string | null): Promise<void> {
  await indexAllSources()
}
export function ensureThreadIndexer(_workspacePath: string | null): void {
  // Lazy-trigger the initial scan if it hasn't happened yet. Non-blocking.
  if (!status.initialIndexDone && !status.scanningInFlight) {
    void ensureInitialIndex()
  }
}
export function initThreadIndexerForWorkspace(_workspacePath: string | null): void {
  void ensureInitialIndex()
}
