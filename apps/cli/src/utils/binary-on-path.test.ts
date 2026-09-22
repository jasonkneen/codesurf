import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBinaryInstalled } from "./binary-on-path.js";
import { clearCliCheckCache } from "./cli-check-cache.js";

let dir: string;
let originalPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "binpath-"));
  originalPath = process.env.PATH;
  clearCliCheckCache();
});

afterEach(() => {
  process.env.PATH = originalPath;
  clearCliCheckCache();
});

function makeExecutable(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

describe("isBinaryInstalled", () => {
  it("finds an executable on PATH", () => {
    makeExecutable("fake-cli");
    process.env.PATH = dir;
    expect(isBinaryInstalled("fake-cli")).toBe(true);
  });

  it("returns false when the binary is absent", () => {
    process.env.PATH = dir;
    expect(isBinaryInstalled("definitely-not-installed-xyz")).toBe(false);
  });

  it("returns false for a file on PATH that is not executable", () => {
    const p = join(dir, "not-exec");
    writeFileSync(p, "nope");
    chmodSync(p, 0o644);
    process.env.PATH = dir;
    expect(isBinaryInstalled("not-exec")).toBe(false);
  });

  it("honours an explicit path instead of searching PATH", () => {
    const p = makeExecutable("explicit-cli");
    process.env.PATH = ""; // not on PATH at all
    expect(isBinaryInstalled(p)).toBe(true);
    expect(isBinaryInstalled(join(dir, "missing-cli"))).toBe(false);
  });

  it("searches every PATH entry", () => {
    const other = mkdtempSync(join(tmpdir(), "binpath2-"));
    makeExecutable("second-dir-cli");
    process.env.PATH = [other, dir].join(delimiter);
    expect(isBinaryInstalled("second-dir-cli")).toBe(true);
  });

  // The whole point: this replaces `execFileSync(bin, ["--help"])`, which for a
  // heavy binary like `fractal` blocked the event loop for ~1.5s at boot. A PATH
  // stat answers the same question ("is it installed") without booting the tool.
  it("is fast enough to sit on the render path", () => {
    makeExecutable("fast-cli");
    process.env.PATH = dir;
    const t = performance.now();
    for (let i = 0; i < 50; i++) {
      clearCliCheckCache(); // force a real lookup every iteration
      isBinaryInstalled("fast-cli");
    }
    expect(performance.now() - t).toBeLessThan(100); // 50 cold lookups < 100ms
  });

  it("memoizes so repeat calls do not re-stat", () => {
    makeExecutable("cached-cli");
    process.env.PATH = dir;
    expect(isBinaryInstalled("cached-cli")).toBe(true);

    // Cache hit: still true even though PATH no longer contains it.
    process.env.PATH = "";
    expect(isBinaryInstalled("cached-cli")).toBe(true);

    clearCliCheckCache();
    expect(isBinaryInstalled("cached-cli")).toBe(false);
  });
});
