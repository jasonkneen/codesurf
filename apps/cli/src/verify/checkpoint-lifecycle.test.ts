import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

import { execFile, spawn } from "child_process";
import { ensureVerifyCheckpoint, getVerifyCheckpointName, VERIFY_CHECKPOINT_LOG_TAIL_BYTES } from "./checkpoint";
import { inferVerifyProjectProfile } from "./recipes";

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);
const tempDirs: string[] = [];

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  /** Never a real pid: terminateProcessTree must fall back to `kill()` instead of signalling a process group. */
  pid: undefined;
  kill: (signal: NodeJS.Signals) => boolean;
  killSignals: NodeJS.Signals[];
  finish: (code: number | null, signal?: NodeJS.Signals | null) => Promise<void>;
}

function createFakeChild(options: { ignoreSigterm?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = undefined;
  child.killSignals = [];
  child.finish = async (code, signal = null) => {
    child.stdout.push(null);
    child.stderr.push(null);
    // Let buffered chunks reach the data listeners before the process "exits", like a real child.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream.readableEnded) await once(stream, "end");
    }
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === "SIGTERM" && options.ignoreSigterm) return true;
    void child.finish(null, signal);
    return true;
  };
  return child;
}

function makeNextProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-verify-ckpt-lifecycle-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "package-lock.json"), "");
  return dir;
}

function execArgs(): string[][] {
  return execFileMock.mock.calls.map((call) => call[1] as string[]);
}

/** shuru list/delete succeed immediately; the list reports no checkpoints. */
function mockBookkeepingCommands(): void {
  execFileMock.mockImplementation((_command, _args, _options, callback) => {
    (callback as ExecCallback)(null, "", "");
    return {} as never;
  });
}

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
  execFileMock.mockReset();
  spawnMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify checkpoint cancellation and bounds (V1)", () => {
  it("rejects before touching shuru when the signal is already aborted", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    const controller = new AbortController();
    controller.abort();

    await expect(
      ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not start a create when the abort lands during checkpoint list", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    const controller = new AbortController();
    execFileMock.mockImplementation((_command, _args, options, callback) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      expect(signal).toBe(controller.signal);
      signal?.addEventListener("abort", () => (callback as ExecCallback)(new Error("aborted"), "", ""), {
        once: true,
      });
      return {} as never;
    });

    const pending = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, undefined, {
      signal: controller.signal,
    });
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    controller.abort();
    await outcome;
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills an in-flight create on abort, removes the partial checkpoint, and rejects with the abort reason", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    const checkpointName = getVerifyCheckpointName(dir, profile.recipe, profile.sandboxSettings);
    mockBookkeepingCommands();
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child as never);
    const controller = new AbortController();
    const progress: string[] = [];

    const pending = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, (detail) => progress.push(detail), {
      signal: controller.signal,
    });
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ detached: process.platform !== "win32" });

    controller.abort();
    await outcome;

    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(execArgs()).toEqual([
      ["checkpoint", "list"],
      ["checkpoint", "delete", checkpointName],
    ]);
    expect(progress).toContain(`Creating checkpoint: ${checkpointName}`);
  });

  it("escalates to SIGKILL when the create process ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    mockBookkeepingCommands();
    const child = createFakeChild({ ignoreSigterm: true });
    spawnMock.mockImplementation(() => child as never);
    const controller = new AbortController();

    const pending = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, undefined, {
      signal: controller.signal,
    });
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    controller.abort();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await outcome;
    expect(execArgs()[1]?.slice(0, 2)).toEqual(["checkpoint", "delete"]);
  });

  it("terminates a create that exceeds the timeout and reports the timeout", async () => {
    vi.useFakeTimers();
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    mockBookkeepingCommands();
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child as never);

    const pending = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, undefined, { timeoutMs: 5_000 });
    const outcome = expect(pending).rejects.toThrow(/Verify checkpoint bootstrap failed .* timed out after 5s/);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.killSignals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await outcome;
    expect(execArgs()[1]?.slice(0, 2)).toEqual(["checkpoint", "delete"]);
  });

  it("bounds the captured log tail while still streaming every progress line", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    mockBookkeepingCommands();
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child as never);
    const progress: string[] = [];
    const lineCount = 200;
    const padding = "x".repeat(1_000);

    const pending = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, (detail) => progress.push(detail));
    const outcome = expect(pending).rejects.toThrow("Verify checkpoint bootstrap failed");
    await flushMicrotasks();
    for (let i = 0; i < lineCount; i += 1) {
      child.stdout.push(`line-${i} ${padding}\n`);
    }
    expect(lineCount * padding.length).toBeGreaterThan(VERIFY_CHECKPOINT_LOG_TAIL_BYTES * 2);
    await child.finish(1);
    await outcome;

    const error = (await pending.catch((err: Error) => err)) as Error;
    expect(error.message.length).toBeLessThanOrEqual(VERIFY_CHECKPOINT_LOG_TAIL_BYTES + 200);
    expect(error.message).toContain(`line-${lineCount - 1} `);
    expect(error.message).not.toContain("line-0 ");
    expect(progress.filter((line) => line.startsWith("line-"))).toHaveLength(lineCount);
    expect(progress[0]).toMatch(/^Creating checkpoint: /);
  });
});

describe("verify checkpoint identity and coordination (V2)", () => {
  it("derives different checkpoint names for the same recipe on different base environments", () => {
    const dir = makeNextProject();
    const { recipe } = inferVerifyProjectProfile(dir);

    const debian = getVerifyCheckpointName(dir, recipe, { verifyBaseFrom: "debian-13" });
    const ubuntu = getVerifyCheckpointName(dir, recipe, { verifyBaseFrom: "ubuntu-24" });
    const debianViaFrom = getVerifyCheckpointName(dir, recipe, { from: "debian-13" });
    const debianAltInit = getVerifyCheckpointName(dir, recipe, { verifyBaseFrom: "debian-13", shellInit: ["true"] });
    const debianSecrets = getVerifyCheckpointName(dir, recipe, {
      verifyBaseFrom: "debian-13",
      secrets: [{ name: "NPM_TOKEN", fromEnv: "NPM_TOKEN", hosts: ["registry.npmjs.org"] }],
    });

    expect(debian).toMatch(/^verify-nextjs-[0-9a-f]{12}$/);
    expect(debian).not.toBe(ubuntu);
    expect(debian).toBe(debianViaFrom);
    expect(debian).not.toBe(debianAltInit);
    expect(debian).not.toBe(debianSecrets);
    expect(getVerifyCheckpointName(dir, recipe, { verifyBaseFrom: "debian-13", cpus: 8, memory: 4096 })).toBe(debian);
  });

  it("creates a separate checkpoint when the base image changes instead of reusing the old one", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    const oldName = getVerifyCheckpointName(dir, profile.recipe, { verifyBaseFrom: "debian-13" });
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const stdout = (args as string[])[1] === "list" ? `${oldName}\n` : "";
      (callback as ExecCallback)(null, stdout, "");
      return {} as never;
    });
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child as never);

    const pending = ensureVerifyCheckpoint(dir, profile, { verifyBaseFrom: "ubuntu-24" });
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const createArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(createArgs[2]).not.toBe(oldName);
    expect(createArgs.slice(3, 5)).toEqual(["--from", "ubuntu-24"]);
    await child.finish(0);
    await expect(pending).resolves.toMatchObject({ created: true, checkpointName: createArgs[2] });
  });

  it("lets concurrent callers share one successful create instead of racing it", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    mockBookkeepingCommands();
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child as never);
    const progress: string[] = [];

    const first = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, (detail) => progress.push(detail));
    const second = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, (detail) => progress.push(detail));
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await child.finish(0);

    const [a, b] = await Promise.all([first, second]);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.checkpointName).toBe(a.checkpointName);
    expect(progress.some((line) => line.startsWith("Waiting for in-progress checkpoint:"))).toBe(true);
    expect(execArgs().filter((args) => args[1] === "delete")).toHaveLength(0);
  });

  it("cleans up a failed create exactly once, fails every joiner, and lets a later caller retry", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    const checkpointName = getVerifyCheckpointName(dir, profile.recipe, profile.sandboxSettings);
    mockBookkeepingCommands();
    const failing = createFakeChild();
    spawnMock.mockImplementation(() => failing as never);

    const first = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);
    const second = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);
    const outcomes = Promise.all([
      expect(first).rejects.toThrow(`Verify checkpoint bootstrap failed for "${checkpointName}"`),
      expect(second).rejects.toThrow(`Verify checkpoint bootstrap failed for "${checkpointName}"`),
    ]);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    failing.stderr.push("bun: not found\n");
    await failing.finish(1);
    await outcomes;
    expect(execArgs().filter((args) => args[1] === "delete")).toEqual([["checkpoint", "delete", checkpointName]]);

    const retryChild = createFakeChild();
    spawnMock.mockImplementation(() => retryChild as never);
    const retry = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await retryChild.finish(0);
    await expect(retry).resolves.toMatchObject({ created: true, checkpointName });
  });

  it("lets a joiner abort its own wait without killing the launcher's create", async () => {
    const dir = makeNextProject();
    const profile = inferVerifyProjectProfile(dir);
    mockBookkeepingCommands();
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child as never);
    const joinerController = new AbortController();

    const launcher = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);
    const joiner = ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings, undefined, {
      signal: joinerController.signal,
    });
    const joinerOutcome = expect(joiner).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    joinerController.abort();
    await joinerOutcome;
    expect(child.killSignals).toEqual([]);

    await child.finish(0);
    await expect(launcher).resolves.toMatchObject({ created: true });
  });
});
