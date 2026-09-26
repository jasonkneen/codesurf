import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "./db";
import { listUnreviewedIssues, markIssuesReviewed, recordIssue } from "./issues";

// Runs under vitest via the bun:sqlite -> node:sqlite shim (see
// vitest.config.ts). Isolated via CODESURF_HOME so it never touches the
// developer's real ~/.codesurf/terminal.db.
describe("issue store", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-issue-tests");
  let tempHome = "";
  const originalCodesurfHome = process.env.CODESURF_HOME;

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "home-"));
    process.env.CODESURF_HOME = tempHome;
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("records an issue and lists it as unreviewed", () => {
    recordIssue({ source: "relay.host", message: "unknown session sess-3", sessionId: "sess-3" });

    const unreviewed = listUnreviewedIssues();
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toMatchObject({
      source: "relay.host",
      message: "unknown session sess-3",
      sessionId: "sess-3",
      reviewedAt: null,
    });
  });

  it("round-trips a context payload as JSON", () => {
    recordIssue({ source: "relay.session-stream", message: "boom", context: { retries: 2, ok: false } });

    const [issue] = listUnreviewedIssues();
    expect(issue.context).toEqual({ retries: 2, ok: false });
  });

  it("excludes reviewed issues from the unreviewed list", () => {
    recordIssue({ source: "a", message: "one" });
    recordIssue({ source: "a", message: "two" });
    const [first, second] = listUnreviewedIssues();

    markIssuesReviewed([first.id]);

    const remaining = listUnreviewedIssues();
    expect(remaining.map((i) => i.id)).toEqual([second.id]);
  });

  it("never throws, even if context can't be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => recordIssue({ source: "a", message: "b", context: circular })).not.toThrow();
    expect(listUnreviewedIssues()).toHaveLength(1);
  });
});
