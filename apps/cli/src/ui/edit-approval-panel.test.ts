import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import { patchToDiffFile } from "./edit-approval-panel";

describe("patchToDiffFile", () => {
  it("keeps added/removed lines whose content starts with ++ or --", () => {
    const before = "let i = 0;\n--i;\nkeep\n";
    const after = "let i = 0;\n++i;\nkeep\n";
    const patch = createTwoFilesPatch("a.js", "a.js", before, after, "", "", { context: 3 });
    const file = patchToDiffFile({
      filePath: "a.js",
      absolutePath: "/tmp/a.js",
      isNew: false,
      additions: 1,
      removals: 1,
      patch,
      noop: false,
    });
    expect(file.lines.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["+++i;"]);
    expect(file.lines.filter((l) => l.type === "remove").map((l) => l.text)).toEqual(["---i;"]);
    // The file headers themselves are still dropped.
    expect(file.lines.some((l) => l.text.startsWith("--- a.js") || l.text.startsWith("+++ a.js"))).toBe(false);
  });
});
