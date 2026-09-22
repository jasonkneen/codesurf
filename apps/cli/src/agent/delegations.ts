import { type ChildProcess, spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { DelegationRun, DelegationStatus, TaskRequest, ToolResult } from "../types/index";
import type { SandboxMode, SandboxSettings } from "../utils/settings";

/** Most recent records examined per poll. The TUI polls twice a second while
 *  anything runs; scanning every record ever written is O(all delegations). */
const MAX_SCANNED_DELEGATIONS = 50;
/** Records kept on disk. Pruned on `start()`, never mid-poll. */
const MAX_RETAINED_DELEGATIONS = 200;
/** Grace period before escalating SIGTERM to SIGKILL during cleanup. */
const TERMINATE_SIGKILL_DELAY_MS = 2_000;
/** How long cleanup waits for a SIGKILLed child's exit before giving up on observing it. */
const TERMINATE_EXIT_JOIN_MS = 1_000;
/** How long a child waits for the parent to publish its record (see `loadDelegation`). */
const LAUNCH_HANDSHAKE_TIMEOUT_MS = 5_000;
const LAUNCH_HANDSHAKE_POLL_MS = 20;

/** A delegation child spawned by THIS session, tracked by its ChildProcess
 *  handle rather than by bare pid so a completed child's (possibly reused)
 *  pid is never signalled. */
interface OwnedDelegation {
  pid: number;
  exited: boolean;
  /** Resolves when the child's 'exit' (or spawn 'error') fires. */
  whenExited: Promise<void>;
}

const ID_ADJECTIVES = ["brisk", "calm", "clever", "eager", "gentle", "keen", "lively", "nimble", "quiet", "steady"];

const ID_COLORS = ["amber", "blue", "copper", "emerald", "indigo", "ivory", "silver", "teal", "violet", "white"];

const ID_ANIMALS = ["badger", "falcon", "fox", "heron", "lynx", "otter", "owl", "panda", "sparrow", "wolf"];

export interface StoredDelegation {
  id: string;
  agent: "explore";
  description: string;
  prompt: string;
  cwd: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds: number;
  maxTokens: number;
  batchApi?: boolean;
  status: DelegationStatus;
  startedAt: string;
  completedAt?: string;
  pid?: number;
  error?: string;
  title?: string;
  summary?: string;
  outputPath: string;
  notifiedAt?: string;
}

export interface DelegationNotification {
  id: string;
  message: string;
}

interface StartDelegationOptions {
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds: number;
  maxTokens: number;
  batchApi?: boolean;
}

export class DelegationManager {
  /** Workspace root, resolved ONCE. Storage is keyed on `getProjectId(cwd)`, so
   *  reading the live bash cwd meant a `cd` mid-session silently moved the
   *  delegation directory: in-flight runs stopped listing, stopped notifying,
   *  and `delegation_read(id)` reported them as not found. */
  private readonly root: string;

  /** Delegations started by THIS session that have not exited yet, so they
   *  can be killed on abort/cleanup instead of outliving the process that
   *  spawned them. Entries leave the set on 'exit', never by a blanket clear. */
  private readonly owned = new Set<OwnedDelegation>();

  /** In-flight `killStarted()`; concurrent callers join it rather than
   *  signalling the same children twice. */
  private terminating: Promise<void> | null = null;

  constructor(getCwd: () => string) {
    this.root = getCwd();
  }

  private getCwd(): string {
    return this.root;
  }

  /** Terminate delegations started by this session. Called on abort/cleanup;
   *  detached children otherwise keep running (and burning credits) after the
   *  TUI exits. Bounded: SIGTERM, then SIGKILL after a grace period, then a
   *  short wait for the exit to be observed. */
  killStarted(): Promise<void> {
    if (this.terminating) return this.terminating;
    this.terminating = Promise.all([...this.owned].map((entry) => terminateOwned(entry)))
      .then(() => undefined)
      .finally(() => {
        this.terminating = null;
      });
    return this.terminating;
  }

  /** Take ownership of a spawned child until its exit is observed. */
  private own(child: ChildProcess): void {
    const pid = child.pid;
    if (typeof pid !== "number") return;
    let release: () => void = () => {};
    const entry: OwnedDelegation = {
      pid,
      exited: false,
      whenExited: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    this.owned.add(entry);
    const onGone = () => {
      entry.exited = true;
      this.owned.delete(entry);
      release();
    };
    child.on("exit", onGone);
    // A spawn failure ('error' without 'exit') means there is no process to own.
    child.on("error", onGone);
  }

  async start(request: TaskRequest, options: StartDelegationOptions): Promise<ToolResult> {
    if (process.env.CODESURF_BACKGROUND_CHILD === "1") {
      return {
        success: false,
        output: "Nested background delegations are disabled.",
      };
    }

    if (request.agent !== "explore") {
      return {
        success: false,
        output:
          "Background delegations are read-only. Use `delegate` with the `explore` agent, or use `task` for foreground work that may edit files.",
      };
    }

    const cwd = this.getCwd();
    const dir = await ensureDelegationsDir(cwd);
    await pruneDelegations(dir);
    const { id, jobPath } = await reserveDelegationRecordPath(dir);
    const outputPath = safeJoinDelegationPath(dir, `${id}.md`);

    const record: StoredDelegation = {
      id,
      agent: "explore",
      description: request.description,
      prompt: request.prompt,
      cwd,
      model: options.model,
      sandboxMode: options.sandboxMode,
      sandboxSettings: options.sandboxSettings,
      maxToolRounds: options.maxToolRounds,
      maxTokens: options.maxTokens,
      batchApi: options.batchApi,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath,
    };

    // Launch handshake: the record is NOT published before spawn. The parent
    // used to write it here, spawn, then write the same in-memory record again
    // with the pid; a child (or the async spawn 'error' handler) that reached a
    // terminal state between those writes was silently reset to "running",
    // losing its completion. Now the parent writes exactly once, after spawn,
    // with the pid merged in, and never touches the record again. The child's
    // `loadDelegation` waits for that write (the reservation is an empty file
    // until then), so every later write belongs to the child.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [
          ...resolveCliArgs(),
          "--directory",
          cwd,
          "--background-task-file",
          jobPath,
          ...(options.batchApi ? ["--batch-api"] : []),
        ],
        {
          cwd,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, CODESURF_BACKGROUND_CHILD: "1" },
        },
      );
    } catch (err) {
      // No child exists, so the parent still owns the record: publish it and
      // mark it failed. Otherwise the reservation would sit there unparseable
      // forever — a phantom agent in the footer, and delegation_read telling
      // the model to keep waiting for a process that never started.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await writeRecord(jobPath, record);
        await failDelegation(jobPath, `Failed to spawn delegation: ${message}`);
      } catch {
        // best effort
      }
      return { success: false, output: `Failed to start delegation: ${message}` };
    }

    // Node emits 'error' asynchronously when the process cannot be spawned
    // (EAGAIN/EMFILE under fan-out). An unhandled 'error' on an EventEmitter
    // throws and takes the host down with it.
    child.on("error", (err) => {
      void failDelegation(jobPath, `Delegation process error: ${err.message}`).catch(() => {});
    });
    child.unref();
    this.own(child);

    // The parent's one and only write of this record (see the handshake note above).
    await writeRecord(jobPath, { ...record, pid: child.pid });

    const output = [
      `Delegation started: ${id}`,
      "Agent: explore",
      "You will be notified when it completes.",
      `Use \`delegation_read("${id}")\` to retrieve the full result later.`,
    ].join("\n");

    return {
      success: true,
      output,
      delegation: {
        id,
        agent: "explore",
        description: request.description,
        summary: "Running in the background.",
        status: "running",
      },
    };
  }

  async list(): Promise<DelegationRun[]> {
    const dir = await ensureDelegationsDir(this.getCwd());
    const files = await readDelegationFiles(dir);
    const items = await Promise.all(files.map(async (file) => readRecord(path.join(dir, file))));

    return items
      .filter((item): item is StoredDelegation => item !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => {
        // Records whose process is gone but whose status is still "running"
        // would otherwise show as phantom agents in the footer forever.
        const run = toDelegationRun(record);
        if (run.status !== "running" || isDelegationProcessAlive(record)) return run;
        return { ...run, status: "error" as const, summary: "Stopped without writing a result." };
      });
  }

  async read(id: string): Promise<string> {
    const record = await this.getById(id);
    if (!record) {
      return `Delegation "${id}" not found. Use \`delegation_list()\` to see available results.`;
    }

    if (record.status === "running") {
      if (isDelegationProcessAlive(record)) {
        return `Delegation "${id}" is still running. Continue working and wait for the completion notice.`;
      }
      // The process is gone but the record still says "running" — the child was
      // killed, crashed, or the machine rebooted before it could write its
      // result. Without this the model is told to keep waiting forever.
      return `Delegation "${id}" stopped without writing a result (the process is no longer running). Re-run it if you still need the answer.`;
    }

    try {
      const dir = await ensureDelegationsDir(this.getCwd());
      return await fs.readFile(safeDelegationOutputPath(dir, record.outputPath), "utf8");
    } catch {
      if (record.error) {
        return `Delegation "${id}" failed.\n\n${record.error}`;
      }
      return `Delegation "${id}" completed, but its saved output could not be read.`;
    }
  }

  async consumeNotifications(): Promise<DelegationNotification[]> {
    const dir = await ensureDelegationsDir(this.getCwd());
    const files = await readDelegationFiles(dir);
    const notifications: DelegationNotification[] = [];

    for (const file of files) {
      const jobPath = path.join(dir, file);
      const record = await readRecord(jobPath);
      if (!record || record.status === "running" || record.notifiedAt) continue;

      // Claim the notification with an exclusive-create sentinel BEFORE writing
      // it back. Read-modify-write alone raced: the TUI poller and
      // `processMessage` both call this, and two interleaved reads each saw
      // `notifiedAt` unset and both delivered the same completion notice.
      if (!(await claimNotification(dir, record.id))) continue;

      record.notifiedAt = new Date().toISOString();
      await writeRecord(jobPath, record);
      notifications.push({
        id: record.id,
        message: formatNotification(record),
      });
    }

    return notifications.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async getById(id: string): Promise<StoredDelegation | null> {
    if (!isValidDelegationId(id)) return null;
    const dir = await ensureDelegationsDir(this.getCwd());
    return readRecord(safeJoinDelegationPath(dir, `${id}.json`));
  }
}

export async function loadDelegation(jobPath: string): Promise<StoredDelegation> {
  const record = await readLaunchedRecord(jobPath);
  if (!record) {
    throw new Error(`Delegation job not found: ${jobPath}`);
  }
  // `--background-task-file` accepts any path and `readRecord` is an unchecked
  // JSON.parse cast, so validate the shape here rather than trusting the file.
  // The `agent !== "explore"` check in `start()` is write-side only; re-assert
  // it at the point of EXECUTION so a hand-written or tampered record cannot
  // launch a write-capable agent in a detached background process.
  if (typeof record.id !== "string" || !isValidDelegationId(record.id)) {
    throw new Error(`Delegation job has an invalid id: ${jobPath}`);
  }
  if (typeof record.prompt !== "string" || typeof record.description !== "string") {
    throw new Error(`Delegation job is missing required fields: ${jobPath}`);
  }
  if (record.agent !== "explore") {
    throw new Error(`Background delegations are read-only; refusing to run agent "${String(record.agent)}".`);
  }
  return record;
}

export async function completeDelegation(jobPath: string, output: string, fallbackSummary?: string): Promise<void> {
  const record = await loadDelegation(jobPath);
  record.status = "complete";
  record.completedAt = new Date().toISOString();
  record.title = record.title || createTitle(output, record.description);
  record.summary = createSummary(output || fallbackSummary || record.description);

  await fs.mkdir(path.dirname(record.outputPath), { recursive: true });
  await fs.writeFile(record.outputPath, renderOutput(record, output), "utf8");
  await writeRecord(jobPath, record);
}

/**
 * Best-effort liveness check for a delegation's OS process.
 *
 * `process.kill(pid, 0)` sends no signal; it only tests whether the pid can be
 * signalled. Records written before pids were captured (and any record whose
 * process has been reaped and its pid recycled) fall back to "assume alive",
 * which keeps the previous behaviour rather than falsely declaring a live run
 * dead.
 */
export function isDelegationProcessAlive(record: Pick<StoredDelegation, "pid">): boolean {
  if (typeof record.pid !== "number") return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function failDelegation(jobPath: string, error: string, output = ""): Promise<void> {
  const record = await loadDelegation(jobPath);
  record.status = "error";
  record.completedAt = new Date().toISOString();
  record.error = error;
  record.title = record.title || createTitle(output || error, record.description);
  record.summary = createSummary(output || error);

  await fs.mkdir(path.dirname(record.outputPath), { recursive: true });
  await fs.writeFile(record.outputPath, renderOutput(record, output || `Error: ${error}`), "utf8");
  await writeRecord(jobPath, record);
}

async function ensureDelegationsDir(cwd: string): Promise<string> {
  const projectId = getProjectId(cwd);
  const dir = path.join(os.homedir(), ".grok", "delegations", projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Newest-first delegation record filenames, capped.
 *
 * The TUI polls `list()` and `consumeNotifications()` every 1.5s while anything
 * is running, and both used to read+parse EVERY record ever written for the
 * project. Ids are `adjective-color-animal-8hex` so the name carries no
 * ordering; sort by mtime instead, and only look at the most recent slice.
 * Older records stay on disk and remain readable by id via `getById`.
 */
async function readDelegationFiles(dir: string, limit = MAX_SCANNED_DELEGATIONS): Promise<string[]> {
  try {
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json"));
    if (files.length <= limit) return files;
    const withTimes = await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fs.stat(path.join(dir, file));
          return { file, mtime: stat.mtimeMs };
        } catch {
          return { file, mtime: 0 };
        }
      }),
    );
    return withTimes
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

/**
 * Delete records older than the retention window, oldest first.
 *
 * Best-effort and never throws: pruning is housekeeping, not correctness. Runs
 * on `start()` only, so an idle session does no filesystem work.
 */
async function pruneDelegations(dir: string): Promise<void> {
  try {
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json"));
    if (files.length <= MAX_RETAINED_DELEGATIONS) return;
    const withTimes = await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fs.stat(path.join(dir, file));
          return { file, mtime: stat.mtimeMs };
        } catch {
          return { file, mtime: 0 };
        }
      }),
    );
    const stale = withTimes.sort((a, b) => b.mtime - a.mtime).slice(MAX_RETAINED_DELEGATIONS);
    for (const entry of stale) {
      const record = await readRecord(path.join(dir, entry.file));
      // Never prune something still in flight.
      if (record?.status === "running" && isDelegationProcessAlive(record)) continue;
      await fs.rm(path.join(dir, entry.file), { force: true }).catch(() => {});
      if (record?.outputPath) await fs.rm(record.outputPath, { force: true }).catch(() => {});
      // Drop the notify-once sentinel alongside its record.
      if (record?.id) {
        await fs.rm(path.join(dir, `${record.id}.notified`), { force: true }).catch(() => {});
      }
    }
  } catch {
    // housekeeping only
  }
}

/**
 * Atomically claim the right to deliver a delegation's completion notice.
 *
 * `open(..., "wx")` fails with EEXIST if the file already exists, so exactly one
 * caller wins even with concurrent pollers. Returns true for the winner.
 */
async function claimNotification(dir: string, id: string): Promise<boolean> {
  try {
    const handle = await fs.open(safeJoinDelegationPath(dir, `${id}.notified`), "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function readRecord(filePath: string): Promise<StoredDelegation | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StoredDelegation;
  } catch {
    return null;
  }
}

/**
 * Child-side half of the launch handshake in `DelegationManager.start()`.
 *
 * The job path is reserved as an EMPTY file and only filled in once the parent
 * has spawned the child and knows its pid. A child that boots faster than that
 * write lands sees the empty reservation; wait (bounded) for the parent to
 * publish the record rather than failing the job. A missing file or corrupt
 * JSON is not a pending handshake and fails immediately, as before.
 */
async function readLaunchedRecord(filePath: string): Promise<StoredDelegation | null> {
  const deadline = Date.now() + LAUNCH_HANDSHAKE_TIMEOUT_MS;
  for (;;) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
    if (raw.length > 0) {
      try {
        return JSON.parse(raw) as StoredDelegation;
      } catch {
        return null;
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_HANDSHAKE_POLL_MS));
  }
}

/**
 * Terminate one owned delegation child and wait (bounded) for its exit.
 *
 * The child is spawned `detached`, which makes it a process-group leader, so
 * signalling `-pid` reaches the shell sub-processes an explore agent started
 * too. Identity is guaranteed by `entry.exited`: the flag flips on the
 * ChildProcess 'exit' event, which is only emitted after the pid has been
 * reaped, so a still-tracked pid cannot have been recycled by the OS.
 */
async function terminateOwned(entry: OwnedDelegation): Promise<void> {
  if (entry.exited) return;
  if (!signalOwned(entry, "SIGTERM")) return;
  if (await waitForExit(entry, TERMINATE_SIGKILL_DELAY_MS)) return;
  if (!signalOwned(entry, "SIGKILL")) return;
  await waitForExit(entry, TERMINATE_EXIT_JOIN_MS);
}

/** Signal the child's process group, falling back to the child itself.
 *  Returns false when the process is already gone. */
function signalOwned(entry: OwnedDelegation, signal: NodeJS.Signals): boolean {
  if (entry.exited) return false;
  try {
    process.kill(-entry.pid, signal);
    return true;
  } catch {
    // No such group (or no group support on this platform): try the pid directly.
  }
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Resolves true once the child's exit is observed, false on timeout. */
function waitForExit(entry: OwnedDelegation, timeoutMs: number): Promise<boolean> {
  if (entry.exited) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    // Deliberately NOT unref'd: at shutdown this timer is what keeps the host
    // alive long enough to escalate to SIGKILL. The child handle is unref'd,
    // so an unref'd timer would let an idle loop exit after SIGTERM only.
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void entry.whenExited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function writeRecord(filePath: string, record: StoredDelegation): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function reserveDelegationRecordPath(dir: string): Promise<{ id: string; jobPath: string }> {
  await fs.mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomId();
    const jobPath = safeJoinDelegationPath(dir, `${id}.json`);
    try {
      const handle = await fs.open(jobPath, "wx");
      await handle.close();
      return { id, jobPath };
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code !== "EEXIST") throw error;
    }
  }

  throw new Error("Failed to allocate a unique delegation ID.");
}

function randomId(): string {
  return `${pick(ID_ADJECTIVES)}-${pick(ID_COLORS)}-${pick(ID_ANIMALS)}-${randomBytes(4).toString("hex")}`;
}

function isValidDelegationId(id: string): boolean {
  return /^[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{8}$/.test(id);
}

function safeJoinDelegationPath(dir: string, fileName: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedPath = path.resolve(resolvedDir, fileName);
  const relative = path.relative(resolvedDir, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Delegation path escaped its storage directory.");
  }
  return resolvedPath;
}

function safeDelegationOutputPath(dir: string, outputPath: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedPath = path.resolve(outputPath);
  const relative = path.relative(resolvedDir, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Delegation output path escaped its storage directory.");
  }
  return resolvedPath;
}

function pick(values: readonly string[]): string {
  return values[Math.floor(Math.random() * values.length)];
}

function resolveCliArgs(): string[] {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Could not resolve the CLI entrypoint for background delegation.");
  }
  return [entry];
}

function getProjectId(cwd: string): string {
  const base =
    path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

function createTitle(text: string, fallback: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const source = firstLine || fallback.trim() || "Background delegation";
  return source.length <= 48 ? source : `${source.slice(0, 45).trimEnd()}...`;
}

function createSummary(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No summary available.";
  return compact.length <= 180 ? compact : `${compact.slice(0, 177).trimEnd()}...`;
}

function renderOutput(record: StoredDelegation, content: string): string {
  const title = record.title || record.id;
  const summary = record.summary || "No summary available.";
  const completed = record.completedAt || "N/A";
  const error = record.error ? `\n**Error:** ${record.error}\n` : "";

  return [
    `# ${title}`,
    "",
    summary,
    "",
    `**ID:** ${record.id}`,
    `**Agent:** ${record.agent}`,
    `**Status:** ${record.status}`,
    `**Started:** ${record.startedAt}`,
    `**Completed:** ${completed}`,
    "",
    `**Prompt:** ${record.description}`,
    error.trimEnd(),
    "",
    "---",
    "",
    content.trim() || "(No output)",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNotification(record: StoredDelegation): string {
  const title = record.title || record.description || record.id;
  const summary = record.summary || (record.error ? createSummary(record.error) : "No summary available.");
  const statusText = record.status === "complete" ? "complete" : "failed";
  const lines = [`Background agent ${statusText}: \`${record.id}\``, `Title: ${title}`, `Summary: ${summary}`];

  if (record.error) {
    lines.push(`Error: ${record.error}`);
  }

  lines.push(`Use \`delegation_read("${record.id}")\` to retrieve the full result.`);
  return lines.join("\n");
}

function toDelegationRun(record: StoredDelegation): DelegationRun {
  return {
    id: record.id,
    agent: "explore",
    description: record.description,
    summary: record.summary || (record.status === "running" ? "Running in the background." : "No summary available."),
    status: record.status,
    title: record.title,
    startedAt: record.startedAt,
  };
}
