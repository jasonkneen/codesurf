import { type ChildProcessByStdio, spawnSync } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough, type Readable } from "stream";
import { afterEach, describe, expect, it } from "vitest";
import { executeGrep, type GrepSpawn } from "./grep";

interface FakeRipgrepScript {
  stdout?: Array<Buffer | string>;
  stderr?: string;
  exitCode?: number | null;
  /** Keep stdout open until the child is killed. */
  hang?: boolean;
}

interface FakeRipgrep {
  spawn: GrepSpawn;
  kills: NodeJS.Signals[];
  spawned: Promise<void>;
}

function createFakeRipgrep(script: FakeRipgrepScript): FakeRipgrep {
  const kills: NodeJS.Signals[] = [];
  let markSpawned: () => void = () => {};
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });

  const spawn: GrepSpawn = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;

    let closed = false;
    const finish = (code: number | null) => {
      if (closed) return;
      closed = true;
      child.emit("close", code);
    };

    child.kill = (signal = "SIGTERM") => {
      kills.push(signal);
      child.killed = true;
      child.stdout.destroy();
      child.stderr.destroy();
      setImmediate(() => finish(null));
      return true;
    };

    // Mirror Node ordering: stdout data → stdout end → close.
    child.stdout.on("end", () => {
      if (!script.hang) finish(script.exitCode ?? 0);
    });

    setImmediate(() => {
      if (script.stderr) child.stderr.write(script.stderr);
      child.stderr.end();
      for (const chunk of script.stdout ?? []) child.stdout.write(chunk);
      if (!script.hang) child.stdout.end();
      markSpawned();
    });

    return child as unknown as ChildProcessByStdio<null, Readable, Readable>;
  };

  return { spawn, kills, spawned };
}

function matchRecord(file: string, line: number, text: string): string {
  return `${JSON.stringify({
    type: "match",
    data: {
      path: { text: file },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: [{ match: { text }, start: 0, end: text.length }],
    },
  })}\n`;
}

function matchRecords(count: number): string {
  let out = "";
  for (let i = 1; i <= count; i++) out += matchRecord("src/a.ts", i, `needle ${i}`);
  return out;
}

function countLines(output: string | undefined): number {
  return (output ?? "").split("\n").filter((line) => line.startsWith("  Line ")).length;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-grep-"));
  tempDirs.push(dir);
  return dir;
}

describe("executeGrep with a fake ripgrep", () => {
  it("reports exit code 2 with stderr as an error when nothing matched", async () => {
    const cwd = createTempDir();
    const fake = createFakeRipgrep({ stderr: "rg: regex parse error:\n    a(\nerror: unclosed group\n", exitCode: 2 });

    const result = await executeGrep({ pattern: "a(" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Grep failed");
    expect(result.error).toContain("regex parse error");
    expect(result.output).toBeUndefined();
  });

  it("returns partial results with an incomplete-search notice when ripgrep exits 2 after matches", async () => {
    const cwd = createTempDir();
    const fake = createFakeRipgrep({
      stdout: [matchRecord("a.txt", 1, "hello"), matchRecord("a.txt", 2, "hello world")],
      stderr: "rg: ./sub/b.txt: Permission denied (os error 13)\n",
      exitCode: 2,
    });

    const result = await executeGrep({ pattern: "hello" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Found 2 matches");
    expect(result.output).toContain("Line 1: hello");
    expect(result.output).toContain("Search incomplete");
    expect(result.output).toContain("Permission denied");
  });

  it("reports exactly 100 matches as a complete result", async () => {
    const cwd = createTempDir();
    const fake = createFakeRipgrep({ stdout: [matchRecords(100)], exitCode: 0 });

    const result = await executeGrep({ pattern: "needle" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(true);
    expect(result.output?.split("\n")[0]).toBe("Found 100 matches");
    expect(countLines(result.output)).toBe(100);
    expect(result.output).not.toContain("truncated");
    expect(result.output).not.toContain("limit reached");
    expect(fake.kills).toEqual([]);
  });

  it("stops at the cap for 101+ matches, warns, and never claims an exact total", async () => {
    const cwd = createTempDir();
    const fake = createFakeRipgrep({ stdout: [matchRecords(150)], exitCode: 0 });

    const result = await executeGrep({ pattern: "needle" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(true);
    expect(result.output?.split("\n")[0]).toBe("Found 100 matches (limit reached; more exist, total not counted)");
    expect(countLines(result.output)).toBe(100);
    expect(result.output).toContain(
      "(Results truncated: the search stopped after 100 matches, so the total is unknown.",
    );
    expect(result.output).not.toContain("Found 150");
    // Cap termination stops the child but resolves as a capped result, never as a cancellation.
    expect(fake.kills).toEqual(["SIGTERM"]);
  });

  it("rejects on user cancellation instead of resolving a capped result", async () => {
    const cwd = createTempDir();
    const fake = createFakeRipgrep({ stdout: [matchRecords(3)], hang: true });
    const controller = new AbortController();

    const pending = executeGrep({ pattern: "needle" }, cwd, controller.signal, { spawn: fake.spawn });
    await fake.spawned;
    controller.abort();

    await expect(pending).rejects.toThrow("Grep aborted.");
    expect(fake.kills).toEqual(["SIGTERM"]);
  });

  it("returns an aborted error without spawning when the signal is already aborted", async () => {
    const cwd = createTempDir();
    let spawnCalls = 0;
    const spawn: GrepSpawn = () => {
      spawnCalls++;
      throw new Error("should not spawn");
    };
    const controller = new AbortController();
    controller.abort();

    const result = await executeGrep({ pattern: "needle" }, cwd, controller.signal, { spawn });

    expect(result).toEqual({ success: false, error: "Grep aborted." });
    expect(spawnCalls).toBe(0);
  });

  it("decodes UTF-8 correctly when a multi-byte character is split across chunks", async () => {
    const cwd = createTempDir();
    const record = Buffer.from(matchRecord("a.txt", 7, "héllo wörld"), "utf8");
    const splitAt = record.indexOf(Buffer.from("é", "utf8")) + 1; // between the two bytes of é
    const fake = createFakeRipgrep({
      stdout: [record.subarray(0, splitAt), record.subarray(splitAt)],
      exitCode: 0,
    });

    const result = await executeGrep({ pattern: "h.llo" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Line 7: héllo wörld");
    expect(result.output).not.toContain("�");
  });

  it("discards oversized records with bounded buffering and says so", async () => {
    const cwd = createTempDir();
    const huge = Buffer.from(matchRecord("big.txt", 1, "x".repeat(70_000)), "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < huge.length; offset += 8 * 1024) {
      chunks.push(huge.subarray(offset, offset + 8 * 1024));
    }
    chunks.push(Buffer.from(matchRecord("small.txt", 3, "needle"), "utf8"));
    const fake = createFakeRipgrep({ stdout: chunks, exitCode: 0 });

    const result = await executeGrep({ pattern: "needle" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Found 1 matches");
    expect(result.output).toContain("Line 3: needle");
    expect(result.output).not.toContain("big.txt");
    expect(result.output).toContain("(Skipped 1 oversized result record larger than 65536 bytes.)");
  });

  it("mentions skipped oversized records even when nothing else matched", async () => {
    const cwd = createTempDir();
    const huge = Buffer.from(matchRecord("big.txt", 1, "x".repeat(70_000)), "utf8");
    const fake = createFakeRipgrep({ stdout: [huge], exitCode: 0 });

    const result = await executeGrep({ pattern: "x" }, cwd, undefined, { spawn: fake.spawn });

    expect(result.success).toBe(true);
    expect(result.output).toBe("No matches found.\n(Skipped 1 oversized result record larger than 65536 bytes.)");
  });
});

const hasRipgrep = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasRipgrep)("executeGrep with real ripgrep", () => {
  it("surfaces an invalid regex as an error", async () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, "a.txt"), "hello\n");

    const result = await executeGrep({ pattern: "a(" }, cwd);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/regex|parse/i);
  });

  it("surfaces a nonexistent search path as an error", async () => {
    const cwd = createTempDir();

    const result = await executeGrep({ pattern: "hello", path: "missing-dir" }, cwd);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Grep failed");
    expect(result.error).toContain("missing-dir");
  });

  it("reports exactly 100 matches as complete and 101 as capped", async () => {
    const cwd = createTempDir();
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `needle ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(cwd, "hundred.txt"), `${lines(100)}\n`);

    const exact = await executeGrep({ pattern: "^needle", path: "hundred.txt" }, cwd);
    expect(exact.success).toBe(true);
    expect(exact.output?.split("\n")[0]).toBe("Found 100 matches");
    expect(countLines(exact.output)).toBe(100);
    expect(exact.output).not.toContain("truncated");

    fs.writeFileSync(path.join(cwd, "more.txt"), `${lines(101)}\n`);
    const capped = await executeGrep({ pattern: "^needle", path: "more.txt" }, cwd);
    expect(capped.success).toBe(true);
    expect(capped.output?.split("\n")[0]).toBe("Found 100 matches (limit reached; more exist, total not counted)");
    expect(countLines(capped.output)).toBe(100);
    expect(capped.output).toContain("Results truncated");
  });
});
