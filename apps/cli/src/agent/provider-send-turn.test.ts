import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

function emptyHookResult() {
  return {
    blocked: false,
    blockingErrors: [],
    commandErrors: [],
    additionalContexts: [],
  };
}

async function importAgentWithProviderSession(
  sendTurn: (input: { abortSignal?: AbortSignal }, controller: { emit: (event: unknown) => void }) => Promise<unknown>,
  sessionExtras: Record<string, unknown> = {},
) {
  vi.resetModules();

  const executeEventHooks = vi.fn(async (_input: unknown, _cwd: string, _signal?: AbortSignal) => emptyHookResult());
  vi.doMock("../hooks/index", async () => {
    const actual = await vi.importActual<typeof import("../hooks/index")>("../hooks/index");
    return {
      ...actual,
      executeEventHooks,
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

  vi.doMock("../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
    return {
      ...actual,
      getEnabledToolSet: vi.fn(() => ({})),
      resolveModelRuntimeViaKernel: vi.fn(async () => ({
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
          sendTurn,
          ...sessionExtras,
        },
      })),
      runtimeUsesSendTurn: vi.fn(() => true),
    };
  });

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  const mod = await import("./agent");
  return {
    ...mod,
    mocks: {
      executeEventHooks,
    },
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
});

describe("Agent provider-owned sendTurn transcript parity", () => {
  it("persists provider tool calls/results and fires Stop on success", async () => {
    const { Agent, mocks } = await importAgentWithProviderSession(async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "before " });
      controller.emit({ type: "tool-call", id: "tool-1", toolName: "Bash", args: { command: "pwd" } });
      controller.emit({ type: "tool-result", id: "tool-1", result: "ok" });
      controller.emit({ type: "text-delta", delta: "after" });
      controller.emit({ type: "usage", usage: { inputTokens: 3, outputTokens: 5 } });
      controller.emit({ type: "done" });
      return { usage: { inputTokens: 3, outputTokens: 5 } };
    });
    const agent = new Agent(undefined, undefined, "provider-model", undefined, {
      persistSession: false,
    });

    const chunks = [];
    for await (const chunk of agent.processMessage("run pwd")) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({ type: "done" });
    const messages = (agent as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    // One assistant/tool pair per tool round, so the transcript keeps its
    // chronological order (was: a single assistant message holding every text
    // delta and tool call of the turn).
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "before " },
        { type: "tool-call", toolCallId: "tool-1", toolName: "Bash", input: { command: "pwd" } },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "tool-1", toolName: "Bash" }],
    });
    expect(messages[3]).toEqual({ role: "assistant", content: "after" });
    expect(mocks.executeEventHooks).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: "Stop" }),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("Agent.abort() forwards to the provider session's abortTurn and fires UserInterrupt", async () => {
    let providerSawAbort = false;
    const abortTurn = vi.fn();
    const { Agent, mocks } = await importAgentWithProviderSession(
      // Emit a provider error after host abort. Before cancellation had a
      // terminal path of its own this persisted the partial assistant text and
      // fired StopFailure; now the user interrupt wins that race.
      (input, controller) => {
        // Trailing newline forces an immediate flush so the first `.next()`
        // resolves with a chunk before we interrupt (the buffer only auto-flushes
        // at >=32 chars or a newline).
        controller.emit({ type: "text-delta", delta: "working...\n" });
        return new Promise((resolve) => {
          input.abortSignal?.addEventListener("abort", () => {
            providerSawAbort = true;
            controller.emit({ type: "error", message: "provider interrupted" });
            resolve({});
          });
        });
      },
      { abortTurn },
    );
    const agent = new Agent(undefined, undefined, "provider-model", undefined, {
      persistSession: false,
    });

    const chunks: unknown[] = [];
    const iterator = agent.processMessage("run a long task");
    // Pull the first chunk so the provider turn is in flight, then interrupt.
    const first = await iterator.next();
    if (!first.done) chunks.push(first.value);
    agent.abort();
    for await (const chunk of iterator) chunks.push(chunk);

    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(providerSawAbort).toBe(true);
    expect(chunks).toContainEqual({ type: "content", content: "\n\n[Cancelled]" });
    expect(chunks.at(-1)).toEqual({ type: "done" });
    // The adapter's subprocess saw this turn, so the mirror keeps it too,
    // marked as cancelled. Dropping it made the two transcripts disagree.
    const messages = (agent as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(String(messages[1]?.content)).toMatch(/cancel/i);
    expect(mocks.executeEventHooks).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: "UserInterrupt" }),
      expect.any(String),
      undefined,
    );
    const terminalEvents = mocks.executeEventHooks.mock.calls.map(
      ([input]) => (input as { hook_event_name?: string }).hook_event_name,
    );
    expect(terminalEvents).not.toContain("Stop");
    expect(terminalEvents).not.toContain("StopFailure");
  });

  it("fires StopFailure and still completes the UI stream on provider errors", async () => {
    const { Agent, mocks } = await importAgentWithProviderSession(async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "partial" });
      controller.emit({ type: "error", message: "provider failed" });
      return {};
    });
    const agent = new Agent(undefined, undefined, "provider-model", undefined, {
      persistSession: false,
    });

    const chunks = [];
    for await (const chunk of agent.processMessage("fail")) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: "error", content: "provider failed" });
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(mocks.executeEventHooks).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: "StopFailure", error: "provider failed" }),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("a setup-phase exception fires StopFailure and clears the abort controller (single outer finally)", async () => {
    const { Agent, mocks } = await importAgentWithProviderSession(async () => ({}));
    const agent = new Agent(undefined, undefined, "provider-model", undefined, {
      persistSession: false,
    });

    // Force a throw during setup (runtime resolution), before any turn machine
    // takes over. The single outer catch must surface StopFailure and the
    // finally must clear the in-flight abort controller.
    const ext = await import("../core/plugins");
    vi.mocked(ext.resolveModelRuntimeViaKernel).mockRejectedValueOnce(new Error("setup boom"));

    await expect(async () => {
      for await (const _chunk of agent.processMessage("go")) {
        // drain
      }
    }).rejects.toThrow("setup boom");

    expect(mocks.executeEventHooks).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: "StopFailure" }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    // No stale in-flight state left behind for the next turn.
    expect((agent as unknown as { abortController: AbortController | null }).abortController).toBeNull();
  });

  it("runTaskRequest routes the subagent through the child bash backend (isolation wiring)", async () => {
    const { Agent } = await importAgentWithProviderSession(async () => ({}));
    const { getHostServices } = await import("../core/plugins");
    const agent = new Agent(undefined, undefined, "provider-model", undefined, {
      persistSession: false,
    });

    // Capture what runTaskRequest hands to buildSharedTurnToolset, then bail
    // before streamText runs (the try/catch turns the throw into a failed
    // result). This pins the exact wiring line `bashOverride: childBash`.
    let capturedBashOverride: unknown = "unset";
    (
      agent as unknown as { buildSharedTurnToolset: (args: { bashOverride?: unknown }) => Promise<never> }
    ).buildSharedTurnToolset = async (args) => {
      capturedBashOverride = args.bashOverride;
      throw new Error("stop-before-streamText");
    };

    const result = await (
      agent as unknown as {
        runTaskRequest: (request: {
          agent: string;
          description: string;
          prompt: string;
        }) => Promise<{ success: boolean }>;
      }
    ).runTaskRequest({ agent: "general", description: "child task", prompt: "do it" });

    expect(result.success).toBe(false);
    // Before the fix this was `undefined` (global bash leaked into the child).
    expect(capturedBashOverride).toBeDefined();
    expect(capturedBashOverride).not.toBe(getHostServices().bash);
  });

  it.each([
    "success",
    "failure",
    "cancelled",
  ] as const)("cleans the child bash backend when a subagent reaches %s", async (terminalState) => {
    const { Agent } = await importAgentWithProviderSession(async () => ({}));
    const { setBashSink } = await import("../core/plugins");
    const childCleanup = vi.fn(async () => {});
    const { sink } = buildMockBashSink();
    setBashSink({
      ...sink,
      spawnChild: () =>
        ({
          getCwd: () => "/mock/child",
          getSandboxMode: () => "off",
          getSandboxSettings: () => ({}),
          cleanup: childCleanup,
        }) as never,
    });

    const agent = new Agent(undefined, undefined, "provider-model", undefined, {
      persistSession: false,
      batchApi: true,
    });
    const patched = agent as unknown as {
      buildSharedTurnToolset: (args: unknown) => Promise<unknown>;
      runTaskRequestBatch: (args: unknown) => Promise<unknown>;
      runTaskRequest: (
        request: { agent: string; description: string; prompt: string },
        onActivity?: (detail: string) => void,
        abortSignal?: AbortSignal,
      ) => Promise<{ success: boolean }>;
    };
    patched.buildSharedTurnToolset = async () => ({
      tools: {},
      closeMcp: async () => {},
      mcpUnavailableMessage: null,
    });
    patched.runTaskRequestBatch = async () => {
      if (terminalState === "success") return { success: true, output: "done" };
      throw new Error(`child ${terminalState}`);
    };

    const controller = new AbortController();
    if (terminalState === "cancelled") controller.abort();
    const run = patched.runTaskRequest(
      { agent: "general", description: "child task", prompt: "do it" },
      undefined,
      controller.signal,
    );

    if (terminalState === "cancelled") {
      await expect(run).rejects.toThrow("child cancelled");
    } else {
      await expect(run).resolves.toMatchObject({ success: terminalState === "success" });
    }
    expect(childCleanup).toHaveBeenCalledTimes(1);
  });
});
