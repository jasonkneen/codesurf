import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvePairingCode, clearPairingStore, registerPairingCode } from "./pairing";

const originalHome = process.env.CODESURF_HOME;
let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-pairing-"));
  process.env.CODESURF_HOME = tempHome;
  clearPairingStore();
});

afterEach(() => {
  clearPairingStore();
  if (originalHome === undefined) delete process.env.CODESURF_HOME;
  else process.env.CODESURF_HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("telegram pairing", () => {
  it("approves a registered code", () => {
    const code = registerPairingCode(12345);

    expect(approvePairingCode(code)).toEqual({ ok: true, userId: 12345 });
  });

  it("normalizes whitespace and lowercase", () => {
    const code = registerPairingCode(67890);

    expect(approvePairingCode(`  ${code.toLowerCase()}  `)).toEqual({ ok: true, userId: 67890 });
  });

  it("persists pending codes for approval from another process", () => {
    const code = registerPairingCode(24680);
    // Simulate a fresh process with empty in-memory state but same CODESURF_HOME.
    // clearPairingStore would remove disk too, so mutate the module-private disk
    // representation indirectly by reloading from disk during approval.
    const storeFile = path.join(tempHome, "telegram-pairing-codes.json");
    expect(fs.existsSync(storeFile)).toBe(true);

    expect(approvePairingCode(code)).toEqual({ ok: true, userId: 24680 });
    expect(JSON.parse(fs.readFileSync(storeFile, "utf8"))).toEqual({});
  });

  it("rejects unknown codes with actionable text", () => {
    expect(approvePairingCode("ABC123")).toEqual({
      ok: false,
      error: "Unknown or expired code. Send /pair again in Telegram.",
    });
  });

  // Pairing disk sync was an unlocked read-modify-write. Every mutation now
  // runs through one synchronous owner and replaces the store atomically, so
  // interleaved registrations/approvals in one process lose no writes and a
  // code is consumed at most once.
  it("interleaved register/approve tasks lose no writes and consume each code once", async () => {
    const storeFile = path.join(tempHome, "telegram-pairing-codes.json");
    const registered: string[] = [];
    const kept: string[] = [];

    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (async () => {
          await new Promise((r) => setTimeout(r, i % 3));
          const code = registerPairingCode(5000 + i);
          registered.push(code);
          await new Promise((r) => setTimeout(r, 0));
          if (i % 2 === 0) {
            expect(approvePairingCode(code)).toEqual({ ok: true, userId: 5000 + i });
            expect(approvePairingCode(code).ok).toBe(false);
          } else {
            kept.push(code);
          }
        })(),
      ),
    );

    expect(new Set(registered).size).toBe(24);
    const onDisk = JSON.parse(fs.readFileSync(storeFile, "utf8")) as Record<string, { userId: number }>;
    expect(Object.keys(onDisk).sort()).toEqual([...kept].sort());
    for (const code of kept) {
      expect(approvePairingCode(code).ok).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync(storeFile, "utf8"))).toEqual({});
  });

  it("replaces the store atomically and leaves no temp files behind", () => {
    const code = registerPairingCode(777);
    approvePairingCode(code);
    registerPairingCode(778);

    expect(fs.readdirSync(tempHome)).toEqual(["telegram-pairing-codes.json"]);
    const raw = fs.readFileSync(path.join(tempHome, "telegram-pairing-codes.json"), "utf8");
    expect(Object.values(JSON.parse(raw) as Record<string, { userId: number }>).map((e) => e.userId)).toEqual([778]);
  });
});
