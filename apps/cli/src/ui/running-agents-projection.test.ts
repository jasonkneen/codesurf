// The live running-subagents popup renders through the same ParallelAgents
// widget the showcase tours, so this pins the row -> widget projection.

import { describe, expect, it } from "vitest";
import { makeExampleRunningAgentRows, runningAgentRowsToParallelAgents } from "./running-agents";

describe("runningAgentRowsToParallelAgents", () => {
  const now = Date.now();

  it("projects every row onto a step, preserving order and identity", () => {
    const rows = makeExampleRunningAgentRows();
    const run = runningAgentRowsToParallelAgents(rows, now);
    expect(run.steps.map((s) => s.id)).toEqual(rows.map((r) => r.id));
    expect(run.steps.map((s) => s.agent)).toEqual(rows.map((r) => r.agent));
  });

  it("maps delegation status onto the widget's step status vocabulary", () => {
    const run = runningAgentRowsToParallelAgents(makeExampleRunningAgentRows(), now);
    expect(run.steps[0].status).toBe("running");
    expect(run.steps[2].status).toBe("done");
  });

  it("counts only running agents in the progress label", () => {
    const run = runningAgentRowsToParallelAgents(makeExampleRunningAgentRows(), now);
    expect(run.progressLabel).toBe("2/3 running");
    expect(run.summary).toBe("2 running / 3 total");
  });

  it("surfaces the inline scratch-pad line and leaves delegations without detail", () => {
    const run = runningAgentRowsToParallelAgents(makeExampleRunningAgentRows(), now);
    expect(run.steps[0].detailLines).toEqual(["grep: src/core/plugins/builtin/transports"]);
    expect(run.steps[1].detailLines).toBeUndefined();
  });

  it("renders an empty run without a summary rather than a bogus 0/0 label", () => {
    const run = runningAgentRowsToParallelAgents([], now);
    expect(run.steps).toEqual([]);
    expect(run.summary).toBeUndefined();
    expect(run.progressLabel).toBe("0/0 running");
  });
});
