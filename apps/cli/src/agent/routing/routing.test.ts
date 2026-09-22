import { describe, expect, it } from "vitest";
import { classifyQuery } from "./classify";
import { adjustTokensForModel, isThinkingModel, scoreComplexity } from "./complexity";

describe("classifyQuery", () => {
  it("detects code, math, short, long, and general", () => {
    expect(classifyQuery("write a function to reverse a list")).toBe("code");
    expect(classifyQuery("```js\nconst x = 1\n```")).toBe("code");
    expect(classifyQuery("solve this equation for x")).toBe("math");
    expect(classifyQuery("hi there")).toBe("short");
    expect(classifyQuery(`general question ${"x".repeat(60)}`)).toBe("general");
    expect(classifyQuery("y".repeat(600))).toBe("long");
  });

  it("prefers code over math when both present", () => {
    // CODE_RE is checked first in upstream order.
    expect(classifyQuery("import numpy then solve the equation")).toBe("code");
  });
});

describe("scoreComplexity", () => {
  it("scores a trivial greeting as trivial with the smallest budget", () => {
    const r = scoreComplexity("hi");
    expect(r.tier).toBe("trivial");
    expect(r.suggestedMaxTokens).toBe(1024);
    expect(r.score).toBeLessThan(0.15);
  });

  it("scores a long code+math+reasoning multi-part request high", () => {
    const q =
      "```python\ndef f(): pass\n```\n" +
      "Explain why this is slow, then optimize it, then benchmark it. " +
      "Solve the equation and compute the probability. " +
      "What is the complexity? What is the bottleneck? " +
      "x".repeat(800);
    const r = scoreComplexity(q);
    expect(["complex", "very_complex"]).toContain(r.tier);
    expect(r.suggestedMaxTokens).toBeGreaterThanOrEqual(8192);
    expect(r.signals.hasCode).toBe(true);
    expect(r.signals.hasMath).toBe(true);
    expect(r.signals.hasReasoning).toBe(true);
    expect(r.signals.hasMultiStep).toBe(true);
    // Strictly higher than a trivial query.
    expect(r.score).toBeGreaterThan(scoreComplexity("hi").score);
  });

  it("clamps score to [0,1] and always returns a known tier", () => {
    const r = scoreComplexity(`${"x".repeat(2000)} analyze compare explain why design create`);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(Object.keys({ trivial: 0, simple: 0, moderate: 0, complex: 0, very_complex: 0 })).toContain(r.tier);
  });

  it("counts questions and subtasks for the multi-part signal", () => {
    const r = scoreComplexity("What is X? What is Y? What is Z? And W?");
    expect(r.signals.nQuestions).toBe(4);
  });
});

describe("thinking-model token adjustment", () => {
  it("identifies thinking models", () => {
    expect(isThinkingModel("deepseek-r1:7b")).toBe(true);
    expect(isThinkingModel("o3-mini")).toBe(true);
    expect(isThinkingModel("claude-opus-4-8")).toBe(false);
  });

  it("doubles the budget only for thinking models", () => {
    expect(adjustTokensForModel(4096, "deepseek-r1")).toBe(8192);
    expect(adjustTokensForModel(4096, "claude-opus-4-8")).toBe(4096);
    expect(adjustTokensForModel(4096)).toBe(4096);
  });
});
