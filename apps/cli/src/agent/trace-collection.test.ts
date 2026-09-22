import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "fs";
import path from "path";
import { buildMockBashSink } from "./mock-bash-sink";

// End-to-end check that the internally-wired TraceCollector captures a real
// processMessage turn and writes it to the trace store. Uses the provider
// sendTurn mock (no live model) but REAL storage isolated via CODESURF_HOME, so
// the agent opens a real session and recordTrace writes to a throwaway DB.
//
// Bun-native (mock.module + bun:sqlite). vitest's vi.doMock isn't available
// under `bun test`, and real storage needs bun:sqlite — hence bun:test here.

type SendTurn = (input: unknown, controller: { emit: (event: unknown) => void }) => Promise<unknown>;

function emptyHookResult() {
  return { blocked: false, blockingErrors: [], commandErrors: [], additionalContexts: [] };
}

// Per-test provider behavior, read by the mocked runtime's sendTurn.
let currentSendTurn: SendTurn = async () => ({});

const realExtensions = await import("../core/plugins");
const realHooks = await import("../hooks/index");

mock.module("../hooks/index", () => ({
  ...realHooks,
  executeEventHooks: async () => emptyHookResult(),
}));

mock.module("../core/plugins", () => ({
  ...realExtensions,
  getEnabledToolSet: () => ({}),
  runtimeUsesSendTurn: () => true,
  resolveModelRuntimeViaKernel: async () => ({
    model: null,
    modelId: "provider-model",
    modelInfo: undefined,
    providerOptions: undefined,
    adapterId: "provider.adapter",
    providerId: "provider",
    session: {
      adapterId: "provider.adapter",
      providerId: "provider",
      mode: "persistent",
      sendTurn: (input: unknown, controller: { emit: (event: unknown) => void }) => currentSendTurn(input, controller),
    },
  }),
}));

const { Agent } = await import("./agent");
const { listTraces, listTraceSteps } = await import("../storage/traces");
const { closeDatabase } = await import("../storage/db");

const tempRoot = path.join(process.cwd(), ".tmp-trace-collection-tests");
/** The session cwd the mock bash sink reports for the current case. */
let sessionCwd = "";
const originalCodesurfHome = process.env.CODESURF_HOME;

describe("TraceCollector end-to-end via processMessage", () => {
  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    process.env.CODESURF_HOME = fs.mkdtempSync(path.join(tempRoot, "home-"));
    sessionCwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    const cwd = sessionCwd;
    closeDatabase();
    realExtensions.setBashSink(buildMockBashSink({ initialCwd: cwd }).sink);
  });

  afterEach(() => {
    closeDatabase();
    realExtensions.setBashSink(null);
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes a success trace with tool steps and usage from a real turn", async () => {
    currentSendTurn = async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "before " });
      controller.emit({ type: "tool-call", id: "tool-1", toolName: "Bash", args: { command: "pwd" } });
      controller.emit({ type: "tool-result", id: "tool-1", result: "ok" });
      controller.emit({ type: "text-delta", delta: "after" });
      controller.emit({ type: "usage", usage: { inputTokens: 3, outputTokens: 5 } });
      controller.emit({ type: "done" });
      return { usage: { inputTokens: 3, outputTokens: 5 } };
    };

    // persistSession defaults to true → a real session is opened.
    const agent = new Agent(undefined, undefined, "provider-model");
    for await (const _chunk of agent.processMessage("run pwd")) {
      // drain
    }

    const traces = listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe("success");
    expect(traces[0].query).toBe("run pwd");
    expect(traces[0].model).toBe("provider-model");
    expect(traces[0].queryClass).toBe("short"); // "run pwd" — classified by classifyQuery
    expect(traces[0].totalTokens).toBe(8);
    expect(traces[0].result).toContain("before after");

    const steps = listTraceSteps(traces[0].traceId);
    const toolStep = steps.find((s) => s.stepType === "tool_call");
    expect(toolStep).toBeDefined();
    expect(toolStep?.toolName).toBe("Bash");
    expect(toolStep?.success).toBe(true);
    // A14: each tool step carries the directory it STARTED in, so skill
    // attribution can resolve a relative read even after a later `cd`.
    expect(typeof toolStep?.metadata?.cwd).toBe("string");
    expect(toolStep?.metadata?.cwd).toBe(sessionCwd);
  });

  it("writes a failure trace on a provider error", async () => {
    currentSendTurn = async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "partial" });
      controller.emit({ type: "error", message: "provider failed" });
      return {};
    };

    const agent = new Agent(undefined, undefined, "provider-model");
    for await (const _chunk of agent.processMessage("fail")) {
      // drain
    }

    const traces = listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe("failure");
    expect(traces[0].query).toBe("fail");
  });

  it("records a neutral cancelled trace without persisting provider partial output", async () => {
    currentSendTurn = (input, controller) => {
      controller.emit({ type: "text-delta", delta: "partial provider text\n" });
      return new Promise((resolve) => {
        (input as { abortSignal?: AbortSignal }).abortSignal?.addEventListener("abort", () => {
          // Providers commonly surface abort as an error; the Agent must still
          // classify the terminal state as a user cancellation.
          controller.emit({ type: "error", message: "provider interrupted" });
          resolve({});
        });
      });
    };

    const agent = new Agent(undefined, undefined, "provider-model");
    const iterator = agent.processMessage("cancel me");
    await iterator.next(); // provider is now in flight and has emitted text
    agent.abort();
    for await (const _chunk of iterator) {
      // drain
    }

    const traces = listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe("cancelled");
    expect(traces[0].result).toBeNull();
  });
});
