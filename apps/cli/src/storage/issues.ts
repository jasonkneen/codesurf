// Durable app-level issue log.
//
// Today, errors like "unknown session" (src/relay/host.ts, src/relay/session-
// stream.ts) surface once to a UI observer and then vanish — nothing persists
// them, so there's no way to see how often they happen or spot a pattern.
// `recordIssue` gives call sites a one-line, never-throws way to log an error
// durably; `src/daemon/issue-reviewer.ts` periodically reads the unreviewed
// backlog, groups it into patterns, and writes a human-readable summary so
// recurring problems get noticed instead of re-discovered from scratch.
import { getDatabase, withTransaction } from "./db";

export interface IssueInput {
  /** Where this came from, e.g. "relay.host", "relay.session-stream", "ui.resume". */
  source: string;
  message: string;
  /** Extra structured detail (session id, stack, args). Stored as JSON, best-effort. */
  context?: unknown;
  sessionId?: string | null;
}

export interface StoredIssue {
  id: number;
  source: string;
  message: string;
  context: unknown;
  sessionId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

interface IssueRow {
  id: number;
  source: string;
  message: string;
  context_json: string | null;
  session_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fromJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fromRow(row: IssueRow): StoredIssue {
  return {
    id: row.id,
    source: row.source,
    message: row.message,
    context: fromJson(row.context_json),
    sessionId: row.session_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/**
 * Record an issue. Best-effort and never throws — a broken issue log must
 * never be the reason a caller's real error handling fails, matching the
 * philosophy of writeCrashLog (src/utils/process-guards.ts).
 */
export function recordIssue(input: IssueInput): void {
  try {
    withTransaction((db) => {
      db.prepare(`
        INSERT INTO issues (source, message, context_json, session_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.source, input.message, toJson(input.context), input.sessionId ?? null, new Date().toISOString());
    });
  } catch {
    /* best-effort; issue logging must never break the caller */
  }
}

/** Issues not yet folded into a background review summary, oldest first. */
export function listUnreviewedIssues(limit = 500): StoredIssue[] {
  const rows = getDatabase()
    .prepare(`
      SELECT id, source, message, context_json, session_id, created_at, reviewed_at
      FROM issues
      WHERE reviewed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .all(limit) as IssueRow[];
  return rows.map(fromRow);
}

/** Mark a batch of issues as folded into a review summary. */
export function markIssuesReviewed(ids: number[]): void {
  if (ids.length === 0) return;
  withTransaction((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`UPDATE issues SET reviewed_at = ? WHERE id = ?`);
    for (const id of ids) stmt.run(now, id);
  });
}
