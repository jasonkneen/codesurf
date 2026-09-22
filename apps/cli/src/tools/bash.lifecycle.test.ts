import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BashTool } from "./bash";

// Gates let a test hold `mkdtemp` / `stat` open at a precise point so the
// races under test (cleanup during directory creation, cancellation across
// the cd stat) are exercised deterministically rather than by timing.
const fsGate = vi.hoisted(() => ({
  mkdtemp: null as Promise<void> | null,
  stat: null as Promise<void> | null,
  createdDirs: [] as string[],
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      if (fsGate.mkdtemp) await fsGate.mkdtemp;
      const dir = await actual.mkdtemp(prefix);
      fsGate.createdDirs.push(dir);
      return dir;
    },
    stat: async (target: string) => {
      if (fsGate.stat) await fsGate.stat;
      return actual.stat(target);
    },
  };
});

const posixOnly = process.platform === "win32" ? describe.skip : describe;

const tools: BashTool[] = [];
const fixtureDirs: string[] = [];
const trackedPids: number[] = [];

function makeTool(cwd = makeFixtureDir()): BashTool {
  const tool = new BashTool(cwd);
  tools.push(tool);
  return tool;
}

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-bash-lifecycle-"));
  fixtureDirs.push(dir);
  return dir;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ps(args: string[]): string {
  try {
    return execFileSync("ps", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** True while the pid exists and is not a killed-but-unreaped zombie. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = ps(["-o", "stat=", "-p", String(pid)]);
  return state !== "" && !state.startsWith("Z");
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function trackPid(file: string): number {
  const pid = readPid(file);
  if (pid === null) throw new Error(`no pid recorded in ${file}`);
  trackedPids.push(pid);
  return pid;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Shell starts a grandchild that inherits its stdout/stderr pipes, records
 * the grandchild's and its own pid, then exits. The grandchild keeps the
 * pipes open, so "the shell exited" says nothing about the work stopping.
 */
function orphanCommand(pidFile: string, shellPidFile: string): string {
  return `sleep 30 & echo $! > "${pidFile}"; echo $$ > "${shellPidFile}"; exit 0`;
}

/** Shell and grandchild both ignore SIGTERM; only SIGKILL ends them. */
function stubbornCommand(pidFile: string): string {
  return `trap '' TERM; sleep 30 & echo $! > "${pidFile}"; wait`;
}

afterEach(async () => {
  fsGate.mkdtemp = null;
  fsGate.stat = null;
  for (const tool of tools.splice(0)) {
    await tool.cleanup();
  }
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of [...fixtureDirs.splice(0), ...fsGate.createdDirs.splice(0)]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixOnly("BashTool background process ownership (T5)", () => {
  it("cleanup terminates a grandchild that outlived its shell and resolves only once it is gone", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const shellPidFile = path.join(dir, "shell.pid");

    const started = await bash.startBackground(orphanCommand(pidFile, shellPidFile));
    expect(started.success).toBe(true);
    await waitFor(() => readPid(pidFile) !== null, "grandchild pid");
    const grandchild = trackPid(pidFile);
    await waitFor(() => bash.listProcesses().output?.includes("exited(0)") === true, "shell exit");
    expect(isRunning(grandchild)).toBe(true);

    await bash.cleanup();

    expect(isRunning(grandchild)).toBe(false);
    expect(bash.listProcesses().output).toBe("No background processes.");
  });

  it("stopProcess terminates the tree even though the shell already exited", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const shellPidFile = path.join(dir, "shell.pid");

    const started = await bash.startBackground(orphanCommand(pidFile, shellPidFile));
    const id = started.backgroundProcess?.id;
    expect(id).toBeDefined();
    await waitFor(() => readPid(pidFile) !== null, "grandchild pid");
    const grandchild = trackPid(pidFile);
    await waitFor(() => bash.listProcesses().output?.includes("exited(0)") === true, "shell exit");

    const stopped = await bash.stopProcess(id as number);
    expect(stopped.success).toBe(true);
    expect(stopped.output).toContain("stopped");
    expect(isRunning(grandchild)).toBe(false);

    const again = await bash.stopProcess(id as number);
    expect(again.output).toContain("already exited");
  });

  it("stopProcess does not claim success while an escaped descendant still holds the output", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "escaped.pid");
    // perl forks, the child leaves the process group with setsid and keeps the
    // inherited stdout open, so the group signal cannot reach it.
    const command = `perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); open(my $f, ">", "${pidFile}"); print $f $$; close $f; sleep 30'`;

    const started = await bash.startBackground(command);
    const id = started.backgroundProcess?.id as number;
    await waitFor(() => readPid(pidFile) !== null, "escaped pid");
    const escaped = trackPid(pidFile);

    const stopped = await bash.stopProcess(id);
    expect(stopped.success).toBe(false);
    expect(stopped.output).toContain("may still be running");
    process.kill(escaped, "SIGKILL");
  }, 15_000);

  it("cleanup escalates to SIGKILL for a tree that ignores SIGTERM", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");

    const started = await bash.startBackground(stubbornCommand(pidFile));
    expect(started.success).toBe(true);
    const shell = started.backgroundProcess?.pid as number;
    trackedPids.push(shell);
    await waitFor(() => readPid(pidFile) !== null, "grandchild pid");
    const grandchild = trackPid(pidFile);

    await bash.cleanup();

    expect(isRunning(shell)).toBe(false);
    expect(isRunning(grandchild)).toBe(false);
  }, 15_000);
});

posixOnly("BashTool foreground cancellation owns the process tree (T5)", () => {
  it("abort kills a grandchild holding the pipes after the shell exited and resolves [Cancelled]", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const shellPidFile = path.join(dir, "shell.pid");
    const controller = new AbortController();

    const pending = bash.execute(orphanCommand(pidFile, shellPidFile), 30_000, controller.signal);
    await waitFor(() => readPid(shellPidFile) !== null, "shell pid");
    const grandchild = trackPid(pidFile);
    const shell = readPid(shellPidFile) as number;
    await waitFor(() => !isRunning(shell), "shell exit");
    expect(isRunning(grandchild)).toBe(true);

    controller.abort();
    const result = await pending;

    expect(result).toEqual({ success: false, error: "[Cancelled]" });
    expect(isRunning(grandchild)).toBe(false);
  });

  it("timeout kills the tree instead of waiting on inherited pipes", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const shellPidFile = path.join(dir, "shell.pid");

    const startedAt = Date.now();
    const result = await bash.execute(orphanCommand(pidFile, shellPidFile), 1_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 1000ms");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const grandchild = trackPid(pidFile);
    expect(isRunning(grandchild)).toBe(false);
  });

  it("abort escalates to SIGKILL when the tree ignores SIGTERM", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const controller = new AbortController();

    const pending = bash.execute(stubbornCommand(pidFile), 30_000, controller.signal);
    await waitFor(() => readPid(pidFile) !== null, "grandchild pid");
    const grandchild = trackPid(pidFile);

    controller.abort();
    const result = await pending;

    expect(result).toEqual({ success: false, error: "[Cancelled]" });
    expect(isRunning(grandchild)).toBe(false);
  }, 15_000);

  it("cleanup terminates an in-flight foreground command", async () => {
    const dir = makeFixtureDir();
    const bash = makeTool(dir);
    const pidFile = path.join(dir, "grandchild.pid");

    const pending = bash.execute(`sleep 30 & echo $! > "${pidFile}"; wait`, 30_000);
    await waitFor(() => readPid(pidFile) !== null, "grandchild pid");
    const grandchild = trackPid(pidFile);

    await bash.cleanup();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(isRunning(grandchild)).toBe(false);
  });

  it("keeps ordinary output and failure reporting", async () => {
    const bash = makeTool();

    expect(await bash.execute("echo hi")).toEqual({ success: true, output: "hi" });
    expect(await bash.execute("printf ''")).toEqual({
      success: true,
      output: "Command executed successfully (no output)",
    });
    expect(await bash.execute("echo oops >&2; exit 2")).toEqual({ success: false, error: "STDERR: oops" });
    const silent = await bash.execute("exit 3");
    expect(silent.success).toBe(false);
    expect(silent.error).toContain("Command failed");
  });
});

posixOnly("BashTool background launch admission (T11)", () => {
  it("concurrent launches share one temp directory and never exceed the cap", async () => {
    const bash = makeTool();

    const results = await Promise.all(Array.from({ length: 10 }, () => bash.startBackground("sleep 30")));

    const admitted = results.filter((r) => r.success);
    const refused = results.filter((r) => !r.success);
    expect(admitted).toHaveLength(8);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.output).toMatch(/Too many background processes \(8\/8\)/);
    expect(fsGate.createdDirs).toHaveLength(1);
    const pids = admitted.map((r) => r.backgroundProcess?.pid as number);
    trackedPids.push(...pids);
    expect(pids.every((pid) => isRunning(pid))).toBe(true);

    await bash.cleanup();

    expect(pids.some((pid) => isRunning(pid))).toBe(false);
    expect(fs.existsSync(fsGate.createdDirs[0] as string)).toBe(false);
  });

  it("cleanup during delayed directory creation abandons the launch and removes the directory", async () => {
    const bash = makeTool();
    const gate = deferred();
    fsGate.mkdtemp = gate.promise;

    const launch = bash.startBackground("sleep 30");
    const cleanup = bash.cleanup();
    gate.resolve();

    const result = await launch;
    expect(result.success).toBe(false);
    expect(result.output).toContain("cleaned up");
    expect(result.backgroundProcess).toBeUndefined();

    await cleanup;
    expect(fsGate.createdDirs).toHaveLength(1);
    expect(fs.existsSync(fsGate.createdDirs[0] as string)).toBe(false);
    expect(bash.listProcesses().output).toBe("No background processes.");
  });

  it("refuses a launch attempted while cleanup runs", async () => {
    const bash = makeTool();
    const started = await bash.startBackground("sleep 30");
    trackedPids.push(started.backgroundProcess?.pid as number);

    const cleanup = bash.cleanup();
    const refused = await bash.startBackground("sleep 30");
    await cleanup;

    expect(refused.success).toBe(false);
    expect(refused.output).toContain("cleaned up");
    expect(bash.listProcesses().output).toBe("No background processes.");
  });

  it("repeated cleanup is idempotent and the tool is reusable afterwards", async () => {
    const bash = makeTool();
    const first = await bash.startBackground("sleep 30");
    trackedPids.push(first.backgroundProcess?.pid as number);

    const cleanupA = bash.cleanup();
    const cleanupB = bash.cleanup();
    expect(cleanupB).toBe(cleanupA);
    await cleanupA;
    await bash.cleanup();
    expect(fs.existsSync(fsGate.createdDirs[0] as string)).toBe(false);

    const second = await bash.startBackground("echo reborn");
    expect(second.success).toBe(true);
    expect(fsGate.createdDirs).toHaveLength(2);
    const id = second.backgroundProcess?.id as number;
    await waitFor(() => bash.listProcesses().output?.includes("exited(0)") === true, "second process exit");
    const logs = await bash.getProcessLogs(id);
    expect(logs.output).toContain("reborn");

    await bash.cleanup();
    expect(fs.existsSync(fsGate.createdDirs[1] as string)).toBe(false);
  });
});

posixOnly("BashTool cd handling", () => {
  it("runs `cd <dir> && cmd` in the shell without moving the tool cwd", async () => {
    const root = makeFixtureDir();
    fs.mkdirSync(path.join(root, "sub"));
    const bash = makeTool(root);

    const result = await bash.execute("cd sub && pwd");

    expect(result.success).toBe(true);
    expect(fs.realpathSync(result.output as string)).toBe(fs.realpathSync(path.join(root, "sub")));
    expect(bash.getCwd()).toBe(root);
  });

  it("moves the cwd for a standalone cd, quoted paths included", async () => {
    const root = makeFixtureDir();
    fs.mkdirSync(path.join(root, "my dir"));
    const bash = makeTool(root);

    expect((await bash.execute('cd "my dir"')).success).toBe(true);
    expect(bash.getCwd()).toBe(path.join(root, "my dir"));
    expect((await bash.execute("cd ..")).success).toBe(true);
    expect(bash.getCwd()).toBe(root);

    const missing = await bash.execute("cd nope");
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("Cannot change directory");
    expect(bash.getCwd()).toBe(root);
  });

  it("honours cancellation before and after the directory check", async () => {
    const root = makeFixtureDir();
    fs.mkdirSync(path.join(root, "sub"));
    const bash = makeTool(root);

    const early = new AbortController();
    early.abort();
    expect(await bash.execute("cd sub", 1_000, early.signal)).toEqual({ success: false, error: "[Cancelled]" });
    expect(bash.getCwd()).toBe(root);

    const late = new AbortController();
    const gate = deferred();
    fsGate.stat = gate.promise;
    const pending = bash.execute("cd sub", 1_000, late.signal);
    late.abort();
    gate.resolve();
    expect(await pending).toEqual({ success: false, error: "[Cancelled]" });
    expect(bash.getCwd()).toBe(root);
  });
});
