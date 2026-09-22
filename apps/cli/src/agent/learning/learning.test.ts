import { describe, expect, it } from "vitest";
import { pickBestModel, type RouterTraceSample, rankModels } from "./learned-router";
import { mineToolSequences, type SequenceTrace } from "./skill-discovery";

describe("pickBestModel", () => {
  function samples(
    model: string,
    n: number,
    outcome: "success" | "failure" | "cancelled",
    feedback: number | null,
  ): RouterTraceSample[] {
    return Array.from({ length: n }, () => ({ model, outcome, feedback }));
  }

  it("returns null when no model clears the sample threshold", () => {
    expect(pickBestModel(samples("a", 3, "success", null), 5)).toBeNull();
  });

  it("picks the model with the highest composite score", () => {
    const data = [
      ...samples("good", 5, "success", 0.9), // composite 0.6 + 0.36 = 0.96
      ...samples("bad", 5, "failure", 0.2), // composite 0 + 0.08 = 0.08
    ];
    const choice = pickBestModel(data, 5);
    expect(choice?.model).toBe("good");
    expect(choice?.samples).toBe(5);
    expect(choice?.score).toBeCloseTo(0.96, 5);
  });

  it("defaults missing feedback to neutral 0.5", () => {
    // success + no feedback => 0.6*1 + 0.4*0.5 = 0.8
    const choice = pickBestModel(samples("m", 5, "success", null), 5);
    expect(choice?.score).toBeCloseTo(0.8, 5);
  });

  it("excludes under-sampled models even if they score higher", () => {
    const data = [
      ...samples("rare", 2, "success", 1), // great but only 2 samples
      ...samples("common", 6, "success", 0.5), // 0.6 + 0.2 = 0.8
    ];
    expect(pickBestModel(data, 5)?.model).toBe("common");
  });

  it("does not count user-cancelled traces as model-quality samples", () => {
    const data = [...samples("complete", 5, "success", null), ...samples("interrupted", 20, "cancelled", 1)];

    expect(pickBestModel(data, 5)?.model).toBe("complete");
    expect(rankModels(data, 5).map((standing) => standing.model)).toEqual(["complete"]);
  });
});

describe("rankModels", () => {
  function samples(
    model: string,
    n: number,
    outcome: "success" | "failure" | "cancelled",
    feedback: number | null,
  ): RouterTraceSample[] {
    return Array.from({ length: n }, () => ({ model, outcome, feedback }));
  }

  it("returns every observed model sorted by composite score desc", () => {
    const data = [
      ...samples("mid", 5, "success", 0.5), // 0.8
      ...samples("top", 5, "success", 0.9), // 0.96
      ...samples("low", 5, "failure", 0.2), // 0.08
    ];
    const ranked = rankModels(data, 5);
    expect(ranked.map((r) => r.model)).toEqual(["top", "mid", "low"]);
  });

  it("includes under-sampled models but flags them unqualified", () => {
    const data = [...samples("rare", 2, "success", 1), ...samples("common", 6, "success", 0.5)];
    const ranked = rankModels(data, 5);
    expect(ranked.find((r) => r.model === "rare")?.qualified).toBe(false);
    expect(ranked.find((r) => r.model === "common")?.qualified).toBe(true);
  });

  it("head of the qualified subset equals pickBestModel", () => {
    const data = [...samples("a", 5, "success", 0.9), ...samples("b", 5, "success", 0.4)];
    const ranked = rankModels(data, 5).filter((r) => r.qualified);
    expect(ranked[0].model).toBe(pickBestModel(data, 5)?.model);
  });

  it("returns empty for no samples", () => {
    expect(rankModels([], 5)).toEqual([]);
  });
});

describe("mineToolSequences", () => {
  function trace(tools: string[], outcome: number, query?: string): SequenceTrace {
    return { toolNames: tools, outcome, query };
  }

  it("finds a recurring high-outcome subsequence", () => {
    const traces = [
      trace(["grep", "read_file", "edit_file"], 1, "q1"),
      trace(["grep", "read_file", "edit_file"], 1, "q2"),
      trace(["grep", "read_file", "edit_file"], 0.8, "q3"),
    ];
    const found = mineToolSequences(traces, { minFrequency: 3 });
    // [grep, read_file] and [read_file, edit_file] and the full triple all recur 3x.
    const pair = found.find((s) => s.toolSequence.join(",") === "grep,read_file");
    expect(pair).toBeDefined();
    expect(pair?.frequency).toBe(3);
    expect(pair?.avgOutcome).toBeGreaterThanOrEqual(0.5);
    expect(pair?.exampleQueries.length).toBeGreaterThan(0);
    expect(pair?.exampleQueries.length).toBeLessThanOrEqual(3);
  });

  it("drops sequences below the frequency threshold", () => {
    const traces = [trace(["a", "b"], 1), trace(["a", "b"], 1)];
    expect(mineToolSequences(traces, { minFrequency: 3 })).toHaveLength(0);
  });

  it("drops recurring but low-outcome sequences", () => {
    const traces = [trace(["x", "y"], 0.1), trace(["x", "y"], 0.2), trace(["x", "y"], 0.0)];
    expect(mineToolSequences(traces, { minFrequency: 3, minOutcome: 0.5 })).toHaveLength(0);
  });

  it("ranks by frequency * avgOutcome", () => {
    const traces = [
      trace(["a", "b"], 1),
      trace(["a", "b"], 1),
      trace(["a", "b"], 1),
      trace(["a", "b"], 1), // [a,b] 4x @1.0 => 4.0
      trace(["c", "d"], 1),
      trace(["c", "d"], 1),
      trace(["c", "d"], 1), // [c,d] 3x @1.0 => 3.0
    ];
    const found = mineToolSequences(traces, { minFrequency: 3 });
    expect(found[0].toolSequence.join(",")).toBe("a,b");
  });
});
