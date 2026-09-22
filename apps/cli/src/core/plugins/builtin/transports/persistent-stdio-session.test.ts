// Turn attribution and disposal for PersistentStdioSession, driven through a
// scripted child so the ordering the review cares about — "A is retired, B is
// submitted, THEN A's tail arrives" — is exact rather than a race against a
// real process. Real signal semantics are covered by the *.process.test.ts
// sibling.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../../api";
import { PersistentStdioSession, textContent } from "./persistent-stdio-session";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  kills: string[];
  /** Deliver stdout lines exactly as a real pipe would, one chunk. */
  say: (...lines: string[]) => void;
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new FakeStream();
  child.stderr = new FakeStream();
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.kills = [];
  // A child that ignores every signal: kill() records and does nothing else.
  child.kill = vi.fn((signal: string) => {
    child.kills.push(signal);
    return true;
  });
  child.say = (...lines) => child.stdout.emit("data", lines.map((l) => `${l}\n`).join(""));
  child.exit = (code, signal = null) => child.emit("exit", code, signal);
  return child;
}

function collect(): { events: ProviderStreamEvent[]; controller: { emit: (e: ProviderStreamEvent) => void } } {
  const events: ProviderStreamEvent[] = [];
  return { events, controller: { emit: (e) => events.push(e) } };
}

const text = (events: ProviderStreamEvent[]): string =>
  events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");

const hasDone = (events: ProviderStreamEvent[]): boolean => events.some((e) => e.type === "done");

function track<T>(p: Promise<T>): { settled: boolean } {
  const t = { settled: false };
  p.then(
    () => {
      t.settled = true;
    },
    () => {
      t.settled = true;
    },
  );
  return t;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const assistant = (body: string, stop = "end_turn") =>
  `{"type":"assistant","message":{"content":[{"type":"text","text":"${body}"}],"stop_reason":"${stop}"}}`;

describe("PersistentStdioSession — turn attribution across retirement", () => {
  const children: FakeChild[] = [];
  let session: PersistentStdioSession;

  beforeEach(() => {
    vi.useFakeTimers();
    children.length = 0;
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child as never;
    });
    session = new PersistentStdioSession({
      bin: "amp",
      args: ["-x"],
      cwd: "/",
      label: "amp",
      stallMs: 1_000,
      terminateGraceMs: 500,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves consecutive turns from one child (baseline)", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    children[0].say(assistant("alpha"));
    await expect(pA).resolves.toEqual({ usage: {} });
    expect(text(a.events)).toBe("alpha");

    const b = collect();
    const pB = session.sendTurn(textContent("B"), b.controller);
    children[0].say(assistant("beta"));
    await expect(pB).resolves.toEqual({ usage: {} });
    expect(text(b.events)).toBe("beta");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].kills).toEqual([]);
  });

  it("an EPIPE on stdin fails the turn and retires the child instead of crashing (H4)", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    const childA = children[0];
    // Emitting 'error' with no listener throws synchronously — the crash.
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => childA.stdin.emit("error", epipe)).not.toThrow();
    await expect(pA).rejects.toThrow(/EPIPE/);
    expect(a.events.at(-1)).toMatchObject({ type: "error" });
    expect(childA.kills).toContain("SIGTERM");

    const b = collect();
    const pB = session.sendTurn(textContent("B"), b.controller);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].say(assistant("beta"));
    await expect(pB).resolves.toEqual({ usage: {} });
  });

  it("stall timeout: A's late text and terminal stop never reach B; B runs on a fresh child", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    const childA = children[0];

    // Attach the expectation before the clock moves so the rejection is never
    // briefly unhandled.
    const aRejected = expect(pA).rejects.toThrow("amp produced no output for 1s.");
    await vi.advanceTimersByTimeAsync(1_000);
    await aRejected;
    expect(a.events).toContainEqual({ type: "error", message: "amp produced no output for 1s." });

    const b = collect();
    const pB = session.sendTurn(textContent("B"), b.controller);
    const bState = track(pB);
    // The stalled child cannot say where B starts, so B gets a new process and
    // the old one is retired: stdin EOF + SIGTERM.
    expect(spawn).toHaveBeenCalledTimes(2);
    const childB = children[1];
    expect(childA.stdin.end).toHaveBeenCalledTimes(1);
    expect(childA.kills).toEqual(["SIGTERM"]);
    expect(childB.stdin.write).toHaveBeenCalledTimes(1);
    expect(childB.stdin.write.mock.calls[0][0]).toContain('"text":"B"');

    // A wakes up and finishes its turn on the OLD child.
    childA.say(assistant("alpha"));
    await flush();
    expect(text(b.events)).toBe("");
    expect(hasDone(b.events)).toBe(false);
    expect(bState.settled).toBe(false);

    // The old child ignores SIGTERM → SIGKILL after the grace period.
    await vi.advanceTimersByTimeAsync(500);
    expect(childA.kills).toEqual(["SIGTERM", "SIGKILL"]);
    childA.exit(null, "SIGKILL");
    await flush();
    expect(bState.settled).toBe(false);

    childB.say(assistant("beta"));
    await expect(pB).resolves.toEqual({ usage: {} });
    expect(text(b.events)).toBe("beta");
    expect(text(a.events)).toBe("");
  });

  it("host abort on a child that ignores SIGINT: turn rejects now, B is untouched by A's tail", async () => {
    const a = collect();
    const ac = new AbortController();
    const pA = session.sendTurn(textContent("A"), a.controller, ac.signal);
    const childA = children[0];

    ac.abort();
    await expect(pA).rejects.toThrow("amp turn aborted.");
    expect(a.events).toContainEqual({ type: "error", message: "amp turn aborted." });
    expect(childA.kills).toEqual(["SIGINT"]);

    const b = collect();
    const pB = session.sendTurn(textContent("B"), b.controller);
    const bState = track(pB);
    expect(spawn).toHaveBeenCalledTimes(2);
    const childB = children[1];
    expect(childA.kills).toEqual(["SIGINT", "SIGTERM"]);

    childA.say(assistant("alpha"));
    await flush();
    expect(text(b.events)).toBe("");
    expect(hasDone(b.events)).toBe(false);
    expect(bState.settled).toBe(false);

    childB.say(assistant("beta"));
    await expect(pB).resolves.toEqual({ usage: {} });
    expect(text(b.events)).toBe("beta");
  });

  it("abortTurn() settles the turn itself instead of waiting on the child", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    session.abortTurn();
    await expect(pA).rejects.toThrow("amp turn aborted.");
    expect(children[0].kills).toEqual(["SIGINT"]);
    // Idempotent once nothing is in flight.
    session.abortTurn();
    expect(children[0].kills).toEqual(["SIGINT"]);
  });

  it("reuses the child once the interrupted turn reaches its terminal stop", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    const childA = children[0];
    session.abortTurn();
    await expect(pA).rejects.toThrow("amp turn aborted.");

    // The CLI honours SIGINT by ending the turn: that is the boundary.
    childA.say(assistant("alpha (interrupted)"));
    expect(text(a.events)).toBe("");

    const b = collect();
    const pB = session.sendTurn(textContent("B"), b.controller);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kills).toEqual(["SIGINT"]);
    expect(childA.stdin.write).toHaveBeenCalledTimes(2);
    childA.say(assistant("beta"));
    await expect(pB).resolves.toEqual({ usage: {} });
    expect(text(b.events)).toBe("beta");
  });

  it("a tool_use stop does not end draining — the agent is still going", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    const childA = children[0];
    session.abortTurn();
    await expect(pA).rejects.toThrow("amp turn aborted.");
    childA.say(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"read_file","input":{}}],"stop_reason":"tool_use"}}',
    );

    const b = collect();
    void session.sendTurn(textContent("B"), b.controller).catch(() => {});
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(childA.kills).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("a child that exits on SIGINT is simply replaced on the next turn", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    const childA = children[0];
    session.abortTurn();
    await expect(pA).rejects.toThrow("amp turn aborted.");
    childA.exit(130, null);

    const b = collect();
    const pB = session.sendTurn(textContent("B"), b.controller);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(childA.kills).toEqual(["SIGINT"]);
    children[1].say(assistant("beta"));
    await expect(pB).resolves.toEqual({ usage: {} });
    expect(text(b.events)).toBe("beta");
  });

  it("a pre-aborted signal neither writes to nor signals the child", async () => {
    session.warm();
    const ac = new AbortController();
    ac.abort();
    const a = collect();
    await expect(session.sendTurn(textContent("A"), a.controller, ac.signal)).rejects.toThrow("amp turn aborted.");
    expect(children[0].stdin.write).not.toHaveBeenCalled();
    expect(children[0].kills).toEqual([]);
    expect(a.events).toEqual([]);
  });
});

describe("PersistentStdioSession — disposal", () => {
  const children: FakeChild[] = [];
  let session: PersistentStdioSession;

  beforeEach(() => {
    vi.useFakeTimers();
    children.length = 0;
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child as never;
    });
    session = new PersistentStdioSession({
      bin: "amp",
      args: ["-x"],
      cwd: "/",
      label: "amp",
      stallMs: 0,
      terminateGraceMs: 500,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("awaits exit, escalating SIGTERM → SIGKILL on a child that ignores signals", async () => {
    const a = collect();
    const pA = session.sendTurn(textContent("A"), a.controller);
    const childA = children[0];

    const done = session.disconnect();
    const doneState = track(done);
    await expect(pA).rejects.toThrow("amp session closed.");
    expect(childA.stdin.end).toHaveBeenCalledTimes(1);
    expect(childA.kills).toEqual(["SIGTERM"]);
    await flush();
    expect(doneState.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(childA.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(doneState.settled).toBe(false);

    childA.exit(null, "SIGKILL");
    await flush();
    expect(doneState.settled).toBe(true);

    // Second call joins the first; nothing is signalled twice.
    expect(session.disconnect()).toBe(done);
    expect(childA.kills).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(session.sendTurn(textContent("B"), collect().controller)).rejects.toThrow(
      "amp session has been disconnected.",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("resolves without SIGKILL when the child honours SIGTERM", async () => {
    session.warm();
    const childA = children[0];
    const done = session.disconnect();
    childA.exit(0, null);
    await expect(done).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(childA.kills).toEqual(["SIGTERM"]);
  });

  it("gives up after the bounded post-SIGKILL wait rather than hanging", async () => {
    session.warm();
    const childA = children[0];
    const done = session.disconnect();
    const doneState = track(done);
    await vi.advanceTimersByTimeAsync(500);
    expect(childA.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(doneState.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(doneState.settled).toBe(true);
  });

  it("resolves immediately when nothing was ever spawned", async () => {
    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});
