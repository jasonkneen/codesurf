import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

// Regression: `Agent.abort()` always raised the PROCESS-WIDE interrupt signals
// (`fireUserInterrupt()` and the `UserInterrupt` event). In multi-session
// `serve` / `node`, one HTTP client disconnecting aborted its own turn and, as
// a side effect, halted every other session's /loop and workflow scripts.
// A host-initiated abort now cancels only its own turn.

type Internals = {
  abortController: AbortController | null;
  fireHook: (input: { hook_event_name: string }) => Promise<unknown>;
};

async function newAgent() {
  vi.resetModules();
  const plugins = await import("./../core/plugins");
  const { onUserInterrupt } = await import("./../core/plugins/loader");
  plugins.setBashSink(buildMockBashSink().sink);
  const { Agent } = await import("./agent");
  const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });
  const internals = agent as unknown as Internals;
  const fireHook = vi.spyOn(internals, "fireHook").mockResolvedValue({} as never);
  const interrupted = vi.fn();
  const dispose = onUserInterrupt(interrupted);
  // A turn in flight.
  const controller = new AbortController();
  internals.abortController = controller;
  return { agent, controller, fireHook, interrupted, dispose };
}

const userInterruptCalls = (fireHook: ReturnType<typeof vi.fn>) =>
  fireHook.mock.calls.filter(([input]) => (input as { hook_event_name: string }).hook_event_name === "UserInterrupt");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Agent.abort", () => {
  it("a human abort cancels the turn and raises the process-wide interrupt", async () => {
    const { agent, controller, fireHook, interrupted, dispose } = await newAgent();

    agent.abort();

    expect(controller.signal.aborted).toBe(true);
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(userInterruptCalls(fireHook)).toHaveLength(1);
    dispose();
  });

  it("a host abort ({ userInitiated: false }) cancels only this turn", async () => {
    const { agent, controller, fireHook, interrupted, dispose } = await newAgent();

    agent.abort({ userInitiated: false });

    expect(controller.signal.aborted).toBe(true);
    expect(interrupted).not.toHaveBeenCalled();
    expect(userInterruptCalls(fireHook)).toHaveLength(0);
    dispose();
  });
});
