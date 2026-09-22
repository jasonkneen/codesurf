/**
 * Migration 003 — lightweight thread index.
 *
 * Replaces the heavier `threads` table from 002 with a simpler index that
 * stores ONLY pointers + display metadata. No message content, no tool
 * blocks, no workspace ownership. External sessions stay in their provider
 * files (Claude/Codex/Cursor/OpenClaw/OpenCode own their own data); we just
 * index them for the sidebar and parse on-demand when the user opens one.
 *
 * The old `threads` table is dropped — its rows were just cached pointers
 * anyway, and the indexer reseeds from source files on next launch.
 */
import type { Migration } from '../migrations'

export const migration003ThreadIndex: Migration = {
  version: 3,
  name: 'thread-index-v2',
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS threads;

      CREATE TABLE thread_index (
        -- Sync prelude
        id                TEXT PRIMARY KEY,
        device_id         TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at        TEXT,
        version           INTEGER NOT NULL DEFAULT 1,

        -- Identity
        entry_id          TEXT NOT NULL UNIQUE,          -- AggregatedSessionEntry.id
        source            TEXT NOT NULL,                  -- codesurf|claude|codex|cursor|openclaw|opencode
        file_path         TEXT,                           -- absolute path on disk (null only for DB-native)
        session_id        TEXT,                           -- provider's own id (for resume)

        -- Display
        title             TEXT NOT NULL,
        title_override    TEXT,                           -- user rename, preserved across reindex
        preview           TEXT,                           -- last-message snippet
        message_count     INTEGER NOT NULL DEFAULT 0,

        -- Placement
        project_path      TEXT,
        scope             TEXT NOT NULL DEFAULT 'user',   -- 'workspace'|'project'|'user'
        related_group_id  TEXT,
        nesting_level     INTEGER NOT NULL DEFAULT 0,
        tile_id           TEXT,

        -- Provider metadata
        provider          TEXT NOT NULL DEFAULT '',
        model             TEXT NOT NULL DEFAULT '',
        source_label      TEXT NOT NULL DEFAULT '',
        source_detail     TEXT,

        -- Source freshness (drives incremental re-index)
        source_mtime_ms   INTEGER NOT NULL DEFAULT 0,
        source_size_bytes INTEGER NOT NULL DEFAULT 0,
        source_updated_ms INTEGER NOT NULL DEFAULT 0,

        -- Overlay (user-owned)
        is_pinned         INTEGER NOT NULL DEFAULT 0,
        is_archived       INTEGER NOT NULL DEFAULT 0,
        is_starred        INTEGER NOT NULL DEFAULT 0,
        last_opened_at    TEXT,

        -- Resume metadata
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
    `)
  },
}
