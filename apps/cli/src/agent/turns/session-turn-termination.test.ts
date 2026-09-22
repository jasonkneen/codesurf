import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderSession, ProviderStreamController, ProviderStreamEvent } from "../../core/plugins";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: end-of-stream must be CLASSIFIED, not assumed successful.
//
// Two ways a failed provider turn used to settle as a clean Stop:
//   - sendTurn resolves without ever emitting `done` (the queue's own
//     finally-push looked identical to a real terminator)
//   - the shared stdio transports emit `{done, stopReason:"error"}` and no
//     `error` event at all, so the failure had no other channel to arrive on
//
// A turn that ran out of room ("length") is truncated, not failed — it warns
// and still settles as Stop, matching the streamText path.

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

function scriptedSession(events: ProviderStreamEvent[]): ProviderSession {
  return {
    adapterId: "test.adapter",
    providerId: "test",
    mode: "persistent",
    sendTurn: async (_input, controller: ProviderStreamController) => {
      for (const event of events) controller.emit(event);
      return {};
    },
  };
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

describe("provider-session end-of-stream classification", () => {
  it("fails a turn whose sendTurn resolved without emitting done", async () => {
    const ctx = makeCtx();
    const chunks = await run(ctx, scriptedSession([{ type: "text-delta", delta: "half an ans" }]));

    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    // The partial text is still delivered and still committed.
    expect(chunks).toContainEqual({ type: "content", content: "half an ans" });
    expect(ctx.appendCompletedTurn).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)).toEqual({ type: "done" });
  });

  it("fails a turn the transport terminated with stopReason error", async () => {
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      scriptedSession([
        { type: "text-delta", delta: "partial" },
        { type: "done", stopReason: "error" },
      ]),
    );

    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
  });

  it("fails a turn that ran out of turns rather than finishing", async () => {
    const ctx = makeCtx();
    await run(ctx, scriptedSession([{ type: "done", stopReason: "error_max_turns" }]));

    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
  });

  it("treats the Responses API's `incomplete` as truncation, not failure", async () => {
    // `response.incomplete` means max_output_tokens or a content filter cut
    // the reply short — a real answer, the same shape as `length`.
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      scriptedSession([
        { type: "text-delta", delta: "a partial answer" },
        { type: "done", stopReason: "incomplete" },
      ]),
    );

    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.type === "warning")?.content).toMatch(/token limit/i);
  });

  it("warns but still succeeds when the model hit its output limit", async () => {
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      scriptedSession([
        { type: "text-delta", delta: "a long answer cut off" },
        { type: "done", stopReason: "length" },
      ]),
    );

    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
    const warning = chunks.find((c) => c.type === "warning");
    expect(warning?.content).toMatch(/token limit/i);
  });

  it("still succeeds on an ordinary terminator", async () => {
    const ctx = makeCtx();
    const chunks = await run(
      ctx,
      scriptedSession([
        { type: "text-delta", delta: "all done" },
        { type: "done", stopReason: "end_turn" },
      ]),
    );

    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  it("still succeeds on a provider vocabulary it does not recognise", async () => {
    // Several adapters pass their upstream's own finish reason straight
    // through; an unfamiliar one must not be read as a failure.
    const ctx = makeCtx();
    await run(ctx, scriptedSession([{ type: "done", stopReason: "some_provider_specific_finish" }]));

    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
  });

  it("still treats an abort terminator as a cancellation, not a failure", async () => {
    const ctx = makeCtx();
    await run(ctx, scriptedSession([{ type: "done", stopReason: "aborted" }]));

    expect(ctx.terminalizeCancelledTurn).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
  });
});
