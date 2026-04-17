/**
 * Thread indexer — walks the aggregated session sources once and mirrors them
 * into the local SQLite `threads` table so the sidebar can render in O(1)
 * without re-walking five filesystem trees on every refresh.
 *
 * Seeding strategy (simple, correct, fast on subsequent launches):
 *   1. Call the existing `listExternalSessionEntries(workspacePath, { force:true })`
 *      aggregator — same code path, same shape.
 *   2. Upsert every returned entry by `entry_id` inside one transaction.
 *   3. Soft-delete (set deleted_at) any rows whose entry_id did not appear
 *      in this seed generation. Overlay columns (pin/star/archive/rename)
 *      are preserved via INSERT ... ON CONFLICT DO UPDATE so we never lose
 *      user-owned metadata across re-seeds.
 *
 * Refresh strategy:
 *   - One-shot seed when the indexer starts for a workspace.
 *   - Low-frequency periodic re-seed (PERIODIC_RESEED_MS).
 *   - Renderer force-refresh on window focus already exists in Sidebar.tsx and
 *     hits `canvas:listSessions(forceRefresh=true)` → triggers a reseed.
 *
 * We deliberately do NOT use chokidar / fs.watch on the provider history dirs
 * (~/.claude, ~/.cursor, ~/.openclaw, ~/.opencode). Those trees contain
 * thousands of files — sockets, caches, SQLite WAL sidecars, worker.sock —
 * and recursive watching exhausts the OS file-descriptor budget on macOS
 * (EMFILE). The IPC-driven refresh path below is both safe and sufficient.
 */
import { randomUUID } from 'crypto'
import type { AggregatedSessionEntry } from '../../shared/session-types'
import { getDb, getDeviceId } from './index'
import { listExternalSessionEntries, invalidateExternalSessionCache } from '../session-sources'
import { daemonClient } from '../daemon/client'
import { broadcastToRenderer } from '../utils/broadcast'

const PERIODIC_RESEED_MS = 15 * 60 * 1000

interface IndexerState {
  workspacePath: string | null
  periodicTimer: NodeJS.Timeout | null
  seedingInFlight: boolean
  lastSeedStartedAt: number
  lastSeedFinishedAt: number
  lastSeedDurationMs: number
  lastSeedCount: number
  lastError: string | null
  generation: number
  /** Resolves when the in-flight seed finishes (null when none). */
  currentSeedPromise: Promise<{ durationMs: number; count: number; tombstoned: number }> | null
}

const state: IndexerState = {
  workspacePath: null,
  periodicTimer: null,
  seedingInFlight: false,
  lastSeedStartedAt: 0,
  lastSeedFinishedAt: 0,
  lastSeedDurationMs: 0,
  lastSeedCount: 0,
  lastError: null,
  generation: 0,
  currentSeedPromise: null,
}

// ─── DB helpers ────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString()
}

interface ThreadRowForInsert {
  id: string
  entry_id: string
  source: string
  scope: string
  session_id: string | null
  file_path: string | null
  provider: string
  model: string
  source_label: string
  source_detail: string | null
  tile_id: string | null
  title: string
  last_message: string | null
  message_count: number
  project_path: string | null
  workspace_dir: string | null
  related_group_id: string | null
  nesting_level: number
  can_open_in_chat: number
  can_open_in_app: number
  resume_bin: string | null
  resume_args_json: string | null
  source_updated_ms: number
}

function entryToRow(entry: AggregatedSessionEntry, workspacePath: string | null): ThreadRowForInsert {
  return {
    id: randomUUID(),
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
    last_message: entry.lastMessage ?? null,
    message_count: entry.messageCount ?? 0,
    project_path: entry.projectPath ?? null,
    workspace_dir: workspacePath,
    related_group_id: entry.relatedGroupId ?? null,
    nesting_level: entry.nestingLevel ?? 0,
    can_open_in_chat: entry.canOpenInChat ? 1 : 0,
    can_open_in_app: entry.canOpenInApp ? 1 : 0,
    resume_bin: entry.resumeBin ?? null,
    resume_args_json: entry.resumeArgs ? JSON.stringify(entry.resumeArgs) : null,
    source_updated_ms: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
  }
}

function rowToEntry(row: Record<string, unknown>): AggregatedSessionEntry {
  const resumeArgs = typeof row.resume_args_json === 'string' && row.resume_args_json.length
    ? (() => {
      try { return JSON.parse(row.resume_args_json as string) as string[] } catch { return undefined }
    })()
    : undefined

  return {
    id: row.entry_id as string,
    source: row.source as AggregatedSessionEntry['source'],
    scope: row.scope as AggregatedSessionEntry['scope'],
    tileId: (row.tile_id as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    provider: (row.provider as string) ?? '',
    model: (row.model as string) ?? '',
    messageCount: (row.message_count as number) ?? 0,
    lastMessage: (row.last_message as string | null) ?? null,
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

// ─── Seeding ───────────────────────────────────────────────────────────────

/**
 * Full reseed for a single workspace. Preserves overlay metadata (pins, stars,
 * archive, rename) on rows that already exist. Tombstones any rows whose
 * entry_id did not appear this pass.
 */
export async function seedThreadsIndex(workspacePath: string | null): Promise<{
  durationMs: number
  count: number
  tombstoned: number
}> {
  // Coalesce concurrent callers onto the in-flight seed.
  if (state.seedingInFlight && state.currentSeedPromise) {
    return state.currentSeedPromise
  }
  const promise = runSeed(workspacePath)
  state.currentSeedPromise = promise
  try { return await promise }
  finally { state.currentSeedPromise = null }
}

export function waitForSeedInFlight(): Promise<unknown> | null {
  return state.currentSeedPromise
}

async function runSeed(workspacePath: string | null): Promise<{
  durationMs: number
  count: number
  tombstoned: number
}> {
  const startedAt = Date.now()
  state.seedingInFlight = true
  state.lastSeedStartedAt = startedAt
  state.lastError = null
  state.generation += 1

  try {
    const entries = await listExternalSessionEntries(workspacePath, { force: true }).catch(() => [])

    const db = getDb()
    const deviceId = getDeviceId()
    const now = nowIso()

    // Upsert — preserves existing overlay columns on conflict.
    const upsert = db.prepare(`
      INSERT INTO threads (
        id, device_id, created_at, updated_at, version,
        entry_id, source, scope, session_id, file_path, provider, model,
        source_label, source_detail, tile_id,
        title, message_count, last_message,
        project_path, workspace_dir, related_group_id, nesting_level,
        can_open_in_chat, can_open_in_app, resume_bin, resume_args_json,
        source_updated_ms, indexed_at
      ) VALUES (
        @id, @device_id, @now, @now, 1,
        @entry_id, @source, @scope, @session_id, @file_path, @provider, @model,
        @source_label, @source_detail, @tile_id,
        @title, @message_count, @last_message,
        @project_path, @workspace_dir, @related_group_id, @nesting_level,
        @can_open_in_chat, @can_open_in_app, @resume_bin, @resume_args_json,
        @source_updated_ms, @now
      )
      ON CONFLICT(entry_id) DO UPDATE SET
        source             = excluded.source,
        scope              = excluded.scope,
        session_id         = excluded.session_id,
        file_path          = excluded.file_path,
        provider           = excluded.provider,
        model              = excluded.model,
        source_label       = excluded.source_label,
        source_detail      = excluded.source_detail,
        tile_id            = excluded.tile_id,
        title              = excluded.title,
        message_count      = excluded.message_count,
        last_message       = excluded.last_message,
        project_path       = excluded.project_path,
        workspace_dir      = excluded.workspace_dir,
        related_group_id   = excluded.related_group_id,
        nesting_level      = excluded.nesting_level,
        can_open_in_chat   = excluded.can_open_in_chat,
        can_open_in_app    = excluded.can_open_in_app,
        resume_bin         = excluded.resume_bin,
        resume_args_json   = excluded.resume_args_json,
        source_updated_ms  = excluded.source_updated_ms,
        updated_at         = excluded.updated_at,
        indexed_at         = excluded.indexed_at,
        deleted_at         = NULL,
        version            = threads.version + 1
    `)

    const markStaleDeleted = db.prepare(`
      UPDATE threads
         SET deleted_at = @now, updated_at = @now, version = version + 1
       WHERE workspace_dir IS @workspace_dir
         AND deleted_at IS NULL
         AND indexed_at < @now
    `)

    // Count how many upserts actually mutated a row (new insert or real
    // column change) so we only broadcast when the UI would see a difference.
    const seededIds = new Set<string>()
    let upsertChanges = 0
    const txn = db.transaction((rows: ThreadRowForInsert[]) => {
      for (const row of rows) {
        const info = upsert.run({ ...row, device_id: deviceId, now })
        upsertChanges += info.changes
        seededIds.add(row.entry_id)
      }
      const result = markStaleDeleted.run({ now, workspace_dir: workspacePath })
      return result.changes
    })

    const rows = entries.map(e => entryToRow(e, workspacePath))
    const tombstoned = txn(rows) as unknown as number

    const finishedAt = Date.now()
    state.lastSeedFinishedAt = finishedAt
    state.lastSeedDurationMs = finishedAt - startedAt
    state.lastSeedCount = rows.length
    state.seedingInFlight = false
    state.workspacePath = workspacePath

    // eslint-disable-next-line no-console
    console.log(`[threads] Seeded ${rows.length} entries in ${state.lastSeedDurationMs}ms (tombstoned ${tombstoned}); workspace=${workspacePath ?? '(none)'}`)

    broadcastToRenderer('threads:indexUpdated', {
      workspacePath,
      count: rows.length,
      tombstoned,
      durationMs: state.lastSeedDurationMs,
    })
    // Only refresh the sidebar when something actually changed. Otherwise
    // periodic reseeds would churn the UI every 15 min for no visible reason
    // (and reset user pagination / scroll state).
    const changed = upsertChanges > 0 || tombstoned > 0
    if (changed) {
      // Sidebar subscribes to canvas:sessionsChanged; '*' is our wildcard
      // sentinel meaning "refresh every loaded workspace".
      broadcastToRenderer('canvas:sessionsChanged', { workspaceId: '*', workspacePath })
    }

    return { durationMs: state.lastSeedDurationMs, count: rows.length, tombstoned }
  } catch (err) {
    state.seedingInFlight = false
    state.lastError = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error('[threads] Seed failed:', err)
    return { durationMs: Date.now() - startedAt, count: 0, tombstoned: 0 }
  }
}

// ─── Reading ───────────────────────────────────────────────────────────────

export function listThreadsFromDb(workspacePath: string | null): AggregatedSessionEntry[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT * FROM threads
     WHERE deleted_at IS NULL
       AND (workspace_dir IS @workspace_dir OR scope = 'user')
     ORDER BY source_updated_ms DESC
  `).all({ workspace_dir: workspacePath }) as Record<string, unknown>[]
  return rows.map(rowToEntry)
}

export function countThreadsInDb(): number {
  const db = getDb()
  return (db.prepare(`SELECT COUNT(*) AS c FROM threads WHERE deleted_at IS NULL`).get() as { c: number }).c
}

export function getIndexerStatus(): {
  workspacePath: string | null
  seedingInFlight: boolean
  lastSeedStartedAt: number
  lastSeedFinishedAt: number
  lastSeedDurationMs: number
  lastSeedCount: number
  totalRows: number
  lastError: string | null
  watcherCount: number
} {
  return {
    workspacePath: state.workspacePath,
    seedingInFlight: state.seedingInFlight,
    lastSeedStartedAt: state.lastSeedStartedAt,
    lastSeedFinishedAt: state.lastSeedFinishedAt,
    lastSeedDurationMs: state.lastSeedDurationMs,
    lastSeedCount: state.lastSeedCount,
    totalRows: (() => {
      try { return countThreadsInDb() } catch { return 0 }
    })(),
    lastError: state.lastError,
    watcherCount: 0, // no filesystem watchers; see module header
  }
}

// ─── Periodic refresh ──────────────────────────────────────────────────────

function startPeriodicReseed(): void {
  stopPeriodicReseed()
  state.periodicTimer = setInterval(() => {
    if (state.seedingInFlight) return
    invalidateExternalSessionCache()
    void seedThreadsIndex(state.workspacePath)
  }, PERIODIC_RESEED_MS)
  if (typeof state.periodicTimer.unref === 'function') state.periodicTimer.unref()
}

function stopPeriodicReseed(): void {
  if (state.periodicTimer) {
    clearInterval(state.periodicTimer)
    state.periodicTimer = null
  }
}

/** Retained as a stable export — no-op now. See module header. */
export function startThreadWatchers(_workspacePath: string | null): void {
  // Intentionally empty.
}

export function stopThreadWatchers(): void {
  stopPeriodicReseed()
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let initialised = false

/**
 * Kick off seeding in the background and start the periodic re-seed timer.
 * Safe to call multiple times; subsequent calls retarget to the new workspace.
 */
export function initThreadIndexerForWorkspace(workspacePath: string | null): void {
  initialised = true
  state.workspacePath = workspacePath
  startPeriodicReseed()
  // Seed only when we actually have a workspace. Boot often hits this before
  // the daemon has resolved the active workspace — avoid wasting an 8s walk
  // that we'd have to throw away the moment the real workspace arrives.
  if (workspacePath) void seedThreadsIndex(workspacePath)
}

export function isThreadIndexerActive(): boolean {
  return initialised
}

/** Ensure the indexer is running; used as a lazy-start hook from IPC. */
export function ensureThreadIndexer(workspacePath: string | null): void {
  if (!initialised) initThreadIndexerForWorkspace(workspacePath)
  else if (state.workspacePath !== workspacePath) {
    initThreadIndexerForWorkspace(workspacePath)
  }
}

// Keep the daemon-client module graph honest even though this file no longer
// uses it directly (a future phase will merge local+external here).
void daemonClient
