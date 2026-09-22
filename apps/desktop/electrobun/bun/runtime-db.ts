import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

type SqliteDatabase = InstanceType<typeof Database>

type Migration = {
  version: number
  name: string
  sql: string
}

type RecentJobsRequest = {
  workspaceId?: string | null
  limit?: number
  offset?: number
  includeArchived?: boolean
}

type RecentJobRow = {
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

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'bootstrap',
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'threads-index',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL UNIQUE,
        device_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at  TEXT,
        version     INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        project_id  TEXT,
        is_active   INTEGER NOT NULL DEFAULT 0,
        device_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at  TEXT,
        version     INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id                    TEXT PRIMARY KEY,
        device_id             TEXT NOT NULL,
        created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at            TEXT,
        version               INTEGER NOT NULL DEFAULT 1,
        entry_id              TEXT NOT NULL UNIQUE,
        source                TEXT NOT NULL,
        scope                 TEXT NOT NULL,
        session_id            TEXT,
        file_path             TEXT,
        provider              TEXT NOT NULL DEFAULT '',
        model                 TEXT NOT NULL DEFAULT '',
        source_label          TEXT NOT NULL DEFAULT '',
        source_detail         TEXT,
        tile_id               TEXT,
        title                 TEXT NOT NULL,
        title_override        TEXT,
        last_message          TEXT,
        message_count         INTEGER NOT NULL DEFAULT 0,
        project_path          TEXT,
        workspace_dir         TEXT,
        related_group_id      TEXT,
        nesting_level         INTEGER NOT NULL DEFAULT 0,
        is_pinned             INTEGER NOT NULL DEFAULT 0,
        is_archived           INTEGER NOT NULL DEFAULT 0,
        is_starred            INTEGER NOT NULL DEFAULT 0,
        last_opened_at        TEXT,
        can_open_in_chat      INTEGER NOT NULL DEFAULT 0,
        can_open_in_app       INTEGER NOT NULL DEFAULT 0,
        resume_bin            TEXT,
        resume_args_json      TEXT,
        source_updated_ms     INTEGER NOT NULL DEFAULT 0,
        source_mtime_ms       INTEGER NOT NULL DEFAULT 0,
        source_size_bytes     INTEGER NOT NULL DEFAULT 0,
        indexed_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_threads_updated      ON threads(source_updated_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_project      ON threads(project_path, source_updated_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_source       ON threads(source);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace    ON threads(workspace_dir);
      CREATE INDEX IF NOT EXISTS idx_threads_deleted      ON threads(deleted_at) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_entry ON threads(entry_id);
    `,
  },
  {
    version: 3,
    name: 'thread-index-v2',
    sql: `
      DROP TABLE IF EXISTS threads;

      CREATE TABLE thread_index (
        id                TEXT PRIMARY KEY,
        device_id         TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at        TEXT,
        version           INTEGER NOT NULL DEFAULT 1,
        entry_id          TEXT NOT NULL UNIQUE,
        source            TEXT NOT NULL,
        file_path         TEXT,
        session_id        TEXT,
        title             TEXT NOT NULL,
        title_override    TEXT,
        preview           TEXT,
        message_count     INTEGER NOT NULL DEFAULT 0,
        project_path      TEXT,
        scope             TEXT NOT NULL DEFAULT 'user',
        related_group_id  TEXT,
        nesting_level     INTEGER NOT NULL DEFAULT 0,
        tile_id           TEXT,
        provider          TEXT NOT NULL DEFAULT '',
        model             TEXT NOT NULL DEFAULT '',
        source_label      TEXT NOT NULL DEFAULT '',
        source_detail     TEXT,
        source_mtime_ms   INTEGER NOT NULL DEFAULT 0,
        source_size_bytes INTEGER NOT NULL DEFAULT 0,
        source_updated_ms INTEGER NOT NULL DEFAULT 0,
        is_pinned         INTEGER NOT NULL DEFAULT 0,
        is_archived       INTEGER NOT NULL DEFAULT 0,
        is_starred        INTEGER NOT NULL DEFAULT 0,
        last_opened_at    TEXT,
        can_open_in_chat  INTEGER NOT NULL DEFAULT 0,
        can_open_in_app   INTEGER NOT NULL DEFAULT 0,
        resume_bin        TEXT,
        resume_args_json  TEXT
      );

      CREATE INDEX idx_ti_updated     ON thread_index(source_updated_ms DESC);
      CREATE INDEX idx_ti_project     ON thread_index(project_path, source_updated_ms DESC);
      CREATE INDEX idx_ti_source      ON thread_index(source);
      CREATE INDEX idx_ti_file_path   ON thread_index(file_path) WHERE file_path IS NOT NULL;
      CREATE INDEX idx_ti_live        ON thread_index(deleted_at) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 4,
    name: 'job-index-v1',
    sql: `
      CREATE TABLE job_index (
        id                   TEXT PRIMARY KEY,
        device_id            TEXT NOT NULL,
        created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at           TEXT,
        version              INTEGER NOT NULL DEFAULT 1,
        job_id               TEXT NOT NULL UNIQUE,
        file_path            TEXT NOT NULL,
        task_label           TEXT,
        initial_prompt       TEXT,
        status               TEXT,
        provider             TEXT,
        model                TEXT,
        run_mode             TEXT,
        workspace_id         TEXT,
        workspace_dir        TEXT,
        card_id              TEXT,
        session_id           TEXT,
        requested_at_ms      INTEGER,
        completed_at_ms      INTEGER,
        duration_ms          INTEGER,
        error_text           TEXT,
        event_count          INTEGER NOT NULL DEFAULT 0,
        error_count          INTEGER NOT NULL DEFAULT 0,
        last_event_type      TEXT,
        last_event_at_ms     INTEGER,
        last_sequence        INTEGER NOT NULL DEFAULT 0,
        last_activity_at_ms  INTEGER,
        source_mtime_ms      INTEGER NOT NULL DEFAULT 0,
        source_size_bytes    INTEGER NOT NULL DEFAULT 0,
        timeline_mtime_ms    INTEGER NOT NULL DEFAULT 0,
        timeline_size_bytes  INTEGER NOT NULL DEFAULT 0,
        is_starred           INTEGER NOT NULL DEFAULT 0,
        is_archived          INTEGER NOT NULL DEFAULT 0,
        notes                TEXT,
        extra_json           TEXT
      );

      CREATE INDEX idx_ji_activity      ON job_index(last_activity_at_ms DESC);
      CREATE INDEX idx_ji_ws_activity   ON job_index(workspace_id, last_activity_at_ms DESC);
      CREATE INDEX idx_ji_live_activity ON job_index(last_activity_at_ms DESC) WHERE deleted_at IS NULL;
      CREATE INDEX idx_ji_requested     ON job_index(requested_at_ms DESC);
      CREATE INDEX idx_ji_provider      ON job_index(provider, status);
      CREATE INDEX idx_ji_status        ON job_index(status);
      CREATE INDEX idx_ji_card          ON job_index(card_id) WHERE card_id IS NOT NULL;
      CREATE INDEX idx_ji_live          ON job_index(deleted_at) WHERE deleted_at IS NULL;

      CREATE TABLE timeline_event_index (
        id             TEXT PRIMARY KEY,
        device_id      TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        job_id         TEXT NOT NULL,
        sequence       INTEGER NOT NULL,
        timestamp_ms   INTEGER NOT NULL,
        event_type     TEXT NOT NULL,
        error_text     TEXT,
        payload_json   TEXT NOT NULL,
        UNIQUE (job_id, sequence)
      );

      CREATE INDEX idx_tei_job_seq   ON timeline_event_index(job_id, sequence);
      CREATE INDEX idx_tei_time      ON timeline_event_index(timestamp_ms DESC);
      CREATE INDEX idx_tei_type      ON timeline_event_index(event_type);
      CREATE INDEX idx_tei_errors    ON timeline_event_index(job_id) WHERE error_text IS NOT NULL;

      CREATE VIRTUAL TABLE job_search USING fts5(
        job_id UNINDEXED,
        task_label,
        error_text,
        content,
        tokenize = 'porter unicode61'
      );

      CREATE VIRTUAL TABLE timeline_search USING fts5(
        job_id UNINDEXED,
        sequence UNINDEXED,
        event_type UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER job_search_ai AFTER INSERT ON job_index BEGIN
        INSERT INTO job_search(rowid, job_id, task_label, error_text, content)
        VALUES (
          new.rowid, new.job_id, new.task_label, new.error_text,
          coalesce(new.task_label,'') || ' '
          || coalesce(new.initial_prompt,'') || ' '
          || coalesce(new.error_text,'')
        );
      END;
      CREATE TRIGGER job_search_au AFTER UPDATE ON job_index BEGIN
        UPDATE job_search SET
          task_label = new.task_label,
          error_text = new.error_text,
          content    = coalesce(new.task_label,'') || ' '
                    || coalesce(new.initial_prompt,'') || ' '
                    || coalesce(new.error_text,'')
        WHERE rowid = new.rowid;
      END;
      CREATE TRIGGER job_search_ad AFTER DELETE ON job_index BEGIN
        DELETE FROM job_search WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER timeline_search_ai AFTER INSERT ON timeline_event_index BEGIN
        INSERT INTO timeline_search(rowid, job_id, sequence, event_type, content)
        VALUES (
          new.rowid, new.job_id, new.sequence, new.event_type,
          coalesce(new.error_text,'') || ' ' || coalesce(new.payload_json,'')
        );
      END;
      CREATE TRIGGER timeline_search_ad AFTER DELETE ON timeline_event_index BEGIN
        DELETE FROM timeline_search WHERE rowid = old.rowid;
      END;
    `,
  },
]

function dbPaths(baseDir: string) {
  const dbDir = join(baseDir, 'db')
  return {
    dbDir,
    dbPath: join(dbDir, 'codesurf.db'),
    backupsDir: join(dbDir, 'backups'),
  }
}

function backupPath(baseDir: string, label: string): string {
  const { backupsDir } = dbPaths(baseDir)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, '-')
  return join(backupsDir, `codesurf.db.${safeLabel}-${timestamp}`)
}

function applyPragmas(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_size_limit = 67108864')
  db.exec('PRAGMA temp_store = MEMORY')
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)
}

function schemaVersion(db: SqliteDatabase): number {
  const row = db.query('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number | null } | null
  return Number(row?.version ?? 0)
}

function runMigrations(db: SqliteDatabase): { applied: Migration[], currentVersion: number } {
  ensureMigrationsTable(db)
  const currentVersion = schemaVersion(db)
  const pending = MIGRATIONS.filter(migration => migration.version > currentVersion).sort((a, b) => a.version - b.version)
  if (pending.length === 0) return { applied: [], currentVersion }

  const insert = db.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
  const applied: Migration[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const migration of pending) {
      db.exec(migration.sql)
      insert.run(migration.version, migration.name)
      applied.push(migration)
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }

  return { applied, currentVersion: schemaVersion(db) }
}

function rowToRecentJob(row: RecentJobRow) {
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
    eventCount: Number(row.event_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
    isStarred: Number(row.is_starred ?? 0) === 1,
    isArchived: Number(row.is_archived ?? 0) === 1,
  }
}

function clampLimit(raw: unknown): number {
  const n = Number.isFinite(raw) ? Math.floor(Number(raw)) : 50
  if (n < 1) return 1
  if (n > 500) return 500
  return n
}

function clampOffset(raw: unknown): number {
  const n = Number.isFinite(raw) ? Math.floor(Number(raw)) : 0
  return n < 0 ? 0 : n
}

function normalizeWorkspace(raw: unknown): string | null {
  if (raw == null) return null
  const value = String(raw).trim()
  return value ? value : null
}

export function createElectrobunDbRuntime(baseDir: string) {
  const paths = dbPaths(baseDir)
  let dbInstance: SqliteDatabase | null = null
  let cachedDeviceId: string | null = null

  const ensureDirs = () => {
    mkdirSync(paths.dbDir, { recursive: true })
    mkdirSync(paths.backupsDir, { recursive: true })
  }

  const getDb = (): SqliteDatabase => {
    if (dbInstance) return dbInstance
    ensureDirs()
    dbInstance = new Database(paths.dbPath)
    applyPragmas(dbInstance)
    runMigrations(dbInstance)
    return dbInstance
  }

  const getDeviceId = (): string => {
    if (cachedDeviceId) return cachedDeviceId
    const db = getDb()
    const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('device_id') as { value?: string } | null
    if (row?.value) {
      cachedDeviceId = row.value
      return cachedDeviceId
    }
    cachedDeviceId = randomUUID()
    db.query('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('device_id', cachedDeviceId)
    return cachedDeviceId
  }

  const close = (): void => {
    if (!dbInstance) return
    try { dbInstance.close() } catch { /* ignore */ }
    dbInstance = null
  }

  const getStatus = () => {
    const db = getDb()
    const version = schemaVersion(db)
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    return {
      path: paths.dbPath,
      deviceId: getDeviceId(),
      schemaVersion: version,
      tables,
    }
  }

  const reset = (): { backupPath: string | null } => {
    close()
    let movedPath: string | null = null
    if (existsSync(paths.dbPath)) {
      ensureDirs()
      movedPath = backupPath(baseDir, 'reset')
      renameSync(paths.dbPath, movedPath)
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${paths.dbPath}${suffix}`
        if (!existsSync(sidecar)) continue
        try { renameSync(sidecar, `${movedPath}${suffix}`) } catch { /* ignore */ }
      }
    }
    cachedDeviceId = null
    getDb()
    return { backupPath: movedPath }
  }

  const listRecentJobs = (req: RecentJobsRequest = {}) => {
    const db = getDb()
    const workspaceId = normalizeWorkspace(req.workspaceId)
    const includeArchived = req.includeArchived === true
    const limit = clampLimit(req.limit)
    const offset = clampOffset(req.offset)
    const clauses = ['deleted_at IS NULL']
    const params: Array<string | number> = []
    if (workspaceId) {
      clauses.push('workspace_id = ?')
      params.push(workspaceId)
    }
    if (!includeArchived) clauses.push('is_archived = 0')
    const whereSql = clauses.join(' AND ')

    const total = Number((db.query(`SELECT COUNT(*) AS n FROM job_index WHERE ${whereSql}`).get(...params) as { n?: number } | null)?.n ?? 0)
    const rows = db.query(`
      SELECT
        job_id, task_label, initial_prompt, status, provider, model,
        run_mode, workspace_id, workspace_dir, card_id,
        requested_at_ms, completed_at_ms, duration_ms,
        last_activity_at_ms, last_event_type,
        event_count, error_count, is_starred, is_archived
      FROM job_index
      WHERE ${whereSql}
      ORDER BY last_activity_at_ms DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RecentJobRow[]

    return {
      jobs: rows.map(rowToRecentJob),
      total,
      limit,
      offset,
    }
  }

  const getJobSummary = () => {
    const db = getDb()
    const row = db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('running', 'active', 'pending', 'queued') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM job_index
      WHERE deleted_at IS NULL AND is_archived = 0
    `).get() as { total?: number, active?: number, completed?: number, failed?: number, cancelled?: number } | null
    const total = Number(row?.total ?? 0)
    const active = Number(row?.active ?? 0)
    const completed = Number(row?.completed ?? 0)
    const failed = Number(row?.failed ?? 0)
    const cancelled = Number(row?.cancelled ?? 0)
    return {
      total,
      active,
      backgroundActive: 0,
      completed,
      failed,
      cancelled,
      other: Math.max(0, total - active - completed - failed - cancelled),
      recent: listRecentJobs({ limit: 6 }).jobs.map(job => ({
        id: job.jobId,
        taskLabel: job.taskLabel,
        status: job.status,
        runMode: job.runMode,
        workspaceId: job.workspaceId,
        cardId: job.cardId,
        provider: job.provider,
        model: job.model,
        workspaceDir: job.workspaceDir,
        sessionId: null,
        initialPrompt: job.initialPrompt,
        updatedAt: job.lastActivityAtMs,
        requestedAt: job.requestedAtMs,
        lastSequence: job.eventCount,
        error: job.errorCount > 0 ? `${job.errorCount} error${job.errorCount === 1 ? '' : 's'}` : null,
      })),
    }
  }

  return {
    getDb,
    getDeviceId,
    close,
    getStatus,
    reset,
    listRecentJobs,
    getJobSummary,
  }
}
