import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("DiffReview layout", () => {
  it("wraps diff lines instead of silently clipping them", () => {
    const source = readFileSync(fileURLToPath(new URL("./diff-review.tsx", import.meta.url)), "utf8");
    const lineText = source.match(/<text key=\{`\$\{file\.path\}-\$\{index\}`\}[^>]*>/)?.[0] ?? "";

    expect(lineText).not.toBe("");
    expect(lineText).not.toContain('wrapMode="none"');
    expect(lineText).toMatch(/wrapMode="(char|word)"/);
  });
});
