import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCliEntry } from "./cli-entry";
import {
  isPidAlive,
  isValidServerName,
  listRecords,
  liveRecord,
  readRecord,
  recordPath,
  type ServerRecord,
  writeRecord,
} from "./registry";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-registry-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(name: string, pid: number, port = 3948): ServerRecord {
  return {
    name,
    pid,
    port,
    url: `ws://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
    cliVersion: "test",
    scope: "user",
  };
}

/** A pid that has certainly exited: a finished child. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return child.pid as number;
}

describe("server registry", () => {
  it("round-trips a record under servers/<name>.json", () => {
    writeRecord(record("default", process.pid), dir);
    expect(fs.existsSync(path.join(dir, "servers", "default.json"))).toBe(true);
    expect(readRecord("default", dir)).toMatchObject({ name: "default", pid: process.pid, port: 3948 });
  });

  it("lists live records and removes ones whose pid is dead", () => {
    writeRecord(record("alive", process.pid, 3948), dir);
    writeRecord(record("dead", deadPid(), 3949), dir);
    expect(listRecords(dir).map((r) => r.name)).toEqual(["alive"]);
    expect(fs.existsSync(recordPath("dead", dir))).toBe(false);
  });

  it("liveRecord drops a stale entry", () => {
    writeRecord(record("gone", deadPid()), dir);
    expect(liveRecord("gone", dir)).toBeNull();
    expect(fs.existsSync(recordPath("gone", dir))).toBe(false);
  });

  it("treats corrupt records as absent and cleans them up", () => {
    fs.mkdirSync(path.join(dir, "servers"), { recursive: true });
    fs.writeFileSync(recordPath("junk", dir), "{not json");
    expect(listRecords(dir)).toEqual([]);
    expect(fs.existsSync(recordPath("junk", dir))).toBe(false);
  });

  it("keeps a project server's scope and root", () => {
    writeRecord({ ...record("proj", process.pid), scope: "project", project: "/work/proj" }, dir);
    expect(readRecord("proj", dir)).toMatchObject({ scope: "project", project: "/work/proj" });
  });

  it("reads records from before scopes as user servers", () => {
    fs.mkdirSync(path.join(dir, "servers"), { recursive: true });
    const { scope: _scope, ...legacy } = record("old", process.pid);
    fs.writeFileSync(recordPath("old", dir), JSON.stringify(legacy));
    expect(readRecord("old", dir)).toMatchObject({ scope: "user" });
    expect(readRecord("old", dir)?.project).toBeUndefined();
  });

  it("returns [] when there is no servers dir", () => {
    expect(listRecords(path.join(dir, "missing"))).toEqual([]);
  });

  it("isPidAlive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid())).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it("validates names", () => {
    expect(isValidServerName("default")).toBe(true);
    expect(isValidServerName("second_2-a")).toBe(true);
    expect(isValidServerName("../etc")).toBe(false);
    expect(isValidServerName("")).toBe(false);
    expect(isValidServerName("-x")).toBe(false);
  });
});

describe("resolveCliEntry", () => {
  const files = new Set(["/repo/dist/index.js", "/repo/src/index.ts"]);
  const isFile = (p: string) => files.has(p);

  it("runs a built dist entry with the current runtime", () => {
    expect(resolveCliEntry(["bun", "/repo/dist/index.js", "server"], "/bin/bun", isFile)).toEqual({
      command: "/bin/bun",
      args: ["/repo/dist/index.js"],
    });
  });

  it("runs the TypeScript entry in dev", () => {
    expect(resolveCliEntry(["bun", "/repo/src/index.ts"], "/bin/bun", isFile)).toEqual({
      command: "/bin/bun",
      args: ["/repo/src/index.ts"],
    });
  });

  it("runs the binary alone when argv[1] is not a real file (bun --compile)", () => {
    expect(resolveCliEntry(["bun", "/$bunfs/root/codesurf", "server"], "/usr/local/bin/codesurf", isFile)).toEqual({
      command: "/usr/local/bin/codesurf",
      args: [],
    });
  });

  it("handles a missing argv[1]", () => {
    expect(resolveCliEntry(["/usr/local/bin/codesurf"], "/usr/local/bin/codesurf", isFile)).toEqual({
      command: "/usr/local/bin/codesurf",
      args: [],
    });
  });
});
