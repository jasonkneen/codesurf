import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonJobRecord, findLatestDaemonSessionIdForCard, repairSplitDaemonSessions } from "./session-repair";

let tempHome: string;

function writeJob(overrides: Partial<DaemonJobRecord> & { id: string; sessionId: string }): void {
  const dir = path.join(tempHome, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${overrides.id}.json`),
    `${JSON.stringify(
      {
        taskLabel: "split title",
        provider: "codex",
        model: "gpt-5.2",
        cardId: "codesurf-card-1",
        workspaceDir: "/repo",
        status: "done",
        requestedAt: "2026-05-04T10:00:00.000Z",
        updatedAt: "2026-05-04T10:00:00.000Z",
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeTimeline(jobId: string, sessionId: string): void {
  const dir = path.join(tempHome, "timelines");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${jobId}.jsonl`),
    [JSON.stringify({ type: "session", sessionId }), JSON.stringify({ type: "text", text: "ok" }), ""].join("\n"),
    "utf8",
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-session-repair-"));
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("repairSplitDaemonSessions", () => {
  it("patches split jobs and timelines to the newest session id", () => {
    writeJob({ id: "job-old", sessionId: "sess-old", updatedAt: "2026-05-04T10:00:00.000Z" });
    writeJob({ id: "job-new", sessionId: "sess-new", updatedAt: "2026-05-04T10:05:00.000Z" });
    writeTimeline("job-old", "sess-old");
    writeTimeline("job-new", "sess-new");

    const dryRun = repairSplitDaemonSessions({ homeDir: tempHome, dryRun: true, workspaceDir: "/repo" });
    expect(dryRun.groups).toHaveLength(1);
    expect(dryRun.groups[0]?.canonicalSessionId).toBe("sess-new");
    expect(dryRun.jobsPatched).toBe(1);
    expect(dryRun.timelinesPatched).toBe(1);
    expect(dryRun.failures).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(tempHome, "jobs", "job-old.json"), "utf8")).sessionId).toBe("sess-old");

    const repaired = repairSplitDaemonSessions({ homeDir: tempHome, workspaceDir: "/repo" });
    expect(repaired.groups).toHaveLength(1);
    expect(repaired.jobsPatched).toBe(1);
    expect(repaired.timelinesPatched).toBe(1);
    expect(repaired.failures).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(tempHome, "jobs", "job-old.json"), "utf8")).sessionId).toBe("sess-new");
    expect(fs.readFileSync(path.join(tempHome, "timelines", "job-old.jsonl"), "utf8")).toContain(
      '"sessionId":"sess-new"',
    );
  });

  it("uses card and workspace boundaries when finding repair candidates", () => {
    writeJob({ id: "job-a", sessionId: "sess-a", updatedAt: "2026-05-04T10:00:00.000Z" });
    writeJob({
      id: "job-b",
      sessionId: "sess-b",
      cardId: "codesurf-card-2",
      updatedAt: "2026-05-04T10:05:00.000Z",
    });
    writeJob({
      id: "job-c",
      sessionId: "sess-c",
      workspaceDir: "/other",
      updatedAt: "2026-05-04T10:10:00.000Z",
    });

    expect(repairSplitDaemonSessions({ homeDir: tempHome, workspaceDir: "/repo" }).groups).toHaveLength(0);
    expect(findLatestDaemonSessionIdForCard(tempHome, "codesurf-card-1", "/repo")).toBe("sess-a");
  });
});
