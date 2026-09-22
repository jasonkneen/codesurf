import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../types/index";
import { earliestToolStart, finishToolTimer, removeActiveToolCall, startToolTimers } from "./tool-timing";

function tc(id: string): ToolCall {
  return { id, type: "function", function: { name: "bash", arguments: "{}" } };
}

describe("tool timing", () => {
  it("records a start per call and returns each call's own duration", () => {
    const map = new Map<string, number>();
    startToolTimers(map, [tc("a"), tc("b")], 1_000);
    expect(finishToolTimer(map, "a", 1_250)).toBe(250);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(1_000);
  });

  it("does not restart a timer for a call that is already running", () => {
    const map = new Map<string, number>([["a", 100]]);
    startToolTimers(map, [tc("a")], 900);
    expect(map.get("a")).toBe(100);
  });

  it("returns undefined for an unknown id", () => {
    expect(finishToolTimer(new Map(), "zzz", 5)).toBeUndefined();
  });

  it("removes only the finished call from the active list", () => {
    const rest = removeActiveToolCall([tc("a"), tc("b"), tc("c")], "b");
    expect(rest.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("reports the earliest in-flight start", () => {
    const map = new Map<string, number>([
      ["a", 500],
      ["b", 200],
    ]);
    expect(earliestToolStart(map)).toBe(200);
    expect(earliestToolStart(new Map())).toBeUndefined();
  });
});
