// Pure-helper tests for the chip-collation algorithm in tool-calls.tsx.
// React rendering isn't covered here — we exercise `deriveChipDisplay` against
// hand-built call lists and assert the derived display structure matches the
// spec the user agreed to:
//
//   • Tier 1 fires per tool when count ≥ CHIP_GROUP_THRESHOLD (3).
//   • Tier 2 fires when groupable tool count ≥ CHIP_MEGA_THRESHOLD (3).
//   • running / error / pending always render individually.
//   • Loose done chips (count below threshold) render individually.
//   • Click-to-explode replaces a group/category chip with its parts.

import { describe, expect, it } from "vitest";
import {
  CHIP_GROUP_THRESHOLD,
  CHIP_MEGA_THRESHOLD,
  type ChipDisplayItem,
  compactChipDurationLabel,
  compactGroupDurationLabel,
  deriveChipDisplay,
  formatChipDuration,
  type ToolCallRecord,
  type ToolCallStatus,
} from "./tool-calls-collation";

function call(id: string, toolName: string, status: ToolCallStatus = "done"): ToolCallRecord {
  return { id, toolName, status };
}

function makeRun(toolName: string, count: number, prefix = ""): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (let i = 0; i < count; i++) {
    out.push(call(`${prefix}${toolName}-${i}`, toolName));
  }
  return out;
}

const NO_EXPLOSION: ReadonlySet<string> = new Set();

describe("deriveChipDisplay — thresholds", () => {
  it("documents the threshold contract the algorithm depends on", () => {
    // If these change, every test below needs revisiting.
    expect(CHIP_GROUP_THRESHOLD).toBe(3);
    expect(CHIP_MEGA_THRESHOLD).toBe(3);
  });
});

describe("deriveChipDisplay — tier 1 (group by tool)", () => {
  it("renders each chip individually when no tool reaches the threshold", () => {
    // 2 BASH + 2 READ + 1 GREP = 5 chips, none grouped.
    const calls = [...makeRun("bash", 2), ...makeRun("read_file", 2), ...makeRun("grep", 1)];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items).toHaveLength(5);
    expect(items.every((it) => it.kind === "individual")).toBe(true);
  });

  it("groups a single tool when it hits exactly the threshold", () => {
    const calls = makeRun("bash", 3);
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("group");
    if (item.kind !== "group") throw new Error("type guard");
    expect(item.toolName).toBe("bash");
    expect(item.calls).toHaveLength(3);
    expect(item.id).toBe("__group:bash");
  });

  it("does NOT trigger tier 2 with only 2 groupable tools", () => {
    // 13 BASH + 13 READ — matches the real screenshot scenario the user
    // showed: two-tool spam should collapse to two group chips, not a mega.
    const calls = [...makeRun("bash", 13), ...makeRun("read_file", 13)];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items.map((it) => it.kind)).toEqual(["group", "group"]);
    if (items[0].kind !== "group" || items[1].kind !== "group") {
      throw new Error("type guard");
    }
    expect(items[0].toolName).toBe("bash");
    expect(items[0].calls).toHaveLength(13);
    expect(items[1].toolName).toBe("read_file");
    expect(items[1].calls).toHaveLength(13);
  });

  it("keeps loose tools individual alongside group chips", () => {
    // 5 BASH (groups) + 2 READ (loose) + 1 GREP (loose).
    const calls = [...makeRun("bash", 5), ...makeRun("read_file", 2), ...makeRun("grep", 1)];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    // Expected order: group(bash), then loose individuals in chronological
    // order — read_file, read_file, grep.
    expect(items.map((it) => it.kind)).toEqual(["group", "individual", "individual", "individual"]);
    if (items[0].kind !== "group") throw new Error("type guard");
    expect(items[0].toolName).toBe("bash");
  });

  it("preserves first-seen tool order across group chips", () => {
    // READ first, then BASH — group chip order should match.
    const calls = [...makeRun("read_file", 4), ...makeRun("bash", 4)];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items.map((it) => (it.kind === "group" ? it.toolName : it.kind))).toEqual(["read_file", "bash"]);
  });
});

describe("deriveChipDisplay — tier 2 (category collapse)", () => {
  it("collapses groupable tools into one category chip when they share a category", () => {
    // Three unknown tools all default to the Tools category → one chip.
    const calls = [...makeRun("foo", 3), ...makeRun("bar", 3), ...makeRun("baz", 3)];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items).toHaveLength(1);
    const [cat] = items;
    expect(cat.kind).toBe("category");
    if (cat.kind !== "category") throw new Error("type guard");
    expect(cat.calls).toHaveLength(9);
    expect(cat.groupCount).toBe(3);
    expect(cat.category).toBe("Tools");
    expect(cat.id).toBe("__category:Tools");
  });

  it("splits mixed-category tools into one chip per category", () => {
    // bash → Shell (1 group); read_file + write_file → Files (2 groups).
    const calls = [...makeRun("bash", 3), ...makeRun("read_file", 3), ...makeRun("write_file", 3)];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items).toHaveLength(2);
    expect(items.map((it) => it.kind)).toEqual(["category", "category"]);
    if (items[0].kind !== "category" || items[1].kind !== "category") throw new Error("type guard");
    expect(items[0].category).toBe("Shell");
    expect(items[0].calls).toHaveLength(3);
    expect(items[0].groupCount).toBe(1);
    expect(items[1].category).toBe("Files");
    expect(items[1].calls).toHaveLength(6);
    expect(items[1].groupCount).toBe(2);
  });

  it("does not pull loose / running / errored chips into category totals", () => {
    const calls: ToolCallRecord[] = [
      ...makeRun("bash", 5),
      ...makeRun("read_file", 4),
      ...makeRun("write_file", 3),
      ...makeRun("grep", 3),
      call("loose-search-1", "search", "done"),
      call("running-1", "bash", "running"),
      call("err-1", "bash", "error"),
    ];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items.map((it) => it.kind)).toEqual(["category", "category", "individual", "individual", "individual"]);
    if (items[0].kind !== "category" || items[1].kind !== "category") throw new Error("type guard");
    expect(items[0].category).toBe("Shell");
    expect(items[0].calls).toHaveLength(5);
    expect(items[1].category).toBe("Files");
    expect(items[1].calls).toHaveLength(10);
    if (items[2].kind !== "individual" || items[3].kind !== "individual" || items[4].kind !== "individual") {
      throw new Error("type guard");
    }
    expect(items[2].call.status).toBe("done");
    expect(items[3].call.status).toBe("running");
    expect(items[4].call.status).toBe("error");
  });
});

describe("deriveChipDisplay — explosion (click-to-expand)", () => {
  it("explodes a tier-1 group back into its individual chips while keeping the summary chip visible", () => {
    const calls = [...makeRun("bash", 4), ...makeRun("read_file", 1)];
    const explode = new Set(["__group:bash"]);
    const items = deriveChipDisplay(calls, explode);
    // 1 expanded BASH group + 4 BASH individuals + 1 loose READ = 6 items.
    // The summary chip stays visible (marked expanded) so the user has a
    // re-collapse target.
    expect(items).toHaveLength(6);
    expect(items.map((it) => it.kind)).toEqual([
      "group",
      "individual",
      "individual",
      "individual",
      "individual",
      "individual",
    ]);
    if (items[0].kind !== "group") throw new Error("type guard");
    expect(items[0].toolName).toBe("bash");
    expect(items[0].expanded).toBe(true);
    const bashCount = items.filter(
      (it): it is Extract<ChipDisplayItem, { kind: "individual" }> =>
        it.kind === "individual" && it.call.toolName === "bash",
    ).length;
    expect(bashCount).toBe(4);
  });

  it("explodes a category into its tier-1 group chips while keeping the category visible", () => {
    const calls = [...makeRun("bash", 3), ...makeRun("read_file", 3), ...makeRun("write_file", 3)];
    const items = deriveChipDisplay(calls, new Set(["__category:Files"]));
    // Shell category + Files category (expanded) + 2 group chips = 4 items.
    expect(items.map((it) => it.kind)).toEqual(["category", "category", "group", "group"]);
    if (items[0].kind !== "category" || items[1].kind !== "category") throw new Error("type guard");
    expect(items[0].category).toBe("Shell");
    expect(items[1].category).toBe("Files");
    expect(items[1].expanded).toBe(true);
    if (items[2].kind !== "group" || items[3].kind !== "group") {
      throw new Error("type guard");
    }
    expect(items[2].expanded).toBe(false);
    expect(items[2].expanded).toBe(false);
    expect(items[3].expanded).toBe(false);
  });

  it("supports nested explosion: category exploded + one group exploded", () => {
    const calls = [...makeRun("bash", 3), ...makeRun("read_file", 3), ...makeRun("write_file", 3)];
    const items = deriveChipDisplay(calls, new Set(["__category:Files", "__group:read_file"]));
    // Shell category + Files category (expanded) + read group (expanded) + 3 read individuals + write group.
    expect(items.map((it) => it.kind)).toEqual([
      "category",
      "category",
      "group",
      "individual",
      "individual",
      "individual",
      "group",
    ]);
    if (items[0].kind !== "category" || items[1].kind !== "category") throw new Error("type guard");
    expect(items[0].category).toBe("Shell");
    expect(items[1].category).toBe("Files");
    expect(items[1].expanded).toBe(true);
    if (items[2].kind !== "group" || items[6].kind !== "group") {
      throw new Error("type guard");
    }
    expect(items[2].toolName).toBe("read_file");
    expect(items[2].expanded).toBe(true);
    expect(items[6].toolName).toBe("write_file");
    expect(items[6].expanded).toBe(false);
    if (items[3].kind !== "individual" || items[4].kind !== "individual" || items[5].kind !== "individual") {
      throw new Error("type guard");
    }
    expect(items[3].call.toolName).toBe("read_file");
  });
});

describe("deriveChipDisplay — status escapes", () => {
  it("never folds running chips into a group, even if they share a tool", () => {
    // 5 done BASH + 1 running BASH → group of 5 + 1 individual running.
    const calls: ToolCallRecord[] = [...makeRun("bash", 5), call("bash-running", "bash", "running")];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    expect(items).toHaveLength(2);
    if (items[0].kind !== "group" || items[1].kind !== "individual") {
      throw new Error("type guard");
    }
    expect(items[0].calls).toHaveLength(5);
    expect(items[1].call.status).toBe("running");
  });

  it("places running, errored, pending chips after summary chips", () => {
    const calls: ToolCallRecord[] = [
      call("running-1", "bash", "running"),
      ...makeRun("read_file", 3),
      call("err-1", "grep", "error"),
      call("pending-1", "write_file", "pending"),
    ];
    const items = deriveChipDisplay(calls, NO_EXPLOSION);
    // Expected order: read_file group, then running, error, pending in input
    // order. The running chip appearing FIRST in the input list still ends up
    // after the group chip — summary first, live action last.
    expect(items.map((it) => it.kind)).toEqual(["group", "individual", "individual", "individual"]);
    if (items[1].kind !== "individual" || items[2].kind !== "individual" || items[3].kind !== "individual") {
      throw new Error("type guard");
    }
    expect(items[1].call.status).toBe("running");
    expect(items[2].call.status).toBe("error");
    expect(items[3].call.status).toBe("pending");
  });

  it("returns an empty list for an empty input", () => {
    expect(deriveChipDisplay([], NO_EXPLOSION)).toEqual([]);
  });
});

describe("compact chip duration", () => {
  it("formats through formatChipDuration", () => {
    expect(formatChipDuration(23)).toBe("23ms");
    expect(formatChipDuration(1_842)).toBe("1.84s");
  });

  it("labels a done chip with duration using formatChipDuration", () => {
    expect(compactChipDurationLabel("done", 23)).toBe(formatChipDuration(23));
    expect(compactChipDurationLabel("done", 1_842)).toBe(formatChipDuration(1_842));
  });

  it("hides duration on running and pending chips", () => {
    expect(compactChipDurationLabel("running", 500)).toBeNull();
    expect(compactChipDurationLabel("pending", 500)).toBeNull();
    expect(compactChipDurationLabel("done")).toBeNull();
  });

  it("labels a group with the slowest finished member", () => {
    const calls: ToolCallRecord[] = [
      { id: "a", toolName: "bash", status: "done", durationMs: 100 },
      { id: "b", toolName: "bash", status: "done", durationMs: 1_842 },
      { id: "c", toolName: "bash", status: "done", durationMs: 50 },
    ];
    expect(compactGroupDurationLabel(calls)).toBe(formatChipDuration(1_842));
  });
});
