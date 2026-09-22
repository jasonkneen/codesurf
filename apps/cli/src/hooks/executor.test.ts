import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.kill = vi.fn();
  return child;
}

describe("execCommandHook process cleanup", () => {
  it("spawns hooks in a process group on POSIX platforms", async () => {
    vi.resetModules();
    spawnMock.mockReset();
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const { execCommandHook } = await import("./executor");

    const promise = execCommandHook(
      { type: "command", command: "echo ok" },
      { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: {}, cwd: process.cwd() },
      process.cwd(),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ outcome: "success" });
    expect(spawnMock).toHaveBeenCalledWith(
      "sh",
      ["-c", "echo ok"],
      expect.objectContaining({
        detached: process.platform !== "win32",
      }),
    );
  });

  it("survives EPIPE on stdin when the hook exits without reading its input", async () => {
    vi.resetModules();
    spawnMock.mockReset();
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const { execCommandHook } = await import("./executor");

    const promise = execCommandHook(
      { type: "command", command: "exit 0" },
      { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: {}, cwd: process.cwd() },
      process.cwd(),
    );
    // Without a listener an emitted `error` throws (in production: an
    // uncaught exception that kills the CLI).
    expect(() => child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ outcome: "success" });
  });

  it("terminates the hook process group on abort on POSIX platforms", async () => {
    if (process.platform === "win32") return;
    vi.resetModules();
    spawnMock.mockReset();
    const child = makeChild(6789);
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { execCommandHook } = await import("./executor");
    const controller = new AbortController();

    const promise = execCommandHook(
      { type: "command", command: "sleep 60" },
      { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: {}, cwd: process.cwd() },
      process.cwd(),
      controller.signal,
    );
    controller.abort();

    await expect(promise).resolves.toMatchObject({ outcome: "cancelled" });
    expect(killSpy).toHaveBeenCalledWith(-6789, "SIGTERM");
    killSpy.mockRestore();
  });
});

describe("execCommandHook termination escalation", () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: {}, cwd: process.cwd() } as const;

  async function setup(pid: number) {
    vi.resetModules();
    spawnMock.mockReset();
    const child = makeChild(pid);
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { execCommandHook, HOOK_KILL_ESCALATION_MS } = await import("./executor");
    return { child, killSpy, execCommandHook, HOOK_KILL_ESCALATION_MS };
  }

  it("escalates to SIGKILL when a timed-out hook ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    try {
      const { child, killSpy, execCommandHook, HOOK_KILL_ESCALATION_MS } = await setup(1111);

      const promise = execCommandHook({ type: "command", command: "sleep 60", timeout: 1 }, input, process.cwd());
      await vi.advanceTimersByTimeAsync(1_000);

      // The caller is released on timeout…
      await expect(promise).resolves.toMatchObject({ outcome: "non_blocking_error" });
      expect(killSpy).toHaveBeenCalledWith(-1111, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-1111, "SIGKILL");

      // …but the escalation stays armed until the child actually exits.
      await vi.advanceTimersByTimeAsync(HOOK_KILL_ESCALATION_MS);
      expect(killSpy).toHaveBeenCalledWith(-1111, "SIGKILL");
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the escalation when the hook exits after SIGTERM", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    try {
      const { child, killSpy, execCommandHook, HOOK_KILL_ESCALATION_MS } = await setup(2222);

      const promise = execCommandHook({ type: "command", command: "sleep 60", timeout: 1 }, input, process.cwd());
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toMatchObject({ outcome: "non_blocking_error" });
      expect(killSpy).toHaveBeenCalledWith(-2222, "SIGTERM");

      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(HOOK_KILL_ESCALATION_MS);
      expect(killSpy).not.toHaveBeenCalledWith(-2222, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates an aborted hook that ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    try {
      const { killSpy, execCommandHook, HOOK_KILL_ESCALATION_MS } = await setup(3333);
      const controller = new AbortController();

      const promise = execCommandHook(
        { type: "command", command: "sleep 60" },
        input,
        process.cwd(),
        controller.signal,
      );
      controller.abort();
      await expect(promise).resolves.toMatchObject({ outcome: "cancelled" });
      expect(killSpy).toHaveBeenCalledWith(-3333, "SIGTERM");

      await vi.advanceTimersByTimeAsync(HOOK_KILL_ESCALATION_MS);
      expect(killSpy).toHaveBeenCalledWith(-3333, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
