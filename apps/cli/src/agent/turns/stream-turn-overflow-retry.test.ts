import { type ModelMessage, NoOutputGeneratedError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: the context-overflow retry re-runs the WHOLE turn from the top.
// Guarding it on "no assistant text" alone is not enough — a step that emitted
// only tool calls has already executed them, and a retry executes them again.
// Recovery must be terminalization-only once a side effect may have happened.
//
// The mocks mirror what ai v6 streamText really does on a failed request: the
// provider error arrives as an `error` stream part, and `result.response`
// then rejects with a generic NoOutputGeneratedError (no step completed) — it
// never rejects with the overflow error itself.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

const modelInfo = { contextWindow: 1000 } as never;

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

function handledRejection(error: unknown): Promise<never> {
  const promise = Promise.reject(error);
  promise.catch(() => {});
  return promise;
}

const overflow = () => new Error("This model's maximum context length is 1000 tokens");
const noOutput = () => new NoOutputGeneratedError({ message: "No output generated. Check the stream for errors." });

async function runAndCollect(ctx: TurnContext) {
  const { runStreamTurn } = await import("./stream-turn");
  const chunks: StreamChunk[] = [];
  for await (const chunk of runStreamTurn(ctx, {
    userModelMessage,
    observer: {},
    system: "sys",
    runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
    modelInfo,
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("stream turn context-overflow recovery", () => {
  it("does not re-run the turn when tool calls already executed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The step emitted a tool call and its result — the side effect happened —
    // then the follow-up request overflowed. There is no assistant text, which
    // is exactly the shape the old guard mistook for "nothing has happened yet".
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.ts" } };
        yield { type: "tool-result", toolCallId: "c1", toolName: "write_file", input: {}, output: "written" };
        yield { type: "error", error: overflow() };
      })(),
      // The first step completed, so the SDK resolves with its messages.
      response: Promise.resolve({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.ts" } }],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { type: "text", value: "ok" } },
            ],
          },
        ],
      }),
      finishReason: Promise.resolve("error"),
    }));
    const ctx = makeCtx();

    const chunks = await runAndCollect(ctx);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(chunks.at(-1)).toEqual({ type: "done" });
  });

  it("still retries once when nothing ran and there is no partial text", async () => {
    streamTextMock
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: "error", error: overflow() };
        })(),
        response: handledRejection(noOutput()),
        finishReason: Promise.resolve("error"),
      }))
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: "text-delta", text: "recovered" };
        })(),
        response: Promise.resolve({ messages: [{ role: "assistant", content: "recovered" }] }),
        finishReason: Promise.resolve("stop"),
      }));
    const ctx = makeCtx();

    const chunks = await runAndCollect(ctx);

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(ctx.compactForContext).toHaveBeenLastCalledWith(
      expect.anything(),
      "sys",
      1000,
      expect.any(AbortSignal),
      expect.anything(),
      true, // forced relaxed compaction on the retry
    );
    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(chunks).toContainEqual({ type: "content", content: "recovered" });
    // The recovered overflow never reached the user as an error.
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
  });

  it("reports the real stream error, not the SDK's generic finalization error", async () => {
    // A second overflow after the one retry: nothing left to try.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "error", error: overflow() };
      })(),
      response: handledRejection(noOutput()),
      finishReason: Promise.resolve("error"),
    }));
    const ctx = makeCtx();

    const chunks = await runAndCollect(ctx);

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    const errors = chunks.filter((chunk) => chunk.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.content).toMatch(/maximum context length/);
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledWith(
      expect.stringMatching(/maximum context length/),
      expect.any(AbortSignal),
    );
  });

  it("does not re-run the turn when a tool call is in flight and the stream throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Same invariant on the outer catch path: the throw arrives after a tool
    // call was dispatched, so the turn must terminalize rather than replay.
    streamTextMock.mockImplementation(() => ({
      get fullStream() {
        return (async function* () {
          yield { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "rm -rf build" } };
          throw overflow();
        })();
      },
      response: handledRejection(overflow()),
      finishReason: Promise.resolve("error"),
    }));
    const ctx = makeCtx();

    await runAndCollect(ctx);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
  });
});
