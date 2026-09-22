import { describe, expect, it } from "vitest";
import { applyChunk, startUserTurn, type TranscriptEntry } from "./transcript.js";

describe("startUserTurn", () => {
  it("appends a user row and an empty assistant row for the coming stream", () => {
    const next = startUserTurn([], "hello", "t1");
    expect(next).toEqual([
      { kind: "user", id: "t1", text: "hello" },
      { kind: "assistant", id: "t1:a", text: "", reasoning: "" },
    ]);
  });
});

describe("applyChunk", () => {
  const turn = (): TranscriptEntry[] => startUserTurn([], "hi", "t1");

  it("concatenates content onto the open assistant row", () => {
    const a = applyChunk(turn(), { type: "content", content: "Hel" });
    const b = applyChunk(a, { type: "content", content: "lo" });
    expect(b.at(-1)).toEqual({ kind: "assistant", id: "t1:a", text: "Hello", reasoning: "" });
  });

  it("concatenates reasoning separately from visible text", () => {
    const a = applyChunk(turn(), { type: "reasoning", content: "think " });
    const b = applyChunk(a, { type: "reasoning", content: "more" });
    expect(b.at(-1)).toEqual({ kind: "assistant", id: "t1:a", text: "", reasoning: "think more" });
  });

  it("records each tool call as its own row so the user sees activity", () => {
    const next = applyChunk(turn(), {
      type: "tool_calls",
      toolCalls: [{ function: { name: "bash" } }, { function: { name: "read" } }],
    });
    expect(next.filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", id: "tool-2", name: "bash" },
      { kind: "tool", id: "tool-3", name: "read" },
    ]);
  });

  it("surfaces errors instead of swallowing them into the assistant buffer", () => {
    const next = applyChunk(turn(), { type: "error", content: "auth failed" });
    expect(next.at(-1)).toEqual({ kind: "error", id: "err-2", text: "auth failed" });
  });

  it("ignores done/warning so the caller can use them as control signals", () => {
    const start = turn();
    expect(applyChunk(start, { type: "done" })).toEqual(start);
    expect(applyChunk(start, { type: "warning", content: "x" })).toEqual(start);
  });

  it("records a singular toolCall the same way as a toolCalls array", () => {
    const next = applyChunk(turn(), { type: "tool_calls", toolCall: { function: { name: "grep" } } });
    expect(next.filter((e) => e.kind === "tool")).toEqual([{ kind: "tool", id: "tool-2", name: "grep" }]);
  });

  it("surfaces status as its own row", () => {
    const next = applyChunk(turn(), { type: "status", status: "connecting" });
    expect(next.at(-1)).toEqual({ kind: "status", id: "st-2", text: "connecting" });
  });

  it("puts text that follows tool rows in a new assistant row after them", () => {
    let next = applyChunk(turn(), { type: "content", content: "Let me check." });
    next = applyChunk(next, { type: "tool_calls", toolCalls: [{ function: { name: "bash" } }] });
    next = applyChunk(next, { type: "content", content: "Done" });
    next = applyChunk(next, { type: "content", content: "!" });

    expect(next.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(next[1]).toMatchObject({ kind: "assistant", text: "Let me check." });
    expect(next[3]).toMatchObject({ kind: "assistant", text: "Done!" });
  });
});
