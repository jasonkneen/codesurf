/**
 * Migration 004 - job + timeline index with FTS5 search.
 *
 * Same "pointer + overlay" pattern as thread_index (003): jobs/{id}.json and
 * timelines/{id}.jsonl remain the canonical, agent-writable source of truth.
 * SQLite carries only:
 *   - indexed columns for fast list / filter / sort ("all failed Codex jobs
 *     this week", "all errors in workspace X")
 *   - an FTS5 mirror for content search across task labels + errors + events
 *   - a user-owned overlay (starred, archived, notes) that survives re-index
 *
 * If the DB is wiped, the indexer rebuilds from disk. If the JSON files are
 * wiped, the indexer tombstones the rows.
 */
import type { Migration } from '../migrations'

export const migration004JobIndex: Migration = {
  version: 4,
  name: 'job-index-v1',
  up(db) {
    db.exec(`
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

        -- Derived: COALESCE(last_event_at_ms, requested_at_ms). Populated by
        -- the indexer so default "recent" list views can sort on a single
        -- indexed column without a COALESCE-at-query-time index miss.
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

      -- Default list sort: most recent activity first. The partial variant
      -- lets the planner do an index-only scan for the hot dashboard query
      -- (live jobs, sorted by activity, LIMIT N) with no temp b-tree sort.
      CREATE INDEX idx_ji_activity      ON job_index(last_activity_at_ms DESC);
      CREATE INDEX idx_ji_ws_activity   ON job_index(workspace_id, last_activity_at_ms DESC);
      CREATE INDEX idx_ji_live_activity ON job_index(last_activity_at_ms DESC) WHERE deleted_at IS NULL;
      -- Still useful for "jobs that started in the last hour" style queries.
      CREATE INDEX idx_ji_requested   ON job_index(requested_at_ms DESC);
      CREATE INDEX idx_ji_provider    ON job_index(provider, status);
      CREATE INDEX idx_ji_status      ON job_index(status);
      CREATE INDEX idx_ji_card        ON job_index(card_id) WHERE card_id IS NOT NULL;
      CREATE INDEX idx_ji_live        ON job_index(deleted_at) WHERE deleted_at IS NULL;

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
    `)
  },
}
