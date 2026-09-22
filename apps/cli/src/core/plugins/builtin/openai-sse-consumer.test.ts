import { describe, expect, it } from "vitest";
import type { ProviderStreamEvent } from "../api";
import { consumeOpenAiSseStream, MAX_SSE_EVENT_CHARS, splitReadableTextDelta } from "./openai-sse-consumer";

const encoder = new TextEncoder();

function streamFromChunks(chunks: Array<string | Uint8Array>, options: { close?: boolean } = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      if (options.close !== false) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

async function consume(chunks: Array<string | Uint8Array>, options: { maxEventChars?: number } = {}) {
  const events: ProviderStreamEvent[] = [];
  const usage = await consumeOpenAiSseStream(streamFromChunks(chunks).stream, {
    controller: { emit: (event) => events.push(event) },
    ...options,
  });
  return { events, usage };
}

const data = (payload: unknown) => `data: ${JSON.stringify(payload)}`;

/** Render SSE blocks (one `data:` line each) with the given line terminator. */
function frame(blocks: string[], terminator: string): string {
  return blocks.map((block) => `${block}${terminator}${terminator}`).join("");
}

function textOf(events: ProviderStreamEvent[]): string {
  return events
    .filter((event): event is Extract<ProviderStreamEvent, { type: "text-delta" }> => event.type === "text-delta")
    .map((event) => event.delta)
    .join("");
}

function doneEvents(events: ProviderStreamEvent[]) {
  return events.filter((event): event is Extract<ProviderStreamEvent, { type: "done" }> => event.type === "done");
}

const HELLO_BLOCKS = [
  data({ choices: [{ delta: { content: "hello" }, finish_reason: null }] }),
  data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  "data: [DONE]",
];

describe("consumeOpenAiSseStream framing", () => {
  it("produces identical output for LF, CRLF and bare-CR framed streams", async () => {
    const lf = await consume([frame(HELLO_BLOCKS, "\n")]);
    const crlf = await consume([frame(HELLO_BLOCKS, "\r\n")]);
    const cr = await consume([frame(HELLO_BLOCKS, "\r")]);

    expect(textOf(lf.events)).toBe("hello");
    expect(lf.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(crlf.events).toEqual(lf.events);
    expect(crlf.usage).toEqual(lf.usage);
    expect(cr.events).toEqual(lf.events);
    expect(cr.usage).toEqual(lf.usage);
  });

  it("reassembles CRLF framing split at every possible chunk boundary", async () => {
    const body = frame(HELLO_BLOCKS, "\r\n");
    const reference = await consume([body]);
    expect(textOf(reference.events)).toBe("hello");

    for (let splitAt = 1; splitAt < body.length; splitAt++) {
      const split = await consume([body.slice(0, splitAt), body.slice(splitAt)]);
      expect(split.events, `split at ${splitAt}`).toEqual(reference.events);
      expect(split.usage, `split at ${splitAt}`).toEqual(reference.usage);
    }
  });

  it("reassembles a multi-byte UTF-8 sequence split across chunks", async () => {
    const content = "héllo 👋 wörld";
    const body = encoder.encode(
      frame([data({ choices: [{ delta: { content }, finish_reason: "stop" }] }), "data: [DONE]"], "\n"),
    );
    // Split inside the 4-byte emoji sequence.
    const emojiStart = body.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(0);
    const splitAt = emojiStart + 2;

    const { events } = await consume([body.slice(0, splitAt), body.slice(splitAt)]);
    expect(textOf(events)).toBe(content);
  });

  it("documents a default event-size bound", () => {
    expect(MAX_SSE_EVENT_CHARS).toBe(4 * 1024 * 1024);
  });

  it("rejects an event line that exceeds the size bound and cancels the reader", async () => {
    const events: ProviderStreamEvent[] = [];
    const oversized = `data: ${"x".repeat(100)}\n\n`;
    const source = streamFromChunks([oversized], { close: false });

    await expect(
      consumeOpenAiSseStream(source.stream, {
        controller: { emit: (event) => events.push(event) },
        maxEventChars: 64,
      }),
    ).rejects.toThrow("SSE event exceeded 64 characters");

    expect(source.wasCancelled()).toBe(true);
    expect(doneEvents(events)).toHaveLength(0);
  });

  it("rejects an unterminated event that keeps growing across chunks", async () => {
    const events: ProviderStreamEvent[] = [];
    const source = streamFromChunks([`data: ${"a".repeat(30)}`, "b".repeat(30), "c".repeat(30)], { close: false });

    await expect(
      consumeOpenAiSseStream(source.stream, {
        controller: { emit: (event) => events.push(event) },
        maxEventChars: 64,
      }),
    ).rejects.toThrow("SSE event exceeded 64 characters");

    expect(source.wasCancelled()).toBe(true);
    expect(doneEvents(events)).toHaveLength(0);
  });
});

describe("consumeOpenAiSseStream usage and termination", () => {
  it.each([
    "length",
    "stop",
  ])("counts a trailing usage-only chunk and emits exactly one done with finish reason %s", async (finishReason) => {
    const { events, usage } = await consume([
      frame(
        [
          data({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }),
          data({ choices: [{ delta: {}, finish_reason: finishReason }] }),
          data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          "data: [DONE]",
        ],
        "\n",
      ),
    ]);

    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(doneEvents(events)).toEqual([{ type: "done", stopReason: finishReason }]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: finishReason });
    expect(events.at(-2)).toEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("retains a tool_calls finish reason and emits the tool call once", async () => {
    const { events, usage } = await consume([
      frame(
        [
          data({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: '{"a":' } }],
                },
                finish_reason: null,
              },
            ],
          }),
          data({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null }],
          }),
          data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          "data: [DONE]",
        ],
        "\n",
      ),
    ]);

    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      { type: "tool-call", id: "call_1", toolName: "echo", args: { a: 1 } },
    ]);
    expect(doneEvents(events)).toEqual([{ type: "done", stopReason: "tool_calls" }]);
  });

  it("emits exactly one done at EOF when the stream ends without [DONE]", async () => {
    const { events, usage } = await consume([
      frame(
        [
          data({ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] }),
          data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
        ],
        "\n",
      ),
    ]);

    expect(usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(doneEvents(events)).toEqual([{ type: "done", stopReason: "length" }]);
  });

  it("emits a single done with stop when no finish reason was ever sent", async () => {
    const { events, usage } = await consume([
      frame([data({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }), "data: [DONE]"], "\n"),
    ]);

    expect(usage).toBeUndefined();
    expect(doneEvents(events)).toEqual([{ type: "done", stopReason: "stop" }]);
  });
});

describe("splitReadableTextDelta", () => {
  it("leaves small deltas untouched", () => {
    expect(splitReadableTextDelta("short", 10)).toEqual(["short"]);
  });

  it("splits oversized provider deltas on readable boundaries without changing content", () => {
    const text =
      "This is the first sentence. This is the second sentence with enough words to cross the limit. Final sentence.";
    const parts = splitReadableTextDelta(text, 48);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    expect(parts.some((part) => part.endsWith(". "))).toBe(true);
  });
});
