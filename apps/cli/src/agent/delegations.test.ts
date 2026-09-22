import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function getDelegationProjectDir(home: string): string {
  const delegationsRoot = path.join(home, ".grok", "delegations");
  const projectDirs = fs.readdirSync(delegationsRoot);
  expect(projectDirs).toHaveLength(1);
  return path.join(delegationsRoot, projectDirs[0] as string);
}

function readStoredDelegationRecord(home: string): Record<string, unknown> {
  const projectDir = getDelegationProjectDir(home);
  const files = fs.readdirSync(projectDir).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(projectDir, files[0] as string), "utf8")) as Record<string, unknown>;
}

async function importDelegationsModule(options: { home?: string; spawnMock?: ReturnType<typeof vi.fn> } = {}) {
  if (options.home) {
    process.env.HOME = options.home;
  }

  if (options.spawnMock) {
    vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process");
      return {
        ...actual,
        spawn: options.spawnMock,
      };
    });
  }

  return import("./delegations");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.env.HOME = originalHome;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("child_process");
});

/** A ChildProcess stand-in: real event emission, no real process. */
function makeFakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

function jobPathFromSpawnArgs(args: string[]): string {
  return args[args.indexOf("--background-task-file") + 1] as string;
}

const START_REQUEST = {
  agent: "explore" as const,
  description: "Inspect the repo",
  prompt: "Find the execution path.",
};
const START_OPTIONS = { model: "test-model", sandboxMode: "off" as const, maxToolRounds: 5, maxTokens: 512 };

describe("DelegationManager sandbox propagation", () => {
  it("persists sandbox mode in background delegation records", async () => {
    const home = makeTempDir("grok-delegation-home-");
    const cwd = makeTempDir("grok-delegation-cwd-");
    const spawnMock = vi.fn(() => ({
      pid: 2468,
      unref: vi.fn(),
      // `start()` attaches an 'error' listener so a failed spawn fails the
      // record instead of crashing the host on an unhandled EventEmitter error.
      on: vi.fn(),
    }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(() => cwd);

    const result = await manager.start(
      {
        agent: "explore",
        description: "Inspect the repo",
        prompt: "Find the execution path.",
      },
      {
        model: "grok-test-model",
        sandboxMode: "shuru",
        maxToolRounds: 25,
        maxTokens: 2048,
      },
    );

    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--directory", cwd]),
      expect.objectContaining({ cwd }),
    );

    const record = readStoredDelegationRecord(home) as {
      id: string;
      sandboxMode: string;
      pid: number;
    };

    expect(record.sandboxMode).toBe("shuru");
    expect(record.pid).toBe(2468);
    expect(record.id).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{8}$/);
  });

  it("persists sandbox settings in background delegation records", async () => {
    const home = makeTempDir("grok-delegation-home-");
    const cwd = makeTempDir("grok-delegation-cwd-");
    const spawnMock = vi.fn(() => ({
      pid: 3579,
      unref: vi.fn(),
      on: vi.fn(),
    }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(() => cwd);

    const sandboxSettings = {
      allowNet: true,
      allowedHosts: ["api.openai.com"],
      cpus: 4,
      memory: 4096,
    };

    await manager.start(
      {
        agent: "explore",
        description: "Inspect",
        prompt: "Look around",
      },
      {
        model: "grok-test-model",
        sandboxMode: "shuru",
        sandboxSettings,
        maxToolRounds: 25,
        maxTokens: 2048,
      },
    );

    const record = readStoredDelegationRecord(home) as {
      sandboxMode: string;
      sandboxSettings?: {
        allowNet: boolean;
        allowedHosts: string[];
        cpus: number;
        memory: number;
      };
    };

    expect(record.sandboxMode).toBe("shuru");
    expect(record.sandboxSettings).toEqual(sandboxSettings);
  });

  it("rejects delegation_read IDs with path traversal characters", async () => {
    const home = makeTempDir("grok-delegation-home-");
    const cwd = makeTempDir("grok-delegation-cwd-");
    const mod = await importDelegationsModule({ home });
    const manager = new mod.DelegationManager(() => cwd);

    const output = await manager.read("../../outside");

    expect(output).toContain('Delegation "../../outside" not found');
  });

  it("does not read completed delegation output outside the delegation directory", async () => {
    const home = makeTempDir("grok-delegation-home-");
    const cwd = makeTempDir("grok-delegation-cwd-");
    const mod = await importDelegationsModule({ home });
    const manager = new mod.DelegationManager(() => cwd);
    await manager.read("brisk-amber-fox-deadbeef");
    const projectDir = getDelegationProjectDir(home);
    const id = "brisk-amber-fox-1234abcd";
    const secretPath = path.join(home, "secret.txt");

    fs.writeFileSync(secretPath, "secret", "utf8");
    fs.writeFileSync(
      path.join(projectDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          agent: "explore",
          description: "done",
          prompt: "done",
          cwd,
          model: "m",
          sandboxMode: "none",
          maxToolRounds: 1,
          maxTokens: 1,
          status: "complete",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          outputPath: secretPath,
        },
        null,
        2,
      ),
      "utf8",
    );

    const output = await manager.read(id);

    expect(output).not.toBe("secret");
    expect(output).toContain("completed, but its saved output could not be read");
  });
});

describe("delegation record hygiene", () => {
  const RECORD_ID = "calm-blue-fox-9a3f2b71";

  /** Create the project dir the same way production does, then return it. */
  async function seedProjectDir(
    home: string,
    DelegationManager: new (getCwd: () => string) => { list(): Promise<unknown[]> },
  ) {
    const manager = new DelegationManager(() => home);
    await manager.list();
    return getDelegationProjectDir(home);
  }

  function baseRecord(home: string, dir: string) {
    return {
      id: RECORD_ID,
      agent: "explore",
      description: "d",
      prompt: "p",
      cwd: home,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath: path.join(dir, `${RECORD_ID}.md`),
    };
  }

  it("rejects a tampered background task file instead of running it", async () => {
    const home = makeTempDir("codesurf-deleg-");
    process.env.HOME = home;
    const { loadDelegation, DelegationManager } = await importDelegationsModule({ home });
    const dir = await seedProjectDir(home, DelegationManager as never);
    const base = baseRecord(home, dir);

    const write = (name: string, record: Record<string, unknown>) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify(record));
      return p;
    };

    // The read-only guarantee must hold at EXECUTION, not only at write time:
    // start() rejects non-explore agents, but the job file is a separate input
    // reachable via --background-task-file.
    await expect(loadDelegation(write("a.json", { ...base, agent: "general" }))).rejects.toThrow(/read-only/i);
    await expect(loadDelegation(write("b.json", { ...base, id: "nope" }))).rejects.toThrow(/invalid id/i);
    await expect(loadDelegation(write("c.json", { ...base, prompt: undefined }))).rejects.toThrow(/missing required/i);
    await expect(loadDelegation(write("d.json", base))).resolves.toMatchObject({ id: RECORD_ID });
  });

  it("reports a delegation whose process is gone instead of waiting forever", async () => {
    const home = makeTempDir("codesurf-deleg-");
    process.env.HOME = home;
    const { DelegationManager } = await importDelegationsModule({ home });
    const dir = await seedProjectDir(home, DelegationManager as never);

    // A pid near the top of the pid space is almost certainly not live.
    fs.writeFileSync(path.join(dir, `${RECORD_ID}.json`), JSON.stringify({ ...baseRecord(home, dir), pid: 4_194_303 }));

    const manager = new DelegationManager(() => home);
    expect(await manager.read(RECORD_ID)).toMatch(/stopped without writing a result/i);
    expect(((await manager.list())[0] as { status: string }).status).toBe("error");
  });

  it("delivers a completion notice exactly once across concurrent pollers", async () => {
    const home = makeTempDir("codesurf-deleg-");
    process.env.HOME = home;
    const { DelegationManager } = await importDelegationsModule({ home });
    const dir = await seedProjectDir(home, DelegationManager as never);

    fs.writeFileSync(
      path.join(dir, `${RECORD_ID}.json`),
      JSON.stringify({ ...baseRecord(home, dir), status: "complete", summary: "done" }),
    );

    // The TUI poll timer and processMessage both drain notifications; two
    // interleaved read-modify-writes used to deliver the same notice twice.
    const manager = new DelegationManager(() => home);
    const [first, second] = await Promise.all([manager.consumeNotifications(), manager.consumeNotifications()]);
    expect(first.length + second.length).toBe(1);
  });
});

describe("delegation launch handshake (A12)", () => {
  /**
   * The parent used to write the running record, spawn, then write the SAME
   * in-memory record again with the pid. A child (or the async spawn 'error'
   * handler) that reached a terminal state between those writes was silently
   * reset to "running". Now the parent publishes the record exactly once,
   * after spawn, with the pid merged in; the child waits for that handshake.
   */
  async function startWithRacingChild(finish: (mod: typeof import("./delegations"), jobPath: string) => Promise<void>) {
    const home = makeTempDir("codesurf-deleg-home-");
    const cwd = makeTempDir("codesurf-deleg-cwd-");
    let onSpawn: (jobPath: string) => void = () => {};
    const spawnMock = vi.fn((_cmd: string, args: string[]) => {
      onSpawn(jobPathFromSpawnArgs(args));
      return makeFakeChild(2468);
    });
    const mod = await importDelegationsModule({ home, spawnMock });

    let contentAtSpawn: string | undefined;
    let childWrite: Promise<void> | undefined;
    onSpawn = (jobPath) => {
      contentAtSpawn = fs.readFileSync(jobPath, "utf8");
      // The child reaches its terminal state BEFORE the parent has written the pid.
      childWrite = finish(mod, jobPath);
    };

    const manager = new mod.DelegationManager(() => cwd);
    const result = await manager.start(START_REQUEST, START_OPTIONS);
    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Nothing but the empty reservation existed when the child was spawned:
    // there is no pre-spawn "running" write for a later write to resurrect.
    expect(contentAtSpawn).toBe("");
    await childWrite;

    const record = readStoredDelegationRecord(home) as {
      status: string;
      pid?: number;
      completedAt?: string;
      error?: string;
      outputPath: string;
    };
    return { manager, record };
  }

  it("keeps a completion that lands before the parent's pid write", async () => {
    const { manager, record } = await startWithRacingChild((mod, jobPath) =>
      mod.completeDelegation(jobPath, "Found it.\nThe path is src/index.ts."),
    );

    expect(record.status).toBe("complete");
    expect(record.completedAt).toBeTruthy();
    expect(record.pid).toBe(2468);
    expect(fs.readFileSync(record.outputPath, "utf8")).toContain("Found it.");
    expect(await manager.read(readStoredDelegationRecord(process.env.HOME as string).id as string)).toContain(
      "Found it.",
    );

    const first = await manager.consumeNotifications();
    const second = await manager.consumeNotifications();
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toMatch(/Background agent complete/);
    expect(second).toHaveLength(0);
  });

  it("keeps a failure that lands before the parent's pid write", async () => {
    const { manager, record } = await startWithRacingChild((mod, jobPath) => mod.failDelegation(jobPath, "boom"));

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.pid).toBe(2468);
    expect(fs.existsSync(record.outputPath)).toBe(true);

    const first = await manager.consumeNotifications();
    const second = await manager.consumeNotifications();
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toMatch(/Background agent failed/);
    expect(second).toHaveLength(0);
  });

  it("still records a synchronous spawn failure", async () => {
    const home = makeTempDir("codesurf-deleg-home-");
    const cwd = makeTempDir("codesurf-deleg-cwd-");
    const spawnMock = vi.fn(() => {
      throw new Error("EAGAIN");
    });
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(() => cwd);

    const result = await manager.start(START_REQUEST, START_OPTIONS);

    expect(result.success).toBe(false);
    const record = readStoredDelegationRecord(home) as { status: string; error?: string };
    expect(record.status).toBe("error");
    expect(record.error).toMatch(/EAGAIN/);
  });

  it("loadDelegation fails fast on a missing or corrupt job file", async () => {
    const home = makeTempDir("codesurf-deleg-home-");
    const mod = await importDelegationsModule({ home });
    const corrupt = path.join(home, "corrupt.json");
    fs.writeFileSync(corrupt, "{not json");

    await expect(mod.loadDelegation(path.join(home, "missing.json"))).rejects.toThrow(/not found/);
    await expect(mod.loadDelegation(corrupt)).rejects.toThrow(/not found/);
  });
});

describe("delegation ownership and termination (A13)", () => {
  // Far above any real pid on macOS (99998) and Linux (4194304 default max).
  // `process.kill` is also stubbed in every test here, so nothing is signalled.
  const PID_A = 4_190_001;
  const PID_B = 4_190_002;

  async function startChildren(...children: ReturnType<typeof makeFakeChild>[]) {
    const home = makeTempDir("codesurf-deleg-home-");
    const cwd = makeTempDir("codesurf-deleg-cwd-");
    const queue = [...children];
    const spawnMock = vi.fn(() => queue.shift() as ReturnType<typeof makeFakeChild>);
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(() => cwd);
    for (let i = 0; i < children.length; i++) {
      expect((await manager.start(START_REQUEST, START_OPTIONS)).success).toBe(true);
    }
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    return { manager, kill };
  }

  it("releases ownership of a child that exited and never signals its pid again", async () => {
    const child = makeFakeChild(PID_A);
    const { manager, kill } = await startChildren(child);

    child.emit("exit", 0, null);
    await manager.killStarted();

    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal a pid whose owned child already exited (pid reuse)", async () => {
    const exited = makeFakeChild(PID_A);
    const live = makeFakeChild(PID_B);
    const { manager, kill } = await startChildren(exited, live);

    // PID_A is now free for the OS to hand to an unrelated process.
    exited.emit("exit", 0, null);
    const done = manager.killStarted();
    live.emit("exit", null, "SIGTERM");
    await done;

    const signalled = kill.mock.calls.map(([pid]) => Math.abs(pid as number));
    expect(signalled).not.toContain(PID_A);
    expect(signalled).toContain(PID_B);
  });

  it("terminates the child's process group and resolves once it exits", async () => {
    const child = makeFakeChild(PID_A);
    const { manager, kill } = await startChildren(child);
    vi.useFakeTimers();

    const done = manager.killStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledWith(-PID_A, "SIGTERM");

    child.emit("exit", null, "SIGTERM");
    await done;

    expect(kill).toHaveBeenCalledTimes(1);
    // Ownership was released by the exit: a second cleanup has nothing to do.
    await manager.killStarted();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("escalates a stubborn child to SIGKILL and stays bounded if it never exits", async () => {
    const child = makeFakeChild(PID_A);
    const { manager, kill } = await startChildren(child);
    vi.useFakeTimers();

    let settled = false;
    const done = manager.killStarted().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledWith(-PID_A, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-PID_A, "SIGKILL");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(kill).toHaveBeenCalledWith(-PID_A, "SIGKILL");
    expect(settled).toBe(false);

    // Even a child that ignores SIGKILL (or whose exit is never observed)
    // cannot hang cleanup.
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(settled).toBe(true);
  });

  it("falls back to the pid when the process group cannot be signalled", async () => {
    const child = makeFakeChild(PID_A);
    const { manager, kill } = await startChildren(child);
    kill.mockImplementation((pid) => {
      if ((pid as number) < 0) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    });

    const done = manager.killStarted();
    child.emit("exit", null, "SIGTERM");
    await done;

    expect(kill).toHaveBeenCalledWith(-PID_A, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(PID_A, "SIGTERM");
  });

  it("joins concurrent cleanup callers instead of signalling twice", async () => {
    const child = makeFakeChild(PID_A);
    const { manager, kill } = await startChildren(child);
    vi.useFakeTimers();

    let firstSettled = false;
    let secondSettled = false;
    // `Promise.resolve` so a void-returning (fire-and-forget) killStarted fails
    // on the assertions below rather than on `.then` not being a function.
    const first = Promise.resolve(manager.killStarted()).then(() => {
      firstSettled = true;
    });
    const second = Promise.resolve(manager.killStarted()).then(() => {
      secondSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
    // The second caller JOINS the in-flight termination: neither caller may
    // return while the child is still alive. The pre-fix implementation
    // signalled once, cleared the set and returned immediately, so a second
    // caller was a no-op that resolved before the child had exited.
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(secondSettled).toBe(false);

    child.emit("exit", null, "SIGTERM");
    await Promise.all([first, second]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
