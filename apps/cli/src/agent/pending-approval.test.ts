import type { ModelMessage } from "ai";
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

// Regression: a turn can end parked on a tool approval. That is fine while the
// user is deciding — but if they type a new instruction instead of answering,
// the parked `tool-call` never gets a result and the NEXT request carries it,
// which providers reject.
//
// Only the UI's approval panel stopped that from happening, by capturing
// input; nothing in the turn engine did, and headless / Telegram / relay
// entry points never go through that panel.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

type Internals = {
  messages: ModelMessage[];
  messageSeqs: Array<number | null>;
  pendingApprovalId: string | null;
};

async function newAgent() {
  vi.resetModules();
  // Every service stays real except model resolution, which would otherwise
  // demand a loaded xAI extension and a live session.
  vi.doMock("./../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("./../core/plugins")>("./../core/plugins");
    return {
      ...actual,
      resolveModelRuntimeViaKernel: async () => ({
        model: {} as never,
        modelId: "test-model",
        modelInfo: undefined,
        providerOptions: undefined,
      }),
      runtimeUsesSendTurn: () => false,
    };
  });
  const { setBashSink } = await import("./../core/plugins");
  setBashSink(buildMockBashSink().sink);
  const { Agent } = await import("./agent");
  const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });
  return { agent, internals: agent as unknown as Internals };
}

/** One streamText turn that parks on an approval and commits nothing else. */
function parksOnApproval(approvalId: string) {
  return () => ({
    fullStream: (async function* () {
      yield {
        type: "tool-approval-request",
        approvalId,
        toolCall: { toolCallId: "call-1", toolName: "write_file", input: { path: "a.ts" } },
      };
    })(),
    // The shape ai v6 `toResponseMessages` commits for a parked call: the
    // call plus the approval request that names it, and no result.
    response: Promise.resolve({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "write_file", input: { path: "a.ts" } },
            { type: "tool-approval-request", approvalId, toolCallId: "call-1" },
          ],
        },
      ],
    }),
    finishReason: Promise.resolve("tool-calls"),
  });
}

function saysOk() {
  return () => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" };
    })(),
    response: Promise.resolve({ messages: [{ role: "assistant", content: "ok" }] }),
    finishReason: Promise.resolve("stop"),
  });
}

async function drain(generator: AsyncGenerator<unknown>) {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

/**
 * toolCallIds with no tool-result.
 *
 * A `tool-approval-response` deliberately does not count: the SDK only acts on
 * one while it is the LAST message, and strips it from the wire otherwise.
 */
function unanswered(messages: ModelMessage[]): string[] {
  const calls: string[] = [];
  const answered = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "tool-call") calls.push(String(part.toolCallId));
      if (part.type === "tool-result") answered.add(String(part.toolCallId));
    }
  }
  return calls.filter((id) => !answered.has(id));
}

/**
 * Run the history through the SDK's own prompt conversion — what streamText
 * does before any provider sees it — and return the calls that reach the wire
 * without a result. Providers reject every one of those with a 400.
 */
async function unansweredOnTheWire(messages: ModelMessage[]): Promise<string[]> {
  const standardized = await standardizePrompt({ system: "sys", messages });
  const prompt = await convertToLanguageModelPrompt({
    prompt: standardized,
    supportedUrls: {},
    download: undefined,
  });
  const calls: string[] = [];
  const answered = new Set<string>();
  for (const message of prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      if (part.type === "tool-call") calls.push(String(part.toolCallId));
      if (part.type === "tool-result") answered.add(String(part.toolCallId));
    }
  }
  return calls.filter((id) => !answered.has(id));
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("a turn parked on a tool approval", () => {
  it("is settled when the user sends a new message instead of deciding", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock.mockImplementationOnce(parksOnApproval("ap-1")).mockImplementationOnce(saysOk());

    await drain(agent.processMessage("edit the file"));
    expect(internals.pendingApprovalId).toBe("ap-1");
    expect(unanswered(internals.messages)).toEqual(["call-1"]);

    await drain(agent.processMessage("actually, never mind — what's in the README?"));

    expect(internals.pendingApprovalId).toBeNull();
    expect(unanswered(internals.messages)).toEqual([]);
    const denial = internals.messages.find((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>).some(
            (p) => p.type === "tool-result" && p.toolCallId === "call-1",
          )
        : false,
    );
    expect(denial).toBeDefined();
    expect((denial?.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      toolName: "write_file",
      output: { type: "execution-denied" },
    });
    // What the second request actually carried, through the SDK's conversion.
    const secondRequest = streamTextMock.mock.calls[1]?.[0] as { messages: ModelMessage[] };
    expect(await unansweredOnTheWire(secondRequest.messages)).toEqual([]);
    // The denial has to precede the new user message, or the call is still
    // open at the point the model reads the new instruction.
    const denialIndex = internals.messages.indexOf(denial as ModelMessage);
    const userIndex = internals.messages.findIndex(
      (m) => m.role === "user" && String(m.content).includes("never mind"),
    );
    expect(denialIndex).toBeLessThan(userIndex);
    expect(internals.messages.length).toBe(internals.messageSeqs.length);
  });

  it("holds a background notification until the parked call is settled", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock.mockImplementationOnce(parksOnApproval("ap-1")).mockImplementationOnce(saysOk());

    await drain(agent.processMessage("edit the file"));
    // The UI poll delivers between turns, while the approval is still parked.
    agent.deliverBackgroundNotifications([{ id: "d1", message: "Delegation d1 finished." }]);
    expect(internals.messages.at(-1)?.role).toBe("assistant");

    await drain(agent.processMessage("never mind"));

    const roles = internals.messages.map((m) => m.role);
    const denialIndex = internals.messages.findIndex((m) => m.role === "tool");
    const reminderIndex = internals.messages.findIndex(
      (m) => m.role === "user" && String(m.content).includes("Delegation d1 finished."),
    );
    // call → denial → reminder → new user message: nothing between the call
    // and its result, and never a mid-conversation system message.
    expect(roles).not.toContain("system");
    expect(denialIndex).toBe(2);
    expect(reminderIndex).toBe(3);
    expect(String(internals.messages[reminderIndex]?.content)).toMatch(/^<system-reminder>/);
    const request = streamTextMock.mock.calls[1]?.[0] as { messages: ModelMessage[] };
    expect(await unansweredOnTheWire(request.messages)).toEqual([]);
  });

  it("leaves the approval alone when the user actually answers it", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock.mockImplementationOnce(parksOnApproval("ap-1"));

    await drain(agent.processMessage("edit the file"));
    expect(internals.pendingApprovalId).toBe("ap-1");

    agent.respondToToolApproval("ap-1", true);

    expect(internals.pendingApprovalId).toBeNull();
    const responses = internals.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>).filter((p) => p.type === "tool-approval-response")
        : [],
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ approvalId: "ap-1", approved: true });
  });

  it("closes a granted call whose continuation fails before the tool runs", async () => {
    const { agent, internals } = await newAgent();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rejected = Promise.reject(new Error("No output generated. Check the stream for errors."));
    rejected.catch(() => {});
    streamTextMock
      .mockImplementationOnce(parksOnApproval("ap-1"))
      // The continuation request dies before its first step: the SDK never
      // got to run the approved call.
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: "error", error: new Error("529 overloaded") };
        })(),
        response: rejected,
        finishReason: Promise.resolve("error"),
      }))
      .mockImplementationOnce(saysOk());

    await drain(agent.processMessage("edit the file"));
    agent.respondToToolApproval("ap-1", true);
    await drain(agent.continueAfterToolApproval());
    await drain(agent.processMessage("try something else"));

    expect(unanswered(internals.messages)).toEqual([]);
    const request = streamTextMock.mock.calls[2]?.[0] as { messages: ModelMessage[] };
    expect(await unansweredOnTheWire(request.messages)).toEqual([]);
    expect(internals.messages.length).toBe(internals.messageSeqs.length);
  });

  it("does not touch the transcript when no approval is outstanding", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock.mockImplementation(saysOk());

    await drain(agent.processMessage("hello"));
    const afterFirst = internals.messages.length;
    await drain(agent.processMessage("again"));

    expect(internals.pendingApprovalId).toBeNull();
    // user + assistant per turn, and nothing synthesized in between.
    expect(internals.messages.length).toBe(afterFirst * 2);
    expect(
      internals.messages.some((m) =>
        Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>).some((p) => p.type === "tool-approval-response")
          : false,
      ),
    ).toBe(false);
  });
});

describe("an approval parked by a turn that never committed it", () => {
  it("is not answered on the next turn when the parked turn was cancelled", async () => {
    const { agent, internals } = await newAgent();
    // The approval chunk is yielded, then the user interrupts. The tool-call
    // never reaches the transcript, so answering it on the next turn would
    // create an approval-response for a call that exists nowhere.
    streamTextMock
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield {
            type: "tool-approval-request",
            approvalId: "ap-1",
            toolCall: { toolCallId: "call-1", toolName: "write_file", input: { path: "a.ts" } },
          };
          agent.abort();
          yield { type: "text-delta", text: "never delivered" };
        })(),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve("stop"),
      }))
      .mockImplementationOnce(saysOk());

    await drain(agent.processMessage("edit the file"));
    await drain(agent.processMessage("do something else"));

    const responses = internals.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>).filter((p) => p.type === "tool-approval-response")
        : [],
    );
    expect(responses).toEqual([]);
    expect(unanswered(internals.messages)).toEqual([]);
  });

  it("is not answered on the next turn when the parked turn failed to commit", async () => {
    const { agent, internals } = await newAgent();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rejected = Promise.reject(new Error("stream died"));
    rejected.catch(() => {});
    streamTextMock
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield {
            type: "tool-approval-request",
            approvalId: "ap-1",
            toolCall: { toolCallId: "call-1", toolName: "write_file", input: { path: "a.ts" } },
          };
        })(),
        response: rejected,
        finishReason: Promise.resolve("error"),
      }))
      .mockImplementationOnce(saysOk());

    await drain(agent.processMessage("edit the file"));
    await drain(agent.processMessage("do something else"));

    const responses = internals.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>).filter((p) => p.type === "tool-approval-response")
        : [],
    );
    expect(responses).toEqual([]);
  });
});
