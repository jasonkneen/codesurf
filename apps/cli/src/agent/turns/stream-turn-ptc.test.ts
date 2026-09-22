import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index";
import { RUN_CODE_TOOL } from "../tool-presentation";
import type { TurnContext } from "./types";

// PTC wire contract: under a code presentation the turn's ToolSet is exactly
// run_code and the SDK section joins the system prompt; native presentation
// leaves both untouched. The toolset builder itself is presentation-tested in
// tool-presentation.test.ts; this pins the stream-turn plumbing end to end
// with a scripted provider (no model, no network).

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };
const runCodeTool = { description: "run a program", inputSchema: {}, execute: vi.fn() } as never;

function makeCtx(toolset: { tools: ToolSet; sdkSection?: string }): TurnContext {
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
    buildSharedTurnToolset: vi.fn(async () => ({
      tools: toolset.tools,
      closeMcp: async () => {},
      mcpUnavailableMessage: null,
      ...(toolset.sdkSection !== undefined ? { sdkSection: toolset.sdkSection } : {}),
    })),
    executeBatchToolCall: vi.fn(),
    setCurrentProviderSession: vi.fn(),
  };
  return ctx;
}

async function runAndCollect(ctx: TurnContext, system = "BASE-SYSTEM") {
  const { runStreamTurn } = await import("./stream-turn");
  const observer = {};
  const chunks: StreamChunk[] = [];
  const calls: unknown[] = [];
  for await (const chunk of runStreamTurn(ctx, {
    userModelMessage,
    observer: observer as never,
    system,
    runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
    modelInfo: undefined as never,
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk);
    const call = streamTextMock.mock.calls.at(-1)?.[0] as { tools?: ToolSet; system?: string } | undefined;
    if (call && !calls.includes(call)) calls.push(call);
  }
  return { chunks, calls };
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("stream turn PTC wire contract", () => {
  it("sends exactly run_code and the SDK section when the toolset presents code", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "composed." };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "composed." }] }),
      finishReason: Promise.resolve("stop"),
    }));
    const ctx = makeCtx({
      tools: { [RUN_CODE_TOOL]: runCodeTool } as unknown as ToolSet,
      sdkSection: "SDK-MARKER: run_code instructions",
    });

    const { chunks, calls } = await runAndCollect(ctx);

    expect(chunks.at(-1)).toEqual({ type: "done" });
    const request = calls[0] as { tools?: ToolSet; system?: string };
    expect(Object.keys(request.tools ?? {}).sort()).toEqual([RUN_CODE_TOOL]);
    expect(request.system).toContain("BASE-SYSTEM");
    expect(request.system).toContain("SDK-MARKER: run_code instructions");
    expect(ctx.buildSharedTurnToolset).toHaveBeenCalledTimes(1);
  });

  it("leaves the system prompt untouched when no SDK section is present (native)", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "plain." };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "plain." }] }),
      finishReason: Promise.resolve("stop"),
    }));
    const ctx = makeCtx({ tools: { alpha: runCodeTool } as unknown as ToolSet });

    const { chunks, calls } = await runAndCollect(ctx);

    expect(chunks.at(-1)).toEqual({ type: "done" });
    const request = calls[0] as { tools?: ToolSet; system?: string };
    expect(Object.keys(request.tools ?? {}).sort()).toEqual(["alpha"]);
    expect(request.system).toBe("BASE-SYSTEM");
  });

  it("sizes compaction against the tool schemas and SDK section the request carries", async () => {
    // The estimate used to see only the base prompt, so a request whose tool
    // definitions pushed it over the window was judged to fit.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "ok" };
      })(),
      response: Promise.resolve({ messages: [{ role: "assistant", content: "ok" }] }),
      finishReason: Promise.resolve("stop"),
    }));
    const bigTool = {
      description: "query the warehouse",
      inputSchema: jsonSchema({ type: "object", properties: { WAREHOUSE_FIELD: { type: "string" } } }),
      execute: vi.fn(),
    };
    const ctx = makeCtx({
      tools: { mcp_db__query: bigTool } as unknown as ToolSet,
      sdkSection: "SDK-MARKER",
    });
    const { runStreamTurn } = await import("./stream-turn");
    for await (const _chunk of runStreamTurn(ctx, {
      userModelMessage,
      observer: {} as never,
      system: "BASE-SYSTEM",
      runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
      modelInfo: { contextWindow: 100_000 } as never,
      signal: new AbortController().signal,
    })) {
      // drain
    }

    const sized = (ctx.compactForContext as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sized).toContain("BASE-SYSTEM");
    expect(sized).toContain("SDK-MARKER");
    expect(sized).toContain("mcp_db__query");
    expect(sized).toContain("WAREHOUSE_FIELD");
    // Sizing input only — the wire system prompt carries no schema dump.
    const request = streamTextMock.mock.calls[0]?.[0] as { system?: string };
    expect(request.system).not.toContain("WAREHOUSE_FIELD");
  });
});
