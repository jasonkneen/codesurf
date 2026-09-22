import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getCodesurfConfigDir } from "../utils/config-dir";

const PAIRING_TTL_MS = 60 * 60 * 1000;

interface PairingEntry {
  userId: number;
  expiresAt: number;
}

/** code (uppercase) -> { userId, expiresAt }; kept in memory for current process, mirrored to disk for cross-process UI/headless approval. */
const pendingByCode = new Map<string, PairingEntry>();

function pairingStorePath(): string {
  // Prefer CODESURF_HOME for tests/legacy override, then codesurf config dir.
  const home = process.env.CODESURF_HOME?.trim() || getCodesurfConfigDir();
  return path.join(home, "telegram-pairing-codes.json");
}

function readStore(): Record<string, PairingEntry> {
  try {
    const filePath = pairingStorePath();
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, PairingEntry> = {};
    for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[A-F0-9]{6}$/.test(code)) continue;
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<PairingEntry>;
      if (typeof entry.userId !== "number" || typeof entry.expiresAt !== "number") continue;
      out[code] = { userId: entry.userId, expiresAt: entry.expiresAt };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomic replace: write a sibling temp file, then rename over the store so a
 * concurrent reader (another CodeSurf process approving a code) never sees a
 * truncated or half-written JSON document.
 */
function writeStore(entries: Record<string, PairingEntry>): void {
  const filePath = pairingStorePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

/** Exclusive-creation lock guarding the store's read-modify-write cycle. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 5;

function pairingLockPath(): string {
  return `${pairingStorePath()}.lock`;
}

/**
 * Block the current thread briefly. The critical section is one small read and
 * one rename, so a waiter spins for microseconds in practice; the bounded wait
 * below is the backstop for a process that died mid-cycle.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockHolderPid(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function lockIsStale(file: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // Vanished between the failed create and this check — retry immediately.
    return true;
  }
  const pid = lockHolderPid(file);
  if (pid !== null && pid !== process.pid) {
    try {
      process.kill(pid, 0);
      // Holder is alive: only age can justify breaking the lock.
      return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    } catch (err) {
      // EPERM means the process exists but belongs to another user.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      }
      return true;
    }
  }
  return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
}

/**
 * Claim the pairing store for one read-modify-write cycle. Returns the
 * release function. A lock whose owner is gone (or that is older than
 * `LOCK_STALE_MS`) is taken over rather than waited on forever, and after the
 * bounded wait the cycle proceeds unlocked: losing pairing serialization is
 * better than refusing to pair at all.
 */
function acquireStoreLock(): () => void {
  const file = pairingLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (lockHolderPid(file) === process.pid) fs.rmSync(file, { force: true });
        } catch {
          // best-effort
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockIsStale(file)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // best-effort; the next create attempt reports the real state
        }
        continue;
      }
      if (Date.now() >= deadline) return () => {};
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function pruneExpired(entries: Record<string, PairingEntry>, now = Date.now()): Record<string, PairingEntry> {
  const out: Record<string, PairingEntry> = {};
  for (const [code, entry] of Object.entries(entries)) {
    if (now <= entry.expiresAt) out[code] = entry;
  }
  return out;
}

/**
 * The single owner of the read-prune-modify-write cycle. Every pairing
 * mutation goes through here, so two cycles can never interleave: `mutator`
 * always sees the freshest on-disk state, and its result replaces the store
 * atomically before memory is refreshed from it.
 *
 * The cycle is also serialized ACROSS processes by an exclusive lock file next
 * to the store. The TUI and a headless bridge run in separate processes and
 * both register and approve codes; without the lock two of them can read the
 * same snapshot, and one registration is lost or one code is consumed twice.
 * Atomic rename alone only prevents torn reads, not lost updates.
 */
function mutateStore<T>(mutator: (entries: Record<string, PairingEntry>) => T): T {
  const release = acquireStoreLock();
  try {
    const entries = pruneExpired(readStore());
    const result = mutator(entries);
    writeStore(entries);
    pendingByCode.clear();
    for (const [code, entry] of Object.entries(entries)) pendingByCode.set(code, entry);
    return result;
  } finally {
    release();
  }
}

function generateCode(): string {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

export function registerPairingCode(userId: number): string {
  return mutateStore((entries) => {
    let code = generateCode();
    // A colliding code would silently overwrite another user's pending entry.
    while (entries[code]) code = generateCode();
    entries[code] = { userId, expiresAt: Date.now() + PAIRING_TTL_MS };
    return code;
  });
}

export function approvePairingCode(code: string): { ok: true; userId: number } | { ok: false; error: string } {
  const normalized = code.trim().toUpperCase();
  return mutateStore((entries) => {
    const entry = entries[normalized];
    if (!entry) {
      return { ok: false, error: "Unknown or expired code. Send /pair again in Telegram." };
    }
    // Consumed exactly once, whether it turns out valid or expired.
    delete entries[normalized];
    if (Date.now() > entry.expiresAt) {
      return { ok: false, error: "Code expired. Send /pair again in Telegram." };
    }
    return { ok: true, userId: entry.userId };
  });
}

export function clearPairingStore(): void {
  pendingByCode.clear();
  try {
    fs.rmSync(pairingStorePath(), { force: true });
    fs.rmSync(pairingLockPath(), { force: true });
  } catch {
    // best-effort test/helper cleanup
  }
}
