// Edit-approval session state for the kernel `write_file` / `edit_file` tools.
//
// Holds two pieces of in-memory state that augment the persistent
// `editApproval` setting (loaded via `loadEditApprovalMode()`):
//
//   1. `sessionAcceptAll`     — set by the user when they choose "Accept all
//                                this session" in the approval panel. Resets
//                                on session change.
//   2. `sessionApprovedPaths` — absolute-path Set populated when the user
//                                chooses "Accept this path". Resets on
//                                session change.
//
// These live module-local because the file tools are the only consumer; no
// host-service plumbing is needed. The UI imports the mutator/reset functions
// directly from this module — the same shape as `setBashSink` / `setTelegramSink`
// exposed at the kernel boundary.
//
// `shouldAutoApproveEdit(absPath)` is the single decision function used by
// `needsApproval` inside `file-tools.ts`. It collapses the three policy
// inputs (persistent setting + session flag + per-path flag) into one bool.

import * as fs from "fs";
import { type EditApprovalMode, getUserSettingsPath, loadEditApprovalMode } from "../../../utils/settings";

let sessionAcceptAll = false;
const sessionApprovedPaths = new Set<string>();

// Memoized parse preflight: the statSync stays per-call (cheap, and how
// missing files and external edits are detected); only the redundant
// readFileSync+JSON.parse is skipped while the file is unchanged. Same
// mtime+size keying as the settings read cache in `utils/settings.ts`.
let preflightMemo: { path: string; mtimeMs: number; size: number; ok: boolean } | null = null;

function canReadAndParseUserSettings(settingsPath: string): boolean {
  try {
    const stat = fs.statSync(settingsPath);
    if (!stat.isFile()) return false;
    if (
      preflightMemo &&
      preflightMemo.path === settingsPath &&
      preflightMemo.mtimeMs === stat.mtimeMs &&
      preflightMemo.size === stat.size
    ) {
      return preflightMemo.ok;
    }
    let ok: boolean;
    try {
      JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      ok = true;
    } catch (error) {
      // Deleted between stat and read: same ENOENT contract as before, and
      // nothing to memoize against a stat that no longer describes a file.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      ok = false;
    }
    preflightMemo = { path: settingsPath, mtimeMs: stat.mtimeMs, size: stat.size, ok };
    return ok;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function shouldAutoApproveEditWithLoader(
  absolutePath: string,
  loadMode: () => EditApprovalMode,
  settingsPath = getUserSettingsPath(),
): boolean {
  if (sessionAcceptAll) return true;
  if (sessionApprovedPaths.has(absolutePath)) return true;
  if (!canReadAndParseUserSettings(settingsPath)) return false;
  try {
    return loadMode() === "accept-all";
  } catch {
    // Settings file unreadable or parser failed after the preflight — fail closed.
    return false;
  }
}

/** Returns true if a pending edit to `absolutePath` should bypass the
 *  approval prompt. Order of checks (cheapest first):
 *   - session-wide accept flag
 *   - per-path accept flag
 *   - persistent setting === "accept-all"
 *  Returns false otherwise (i.e. an approval prompt should fire). */
export function shouldAutoApproveEdit(absolutePath: string): boolean {
  return shouldAutoApproveEditWithLoader(absolutePath, loadEditApprovalMode);
}

/** Marks every subsequent edit in this process session as pre-approved.
 *  Resets via {@link resetEditApprovalSession}. */
export function markAcceptAllThisSession(): void {
  sessionAcceptAll = true;
}

/** Marks a specific absolute path as pre-approved for this session.
 *  Subsequent edits to the same path will skip the approval prompt. */
export function markPathApprovedThisSession(absolutePath: string): void {
  sessionApprovedPaths.add(absolutePath);
}

/** Clears all session-local state. Called from the host (app.tsx) when the
 *  user starts a new session, resumes a different one, or runs `/clear`. */
export function resetEditApprovalSession(): void {
  sessionAcceptAll = false;
  sessionApprovedPaths.clear();
}

/** Read-only snapshot for tests / `/edits status`. */
export function getEditApprovalSessionState(): {
  acceptAll: boolean;
  approvedPaths: string[];
} {
  return {
    acceptAll: sessionAcceptAll,
    approvedPaths: Array.from(sessionApprovedPaths).sort(),
  };
}
