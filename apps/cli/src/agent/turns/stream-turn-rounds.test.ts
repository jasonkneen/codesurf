import type { ModelMessage, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Round-trip counting for stream-turn: rounds = number of tool-call BATCHES the
// model emits (one per distinct tool-calling response), NOT one per tool call.
// This is the metric the PTC-vs-native bench reports; it must count runs of
// consecutive tool-call parts once each.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

function makeCtx(toolset: { tools: ToolSet }): TurnContext {
  const ctx: TurnContext = {
    getMessages: () => [userModelMessage],
    mode: "agent",
    maxToolRounds: 6,
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
    buildSharedTurnToolset: vi.fn(async () => ({
      tools: toolset.tools,
      closeMcp: async () => {},
      mcpUnavailableMessage: null,
    })),
    executeBatchToolCall: vi.fn(),
    setCurrentProviderSession: vi.fn(),
  };
  return ctx;
}

async function drive(tools: ToolSet, parts: unknown[], onStepFinish?: (info: { rounds?: number }) => void) {
  streamTextMock.mockImplementation((opts: { onStepFinish?: (info: unknown) => void }) => ({
    fullStream: (async function* () {
      for (const part of parts) yield part;
      opts.onStepFinish?.({ stepNumber: 1 });
    })(),
    response: Promise.resolve({ messages: [] }),
    finishReason: Promise.resolve("stop"),
  }));
  const { runStreamTurn } = await import("./stream-turn");
  const observer = { onStepFinish };
  const chunks: StreamChunk[] = [];
  for await (const chunk of runStreamTurn(makeCtx({ tools }), {
    userModelMessage,
    observer: observer as never,
    system: "S",
    runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
    modelInfo: undefined as never,
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

const t1 = { description: "t1", inputSchema: {}, execute: vi.fn() } as never;
const t2 = { description: "t2", inputSchema: {}, execute: vi.fn() } as never;
const t3 = { description: "t3", inputSchema: {}, execute: vi.fn() } as never;
const tools = { t1, t2, t3 } as unknown as ToolSet;

describe("stream turn round-trip counting", () => {
  it("counts one round per tool-call batch, not per tool call", async () => {
    let rounds: number | undefined;
    const parts = [
      { type: "tool-call", toolCallId: "a", toolName: "t1", input: {} },
      { type: "tool-call", toolCallId: "b", toolName: "t2", input: {} },
      { type: "tool-result", toolCallId: "a", toolName: "t1", input: {}, output: { ok: true } },
      { type: "tool-result", toolCallId: "b", toolName: "t2", input: {}, output: { ok: true } },
      { type: "tool-call", toolCallId: "c", toolName: "t3", input: {} },
      { type: "text-delta", text: "done." },
    ];
    await drive(tools, parts, (info) => {
      rounds = info.rounds;
    });
    expect(rounds).toBe(2); // batch [a,b] = 1, batch [c] = 1
  });

  it("counts zero rounds for a pure-text turn", async () => {
    let rounds: number | undefined;
    await drive(tools, [{ type: "text-delta", text: "no tools here." }], (info) => {
      rounds = info.rounds;
    });
    expect(rounds).toBe(0);
  });
});
