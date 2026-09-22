import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inlineImageCacheKey, pruneInlineImageCache } from "./inline-image-cache";

const sizing = { maxWidthCells: 60, maxHeightCells: 16, cellPxW: 9, cellPxH: 18 };

describe("inlineImageCacheKey", () => {
  it("changes when the source file is modified in place", () => {
    const before = inlineImageCacheKey("/tmp/shot.png", { mtimeMs: 1000, size: 10 }, sizing);
    expect(inlineImageCacheKey("/tmp/shot.png", { mtimeMs: 2000, size: 10 }, sizing)).not.toBe(before);
    expect(inlineImageCacheKey("/tmp/shot.png", { mtimeMs: 1000, size: 11 }, sizing)).not.toBe(before);
    expect(inlineImageCacheKey("/tmp/shot.png", { mtimeMs: 1000, size: 10 }, sizing)).toBe(before);
  });
});

describe("pruneInlineImageCache", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("removes stale entries and the oldest beyond the count bound", () => {
    dir = mkdtempSync(join(tmpdir(), "inline-image-cache-"));
    const now = Date.now();
    const write = (name: string, ageMs: number) => {
      const path = join(dir, name);
      writeFileSync(path, "x");
      const at = new Date(now - ageMs);
      utimesSync(path, at, at);
    };
    write("stale.png", 30 * 24 * 60 * 60 * 1000);
    write("a.png", 1000);
    write("b.png", 2000);
    write("c.png", 3000);
    write("keep.txt", 30 * 24 * 60 * 60 * 1000);

    const removed = pruneInlineImageCache(dir, { maxFiles: 2, now });

    expect(removed).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["a.png", "b.png", "keep.txt"]);
  });
});
