import type { ModelMessage } from "ai";
import { asLanguageModelUsage } from "ai/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryMixin } from "../mixins/telemetry";
import type { TurnContext } from "./types";

// Regression: cache tokens were double-counted on the streamText path.
//
// ai v6 reports `usage.inputTokens` as the WHOLE prompt — cache reads and
// writes included — with the split under `inputTokenDetails`. Telemetry
// treated it as the cache-miss remainder (the provider-session convention)
// and added the cache fields on top, so every cached turn was billed for its
// prefix twice (three times over for a cache write, which was also folded in
// again from provider metadata). The usage below is built by the SDK's own
// converter, from what the Anthropic provider reports.

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

/** A streamText stub that fires `onFinish` the way the SDK does. */
function respondsWith(finish: { totalUsage: unknown; providerMetadata?: unknown }) {
  return (options: { onFinish?: (event: unknown) => void }) => {
    options.onFinish?.(finish);
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "done" };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "done" }] }),
      finishReason: Promise.resolve("stop"),
    };
  };
}

async function run(ctx: TurnContext) {
  const { runStreamTurn } = await import("./stream-turn");
  for await (const _chunk of runStreamTurn(ctx, {
    userModelMessage,
    observer: {},
    system: "sys",
    runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
    modelInfo: undefined as never,
    signal: new AbortController().signal,
  })) {
    // drain
  }
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

/** The real telemetry recorder, standing alone (no session, no host). */
function makeRecorder() {
  const Recorder = TelemetryMixin(class {});
  const recorder = new Recorder() as InstanceType<typeof Recorder> & {
    session: null;
    activeTrace: { addUsage: ReturnType<typeof vi.fn> };
    lastTurnUsage: { cacheReadTokens?: number; cacheWriteTokens?: number; inputTokens?: number } | null;
  };
  recorder.session = null;
  recorder.activeTrace = { addUsage: vi.fn() };
  recorder.lastTurnUsage = null;
  return recorder;
}

describe("streamText usage accounting", () => {
  it("bills a cached Anthropic turn for its prefix exactly once", async () => {
    const totalUsage = asLanguageModelUsage({
      inputTokens: { total: 38_120, noCache: 120, cacheRead: 30_000, cacheWrite: 8_000 },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
    });
    streamTextMock.mockImplementation(
      respondsWith({ totalUsage, providerMetadata: { anthropic: { cacheCreationInputTokens: 8_000 } } }),
    );
    const recorder = makeRecorder();
    const ctx = makeCtx();
    ctx.recordUsage = (usage, source, model) => recorder.recordUsage(usage, source, model);

    await run(ctx);

    // 120 fresh + 30k read + 8k written + 40 out — once each.
    expect(recorder.activeTrace.addUsage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 38_160, inputTokens: 120 }),
    );
    expect(recorder.lastTurnUsage).toEqual({ cacheReadTokens: 30_000, cacheWriteTokens: 8_000, inputTokens: 120 });
  });

  it("uses the provider's own total for an uncached turn", async () => {
    const totalUsage = asLanguageModelUsage({
      inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
    });
    streamTextMock.mockImplementation(respondsWith({ totalUsage, providerMetadata: { openai: { somethingElse: 1 } } }));
    const recorder = makeRecorder();
    const ctx = makeCtx();
    ctx.recordUsage = (usage, source, model) => recorder.recordUsage(usage, source, model);

    await run(ctx);

    expect(recorder.activeTrace.addUsage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 160, inputTokens: 120 }),
    );
    expect(recorder.lastTurnUsage?.cacheWriteTokens).toBeUndefined();
  });

  it("keeps the provider-session convention (inputTokens already the miss remainder)", () => {
    const recorder = makeRecorder();

    recorder.recordUsage({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 30_000, cacheWriteTokens: 8_000 });

    expect(recorder.activeTrace.addUsage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 38_160, inputTokens: 120 }),
    );
  });
});
