// Real-process counterpart to persistent-stdio-session.test.ts: a child that
// ignores SIGINT and SIGTERM must not keep `disconnect()` waiting forever.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../../api";
import { PersistentStdioSession, textContent } from "./persistent-stdio-session";

let dir: string;
let ignoresSignals: string;

const IGNORES_SIGNALS = `
process.on("SIGTERM", () => { process.stderr.write("ignoring SIGTERM\\n"); });
process.on("SIGINT", () => { process.stderr.write("ignoring SIGINT\\n"); });
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: String(process.pid) }) + "\\n");
setInterval(() => {}, 1000);
`;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codesurf-persistent-"));
  ignoresSignals = path.join(dir, "ignores-signals.cjs");
  writeFileSync(ignoresSignals, IGNORES_SIGNALS);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PersistentStdioSession — real child that ignores signals", () => {
  it("abortTurn() settles the turn and disconnect() escalates to SIGKILL", async () => {
    const events: ProviderStreamEvent[] = [];
    let pid: number | null = null;
    const session = new PersistentStdioSession({
      bin: process.execPath,
      args: [ignoresSignals],
      cwd: dir,
      label: "fixture",
      stallMs: 0,
      terminateGraceMs: 250,
      onSessionId: (id) => {
        pid = Number(id);
      },
    });

    const turn = session.sendTurn(textContent("A"), { emit: (e) => events.push(e) });
    await vi.waitFor(() => expect(pid).not.toBeNull(), { timeout: 10_000 });

    session.abortTurn();
    await expect(turn).rejects.toThrow("fixture turn aborted.");

    await session.disconnect();
    expect(() => process.kill(pid as number, 0)).toThrow();
  }, 15_000);
});
