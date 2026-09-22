import { type ChildProcess, spawn } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import { mkdtemp, rm, stat, unlink } from "fs/promises";
import os from "os";
import path from "path";
import { executeEventHooks } from "../hooks/index";
import type { CwdChangedHookInput } from "../hooks/types";
import type { ToolResult } from "../types/index";
import type { SandboxMode, SandboxSettings } from "../utils/settings";
import { executeGrep } from "./grep";

/** Grace period before escalating SIGTERM to SIGKILL during cleanup. */
const CLEANUP_SIGKILL_DELAY_MS = 2_000;
/** Grace period before escalating SIGTERM to SIGKILL for process_stop. */
const STOP_SIGKILL_DELAY_MS = 3_000;
/** Grace period before escalating SIGTERM to SIGKILL when a foreground command is cancelled or times out. */
const CANCEL_SIGKILL_DELAY_MS = 1_000;
/**
 * Upper bound on waiting for a SIGKILLed tree's stdio to close. A descendant
 * that escaped the process group (its own setsid) can keep the pipes open;
 * teardown must not wait on it forever.
 */
const POST_SIGKILL_WAIT_MS = 1_000;
const FOREGROUND_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_TAIL_BYTES = 8_192;
const MAX_BACKGROUND_PROCESSES = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** Bytes of command output returned to the model; the rest is elided with a marker. */
const MAX_RESULT_BYTES = 512 * 1024;

/** Clamp a model-supplied timeout: 0, negative or non-numeric means the default, never "no timeout". */
export function normalizeBashTimeout(timeout: unknown): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(timeout)));
}

/**
 * Bound command output returned to the model. Keeps the head and the tail
 * (errors and summaries usually land at the end) and names what was cut.
 */
export function capCommandOutput(text: string, maxBytes = MAX_RESULT_BYTES): string {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return text;
  const buf = Buffer.from(text, "utf-8");
  const half = Math.floor(maxBytes / 2);
  // Drop replacement chars left by cutting inside a multi-byte sequence.
  const head = buf
    .subarray(0, half)
    .toString("utf-8")
    .replace(/\uFFFD+$/, "");
  const tail = buf
    .subarray(bytes - half)
    .toString("utf-8")
    .replace(/^\uFFFD+/, "");
  const elided = bytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8");
  return `${head}\n\n[... truncated: ${bytes.toLocaleString("en-US")} bytes total, ${elided.toLocaleString("en-US")} elided from the middle. Redirect output to a file and read it in ranges, or filter it, to see the rest.]\n\n${tail}`;
}

export interface BackgroundProcess {
  id: number;
  command: string;
  pid: number;
  cwd: string;
  startedAt: Date;
  child: ChildProcess;
  logPath: string;
  /** The shell process itself is still running. */
  alive: boolean;
  /**
   * The shell or a descendant that inherited its stdio is still running. A
   * shell can exit while a child it launched keeps the pipes open; `alive`
   * alone does not mean the command's work has stopped.
   */
  treeAlive: boolean;
  /** Resolves on the child's `close` event: exited and every inherited pipe released. */
  closed: Promise<void>;
  exitCode: number | null;
}

interface BashToolOptions {
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
}

interface OwnedProcess {
  child: ChildProcess;
  closed: Promise<void>;
}

let nextBgId = 1;

export class BashTool {
  private cwd: string;
  private bgProcesses = new Map<number, BackgroundProcess>();
  /** Shared by concurrent first launches so only one directory is ever created and owned. */
  private tmpDirPromise: Promise<string> | null = null;
  /** Launches admitted against the cap whose child is not yet registered in `bgProcesses`. */
  private pendingLaunches = 0;
  private inFlightLaunches = new Set<Promise<ToolResult>>();
  private foregroundProcesses = new Set<OwnedProcess>();
  private cleanupInFlight: Promise<void> | null = null;
  /** Set while `cleanup()` runs: no launch is admitted and in-flight launches abandon before spawning. */
  private closing = false;
  private sandboxMode: SandboxMode;
  private sandboxSettings: SandboxSettings;

  constructor(initialCwd = process.cwd(), options: BashToolOptions = {}) {
    this.cwd = initialCwd;
    this.sandboxMode = options.sandboxMode ?? "off";
    this.sandboxSettings = options.sandboxSettings ?? {};
  }

  private ensureTmpDir(): Promise<string> {
    if (!this.tmpDirPromise) {
      const pending = mkdtemp(path.join(os.tmpdir(), "grok-bg-")).catch((err: unknown) => {
        // Let the next launch retry instead of failing forever on a stale rejection.
        if (this.tmpDirPromise === pending) this.tmpDirPromise = null;
        throw err;
      });
      this.tmpDirPromise = pending;
    }
    return this.tmpDirPromise;
  }

  async execute(command: string, requestedTimeout?: number, abortSignal?: AbortSignal): Promise<ToolResult> {
    const timeout = normalizeBashTimeout(requestedTimeout);
    try {
      const cdTarget = parseStandaloneCd(command);
      if (cdTarget !== null) {
        if (abortSignal?.aborted) {
          return { success: false, error: "[Cancelled]" };
        }
        try {
          const nextCwd = path.resolve(this.cwd, cdTarget);
          const info = await stat(nextCwd);
          if (abortSignal?.aborted) {
            return { success: false, error: "[Cancelled]" };
          }
          if (!info.isDirectory()) {
            return { success: false, error: `Cannot change directory: ${nextCwd} is not a directory` };
          }
          const oldCwd = this.cwd;
          this.cwd = nextCwd;

          const cwdInput: CwdChangedHookInput = {
            hook_event_name: "CwdChanged",
            old_cwd: oldCwd,
            new_cwd: nextCwd,
            cwd: nextCwd,
          };
          executeEventHooks(cwdInput, nextCwd).catch(() => {});

          return { success: true, output: `Changed directory to: ${this.cwd}` };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Cannot change directory: ${msg}` };
        }
      }

      if (abortSignal?.aborted) {
        return { success: false, error: "[Cancelled]" };
      }

      // Host-only fast path: never bypass Shuru guest isolation. Sandboxed
      // shells must run real `rg` (or fail) inside the guest.
      if (this.sandboxMode !== "shuru") {
        const rgFastPath = tryParseRipgrepCommand(command);
        if (rgFastPath) {
          return executeGrep(rgFastPath, this.cwd, abortSignal);
        }
      }

      const prepared = this.prepareCommand(command);
      if (!prepared.ok) {
        return { success: false, error: prepared.error };
      }

      return await new Promise<ToolResult>((resolve) => {
        let settled = false;
        let aborted = false;
        let failure: string | null = null;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        let bufferedLength = 0;

        // `exec` cannot spawn detached, so the shell shared our process group
        // and signalling it left descendants alive. A detached spawn on POSIX
        // makes the shell lead its own group; every process it starts inherits
        // that group, so cancellation, timeout and cleanup can reach the whole
        // tree with one signal and wait for its stdio to actually close.
        const child = spawn(prepared.command, {
          cwd: this.cwd,
          shell: true,
          detached: process.platform !== "win32",
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        const owned: OwnedProcess = { child, closed: closeEvent(child) };
        this.foregroundProcesses.add(owned);

        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          abortSignal?.removeEventListener("abort", onAbort);
          this.foregroundProcesses.delete(owned);
          resolve(result);
        };

        const outcome = (): ToolResult => {
          if (aborted || abortSignal?.aborted) {
            return { success: false, error: "[Cancelled]" };
          }
          const stderr = stderrChunks.join("");
          const output = stdoutChunks.join("") + (stderr ? `\nSTDERR: ${stderr}` : "");
          if (failure) {
            const sandboxError = this.formatSandboxRuntimeError(output, failure);
            if (sandboxError) {
              return { success: false, error: sandboxError };
            }
            if (output.trim()) {
              return { success: false, error: capCommandOutput(output.trim()) };
            }
            return { success: false, error: `Command failed: ${failure}` };
          }
          return {
            success: true,
            output: capCommandOutput(output.trim()) || "Command executed successfully (no output)",
          };
        };

        const terminate = (): Promise<boolean> => terminateProcessTree(child, owned.closed, CANCEL_SIGKILL_DELAY_MS);

        const collect = (chunks: string[], streamName: "stdout" | "stderr") => (chunk: string) => {
          if (failure) return;
          bufferedLength += chunk.length;
          if (bufferedLength > FOREGROUND_MAX_BUFFER) {
            failure = `${streamName} maxBuffer length exceeded`;
            void terminate().then(() => finish(outcome()));
            return;
          }
          chunks.push(chunk);
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", collect(stdoutChunks, "stdout"));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", collect(stderrChunks, "stderr"));

        child.on("error", (err) => {
          failure ??= err.message;
          finish(outcome());
        });

        // `close` (not `exit`): fires once the shell has exited AND every
        // holder of its stdout/stderr pipes is gone, which is when the
        // command's output is complete and its work has really stopped.
        child.on("close", (code, signal) => {
          if (!failure && (code !== 0 || signal)) {
            failure = `Command failed: ${prepared.command}`;
          }
          finish(outcome());
        });

        timeoutTimer = setTimeout(() => {
          failure ??= `Command timed out after ${timeout}ms`;
          void terminate().then(() => finish(outcome()));
        }, timeout);

        const onAbort = () => {
          aborted = true;
          void terminate().then(() => finish({ success: false, error: "[Cancelled]" }));
        };

        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const execErr = err as { stdout?: string; stderr?: string; message: string };
        const output = (execErr.stdout || "") + (execErr.stderr ? `\nSTDERR: ${execErr.stderr}` : "");
        if (output.trim()) {
          return { success: false, error: output.trim() };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Command failed: ${msg}` };
    }
  }

  async startBackground(command: string): Promise<ToolResult> {
    if (this.closing) {
      return { success: false, output: "Background processes are being cleaned up; cannot start a new one." };
    }
    // Count launches already admitted but not yet registered, and reserve
    // synchronously, so concurrent calls cannot all pass the check and exceed
    // the cap while one of them awaits the temp directory.
    const alive = [...this.bgProcesses.values()].filter((p) => p.alive).length + this.pendingLaunches;
    if (alive >= MAX_BACKGROUND_PROCESSES) {
      return {
        success: false,
        output: `Too many background processes (${alive}/${MAX_BACKGROUND_PROCESSES}). Stop one first with process_stop.`,
      };
    }

    this.pendingLaunches += 1;
    const launch = this.launchBackground(command);
    this.inFlightLaunches.add(launch);
    try {
      return await launch;
    } finally {
      this.pendingLaunches -= 1;
      this.inFlightLaunches.delete(launch);
    }
  }

  private async launchBackground(command: string): Promise<ToolResult> {
    try {
      const prepared = this.prepareCommand(command);
      if (!prepared.ok) {
        return { success: false, output: prepared.error };
      }
      const tmpDir = await this.ensureTmpDir();
      if (this.closing) {
        // cleanup() started while we awaited the directory; it is waiting for
        // this launch to settle and will remove the directory. Spawning now
        // would create a child nobody tracks.
        return { success: false, output: "Background processes are being cleaned up; the command was not started." };
      }
      const id = nextBgId++;
      const logPath = path.join(tmpDir, `bg-${id}.log`);
      const logStream = createWriteStream(logPath, { flags: "a" });

      const child = spawn("sh", ["-c", prepared.command], {
        cwd: this.cwd,
        // Own process group on POSIX so stop/cleanup can signal descendants,
        // not just the shell. See `terminateProcessTree`.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const closed = closeEvent(child);

      // The log is ended on `close`, once both pipes are drained; letting
      // either pipe auto-end it would drop the other stream's later writes.
      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });

      const entry: BackgroundProcess = {
        id,
        command,
        pid: child.pid ?? 0,
        cwd: this.cwd,
        startedAt: new Date(),
        child,
        logPath,
        alive: true,
        treeAlive: true,
        closed,
        exitCode: null,
      };

      child.on("exit", (code) => {
        entry.alive = false;
        entry.exitCode = code;
      });

      child.on("error", () => {
        entry.alive = false;
      });

      child.on("close", () => {
        entry.alive = false;
        entry.treeAlive = false;
        logStream.end();
      });

      this.bgProcesses.set(id, entry);

      return {
        success: true,
        output: [
          `Background process started (id: ${id}, pid: ${entry.pid})`,
          `Command: ${truncCmd(command, 80)}`,
          `Use process_logs(${id}) to view output, process_stop(${id}) to terminate.`,
        ].join("\n"),
        backgroundProcess: { id, pid: entry.pid, command },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Failed to start background process: ${msg}` };
    }
  }

  async getProcessLogs(id: number, tail = 50): Promise<ToolResult> {
    const entry = this.bgProcesses.get(id);
    if (!entry) {
      return { success: false, output: `No background process with id ${id}.` };
    }

    try {
      const stats = await stat(entry.logPath);
      const start = Math.max(0, stats.size - MAX_TAIL_BYTES);

      const content = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = createReadStream(entry.logPath, { start });
        stream.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
      });

      const lines = content.split("\n");
      const tailed = lines.slice(-tail).join("\n").trimEnd();
      const status = describeStatus(entry);

      return {
        success: true,
        output: [
          `[Process ${id} — ${status} — pid ${entry.pid}]`,
          `[${truncCmd(entry.command, 70)}]`,
          "",
          tailed || "(no output yet)",
        ].join("\n"),
      };
    } catch {
      return {
        success: true,
        output: `[Process ${id} — ${describeStatus(entry)}] (no output yet)`,
      };
    }
  }

  async stopProcess(id: number): Promise<ToolResult> {
    const entry = this.bgProcesses.get(id);
    if (!entry) {
      return { success: false, output: `No background process with id ${id}.` };
    }

    if (!entry.treeAlive) {
      return {
        success: true,
        output: `Process ${id} already exited (code ${entry.exitCode ?? "unknown"}).`,
      };
    }

    try {
      const exited = await terminateProcessTree(entry.child, entry.closed, STOP_SIGKILL_DELAY_MS);

      if (!exited) {
        // `close` never fired: something that left the process group still
        // holds the command's output pipes, so its work may still be running.
        return {
          success: false,
          output: `Process ${id} (pid ${entry.pid}) was signalled, but a descendant outside its process group still holds its output and may still be running.`,
        };
      }
      return {
        success: true,
        output: `Process ${id} (pid ${entry.pid}) stopped.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Failed to stop process ${id}: ${msg}` };
    }
  }

  listProcesses(): ToolResult {
    const entries = [...this.bgProcesses.values()];
    if (entries.length === 0) {
      return { success: true, output: "No background processes." };
    }

    const lines = entries.map((entry) => {
      const status = entry.alive
        ? "running"
        : entry.treeAlive
          ? `exited(${entry.exitCode ?? "?"})+children`
          : `exited(${entry.exitCode ?? "?"})`;
      const age = formatAge(entry.startedAt);
      return `${entry.id}  ${status}  pid:${entry.pid}  ${age}  ${truncCmd(entry.command, 50)}`;
    });

    return {
      success: true,
      output: ["ID  STATUS       PID    AGE     COMMAND", ...lines].join("\n"),
    };
  }

  /**
   * Terminate every owned process tree (background and in-flight foreground
   * commands), remove the background log directory, and resolve only once
   * those trees have actually exited (SIGTERM, then SIGKILL after
   * `CLEANUP_SIGKILL_DELAY_MS`, bounded by `POST_SIGKILL_WAIT_MS`).
   *
   * Concurrent calls share the in-flight cleanup. While it runs, no new
   * background launch is admitted and launches already admitted abandon before
   * spawning. Once it resolves the tool is usable again: the next launch
   * creates a fresh log directory.
   */
  cleanup(): Promise<void> {
    if (!this.cleanupInFlight) {
      this.closing = true;
      this.cleanupInFlight = this.runCleanup().finally(() => {
        this.cleanupInFlight = null;
        this.closing = false;
      });
    }
    return this.cleanupInFlight;
  }

  private async runCleanup(): Promise<void> {
    // Launches admitted before `closing` was set either register their child
    // in `bgProcesses` or bail out after their directory await; settle them
    // first so the snapshot below is complete and nothing spawns after it.
    await Promise.allSettled([...this.inFlightLaunches]);

    // SIGTERM then escalate, matching `stopProcess`. Previously this sent
    // SIGTERM and immediately cleared the map, so a process that ignores or is
    // slow to handle SIGTERM was orphaned AND untracked — unkillable through
    // the CLI afterwards. Escalation runs concurrently across processes so
    // teardown stays bounded by one timeout, not N.
    await Promise.all([
      ...[...this.bgProcesses.values()].map(async (entry) => {
        if (entry.treeAlive) {
          await terminateProcessTree(entry.child, entry.closed, CLEANUP_SIGKILL_DELAY_MS);
        }
        try {
          await unlink(entry.logPath);
        } catch {
          /* */
        }
      }),
      ...[...this.foregroundProcesses].map((owned) =>
        terminateProcessTree(owned.child, owned.closed, CLEANUP_SIGKILL_DELAY_MS),
      ),
    ]);
    this.bgProcesses.clear();

    const tmpDirPromise = this.tmpDirPromise;
    this.tmpDirPromise = null;
    if (tmpDirPromise) {
      const tmpDir = await tmpDirPromise.catch(() => null);
      if (tmpDir) {
        try {
          await rm(tmpDir, { recursive: true, force: true });
        } catch {
          /* */
        }
      }
    }
  }

  getCwd(): string {
    return this.cwd;
  }

  getSandboxMode(): SandboxMode {
    return this.sandboxMode;
  }

  setSandboxMode(mode: SandboxMode): void {
    this.sandboxMode = mode;
  }

  getSandboxSettings(): SandboxSettings {
    return this.sandboxSettings;
  }

  setSandboxSettings(settings: SandboxSettings): void {
    this.sandboxSettings = settings;
  }

  getToolDescription(): string {
    if (this.sandboxMode === "shuru") {
      const s = this.sandboxSettings;
      const netStatus = s.allowNet
        ? s.allowedHosts?.length
          ? `network is restricted to: ${s.allowedHosts.join(", ")}`
          : "network access is enabled"
        : "network is disabled";
      const hostBrowserNote = s.hostBrowserCommandsOnHost
        ? " Commands that invoke agent-browser run on the host instead of inside Shuru so they can interact with forwarded localhost services."
        : "";
      return `Execute a bash command inside a Shuru sandbox. Use for find, ls, git inspection, build tools, test runners, and other shell commands that should stay isolated. For content search, prefer the dedicated grep tool. The current workspace is mounted inside the sandbox at /workspace, ${netStatus}, and shell-side workspace file changes do not persist back to the host in this version, so prefer the dedicated file tools for durable edits.${hostBrowserNote} Set background=true for long-running processes like dev servers or watchers.`;
    }
    return "Execute a bash command. Use for find, ls, git, build tools, package managers, running tests, and any other shell command. For content search, prefer the dedicated grep tool. Set background=true for long-running processes like dev servers, watchers, or anything that should keep running while you continue working. For file read/write/edit, prefer the dedicated file tools instead.";
  }

  private prepareCommand(command: string): { ok: true; command: string } | { ok: false; error: string } {
    if (this.sandboxMode !== "shuru") {
      return { ok: true, command };
    }
    if (shouldRunOnHostInSandboxMode(command, this.sandboxSettings)) {
      return { ok: true, command: wrapHostBrowserCommand(command) };
    }
    const unsupportedReason = getSandboxUnsupportedReason();
    if (unsupportedReason) {
      return { ok: false, error: unsupportedReason };
    }
    const blockedReason = getSandboxMutationBlockReason(command, this.sandboxSettings);
    if (blockedReason) {
      return { ok: false, error: blockedReason };
    }
    const settingsError = getSandboxSettingsError(this.sandboxSettings);
    if (settingsError) {
      return { ok: false, error: settingsError };
    }
    return { ok: true, command: wrapCommandForShuru(this.cwd, command, this.sandboxSettings) };
  }

  private formatSandboxRuntimeError(output: string, fallbackMessage: string): string | null {
    if (this.sandboxMode !== "shuru") {
      return null;
    }
    if (output.includes("shuru: command not found") || output.includes("sh: shuru: not found")) {
      return "Shuru sandbox mode is enabled, but the `shuru` CLI is not installed or not on PATH. Install Shuru or disable sandbox mode.";
    }
    if (output.includes("Apple Silicon") || fallbackMessage.includes("Apple Silicon")) {
      return "Shuru sandbox mode requires macOS on Apple Silicon.";
    }
    return null;
  }
}

/**
 * Recognise a complete standalone `cd <dir>` invocation: `cd` followed by
 * exactly one (possibly quoted) word and no shell operators. Anything else
 * (`cd dir && make`, `cd dir; ls`, pipes, redirections, substitutions) is left
 * to the shell, where it runs in a subshell and does not move the tool's cwd.
 * Previously every string starting with `cd ` was intercepted, so
 * `cd dir && make` was treated as a directory literally named `dir && make`
 * and the command never ran.
 */
export function parseStandaloneCd(command: string): string | null {
  const trimmed = command.trim();
  if (!/^cd\s/.test(trimmed) || hasUnsafeShellMetachars(trimmed)) return null;
  const tokens = tokenizeShell(trimmed);
  if (tokens.length !== 2 || tokens[0] !== "cd") return null;
  return expandHomeInCdTarget(trimmed.slice(2).trim(), tokens[1]);
}

/**
 * Expand a leading `~`, `$HOME` or `${HOME}` the way the shell would, so the
 * tool's cwd matches what `cd ~/x` means instead of a literal `./~/x`.
 * Quoted `~` is literal in the shell, so it is left alone; `$HOME` expands
 * inside double quotes but not single quotes.
 */
function expandHomeInCdTarget(rawWord: string, target: string): string {
  const home = os.homedir();
  if (rawWord.startsWith("~") && (target === "~" || target.startsWith("~/"))) {
    return home + target.slice(1);
  }
  if (!rawWord.startsWith("$") && !rawWord.startsWith('"$')) return target;
  const m = /^(\$HOME|\$\{HOME\})(?=\/|$)/.exec(target);
  return m ? home + target.slice(m[1].length) : target;
}

/** Resolves on the child's `close` event: process exited and every inherited stdio pipe released. */
function closeEvent(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve());
  });
}

/**
 * Terminate the process tree rooted at `child` and resolve once it has
 * actually gone. The child is spawned detached on POSIX so it leads its own
 * process group; signalling the negative pgid reaches every descendant,
 * including ones that outlived an already-exited shell while holding its
 * pipes. Escalates SIGTERM → SIGKILL after `graceMs`, then waits a bounded
 * time for `closed` so a descendant that escaped the group cannot stall
 * teardown forever. Windows has no process groups here: only the direct
 * child is signalled.
 */
async function terminateProcessTree(child: ChildProcess, closed: Promise<void>, graceMs: number): Promise<boolean> {
  signalProcessTree(child, "SIGTERM");
  if (await settledWithin(closed, graceMs)) return true;
  signalProcessTree(child, "SIGKILL");
  if (await settledWithin(closed, POST_SIGKILL_WAIT_MS)) return true;
  // Something outside the group still holds the pipes. Release our ends so
  // we stop buffering its output and `close` can fire; it is no longer ours.
  child.stdout?.destroy();
  child.stderr?.destroy();
  return false;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH: the group is already empty. Fall through so a child that is
      // not a group leader for any reason is still signalled directly.
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

function describeStatus(entry: BackgroundProcess): string {
  if (entry.alive) return "running";
  const exited = `exited (code ${entry.exitCode ?? "unknown"})`;
  return entry.treeAlive ? `${exited}, descendants still running` : exited;
}

function truncCmd(cmd: string, max: number): string {
  const oneLine = cmd.replace(/\n/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatAge(start: Date): string {
  const sec = Math.round((Date.now() - start.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

const SANDBOX_HOST_RE = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
const SANDBOX_PORT_RE = /^\d{1,5}:\d{1,5}$/;
const SANDBOX_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SANDBOX_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Reject sandbox settings that would not survive as a single shuru argument.
 * Settings reach here from user settings, CLI flags and verify manifests
 * without a shared normalizer, so the check sits at the point of use. Values
 * are also shell-quoted when interpolated; this is the second, explicit gate.
 */
export function getSandboxSettingsError(settings: SandboxSettings): string | null {
  const invalid = (what: string, value: unknown) =>
    `Invalid sandbox setting ${what}: ${JSON.stringify(value)}. Fix it in ~/.codesurf/user-settings.json or the CLI flags.`;
  for (const key of ["cpus", "memory", "diskSize"] as const) {
    if (settings[key] !== undefined && !isPositiveNumber(settings[key])) return invalid(key, settings[key]);
  }
  for (const host of settings.allowedHosts ?? []) {
    if (typeof host !== "string" || !SANDBOX_HOST_RE.test(host)) return invalid("allowedHosts", host);
  }
  for (const port of settings.ports ?? []) {
    if (typeof port !== "string" || !SANDBOX_PORT_RE.test(port)) return invalid("ports", port);
  }
  for (const secret of settings.secrets ?? []) {
    if (!SANDBOX_ENV_NAME_RE.test(secret?.name ?? "")) return invalid("secrets.name", secret?.name);
    if (!SANDBOX_ENV_NAME_RE.test(secret?.fromEnv ?? "")) return invalid("secrets.fromEnv", secret?.fromEnv);
    for (const host of secret.hosts ?? []) {
      if (typeof host !== "string" || !SANDBOX_HOST_RE.test(host)) return invalid("secrets.hosts", host);
    }
  }
  if (settings.from !== undefined && !SANDBOX_IMAGE_RE.test(settings.from)) return invalid("from", settings.from);
  return null;
}

export function wrapCommandForShuru(cwd: string, command: string, settings: SandboxSettings = {}): string {
  const parts: string[] = ["shuru", "run"];

  // Every interpolated value is quoted: this string is run by a host shell.
  if (settings.cpus) parts.push("--cpus", shellQuote(String(settings.cpus)));
  if (settings.memory) parts.push("--memory", shellQuote(String(settings.memory)));
  if (settings.diskSize) parts.push("--disk-size", shellQuote(String(settings.diskSize)));
  if (settings.allowNet) parts.push("--allow-net");
  if (settings.allowedHosts) {
    for (const host of settings.allowedHosts) parts.push("--allow-host", shellQuote(host));
  }
  if (settings.ports) {
    for (const port of settings.ports) parts.push("-p", shellQuote(port));
  }
  if (settings.secrets) {
    for (const s of settings.secrets) {
      parts.push("--secret", shellQuote(`${s.name}=${s.fromEnv}@${s.hosts.join(",")}`));
    }
  }
  if (settings.from) parts.push("--from", shellQuote(settings.from));

  const mountArg = `${cwd}:/workspace`;
  parts.push("--mount", shellQuote(mountArg));
  const shellInit = buildShellInitScript(settings);
  const guestPrelude = buildGuestWorkspacePrelude(settings);
  const guestSteps = [
    shellInit,
    guestPrelude,
    `cd ${shellPathForScript(settings.guestWorkdir || "/workspace")}`,
    command,
  ].filter(Boolean);
  const guestCommand = guestSteps.join(" && ");
  parts.push("--", "sh", "-lc", shellQuote(guestCommand));
  return parts.join(" ");
}

const HOST_SAFE_SEGMENT_RE =
  /^\s*(?:(?:npx(?:\s+-y)?|bunx)\s+)?agent-browser\b|^\s*mkdir\s|^\s*sleep\s|^\s*echo\s|^\s*true\s*$|^\s*$/;

/**
 * Split a command line at every point where the host shell would start a new
 * simple command or redirection: newlines, `;`, `&`/`&&`, `|`/`||`/`|&` and
 * `<`/`>` (including `<<`, `>>`). Quoted text is opaque (an `&` inside a URL
 * argument is not a background operator) and a backslash escapes the next
 * character, exactly as the shell reads it. Returns null for an unbalanced
 * quote, which the caller treats as "not classifiable, keep it in the sandbox".
 *
 * The previous regex split only on `&&`, `||`, `;`, `|` and `>`: a newline or
 * a single `&` was not a boundary, so an unrelated command could hide behind
 * an accepted `agent-browser` prefix and run on the host.
 */
export function splitHostShellSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";" || ch === "&" || ch === "|" || ch === ">" || ch === "<") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  segments.push(current);
  return segments;
}

export function shouldRunOnHostInSandboxMode(command: string, settings: SandboxSettings = {}): boolean {
  if (!settings.hostBrowserCommandsOnHost) {
    return false;
  }
  if (!/\bagent-browser\b/.test(command)) {
    return false;
  }
  // Command and process substitution run another program inside a segment
  // that otherwise starts with an accepted word.
  if (/\$\(|`|<\(|>\(/.test(command)) {
    return false;
  }
  const segments = splitHostShellSegments(command);
  if (!segments) {
    return false;
  }
  return segments.every((segment) => HOST_SAFE_SEGMENT_RE.test(segment));
}

export function wrapHostBrowserCommand(command: string): string {
  const normalized = command
    .replace(/\bbunx\s+agent-browser\b/g, "__grok_ab")
    .replace(/\bnpx(?:\s+-y)?\s+agent-browser\b/g, "__grok_ab")
    .replace(/\bagent-browser\b/g, "__grok_ab");
  return [
    "__grok_ab() {",
    "  if command -v agent-browser >/dev/null 2>&1; then",
    '    command agent-browser "$@"',
    "  elif command -v bunx >/dev/null 2>&1; then",
    '    bunx agent-browser "$@"',
    "  elif command -v npx >/dev/null 2>&1; then",
    '    npx -y agent-browser "$@"',
    "  else",
    '    echo "agent-browser: not found (no bunx/npx fallback)" >&2',
    "    return 127",
    "  fi",
    "}",
    normalized,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellPathForScript(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : shellQuote(value);
}

function buildGuestWorkspacePrelude(settings: SandboxSettings): string {
  if (!settings.guestWorkdir || !settings.syncHostWorkspace) {
    return "";
  }

  const guest = shellQuote(settings.guestWorkdir);
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
  const tarExcludes = exclusions.map((entry) => `--exclude=${shellQuote(entry)}`).join(" ");
  return [
    `mkdir -p ${guest}`,
    `find ${guest} -mindepth 1 -maxdepth 1 ${exclusions
      .map((entry) => `! -name ${shellQuote(entry)}`)
      .join(" ")} -exec rm -rf {} + 2>/dev/null || true`,
    `tar -C /workspace ${tarExcludes} -cf - . | tar -C ${guest} -xf -`,
  ].join(" && ");
}

function buildShellInitScript(settings: SandboxSettings): string {
  return (settings.shellInit ?? []).filter(Boolean).join(" && ");
}

function getSandboxUnsupportedReason(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return "Shuru sandbox mode currently requires macOS on Apple Silicon.";
  }
  return null;
}

export function getSandboxMutationBlockReason(command: string, settings: SandboxSettings = {}): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (/\bgit\s+/.test(trimmed) && !/\bgit\s+(status|diff|log|show|rev-parse|grep|ls-files)\b/.test(trimmed)) {
    return [
      "Sandbox mode blocks git commands that mutate repository state because Shuru guest-side workspace changes do not persist back to the host.",
      "Disable sandbox mode to run persistent git mutations on the real workspace.",
    ].join(" ");
  }

  const blockedPatterns: Array<{ pattern: RegExp; reason: string }> = [
    {
      pattern:
        /\b(?:prettier\s+--write|eslint\b.*--fix|biome\s+check\b.*--write|ruff\s+check\b.*--fix|gofmt\s+-w|rustfmt\b|clang-format\b.*-i)\b/,
      reason:
        "Shell-driven formatters that rewrite files are blocked in sandbox mode because those file changes would not persist back to the host workspace.",
    },
  ];

  if (!settings.allowEphemeralInstall) {
    const installPatterns: Array<{ pattern: RegExp; reason: string }> = [
      {
        pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|unlink|update|upgrade)\b/,
        reason:
          "Package-manager installs are blocked in sandbox mode because workspace changes like lockfile updates would stay inside the Shuru guest overlay.",
      },
      {
        pattern: /\b(?:pip|pip3)\s+install\b|\bpoetry\s+add\b|\buv\s+add\b|\bcargo\s+add\b/,
        reason:
          "Dependency install commands are blocked in sandbox mode because resulting workspace changes would not persist back to the host.",
      },
    ];
    const installMatch = installPatterns.find(({ pattern }) => pattern.test(trimmed));
    if (installMatch) {
      return `${installMatch.reason} Use read_file/edit_file/write_file for durable edits, or disable sandbox mode for host-persistent shell changes.`;
    }
  }

  const matched = blockedPatterns.find(({ pattern }) => pattern.test(trimmed));
  if (!matched) return null;
  return `${matched.reason} Use read_file/edit_file/write_file for durable edits, or disable sandbox mode for host-persistent shell changes.`;
}

export interface GrepParams {
  pattern: string;
  path?: string;
  include?: string;
}

/** Flags our dedicated grep tool understands (mapped or no-ops). Anything else
 *  forces fall-through to the real shell so we never silently drop semantics. */
const SAFE_RG_LONG_FLAGS = new Set([
  "--hidden",
  "--no-messages",
  "--json",
  "--no-config",
  "--line-number",
  "--with-filename",
  "--no-heading",
  "--color=never",
  "--color=auto",
  "--color=always",
]);

const SAFE_RG_SHORT_FLAGS = new Set(["n", "H", "I"]);

/**
 * Parse a *simple* `rg` invocation for the host grep fast-path.
 * Returns null (caller should run the real shell) when:
 *  - not an `rg` command
 *  - shell operators / redirection / substitution present
 *  - unknown flags that would change search semantics
 *  - more than one search path
 */
export function tryParseRipgrepCommand(command: string): GrepParams | null {
  const trimmed = command.trim();
  if (!/^rg\b/.test(trimmed)) return null;

  // Reject shell metacharacters outside of quotes. tokenizeShell alone cannot
  // prove `| head` or `&& rm` are safe — refuse the fast path entirely.
  if (hasUnsafeShellMetachars(trimmed)) return null;

  const tokens = tokenizeShell(trimmed);
  if (tokens.length === 0 || tokens[0] !== "rg") return null;

  let pattern: string | undefined;
  let searchPath: string | undefined;
  let include: string | undefined;
  let dashDashSeen = false;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok === "--" && !dashDashSeen) {
      dashDashSeen = true;
      continue;
    }

    if (!dashDashSeen && tok.startsWith("--glob=")) {
      const val = tok.slice(7);
      if (!val || val.startsWith("!")) return null;
      if (include !== undefined) return null;
      include = val;
      continue;
    }

    if (!dashDashSeen && (tok === "-g" || tok === "--glob")) {
      const val = tokens[++i];
      if (!val || val.startsWith("!") || val.startsWith("-")) return null;
      if (include !== undefined) return null;
      include = val;
      continue;
    }

    if (!dashDashSeen && tok.startsWith("--")) {
      if (!SAFE_RG_LONG_FLAGS.has(tok) && !tok.startsWith("--glob=")) return null;
      continue;
    }

    if (!dashDashSeen && tok.startsWith("-") && tok !== "-") {
      // Clustered short flags only; reject anything with args (e.g. -A3).
      const body = tok.slice(1);
      if (!body || !/^[a-zA-Z]+$/.test(body)) return null;
      for (const ch of body) {
        if (!SAFE_RG_SHORT_FLAGS.has(ch)) return null;
      }
      continue;
    }

    if (pattern === undefined) {
      pattern = tok;
    } else if (searchPath === undefined) {
      searchPath = tok;
    } else {
      // Multiple paths — shell rg supports this; our tool does not.
      return null;
    }
  }

  if (!pattern) return null;
  return { pattern, ...(searchPath ? { path: searchPath } : {}), ...(include ? { include } : {}) };
}

function hasUnsafeShellMetachars(input: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "\\" && i + 1 < input.length) {
      i++;
      continue;
    }
    // Pipes, chain, redirect, background, subshell, history expansion.
    if ("|&;<>()`".includes(ch) || ch === "\n") return true;
    if (ch === "$" && i + 1 < input.length && (input[i + 1] === "(" || input[i + 1] === "{")) {
      return true;
    }
  }
  return false;
}

function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    let token = "";
    while (i < input.length && !/\s/.test(input[i])) {
      if (input[i] === "'" || input[i] === '"') {
        const quote = input[i];
        i++;
        while (i < input.length && input[i] !== quote) {
          token += input[i];
          i++;
        }
        if (i >= input.length) return []; // unclosed quote → refuse
        i++;
      } else if (input[i] === "\\" && i + 1 < input.length) {
        token += input[i + 1];
        i += 2;
      } else {
        token += input[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}
