/**
 * Local SQLite database paths.
 *
 * Layout:
 *   ~/.codesurf/db/codesurf.db          — live database (WAL mode)
 *   ~/.codesurf/db/codesurf.db-wal      — SQLite WAL sidecar
 *   ~/.codesurf/db/codesurf.db-shm      — SQLite SHM sidecar
 *   ~/.codesurf/db/backups/             — pre-migration backups + reset snapshots
 *       codesurf.db.premigrate-{version}-{timestamp}
 *       codesurf.db.reset-{timestamp}
 */
import { join } from 'path'
import { CONTEX_HOME } from '../paths'

export const DB_DIRNAME = 'db'
export const DB_FILENAME = 'codesurf.db'
export const DB_BACKUPS_DIRNAME = 'backups'

export const DB_DIR = join(CONTEX_HOME, DB_DIRNAME)
export const DB_PATH = join(DB_DIR, DB_FILENAME)
export const DB_BACKUPS_DIR = join(DB_DIR, DB_BACKUPS_DIRNAME)

export function dbBackupPath(label: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, '-')
  return join(DB_BACKUPS_DIR, `${DB_FILENAME}.${safeLabel}-${timestamp}`)
}
