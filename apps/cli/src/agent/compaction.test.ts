import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildEffectiveTranscript, type PersistedCompaction } from "../storage/transcript-view";
import {
  COMPACTION_SUMMARY_HEADER,
  computeContextBreakdown,
  createCompactionSummaryMessage,
  estimateConversationTokens,
  estimateMessageTokens,
  findCutPoint,
  IMAGE_PART_TOKEN_ESTIMATE,
  prepareCompaction,
  serializeConversation,
  shouldCompactContext,
} from "./compaction";

function user(text: string): ModelMessage {
  return { role: "user", content: text } as ModelMessage;
}

function assistantText(text: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as ModelMessage;
}

function assistantToolCall(toolCallId: string, toolName: string, input: Record<string, unknown> = {}): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  } as ModelMessage;
}

function toolResult(toolCallId: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output }],
  } as ModelMessage;
}

describe("compaction helpers", () => {
  it("triggers when context exceeds reserved headroom", () => {
    const settings = { reserveTokens: 100, keepRecentTokens: 40 };

    expect(shouldCompactContext(901, 1000, settings)).toBe(true);
    expect(shouldCompactContext(900, 1000, settings)).toBe(false);
  });

  it("never selects a tool-result message as the cut point", () => {
    const messages = [
      user("inspect this file"),
      assistantToolCall("call-1", "read_file", { path: "src/index.ts" }),
      toolResult("call-1", "read_file", "x".repeat(400)),
      assistantText("I found the relevant section."),
      user("continue"),
    ];

    const cutPoint = findCutPoint(messages, 0, 130);

    expect(cutPoint.firstKeptIndex).not.toBe(2);
    expect(messages[cutPoint.firstKeptIndex]?.role).not.toBe("tool");
  });

  it("detects split turns and captures the turn prefix for summarization", () => {
    const messages = [
      user("Refactor the session loader."),
      assistantText("a".repeat(320)),
      assistantText("recent status update"),
    ];

    const preparation = prepareCompaction(messages, "system prompt", {
      reserveTokens: 100,
      keepRecentTokens: 5,
    });

    expect(preparation).not.toBeNull();
    expect(preparation?.isSplitTurn).toBe(true);
    expect(preparation?.messagesToSummarize).toHaveLength(0);
    expect(preparation?.turnPrefixMessages).toHaveLength(2);
    expect(preparation?.keptMessages).toHaveLength(1);
  });

  it("excludes the previous summary message from new compaction input", () => {
    const messages = [
      createCompactionSummaryMessage("Earlier work"),
      user("Handle migration edge cases"),
      assistantText("I added the table and loader changes."),
      user("Now wire the retry path"),
    ];

    const preparation = prepareCompaction(messages, "system prompt", {
      reserveTokens: 100,
      keepRecentTokens: 4,
    });

    expect(preparation).not.toBeNull();
    expect(preparation?.previousSummary).toBe("Earlier work");
    expect(preparation?.messagesToSummarize[0]).toEqual(user("Handle migration edge cases"));
    expect(preparation?.messagesToSummarize.some((message) => message.role === "system")).toBe(false);
  });

  it("serializes tool results with truncation markers", () => {
    const transcript = serializeConversation([user("Read the output"), toolResult("call-1", "bash", "x".repeat(2105))]);

    expect(transcript).toContain("[Tool result]:");
    expect(transcript).toContain("more characters truncated");
  });

  it("builds the effective transcript from the latest persisted checkpoint", () => {
    const rawMessages = [
      user("old request"),
      assistantText("old answer"),
      user("new request"),
      assistantText("new answer"),
      user("latest request"),
    ];
    const seqs = [1, 2, 3, 4, 5];
    const timestamps = seqs.map((seq) => new Date(`2026-03-20T00:00:0${seq}.000Z`));
    const checkpoint: PersistedCompaction = {
      firstKeptSeq: 4,
      summary: "Summarized old work",
      tokensBefore: 1234,
      createdAt: new Date("2026-03-20T00:00:10.000Z"),
    };

    const transcript = buildEffectiveTranscript(rawMessages, seqs, timestamps, checkpoint);

    // The checkpoint cuts mid-turn, so the kept slice leads with an assistant
    // message. A bridging user turn joins the head: the summary is role
    // "system" and gets folded into the system block, which would otherwise
    // leave `assistant` as the first message on the wire.
    expect(transcript.messages).toHaveLength(4);
    expect(transcript.seqs).toEqual([null, null, 4, 5]);
    expect(transcript.messages[1]?.role).toBe("user");
    expect(transcript.messages[0]).toEqual(createCompactionSummaryMessage("Summarized old work"));
    expect(
      transcript.messages[0]?.role === "system" && typeof transcript.messages[0].content === "string"
        ? transcript.messages[0].content
        : "",
    ).toContain(COMPACTION_SUMMARY_HEADER);
  });
});

describe("wire-size token estimates (A4)", () => {
  it("keeps increasing the tool-result estimate past the 2,000-char summary cap", () => {
    const sizes = [1_000, 2_000, 4_000, 16_000, 1_000_000];
    const estimates = sizes.map((size) => estimateMessageTokens(toolResult("call-1", "bash", "x".repeat(size))));

    for (let i = 1; i < estimates.length; i++) {
      expect(estimates[i]).toBeGreaterThan(estimates[i - 1]);
    }
    // ~4 chars per token over the complete output, not the truncated summary.
    expect(estimates[estimates.length - 1]).toBeGreaterThanOrEqual(1_000_000 / 4);
  });

  it("request-sized tool output crosses the compaction threshold and keeps the recent suffix", () => {
    const contextWindow = 200_000;
    const settings = { reserveTokens: 16_384, keepRecentTokens: 20_000 };
    const bigResult = toolResult("call-1", "read_file", "y".repeat(1_000_000));
    const suffixTail = user("Now summarize the config section.");
    const finalAnswer = assistantText("Summarized.");
    const messages = [
      user("Read the big generated file."),
      assistantToolCall("call-1", "read_file", { path: "generated.txt" }),
      bigResult,
      assistantText("I read the file; it is mostly generated data."),
      suffixTail,
      finalAnswer,
    ];

    const tokensBefore = estimateConversationTokens("system prompt", messages);
    expect(shouldCompactContext(tokensBefore, contextWindow, settings)).toBe(true);

    const preparation = prepareCompaction(messages, "system prompt", settings);
    expect(preparation).not.toBeNull();
    expect(preparation?.keptMessages).not.toContain(bigResult);
    expect(preparation?.keptMessages.at(-1)).toBe(finalAnswer);
    expect(preparation?.keptMessages).toContain(suffixTail);
    expect([...(preparation?.messagesToSummarize ?? []), ...(preparation?.turnPrefixMessages ?? [])]).toContain(
      bigResult,
    );
  });

  it("charges image parts a flat conservative cost instead of a placeholder", () => {
    const withImage = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", image: "a".repeat(400_000), mediaType: "image/png" },
      ],
    } as ModelMessage;

    const estimate = estimateMessageTokens(withImage);
    expect(estimate).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);
    // The base64 payload is not tokenized as text (that would be ~100k tokens).
    expect(estimate).toBeLessThan(IMAGE_PART_TOKEN_ESTIMATE + 100);
  });

  it("charges media items inside content-typed tool outputs the image cost", () => {
    const withMedia = toolResult("call-1", "screenshot", {
      type: "content",
      value: [
        { type: "text", text: "captured" },
        { type: "media", data: "b".repeat(400_000), mediaType: "image/png" },
      ],
    });

    const estimate = estimateMessageTokens(withMedia);
    expect(estimate).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);
    expect(estimate).toBeLessThan(IMAGE_PART_TOKEN_ESTIMATE + 100);
  });

  it("still truncates tool results for the summarizer without affecting the estimate", () => {
    const message = toolResult("call-1", "bash", "z".repeat(50_000));
    expect(serializeConversation([message])).toContain("more characters truncated");
    expect(estimateMessageTokens(message)).toBeGreaterThanOrEqual(50_000 / 4);
  });
});

describe("computeContextBreakdown", () => {
  it("components sum exactly to usedTokens (no double counting)", () => {
    const messages = [user("a".repeat(400)), assistantText("b".repeat(800))];
    const bd = computeContextBreakdown("s".repeat(2000), messages, 100_000, "x".repeat(200));

    expect(bd.systemTokens).toBe(500);
    expect(bd.inFlightTokens).toBe(50);
    expect(bd.compactionSummaryTokens).toBe(0);
    expect(bd.usedTokens).toBe(bd.systemTokens + bd.inFlightTokens + bd.compactionSummaryTokens + bd.historyTokens);
    expect(bd.remainingTokens).toBe(100_000 - bd.usedTokens);
    expect(bd.ratioUsed).toBeCloseTo(bd.usedTokens / 100_000);
  });

  it("in-flight text is not folded into systemTokens", () => {
    const withoutInFlight = computeContextBreakdown("s".repeat(2000), [], 100_000);
    const withInFlight = computeContextBreakdown("s".repeat(2000), [], 100_000, "x".repeat(400));
    expect(withInFlight.systemTokens).toBe(withoutInFlight.systemTokens);
    expect(withInFlight.inFlightTokens).toBe(100);
    expect(withInFlight.usedTokens).toBe(withoutInFlight.usedTokens + 100);
  });

  it("splits a leading compaction summary out of history", () => {
    const summary = createCompactionSummaryMessage("k".repeat(396));
    const messages = [summary, user("a".repeat(400))];
    const bd = computeContextBreakdown("", messages, 100_000);

    expect(bd.compactionSummaryTokens).toBe(estimateMessageTokens(summary));
    expect(bd.compactionSummaryTokens).toBeGreaterThan(0);
    expect(bd.historyTokens).toBe(100);
  });

  it("clamps usedTokens to the context window", () => {
    const bd = computeContextBreakdown("s".repeat(4_000_000), [], 1_000);
    expect(bd.usedTokens).toBe(1_000);
    expect(bd.remainingTokens).toBe(0);
    expect(bd.ratioUsed).toBe(1);
  });

  it("estimateMessageTokens is stable for a repeated message object (cache)", () => {
    const msg = assistantText("hello world ".repeat(50));
    const first = estimateMessageTokens(msg);
    const second = estimateMessageTokens(msg);
    expect(second).toBe(first);
    expect(first).toBeGreaterThan(0);
  });
});
