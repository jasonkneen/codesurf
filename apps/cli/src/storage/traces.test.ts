import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "./db";
import { SessionStore } from "./sessions";
import { getTrace, listTraceSteps, listTraces, recordTrace, setFeedback, setOutcome } from "./traces";

// Runs under `bun test` (needs bun:sqlite). Isolated via CODESURF_HOME so it
// never touches the real ~/.codesurf/terminal.db.
describe("trace store", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-trace-tests");
  let tempHome = "";
  let tempCwd = "";
  let sessionId = "";
  const originalCodesurfHome = process.env.CODESURF_HOME;

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "home-"));
    tempCwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    process.env.CODESURF_HOME = tempHome;
    closeDatabase();
    sessionId = new SessionStore(tempCwd).createSession("test-model", "agent", tempCwd).id;
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("records a trace with steps and reads it back", () => {
    recordTrace({
      traceId: "t1",
      sessionId,
      query: "fix the bug",
      model: "test-model",
      agentMode: "agent",
      queryClass: "code",
      result: "done",
      outcome: "success",
      totalTokens: 1234,
      totalLatencyMs: 5000,
      steps: [
        { stepIndex: 0, stepType: "generate", output: { text: "thinking" }, durationMs: 1200 },
        {
          stepIndex: 1,
          stepType: "tool_call",
          toolName: "bash",
          input: { cmd: "ls" },
          output: "files",
          success: true,
          durationMs: 300,
          metadata: { skill: "demo" },
        },
      ],
    });

    const t = getTrace("t1");
    expect(t).not.toBeNull();
    expect(t?.query).toBe("fix the bug");
    expect(t?.outcome).toBe("success");
    expect(t?.queryClass).toBe("code");
    expect(t?.totalTokens).toBe(1234);
    expect(t?.totalLatencyMs).toBe(5000);
    expect(t?.stepCount).toBe(2);

    const steps = listTraceSteps("t1");
    expect(steps).toHaveLength(2);
    expect(steps[0].stepType).toBe("generate");
    expect(steps[1].toolName).toBe("bash");
    expect(steps[1].input).toEqual({ cmd: "ls" });
    expect(steps[1].output).toBe("files");
    expect(steps[1].success).toBe(true);
    expect(steps[1].metadata).toEqual({ skill: "demo" });
  });

  it("filters by outcome and minFeedback", () => {
    recordTrace({ traceId: "a", sessionId, query: "q1", model: "m", outcome: "success" });
    recordTrace({ traceId: "b", sessionId, query: "q2", model: "m", outcome: "failure" });
    recordTrace({ traceId: "c", sessionId, query: "q3", model: "m", outcome: "success" });
    setFeedback("c", 0.9);
    setFeedback("a", 0.2);

    expect(
      listTraces({ outcome: "success" })
        .map((t) => t.traceId)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(listTraces({ minFeedback: 0.5 }).map((t) => t.traceId)).toEqual(["c"]);
  });

  it("clamps feedback to [0,1] and allows outcome override", () => {
    recordTrace({ traceId: "x", sessionId, query: "q", model: "m" });
    setFeedback("x", 5);
    expect(getTrace("x")?.feedback).toBe(1);
    setFeedback("x", -2);
    expect(getTrace("x")?.feedback).toBe(0);
    setOutcome("x", "failure");
    expect(getTrace("x")?.outcome).toBe("failure");
  });

  it("is idempotent on trace_id (re-record replaces steps)", () => {
    recordTrace({
      traceId: "dup",
      sessionId,
      query: "q",
      model: "m",
      steps: [{ stepIndex: 0, stepType: "generate" }],
    });
    recordTrace({
      traceId: "dup",
      sessionId,
      query: "q",
      model: "m",
      steps: [
        { stepIndex: 0, stepType: "generate" },
        { stepIndex: 1, stepType: "result" },
      ],
    });
    expect(listTraceSteps("dup")).toHaveLength(2);
    expect(getTrace("dup")?.stepCount).toBe(2);
  });
});
