import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

// Regression: cancelling a turn spliced the user's message back out of the
// transcript, leaving no trace it ever happened.
//
// That is fine for a turn that did nothing. It is not fine for an owning
// adapter (Claude CLI, Codex), whose subprocess keeps its OWN history: the
// user turn, the partial answer and any tools it already ran. The two
// transcripts then disagree permanently, and the mirror is what feeds the
// resume preface, the compaction summariser and any model switch — so the
// model is told work it actually did never happened, and may redo it.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

type Internals = { messages: ModelMessage[]; messageSeqs: Array<number | null> };

async function newAgent() {
  vi.resetModules();
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

async function drain(generator: AsyncGenerator<unknown>) {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

const textOf = (message: ModelMessage | undefined): string =>
  typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("a cancelled turn", () => {
  it("keeps the user message and records that tools may have run", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "on it" };
        agent.abort();
        yield { type: "text-delta", text: "never delivered" };
      })(),
      response: Promise.resolve({ messages: [] }),
      finishReason: Promise.resolve("stop"),
    }));

    const chunks = await drain(agent.processMessage("refactor the parser"));

    expect(chunks).toContainEqual({ type: "content", content: "\n\n[Cancelled]" });
    const user = internals.messages.find((m) => m.role === "user");
    expect(textOf(user)).toContain("refactor the parser");

    const note = internals.messages[internals.messages.length - 1];
    expect(note?.role).toBe("assistant");
    // The model has to be told the gap is a gap, or it assumes the turn never
    // happened and repeats work the adapter already did.
    expect(textOf(note)).toMatch(/cancel/i);
    expect(textOf(note)).toMatch(/may have|already/i);
    expect(internals.messages.length).toBe(internals.messageSeqs.length);
  });

  it("leaves the next turn with a well-formed history to build on", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          agent.abort();
          yield { type: "text-delta", text: "never delivered" };
        })(),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve("stop"),
      }))
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: "text-delta", text: "second answer" };
        })(),
        response: Promise.resolve({ messages: [{ role: "assistant", content: "second answer" }] }),
        finishReason: Promise.resolve("stop"),
      }));

    await drain(agent.processMessage("first"));
    await drain(agent.processMessage("second"));

    // user, cancellation note, user, assistant — alternating and complete.
    expect(internals.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(internals.messages.length).toBe(internals.messageSeqs.length);
  });

  it("records nothing when the turn was cancelled before a user message existed", async () => {
    const { agent, internals } = await newAgent();
    agent.abort();

    expect(internals.messages).toHaveLength(0);
  });
});

describe("cancelling the continuation after an approval", () => {
  it("leaves no tool call unanswered", async () => {
    const { agent, internals } = await newAgent();
    streamTextMock
      // Turn 1 parks on an approval and COMMITS the tool call.
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield {
            type: "tool-approval-request",
            approvalId: "ap-1",
            toolCall: { toolCallId: "call-1", toolName: "write_file", input: { path: "a.ts" } },
          };
        })(),
        response: Promise.resolve({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "call-1", toolName: "write_file", input: { path: "a.ts" } }],
            },
          ],
        }),
        finishReason: Promise.resolve("tool-calls"),
      }))
      // The continuation is interrupted before the approved tool ever runs.
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          agent.abort();
          yield { type: "text-delta", text: "never delivered" };
        })(),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve("stop"),
      }));

    await drain(agent.processMessage("edit the file"));
    agent.respondToToolApproval("ap-1", true);
    await drain(agent.continueAfterToolApproval());

    const calls: string[] = [];
    const answered = new Set<string>();
    for (const message of internals.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "tool-call") calls.push(String(part.toolCallId));
        if (part.type === "tool-result") answered.add(String(part.toolCallId));
      }
    }
    // The approval was granted but the tool never ran, so nothing but a
    // synthesized result can close the call.
    expect(calls.filter((id) => !answered.has(id))).toEqual([]);
    expect(internals.messages.length).toBe(internals.messageSeqs.length);
  });
});

describe("a failed turn that committed nothing", () => {
  it("keeps the user message with a failure note, like a cancelled turn", async () => {
    // Without the note the user message sat in memory unpersisted: the next
    // turn writes only its own message, so a resume lost this one while the
    // model had already been sent it.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, internals } = await newAgent();
    const rejected = Promise.reject(new Error("No output generated."));
    rejected.catch(() => {});
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield { type: "error", error: new Error("401 invalid x-api-key") };
      })(),
      response: rejected,
      finishReason: Promise.resolve("error"),
    }));

    await drain(agent.processMessage("hello"));

    expect(internals.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(internals.messages[1])).toMatch(/Turn failed.*invalid x-api-key/);
    expect(internals.messageSeqs).toHaveLength(internals.messages.length);
  });
});
