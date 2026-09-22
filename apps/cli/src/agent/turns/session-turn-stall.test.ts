import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSession, ProviderStreamController } from "../../core/plugins";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: a provider-owned session can wait on its own subprocess forever.
// Before this guard the only wake source besides the user's abort was a
// provider event, so a wedged adapter left the turn with no terminal state,
// no Stop hook and the UI latched as busy — a wedge no restart could clear
// because nothing ever wrote a terminal record.
//
// This is a BACKSTOP. Adapter- and transport-level watchdogs are tighter and
// fire first; this one exists so coverage does not depend on every adapter
// remembering to guard itself.

const hostCwd = vi.hoisted(() => ({ dir: "/tmp" }));
vi.mock("../../core/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/plugins")>();
  return { ...actual, getHostServices: () => ({ bash: { cwd: () => hostCwd.dir } }) };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

beforeAll(async () => {
  await import("./session-turn");
}, 60_000);

beforeEach(() => {
  process.env.CODESURF_TURN_STALL_MS = "150";
});
afterEach(() => {
  process.env.CODESURF_TURN_STALL_MS = undefined;
  delete process.env.CODESURF_TURN_STALL_MS;
});

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
  return { adapterId: "wedged.adapter", providerId: "test", mode: "persistent", sendTurn };
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
      adapterId: "wedged.adapter",
      providerId: "test",
      session,
    },
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("provider-session stall backstop", () => {
  it("terminalizes a turn whose adapter never emits and never settles", async () => {
    const ctx = makeCtx();
    // Neither resolves nor emits — the exact shape of a hung subprocess.
    const chunks = await run(
      ctx,
      sessionOf(() => new Promise(() => {})),
    );

    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    const error = chunks.find((c) => c.type === "error");
    expect(error?.content).toMatch(/wedged\.adapter/);
    expect(error?.content).toMatch(/nothing for/i);
    expect(chunks.at(-1)).toEqual({ type: "done" });
  }, 10_000);

  it("is not reset by status pings, which prove the transport is alive but not the turn", async () => {
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      sessionOf((_input, controller: ProviderStreamController) => {
        const ping = setInterval(() => controller.emit({ type: "status", status: "streaming" }), 30);
        ping.unref?.();
        return new Promise(() => {});
      }),
    );

    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
  }, 10_000);

  it("is reset by real content, so a slow but progressing turn completes", async () => {
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      sessionOf(async (_input, controller: ProviderStreamController) => {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 50));
          controller.emit({ type: "text-delta", delta: `chunk ${i} ` });
        }
        controller.emit({ type: "done", stopReason: "end_turn" });
        return {};
      }),
    );

    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  }, 10_000);

  it("can be disabled outright", async () => {
    process.env.CODESURF_TURN_STALL_MS = "0";
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      sessionOf(async (_input, controller: ProviderStreamController) => {
        await new Promise((r) => setTimeout(r, 400));
        controller.emit({ type: "done", stopReason: "end_turn" });
        return {};
      }),
    );

    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  }, 10_000);
});
