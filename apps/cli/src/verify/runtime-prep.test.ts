import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./checkpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./checkpoint")>()),
  ensureVerifyCheckpoint: vi.fn(async () => ({
    created: true,
    checkpointName: "verify-nextjs-test",
    guestWorkdir: "/grok/verify/worktree",
  })),
}));

import { ensureVerifyCheckpoint } from "./checkpoint";
import { prepareVerifySandbox } from "./entrypoint";

const ensureVerifyCheckpointMock = vi.mocked(ensureVerifyCheckpoint);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  ensureVerifyCheckpointMock.mockClear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepareVerifySandbox", () => {
  it("adds checkpoint-backed sandbox settings for verify execution", async () => {
    const dir = makeTempDir("grok-verify-runtime-prep-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    const prepared = await prepareVerifySandbox(dir, { allowNet: false });
    expect(prepared.profile.appKind).toBe("nextjs");
    expect(prepared.sandboxSettings.allowNet).toBe(true);
    expect(prepared.sandboxSettings.from).toBe("verify-nextjs-test");
    expect(prepared.sandboxSettings.guestWorkdir).toBe("/grok/verify/worktree");
    expect(prepared.sandboxSettings.syncHostWorkspace).toBe(true);
    expect(prepared.checkpoint?.created).toBe(true);
  });

  it("forwards the abort signal and checkpoint timeout to checkpoint preparation", async () => {
    const dir = makeTempDir("grok-verify-runtime-prep-signal-");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2));
    const controller = new AbortController();
    const onProgress = vi.fn();

    await prepareVerifySandbox(dir, {}, undefined, onProgress, {
      signal: controller.signal,
      checkpointTimeoutMs: 1_234,
    });

    expect(ensureVerifyCheckpointMock).toHaveBeenCalledTimes(1);
    const call = ensureVerifyCheckpointMock.mock.calls[0];
    expect(call?.[3]).toBe(onProgress);
    expect(call?.[4]).toEqual({ signal: controller.signal, timeoutMs: 1_234 });
  });

  it("rejects without preparing a checkpoint when the signal is already aborted", async () => {
    const dir = makeTempDir("grok-verify-runtime-prep-aborted-");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2));
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareVerifySandbox(dir, {}, undefined, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(ensureVerifyCheckpointMock).not.toHaveBeenCalled();
  });

  it("does not hand back sandbox settings when the abort lands during checkpoint preparation", async () => {
    const dir = makeTempDir("grok-verify-runtime-prep-mid-abort-");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2));
    const controller = new AbortController();
    ensureVerifyCheckpointMock.mockImplementationOnce(async () => {
      controller.abort();
      return { created: true, checkpointName: "verify-nextjs-test", guestWorkdir: "/grok/verify/worktree" };
    });

    await expect(
      prepareVerifySandbox(dir, {}, undefined, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
