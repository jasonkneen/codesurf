import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_FILE_NAME = "telegram-poller.lock";

export type PollerLockResult = { acquired: true; release: () => void } | { acquired: false; holderPid: number };

let heldLockPath: string | null = null;
let exitHookInstalled = false;

function lockPath(dir?: string): string {
  return join(dir ?? join(homedir(), ".codesurf"), LOCK_FILE_NAME);
}

function readLockPid(file: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed?.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(file: string): boolean {
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(file: string): void {
  try {
    // Only remove the lock if it is still ours — another process may have
    // taken over after a stale-lock cleanup.
    if (readLockPid(file) === process.pid) {
      unlinkSync(file);
    }
  } catch {
    /* best-effort */
  }
  if (heldLockPath === file) heldLockPath = null;
}

/**
 * Claim the machine-wide right to long-poll Telegram. Only one CodeSurf
 * process may poll a bot token at a time — a second poller makes Telegram
 * return 409 Conflict to both. Callers must hold the lock only while
 * actually polling and release it as soon as polling stops.
 */
export function acquireTelegramPollerLock(dir?: string): PollerLockResult {
  const file = lockPath(dir);
  try {
    mkdirSync(join(file, ".."), { recursive: true });
  } catch {
    /* best-effort */
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(file)) {
      heldLockPath = file;
      installExitHook();
      return { acquired: true, release: () => releaseLock(file) };
    }
    const holderPid = readLockPid(file);
    if (holderPid !== null && isPidAlive(holderPid)) {
      return { acquired: false, holderPid };
    }
    // Stale (dead pid or unparseable) — remove and retry once.
    try {
      unlinkSync(file);
    } catch {
      /* raced with another process; retry will settle it */
    }
  }
  return { acquired: false, holderPid: readLockPid(file) ?? -1 };
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (heldLockPath) releaseLock(heldLockPath);
  });
}
