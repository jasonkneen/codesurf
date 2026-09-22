import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDesktopChildProcess,
  type AgentDesktopExecFile,
  type AgentDesktopRunner,
  buildAgentDesktopEnv,
  buildScreenshotPath,
  computerClick,
  computerLaunch,
  computerScreenshot,
  computerSnapshot,
  computerType,
  createAgentDesktopRunner,
} from "./computer";

class FakeChild extends EventEmitter implements AgentDesktopChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];

  constructor(private readonly onKill: (signal: NodeJS.Signals) => void) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.onKill(signal);
    return true;
  }

  exit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
}

describe("computer tools", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores screenshots under .grok/computer by default", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-computer-"));
    tempDirs.push(cwd);

    const outputPath = buildScreenshotPath(cwd);

    expect(outputPath).toContain(path.join(".grok", "computer"));
    expect(path.dirname(outputPath)).toBe(path.join(cwd, ".grok", "computer"));
  });

  it("refuses a screenshot output_path outside the workspace and temp dir", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-computer-"));
    tempDirs.push(cwd);
    const runner: AgentDesktopRunner = vi.fn(async () => ({ success: true, stdout: "", stderr: "" }));
    const outside = path.join(os.homedir(), `codesurf-screenshot-test-${Date.now()}`, "shot.png");

    const result = await computerScreenshot({ output_path: outside }, cwd, undefined, runner);

    expect(result.success).toBe(false);
    expect(result.output).toContain("must be inside the workspace");
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(outside))).toBe(false);
  });

  it("captures screenshots through agent-desktop", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-computer-"));
    tempDirs.push(cwd);
    const outputPath = path.join(cwd, "artifacts", "screen.png");
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "screenshot", data: { path: outputPath } }),
      stderr: "",
    }));

    const result = await computerScreenshot(
      { output_path: "artifacts/screen.png", app: "Google Chrome", window_id: "w-42" },
      cwd,
      undefined,
      runner,
    );

    expect(result.success).toBe(true);
    expect(result.media).toEqual([{ kind: "image", path: outputPath, mediaType: "image/png" }]);
    expect(result.computer).toEqual({
      action: "screenshot",
      path: outputPath,
      app: "Google Chrome",
      windowId: "w-42",
      hint: "Use computer_snapshot to inspect accessibility refs before clicking or typing.",
    });
    expect(runner).toHaveBeenCalledWith(
      ["screenshot", outputPath, "--app", "Google Chrome", "--window-id", "w-42"],
      cwd,
      undefined,
    );
  });

  it("formats snapshots with refs and raw JSON", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({
        ok: true,
        command: "snapshot",
        data: {
          refs: ["@e1", "@e2"],
        },
      }),
      stderr: "",
    }));

    const result = await computerSnapshot({ app: "Finder" }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Refs: @e1, @e2");
    expect(result.output).toContain('"command": "snapshot"');
    expect(result.computer).toEqual({
      action: "snapshot",
      app: "Finder",
      windowId: undefined,
    });
    expect(runner).toHaveBeenCalledWith(["snapshot", "--app", "Finder", "--interactive-only"], "/tmp", undefined);
  });

  it("clicks by accessibility ref", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "click", data: { action: "click" } }),
      stderr: "",
    }));

    const result = await computerClick({ ref: "@e7" }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(result.computer).toEqual({ action: "click", ref: "@e7" });
    expect(runner).toHaveBeenCalledWith(["click", "@e7"], "/tmp", undefined);
  });

  it("reports a specific error for non-left ref clicks", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: "",
      stderr: "",
    }));

    const result = await computerClick({ ref: "@e7", button: "right" }, "/tmp", undefined, runner);

    expect(result.success).toBe(false);
    expect(result.output).toContain("supports only the left button");
    expect(runner).not.toHaveBeenCalled();
  });

  it("types into an element ref", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "type", data: { action: "type" } }),
      stderr: "",
    }));

    const result = await computerType({ ref: "@e5", text: "hello from grok" }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Typed into @e5.");
    expect(runner).toHaveBeenCalledWith(["type", "@e5", "hello from grok"], "/tmp", undefined);
  });

  it("launches apps through agent-desktop", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "launch", data: { launched: true } }),
      stderr: "",
    }));

    const result = await computerLaunch({ app: "Google Chrome", timeout_ms: 15000 }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(["launch", "Google Chrome", "--timeout", "15000"], "/tmp", undefined);
  });

  it("adds a macOS accessibility hint on permission failures", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: false,
      stdout: JSON.stringify({
        ok: false,
        command: "snapshot",
        error: {
          code: "PERM_DENIED",
          message: "Accessibility permission not granted",
          suggestion: "Open System Settings > Privacy & Security > Accessibility and add your terminal application",
        },
      }),
      stderr: "",
    }));

    const result = await computerSnapshot({ app: "Finder" }, "/tmp", undefined, runner);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Accessibility permission");
  });

  it("neither spawns nor creates screenshot directories when the signal is already aborted", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-computer-"));
    tempDirs.push(cwd);
    const controller = new AbortController();
    controller.abort();
    const runner: AgentDesktopRunner = vi.fn(async () => ({ success: true, stdout: "", stderr: "" }));

    const results = await Promise.all([
      computerScreenshot({}, cwd, controller.signal, runner),
      computerScreenshot({ output_path: "artifacts/shot.png" }, cwd, controller.signal, runner),
      computerClick({ ref: "@e1" }, cwd, controller.signal, runner),
      computerType({ ref: "@e1", text: "hello" }, cwd, controller.signal, runner),
      computerLaunch({ app: "Finder" }, cwd, controller.signal, runner),
    ]);

    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.output).toContain("[Cancelled]");
    }
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, ".grok"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "artifacts"))).toBe(false);
  });

  it("only forwards an allowlisted environment to agent-desktop", () => {
    const env = buildAgentDesktopEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/tester",
      TERM: "xterm-256color",
      CODESURF_API_KEY: "secret",
      TELEGRAM_BOT_TOKEN: "also-secret",
      CUSTOM_SECRET: "nope",
    });

    expect(env).toEqual({
      FORCE_COLOR: "0",
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
    });
  });
});

describe("createAgentDesktopRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call execFile when the signal is already aborted", async () => {
    const execFile = vi.fn<AgentDesktopExecFile>(() => new FakeChild(() => {}));
    const runner = createAgentDesktopRunner({ execFile });
    const controller = new AbortController();
    controller.abort();

    const result = await runner(["click", "@e1"], "/tmp", controller.signal);

    expect(result).toEqual({ success: false, stdout: "", stderr: "", error: "[Cancelled]" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("resolves the child's output when it completes normally", async () => {
    const execFile = vi.fn<AgentDesktopExecFile>((_command, _args, _options, callback) => {
      const child = new FakeChild(() => {});
      setImmediate(() => callback(null, '{"ok":true}', ""));
      return child;
    });
    const runner = createAgentDesktopRunner({ execFile });

    const result = await runner(["snapshot"], "/tmp", new AbortController().signal);

    expect(result).toEqual({ success: true, stdout: '{"ok":true}', stderr: "" });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain("snapshot");
  });

  it("terminates a stubborn child with SIGKILL before reporting cancellation", async () => {
    vi.useFakeTimers();
    let settled = false;
    let settledAtKill: boolean | undefined;
    const child = new FakeChild((signal) => {
      // Ignores SIGTERM; only SIGKILL makes it exit.
      if (signal === "SIGKILL") {
        settledAtKill = settled;
        child.exit("SIGKILL");
      }
    });
    const execFile = vi.fn<AgentDesktopExecFile>(() => child);
    const runner = createAgentDesktopRunner({ execFile, terminateGraceMs: 50, killGraceMs: 50 });
    const controller = new AbortController();

    const pending = runner(["click", "@e1"], "/tmp", controller.signal);
    void pending.then(() => {
      settled = true;
    });

    controller.abort();
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(49);
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settledAtKill).toBe(false);

    const result = await pending;
    expect(result).toEqual({ success: false, stdout: "", stderr: "", error: "[Cancelled]" });
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("does not escalate to SIGKILL when the child exits on SIGTERM", async () => {
    vi.useFakeTimers();
    const child = new FakeChild((signal) => {
      if (signal === "SIGTERM") child.exit("SIGTERM");
    });
    const execFile = vi.fn<AgentDesktopExecFile>(() => child);
    const runner = createAgentDesktopRunner({ execFile, terminateGraceMs: 50, killGraceMs: 50 });
    const controller = new AbortController();

    const pending = runner(["type", "@e1", "hello"], "/tmp", controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const result = await pending;
    expect(result.error).toBe("[Cancelled]");
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a call that never completes and tears the child down", async () => {
    vi.useFakeTimers();
    const child = new FakeChild((signal) => {
      if (signal === "SIGTERM") child.exit("SIGTERM");
    });
    const execFile = vi.fn<AgentDesktopExecFile>(() => child);
    const runner = createAgentDesktopRunner({ execFile, terminateGraceMs: 50, killGraceMs: 50, timeoutMs: 1_000 });

    const pending = runner(["snapshot"], "/tmp");
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 1000ms");
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(execFile.mock.calls[0]?.[2]).toMatchObject({ detached: process.platform !== "win32" });
  });

  it("extends the timeout for calls that carry their own --timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(() => {});
    const execFile = vi.fn<AgentDesktopExecFile>((_c, _a, _o, callback) => {
      setTimeout(() => callback(null, "{}", ""), 5_000);
      return child;
    });
    const runner = createAgentDesktopRunner({ execFile, timeoutMs: 1_000 });

    const pending = runner(["wait", "--timeout", "4000"], "/tmp");
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await pending).success).toBe(true);
    expect(child.kills).toEqual([]);
  });

  it("reports cancellation after the kill grace even if the child never exits", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(() => {});
    const execFile = vi.fn<AgentDesktopExecFile>(() => child);
    const runner = createAgentDesktopRunner({ execFile, terminateGraceMs: 50, killGraceMs: 50 });
    const controller = new AbortController();
    let settled = false;

    const pending = runner(["press", "enter"], "/tmp", controller.signal);
    void pending.then(() => {
      settled = true;
    });
    controller.abort();

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(result.error).toBe("[Cancelled]");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
