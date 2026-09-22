/**
 * Migration 002 — projects, workspaces, and threads index.
 *
 * Phase 1 (schema-only for projects/workspaces): JSON files remain the
 * source of truth for now; the DB tables are dual-write targets for a
 * future phase.
 *
 * Phase 2 (active): `threads` stores an index of every aggregated session
 * entry across all sources. The thread-indexer seeds/refreshes it; the
 * sidebar reads it instead of walking the filesystem on every refresh.
 *
 * Every table carries the sync prelude: id (TEXT PK), device_id,
 * created_at, updated_at, deleted_at, version. Sync (phase 10) will push
 * these to Postgres via LWW per row.
 */
import type { Migration } from '../migrations'

export const migration002Threads: Migration = {
  version: 2,
  name: 'threads-index',
  up(db) {
    db.exec(`
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
        -- Sync prelude
        id                    TEXT PRIMARY KEY,           -- uuid v4 for sync; stable across devices
        device_id             TEXT NOT NULL,
        created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at            TEXT,
        version               INTEGER NOT NULL DEFAULT 1,

        -- Identity against the aggregator
        entry_id              TEXT NOT NULL UNIQUE,       -- AggregatedSessionEntry.id
        source                TEXT NOT NULL,              -- 'codesurf'|'claude'|'codex'|'cursor'|'openclaw'|'opencode'
        scope                 TEXT NOT NULL,              -- 'workspace'|'project'|'user'
        session_id            TEXT,                       -- provider-side session id
        file_path             TEXT,                       -- absolute path on disk (null for DB-sourced)
        provider              TEXT NOT NULL DEFAULT '',
        model                 TEXT NOT NULL DEFAULT '',
        source_label          TEXT NOT NULL DEFAULT '',
        source_detail         TEXT,
        tile_id               TEXT,

        -- Content snapshot
        title                 TEXT NOT NULL,
        title_override        TEXT,                       -- user rename overlay (owned by us)
        last_message          TEXT,
        message_count         INTEGER NOT NULL DEFAULT 0,

        -- Placement
        project_path          TEXT,                       -- for grouping
        workspace_dir         TEXT,
        related_group_id      TEXT,
        nesting_level         INTEGER NOT NULL DEFAULT 0,

        -- Overlay metadata we own
        is_pinned             INTEGER NOT NULL DEFAULT 0,
        is_archived           INTEGER NOT NULL DEFAULT 0,
        is_starred            INTEGER NOT NULL DEFAULT 0,
        last_opened_at        TEXT,

        -- Resume metadata
        can_open_in_chat      INTEGER NOT NULL DEFAULT 0,
        can_open_in_app       INTEGER NOT NULL DEFAULT 0,
        resume_bin            TEXT,
        resume_args_json      TEXT,                       -- JSON array

        -- Source freshness signals (for incremental re-index)
        source_updated_ms     INTEGER NOT NULL DEFAULT 0, -- AggregatedSessionEntry.updatedAt
        source_mtime_ms       INTEGER NOT NULL DEFAULT 0, -- file mtime
        source_size_bytes     INTEGER NOT NULL DEFAULT 0,
        indexed_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_threads_updated      ON threads(source_updated_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_project      ON threads(project_path, source_updated_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_source       ON threads(source);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace    ON threads(workspace_dir);
      CREATE INDEX IF NOT EXISTS idx_threads_deleted      ON threads(deleted_at) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_entry ON threads(entry_id);
    `)
  },
}
