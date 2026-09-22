// Prompt history storage — persists submitted prompts per workspace so the
// TUI can offer shell-style Up/Down recall across sessions.
//
// Design notes:
// - Raw pre-expansion text is stored (what the user typed, before
//   @mention/@paste-block expansion). This means recall restores exactly
//   what the user wrote, not the expanded form.
// - Consecutive-dedup: if the submitted text is identical to the most recent
//   entry for this workspace, no new row is inserted. This mirrors zsh's
//   HIST_IGNORE_DUPS policy.
// - Workspace-scoped: history is per git-root (or cwd when not in a repo),
//   matching the workspace identity established by ensureWorkspace().

import { getDatabase } from "./db";

export interface RecordPromptOptions {
  workspaceId: string;
  sessionId?: string | null;
  text: string;
}

/** Store a submitted prompt. No-ops if text is identical to the most recent
 *  entry for this workspace (consecutive-dedup). */
export function recordPrompt(options: RecordPromptOptions): void {
  const { workspaceId, sessionId, text } = options;
  if (!text.trim()) return;

  const db = getDatabase();

  // Consecutive-dedup check.
  const latest = db
    .prepare(
      `SELECT text FROM prompt_history
       WHERE workspace_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(workspaceId) as { text: string } | undefined;

  if (latest?.text === text) return;

  db.prepare(
    `INSERT INTO prompt_history (workspace_id, session_id, text, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(workspaceId, sessionId ?? null, text, Date.now());
}

/** Load the most recent `limit` prompts for a workspace, in ascending
 *  chronological order (oldest first, newest last). Returns an empty array
 *  when no history exists. */
export function loadPromptHistory(workspaceId: string, limit = 200): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT text FROM (
         SELECT text, created_at, id
         FROM prompt_history
         WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, id ASC`,
    )
    .all(workspaceId, limit) as Array<{ text: string }>;

  return rows.map((r) => r.text);
}
