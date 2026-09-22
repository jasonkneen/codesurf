import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: the batch runner yields its final content / tool result to the
// consumer BEFORE committing the turn. An Esc that lands while the generator
// is suspended at that yield must win over the success (or max-rounds
// failure) commit, exactly as the provider-session runner guards it.

const batchMocks = vi.hoisted(() => ({
  createBatch: vi.fn(async () => ({ batch_id: "batch-1" })),
  addBatchRequests: vi.fn(async (_request: unknown) => {}),
  pollBatchRequestResult: vi.fn(async () => ({ batch_request_id: "req-1" })),
  getBatchChatCompletion: vi.fn((): unknown => ({ choices: [], usage: {} })),
  cancelBatch: vi.fn(async (_request: { batchId: string; signal?: AbortSignal }) => ({ batch_id: "batch-1" })),
}));
vi.mock("../../grok/batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../grok/batch")>();
  return { ...actual, ...batchMocks };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

function makeCtx(maxToolRounds: number) {
  const ctx: TurnContext = {
    getMessages: () => [userModelMessage],
    mode: "agent",
    maxToolRounds,
    maxTokens: 1024,
    getSessionId: () => "session-1",
    getCompactionSettings: () => ({ enabled: false }) as never,
    getBatchClientOptions: () => ({ apiKey: "k" }) as never,
    recordUsage: vi.fn(),
    appendCompletedTurn: vi.fn(),
    terminalizeCancelledTurn: vi.fn(async () => {}),
    emitTurnStop: vi.fn(async () => {}),
    emitTurnStopFailure: vi.fn(async () => {}),
    refreshSessionRecap: vi.fn(async () => {}),
    compactForContext: vi.fn(async () => false),
    buildSharedTurnToolset: vi.fn(async () => ({ tools: {}, closeMcp: async () => {}, mcpUnavailableMessage: null })),
    executeBatchToolCall: vi.fn(async () => ({ input: {}, result: { success: true, output: "tool ok" } })),
    setCurrentProviderSession: vi.fn(),
  };
  return ctx;
}

const finalAnswer = {
  choices: [{ message: { content: "final answer", tool_calls: [] }, finish_reason: "stop" }],
  usage: {},
};
const toolRound = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {},
};

/**
 * Drive the generator by hand; abort the signal while it is suspended at the
 * first yield matching `abortAt`, then drain the remainder.
 */
async function runUntilAbort(ctx: TurnContext, abortAt: (chunk: StreamChunk) => boolean) {
  const { runBatchTurn } = await import("./batch-turn");
  const abort = new AbortController();
  const iterator = runBatchTurn(ctx, {
    userModelMessage,
    system: "sys",
    runtime: {
      model: {} as never,
      modelId: "grok-batch",
      modelInfo: { supportsClientTools: false } as never,
    },
    modelInfo: undefined as never,
    signal: abort.signal,
  });
  const chunks: StreamChunk[] = [];
  let aborted = false;
  let step = await iterator.next();
  while (!step.done) {
    chunks.push(step.value);
    if (!aborted && abortAt(step.value)) {
      aborted = true;
      abort.abort();
    }
    step = await iterator.next();
  }
  return { chunks, aborted };
}

function expectCancelledTerminal(ctx: TurnContext, chunks: StreamChunk[]) {
  expect(chunks.slice(-2)).toEqual([{ type: "content", content: "\n\n[Cancelled]" }, { type: "done" }]);
  expect(ctx.terminalizeCancelledTurn).toHaveBeenCalledTimes(1);
  expect(ctx.appendCompletedTurn).not.toHaveBeenCalled();
  expect(ctx.emitTurnStop).not.toHaveBeenCalled();
  expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
  expect(ctx.refreshSessionRecap).not.toHaveBeenCalled();
}

afterEach(() => {
  batchMocks.addBatchRequests.mockClear();
  batchMocks.getBatchChatCompletion.mockReset();
});

describe("batch turn rechecks cancellation at its last yields", () => {
  it("abort while the final content is held by the consumer does not commit success", async () => {
    batchMocks.getBatchChatCompletion.mockReturnValue(finalAnswer);
    const ctx = makeCtx(3);

    const { chunks, aborted } = await runUntilAbort(ctx, (c) => c.type === "content" && c.content === "final answer");

    expect(aborted).toBe(true);
    expectCancelledTerminal(ctx, chunks);
    expect(batchMocks.addBatchRequests).toHaveBeenCalledTimes(1);
  });

  it("abort while the last tool result is held does not start another round", async () => {
    batchMocks.getBatchChatCompletion.mockReturnValueOnce(toolRound).mockReturnValue(finalAnswer);
    const ctx = makeCtx(3);

    const { chunks, aborted } = await runUntilAbort(ctx, (c) => c.type === "tool_result");

    expect(aborted).toBe(true);
    expectCancelledTerminal(ctx, chunks);
    expect(batchMocks.addBatchRequests).toHaveBeenCalledTimes(1);
  });

  it("abort at the last tool result of the final round does not commit the max-rounds failure", async () => {
    batchMocks.getBatchChatCompletion.mockReturnValue(toolRound);
    const ctx = makeCtx(1);

    const { chunks, aborted } = await runUntilAbort(ctx, (c) => c.type === "tool_result");

    expect(aborted).toBe(true);
    expectCancelledTerminal(ctx, chunks);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(batchMocks.addBatchRequests).toHaveBeenCalledTimes(1);
  });

  it("without an abort the same final content still commits and fires Stop", async () => {
    batchMocks.getBatchChatCompletion.mockReturnValue(finalAnswer);
    const ctx = makeCtx(3);

    const { chunks, aborted } = await runUntilAbort(ctx, () => false);

    expect(aborted).toBe(false);
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(ctx.appendCompletedTurn).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.terminalizeCancelledTurn).not.toHaveBeenCalled();
  });
});

describe("batch turn cancelled while a request is in flight", () => {
  it("cancels the xAI batch so the queued request stops running and billing", async () => {
    batchMocks.cancelBatch.mockClear();
    // Real poll behaviour: it rejects as soon as the turn signal aborts.
    let abortTurn: (() => void) | undefined;
    batchMocks.pollBatchRequestResult.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          abortTurn = () => reject(new Error("aborted"));
        }),
    );
    const ctx = makeCtx(3);
    const { runBatchTurn } = await import("./batch-turn");
    const abort = new AbortController();
    const iterator = runBatchTurn(ctx, {
      userModelMessage,
      system: "sys",
      runtime: { model: {} as never, modelId: "grok-batch", modelInfo: { supportsClientTools: false } as never },
      modelInfo: undefined as never,
      signal: abort.signal,
    });
    const pending = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) chunks.push(chunk);
      return chunks;
    })();
    await vi.waitFor(() => expect(abortTurn).toBeDefined());
    abort.abort();
    abortTurn?.();
    const chunks = await pending;

    expectCancelledTerminal(ctx, chunks);
    expect(batchMocks.cancelBatch).toHaveBeenCalledTimes(1);
    const [request] = batchMocks.cancelBatch.mock.calls[0]!;
    expect(request.batchId).toBe("batch-1");
    // Its own deadline, not the already-aborted turn signal.
    expect(request.signal?.aborted).toBe(false);
  });
});

describe("batch turn compaction sizing", () => {
  it("sizes compaction against the tool definitions the batch request carries", async () => {
    batchMocks.getBatchChatCompletion.mockReturnValue(finalAnswer);
    const ctx = makeCtx(3);
    ctx.buildSharedTurnToolset = vi.fn(async () => ({
      tools: {
        mcp_db__query: {
          description: "query the warehouse",
          inputSchema: jsonSchema({ type: "object", properties: { WAREHOUSE_FIELD: { type: "string" } } }),
          execute: vi.fn(),
        },
      } as unknown as ToolSet,
      closeMcp: async () => {},
      mcpUnavailableMessage: null,
    }));
    const { runBatchTurn } = await import("./batch-turn");
    for await (const _chunk of runBatchTurn(ctx, {
      userModelMessage,
      system: "sys",
      runtime: { model: {} as never, modelId: "grok-batch", modelInfo: {} as never },
      modelInfo: { contextWindow: 100_000 } as never,
      signal: new AbortController().signal,
    })) {
      // drain
    }

    const sized = vi.mocked(ctx.compactForContext).mock.calls[0]?.[1];
    expect(sized).toContain("sys");
    expect(sized).toContain("mcp_db__query");
    expect(sized).toContain("WAREHOUSE_FIELD");
  });
});
