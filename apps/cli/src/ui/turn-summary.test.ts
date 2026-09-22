import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../types/index";
import { collectTurnStats, formatTurnSummary } from "./turn-summary";

const tool = (name: string, path?: string, runId = 7): ChatEntry => ({
  type: "tool_result",
  content: "",
  timestamp: new Date(0),
  runId,
  toolCall: {
    id: `${name}-${path ?? ""}-${runId}`,
    type: "function",
    function: { name, arguments: JSON.stringify(path ? { path } : {}) },
  },
  toolResult: { success: true },
});

describe("formatTurnSummary", () => {
  it("formats done, stopped, and error outcomes", () => {
    expect(
      formatTurnSummary({ outcome: "done", elapsedMs: 12_340, toolCount: 4, filesChanged: 2, tokenDelta: 1_200 }),
    ).toBe("✓ Done in 12.3s · 4 tools · 2 files changed · +1.2k tokens");
    expect(formatTurnSummary({ outcome: "stopped", elapsedMs: 8_000, toolCount: 2, filesChanged: 0 })).toBe(
      "■ Stopped after 8.0s · 2 tools",
    );
    expect(formatTurnSummary({ outcome: "error", elapsedMs: 3_000, toolCount: 0, filesChanged: 0 })).toBe(
      "✗ Failed after 3.0s",
    );
  });

  it("uses singular nouns and omits a zero token delta", () => {
    expect(formatTurnSummary({ outcome: "done", elapsedMs: 900, toolCount: 1, filesChanged: 1, tokenDelta: 0 })).toBe(
      "✓ Done in 0.9s · 1 tool · 1 file changed",
    );
    expect(formatTurnSummary({ outcome: "done", elapsedMs: 900, toolCount: 0, filesChanged: 0, tokenDelta: 250 })).toBe(
      "✓ Done in 0.9s · +250 tokens",
    );
  });
});

describe("collectTurnStats", () => {
  it("counts tools and distinct edited files for one run only", () => {
    const entries = [
      tool("bash"),
      tool("edit_file", "/a.ts"),
      tool("write_file", "/a.ts"),
      tool("edit_file", "/b.ts"),
      tool("bash", undefined, 6),
    ];
    expect(collectTurnStats(entries, 7)).toEqual({ toolCount: 4, filesChanged: 2 });
  });

  it("ignores non-tool rows and rows without a run id", () => {
    const entries: ChatEntry[] = [
      { type: "assistant", content: "x", timestamp: new Date(0), runId: 7 },
      { ...tool("bash"), runId: undefined },
    ];
    expect(collectTurnStats(entries, 7)).toEqual({ toolCount: 0, filesChanged: 0 });
  });
});
