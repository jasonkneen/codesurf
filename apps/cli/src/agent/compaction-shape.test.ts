import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactionHeadMessages, createCompactionSummaryMessage, prepareCompaction } from "./compaction";

// Compaction keeps a suffix of the transcript behind a summary message. The
// summary carries role "system", which provider adapters lift out of the
// message list and into the system block — so whatever the kept slice starts
// with becomes the FIRST message on the wire, and providers require that to be
// a user message.
//
// `isValidCutPoint` only refuses to cut on a `tool` message, so a token
// boundary landing mid-turn can start the kept slice at an assistant message.

const big = (n: number) => "word ".repeat(n);

/** What runtime.ts installs after a successful compaction, and what
 *  transcript-view rebuilds when the session is reopened. */
function applied(summary: string, kept: ModelMessage[]): ModelMessage[] {
  return [...compactionHeadMessages(summary, kept), ...kept];
}

/** The first message an adapter actually sends, once a leading system message
 *  has been folded into the system block. */
function firstWireMessage(messages: ModelMessage[]): ModelMessage | undefined {
  return messages.find((m) => m.role !== "system");
}

describe("compaction keeps a provider-valid message order", () => {
  it("starts the kept slice at a user message when the cut lands mid-turn", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: big(4_000) },
      { role: "user", content: "second question" },
      { role: "assistant", content: big(4_000) },
      { role: "user", content: "third question" },
      { role: "assistant", content: big(4_000) },
    ];

    const prepared = prepareCompaction(messages, "system prompt", {
      reserveTokens: 1_000,
      keepRecentTokens: 6_000,
    });

    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error("unreachable");

    const wire = applied("a summary", prepared.keptMessages);
    expect(firstWireMessage(wire)?.role).toBe("user");
  });

  it("keeps a tool result with the assistant message that called for it", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: big(4_000) },
      { role: "user", content: "do a thing" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "a.ts" } }],
      },
      { role: "assistant", content: big(4_000) },
    ];

    const prepared = prepareCompaction(messages, "system prompt", {
      reserveTokens: 1_000,
      keepRecentTokens: 5_000,
    });
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error("unreachable");

    const wire = applied("a summary", prepared.keptMessages);
    expect(firstWireMessage(wire)?.role).toBe("user");

    const kept = JSON.stringify(prepared.keptMessages);
    // Either both halves of the tool round are kept or neither is.
    expect(kept.includes('"tool-call"')).toBe(kept.includes('"tool-result"'));
  });

  it("still starts at a user message when a previous summary is already present", () => {
    const messages: ModelMessage[] = [
      createCompactionSummaryMessage("earlier summary"),
      { role: "user", content: "q1" },
      { role: "assistant", content: big(4_000) },
      { role: "user", content: "q2" },
      { role: "assistant", content: big(4_000) },
    ];

    const prepared = prepareCompaction(messages, "system prompt", {
      reserveTokens: 1_000,
      keepRecentTokens: 3_000,
    });
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error("unreachable");

    const wire = applied("a summary", prepared.keptMessages);
    expect(firstWireMessage(wire)?.role).toBe("user");
  });
});

describe("reopening a compacted session", () => {
  it("rebuilds the same head the live compaction installed", async () => {
    const { buildEffectiveTranscript } = await import("../storage/transcript-view");
    // Stored rows start mid-turn: seq 5 is the assistant half of a split turn.
    const stored: ModelMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "the kept tail of a split turn" },
      { role: "user", content: "q2" },
    ];
    const seqs = [3, 4, 5, 6];
    const timestamps = stored.map(() => new Date("2026-01-01T00:00:00.000Z"));

    const view = buildEffectiveTranscript(stored, seqs, timestamps, {
      firstKeptSeq: 5,
      summary: "earlier work",
      tokensBefore: 10_000,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(firstWireMessage(view.messages)?.role).toBe("user");
    // Every parallel array stays aligned, or later seq lookups address the
    // wrong message.
    expect(view.messages.length).toBe(view.seqs.length);
    expect(view.messages.length).toBe(view.timestamps.length);
  });

  it("adds no bridge when the kept slice already starts at a user turn", async () => {
    const { buildEffectiveTranscript } = await import("../storage/transcript-view");
    const stored: ModelMessage[] = [
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const view = buildEffectiveTranscript(
      stored,
      [3, 4, 5],
      stored.map(() => new Date("2026-01-01T00:00:00.000Z")),
      {
        firstKeptSeq: 4,
        summary: "earlier work",
        tokensBefore: 10_000,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    expect(view.messages).toHaveLength(3);
    expect(firstWireMessage(view.messages)?.content).toBe("q2");
    expect(view.messages.length).toBe(view.seqs.length);
  });
});
