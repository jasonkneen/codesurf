import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnContext } from "./types";

// Regression for the stale-transcript-after-compaction defect: the turn
// runners captured `ctx.messages` when the TurnContext was built, so after
// `compactForContext` replaced the Agent's array the request still carried
// the pre-compaction history. They now read `ctx.getMessages()` after the
// compaction point.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const batchMocks = vi.hoisted(() => ({
  createBatch: vi.fn(async () => ({ batch_id: "batch-1" })),
  addBatchRequests: vi.fn(async (_request: unknown) => {}),
  pollBatchRequestResult: vi.fn(async () => ({ batch_request_id: "req-1" })),
  getBatchChatCompletion: vi.fn(() => ({
    choices: [{ message: { content: "compact answer", tool_calls: [] }, finish_reason: "stop" }],
    usage: {},
  })),
}));
vi.mock("../../grok/batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../grok/batch")>();
  return { ...actual, ...batchMocks };
});

const originalHistory: ModelMessage[] = [
  { role: "user", content: "very old prompt" },
  { role: "assistant", content: "very old answer" },
  { role: "user", content: "latest prompt" },
];
const compactedHistory: ModelMessage[] = [
  { role: "user", content: "[compaction summary]" },
  { role: "user", content: "latest prompt" },
];

function makeAgentState() {
  const state = { messages: originalHistory };
  const ctx: TurnContext = {
    getMessages: () => state.messages,
    mode: "agent",
    maxToolRounds: 3,
    maxTokens: 1024,
    getSessionId: () => "session-1",
    getCompactionSettings: () => ({ enabled: true, thresholdRatio: 0.8, keepRecentTokens: 100 }) as never,
    getBatchClientOptions: () => ({ apiKey: "k" }) as never,
    recordUsage: vi.fn(),
    appendCompletedTurn: vi.fn(),
    terminalizeCancelledTurn: vi.fn(async () => {}),
    emitTurnStop: vi.fn(async () => {}),
    emitTurnStopFailure: vi.fn(async () => {}),
    refreshSessionRecap: vi.fn(async () => {}),
    compactForContext: vi.fn(async () => {
      // Mirrors Agent.compactForContext: the array is REPLACED, not mutated.
      state.messages = compactedHistory;
      return true;
    }),
    buildSharedTurnToolset: vi.fn(async () => ({ tools: {}, closeMcp: async () => {}, mcpUnavailableMessage: null })),
    executeBatchToolCall: vi.fn(),
    setCurrentProviderSession: vi.fn(),
  };
  return { ctx, state };
}

async function drain(generator: AsyncGenerator<unknown>) {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  streamTextMock.mockReset();
  batchMocks.addBatchRequests.mockClear();
});

describe("turn runners read the live transcript after compaction", () => {
  it("stream turn sends the compacted history to streamText", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "ok" };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "ok" }] }),
    }));
    const { runStreamTurn } = await import("./stream-turn");
    const { ctx } = makeAgentState();

    await drain(
      runStreamTurn(ctx, {
        userModelMessage: originalHistory[2]!,
        observer: {},
        system: "sys",
        runtime: { model: {} as never, modelId: "m", modelInfo: { contextWindow: 1000 } as never },
        modelInfo: { contextWindow: 1000 } as never,
        signal: new AbortController().signal,
      }),
    );

    expect(ctx.compactForContext).toHaveBeenCalledTimes(1);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const request = streamTextMock.mock.calls[0]![0] as { messages: ModelMessage[] };
    expect(request.messages).toBe(compactedHistory);
    expect(request.messages.map((m) => m.content)).not.toContain("very old prompt");
  });

  it("batch turn sends the compacted history in the batch request", async () => {
    const { runBatchTurn } = await import("./batch-turn");
    const { ctx } = makeAgentState();

    await drain(
      runBatchTurn(ctx, {
        userModelMessage: originalHistory[2]!,
        system: "sys",
        runtime: {
          model: {} as never,
          modelId: "grok-batch",
          modelInfo: { contextWindow: 1000, supportsClientTools: false } as never,
        },
        modelInfo: { contextWindow: 1000 } as never,
        signal: new AbortController().signal,
      }),
    );

    expect(ctx.compactForContext).toHaveBeenCalledTimes(1);
    expect(batchMocks.addBatchRequests).toHaveBeenCalledTimes(1);
    const call = batchMocks.addBatchRequests.mock.calls[0]![0] as {
      batchRequests: Array<{ batch_request: { chat_get_completion: { messages: Array<{ content: unknown }> } } }>;
    };
    const sent = call.batchRequests[0]!.batch_request.chat_get_completion.messages.map((m) => m.content);
    expect(sent).toContain("[compaction summary]");
    expect(sent).not.toContain("very old prompt");
  });
});
