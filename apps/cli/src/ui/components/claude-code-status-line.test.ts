import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../types/index";
import {
  buildClaudeCodeStatusModel,
  formatClaudeCodeCancelGlyph,
  formatClaudeCodeStatusLabel,
  formatExtraToolCount,
  formatStatusElapsed,
} from "./claude-code-status-line";

describe("formatStatusElapsed", () => {
  it("uses one decimal for precise tool timing", () => {
    expect(formatStatusElapsed(1000, true)).toBe("1.0s");
  });

  it("uses integer seconds for waiting", () => {
    expect(formatStatusElapsed(13_400, false)).toBe("13s");
  });

  it("switches to minutes past sixty seconds", () => {
    expect(formatStatusElapsed(95_000, false)).toBe("1m35s");
    expect(formatStatusElapsed(95_000, true)).toBe("1m35s");
  });
});

describe("formatClaudeCodeStatusLabel", () => {
  it("labels each phase with elapsed at the end", () => {
    expect(formatClaudeCodeStatusLabel({ phase: "connecting", elapsedMs: 0 }, "3s")).toBe("Connecting… 3s");
    expect(formatClaudeCodeStatusLabel({ phase: "waiting", elapsedMs: 0 }, "3s")).toBe("Waiting for model… 3s");
    expect(formatClaudeCodeStatusLabel({ phase: "thinking", elapsedMs: 0 }, "12s")).toBe("Thinking… 12s");
    expect(formatClaudeCodeStatusLabel({ phase: "writing", elapsedMs: 0 }, "4s")).toBe("Writing… 4s");
    expect(formatClaudeCodeStatusLabel({ phase: "stopped", elapsedMs: 0 }, "8s")).toBe("Stopped · 8s");
  });
});

describe("formatExtraToolCount", () => {
  it("is empty for a single tool and counts the rest otherwise", () => {
    expect(formatExtraToolCount(undefined)).toBe("");
    expect(formatExtraToolCount(0)).toBe("");
    expect(formatExtraToolCount(2)).toBe(" +2 more");
  });
});

describe("formatClaudeCodeCancelGlyph", () => {
  it("uses the Nerd Font close glyph when available", () => {
    expect(formatClaudeCodeCancelGlyph("")).toBe("");
  });

  it("falls back to the text close marker", () => {
    expect(formatClaudeCodeCancelGlyph("")).toBe("[x]");
  });
});

describe("buildClaudeCodeStatusModel", () => {
  const home = "/Users/me";
  const base = {
    activeToolCalls: [] as ToolCall[],
    isProcessing: true,
    justStopped: false,
    elapsedMs: 13_000,
    startedAtMs: 1_000,
    homeDir: home,
  };
  const tc = (id: string, name = "bash"): ToolCall => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify({ command: "ls" }) },
  });

  it("is waiting before the stream reports anything", () => {
    expect(buildClaudeCodeStatusModel({ ...base, streamPhase: null })?.phase).toBe("waiting");
  });

  it("follows the stream phase when no tool is running", () => {
    expect(buildClaudeCodeStatusModel({ ...base, streamPhase: "connecting" })?.phase).toBe("connecting");
    expect(buildClaudeCodeStatusModel({ ...base, streamPhase: "thinking" })?.phase).toBe("thinking");
    expect(buildClaudeCodeStatusModel({ ...base, streamPhase: "writing" })?.phase).toBe("writing");
  });

  it("returns null when idle and stopped when just stopped", () => {
    expect(buildClaudeCodeStatusModel({ ...base, isProcessing: false, streamPhase: null })).toBeNull();
    expect(buildClaudeCodeStatusModel({ ...base, justStopped: true, streamPhase: "writing" })?.phase).toBe("stopped");
  });

  it("returns tool phase with Read verb and shortened path", () => {
    const read: ToolCall = {
      id: "t1",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "/Users/me/Documents/GitHub/grok-cli/HEARTBEAT.md" }),
      },
    };
    const model = buildClaudeCodeStatusModel({ ...base, activeToolCalls: [read], streamPhase: "writing" });
    expect(model).toEqual(
      expect.objectContaining({
        phase: "tool",
        toolVerb: "Read",
        toolDetail: "~/Documents/GitHub/grok-cli/HEARTBEAT.md",
        extraToolCount: 0,
      }),
    );
  });

  it("counts the other active tools and carries the head tool's start", () => {
    const model = buildClaudeCodeStatusModel({
      ...base,
      activeToolCalls: [tc("a"), tc("b"), tc("c")],
      toolStartedAtMs: 5_000,
      streamPhase: "waiting",
    });
    expect(model?.phase).toBe("tool");
    expect(model?.extraToolCount).toBe(2);
    expect(model?.toolStartedAtMs).toBe(5_000);
  });
});
