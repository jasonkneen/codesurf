// Cross-process serialization of the pairing store (NET review, pairing.ts).
//
// The TUI and a headless bridge are separate processes that both register and
// approve pairing codes. Atomic rename stops a reader seeing half a JSON
// document, but it does not stop two processes reading the same snapshot and
// one of them renaming its version over the other — a lost registration, or a
// code consumed twice. `mutateStore` therefore holds an exclusive lock file
// for the whole read-prune-modify-rename cycle.
//
// The first three cases drive the lock directly and are deterministic; the
// last one is the review's own two-process scenario driven through a barrier.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PAIRING_MODULE = fileURLToPath(new URL("./pairing.ts", import.meta.url));
const STORE_FILE = "telegram-pairing-codes.json";
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

let tempHome: string;
let workDir: string;

function storePath(): string {
  return path.join(tempHome, STORE_FILE);
}

function lockPath(): string {
  return `${storePath()}.lock`;
}

function readStore(): Record<string, { userId: number; expiresAt: number }> {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * A worker that waits on a file barrier and then performs one pairing
 * mutation, so several of them enter their read-modify-write cycles at the
 * same moment. Results go to disk; the parent asserts on them.
 */
function workerSource(): string {
  return `
import * as fs from "node:fs";
import { approvePairingCode, registerPairingCode } from ${JSON.stringify(PAIRING_MODULE)};

const [, , action, outPath, readyPath, goPath, arg] = process.argv;
if (readyPath !== "-") {
  fs.writeFileSync(readyPath, "ready");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(goPath)) {
    if (Date.now() > deadline) throw new Error("barrier timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}
const result = action === "register" ? registerPairingCode(Number(arg)) : approvePairingCode(arg);
fs.writeFileSync(outPath, JSON.stringify({ pid: process.pid, result }));
`;
}

function startWorker(args: string[]): ReturnType<typeof spawn> {
  return spawn("bun", [path.join(workDir, "worker.ts"), ...args], {
    env: { ...process.env, CODESURF_HOME: tempHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-pairing-xp-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-pairing-worker-"));
  fs.writeFileSync(path.join(workDir, "worker.ts"), workerSource());
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!bunAvailable)("pairing store cross-process serialization", () => {
  it("blocks another process's mutation while the lock is held by a live owner", async () => {
    fs.mkdirSync(tempHome, { recursive: true });
    // This test process is alive, so the lock is neither stale nor abandoned.
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });

    const out = path.join(workDir, "blocked.json");
    const readyPath = path.join(workDir, "ready-blocked");
    const goPath = path.join(workDir, "go-blocked");
    const child = startWorker(["register", out, readyPath, goPath, "4242"]);
    const exited = waitForExit(child);

    let settled = false;
    void exited.then(() => {
      settled = true;
    });
    // Release the worker only once it is warm, so the window below measures
    // the lock and not Bun's startup.
    await waitForFile(readyPath);
    fs.writeFileSync(goPath, "go");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(fs.existsSync(out)).toBe(false);

    fs.rmSync(lockPath(), { force: true });
    expect(await exited).toBe(0);
    expect(Object.values(readStore()).map((entry) => entry.userId)).toEqual([4242]);
  }, 20_000);

  it("takes over a lock whose owner is gone instead of waiting for it", async () => {
    fs.mkdirSync(tempHome, { recursive: true });
    // A pid that cannot be running: the owner died mid-cycle.
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 30, at: Date.now() }), { flag: "wx" });

    const out = path.join(workDir, "takeover.json");
    const started = Date.now();
    expect(await waitForExit(startWorker(["register", out, "-", "-", "7"]))).toBe(0);
    // Well under the 2s bounded wait: the lock was broken, not waited out.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.values(readStore()).map((entry) => entry.userId)).toEqual([7]);
  }, 20_000);

  it("proceeds after the bounded wait rather than refusing to pair forever", async () => {
    fs.mkdirSync(tempHome, { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });

    const out = path.join(workDir, "bounded.json");
    expect(await waitForExit(startWorker(["register", out, "-", "-", "9"]))).toBe(0);
    expect(Object.values(readStore()).map((entry) => entry.userId)).toEqual([9]);
    fs.rmSync(lockPath(), { force: true });
  }, 20_000);

  it("loses no registration when two processes register through a barrier", async () => {
    const goPath = path.join(workDir, "go-register");
    const outs = [path.join(workDir, "r1.json"), path.join(workDir, "r2.json")];
    const readys = [path.join(workDir, "ready1"), path.join(workDir, "ready2")];

    const children = [
      startWorker(["register", outs[0], readys[0], goPath, "1001"]),
      startWorker(["register", outs[1], readys[1], goPath, "1002"]),
    ];
    const exits = children.map(waitForExit);
    await Promise.all(readys.map((file) => waitForFile(file)));
    fs.writeFileSync(goPath, "go");
    expect(await Promise.all(exits)).toEqual([0, 0]);

    const codes = outs.map((file) => JSON.parse(fs.readFileSync(file, "utf8")).result as string);
    expect(new Set(codes).size).toBe(2);
    const stored = readStore();
    // Both registrations survive: neither process's rename erased the other's.
    expect(Object.keys(stored).sort()).toEqual([...codes].sort());
    expect(
      Object.values(stored)
        .map((entry) => entry.userId)
        .sort(),
    ).toEqual([1001, 1002]);
  }, 30_000);

  it("consumes a code exactly once when two processes approve it through a barrier", async () => {
    // Seed one pending code from a third process so neither approver created it.
    const seedOut = path.join(workDir, "seed.json");
    expect(await waitForExit(startWorker(["register", seedOut, "-", "-", "5150"]))).toBe(0);
    const code = JSON.parse(fs.readFileSync(seedOut, "utf8")).result as string;

    const goPath = path.join(workDir, "go-approve");
    const outs = [path.join(workDir, "a1.json"), path.join(workDir, "a2.json")];
    const readys = [path.join(workDir, "ready-a1"), path.join(workDir, "ready-a2")];

    const children = [
      startWorker(["approve", outs[0], readys[0], goPath, code]),
      startWorker(["approve", outs[1], readys[1], goPath, code]),
    ];
    const exits = children.map(waitForExit);
    await Promise.all(readys.map((file) => waitForFile(file)));
    fs.writeFileSync(goPath, "go");
    expect(await Promise.all(exits)).toEqual([0, 0]);

    const results = outs.map((file) => JSON.parse(fs.readFileSync(file, "utf8")).result as { ok: boolean });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(readStore()).toEqual({});
  }, 30_000);
});
