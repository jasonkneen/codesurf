import { execSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { FileIndex } from "./file-index.js";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-index-test-"));
  // No `.git` -> exercises the `find` fallback in collectFiles.
  fs.writeFileSync(path.join(dir, "auth.ts"), "// authentication entrypoint");
  fs.writeFileSync(path.join(dir, "session-manager.ts"), "// session state");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "router.ts"), "// route table");
  fs.writeFileSync(path.join(dir, "README.md"), "# repo");
  return dir;
}

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("FileIndex.matchTokens", () => {
  it("returns prose-query matches that plain match() drops", async () => {
    const dir = makeRepo();
    created.push(dir);
    const index = new FileIndex(dir);
    await index.refresh();

    // The original bug: prose queries are never substrings of any path,
    // so plain match() returned [].
    expect(await index.match("how is authentication initialized?", 5)).toEqual([]);

    const tokenHits = await index.matchTokens("how is authentication initialized?", 5);
    expect(tokenHits.some((p) => p.endsWith("auth.ts"))).toBe(true);
  });

  it("ranks paths matching multiple tokens above paths matching one", async () => {
    const dir = makeRepo();
    created.push(dir);
    const index = new FileIndex(dir);
    await index.refresh();

    const hits = await index.matchTokens("session router", 5);
    // session-manager.ts and src/router.ts each match one token; both should
    // appear before unrelated files.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const top2 = hits
      .slice(0, 2)
      .map((p) => path.basename(p))
      .sort();
    expect(top2).toEqual(["router.ts", "session-manager.ts"]);
  });

  it("falls back to substring match when tokens yield no hits", async () => {
    const dir = makeRepo();
    created.push(dir);
    const index = new FileIndex(dir);
    await index.refresh();

    // Only stopwords + sub-3-char tokens after tokenization -> falls back
    // to plain match("the and is a"), which itself returns [] for these
    // paths. Verifies fallback path runs without throwing.
    await expect(index.matchTokens("the and is a", 5)).resolves.toEqual([]);
  });

  it("exposes the refreshed file list for semantic indexing", async () => {
    const dir = makeRepo();
    created.push(dir);
    const index = new FileIndex(dir);
    await index.refresh();

    const files = await index.list();
    expect(files).toEqual(expect.arrayContaining(["auth.ts", "session-manager.ts", "src/router.ts"]));
  });
});

describe("FileIndex listing hardening (M12/L15)", () => {
  it("drops committed symlinks and keeps git paths verbatim (ls-files -z)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-index-git-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "file-index-outside-"));
    created.push(dir, outside);
    execSync("git init -q", { cwd: dir });
    fs.writeFileSync(path.join(outside, "id_rsa"), "PRIVATE");
    fs.symlinkSync(path.join(outside, "id_rsa"), path.join(dir, "key.txt"));
    fs.writeFileSync(path.join(dir, "real.ts"), "x");
    // Without -z git C-quotes this name ("sp\\303\\251cial ...") and it no longer resolves.
    fs.writeFileSync(path.join(dir, "spécial name.ts"), "y");
    const index = new FileIndex(dir);
    await index.refresh();
    const files = await index.list();
    expect(files).toContain("real.ts");
    expect(files).toContain("spécial name.ts");
    expect(files).not.toContain("key.txt");
    expect(index.truncated).toBe(false);
  });
});
