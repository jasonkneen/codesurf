import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regression: the paid_request approval prompt ran its OWN probe of the
// endpoint and showed the server's first payment option. `execute` pays the
// option `needsApproval` selected and stored for this call's input, which
// need not be the first — so the user could approve terms (and a recipient)
// other than the ones that get paid.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const quoteMock = vi.hoisted(() => vi.fn());
vi.mock("../../core/plugins/native/payments-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/plugins/native/payments-tools")>();
  return { ...actual, getPaidRequestApprovalQuote: quoteMock };
});
vi.mock("../../payments/brin", () => ({ scanUrl: async () => null }));

const userModelMessage: ModelMessage = { role: "user", content: "buy the report" };
const input = { url: "https://paid.example/report", method: "GET" };

function makeCtx(): TurnContext {
  return {
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
}

async function approvalChunk() {
  streamTextMock.mockImplementation(() => ({
    fullStream: (async function* () {
      yield { type: "tool-call", toolCallId: "c1", toolName: "paid_request", input };
      yield {
        type: "tool-approval-request",
        approvalId: "ap-1",
        toolCall: { toolCallId: "c1", toolName: "paid_request", input },
      };
    })(),
    response: Promise.resolve({ messages: [] }),
    finishReason: Promise.resolve("tool-calls"),
  }));
  const { runStreamTurn } = await import("./stream-turn");
  const chunks: StreamChunk[] = [];
  for await (const chunk of runStreamTurn(makeCtx(), {
    userModelMessage,
    observer: {},
    system: "sys",
    runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
    modelInfo: undefined as never,
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  return chunks.find((chunk) => chunk.type === "tool_approval_request");
}

afterEach(() => {
  streamTextMock.mockReset();
  quoteMock.mockReset();
  vi.restoreAllMocks();
});

describe("paid_request approval precheck", () => {
  it("shows the quote needsApproval stored for this call, including who gets paid", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    quoteMock.mockReturnValue({
      kind: "payment",
      option: { scheme: "exact", network: "base", asset: "USDC", amount: "250000", payTo: "0xSECOND" },
      description: "Quarterly report",
    });

    const chunk = await approvalChunk();

    expect(quoteMock).toHaveBeenCalledWith(input);
    expect(chunk?.paymentPrecheck).toMatchObject({
      amount: "250000",
      network: "base",
      asset: "USDC",
      payTo: "0xSECOND",
      description: "Quarterly report",
    });
    // No second probe of the endpoint from the turn loop.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says no terms were fetched when there is no stored quote", async () => {
    quoteMock.mockReturnValue(undefined);

    const chunk = await approvalChunk();

    expect(chunk?.paymentPrecheck?.description).toBe("No payment terms were fetched for this request.");
    expect(chunk?.paymentPrecheck?.payTo).toBeUndefined();
  });

  it("explains an unavailable quote instead of showing blank terms", async () => {
    quoteMock.mockReturnValue({ kind: "unavailable", reason: "no option on base" });

    const chunk = await approvalChunk();

    expect(chunk?.paymentPrecheck?.description).toBe("Payment terms unavailable: no option on base");
  });
});
