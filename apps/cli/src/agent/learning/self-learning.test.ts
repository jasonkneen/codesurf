import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../storage/db";
import { recordTrace, SessionStore } from "../../storage/index";
import {
  buildLearningPromptNotes,
  isDevConversationLoggingEnabled,
  maybeRefreshLearningArtifacts,
} from "./self-learning";
import { optimizeSkillsFromTraces } from "./skill-optimizer";

// The optimizer is the expensive full-store rescan; counting its calls is how
// the watermark tests observe "a refresh happened" (and that none happened).
vi.mock("./skill-optimizer", () => ({ optimizeSkillsFromTraces: vi.fn(() => []) }));

const originalDevLogs = process.env.CODESURF_DEV_CONVERSATION_LOGS;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalDevLogs === undefined) delete process.env.CODESURF_DEV_CONVERSATION_LOGS;
  else process.env.CODESURF_DEV_CONVERSATION_LOGS = originalDevLogs;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("maybeRefreshLearningArtifacts watermark (A7)", () => {
  const originalHome = process.env.CODESURF_HOME;
  let home = "";
  let cwd = "";
  let sessionId = "";
  let seq = 0;

  const refreshCount = () => vi.mocked(optimizeSkillsFromTraces).mock.calls.length;
  const refresh = () => maybeRefreshLearningArtifacts({ cwd });
  const openStore = () => {
    closeDatabase();
    sessionId = new SessionStore(cwd).createSession("m", "agent", cwd).id;
  };
  /** Record `n` traces with strictly increasing, deterministic start times. */
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      seq++;
      recordTrace({
        traceId: `t${seq}`,
        sessionId,
        query: `query ${seq}`,
        model: "m",
        result: `result ${seq}`,
        outcome: "success",
        startedAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
      });
    }
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-learning-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-learning-proj-"));
    process.env.CODESURF_HOME = home;
    seq = 0;
    vi.mocked(optimizeSkillsFromTraces).mockClear();
    openStore();
  });

  afterEach(() => {
    closeDatabase();
    if (originalHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refreshes once for a new store and not again while history is unchanged", () => {
    seed(3);
    refresh();
    expect(refreshCount()).toBe(1);
    refresh();
    refresh();
    expect(refreshCount()).toBe(1);
  });

  it("refreshes again only after MIN_NEW_TRACES new traces", () => {
    seed(3);
    refresh();
    seed(7);
    refresh();
    expect(refreshCount()).toBe(1);
    seed(1);
    refresh();
    expect(refreshCount()).toBe(2);
  });

  it("keeps refreshing at the same cadence after the 200-trace window saturates", () => {
    seed(230);
    refresh();
    expect(refreshCount()).toBe(1);

    // The window is full: its length can never move again. Newer traces keep
    // replacing older ones, and each batch of 8 must still trigger exactly one refresh.
    for (let batch = 1; batch <= 3; batch++) {
      seed(7);
      refresh();
      expect(refreshCount()).toBe(batch);
      seed(1);
      refresh();
      expect(refreshCount()).toBe(batch + 1);
    }
  });

  it("re-anchors when the trace store is deleted, even if the new traces are older than the watermark", () => {
    seed(10);
    refresh();
    expect(refreshCount()).toBe(1);

    closeDatabase();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(path.join(home, `terminal.db${suffix}`), { force: true });
    }
    seq = 0;
    openStore();
    seed(3);
    refresh();
    expect(refreshCount()).toBe(2);
  });

  it("treats a legacy count-only state file as no watermark", () => {
    fs.mkdirSync(path.join(home, "learning"), { recursive: true });
    fs.writeFileSync(path.join(home, "learning", "state.json"), JSON.stringify({ lastTraceCount: 3 }));
    seed(3);
    refresh();
    expect(refreshCount()).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(home, "learning", "state.json"), "utf8")) as {
      lastTraceId?: string;
    };
    expect(state.lastTraceId).toBe("t3");
  });
});

describe("self-learning", () => {
  it("builds prompt-visible notes from recent trace outcomes and tools", () => {
    const notes = buildLearningPromptNotes(
      [
        {
          traceId: "a",
          queryClass: "code",
          outcome: "success",
          feedback: 1,
          model: "grok-4.3",
          totalLatencyMs: 10,
        },
        {
          traceId: "b",
          queryClass: "code",
          outcome: "failure",
          feedback: 0.2,
          model: "grok-4.3",
          totalLatencyMs: 20,
        },
      ],
      [["grep", "read_file", "edit_file"]],
    );

    expect(notes).toContain("Generated from local CodeSurf traces");
    expect(notes).toContain("success 1/2 (50%)");
    expect(notes).toContain("Query classes with recent failures: code (1)");
    expect(notes).toContain("Tools common in successful traces: edit_file (1), grep (1), read_file (1)");
  });

  it("keeps cancelled traces out of failure-rate aggregation", () => {
    const notes = buildLearningPromptNotes(
      [
        {
          traceId: "a",
          queryClass: "code",
          outcome: "success",
          feedback: null,
          model: "grok-4.3",
          totalLatencyMs: 10,
        },
        {
          traceId: "b",
          queryClass: "code",
          outcome: "failure",
          feedback: null,
          model: "grok-4.3",
          totalLatencyMs: 20,
        },
        {
          traceId: "c",
          queryClass: "code",
          outcome: "cancelled",
          feedback: null,
          model: "grok-4.3",
          totalLatencyMs: 30,
        },
      ],
      [],
    );

    expect(notes).toContain("completed 2; success 1/2 (50%), failure 1/2; cancelled 1.");
  });

  it("lets dev conversation logging be explicitly enabled or disabled", () => {
    process.env.CODESURF_DEV_CONVERSATION_LOGS = "1";
    expect(isDevConversationLoggingEnabled()).toBe(true);
    process.env.CODESURF_DEV_CONVERSATION_LOGS = "0";
    expect(isDevConversationLoggingEnabled()).toBe(false);
  });
});
