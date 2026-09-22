// Regression for review finding A8 (sub-agent depth/concurrency accounting)
// and the V1 call site (verify preparation receives the run's signal).
//
// Before: `subagentDepth` and `inFlightSubagents` were both incremented only
// AFTER awaited preparation / runtime resolution, so concurrent starts all
// passed admission before any reservation, and depth lived on one shared
// counter so active siblings looked like ancestors to an unrelated top-level
// request. Now the slot is reserved synchronously at admission and released
// in `finally`, and depth is carried per execution context — the child's
// nested `task` tool is bound to `{ depth: parent + 1 }`.

import { tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

function emptyHookResult() {
  return { blocked: false, blockingErrors: [], commandErrors: [], additionalContexts: [] };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const req = (agent: string) => ({ agent, description: "d", prompt: "p" });

type TaskInternals = {
  inFlightSubagents: number;
  runTaskRequest(
    request: { agent: string; description: string; prompt: string },
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<{ success: boolean; output: string }>;
  // Toolset composition moved to ./session-toolsets.ts; the Agent holds the
  // owner. These tests reach it there rather than through a delegating shim.
  toolsets: {
    buildTurn(args: {
      runtime: { modelInfo?: { supportsClientTools?: boolean } };
      mode: string;
      subagentContext?: { depth: number };
    }): Promise<{
      tools: Record<
        string,
        {
          execute: (
            input: unknown,
            ctx: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
          ) => Promise<{ success: boolean; output?: string }>;
        }
      >;
    }>;
  };
};

async function importAgentForAdmission() {
  vi.resetModules();

  vi.doMock("../hooks/index", async () => {
    const actual = await vi.importActual<typeof import("../hooks/index")>("../hooks/index");
    return {
      ...actual,
      executeEventHooks: vi.fn(async () => emptyHookResult()),
      executePreToolHooks: vi.fn(async () => emptyHookResult()),
      executePostToolHooks: vi.fn(async () => emptyHookResult()),
      executePostToolFailureHooks: vi.fn(async () => emptyHookResult()),
    };
  });

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

  // Every admitted run blocks at runtime resolution until the test releases
  // the gate. Rejecting the gate unwinds every run without touching a model.
  const runtimeGate = deferred<never>();
  const resolveModelRuntimeViaKernel = vi.fn(() => runtimeGate.promise);

  // The kernel's `task` tool, as the global subagents sink would bind it. If
  // the child override fails, executing `tools.task` runs this instead.
  const globalTaskExecute = vi.fn(async () => ({ success: true, output: "GLOBAL" }));
  const globalTaskTool = tool({
    description: "global task",
    inputSchema: z.object({ agent: z.string(), description: z.string(), prompt: z.string() }),
    execute: async () => globalTaskExecute(),
  });
  vi.doMock("../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
    return {
      ...actual,
      getEnabledToolSet: vi.fn(() => ({ task: globalTaskTool })),
      resolveModelRuntimeViaKernel,
    };
  });

  // Verify preparation: rejects on demand, or when the run's signal aborts.
  const prepareVerifySandbox = vi.fn(
    (
      _cwd: string,
      _settings: unknown,
      _recipe: unknown,
      _onProgress: unknown,
      options: { signal?: AbortSignal } = {},
    ) =>
      new Promise<never>((_, reject) => {
        const { signal } = options;
        if (!signal) {
          reject(new Error("no signal supplied to prepareVerifySandbox"));
          return;
        }
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  vi.doMock("../verify/entrypoint", async () => {
    const actual = await vi.importActual<typeof import("../verify/entrypoint")>("../verify/entrypoint");
    return { ...actual, prepareVerifySandbox };
  });

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  const { Agent } = await import("./agent");
  const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });
  return {
    agent: agent as unknown as TaskInternals,
    runtimeGate,
    resolveModelRuntimeViaKernel,
    prepareVerifySandbox,
    globalTaskExecute,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink, setHooksSink } = await import("../core/plugins");
    setBashSink(null);
    setHooksSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../core/plugins");
  vi.doUnmock("../hooks/index");
  vi.doUnmock("../storage/index");
  vi.doUnmock("../verify/entrypoint");
});

describe("sub-agent admission (A8)", () => {
  it("reserves the fan-out slot before any await, so simultaneous starts cannot exceed the cap", async () => {
    const { agent, runtimeGate, resolveModelRuntimeViaKernel } = await importAgentForAdmission();

    // Five simultaneous starts against a cap of four: the fifth is refused
    // synchronously, while the first four are still parked before runtime
    // resolution.
    const runs = Array.from({ length: 5 }, () => agent.runTaskRequest(req("general")));
    expect(agent.inFlightSubagents).toBe(4);
    const fifth = await runs[4]!;
    expect(fifth.success).toBe(false);
    expect(fifth.output).toMatch(/Too many sub-agents already running \(4\)/);
    expect(resolveModelRuntimeViaKernel).toHaveBeenCalledTimes(4);

    // Failed preparation before the child exists: every slot is released.
    runtimeGate.reject(new Error("no runtime"));
    const settled = await Promise.allSettled(runs.slice(0, 4));
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    expect(agent.inFlightSubagents).toBe(0);

    // And a new start is admitted again (it fails on the gate, not on the cap).
    await expect(agent.runTaskRequest(req("general"))).rejects.toThrow("no runtime");
    expect(agent.inFlightSubagents).toBe(0);
  });

  it("counts depth along the chain, not across concurrent siblings", async () => {
    const { agent, runtimeGate, globalTaskExecute } = await importAgentForAdmission();

    // Two active siblings at the root. A third top-level request has true
    // depth 0 and must be admitted rather than refused as "too deep".
    const siblings = [agent.runTaskRequest(req("general")), agent.runTaskRequest(req("general"))];
    const third = agent.runTaskRequest(req("general"));
    await settle();
    expect(agent.inFlightSubagents).toBe(3);

    // A child two levels down (root -> reviewer -> focused check) is bound to
    // depth 2, so ITS nested task hits the nesting limit — and it is refused
    // by this Agent, never routed through the global kernel sink.
    const grandchild = await agent.toolsets.buildTurn({
      runtime: { modelInfo: { supportsClientTools: true } },
      mode: "ask",
      subagentContext: { depth: 2 },
    });
    const refused = await grandchild.tools.task!.execute(req("general"), { toolCallId: "t1", messages: [] });
    expect(refused.success).toBe(false);
    expect(refused.output).toMatch(/nesting limit reached \(depth 2\)/);
    expect(globalTaskExecute).not.toHaveBeenCalled();
    expect(agent.inFlightSubagents).toBe(3);

    // A child one level down is admitted (it parks at the runtime gate) and
    // takes a slot like any other run.
    const child = await agent.toolsets.buildTurn({
      runtime: { modelInfo: { supportsClientTools: true } },
      mode: "ask",
      subagentContext: { depth: 1 },
    });
    const nested = child.tools.task!.execute(req("general"), { toolCallId: "t2", messages: [] });
    await settle();
    expect(agent.inFlightSubagents).toBe(4);
    expect(globalTaskExecute).not.toHaveBeenCalled();

    runtimeGate.reject(new Error("no runtime"));
    const settled = await Promise.allSettled([...siblings, third, nested]);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    for (const r of settled) {
      if (r.status === "rejected") expect(String(r.reason)).not.toMatch(/nesting limit/);
    }
    expect(agent.inFlightSubagents).toBe(0);
  });

  it("releases the slot when verify preparation fails or is cancelled before runtime resolution", async () => {
    const { agent, prepareVerifySandbox, resolveModelRuntimeViaKernel } = await importAgentForAdmission();

    // Cancellation before runtime resolution: the run's signal reaches
    // prepareVerifySandbox (V1 call site) and aborting it unwinds the run.
    const controller = new AbortController();
    const cancelled = agent.runTaskRequest(req("verify"), undefined, controller.signal);
    await settle();
    expect(agent.inFlightSubagents).toBe(1);
    expect(prepareVerifySandbox).toHaveBeenCalledTimes(1);
    const passedSignal = prepareVerifySandbox.mock.calls[0]![4]?.signal;
    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(passedSignal?.aborted).toBe(false);

    controller.abort();
    await expect(cancelled).rejects.toThrow("aborted");
    expect(passedSignal?.aborted).toBe(true);
    expect(agent.inFlightSubagents).toBe(0);
    expect(resolveModelRuntimeViaKernel).not.toHaveBeenCalled();

    // Failed preparation: the checkpoint rejects before any child exists.
    prepareVerifySandbox.mockImplementationOnce(() => Promise.reject(new Error("checkpoint failed")));
    await expect(agent.runTaskRequest(req("verify"))).rejects.toThrow("checkpoint failed");
    expect(agent.inFlightSubagents).toBe(0);
  });
});
