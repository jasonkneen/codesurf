// Regression for review finding A9: `runVerify` must honour `Agent.abort()`
// (Esc) even when the caller supplied its own AbortSignal.
//
// Before: `abortSignal ?? this.abortController.signal` handed orchestration the
// EXTERNAL signal alone, so `Agent.abort()` aborted an unused controller and
// verification kept running; the finally's identity check then failed too,
// leaving that controller installed after completion. Now the run owns a
// controller that is composed with the external signal and cleared by
// controller identity.

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type VerifyInternals = {
  abortController: AbortController | null;
  messages: Array<{ role: string; content: unknown }>;
};

type VerifyResult = { success: boolean; output?: string; error?: string };

async function importAgentWithVerifyGate() {
  vi.resetModules();

  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  // Each orchestration call parks on its own gate and records the signal it
  // was handed — that signal is what the real orchestrator threads into the
  // verify sub-agent and checkpoint preparation.
  const gates: Array<ReturnType<typeof deferred<VerifyResult>>> = [];
  const signals: AbortSignal[] = [];
  const runVerifyOrchestration = vi.fn((_agent: unknown, options: { abortSignal?: AbortSignal } = {}) => {
    const gate = deferred<VerifyResult>();
    gates.push(gate);
    signals.push(options.abortSignal as AbortSignal);
    return gate.promise;
  });
  vi.doMock("../verify/orchestrator", () => ({ runVerifyOrchestration }));

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  const { Agent } = await import("./agent");
  const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });
  // Notifications are drained at the verify boundary; keep that off the disk.
  Object.assign(agent as object, { delegations: { consumeNotifications: async () => [] } });
  return { agent, internals: agent as unknown as VerifyInternals, gates, signals };
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink } = await import("../core/plugins");
    setBashSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../verify/orchestrator");
  vi.doUnmock("../storage/index");
});

describe("runVerify abort composition (A9)", () => {
  it("Agent.abort() cancels verification even when the caller supplied its own signal", async () => {
    const { agent, internals, gates, signals } = await importAgentWithVerifyGate();
    const external = new AbortController();
    const run = agent.runVerify(undefined, external.signal);
    await settle();
    expect(signals[0]!.aborted).toBe(false);
    expect(internals.abortController).not.toBeNull();

    agent.abort();
    expect(signals[0]!.aborted).toBe(true);
    expect(external.signal.aborted).toBe(false);

    gates[0]!.reject(new Error("cancelled by orchestration"));
    const result = await run;
    expect(result).toEqual({ success: false, output: "Verification aborted." });
    expect(internals.abortController).toBeNull();
  });

  it("external cancellation alone still aborts the run", async () => {
    const { agent, internals, gates, signals } = await importAgentWithVerifyGate();
    const external = new AbortController();
    const run = agent.runVerify(undefined, external.signal);
    await settle();

    external.abort();
    expect(signals[0]!.aborted).toBe(true);

    gates[0]!.reject(new Error("cancelled by orchestration"));
    const result = await run;
    expect(result).toEqual({ success: false, output: "Verification aborted." });
    expect(internals.abortController).toBeNull();
  });

  it("successful completion records the turn and clears the owned controller", async () => {
    const { agent, internals, gates, signals } = await importAgentWithVerifyGate();
    const external = new AbortController();
    const run = agent.runVerify(undefined, external.signal);
    await settle();

    gates[0]!.resolve({ success: true, output: "All checks passed." });
    const result = await run;
    expect(result.success).toBe(true);
    expect(signals[0]!.aborted).toBe(false);
    expect(internals.abortController).toBeNull();
    expect(internals.messages.at(-1)).toEqual({ role: "assistant", content: "All checks passed." });
  });

  it("a stale run finishing after replacement leaves the newer run's controller in place", async () => {
    const { agent, internals, gates, signals } = await importAgentWithVerifyGate();
    const first = agent.runVerify(undefined, new AbortController().signal);
    await settle();
    const second = agent.runVerify(undefined, new AbortController().signal);
    await settle();
    const secondController = internals.abortController;
    expect(secondController).not.toBeNull();

    gates[0]!.resolve({ success: true, output: "first done" });
    await first;
    // The first run's finally must not clear a controller it does not own.
    expect(internals.abortController).toBe(secondController);

    agent.abort();
    expect(signals[1]!.aborted).toBe(true);

    gates[1]!.reject(new Error("cancelled by orchestration"));
    const result = await second;
    expect(result).toEqual({ success: false, output: "Verification aborted." });
    expect(internals.abortController).toBeNull();
  });
});
