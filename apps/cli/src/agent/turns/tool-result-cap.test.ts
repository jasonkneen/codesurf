import type { ModelMessage } from "ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderSession, ProviderStreamController } from "../../core/plugins";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: tool results entered the transcript unbounded.
//
// The native tools cap themselves (read_file at 512KB, grep at 64KB records,
// bash at an 8KB tail), but nothing capped an MCP tool or a provider-owned one
// — a Claude CLI `Read` of a 5MB file landed whole in the transcript and was
// persisted, so every later turn re-sent it.
//
// The cap sits at the native ceiling, so no in-tree tool changes behaviour and
// only genuinely unbounded external output is elided.

const hostCwd = vi.hoisted(() => ({ dir: "/tmp" }));
vi.mock("../../core/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/plugins")>();
  return { ...actual, getHostServices: () => ({ bash: { cwd: () => hostCwd.dir } }) };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

beforeAll(async () => {
  await import("./session-turn");
}, 60_000);

afterEach(() => {
  delete process.env.CODESURF_TOOL_RESULT_MAX_BYTES;
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

describe("capToolOutput", () => {
  it("leaves output under the cap byte-identical", async () => {
    const { capToolOutput } = await import("./helpers");
    expect(capToolOutput("small")).toBe("small");
  });

  it("elides oversized output and names the size and the way forward", async () => {
    process.env.CODESURF_TOOL_RESULT_MAX_BYTES = "100";
    const { capToolOutput } = await import("./helpers");
    const capped = capToolOutput("x".repeat(5_000));

    expect(capped.length).toBeLessThan(1_000);
    expect(capped).toContain("x".repeat(50));
    expect(capped).toMatch(/5,?000 bytes|5000 bytes/);
    // The model has to know it can get the rest a different way, or it will
    // assume the tool simply returned this much.
    expect(capped).toMatch(/elided|truncat/i);
    expect(capped).toMatch(/narrower|again|re-?run|smaller/i);
  });

  it("counts bytes rather than characters", async () => {
    process.env.CODESURF_TOOL_RESULT_MAX_BYTES = "100";
    const { capToolOutput } = await import("./helpers");
    // Four bytes per emoji: 50 of them is 200 bytes, over a 100 byte cap.
    const capped = capToolOutput("🙂".repeat(50));
    expect(Buffer.byteLength(capped, "utf-8")).toBeLessThan(1_000);
    expect(capped).toMatch(/elided|truncat/i);
  });
});

describe("toToolResult capping", () => {
  it("caps a large successful output and keeps the success flag", async () => {
    process.env.CODESURF_TOOL_RESULT_MAX_BYTES = "100";
    const { toToolResult } = await import("./helpers");
    const result = toToolResult({ success: true, output: "y".repeat(10_000) });

    expect(result.success).toBe(true);
    expect(result.output?.length ?? 0).toBeLessThan(1_000);
    expect(result.output).toMatch(/elided|truncat/i);
  });

  it("caps a large error and keeps is-error", async () => {
    process.env.CODESURF_TOOL_RESULT_MAX_BYTES = "100";
    const { toToolResult } = await import("./helpers");
    const result = toToolResult({ success: false, error: "z".repeat(10_000) });

    expect(result.success).toBe(false);
    expect(result.error?.length ?? 0).toBeLessThan(1_000);
  });
});

describe("provider tool results", () => {
  it("caps an oversized provider tool result before it is persisted", async () => {
    process.env.CODESURF_TOOL_RESULT_MAX_BYTES = "200";
    const ctx = makeCtx();
    await run(ctx, {
      adapterId: "test.adapter",
      providerId: "test",
      mode: "persistent",
      sendTurn: async (_input, controller: ProviderStreamController) => {
        controller.emit({ type: "tool-call", id: "t1", toolName: "Read", args: { file_path: "big.log" } });
        controller.emit({ type: "tool-result", id: "t1", result: "L".repeat(500_000) });
        controller.emit({ type: "done", stopReason: "end_turn" });
        return {};
      },
    });

    const persisted = (ctx.appendCompletedTurn as ReturnType<typeof vi.fn>).mock.calls[0][1] as ModelMessage[];
    const serialized = JSON.stringify(persisted);
    expect(serialized.length).toBeLessThan(10_000);
    expect(serialized).toMatch(/elided|truncat/i);
  });
});
