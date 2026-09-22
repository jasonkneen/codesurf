import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: a streamText turn that surfaced an SDK `error` part and/or whose
// `result.response` rejected must settle as a FAILED terminal (StopFailure)
// while still retaining the partial assistant text — never as Stop, which
// would train the learning loop on a visibly failed stream.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

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

/** A rejected promise that is already "handled" so vitest does not flag it
 *  as unhandled before the runner awaits it. */
function handledRejection(error: unknown): Promise<never> {
  const promise = Promise.reject(error);
  promise.catch(() => {});
  return promise;
}

async function runAndCollect(ctx: TurnContext) {
  const { runStreamTurn } = await import("./stream-turn");
  const observer = { onError: vi.fn() };
  const chunks: StreamChunk[] = [];
  for await (const chunk of runStreamTurn(ctx, {
    userModelMessage,
    observer,
    system: "sys",
    runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
    modelInfo: undefined as never,
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  return { chunks, observer };
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("stream turn failed terminal state", () => {
  it("text then error part with a rejected response settles as StopFailure and keeps the partial text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial answer" };
        yield { type: "error", error: new Error("upstream exploded") };
      })(),
      response: handledRejection(new Error("upstream exploded")),
      finishReason: Promise.resolve("error"),
    }));
    const ctx = makeCtx();

    const { chunks, observer } = await runAndCollect(ctx);

    expect(chunks).toContainEqual({ type: "content", content: "partial answer" });
    expect(chunks.filter((c) => c.type === "error")).toEqual([
      { type: "error", content: "upstream exploded", isAuthError: false },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledWith("upstream exploded", expect.any(AbortSignal));
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.terminalizeCancelledTurn).not.toHaveBeenCalled();
    expect(ctx.appendCompletedTurn).toHaveBeenCalledTimes(1);
    expect(ctx.appendCompletedTurn).toHaveBeenCalledWith(userModelMessage, [
      { role: "assistant", content: "partial answer" },
    ]);
    expect(observer.onError).toHaveBeenCalled();
  });

  it("a rejected response after partial text (no error part) still fails, surfacing the error once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "half" };
      })(),
      response: handledRejection(new Error("connection reset")),
      finishReason: Promise.resolve("error"),
    }));
    const ctx = makeCtx();

    const { chunks } = await runAndCollect(ctx);

    expect(chunks.filter((c) => c.type === "error")).toEqual([
      { type: "error", content: "connection reset", isAuthError: false },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledWith("connection reset", expect.any(AbortSignal));
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.appendCompletedTurn).toHaveBeenCalledWith(userModelMessage, [{ role: "assistant", content: "half" }]);
  });

  it("an error part makes Stop impossible even when the response promise resolves", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "before failure" };
        yield { type: "error", error: new Error("step failed") };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "before failure" }] }),
      finishReason: Promise.resolve("error"),
    }));
    const ctx = makeCtx();

    const { chunks } = await runAndCollect(ctx);

    expect(chunks.filter((c) => c.type === "error")).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledWith("step failed", expect.any(AbortSignal));
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    // The response transcript was already committed; it is not duplicated.
    expect(ctx.appendCompletedTurn).toHaveBeenCalledTimes(1);
  });

  it("a clean stream still settles as Stop", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "fine" };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "fine" }] }),
      finishReason: Promise.resolve("stop"),
    }));
    const ctx = makeCtx();

    const { chunks } = await runAndCollect(ctx);

    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
  });

  it("closes a tool whose execute threw (tool-error part) as a failed result", async () => {
    // What ai v6 emits when a tool's execute throws: the call, then a
    // `tool-error` part instead of a `tool-result`. The step still completes.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "x" } };
        yield {
          type: "tool-error",
          toolCallId: "c1",
          toolName: "read_file",
          input: { path: "x" },
          error: new Error("EACCES"),
        };
        yield { type: "text-delta", text: "could not read it" };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "could not read it" }] }),
      finishReason: Promise.resolve("stop"),
    }));
    const ctx = makeCtx();
    const onToolFinish = vi.fn();
    const { runStreamTurn } = await import("./stream-turn");
    const chunks: StreamChunk[] = [];
    for await (const chunk of runStreamTurn(ctx, {
      userModelMessage,
      observer: { onToolFinish },
      system: "sys",
      runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
      modelInfo: undefined as never,
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk);
    }

    const result = chunks.find((chunk) => chunk.type === "tool_result");
    expect(result).toMatchObject({ toolCall: { id: "c1" }, toolResult: { success: false, error: "EACCES" } });
    expect(onToolFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "c1" }),
        toolResult: expect.objectContaining({ success: false }),
      }),
    );
    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
  });
});
