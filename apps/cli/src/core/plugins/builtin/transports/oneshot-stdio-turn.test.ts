// Real child processes, deliberately: cancellation is about what a process
// does with a signal, and only a process can tell us that. Fixtures are small
// node scripts written to an owned temp dir; nothing outside it is touched.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../../api";
import { resolveOneshotStallMs, runOneshotStreamJsonTurn } from "./oneshot-stdio-turn";

let dir: string;
let ignoresSignals: string;
let happyPath: string;
let exitsLeavingGrandchild: string;
let silentAfterInit: string;

const IGNORES_SIGNALS = `
process.on("SIGTERM", () => { process.stderr.write("ignoring SIGTERM\\n"); });
process.on("SIGINT", () => { process.stderr.write("ignoring SIGINT\\n"); });
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: String(process.pid) }) + "\\n");
setInterval(() => {}, 1000);
`;

// Exits promptly but leaves a detached grandchild holding the inherited
// stdout/stderr pipes, so the parent's `close` never arrives. Its pid is
// reported as the session id so the test can reap it.
const EXITS_LEAVING_GRANDCHILD = `
const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "inherit" });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: String(child.pid) }) + "\\n");
setTimeout(() => process.exit(0), 50);
`;

const HAPPY_PATH = `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 1 } }) + "\\n");
`;

// Streams its opening line, then goes silent forever without exiting — the
// shape of a wedged CLI. Nothing else ends this turn, so only a stall guard can.
const SILENT_AFTER_INIT = `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: String(process.pid) }) + "\\n");
setInterval(() => {}, 1000);
`;

function collect(): { events: ProviderStreamEvent[]; controller: { emit: (e: ProviderStreamEvent) => void } } {
  const events: ProviderStreamEvent[] = [];
  return { events, controller: { emit: (e) => events.push(e) } };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codesurf-oneshot-"));
  ignoresSignals = path.join(dir, "ignores-signals.cjs");
  happyPath = path.join(dir, "happy-path.cjs");
  exitsLeavingGrandchild = path.join(dir, "exits-leaving-grandchild.cjs");
  silentAfterInit = path.join(dir, "silent-after-init.cjs");
  writeFileSync(ignoresSignals, IGNORES_SIGNALS);
  writeFileSync(happyPath, HAPPY_PATH);
  writeFileSync(exitsLeavingGrandchild, EXITS_LEAVING_GRANDCHILD);
  writeFileSync(silentAfterInit, SILENT_AFTER_INIT);
});

describe("resolveOneshotStallMs (M4)", () => {
  it("defaults well past two minutes so a silent long tool run is not killed", () => {
    // 120s used to kill a grok turn whose CLI was quietly running a long build.
    expect(resolveOneshotStallMs({})).toBe(600_000);
  });

  it("honours CODESURF_ONESHOT_STALL_MS, including 0 to disable", () => {
    expect(resolveOneshotStallMs({ CODESURF_ONESHOT_STALL_MS: "30000" })).toBe(30_000);
    expect(resolveOneshotStallMs({ CODESURF_ONESHOT_STALL_MS: "0" })).toBe(0);
    expect(resolveOneshotStallMs({ CODESURF_ONESHOT_STALL_MS: "nope" })).toBe(600_000);
  });
});

describe("runOneshotStreamJsonTurn — stall watchdog", () => {
  it("fails a turn whose child streams nothing for the stall window", async () => {
    const { events, controller } = collect();

    await expect(
      runOneshotStreamJsonTurn(
        { bin: process.execPath, args: [silentAfterInit], cwd: dir, label: "stub", stallMs: 200 },
        controller,
      ),
    ).rejects.toThrow(/no output/i);

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error && "message" in error ? error.message : "").toMatch(/stub produced no output for 0s|no output/i);
  });

  it("does not fire while the child is still streaming", async () => {
    const chatty = path.join(dir, "chatty.cjs");
    // Every gap (300ms) is well inside the stall window, but the whole stream
    // (~2.4s) outlasts it, so a guard that failed to re-arm on output would
    // kill this turn mid-stream. The window also leaves room for a slow child
    // boot on a loaded machine before the first line arrives.
    writeFileSync(
      chatty,
      `
let n = 0;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }) + "\\n");
const t = setInterval(() => {
  n += 1;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tick" }] } }) + "\\n");
  if (n === 8) {
    clearInterval(t);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} }) + "\\n");
  }
}, 300);
`,
    );
    const { events, controller } = collect();

    await runOneshotStreamJsonTurn(
      { bin: process.execPath, args: [chatty], cwd: dir, label: "stub", stallMs: 1_500 },
      controller,
    );

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.filter((e) => e.type === "text-delta").length).toBeGreaterThan(0);
  });

  it("leaves the watchdog disarmed when stallMs is zero", async () => {
    const { events, controller } = collect();
    await runOneshotStreamJsonTurn(
      { bin: process.execPath, args: [happyPath], cwd: dir, label: "stub", stallMs: 0 },
      controller,
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runOneshotStreamJsonTurn — cancellation", () => {
  it("escalates to SIGKILL when the child ignores SIGTERM and settles once it is gone", async () => {
    const ac = new AbortController();
    const { events, controller } = collect();
    let pid: number | null = null;
    const turn = runOneshotStreamJsonTurn(
      {
        bin: process.execPath,
        args: [ignoresSignals],
        cwd: dir,
        label: "fixture",
        abortSignal: ac.signal,
        terminateGraceMs: 250,
        // Abort only once the child has installed its handlers (they are
        // registered before it writes the init line).
        onSessionId: (id) => {
          pid = Number(id);
          ac.abort();
        },
      },
      controller,
    );

    await expect(turn).rejects.toThrow("fixture turn aborted.");
    expect(pid).not.toBeNull();
    // Our own child, already reaped by its exit event: a signal-0 probe must
    // fail. If the bounded wait had settled the turn with the child alive,
    // this would still succeed and fail the test.
    expect(() => process.kill(pid as number, 0)).toThrow();
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "fixture turn aborted." }]);
    expect(events.some((e) => e.type === "done")).toBe(false);
  }, 15_000);

  it("settles a cancellation that arrives after exit, without waiting on a descendant's pipes", async () => {
    const ac = new AbortController();
    const { events, controller } = collect();
    let grandchildPid: number | null = null;
    const turn = runOneshotStreamJsonTurn(
      {
        bin: process.execPath,
        args: [exitsLeavingGrandchild],
        cwd: dir,
        label: "fixture",
        abortSignal: ac.signal,
        // Short bound: if the fix regressed, this test hangs waiting on
        // `close` rather than finishing inside it.
        terminateGraceMs: 200,
        onSessionId: (id) => {
          grandchildPid = Number(id);
        },
      },
      controller,
    );

    // The fixture exits ~50ms after writing its init line, leaving only the
    // detached grandchild on the inherited pipes. Cancel after that exit has
    // landed: `exit` has fired, `close` has not and may never.
    await vi.waitFor(() => expect(grandchildPid).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 400));

    const abortedAt = Date.now();
    ac.abort();
    await expect(turn).rejects.toThrow("fixture turn aborted.");
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "fixture turn aborted." }]);

    if (grandchildPid !== null) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 20_000);

  it("does not spawn at all when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { events, controller } = collect();
    const turn = runOneshotStreamJsonTurn(
      {
        // Had a spawn happened this would surface as an ENOENT error instead.
        bin: path.join(dir, "definitely-missing-binary"),
        args: [],
        cwd: dir,
        label: "fixture",
        abortSignal: ac.signal,
      },
      controller,
    );
    await expect(turn).rejects.toThrow("fixture turn aborted.");
    expect(events).toEqual([{ type: "error", message: "fixture turn aborted." }]);
  });
});

describe("runOneshotStreamJsonTurn — completion", () => {
  it("resolves on exit with the decoded result", async () => {
    const { events, controller } = collect();
    let sessionId: string | null = null;
    const result = await runOneshotStreamJsonTurn(
      {
        bin: process.execPath,
        args: [happyPath],
        cwd: dir,
        label: "fixture",
        onSessionId: (id) => {
          sessionId = id;
        },
      },
      controller,
    );
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(sessionId).toBe("s-1");
    expect(events).toContainEqual({ type: "text-delta", delta: "ok" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  }, 15_000);
});
