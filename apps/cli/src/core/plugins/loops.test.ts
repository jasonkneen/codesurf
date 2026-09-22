import { describe, expect, it } from "vitest";
import { createLoopManager } from "./loops";

describe("createLoopManager", () => {
  it("starts a new loop at iteration 1, running", () => {
    const loops = createLoopManager();
    const res = loops.start("alpha", 5, "Ship the thing");
    expect(res.started).toBe(true);
    expect(res.state.status).toBe("running");
    expect(res.state.currentIteration).toBe(1);
    expect(res.state.spec.maxIterations).toBe(5);
    expect(res.state.spec.goal).toBe("Ship the thing");
    expect(loops.getActive()?.spec.name).toBe("alpha");
  });

  it("resuming a STOPPED loop preserves iteration and history", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.record("alpha", { status: "passed", summary: "first pass" });
    void loops.advance("alpha");
    loops.stop("alpha");

    const resumed = loops.start("alpha");
    expect(resumed.message).toContain("resumed");
    expect(resumed.state.currentIteration).toBe(2);
    expect(resumed.state.history).toHaveLength(1);
    expect(resumed.state.history[0]?.summary).toBe("first pass");
  });

  it("restarting a COMPLETE loop resets iteration and history", () => {
    const loops = createLoopManager();
    loops.start("alpha", 2, "goal");
    loops.record("alpha", { status: "complete", summary: "done" });
    expect(loops.get("alpha")?.status).toBe("complete");

    const fresh = loops.start("alpha");
    expect(fresh.message).toContain("started");
    expect(fresh.state.currentIteration).toBe(1);
    expect(fresh.state.history).toHaveLength(0);
  });

  it("advance is a no-op for unknown and non-running loops", async () => {
    const loops = createLoopManager();
    const unknown = await loops.advance("ghost");
    expect(unknown.advanced).toBe(false);
    expect(unknown.state).toBeUndefined();

    loops.start("alpha", 5, "goal");
    loops.stop("alpha");
    const stopped = await loops.advance("alpha");
    expect(stopped.advanced).toBe(false);
    expect(loops.get("alpha")?.currentIteration).toBe(1);
  });

  it("advance completes the loop only after the last budgeted iteration ran", async () => {
    const loops = createLoopManager();
    loops.start("alpha", 2, "goal");
    // Iteration 1 finished → iteration 2 runs; the budget is not spent yet.
    const second = await loops.advance("alpha");
    expect(second.advanced).toBe(true);
    expect(second.state?.status).toBe("running");
    expect(second.state?.currentIteration).toBe(2);
    // Iteration 2 finished → budget spent.
    const done = await loops.advance("alpha");
    expect(done.advanced).toBe(true);
    expect(done.state?.status).toBe("complete");
    expect(done.state?.currentIteration).toBe(2);
    expect(loops.getActive()).toBeNull();
  });

  it("a budget of N runs exactly N iterations", async () => {
    for (const budget of [1, 2, 3, 5]) {
      const loops = createLoopManager();
      loops.start("alpha", budget, "goal");
      let ran = 0;
      while (loops.get("alpha")?.status === "running") {
        ran += 1;
        await loops.advance("alpha");
        if (ran > budget + 1) break;
      }
      expect(ran).toBe(budget);
    }
  });

  it("record appends history with the current iteration and stamps a timestamp", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    const res = loops.record("alpha", { status: "failed", summary: "gap", verificationNotes: "tests red" });
    expect(res.ok).toBe(true);
    const entry = loops.get("alpha")?.history[0];
    expect(entry?.iteration).toBe(1);
    expect(entry?.status).toBe("failed");
    expect(entry?.verificationNotes).toBe("tests red");
    expect(typeof entry?.startedAt).toBe("string");
  });

  it("record with status complete ends the loop", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.record("alpha", { status: "complete" });
    expect(loops.get("alpha")?.status).toBe("complete");
    expect(loops.getActive()).toBeNull();
  });

  it("record on an unknown loop fails without creating one", () => {
    const loops = createLoopManager();
    const res = loops.record("ghost", { status: "passed" });
    expect(res.ok).toBe(false);
    expect(loops.get("ghost")).toBeNull();
  });

  it("stop without a name stops the running loop; with a name targets that loop", () => {
    const loops = createLoopManager();
    expect(loops.stop().stopped).toBe(false);
    loops.start("alpha", 5, "goal");
    expect(loops.stop().stopped).toBe(true);
    expect(loops.get("alpha")?.status).toBe("stopped");
    expect(loops.stop("ghost").stopped).toBe(false);
  });

  it("start without explicit maxIterations does not reset a previously-set budget", () => {
    const loops = createLoopManager();
    loops.start("alpha", 7, "goal");
    loops.stop("alpha");
    const resumed = loops.start("alpha");
    expect(resumed.state.spec.maxIterations).toBe(7);
  });

  it("setSpec preserves runtime state for an existing loop", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.record("alpha", { status: "passed" });
    const spec = { ...loops.get("alpha")!.spec, goal: "new goal" };
    loops.setSpec(spec);
    const state = loops.get("alpha");
    expect(state?.spec.goal).toBe("new goal");
    expect(state?.history).toHaveLength(1);
    expect(state?.status).toBe("running");
  });

  it("noteUsage accumulates pendingTokens on the running loop", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.noteUsage(100);
    loops.noteUsage(250);
    expect(loops.get("alpha")?.pendingTokens).toBe(350);
  });

  it("noteUsage is a no-op when no loop is running", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.stop("alpha");
    loops.noteUsage(500);
    expect(loops.get("alpha")?.pendingTokens ?? 0).toBe(0);
  });

  it("record folds pendingTokens into tokensUsed and resets pendingTokens", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.noteUsage(400);
    loops.noteUsage(600);
    loops.record("alpha", { status: "passed", summary: "ok" });
    const entry = loops.get("alpha")?.history[0];
    expect(entry?.tokensUsed).toBe(1000);
    expect(loops.get("alpha")?.pendingTokens).toBe(0);
  });

  it("record with no pendingTokens sets tokensUsed to 0", () => {
    const loops = createLoopManager();
    loops.start("alpha", 5, "goal");
    loops.record("alpha", { status: "passed" });
    const entry = loops.get("alpha")?.history[0];
    expect(entry?.tokensUsed).toBe(0);
  });
});
