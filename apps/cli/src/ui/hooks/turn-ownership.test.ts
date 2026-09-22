import { describe, expect, it, vi } from "vitest";
import { invalidateActiveRun, isRunStale, resolveTurnInput } from "./turn-ownership";

function makeRefs(activeRunId = 7) {
  return {
    activeRunIdRef: { current: activeRunId },
    interruptedRunIdRef: { current: null as number | null },
    cancelledRunIdsRef: { current: new Set<number>() },
  };
}

describe("invalidateActiveRun", () => {
  it("makes the current run stale, records it as interrupted and cancelled", () => {
    const refs = makeRefs(7);
    expect(isRunStale(refs.activeRunIdRef, 7)).toBe(false);

    expect(invalidateActiveRun(refs)).toBe(7);

    expect(isRunStale(refs.activeRunIdRef, 7)).toBe(true);
    expect(refs.interruptedRunIdRef.current).toBe(7);
    expect(refs.cancelledRunIdsRef.current.has(7)).toBe(true);
    // The next run claims a fresh id above the invalidated one.
    const nextRunId = ++refs.activeRunIdRef.current;
    expect(nextRunId).toBeGreaterThan(7);
    expect(isRunStale(refs.activeRunIdRef, nextRunId)).toBe(false);
  });

  it("tolerates callers that do not track cancelled runs", () => {
    const refs = { activeRunIdRef: { current: 3 }, interruptedRunIdRef: { current: null as number | null } };
    expect(invalidateActiveRun(refs)).toBe(3);
    expect(refs.activeRunIdRef.current).toBe(4);
  });
});

describe("resolveTurnInput", () => {
  it("never yields input for a run aborted while its preparation was pending", async () => {
    const refs = makeRefs(1);
    const runId = 1;
    const isStale = () => isRunStale(refs.activeRunIdRef, runId);
    let releasePrepare!: (text: string) => void;
    const prepareText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releasePrepare = resolve;
        }),
    );
    const agent = { processMessage: vi.fn() };

    const pending = resolveTurnInput({ text: "hello @file", isContinuation: false, prepareText, isStale }).then(
      (input) => {
        if (input !== null) agent.processMessage(input);
        return input;
      },
    );
    await vi.waitFor(() => expect(prepareText).toHaveBeenCalledTimes(1));

    // Ctrl+X while @file expansion is still running…
    invalidateActiveRun(refs);
    releasePrepare("hello <expanded file>");

    // …must not start the agent once the expansion resolves.
    await expect(pending).resolves.toBeNull();
    expect(agent.processMessage).not.toHaveBeenCalled();
  });

  it("returns the prepared text when the run still owns the turn", async () => {
    const refs = makeRefs(1);
    const isStale = () => isRunStale(refs.activeRunIdRef, 1);
    await expect(
      resolveTurnInput({ text: "hi", isContinuation: false, prepareText: async () => "hi expanded", isStale }),
    ).resolves.toBe("hi expanded");
    await expect(resolveTurnInput({ text: "hi", isContinuation: false, isStale })).resolves.toBe("hi");
    await expect(resolveTurnInput({ text: "", isContinuation: true, isStale })).resolves.toBe("");
  });

  it("refuses a continuation whose run was invalidated before it started", async () => {
    const refs = makeRefs(1);
    const isStale = () => isRunStale(refs.activeRunIdRef, 1);
    invalidateActiveRun(refs);
    await expect(resolveTurnInput({ text: "", isContinuation: true, isStale })).resolves.toBeNull();
  });
});
