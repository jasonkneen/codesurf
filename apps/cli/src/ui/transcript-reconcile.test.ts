import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../types/index";
import { reconcileRebuiltTranscript } from "./transcript-reconcile";

function entry(partial: Partial<ChatEntry> & Pick<ChatEntry, "type" | "content">): ChatEntry {
  return { timestamp: new Date(0), ...partial };
}

describe("reconcileRebuiltTranscript", () => {
  it("carries display text and reasoning forward by ordinal when nothing was cancelled", () => {
    const prev = [
      entry({ type: "user", content: "read @a.ts" }),
      entry({ type: "assistant", content: "done", reasoningText: "thinking" }),
    ];
    const fresh = [
      entry({ type: "user", content: "read <contents of a.ts>" }),
      entry({ type: "assistant", content: "done" }),
    ];
    const merged = reconcileRebuiltTranscript(prev, fresh, new Set());
    expect(merged[0]?.content).toBe("read @a.ts");
    expect(merged[1]?.reasoningText).toBe("thinking");
  });

  it("carries UI-only system rows forward at their anchor position", () => {
    const prev = [
      entry({ type: "user", content: "q1" }),
      entry({ type: "assistant", content: "a1" }),
      entry({ type: "system", content: "✓ Done in 1.0s", systemKind: "summary" }),
      entry({ type: "user", content: "q2", runId: 2 }),
      entry({ type: "assistant", content: "a2", runId: 2 }),
      entry({ type: "system", content: "✓ Done in 2.0s", systemKind: "summary", runId: 2 }),
    ];
    const fresh = [
      entry({ type: "user", content: "q1" }),
      entry({ type: "assistant", content: "a1" }),
      entry({ type: "user", content: "q2" }),
      entry({ type: "assistant", content: "a2" }),
    ];
    const merged = reconcileRebuiltTranscript(prev, fresh, new Set());
    expect(merged.map((e) => e.content)).toEqual(["q1", "a1", "✓ Done in 1.0s", "q2", "a2", "✓ Done in 2.0s"]);
  });

  it("drops a cancelled run's system rows and keeps pairing aligned", () => {
    const prev = [
      entry({ type: "user", content: "q1" }),
      entry({ type: "assistant", content: "a1", reasoningText: "r1" }),
      entry({ type: "user", content: "gone", runId: 3 }),
      entry({ type: "system", content: "■ Stopped after 1.0s", systemKind: "summary", runId: 3 }),
      entry({ type: "user", content: "q2", runId: 4 }),
      entry({ type: "assistant", content: "a2", runId: 4, reasoningText: "r2" }),
    ];
    const fresh = [
      entry({ type: "user", content: "q1" }),
      entry({ type: "assistant", content: "a1" }),
      entry({ type: "user", content: "q2" }),
      entry({ type: "assistant", content: "a2" }),
    ];
    const merged = reconcileRebuiltTranscript(prev, fresh, new Set([3]));
    expect(merged.map((e) => e.content)).toEqual(["q1", "a1", "q2", "a2"]);
    expect(merged[3]?.reasoningText).toBe("r2");
  });

  it("pairs assistant segments by ordinal across a multi-round turn", () => {
    const prev = [
      entry({ type: "user", content: "go", runId: 1 }),
      entry({ type: "assistant", content: "First.", runId: 1, reasoningText: "r-first" }),
      entry({ type: "tool_result", content: "A", runId: 1 }),
      entry({ type: "assistant", content: "Done.", runId: 1, followupSuggestions: ["next"] }),
    ];
    const fresh = [
      entry({ type: "user", content: "go" }),
      entry({ type: "assistant", content: "First." }),
      entry({ type: "tool_result", content: "A" }),
      entry({ type: "assistant", content: "Done." }),
    ];
    const merged = reconcileRebuiltTranscript(prev, fresh, new Set());
    expect(merged.map((e) => e.content)).toEqual(["go", "First.", "A", "Done."]);
    expect(merged[1]?.reasoningText).toBe("r-first");
    expect(merged[3]?.followupSuggestions).toEqual(["next"]);
  });

  it("does not attribute a cancelled run's prompt to the next completed turn", () => {
    // Turn A was aborted: the agent discarded its user message, but the
    // optimistic row stayed in the previous render. Turn B then completed.
    const prev = [
      entry({ type: "user", content: "first @x" }),
      entry({ type: "assistant", content: "first answer" }),
      entry({ type: "user", content: "cancelled prompt", runId: 1 }),
      entry({ type: "user", content: "second @y", runId: 2 }),
    ];
    const fresh = [
      entry({ type: "user", content: "first <x>" }),
      entry({ type: "assistant", content: "first answer" }),
      entry({ type: "user", content: "second <y>" }),
      entry({ type: "assistant", content: "second answer" }),
    ];

    const merged = reconcileRebuiltTranscript(prev, fresh, new Set([1]));

    const users = merged.filter((e) => e.type === "user").map((e) => e.content);
    expect(users).toEqual(["first @x", "second @y"]);
    expect(merged.some((e) => e.content === "cancelled prompt")).toBe(false);
  });

  it("does not carry a cancelled run's partial reasoning onto the replacement's assistant row", () => {
    const prev = [
      entry({ type: "user", content: "q1" }),
      entry({ type: "assistant", content: "a1", reasoningText: "r1" }),
      entry({ type: "user", content: "cancelled", runId: 5 }),
      entry({ type: "assistant", content: "partial", runId: 5, reasoningText: "cancelled reasoning" }),
      entry({ type: "tool_result", content: "tool", runId: 5 }),
      entry({ type: "user", content: "q2", runId: 6 }),
      entry({ type: "assistant", content: "a2", runId: 6, reasoningText: "r2", followupSuggestions: ["next"] }),
    ];
    const fresh = [
      entry({ type: "user", content: "q1" }),
      entry({ type: "assistant", content: "a1" }),
      entry({ type: "user", content: "q2" }),
      entry({ type: "assistant", content: "a2" }),
    ];

    const merged = reconcileRebuiltTranscript(prev, fresh, new Set([5]));

    expect(merged.map((e) => e.content)).toEqual(["q1", "a1", "q2", "a2"]);
    expect(merged[1]?.reasoningText).toBe("r1");
    expect(merged[3]?.reasoningText).toBe("r2");
    expect(merged[3]?.followupSuggestions).toEqual(["next"]);
  });

  it("reuses render-identical previous objects so memoized rows do not re-render", () => {
    const stable = entry({ type: "assistant", content: "same" });
    const prev = [entry({ type: "user", content: "u" }), stable];
    const fresh = [entry({ type: "user", content: "u" }), entry({ type: "assistant", content: "same" })];
    const merged = reconcileRebuiltTranscript(prev, fresh, new Set());
    expect(merged[1]).toBe(stable);
  });
});
