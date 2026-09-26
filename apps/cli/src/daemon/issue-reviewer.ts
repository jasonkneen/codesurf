// Background issue reviewer.
//
// src/storage/issues.ts gives call sites a durable place to log app-level
// errors (e.g. "unknown session" from src/relay/host.ts). On its own that's
// just a growing table nobody reads. This module is the "reviewing... in the
// background so we can learn and fix" half: periodically drain the unreviewed
// backlog, collapse repeats of the same failure into one counted pattern, and
// append a plain-markdown summary to ~/.codesurf/issues/review.md — something
// a human or an agent can skim to notice "unknown session has fired 40 times
// today" instead of that fact being invisible.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultCodesurfHome } from "@codesurf/daemon";
import { listUnreviewedIssues, markIssuesReviewed, type StoredIssue } from "../storage/issues";

export interface IssueGroup {
  source: string;
  pattern: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleContext: unknown;
  ids: number[];
}

/**
 * Collapse volatile identifiers out of a message so repeats of the same
 * underlying failure (e.g. "unknown session sess-3", "unknown session
 * sess-42") group into one pattern instead of one row each.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\bsess-\d+\b/gi, "<id>")
    .replace(/[0-9a-f]{6,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Group issues by (source, normalized message), most frequent first. */
export function groupIssues(issues: StoredIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const pattern = normalizeMessage(issue.message);
    const key = `${issue.source}::${pattern}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = issue.createdAt;
      existing.ids.push(issue.id);
    } else {
      groups.set(key, {
        source: issue.source,
        pattern,
        count: 1,
        firstSeen: issue.createdAt,
        lastSeen: issue.createdAt,
        sampleContext: issue.context,
        ids: [issue.id],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Render a batch of groups as a markdown section. Empty input -> empty string. */
export function renderReviewReport(groups: IssueGroup[], reviewedAt: string): string {
  if (groups.length === 0) return "";
  const lines = [`## Issue review — ${reviewedAt}`, ""];
  for (const g of groups) {
    const times = g.count === 1 ? "once" : `${g.count}x`;
    lines.push(`- **${g.source}**: ${g.pattern} — ${times} (first ${g.firstSeen}, last ${g.lastSeen})`);
  }
  lines.push("", "");
  return lines.join("\n");
}

export function reviewReportPath(homeDir: string = defaultCodesurfHome()): string {
  return join(homeDir, "issues", "review.md");
}

/**
 * Read the unreviewed issue backlog, group it into patterns, append a summary
 * to `<home>/issues/review.md`, and mark those issues reviewed so the next
 * run only picks up what's new. Best-effort and never throws — a broken
 * reviewer must not take down the daemon it runs inside.
 */
export function runIssueReview(homeDir: string = defaultCodesurfHome()): IssueGroup[] {
  try {
    const issues = listUnreviewedIssues();
    if (issues.length === 0) return [];
    const groups = groupIssues(issues);
    mkdirSync(join(homeDir, "issues"), { recursive: true });
    appendFileSync(reviewReportPath(homeDir), renderReviewReport(groups, new Date().toISOString()));
    markIssuesReviewed(issues.map((i) => i.id));
    return groups;
  } catch {
    return [];
  }
}

/** Start a periodic reviewer. Returns a stop function. Default: every 10 min. */
export function startIssueReviewer(intervalMs = 10 * 60_000): () => void {
  const timer = setInterval(() => runIssueReview(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
