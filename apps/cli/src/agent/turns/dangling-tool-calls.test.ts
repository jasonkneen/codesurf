import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderSession, ProviderStreamController, ProviderStreamEvent } from "../../core/plugins";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: a tool-call that never received a tool-result must never reach
// the durable transcript. Providers cut streams, error out mid-round and
// settle with calls still open; the persisted history then contains an
// assistant `tool-call` part with no matching `tool-result`, which every
// provider rejects. Nothing repairs it on load, so the session is poisoned
// permanently — a restart replays the same broken rows.
//
// Recovery synthesizes a structured error result. It never re-executes.

const hostCwd = vi.hoisted(() => ({ dir: "/tmp" }));
vi.mock("../../core/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/plugins")>();
  return { ...actual, getHostServices: () => ({ bash: { cwd: () => hostCwd.dir } }) };
});

const batchMocks = vi.hoisted(() => ({
  createBatch: vi.fn(async () => ({ batch_id: "batch-1" })),
  addBatchRequests: vi.fn(async (_request: unknown) => {}),
  pollBatchRequestResult: vi.fn(async () => ({ batch_request_id: "req-1" })),
  getBatchChatCompletion: vi.fn((): unknown => ({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {},
  })),
}));
vi.mock("../../grok/batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../grok/batch")>();
  return { ...actual, ...batchMocks };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

beforeAll(async () => {
  await import("./session-turn");
}, 60_000);

function makeCtx() {
  const ctx: TurnContext = {
    getMessages: () => [userModelMessage],
    mode: "agent",
    maxToolRounds: 3,
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
    executeBatchToolCall: vi.fn(),
    setCurrentProviderSession: vi.fn(),
  };
  return ctx;
}

type SendTurn = NonNullable<ProviderSession["sendTurn"]>;

function makeSession(sendTurn: SendTurn): ProviderSession {
  return { adapterId: "test.adapter", providerId: "test", mode: "persistent", sendTurn };
}

/** A session that replays a fixed script of provider events, then settles. */
function scriptedSession(events: ProviderStreamEvent[]): ProviderSession {
  return makeSession(async (_input, controller: ProviderStreamController) => {
    for (const event of events) controller.emit(event);
    return {};
  });
}

async function runSession(ctx: TurnContext, session: ProviderSession) {
  const { runSessionTurn } = await import("./session-turn");
  const chunks: StreamChunk[] = [];
  const generator = runSessionTurn(ctx, {
    userMessage: "hello",
    userModelMessage,
    observer: {},
    runtime: {
      model: null as never,
      modelId: "test-model",
      modelInfo: undefined,
      providerOptions: undefined,
      adapterId: "test.adapter",
      providerId: "test",
      session,
    },
    signal: new AbortController().signal,
  });
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

/** Every tool-call part in `messages` has a tool-result part with the same id. */
function assertBalanced(messages: ModelMessage[]) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "tool-call") calls.add(String(part.toolCallId));
      if (part.type === "tool-result") results.add(String(part.toolCallId));
    }
  }
  expect([...calls].filter((id) => !results.has(id))).toEqual([]);
  return { calls, results };
}

describe("closeDanglingToolCalls", () => {
  it("synthesizes a failed result for an unanswered call and leaves answered ones alone", async () => {
    const { closeDanglingToolCalls } = await import("./helpers");
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "answered", toolName: "read_file", input: {} },
          { type: "tool-call", toolCallId: "open", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "answered", toolName: "read_file", output: { type: "text", value: "ok" } },
        ],
      },
    ];

    const closed = closeDanglingToolCalls(messages);

    const { results } = assertBalanced(closed);
    expect(results.has("open")).toBe(true);
    const synthesized = closed
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
      .find((p) => p.type === "tool-result" && p.toolCallId === "open");
    expect(synthesized?.output).toMatchObject({ type: "error-json" });
    // The marker must warn that the side effect is of unknown status, so the
    // model verifies rather than blindly re-running the call.
    expect(JSON.stringify(synthesized?.output)).toMatch(/may or may not/i);
  });

  it("is a no-op on an already balanced transcript", async () => {
    const { closeDanglingToolCalls } = await import("./helpers");
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "t", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "a", toolName: "t", output: { type: "text", value: "v" } }],
      },
    ];
    expect(closeDanglingToolCalls(messages)).toBe(messages);
  });
});

describe("provider-session turn transcript integrity", () => {
  function persistedBy(ctx: TurnContext): ModelMessage[] {
    const mock = ctx.appendCompletedTurn as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    return mock.mock.calls[0][1] as ModelMessage[];
  }

  it("closes a tool call left open when the provider errors mid-round", async () => {
    const ctx = makeCtx();
    await runSession(
      ctx,
      scriptedSession([
        { type: "tool-call", id: "t1", toolName: "write_file", args: { path: "a.ts" } },
        { type: "error", message: "provider exploded" },
      ]),
    );

    assertBalanced(persistedBy(ctx));
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
  });

  it("closes a tool call left open when the provider reports done without a result", async () => {
    const ctx = makeCtx();
    await runSession(
      ctx,
      scriptedSession([
        { type: "tool-call", id: "t1", toolName: "bash", args: { command: "ls" } },
        { type: "done", stopReason: "end_turn" },
      ]),
    );

    assertBalanced(persistedBy(ctx));
  });

  it("closes only the unanswered call when a round answers some but not all", async () => {
    const ctx = makeCtx();
    await runSession(
      ctx,
      scriptedSession([
        { type: "tool-call", id: "t1", toolName: "read_file", args: { path: "a.ts" } },
        { type: "tool-call", id: "t2", toolName: "bash", args: { command: "ls" } },
        { type: "tool-result", id: "t1", result: "contents" },
        { type: "error", message: "died before t2" },
      ]),
    );

    const { calls, results } = assertBalanced(persistedBy(ctx));
    expect(calls.size).toBe(2);
    expect(results.size).toBe(2);
  });

  it("leaves a normally completed round untouched", async () => {
    const ctx = makeCtx();
    await runSession(
      ctx,
      scriptedSession([
        { type: "tool-call", id: "t1", toolName: "bash", args: { command: "ls" } },
        { type: "tool-result", id: "t1", result: "a.ts" },
        { type: "text-delta", delta: "done looking" },
        { type: "done", stopReason: "end_turn" },
      ]),
    );

    const { results } = assertBalanced(persistedBy(ctx));
    expect(results.size).toBe(1);
    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
  });
});

describe("batch turn transcript integrity", () => {
  it("closes the round's tool call when tool preparation throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runBatchTurn } = await import("./batch-turn");
    const ctx = makeCtx();
    // A throw from the approval / schema gate happens BEFORE any result is
    // recorded, so the round's assistant message is left holding an open call.
    ctx.executeBatchToolCall = vi.fn(async () => {
      throw new Error("needsApproval blew up");
    });

    for await (const _chunk of runBatchTurn(ctx, {
      userModelMessage,
      system: "sys",
      runtime: { model: {} as never, modelId: "grok-4", modelInfo: { contextWindow: 1000 } as never },
      modelInfo: { contextWindow: 1000 } as never,
      signal: new AbortController().signal,
    })) {
      // drain
    }

    const mock = ctx.appendCompletedTurn as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    assertBalanced(mock.mock.calls[0][1] as ModelMessage[]);
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
  });
});

describe("interleaved rounds", () => {
  it("does not synthesize a result for a call answered in a later round", async () => {
    const ctx = makeCtx();
    // `openRoundIfSettled` starts a new round as soon as the current one has
    // any result, so a second call's real result can land in the NEXT round.
    // Closing per round would then answer it twice — once synthetically here,
    // once for real there — and two results for one id is itself rejected.
    await runSession(
      ctx,
      scriptedSession([
        { type: "tool-call", id: "a", toolName: "read_file", args: {} },
        { type: "tool-call", id: "b", toolName: "bash", args: {} },
        { type: "tool-result", id: "a", result: "contents" },
        { type: "text-delta", delta: "still working" },
        { type: "tool-result", id: "b", result: "listing" },
        { type: "done", stopReason: "end_turn" },
      ]),
    );

    const persisted = (ctx.appendCompletedTurn as ReturnType<typeof vi.fn>).mock.calls[0][1] as ModelMessage[];
    const resultIds = persisted.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>)
            .filter((p) => p.type === "tool-result")
            .map((p) => String(p.toolCallId))
        : [],
    );
    expect(resultIds.sort()).toEqual(["a", "b"]);
    expect(JSON.stringify(persisted)).not.toMatch(/may or may not/i);
  });
});
