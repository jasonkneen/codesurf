import { Database } from "bun:sqlite";
import { defaultCodesurfHome } from "@codesurf/daemon";
import fs from "fs";
import os from "os";
import path from "path";
import { applyMigrations } from "./migrations";

export interface SQLiteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  pragma(query: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

let db: SQLiteDatabase | null = null;

/**
 * Returns the path to the TUI's sqlite database. Lives at
 * `~/.codesurf/terminal.db` (the codesurf TUI shares the same home directory
 * as the desktop app and the codesurfd daemon, but uses a distinct filename
 * so it can't collide with daemon-owned JSON state).
 *
 * On first call, if `~/.codesurf/terminal.db` is missing AND the legacy
 * `~/.grok/grok.db` exists, the legacy DB (plus its WAL/SHM sidecars) is
 * copied across and a marker file is written so we don't repeat the migration
 * on every subsequent call. The legacy DB is *not* deleted; users can wipe
 * `~/.grok/` manually once they're confident the new home works.
 */
export function getDatabasePath(): string {
  const dir = defaultCodesurfHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, "terminal.db");
  migrateLegacyDatabaseOnce(dir, target);
  return target;
}

const MIGRATION_MARKER = ".terminal-migrated-from-grok";

function migrateLegacyDatabaseOnce(homeDir: string, targetPath: string): void {
  // The legacy copy exists for the default-home upgrade path only. A custom
  // CODESURF_HOME (tests, sandboxed installs) is an explicit fresh location —
  // silently pulling the real ~/.grok database into it would leak the user's
  // sessions into test/temp homes.
  if (process.env.CODESURF_HOME?.trim()) return;

  const markerPath = path.join(homeDir, MIGRATION_MARKER);
  // Already migrated, or new install — never touch the legacy file again.
  if (fs.existsSync(markerPath) || fs.existsSync(targetPath)) return;

  const legacyDir = path.join(os.homedir(), ".grok");
  const legacyPath = path.join(legacyDir, "grok.db");
  if (!fs.existsSync(legacyPath)) {
    // Nothing to migrate: write the marker so we skip the existsSync chain
    // on subsequent calls.
    try {
      fs.writeFileSync(markerPath, new Date().toISOString(), { mode: 0o600 });
    } catch {
      // Non-fatal — worst case we re-check next time.
    }
    return;
  }

  // Copy the database and any WAL/SHM sidecars side-by-side. Use copyFileSync
  // (not rename) so the legacy file remains intact as a safety net.
  try {
    fs.copyFileSync(legacyPath, targetPath);
    for (const sidecarSuffix of ["-wal", "-shm"]) {
      const sidecarSrc = `${legacyPath}${sidecarSuffix}`;
      if (fs.existsSync(sidecarSrc)) {
        fs.copyFileSync(sidecarSrc, `${targetPath}${sidecarSuffix}`);
      }
    }
    fs.writeFileSync(markerPath, `migrated-from=${legacyPath}\nmigrated-at=${new Date().toISOString()}\n`, {
      mode: 0o600,
    });
    process.stderr.write(
      `[codesurf] migrated sqlite database from ${legacyPath} to ${targetPath} (legacy file preserved).\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[codesurf] sqlite migration from ${legacyPath} failed: ${(err as Error).message}. Falling back to a fresh database at ${targetPath}.\n`,
    );
  }
}

export function getDatabase(): SQLiteDatabase {
  if (db) return db;

  const database = new BunSqliteDatabase(getDatabasePath());
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  applyMigrations(database);
  db = database;
  return database;
}

export function withTransaction<T>(fn: (database: SQLiteDatabase) => T): T {
  const database = getDatabase();
  return database.transaction(() => fn(database))();
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

class BunSqliteDatabase implements SQLiteDatabase {
  private readonly db: Database;

  constructor(filename: string) {
    this.db = new Database(filename, { create: true, strict: true });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SQLiteStatement {
    return {
      run: (...params: unknown[]) => this.db.run(sql, normalizeBinding(params)),
      get: (...params: unknown[]) => this.db.query(sql).get(normalizeBinding(params)),
      all: (...params: unknown[]) => this.db.query(sql).all(normalizeBinding(params)),
    };
  }

  pragma(query: string, options?: { simple?: boolean }): unknown {
    if (query.includes("=")) {
      this.db.exec(`PRAGMA ${query}`);
      return undefined;
    }

    const row = this.db.query(`PRAGMA ${query}`).get() as Record<string, unknown> | undefined;
    if (!options?.simple) return row;
    if (!row) return undefined;
    return Object.values(row)[0];
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

function normalizeBinding(params: unknown[]): unknown {
  if (params.length === 0) return undefined;
  return params.length === 1 ? params[0] : params;
}
