import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "../storage/db";
import { listUnreviewedIssues, recordIssue, type StoredIssue } from "../storage/issues";
import { groupIssues, normalizeMessage, renderReviewReport, reviewReportPath, runIssueReview } from "./issue-reviewer";

function issue(overrides: Partial<StoredIssue>): StoredIssue {
  return {
    id: 1,
    source: "relay.host",
    message: "unknown session sess-1",
    context: null,
    sessionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewedAt: null,
    ...overrides,
  };
}

describe("normalizeMessage", () => {
  it("collapses session ids so repeats of the same failure share a pattern", () => {
    expect(normalizeMessage("unknown session sess-3")).toBe(normalizeMessage("unknown session sess-42"));
  });
});

describe("groupIssues", () => {
  it("groups by source + normalized message, most frequent first", () => {
    const groups = groupIssues([
      issue({ id: 1, message: "unknown session sess-1", createdAt: "2026-01-01T00:00:00.000Z" }),
      issue({ id: 2, message: "unknown session sess-2", createdAt: "2026-01-01T00:05:00.000Z" }),
      issue({ id: 3, source: "relay.session-stream", message: "boom", createdAt: "2026-01-01T00:06:00.000Z" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      source: "relay.host",
      count: 2,
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:05:00.000Z",
      ids: [1, 2],
    });
    expect(groups[1]).toMatchObject({ source: "relay.session-stream", count: 1 });
  });

  it("returns an empty array for no issues", () => {
    expect(groupIssues([])).toEqual([]);
  });
});

describe("renderReviewReport", () => {
  it("renders nothing for an empty group list", () => {
    expect(renderReviewReport([], "2026-01-01T00:00:00.000Z")).toBe("");
  });

  it("renders a counted line per group", () => {
    const report = renderReviewReport(groupIssues([issue({}), issue({ id: 2 })]), "2026-01-01T00:00:00.000Z");
    expect(report).toContain("Issue review — 2026-01-01T00:00:00.000Z");
    expect(report).toContain("relay.host");
    expect(report).toContain("2x");
  });
});

describe("runIssueReview", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-issue-reviewer-tests");
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

  it("is a no-op when there's nothing unreviewed", () => {
    expect(runIssueReview(tempHome)).toEqual([]);
    expect(fs.existsSync(reviewReportPath(tempHome))).toBe(false);
  });

  it("drains the backlog, writes a report, and marks issues reviewed", () => {
    recordIssue({ source: "relay.host", message: "unknown session sess-1" });
    recordIssue({ source: "relay.host", message: "unknown session sess-2" });

    const groups = runIssueReview(tempHome);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(fs.readFileSync(reviewReportPath(tempHome), "utf8")).toContain("relay.host");
    expect(listUnreviewedIssues()).toEqual([]);
  });

  it("appends rather than overwrites across runs", () => {
    recordIssue({ source: "a", message: "first" });
    runIssueReview(tempHome);
    recordIssue({ source: "a", message: "second" });
    runIssueReview(tempHome);

    const content = fs.readFileSync(reviewReportPath(tempHome), "utf8");
    expect(content).toContain("first");
    expect(content).toContain("second");
  });
});
