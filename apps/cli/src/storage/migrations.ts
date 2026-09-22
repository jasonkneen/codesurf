import type { SQLiteDatabase } from "./db";

const LATEST_DB_VERSION = 5;

export function applyMigrations(db: SQLiteDatabase): void {
  const version = Number(db.pragma("user_version", { simple: true })) || 0;

  const migrate = db.transaction(() => {
    if (version < 1) {
      createInitialSchema(db);
      db.pragma("user_version = 1");
    }
    if (version < 2) {
      createCompactionSchema(db);
      db.pragma("user_version = 2");
    }
    if (version < 3) {
      createSessionRecapSchema(db);
      db.pragma("user_version = 3");
    }
    if (version < 4) {
      createTraceSchema(db);
      db.pragma("user_version = 4");
    }
    if (version < 5) {
      createPromptHistorySchema(db);
      db.pragma(`user_version = ${LATEST_DB_VERSION}`);
    }

    ensureLatestSchema(db);
  });

  migrate();
}

function createInitialSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      canonical_path TEXT NOT NULL,
      git_root TEXT,
      display_name TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT,
      recap_text TEXT,
      recap_model TEXT,
      recap_updated_at TEXT,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      cwd_at_start TEXT NOT NULL,
      cwd_last TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(session_id, tool_call_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tool_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_call_row_id INTEGER NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      output_kind TEXT NOT NULL,
      output_json TEXT NOT NULL,
      success INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_seq INTEGER,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      first_kept_seq INTEGER NOT NULL,
      summary TEXT NOT NULL,
      tokens_before INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated
      ON sessions(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq
      ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session_seq
      ON tool_calls(session_id, message_seq);
    CREATE INDEX IF NOT EXISTS idx_usage_events_session_created
      ON usage_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compactions_session_created
      ON compactions(session_id, created_at DESC);
  `);
}

function createCompactionSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      first_kept_seq INTEGER NOT NULL,
      summary TEXT NOT NULL,
      tokens_before INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_compactions_session_created
      ON compactions(session_id, created_at DESC);
  `);
}

function createSessionRecapSchema(db: SQLiteDatabase): void {
  addColumnIfMissing(db, "sessions", "recap_text", "TEXT");
  addColumnIfMissing(db, "sessions", "recap_model", "TEXT");
  addColumnIfMissing(db, "sessions", "recap_updated_at", "TEXT");
}

function createTraceSchema(db: SQLiteDatabase): void {
  // Learning-loop trace store. One `traces` row per completed agent turn,
  // with ordered `trace_steps` capturing each generate/tool-call/result.
  // `outcome` is auto-derived from turn completion (success/failure/cancelled);
  // `feedback` is an optional [0,1] score set later via /feedback. Downstream
  // routing/mining read from these tables — see src/storage/traces.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_seq INTEGER,
      query TEXT NOT NULL,
      agent_mode TEXT,
      model TEXT NOT NULL,
      query_class TEXT,
      result TEXT,
      outcome TEXT,
      feedback REAL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_latency_ms INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS trace_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      tool_name TEXT,
      input_json TEXT,
      output_json TEXT,
      success INTEGER,
      duration_ms INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_traces_session_started
      ON traces(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_traces_outcome
      ON traces(outcome, query_class);
    CREATE INDEX IF NOT EXISTS idx_trace_steps_trace
      ON trace_steps(trace_id, step_index);
  `);
}

function createPromptHistorySchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_prompt_history_workspace_created
      ON prompt_history(workspace_id, created_at);
  `);
}

function ensureLatestSchema(db: SQLiteDatabase): void {
  createSessionRecapSchema(db);
  createTraceSchema(db);
  createPromptHistorySchema(db);
}

function addColumnIfMissing(db: SQLiteDatabase, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}
