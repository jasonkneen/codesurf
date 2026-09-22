import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireTelegramPollerLock } from "./poller-lock";

// A pid that can never exist (macOS/Linux pid_max is far below this).
const DEAD_PID = 999999999;

describe("acquireTelegramPollerLock", () => {
  let dir: string;
  const lockFile = () => join(dir, "telegram-poller.lock");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "poller-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a fresh lock and records our pid", () => {
    const result = acquireTelegramPollerLock(dir);
    expect(result.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).pid).toBe(process.pid);
    if (result.acquired) result.release();
  });

  it("fails when a live process holds the lock", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, startedAt: "x" }));
    const result = acquireTelegramPollerLock(dir);
    expect(result).toEqual({ acquired: false, holderPid: process.pid });
  });

  it("takes over a stale lock held by a dead pid", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x" }));
    const result = acquireTelegramPollerLock(dir);
    expect(result.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).pid).toBe(process.pid);
    if (result.acquired) result.release();
  });

  it("takes over an unparseable lock file", () => {
    writeFileSync(lockFile(), "not json");
    const result = acquireTelegramPollerLock(dir);
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  it("release removes the lock file", () => {
    const result = acquireTelegramPollerLock(dir);
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("release leaves the lock alone if another pid replaced it", () => {
    const result = acquireTelegramPollerLock(dir);
    expect(result.acquired).toBe(true);
    writeFileSync(lockFile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x" }));
    if (result.acquired) result.release();
    expect(existsSync(lockFile())).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).pid).toBe(DEAD_PID);
  });
});
