import { type ChildProcess, execFile, spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { VerifyRecipe } from "../types/index";
import type { SandboxSettings } from "../utils/settings";
import type { VerifyProjectProfile } from "./recipes";

const DEFAULT_VERIFY_GUEST_WORKDIR = "/grok/verify/worktree";

/** Upper bound for `shuru checkpoint create` (runtime bootstrap + dependency install inside the VM). */
export const DEFAULT_VERIFY_CHECKPOINT_CREATE_TIMEOUT_MS = 30 * 60_000;
/** Upper bound for the short bookkeeping commands (`checkpoint list` / `checkpoint delete`). */
const VERIFY_CHECKPOINT_COMMAND_TIMEOUT_MS = 60_000;
/** Grace period between SIGTERM and SIGKILL when the create process (or a descendant) ignores termination. */
const VERIFY_CHECKPOINT_KILL_ESCALATION_MS = 2_000;
/** Bytes retained per stream from the create process. Earlier output is dropped; progress lines still stream. */
export const VERIFY_CHECKPOINT_LOG_TAIL_BYTES = 64 * 1024;

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("Verify checkpoint preparation was aborted");
  error.name = "AbortError";
  return error;
}

/** Throw the signal's reason (an AbortError by default) when the signal has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

function execFileAsync(
  command: string,
  args: string[],
  cwd: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error) {
          if (options.signal?.aborted) {
            reject(createAbortError(options.signal.reason));
            return;
          }
          reject(new Error((stderr || stdout || error.message).trim() || error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function appendTail(current: string, text: string, limit: number): string {
  const combined = current + text;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

function emitLines(text: string, onLine?: (line: string) => void): void {
  if (!onLine) return;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // `child.killed` only records that a signal was SENT; callers track actual exit instead.
  if (!child.pid) {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
    return;
  }

  if (process.platform !== "win32") {
    try {
      // The child is spawned detached, so it leads its own process group: signal the whole group so
      // descendants (installer sub-shells, package managers) go with it.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          /* already exited */
        }
      }
      return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

interface SpawnWithProgressOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  onLine?: (line: string) => void;
}

function spawnWithProgress(
  command: string,
  args: string[],
  cwd: string,
  options: SpawnWithProgressOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs, onLine } = options;
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    let terminationReason: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      finish();
    };

    // Ask the process tree to stop and escalate to SIGKILL if it is still alive after the grace period.
    // Idempotent: the first reason (abort or timeout) wins and arms a single escalation.
    const requestTermination = (reason: Error) => {
      if (exited || terminationReason) return;
      terminationReason = reason;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (!exited) terminateProcessTree(child, "SIGKILL");
      }, VERIFY_CHECKPOINT_KILL_ESCALATION_MS);
    };
    const onAbort = () => requestTermination(createAbortError(signal?.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined;
      requestTermination(
        new Error(`${command} ${args.slice(0, 2).join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendTail(stdout, text, VERIFY_CHECKPOINT_LOG_TAIL_BYTES);
      emitLines(text, onLine);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendTail(stderr, text, VERIFY_CHECKPOINT_LOG_TAIL_BYTES);
      emitLines(text, onLine);
    });
    child.on("error", (err) => settle(() => reject(terminationReason ?? err)));
    child.on("exit", () => {
      exited = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      // When we terminated the process, do not wait for `close`: an escaped descendant holding the
      // stdio pipes must not keep the caller blocked.
      if (terminationReason) settle(() => reject(terminationReason));
    });
    child.on("close", (code) => {
      exited = true;
      if (terminationReason) {
        settle(() => reject(terminationReason));
        return;
      }
      if (code !== 0) {
        settle(() => reject(new Error((stderr || stdout || `Process exited with code ${code}`).trim())));
      } else {
        settle(() => resolve({ stdout, stderr }));
      }
    });
  });
}

function stableRecipePayload(recipe: VerifyRecipe): string {
  return JSON.stringify({
    ecosystem: recipe.ecosystem,
    appKind: recipe.appKind,
    shellInitCommands: recipe.shellInitCommands,
    bootstrapCommands: recipe.bootstrapCommands,
    installCommands: recipe.installCommands,
    buildCommands: recipe.buildCommands,
    testCommands: recipe.testCommands,
    startCommand: recipe.startCommand,
    startPort: recipe.startPort,
    smokeKind: recipe.smokeKind,
  });
}

/**
 * Settings that change what ends up inside the checkpoint: the base image it is built from, the
 * shell init that replaces the recipe's (see buildShellInitScript), and the network/secret inputs
 * the installer sees. Resource limits (cpus/memory/disk) and forwarded ports are deliberately
 * excluded: they do not affect installed dependencies.
 */
function stableEnvironmentPayload(settings: SandboxSettings): string {
  return JSON.stringify({
    baseFrom: settings.verifyBaseFrom || settings.from || null,
    shellInit: settings.shellInit ?? null,
    allowedHosts: settings.allowedHosts ?? null,
    secrets: (settings.secrets ?? []).map((secret) => ({
      name: secret.name,
      fromEnv: secret.fromEnv,
      hosts: secret.hosts,
    })),
  });
}

function readExistingFiles(cwd: string, files: string[]): Array<[string, string]> {
  return files
    .filter((file) => fs.existsSync(path.join(cwd, file)))
    .map((file) => [file, fs.readFileSync(path.join(cwd, file), "utf8")] as [string, string]);
}

function getRecipeFingerprint(cwd: string, recipe: VerifyRecipe, settings: SandboxSettings): string {
  const manifestFiles = readExistingFiles(cwd, [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Makefile",
  ]);

  return createHash("sha1")
    .update(stableRecipePayload(recipe))
    .update(stableEnvironmentPayload(settings))
    .update(JSON.stringify(manifestFiles))
    .digest("hex")
    .slice(0, 12);
}

export function buildVerifyCheckpointName(recipe: VerifyRecipe, fingerprint: string): string {
  const prefix = recipe.appKind.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "app";
  return `verify-${prefix}-${fingerprint}`;
}

export function getVerifyCheckpointName(cwd: string, recipe: VerifyRecipe, settings: SandboxSettings = {}): string {
  return buildVerifyCheckpointName(recipe, getRecipeFingerprint(cwd, recipe, settings));
}

async function listCheckpoints(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync("shuru", ["checkpoint", "list"], cwd, {
    signal,
    timeoutMs: VERIFY_CHECKPOINT_COMMAND_TIMEOUT_MS,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
}

async function deleteCheckpoint(cwd: string, checkpointName: string): Promise<void> {
  // Cleanup is a compensating action: bounded, but never tied to the (possibly already aborted) caller signal.
  await execFileAsync("shuru", ["checkpoint", "delete", checkpointName], cwd, {
    timeoutMs: VERIFY_CHECKPOINT_COMMAND_TIMEOUT_MS,
  });
}

function buildSyncScript(guestWorkdir: string): string {
  const exclusions = [
    ".git",
    "node_modules",
    ".venv",
    ".next",
    "dist",
    "build",
    "target",
    ".pytest_cache",
    ".mypy_cache",
  ];
  const preserveArgs = exclusions.map((entry) => `! -name '${entry}'`).join(" ");
  const tarExcludes = exclusions.map((entry) => `--exclude='${entry}'`).join(" ");
  return [
    `mkdir -p '${guestWorkdir}'`,
    `find '${guestWorkdir}' -mindepth 1 -maxdepth 1 ${preserveArgs} -exec rm -rf {} + 2>/dev/null || true`,
    `tar -C /workspace ${tarExcludes} -cf - . | tar -C '${guestWorkdir}' -xf -`,
  ].join(" && ");
}

function buildShellInitScript(settings: SandboxSettings, recipe: VerifyRecipe): string {
  const commands = settings.shellInit ?? recipe.shellInitCommands ?? [];
  return commands.filter(Boolean).join(" && ");
}

function buildCheckpointCreateArgs(
  cwd: string,
  checkpointName: string,
  guestWorkdir: string,
  recipe: VerifyRecipe,
  settings: SandboxSettings,
): string[] {
  const args = ["checkpoint", "create", checkpointName];
  const baseFrom = settings.verifyBaseFrom || settings.from;
  if (baseFrom) args.push("--from", baseFrom);
  if (settings.cpus) args.push("--cpus", String(settings.cpus));
  if (settings.memory) args.push("--memory", String(settings.memory));
  if (settings.diskSize) args.push("--disk-size", String(settings.diskSize));
  if (settings.allowNet || recipe.installCommands.length > 0) args.push("--allow-net");
  if (settings.allowedHosts) {
    for (const host of settings.allowedHosts) args.push("--allow-host", host);
  }
  if (settings.secrets) {
    for (const secret of settings.secrets) {
      args.push("--secret", `${secret.name}=${secret.fromEnv}@${secret.hosts.join(",")}`);
    }
  }
  args.push("--mount", `${cwd}:/workspace`);

  const shellInitScript = buildShellInitScript(settings, recipe);
  const bootstrapScript = recipe.bootstrapCommands.join(" && ") || "true";
  const installScript = recipe.installCommands.join(" && ") || "true";
  const script = [
    buildSyncScript(guestWorkdir),
    shellInitScript,
    bootstrapScript,
    `cd '${guestWorkdir}'`,
    installScript,
  ]
    .filter(Boolean)
    .join(" && ");
  args.push("--", "sh", "-lc", script);
  return args;
}

export interface PreparedVerifyCheckpoint {
  checkpointName?: string;
  guestWorkdir?: string;
  created: boolean;
}

export interface EnsureVerifyCheckpointOptions {
  /** Cancels preparation: the list/create subprocesses are killed and the promise rejects with the abort reason. */
  signal?: AbortSignal;
  /** Upper bound for `shuru checkpoint create`; defaults to DEFAULT_VERIFY_CHECKPOINT_CREATE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * In-flight creations by checkpoint name. Concurrent callers in this process join the attempt that
 * launched `checkpoint create` instead of racing it, and only that attempt owns (and may delete) the
 * name while it is in flight. Creators in other processes are not coordinated here.
 */
const inflightCreates = new Map<string, Promise<PreparedVerifyCheckpoint>>();

function waitForPending<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function createCheckpoint(
  cwd: string,
  checkpointName: string,
  recipe: VerifyRecipe,
  settings: SandboxSettings,
  onProgress: ((detail: string) => void) | undefined,
  options: EnsureVerifyCheckpointOptions,
): Promise<PreparedVerifyCheckpoint> {
  const args = buildCheckpointCreateArgs(cwd, checkpointName, DEFAULT_VERIFY_GUEST_WORKDIR, recipe, settings);
  onProgress?.(`Creating checkpoint: ${checkpointName}`);
  try {
    await spawnWithProgress("shuru", args, cwd, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_VERIFY_CHECKPOINT_CREATE_TIMEOUT_MS,
      onLine: onProgress,
    });
  } catch (error) {
    // This attempt launched the create for a name that was absent beforehand, so any partial
    // checkpoint under it belongs to this attempt and is safe to remove.
    await deleteCheckpoint(cwd, checkpointName).catch(() => {});
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Verify checkpoint bootstrap failed for "${checkpointName}": ${message}`);
  }
  return { checkpointName, guestWorkdir: DEFAULT_VERIFY_GUEST_WORKDIR, created: true };
}

export async function ensureVerifyCheckpoint(
  cwd: string,
  profile: VerifyProjectProfile,
  settings: SandboxSettings,
  onProgress?: (detail: string) => void,
  options: EnsureVerifyCheckpointOptions = {},
): Promise<PreparedVerifyCheckpoint> {
  const { signal } = options;
  throwIfAborted(signal);
  if (profile.recipe.installCommands.length === 0) {
    return { created: false };
  }

  const checkpointName = getVerifyCheckpointName(cwd, profile.recipe, settings);
  const checkpoints: string[] = await listCheckpoints(cwd, signal).catch((): string[] => []);
  throwIfAborted(signal);
  if (checkpoints.includes(checkpointName)) {
    onProgress?.(`Reusing checkpoint: ${checkpointName}`);
    return { checkpointName, guestWorkdir: DEFAULT_VERIFY_GUEST_WORKDIR, created: false };
  }

  const pending = inflightCreates.get(checkpointName);
  if (pending) {
    onProgress?.(`Waiting for in-progress checkpoint: ${checkpointName}`);
    const result = await waitForPending(pending, signal);
    return { ...result, created: false };
  }

  const attempt = createCheckpoint(cwd, checkpointName, profile.recipe, settings, onProgress, options);
  inflightCreates.set(checkpointName, attempt);
  try {
    return await attempt;
  } finally {
    if (inflightCreates.get(checkpointName) === attempt) inflightCreates.delete(checkpointName);
  }
}
