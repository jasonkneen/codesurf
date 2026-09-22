import { describe, expect, it } from "vitest";
import { formatThinkingHeader, getThinkingBlockMeta } from "./thinking-block";

describe("ThinkingBlock metadata", () => {
  it("does not count the growing trace while reasoning is still streaming", () => {
    expect(getThinkingBlockMeta("first thought\nsecond thought", true)).toEqual({
      hasReasoning: true,
      lineCount: 0,
    });
  });

  it("counts lines only after reasoning settles and ignores whitespace-only output", () => {
    expect(getThinkingBlockMeta("first thought\nsecond thought", false)).toEqual({
      hasReasoning: true,
      lineCount: 2,
    });
    expect(getThinkingBlockMeta(" \n ", false)).toEqual({ hasReasoning: false, lineCount: 0 });
  });
});

describe("formatThinkingHeader", () => {
  it("shows elapsed while thinking and duration once done", () => {
    expect(formatThinkingHeader({ isThinking: true, elapsedMs: 4_200 })).toBe("◌ Thinking 4s");
    expect(formatThinkingHeader({ isThinking: true })).toBe("◌ Thinking");
    expect(formatThinkingHeader({ isThinking: false, lineCount: 12, durationMs: 8_000 })).toBe(
      "Reasoned  12 lines · 8s",
    );
    expect(formatThinkingHeader({ isThinking: false, lineCount: 1 })).toBe("Reasoned  1 line");
  });

  it("drops a sub-half-second duration as noise", () => {
    expect(formatThinkingHeader({ isThinking: false, lineCount: 2, durationMs: 120 })).toBe("Reasoned  2 lines");
  });
});
