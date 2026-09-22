import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readTextUntilAborted, stopWithGrace, waitForExitAndDrain } from "./manager";

describe("readTextUntilAborted", () => {
  it("returns promptly on abort even while a read is pending", async () => {
    // A stream that never produces data: the old pump stayed parked in read().
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const controller = new AbortController();
    const onText = vi.fn();
    const done = readTextUntilAborted(stream, controller, onText);

    controller.abort();
    await expect(
      Promise.race([done.then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), 200))]),
    ).resolves.toBe("done");
    expect(onText).not.toHaveBeenCalled();
  });

  it("delivers decoded text until the stream ends", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hi "));
        c.enqueue(new TextEncoder().encode("there"));
        c.close();
      },
    });
    const chunks: string[] = [];
    await readTextUntilAborted(stream, new AbortController(), (t) => chunks.push(t));
    expect(chunks.join("")).toBe("hi there");
  });
});

describe("waitForExitAndDrain", () => {
  it("waits for stdout to drain after exit so the bridge's exit event is parsed first", async () => {
    const order: string[] = [];
    let drain!: () => void;
    const drained = new Promise<void>((r) => {
      drain = () => {
        order.push("drained");
        r();
      };
    });
    const settled = waitForExitAndDrain(Promise.resolve(0), drained, 1_000).then((code) => {
      order.push(`settled:${code}`);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    drain();
    await settled;
    expect(order).toEqual(["drained", "settled:0"]);
  });

  it("does not wait forever for a stdout that never closes", async () => {
    await expect(waitForExitAndDrain(Promise.resolve(3), new Promise(() => {}), 10)).resolves.toBe(3);
  });
});

describe("stopWithGrace", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks politely first and only escalates if the process is still alive", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let alive = true;
    stopWithGrace({
      requestStop: () => calls.push("stop"),
      kill: (signal) => calls.push(signal),
      isAlive: () => alive,
      graceMs: 100,
    });
    expect(calls).toEqual(["stop"]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual(["stop", "SIGTERM"]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual(["stop", "SIGTERM", "SIGKILL"]);

    calls.length = 0;
    alive = true;
    stopWithGrace({
      requestStop: () => calls.push("stop"),
      kill: (signal) => calls.push(signal),
      isAlive: () => alive,
      graceMs: 100,
    });
    alive = false; // exited after the polite request
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(["stop"]);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("pty_bridge.py", () => {
  it("exits promptly (no busy loop) when its stdin reaches EOF", async () => {
    const bridge = fileURLToPath(new URL("./pty_bridge.py", import.meta.url));
    const config = Buffer.from(
      JSON.stringify({ command: "sleep 30", cwd: process.cwd(), shell: "/bin/sh", cols: 80, rows: 24, env: {} }),
    ).toString("base64");
    const child = spawn("python3", [bridge, config], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    await new Promise((r) => setTimeout(r, 300));
    child.stdin.end();

    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once("exit", () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    if (!exited) child.kill("SIGKILL");
    expect(exited).toBe(true);
    expect(stdout).toContain('"type": "exit"');
  });
});
