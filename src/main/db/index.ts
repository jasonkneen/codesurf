/**
 * Local SQLite database singleton.
 *
 * Phase 0: opens (and creates if missing) the DB at ~/.codesurf/db/codesurf.db,
 * applies pending migrations, and seeds a stable device_id into app_meta. No
 * feature code reads or writes it yet. See ./paths.ts for layout.
 *
 * Lifecycle:
 *   getDb()       — opens + migrates on first call, returns singleton.
 *   getDeviceId() — returns the stable per-install uuid.
 *   closeDb()     — closes the handle; safe to call multiple times.
 *   resetDatabase() — closes, moves the live DB aside into backups/,
 *                     and clears the singleton so the next getDb() call
 *                     re-creates a fresh, migrated DB.
 */
import type DatabaseCtor from 'better-sqlite3'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import { DB_BACKUPS_DIR, DB_DIR, DB_PATH, dbBackupPath } from './paths'
import { runMigrations, type Migration } from './migrations'
import { migration001Bootstrap } from './migrations/001_bootstrap'

type DBHandle = ReturnType<typeof DatabaseCtor>

const ALL_MIGRATIONS: Migration[] = [
  migration001Bootstrap,
  // Future phases append here:
  //   migration002Projects,
  //   migration003Workspaces,
  //   migration004Threads,
  //   ...
]

let dbInstance: DBHandle | null = null
let cachedDeviceId: string | null = null

function ensureDirs(): void {
  mkdirSync(DB_DIR, { recursive: true })
  mkdirSync(DB_BACKUPS_DIR, { recursive: true })
}

function applyPragmas(db: DBHandle): void {
  // WAL gives us safe concurrent read + single-writer semantics and avoids
  // blocking the UI on writes. NORMAL sync is durable enough for WAL.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  // 64 MB cap on the WAL file growth; prevents unbounded growth on crash loops.
  db.pragma('journal_size_limit = 67108864')
  db.pragma('temp_store = MEMORY')
}

function seedDeviceId(db: DBHandle): string {
  const row = db.prepare<[string], { value: string }>(
    'SELECT value FROM app_meta WHERE key = ?',
  ).get('device_id')
  if (row?.value) return row.value

  const id = randomUUID()
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('device_id', id)
  return id
}

function openAndMigrate(): DBHandle {
  ensureDirs()
  const db = new Database(DB_PATH)
  applyPragmas(db)

  const { applied, currentVersion } = runMigrations(db, ALL_MIGRATIONS)
  if (applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[db] Applied ${applied.length} migration(s); now at v${currentVersion}: ${applied.map(m => `${m.version}:${m.name}`).join(', ')}`)
  }

  cachedDeviceId = seedDeviceId(db)
  return db
}

export function getDb(): DBHandle {
  if (!dbInstance) dbInstance = openAndMigrate()
  return dbInstance
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  // Cheap self-init if someone calls getDeviceId before getDb.
  getDb()
  return cachedDeviceId ?? ''
}

export function closeDb(): void {
  if (!dbInstance) return
  try { dbInstance.close() } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[db] close failed:', err)
  }
  dbInstance = null
}

/**
 * Close the DB, move the live file (and WAL/SHM sidecars) into backups/
 * under a timestamped name, and clear caches. The next getDb() call will
 * create a fresh DB at DB_PATH.
 *
 * Intended as a user-facing "Reset local database" action.
 */
export function resetDatabase(): { backupPath: string | null } {
  closeDb()
  let backupPath: string | null = null
  try {
    if (existsSync(DB_PATH)) {
      mkdirSync(DB_BACKUPS_DIR, { recursive: true })
      backupPath = dbBackupPath('reset')
      renameSync(DB_PATH, backupPath)
      // WAL / SHM sidecars are not critical to preserve but should not linger.
      for (const suffix of ['-wal', '-shm']) {
        const side = `${DB_PATH}${suffix}`
        if (existsSync(side)) {
          try { renameSync(side, `${backupPath}${suffix}`) } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[db] reset failed:', err)
  }
  cachedDeviceId = null
  return { backupPath }
}

/** Phase-0 status snapshot — intended for diagnostics / Settings > Advanced later. */
export function getDbStatus(): {
  path: string
  deviceId: string
  schemaVersion: number
  tables: string[]
} {
  const db = getDb()
  const version = db.prepare<[], { v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  ).get()?.v ?? 0
  const tables = db.prepare<[], { name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all().map(r => r.name)
  return {
    path: DB_PATH,
    deviceId: getDeviceId(),
    schemaVersion: version,
    tables,
  }
}
