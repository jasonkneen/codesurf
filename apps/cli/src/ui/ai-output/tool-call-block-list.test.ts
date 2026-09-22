import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collapseBlockListCalls,
  expandBlockListRecords,
  formatBlockListExpandedDetail,
  formatBlockListLabel,
  formatBlockListMeta,
  formatBlockListStatusGlyph,
  formatOutputHint,
  formatThoughtLabel,
  parseGrepMatchSummary,
  parseReadRangeFromOutput,
} from "./tool-call-block-list";
import type { ToolCallRecord } from "./tool-calls-collation";

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { id: "tc-1", toolName: "Read", status: "done", ...overrides };
}

describe("formatBlockListLabel", () => {
  it("formats read with quoted path", () => {
    const label = formatBlockListLabel(
      record({
        toolName: "Read",
        rawToolName: "read_file",
        args: { path: "/Users/jkneen/Documents/GitHub/grok-cli/SOUL.md" },
      }),
    );
    expect(label).toBe('Read "/Users/jkneen/Documents/GitHub/grok-cli/SOUL.md"');
  });

  it("formats read with image suffix", () => {
    const label = formatBlockListLabel(
      record({
        toolName: "Read",
        rawToolName: "read_file",
        args: { path: "/tmp/assets/image-abc.jpg" },
      }),
    );
    expect(label).toBe('Read "/tmp/assets/image-abc.jpg" (image)');
  });

  it("formats read with line range from output", () => {
    const label = formatBlockListLabel(
      record({
        toolName: "Read",
        rawToolName: "read_file",
        args: { path: "src/ui/app.tsx", start_line: 701, end_line: 750 },
        output: "[src/ui/app.tsx: lines 701-750 of 7351]\n701 | ...",
      }),
    );
    expect(label).toBe('Read lines 701-750 in "src/ui/app.tsx"');
  });

  it("formats grep as Search with scope and match summary", () => {
    const label = formatBlockListLabel(
      record({
        toolName: "Grep",
        rawToolName: "grep",
        args: { pattern: "Composer.*footer", path: "dist/ui" },
        output: "Found 4 matches\n\nsrc/a.ts:\n  Line 1: foo\nsrc/b.ts:\n  Line 2: bar\nsrc/c.ts:\n  Line 3: baz",
      }),
    );
    expect(label).toBe('Search "Composer.*footer" in dist/ui (4 matches in 3 files)');
  });

  it("formats Search with no matches", () => {
    const label = formatBlockListLabel(
      record({
        toolName: "Grep",
        rawToolName: "grep",
        args: { pattern: "type PasteBlock|interface PasteBlock", path: "src" },
        output: "No matches found.",
      }),
    );
    expect(label).toBe('Search "type PasteBlock|interface PasteBlock" in src (no matches)');
  });

  it("formats thought duration", () => {
    expect(formatBlockListLabel(record({ toolName: "Thought", durationMs: 1_000 }))).toBe("Thought for 1.0s");
  });

  it("formats skill invocations", () => {
    expect(formatBlockListLabel(record({ toolName: "skill:opentui", rawToolName: "skill:opentui" }))).toBe(
      "Skill opentui",
    );
  });
});

describe("formatBlockListMeta", () => {
  it("includes hooks and skills tags", () => {
    const meta = formatBlockListMeta(
      record({
        hooksCount: 2,
        skills: ["opentui"],
      }),
    );
    expect(meta).toBe("[skill: opentui] [hooks: 2]");
  });

  it("omits zero hooks", () => {
    expect(formatBlockListMeta(record({ hooksCount: 0 }))).toBe("");
  });

  it("omits meta on thought rows", () => {
    expect(formatBlockListMeta(record({ toolName: "Thought", durationMs: 900, hooksCount: 2 }))).toBe("");
  });
});

describe("formatBlockListStatusGlyph", () => {
  it("uses an animated frame for running rows", () => {
    expect(formatBlockListStatusGlyph("running", {}, "⠼")).toBe("⠼");
  });

  it("uses terminal-safe unicode fallbacks for terminal states", () => {
    expect(formatBlockListStatusGlyph("done", {})).toBe("✓");
    expect(formatBlockListStatusGlyph("error", {})).toBe("✗");
    expect(formatBlockListStatusGlyph("pending", {})).toBe("◆");
  });

  it("prefers provided icon glyphs for success and failure", () => {
    expect(formatBlockListStatusGlyph("done", { check: "ok" })).toBe("ok");
    expect(formatBlockListStatusGlyph("error", { error: "no" })).toBe("no");
  });
});

describe("formatBlockListExpandedDetail", () => {
  it("unwraps serialized command result envelopes into readable output", () => {
    const detail = formatBlockListExpandedDetail(
      record({
        toolName: "Command",
        output: JSON.stringify({
          output: "line one\nline two\n",
          exitCode: 0,
          status: "completed",
          durationMs: 42,
        }),
      }),
    );

    expect(detail).toBe("line one\nline two\nexit 0 · completed · 42ms");
  });

  it("pretty-prints structured JSON when there is no output envelope", () => {
    const detail = formatBlockListExpandedDetail(record({ output: '{"foo":{"bar":1}}' }));

    expect(detail).toBe('{\n  "foo": {\n    "bar": 1\n  }\n}');
  });

  it("leaves plain text output unchanged", () => {
    expect(formatBlockListExpandedDetail(record({ output: "plain output" }))).toBe("plain output");
  });
});

describe("formatOutputHint", () => {
  it("detects no matches from grep output", () => {
    expect(formatOutputHint("grep", "found 0 matches")).toBe("(no matches)");
  });
});

describe("parseGrepMatchSummary", () => {
  it("parses match and file counts", () => {
    expect(parseGrepMatchSummary("Found 4 matches\n\na.ts:\n  Line 1: x\nb.ts:\n  Line 2: y\nc.ts:\n  Line 3: z")).toBe(
      "(4 matches in 3 files)",
    );
  });
});

describe("parseReadRangeFromOutput", () => {
  it("extracts line range", () => {
    expect(parseReadRangeFromOutput("[app.tsx: lines 701-750 of 7351]\n701 | foo")).toEqual({
      start: 701,
      end: 750,
      total: 7351,
    });
  });
});

describe("formatThoughtLabel", () => {
  it("formats sub-10s with one decimal", () => {
    expect(formatThoughtLabel(1_000)).toBe("Thought for 1.0s");
  });
});

describe("expandBlockListRecords", () => {
  it("inserts thought rows for large timestamp gaps", () => {
    const t0 = new Date("2026-06-06T20:24:00Z");
    const t1 = new Date("2026-06-06T20:24:02Z");
    const expanded = expandBlockListRecords([record({ id: "a", timestamp: t0 }), record({ id: "b", timestamp: t1 })]);
    expect(expanded).toHaveLength(3);
    expect(expanded[1]?.toolName).toBe("Thought");
    expect(expanded[1]?.durationMs).toBe(2_000);
  });
});

describe("collapseBlockListCalls", () => {
  it("keeps the tail and reports hidden count", () => {
    const calls = Array.from({ length: 10 }, (_, i) => record({ id: `tc-${i}` }));
    const { hiddenCount, visible } = collapseBlockListCalls(calls, 8);
    expect(hiddenCount).toBe(2);
    expect(visible).toHaveLength(8);
    expect(visible[0]?.id).toBe("tc-2");
    expect(visible[7]?.id).toBe("tc-9");
  });
});

describe("ToolCallBlockList layout", () => {
  it("clips long rows to the available transcript width", () => {
    const source = readFileSync(fileURLToPath(new URL("./tool-call-block-list.tsx", import.meta.url)), "utf8");

    expect(source).toContain('width="100%"');
    expect(source).toContain('overflow="hidden"');
    expect(source).toContain('wrapMode={expanded ? "word" : "none"}');
  });
});
