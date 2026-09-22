/**
 * Migration 005 - provider rate-limit snapshot index.
 *
 * Pointer + overlay pattern (mirrors migration 004):
 *   ~/.codesurf/usage/<provider>.json   - canonical snapshot, agent-writable
 *   provider_rate_limits_index        - fast index row pointing at the file
 *
 * One row per provider. The JSON file holds the full last-known
 * `account.rate-limits.updated` payload exactly as the agent emits it (Codex
 * 5h+Weekly, Claude five_hour/seven_day, etc.). The SQLite row carries only
 * the fields the renderer needs to filter/sort quickly without parsing JSON
 * for every status-bar render.
 *
 * If the DB is wiped, the indexer rebuilds rows from the JSON files.
 * If the JSON files are wiped, the rows tombstone themselves.
 */
import type { Migration } from '../migrations'

const SCHEMA_SQL = [
  `CREATE TABLE provider_rate_limits_index (
    provider             TEXT PRIMARY KEY,
    device_id            TEXT NOT NULL,
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    file_path            TEXT NOT NULL,
    primary_window       TEXT,
    primary_used_pct     REAL,
    primary_resets_at    TEXT,
    secondary_window     TEXT,
    secondary_used_pct   REAL,
    secondary_resets_at  TEXT,
    status               TEXT,
    source               TEXT NOT NULL,
    source_mtime_ms      INTEGER NOT NULL DEFAULT 0,
    source_size_bytes    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX idx_prl_primary_used    ON provider_rate_limits_index(primary_used_pct DESC)`,
  `CREATE INDEX idx_prl_secondary_used  ON provider_rate_limits_index(secondary_used_pct DESC)`,
  `CREATE INDEX idx_prl_resets_primary  ON provider_rate_limits_index(primary_resets_at)   WHERE primary_resets_at   IS NOT NULL`,
  `CREATE INDEX idx_prl_resets_secondary ON provider_rate_limits_index(secondary_resets_at) WHERE secondary_resets_at IS NOT NULL`,
]

export const migration005ProviderRateLimits: Migration = {
  version: 5,
  name: 'provider-rate-limits-v1',
  up(db) {
    for (const statement of SCHEMA_SQL) {
      db.prepare(statement).run()
    }
  },
}
