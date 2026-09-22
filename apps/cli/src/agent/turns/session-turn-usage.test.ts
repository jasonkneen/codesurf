import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderSession, ProviderStreamController } from "../../core/plugins";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: cached input is billed but was not counted.
//
// Anthropic reports `input_tokens` as the cache-MISS slice, with cache reads
// in their own field, so a turn that reused a 40k prefix reported ~200 input
// tokens. The runner then overwrote the total with input + output, dropping
// the cache entirely — and the auto-loop budget reads that number.
//
// A failed turn's tokens are billed too, and were recorded nowhere.

const hostCwd = vi.hoisted(() => ({ dir: "/tmp" }));
vi.mock("../../core/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/plugins")>();
  return { ...actual, getHostServices: () => ({ bash: { cwd: () => hostCwd.dir } }) };
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

function sessionOf(sendTurn: NonNullable<ProviderSession["sendTurn"]>): ProviderSession {
  return { adapterId: "test.adapter", providerId: "test", mode: "persistent", sendTurn };
}

async function run(ctx: TurnContext, session: ProviderSession) {
  const { runSessionTurn } = await import("./session-turn");
  const chunks: StreamChunk[] = [];
  for await (const chunk of runSessionTurn(ctx, {
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
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("totalBilledTokens", () => {
  it("counts the cache slices alongside the cache-miss input", async () => {
    const { totalBilledTokens } = await import("../../core/plugins/builtin/provider-usage");
    // The canonical cached-turn fixture: a large reused prefix, a tiny miss.
    expect(totalBilledTokens({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 40_000 })).toBe(40_250);
    expect(totalBilledTokens({ inputTokens: 8, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 })).toBe(15);
  });

  it("keeps the full total when no cache slice was reported", async () => {
    const { totalBilledTokens } = await import("../../core/plugins/builtin/provider-usage");
    expect(totalBilledTokens({ inputTokens: 12, outputTokens: 3 })).toBe(15);
    expect(totalBilledTokens({})).toBe(0);
  });
});

describe("provider-session usage accounting", () => {
  it("records cached input in the turn total", async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      sessionOf(async (_input, controller: ProviderStreamController) => {
        controller.emit({
          type: "usage",
          usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 40_000, cacheWriteTokens: 120 },
        });
        controller.emit({ type: "done", stopReason: "end_turn" });
        return {};
      }),
    );

    expect(ctx.recordUsage).toHaveBeenCalledTimes(1);
    const [usage] = (ctx.recordUsage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 40_000, cacheWriteTokens: 120 });
    expect(usage.totalTokens).toBe(40_370);
  });

  it("records the tokens a failed turn still burned", async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      sessionOf(async (_input, controller: ProviderStreamController) => {
        controller.emit({ type: "usage", usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 12_000 } });
        controller.emit({ type: "error", message: "upstream died" });
        return {};
      }),
    );

    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(ctx.recordUsage).toHaveBeenCalledTimes(1);
    const [usage] = (ctx.recordUsage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(usage.totalTokens).toBe(12_930);
  });

  it("does not record anything when the provider reported no usage", async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      sessionOf(async (_input, controller: ProviderStreamController) => {
        controller.emit({ type: "done", stopReason: "end_turn" });
        return {};
      }),
    );

    expect(ctx.recordUsage).not.toHaveBeenCalled();
  });
});
