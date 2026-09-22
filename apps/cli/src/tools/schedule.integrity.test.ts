import { type ChildProcess, spawn as realSpawn } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the 2026-09-05 tools review findings T12 (detached
// spawn handshake), T13 (daemon identity), T14 (record write races) plus the
// bounded run-log tail and whole-token cron grammar observations.
//
// Real timers only: the cross-process record lock polls with setTimeout, so
// fake timers would deadlock it. Races are controlled with deferred promises.

const tempDirs: string[] = [];
const fixtures: ChildProcess[] = [];
let previousConfigDir: string | undefined;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function useConfigDir(): string {
  const home = makeTempDir("codesurf-schedule-integrity-");
  previousConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = home;
  return home;
}

type FakeChild = EventEmitter & { pid?: number; unref: () => void };

/** A ChildProcess stand-in that completes the spawn/error handshake on the next tick. */
function fakeChild(options: { pid?: number; fail?: Error }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = options.pid;
  child.unref = vi.fn();
  process.nextTick(() => {
    // An `error` emitted with no listener throws here, which vitest reports
    // as an unhandled error: that is the "no unhandled event" assertion.
    if (options.fail) child.emit("error", options.fail);
    else child.emit("spawn");
  });
  return child;
}

/** A real, long-lived process the test owns; killed in afterEach. */
async function spawnFixture(): Promise<ChildProcess & { pid: number }> {
  const child = realSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fixtures.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("fixture has no pid");
  return child as ChildProcess & { pid: number };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function importScheduleModule(options: { spawnMock?: ReturnType<typeof vi.fn> } = {}) {
  vi.resetModules();
  vi.doUnmock("child_process");
  if (options.spawnMock) {
    vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process");
      return { ...actual, spawn: options.spawnMock };
    });
  }
  return import("./schedule");
}

afterEach(async () => {
  for (const child of fixtures.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child);
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("child_process");
  if (previousConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = previousConfigDir;
  previousConfigDir = undefined;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("T12: detached spawn handshake", () => {
  it("rejects an injected spawn failure instead of leaking an unhandled error event", async () => {
    const home = useConfigDir();
    const spawnMock = vi.fn(() => fakeChild({ fail: new Error("spawn EACCES injected") }));
    const mod = await importScheduleModule({ spawnMock });

    await expect(
      mod.startDetachedHeadlessRun({
        instruction: "x",
        directory: home,
        model: "m",
        maxToolRounds: 1,
        logPath: path.join(home, "schedules", "one", "run.log"),
      }),
    ).rejects.toThrow("spawn EACCES injected");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("returns the pid only after the spawn event and detaches the child", async () => {
    const home = useConfigDir();
    let spawned = false;
    let child!: FakeChild;
    const spawnMock = vi.fn(() => {
      child = fakeChild({ pid: 4242 });
      child.once("spawn", () => {
        spawned = true;
      });
      return child;
    });
    const mod = await importScheduleModule({ spawnMock });

    const pid = await mod.startDetachedHeadlessRun({
      instruction: "x",
      directory: home,
      model: "m",
      maxToolRounds: 1,
      logPath: path.join(home, "schedules", "one", "run.log"),
    });

    expect(pid).toBe(4242);
    expect(spawned).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
    const stdio = (spawnMock.mock.calls[0] as unknown[])[2] as { stdio: unknown[]; detached: boolean };
    expect(stdio.detached).toBe(true);
    expect(typeof stdio.stdio[1]).toBe("number");
  });

  it("create: a directory that vanishes after validation fails the launch and records no run timestamp", async () => {
    const home = useConfigDir();
    const cwd = makeTempDir("codesurf-schedule-cwd-");
    const target = path.join(cwd, "workdir");
    fs.mkdirSync(target);
    // Real spawn with the CLI argv replaced: the missing cwd yields a genuine
    // asynchronous ENOENT error event from the runtime.
    const spawnMock = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      fs.rmSync(opts.cwd as string, { recursive: true, force: true });
      return realSpawn(process.execPath, ["-e", ""], opts as Parameters<typeof realSpawn>[2]);
    });
    const mod = await importScheduleModule({ spawnMock });
    const manager = new mod.ScheduleManager(
      () => cwd,
      () => "test-model",
    );

    await expect(manager.create({ name: "Vanishing dir", instruction: "run once", directory: target })).rejects.toThrow(
      /ENOENT/,
    );

    const id = mod.toScheduleId("Vanishing dir");
    const record = await manager.get(id);
    expect(record?.lastRunAt).toBeUndefined();
    expect(fs.existsSync(path.join(home, "schedules", `${id}.json`))).toBe(false);
  });

  it("startScheduleDaemon: an injected spawn failure rejects and leaves no pid record", async () => {
    const home = useConfigDir();
    const spawnMock = vi.fn(() => fakeChild({ fail: new Error("spawn ENOMEM injected") }));
    const mod = await importScheduleModule({ spawnMock });

    await expect(mod.startScheduleDaemon(home)).rejects.toThrow("spawn ENOMEM injected");
    expect(fs.existsSync(mod.getScheduleDaemonPidPath())).toBe(false);
  });

  it("startScheduleDaemon: launches the schedule-daemon subcommand and reports the claimed pid", async () => {
    const home = useConfigDir();
    let mod!: Awaited<ReturnType<typeof importScheduleModule>>;
    const spawnMock = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      const child = realSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        ...(opts as Parameters<typeof realSpawn>[2]),
        stdio: "ignore",
      });
      fixtures.push(child);
      // Stand in for the daemon child claiming its own identity record.
      child.once("spawn", () => {
        void mod.writeScheduleDaemonPid(child.pid as number, Date.now());
      });
      return child;
    });
    mod = await importScheduleModule({ spawnMock });

    const result = await mod.startScheduleDaemon(home);
    const args = (spawnMock.mock.calls[0] as unknown[])[1] as string[];
    expect(args[args.length - 1]).toBe("schedule-daemon");
    expect(result.alreadyRunning).toBe(false);
    expect(result.status.running).toBe(true);
    expect(result.pid).toBe(fixtures[0]?.pid);
  });
});

describe("T13: daemon identity", () => {
  it("refuses to classify or stop a live non-daemon process named by a stale pid record", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const fixture = await spawnFixture();
    const pidPath = mod.getScheduleDaemonPidPath();
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    // Start time from an hour ago: the pid has since been reused by the fixture.
    fs.writeFileSync(pidPath, JSON.stringify({ pid: fixture.pid, startedAt: Date.now() - 3_600_000 }));

    await expect(mod.getScheduleDaemonStatus()).resolves.toEqual({ running: false, pid: null });
    const stopped = await mod.stopScheduleDaemon();
    expect(stopped.wasRunning).toBe(false);
    expect(fixture.exitCode).toBeNull();
    expect(fixture.signalCode).toBeNull();
    expect(isAlive(fixture.pid)).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("treats a legacy numeric pid file as unverifiable and never signals it", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const fixture = await spawnFixture();
    const pidPath = mod.getScheduleDaemonPidPath();
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${fixture.pid}\n`);

    await expect(mod.getScheduleDaemonStatus()).resolves.toEqual({ running: false, pid: null });
    const stopped = await mod.stopScheduleDaemon();
    expect(stopped.wasRunning).toBe(false);
    expect(isAlive(fixture.pid)).toBe(true);
    expect(fixture.signalCode).toBeNull();
  });

  it("reports a verified record as running and stops only that process", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const fixture = await spawnFixture();
    await mod.writeScheduleDaemonPid(fixture.pid, Date.now());

    await expect(mod.getScheduleDaemonStatus()).resolves.toEqual({ running: true, pid: fixture.pid });

    const stopped = await mod.stopScheduleDaemon();
    expect(stopped).toMatchObject({ wasRunning: true, pid: fixture.pid });
    await waitForExit(fixture);
    expect(isAlive(fixture.pid)).toBe(false);
    expect(fs.existsSync(mod.getScheduleDaemonPidPath())).toBe(false);
  });

  it("simultaneous claims let exactly one daemon identity win", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const a = await spawnFixture();
    const b = await spawnFixture();
    const now = Date.now();

    const results = await Promise.allSettled([
      mod.writeScheduleDaemonPid(a.pid, now),
      mod.writeScheduleDaemonPid(b.pid, now),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toMatch(/already running/);

    const status = await mod.getScheduleDaemonStatus();
    expect(status.running).toBe(true);
    expect([a.pid, b.pid]).toContain(status.pid);
  });

  it("a claim replaces a dead record; removal only touches the caller's own record", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const dead = await spawnFixture();
    dead.kill("SIGKILL");
    await waitForExit(dead);
    const pidPath = mod.getScheduleDaemonPidPath();
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, JSON.stringify({ pid: dead.pid, startedAt: Date.now() }));

    await mod.writeScheduleDaemonPid(process.pid);
    await expect(mod.getScheduleDaemonStatus()).resolves.toEqual({ running: true, pid: process.pid });
    await mod.removeScheduleDaemonPid();
    expect(fs.existsSync(pidPath)).toBe(false);

    const other = await spawnFixture();
    await mod.writeScheduleDaemonPid(other.pid, Date.now());
    await mod.removeScheduleDaemonPid();
    expect(fs.existsSync(pidPath)).toBe(true);
    await expect(mod.stopScheduleDaemon()).resolves.toMatchObject({ wasRunning: true, pid: other.pid });
  });
});

describe("T14: record persistence", () => {
  it("a deferred lastRunAt update racing a disable keeps enabled:false", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const cwd = makeTempDir("codesurf-schedule-cwd-");
    const manager = new mod.ScheduleManager(
      () => cwd,
      () => "test-model",
    );
    const { schedule } = await manager.create({ name: "Race", instruction: "tick", cron: "* * * * *" });
    const recordPath = mod.getScheduleRecordPath(schedule.id);
    const snapshot = fs.readFileSync(recordPath, "utf8");

    const originalRead = fs.promises.readFile;
    const readRequested = deferred<void>();
    const release = deferred<string>();
    let intercepted = false;
    vi.spyOn(fs.promises, "readFile").mockImplementation(((...args: Parameters<typeof originalRead>) => {
      if (!intercepted && args[0] === recordPath) {
        intercepted = true;
        readRequested.resolve();
        return release.promise;
      }
      return originalRead.apply(fs.promises, args);
    }) as typeof originalRead);

    // The daemon tick reads its snapshot, then stalls before writing...
    const touch = manager.touchLastRunAt(schedule.id, new Date("2026-09-05T09:00:00Z"));
    await readRequested.promise;
    // ...while the user disables the schedule.
    const disable = manager.disable(schedule.id);
    await sleep(80);
    release.resolve(snapshot);
    await Promise.all([touch, disable]);

    const final = await manager.get(schedule.id);
    expect(final?.enabled).toBe(false);
    expect(final?.lastRunAt).toBe("2026-09-05T09:00:00.000Z");
  });

  it("concurrent same-name creation launches exactly once", async () => {
    useConfigDir();
    const spawnMock = vi.fn(() => fakeChild({ pid: 777 }));
    const mod = await importScheduleModule({ spawnMock });
    const cwd = makeTempDir("codesurf-schedule-cwd-");
    const manager = new mod.ScheduleManager(
      () => cwd,
      () => "test-model",
    );

    const results = await Promise.allSettled([
      manager.create({ name: "Once", instruction: "run" }),
      manager.create({ name: "Once", instruction: "run" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toMatch(/already exists/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((await manager.list()).filter((s) => s.id === "once")).toHaveLength(1);
  });

  it("an interrupted replace retains the previous valid record and leaves no temp files", async () => {
    const home = useConfigDir();
    const mod = await importScheduleModule();
    const cwd = makeTempDir("codesurf-schedule-cwd-");
    const manager = new mod.ScheduleManager(
      () => cwd,
      () => "test-model",
    );
    const { schedule } = await manager.create({ name: "Durable", instruction: "tick", cron: "0 9 * * *" });
    const recordPath = mod.getScheduleRecordPath(schedule.id);
    const writeSpy = vi.spyOn(fs.promises, "writeFile");
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("EIO: injected"));

    await expect(manager.disable(schedule.id)).rejects.toThrow("EIO: injected");

    // Replacement never targets the live record path directly.
    for (const call of writeSpy.mock.calls) {
      expect(call[0]).not.toBe(recordPath);
    }
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8"))).toMatchObject({ id: schedule.id, enabled: true });
    const leftovers = fs.readdirSync(path.join(home, "schedules")).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    const disabled = await manager.disable(schedule.id);
    expect(disabled.enabled).toBe(false);
    expect((await manager.get(schedule.id))?.enabled).toBe(false);
  });
});

describe("observations: bounded log tail and cron grammar", () => {
  it("readLog returns the last lines without reading the whole file", async () => {
    useConfigDir();
    const mod = await importScheduleModule();
    const cwd = makeTempDir("codesurf-schedule-cwd-");
    const manager = new mod.ScheduleManager(
      () => cwd,
      () => "test-model",
    );
    const { schedule } = await manager.create({ name: "Logs", instruction: "tick", cron: "0 9 * * *" });
    const logPath = mod.getScheduleRunLogPath(schedule.id);
    const padding = "x".repeat(90);
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(`line-${i} ${padding}`);
    fs.writeFileSync(logPath, `${lines.join("\n")}\n`);
    const readFileSpy = vi.spyOn(fs.promises, "readFile");

    const tail = await manager.readLog(schedule.id, 5);

    expect(tail.split("\n").map((l) => l.split(" ")[0])).toEqual([
      "line-19995",
      "line-19996",
      "line-19997",
      "line-19998",
      "line-19999",
    ]);
    expect(readFileSpy.mock.calls.some((call) => call[0] === logPath)).toBe(false);

    fs.writeFileSync(logPath, "");
    await expect(manager.readLog(schedule.id)).resolves.toBe(`No log output yet for "${schedule.name}".`);
  });

  it("cron grammar requires whole tokens and two-part ranges, without launching anything", async () => {
    const spawnMock = vi.fn();
    const mod = await importScheduleModule({ spawnMock });

    const invalid = [
      "1garbage * * * *",
      "1-2-3 * * * *",
      "*/5x * * * *",
      "1-x * * * *",
      "*/ * * * *",
      "0 9 * * 1-5-7",
      "0 0x9 * * *",
      "0 9 * * mon",
      "0 9 * * *-1",
    ];
    for (const expr of invalid) {
      expect(mod.isValidCron(expr), expr).toBe(false);
      expect(mod.cronMatchesDate(expr, new Date("2026-09-05T09:00:00")), expr).toBe(false);
    }
    for (const expr of ["1-5/2 * * * *", "0 9 * * 5-7", "*/15 9-17 * * 1-5", "0 0 1 1 0"]) {
      expect(mod.isValidCron(expr), expr).toBe(true);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
