/**
 * Migration runner. Each migration is an idempotent step that brings the schema
 * from version N-1 to version N. Versions are monotonic integers starting at 1.
 *
 * Migrations run inside a single transaction. Before the runner applies the
 * first pending migration, it takes a physical file-level backup of the
 * current DB (only if the DB already has a schema version > 0).
 */
import type Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { DB_BACKUPS_DIR, DB_PATH, dbBackupPath } from './paths'

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)
}

function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare<[], { version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  ).get()
  return row?.version ?? 0
}

function backupDatabase(version: number): string | null {
  try {
    if (!existsSync(DB_PATH)) return null
    mkdirSync(DB_BACKUPS_DIR, { recursive: true })
    const target = dbBackupPath(`premigrate-v${version}`)
    copyFileSync(DB_PATH, target)
    return target
  } catch (err) {
    // Non-fatal: if backup fails we still want the migration to run, but log it.
    // eslint-disable-next-line no-console
    console.warn('[db] Pre-migration backup failed:', err)
    return null
  }
}

export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
): { applied: Migration[]; currentVersion: number } {
  ensureMigrationsTable(db)
  const currentVersion = getCurrentVersion(db)
  const pending = migrations
    .slice()
    .sort((a, b) => a.version - b.version)
    .filter(m => m.version > currentVersion)

  if (pending.length === 0) {
    return { applied: [], currentVersion }
  }

  // Back up before the first pending migration touches anything.
  if (currentVersion > 0) {
    const backup = backupDatabase(currentVersion)
    if (backup) {
      // eslint-disable-next-line no-console
      console.log(`[db] Backup taken before migrating v${currentVersion} -> v${pending[pending.length - 1].version}: ${backup}`)
    }
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
  )

  const applied: Migration[] = []
  const txn = db.transaction((list: Migration[]) => {
    for (const migration of list) {
      migration.up(db)
      insert.run(migration.version, migration.name)
      applied.push(migration)
    }
  })
  txn(pending)

  return { applied, currentVersion: getCurrentVersion(db) }
}
