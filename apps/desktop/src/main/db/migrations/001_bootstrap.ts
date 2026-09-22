/**
 * Migration 001 — bootstrap.
 *
 * Creates the always-present app-meta table used across all later phases.
 * Phase 0 intentionally does not create feature tables; later phases add
 * their own migrations (002_projects.ts, 003_threads.ts, etc.).
 */
import type { Migration } from '../migrations'

export const migration001Bootstrap: Migration = {
  version: 1,
  name: 'bootstrap',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  },
}
