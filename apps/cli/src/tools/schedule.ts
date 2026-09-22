import { type ChildProcess, execFile, spawn } from "child_process";
import { closeSync, promises as fs, openSync } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { getCodesurfConfigDir } from "../utils/config-dir";
import {
  getCurrentModel,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";

const execFileAsync = promisify(execFile);

/** Largest slice of a run log read back for `readLog`; older output is not loaded. */
const LOG_TAIL_BYTES = 64 * 1024;
/** How far a recorded daemon start time may drift from the OS-reported one and still be the same process. */
const DAEMON_START_TOLERANCE_MS = 5_000;
/** Cross-process lock directory polling; a lock older than the stale limit is assumed abandoned by a crash. */
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

function getSchedulesDir(): string {
  return path.join(getCodesurfConfigDir(), "schedules");
}

function getDaemonPidPath(): string {
  return path.join(getCodesurfConfigDir(), "daemon.pid");
}

const LEGACY_SCHEDULES_DIR = path.join(os.homedir(), ".grok", "schedules");
const LEGACY_DAEMON_PID_PATH = path.join(os.homedir(), ".grok", "daemon.pid");

/** Best-effort copy of legacy ~/.grok/schedules into the codesurf config dir
 *  when the new dir is empty. Never moves; never re-copies if any records exist. */
async function migrateLegacySchedulesOnce(): Promise<void> {
  if (process.env.CODESURF_CONFIG_DIR?.trim()) return;
  const schedulesDir = getSchedulesDir();
  if (path.resolve(schedulesDir) === path.resolve(LEGACY_SCHEDULES_DIR)) return;
  try {
    await fs.mkdir(schedulesDir, { recursive: true });
    const existing = await fs.readdir(schedulesDir).catch(() => [] as string[]);
    if (existing.some((f) => f.endsWith(".json"))) return;
    const legacy = await fs.readdir(LEGACY_SCHEDULES_DIR).catch(() => null);
    if (!legacy || legacy.length === 0) return;
    for (const file of legacy) {
      const src = path.join(LEGACY_SCHEDULES_DIR, file);
      const dest = path.join(schedulesDir, file);
      const st = await fs.stat(src).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        // log dirs are named by schedule id (no extension)
        await fs.cp(src, dest, { recursive: true }).catch(() => {});
      } else if (file.endsWith(".json")) {
        await fs.copyFile(src, dest).catch(() => {});
      }
    }
    // Prefer new daemon.pid location; copy only if missing.
    try {
      await fs.access(getDaemonPidPath());
    } catch {
      await fs.copyFile(LEGACY_DAEMON_PID_PATH, getDaemonPidPath()).catch(() => {});
    }
  } catch {
    /* non-fatal */
  }
}

export interface StoredSchedule {
  id: string;
  name: string;
  instruction: string;
  cron?: string;
  model: string;
  directory: string;
  enabled: boolean;
  maxToolRounds: number;
  /** Sandbox mode of the session that created the schedule; every run inherits it. */
  sandboxMode?: SandboxMode;
  /** Network/port overrides of that session, re-passed as CLI flags. */
  sandboxSettings?: ScheduleSandboxSettings;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** The sandbox overrides a headless run can receive on its command line. */
export type ScheduleSandboxSettings = Pick<SandboxSettings, "allowNet" | "allowedHosts" | "ports">;

export interface ScheduleSandbox {
  mode: SandboxMode;
  settings?: SandboxSettings;
}

export interface ScheduleCreateOptions {
  name: string;
  instruction: string;
  cron?: string;
  model?: string;
  directory?: string;
  maxToolRounds?: number;
}

export interface ScheduleDaemonStatus {
  running: boolean;
  pid: number | null;
}

/** Contents of daemon.pid: the pid plus the daemon's own start time (epoch ms), which is verified
 *  against the OS before the pid is ever classified as the daemon or signalled. */
export interface ScheduleDaemonPidRecord {
  pid: number;
  startedAt: number;
}

export interface ScheduleDaemonStartResult {
  status: ScheduleDaemonStatus;
  pid: number | null;
  alreadyRunning: boolean;
}

export interface ScheduleDaemonStopResult {
  status: ScheduleDaemonStatus;
  pid: number | null;
  wasRunning: boolean;
}

export interface ScheduleCreateResult {
  schedule: StoredSchedule;
  daemonStatus: ScheduleDaemonStatus;
  startedPid: number | null;
}

interface HeadlessRunOptions {
  instruction: string;
  directory: string;
  model: string;
  maxToolRounds: number;
  logPath: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: ScheduleSandboxSettings;
  env?: NodeJS.ProcessEnv;
}

interface CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface ParsedCronPart {
  start: number;
  end: number;
  step: number;
}

export class ScheduleManager {
  constructor(
    private readonly getCwd: () => string = () => process.cwd(),
    private readonly getModel: () => string = () => getCurrentModel(),
    private readonly getSandbox: () => ScheduleSandbox = () => ({
      mode: getCurrentSandboxMode(),
      settings: getCurrentSandboxSettings(),
    }),
  ) {}

  async create(options: ScheduleCreateOptions): Promise<ScheduleCreateResult> {
    const name = options.name.trim();
    const instruction = options.instruction.trim();
    const cron = options.cron?.trim() || undefined;

    if (!name) {
      throw new Error("Schedule name is required.");
    }
    if (!instruction) {
      throw new Error("Schedule instruction is required.");
    }
    if (cron && !isValidCron(cron)) {
      throw new Error(`Invalid cron expression: ${cron}`);
    }

    const id = toScheduleId(name);
    if (!id) {
      throw new Error("Could not derive a valid schedule id from the provided name.");
    }

    const existing = await this.get(id);
    if (existing) {
      throw new Error(`A schedule named "${existing.name}" already exists.`);
    }

    const directory = await resolveScheduleDirectory(options.directory, this.getCwd());
    const model = (options.model?.trim() || this.getModel()).trim();
    const sandbox = this.getSandbox();
    const sandboxSettings = pickScheduleSandboxSettings(sandbox.settings);
    const now = new Date().toISOString();
    const schedule: StoredSchedule = {
      id,
      name,
      instruction,
      ...(cron ? { cron } : {}),
      model,
      directory,
      enabled: true,
      maxToolRounds: options.maxToolRounds ?? 400,
      sandboxMode: sandbox.mode,
      ...(sandboxSettings ? { sandboxSettings } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await withScheduleRecordLock(id, () => createScheduleRecord(schedule));

    let startedPid: number | null = null;
    let stored: StoredSchedule = schedule;
    if (!schedule.cron) {
      try {
        startedPid = await startDetachedHeadlessRun({
          instruction: schedule.instruction,
          directory: schedule.directory,
          model: schedule.model,
          maxToolRounds: schedule.maxToolRounds,
          sandboxMode: schedule.sandboxMode,
          sandboxSettings: schedule.sandboxSettings,
          logPath: getScheduleRunLogPath(schedule.id),
        });
      } catch (err) {
        // The one-time run never launched: roll the record back so the name
        // is reusable and no run timestamp is ever recorded for it.
        await this.remove(id).catch(() => {});
        throw err;
      }
      stored = await this.touchLastRunAt(schedule.id, new Date(now));
    }

    return {
      schedule: stored,
      daemonStatus: await getScheduleDaemonStatus(),
      startedPid,
    };
  }

  async list(): Promise<StoredSchedule[]> {
    const files = await listScheduleFiles();
    const dir = getSchedulesDir();
    const items = await Promise.all(files.map((file) => readScheduleRecord(path.join(dir, file))));
    return items
      .filter((item): item is StoredSchedule => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    return readScheduleRecord(getScheduleRecordPath(id));
  }

  async remove(id: string): Promise<StoredSchedule | null> {
    return withScheduleRecordLock(id, async () => {
      const schedule = await this.get(id);
      if (!schedule) {
        return null;
      }

      await fs.rm(getScheduleRecordPath(id), { force: true });
      await fs.rm(getScheduleLogDir(id), { recursive: true, force: true });
      return schedule;
    });
  }

  async enable(id: string): Promise<StoredSchedule> {
    return this.update(id, (schedule) => {
      if (!schedule.cron) {
        throw new Error(`Schedule "${id}" is one-time only and cannot be enabled.`);
      }
      return { ...schedule, enabled: true, updatedAt: new Date().toISOString() };
    });
  }

  async disable(id: string): Promise<StoredSchedule> {
    return this.update(id, (schedule) => {
      if (!schedule.cron) {
        throw new Error(`Schedule "${id}" is one-time only and cannot be disabled.`);
      }
      return { ...schedule, enabled: false, updatedAt: new Date().toISOString() };
    });
  }

  async readLog(id: string, tail = 50): Promise<string> {
    const schedule = await this.require(id);
    const logPath = getScheduleRunLogPath(schedule.id);

    try {
      const { text, truncated } = await readFileTail(logPath, LOG_TAIL_BYTES);
      let lines = text.split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1);
      // The window may open mid-line; drop that partial first line when more follow.
      if (truncated && lines.length > 1) {
        lines = lines.slice(1);
      }
      if (lines.length === 0) {
        return `No log output yet for "${schedule.name}".`;
      }
      return lines.slice(-Math.max(1, tail)).join("\n");
    } catch {
      return `No log output yet for "${schedule.name}".`;
    }
  }

  async touchLastRunAt(id: string, at = new Date()): Promise<StoredSchedule> {
    const timestamp = at.toISOString();
    return this.update(id, (schedule) => ({
      ...schedule,
      lastRunAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  async getDaemonStatus(): Promise<ScheduleDaemonStatus> {
    return getScheduleDaemonStatus();
  }

  async startDaemon(): Promise<ScheduleDaemonStartResult> {
    return startScheduleDaemon(this.getCwd());
  }

  async stopDaemon(): Promise<ScheduleDaemonStopResult> {
    return stopScheduleDaemon();
  }

  private async require(id: string): Promise<StoredSchedule> {
    const schedule = await this.get(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" not found.`);
    }
    return schedule;
  }

  /** Read-modify-write of one record under its cross-process lock, so a writer
   *  never applies a snapshot that another writer has already superseded. */
  private update(id: string, mutate: (schedule: StoredSchedule) => StoredSchedule): Promise<StoredSchedule> {
    return withScheduleRecordLock(id, async () => {
      const next = mutate(await this.require(id));
      await writeScheduleRecord(next);
      return next;
    });
  }
}

export async function ensureSchedulesDir(): Promise<string> {
  await migrateLegacySchedulesOnce();
  const dir = getSchedulesDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function getScheduleRecordPath(id: string): string {
  const resolved = path.join(getSchedulesDir(), `${id}.json`);
  assertInsideSchedulesDir(resolved);
  return resolved;
}

export function getScheduleLogDir(id: string): string {
  const resolved = path.join(getSchedulesDir(), id);
  assertInsideSchedulesDir(resolved);
  return resolved;
}

function assertInsideSchedulesDir(resolved: string): void {
  const normalized = path.resolve(resolved);
  const root = path.resolve(getSchedulesDir());
  if (!normalized.startsWith(`${root}${path.sep}`) && normalized !== root) {
    throw new Error("Invalid schedule id: path traversal detected.");
  }
}

export function getScheduleRunLogPath(id: string): string {
  return path.join(getScheduleLogDir(id), "run.log");
}

export function getScheduleDaemonPidPath(): string {
  return getDaemonPidPath();
}

/** Claim the daemon record for `pid` as the single owner. The claim runs under a
 *  cross-process lock; a record naming a different, verified-live daemon refuses
 *  the claim, while a dead or reused pid is replaced atomically. */
export async function writeScheduleDaemonPid(pid: number, startedAt?: number): Promise<void> {
  const resolvedStart =
    startedAt ?? (pid === process.pid ? currentProcessStartedAt() : await probeProcessStartedAt(pid));
  if (resolvedStart === null) {
    throw new Error(`Could not determine the start time of schedule daemon pid ${pid}.`);
  }
  const record: ScheduleDaemonPidRecord = { pid, startedAt: Math.round(resolvedStart) };

  await withDaemonPidLock(async () => {
    const existing = await readDaemonPidRecord();
    if (existing && existing.pid !== pid) {
      const verdict = await verifyDaemonRecord(existing);
      if (verdict === "live") {
        throw new Error(`Schedule daemon is already running (pid ${existing.pid}).`);
      }
      if (verdict === "unverifiable") {
        throw new Error(
          `Schedule daemon record names live pid ${existing.pid} that could not be verified; refusing to replace it.`,
        );
      }
    }
    await writeFileAtomic(getDaemonPidPath(), `${JSON.stringify(record)}\n`);
  });
}

/** Remove the daemon record only when it still belongs to `expected` (default: the current process). */
export async function removeScheduleDaemonPid(expected?: ScheduleDaemonPidRecord): Promise<void> {
  await withDaemonPidLock(async () => {
    const existing = await readDaemonPidRecord();
    if (!existing) return;
    const matches = expected
      ? existing.pid === expected.pid && existing.startedAt === expected.startedAt
      : existing.pid === process.pid;
    if (matches) {
      await fs.rm(getDaemonPidPath(), { force: true });
    }
  });
}

/** Pure read: a record is only "running" when its pid is alive and its start time matches the OS. */
export async function getScheduleDaemonStatus(): Promise<ScheduleDaemonStatus> {
  const record = await readDaemonPidRecord();
  if (!record) return { running: false, pid: null };
  const verdict = await verifyDaemonRecord(record);
  return verdict === "live" ? { running: true, pid: record.pid } : { running: false, pid: null };
}

export async function startScheduleDaemon(cwd = process.cwd()): Promise<ScheduleDaemonStartResult> {
  const existing = await getScheduleDaemonStatus();
  if (existing.running) {
    return {
      status: existing,
      pid: existing.pid,
      alreadyRunning: true,
    };
  }

  const child = spawn(process.execPath, [...resolveCliArgs(), "schedule-daemon"], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FORCE_COLOR: "0", CODESURF_DAEMON_CHILD: "1" },
  });
  await awaitSpawnHandshake(child);
  child.unref();

  const status = await waitForDaemonStatus((current) => current.running);
  return {
    status,
    pid: status.pid ?? child.pid ?? null,
    // Another daemon may have won the claim while ours was starting.
    alreadyRunning: status.running && status.pid !== child.pid,
  };
}

export async function stopScheduleDaemon(): Promise<ScheduleDaemonStopResult> {
  const record = await readDaemonPidRecord();
  const verdict = record ? await verifyDaemonRecord(record) : "stale";
  if (!record || verdict !== "live") {
    // Dead or reused pid: reap the record. Unverifiable: leave both alone.
    if (record && verdict === "stale") {
      await removeScheduleDaemonPid(record);
    }
    return {
      status: { running: false, pid: null },
      pid: null,
      wasRunning: false,
    };
  }

  if (record.pid === process.pid) {
    throw new Error("Refusing to stop the current process as the schedule daemon.");
  }

  // Wait on *this* process (pid + start time), not on the record file: a
  // replacement daemon claiming the file meanwhile must not end the wait,
  // and it is neither signalled nor has its record removed.
  signalProcess(record.pid, "SIGTERM");
  let stopped = await waitForDaemonExit(record);
  if (!stopped) {
    signalProcess(record.pid, "SIGKILL");
    stopped = await waitForDaemonExit(record, 10, 100);
  }

  if (!stopped) {
    throw new Error(`Failed to stop schedule daemon pid ${record.pid}.`);
  }

  await removeScheduleDaemonPid(record);
  return {
    status: await getScheduleDaemonStatus(),
    pid: record.pid,
    wasRunning: true,
  };
}

/** True once the process identified by `record` is verifiably gone (dead, or its pid reused). */
async function waitForDaemonExit(record: ScheduleDaemonPidRecord, attempts = 20, delayMs = 50): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if ((await verifyDaemonRecord(record)) === "stale") return true;
    if (attempt >= attempts) return false;
    await sleep(delayMs);
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err: unknown) {
    if (errorCode(err) !== "ESRCH") {
      throw err;
    }
  }
}

async function readDaemonPidRecord(): Promise<ScheduleDaemonPidRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getDaemonPidPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScheduleDaemonPidRecord> | number | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.startedAt === "number" &&
      Number.isFinite(parsed.startedAt)
    ) {
      return { pid: parsed.pid as number, startedAt: parsed.startedAt };
    }
  } catch {
    /* legacy bare-pid or damaged file: carries no verifiable identity */
  }
  return null;
}

type DaemonVerdict = "live" | "stale" | "unverifiable";

/** `live` = the pid is alive and started when the record says; `stale` = dead or a reused pid;
 *  `unverifiable` = alive, but the OS start time could not be read (never treat as ours). */
async function verifyDaemonRecord(record: ScheduleDaemonPidRecord): Promise<DaemonVerdict> {
  if (record.pid === process.pid) {
    return Math.abs(record.startedAt - currentProcessStartedAt()) <= DAEMON_START_TOLERANCE_MS ? "live" : "stale";
  }
  try {
    process.kill(record.pid, 0);
  } catch (err: unknown) {
    if (errorCode(err) === "ESRCH") return "stale";
  }
  const startedAt = await probeProcessStartedAt(record.pid);
  if (startedAt === null) return "unverifiable";
  return Math.abs(startedAt - record.startedAt) <= DAEMON_START_TOLERANCE_MS ? "live" : "stale";
}

function currentProcessStartedAt(): number {
  return Date.now() - process.uptime() * 1000;
}

/** OS-reported start time (epoch ms) of `pid` via `ps -o etime=`, or null when unavailable. */
async function probeProcessStartedAt(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 5_000 });
    const elapsed = parseElapsedSeconds(stdout.trim());
    return elapsed === null ? null : Date.now() - elapsed * 1000;
  } catch {
    return null;
  }
}

/** Parses ps `etime` output: `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS`. */
function parseElapsedSeconds(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function withDaemonPidLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${getDaemonPidPath()}.lock`, fn);
}

function withScheduleRecordLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${getScheduleRecordPath(id)}.lock`, fn);
}

/** Cross-process mutual exclusion via an atomically created lock directory. */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (err: unknown) {
      if (errorCode(err) !== "EEXIST") throw err;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (!stat) continue;
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rmdir(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock ${lockPath}.`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockPath).catch(() => {});
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

export async function listStoredSchedules(): Promise<StoredSchedule[]> {
  return new ScheduleManager().list();
}

export async function readStoredSchedule(id: string): Promise<StoredSchedule | null> {
  return readScheduleRecord(getScheduleRecordPath(id));
}

export async function writeStoredSchedule(schedule: StoredSchedule): Promise<void> {
  await writeScheduleRecord(schedule);
}

export async function startDetachedHeadlessRun(options: HeadlessRunOptions): Promise<number | null> {
  await fs.mkdir(path.dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, "a");
  try {
    const child = spawn(process.execPath, [...resolveCliArgs(), ...buildHeadlessCliArgs(options)], {
      cwd: options.directory,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, FORCE_COLOR: "0", ...options.env },
    });
    // The child inherits its own copy of the log descriptor during the
    // handshake; ours is released in `finally` only once that has settled.
    await awaitSpawnHandshake(child);
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(logFd);
  }
}

/** Resolves on the `spawn` event and rejects on `error`, so an asynchronous launch
 *  failure (missing cwd, EACCES, ENOMEM) surfaces to the caller instead of the process. */
function awaitSpawnHandshake(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      // Post-launch `error` events (only kill/IPC failures, neither used here)
      // must never become uncaught exceptions in a long-lived daemon.
      child.on("error", () => {});
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function buildHeadlessCliArgs(options: Omit<HeadlessRunOptions, "logPath" | "env">): string[] {
  const args = [
    "--directory",
    options.directory,
    "--prompt",
    options.instruction,
    "--model",
    options.model,
    "--max-tool-rounds",
    String(options.maxToolRounds),
  ];
  // The run is detached and outlives the session that created it: it must
  // run at least as sandboxed as that session did. An unsandboxed parent
  // passes nothing, so the child still applies the target directory's own
  // settings and trust decision rather than being forced onto the host.
  if (options.sandboxMode === "shuru") {
    args.push("--sandbox");
    const settings = options.sandboxSettings;
    if (settings?.allowNet) args.push("--allow-net");
    for (const host of settings?.allowedHosts ?? []) args.push("--allow-host", host);
    for (const port of settings?.ports ?? []) args.push("--forward-port", port);
  }
  return args;
}

function pickScheduleSandboxSettings(settings: SandboxSettings | undefined): ScheduleSandboxSettings | undefined {
  if (!settings) return undefined;
  const picked: ScheduleSandboxSettings = {};
  if (settings.allowNet) picked.allowNet = true;
  if (settings.allowedHosts?.length) picked.allowedHosts = [...settings.allowedHosts];
  if (settings.ports?.length) picked.ports = [...settings.ports];
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function resolveCliArgs(): string[] {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Could not resolve the CLI entrypoint.");
  }
  return [entry];
}

async function waitForDaemonStatus(
  settled: (status: ScheduleDaemonStatus) => boolean,
  attempts = 20,
  delayMs = 50,
): Promise<ScheduleDaemonStatus> {
  let status = await getScheduleDaemonStatus();
  for (let attempt = 0; attempt < attempts && !settled(status); attempt++) {
    await sleep(delayMs);
    status = await getScheduleDaemonStatus();
  }
  return status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toScheduleId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    return "";
  }
  return id;
}

export function isValidCron(expr: string): boolean {
  return parseCronExpression(expr) !== null;
}

export function cronMatchesDate(expr: string, date: Date): boolean {
  const cron = parseCronExpression(expr);
  if (!cron) return false;

  const minuteMatch = matchesCronField(cron.minute, date.getMinutes(), 0, 59);
  const hourMatch = matchesCronField(cron.hour, date.getHours(), 0, 23);
  const monthMatch = matchesCronField(cron.month, date.getMonth() + 1, 1, 12);
  const domMatch = matchesCronField(cron.dayOfMonth, date.getDate(), 1, 31);
  const dowMatch = matchesCronField(cron.dayOfWeek, date.getDay(), 0, 7, true);
  const domAny = cron.dayOfMonth === "*";
  const dowAny = cron.dayOfWeek === "*";
  const dayMatch = domAny || dowAny ? domMatch && dowMatch : domMatch || dowMatch;

  return minuteMatch && hourMatch && monthMatch && dayMatch;
}

function parseCronExpression(expr: string): CronExpression | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!validateCronField(minute, 0, 59)) return null;
  if (!validateCronField(hour, 0, 23)) return null;
  if (!validateCronField(dayOfMonth, 1, 31)) return null;
  if (!validateCronField(month, 1, 12)) return null;
  if (!validateCronField(dayOfWeek, 0, 7, true)) return null;

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function validateCronField(field: string, min: number, max: number, dayOfWeek = false): boolean {
  const parts = field.split(",");
  if (parts.length === 0) return false;
  return parts.every((part) => parseCronPart(part.trim(), min, max, dayOfWeek) !== null);
}

function matchesCronField(field: string, value: number, min: number, max: number, dayOfWeek = false): boolean {
  const normalizedValue = normalizeCronValue(value, dayOfWeek);
  return field.split(",").some((part) => {
    const parsed = parseCronPart(part.trim(), min, max, dayOfWeek);
    if (!parsed) return false;
    if (parsed.start <= parsed.end) {
      if (normalizedValue < parsed.start || normalizedValue > parsed.end) return false;
      return (normalizedValue - parsed.start) % parsed.step === 0;
    }
    if (normalizedValue >= parsed.start) {
      return (normalizedValue - parsed.start) % parsed.step === 0;
    }
    if (normalizedValue <= parsed.end) {
      return (normalizedValue - parsed.start + max - min + 1) % parsed.step === 0;
    }
    return false;
  });
}

function parseCronPart(part: string, min: number, max: number, dayOfWeek: boolean): ParsedCronPart | null {
  if (!part) return null;

  const pieces = part.split("/");
  if (pieces.length > 2) return null;

  const base = pieces[0];
  const step = pieces[1] !== undefined ? parseCronInteger(pieces[1]) : 1;
  if (step === null || step <= 0) return null;

  if (base === "*") {
    return { start: min, end: max, step };
  }

  if (base.includes("-")) {
    const rangePieces = base.split("-");
    if (rangePieces.length !== 2) return null;
    const startRaw = parseCronInteger(rangePieces[0]);
    const endRaw = parseCronInteger(rangePieces[1]);
    if (startRaw === null || endRaw === null) return null;
    if (dayOfWeek) {
      if (startRaw < 0 || startRaw > 7 || endRaw < 0 || endRaw > 7) return null;
      if (startRaw > endRaw) return null;
    } else {
      if (startRaw < min || startRaw > max || endRaw < min || endRaw > max) return null;
      if (startRaw > endRaw) return null;
    }
    return { start: normalizeCronValue(startRaw, dayOfWeek), end: normalizeCronValue(endRaw, dayOfWeek), step };
  }

  const value = parseCronNumber(base, min, max, dayOfWeek);
  if (value === null) return null;
  return { start: value, end: value, step };
}

/** Whole-token decimal integer; `parseInt` would silently accept `1garbage`. */
function parseCronInteger(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function parseCronNumber(raw: string, min: number, max: number, dayOfWeek: boolean): number | null {
  const value = parseCronInteger(raw);
  if (value === null) return null;
  if (dayOfWeek) {
    if (value < 0 || value > 7) return null;
  } else {
    if (value < min || value > max) return null;
  }
  return normalizeCronValue(value, dayOfWeek);
}

function normalizeCronValue(value: number, dayOfWeek: boolean): number {
  if (dayOfWeek && value === 7) return 0;
  return value;
}

async function resolveScheduleDirectory(directory: string | undefined, cwd: string): Promise<string> {
  const resolved = directory ? path.resolve(cwd, directory) : cwd;
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Schedule directory does not exist: ${resolved}`);
  }
  return resolved;
}

async function listScheduleFiles(): Promise<string[]> {
  await ensureSchedulesDir();
  try {
    const files = await fs.readdir(getSchedulesDir());
    return files.filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readScheduleRecord(filePath: string): Promise<StoredSchedule | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StoredSchedule;
  } catch {
    return null;
  }
}

/** Replace a record atomically (temp file + rename): readers see the old or the new JSON, never a partial one. */
async function writeScheduleRecord(schedule: StoredSchedule): Promise<void> {
  await ensureSchedulesDir();
  await fs.mkdir(getScheduleLogDir(schedule.id), { recursive: true });
  await writeFileAtomic(getScheduleRecordPath(schedule.id), JSON.stringify(schedule, null, 2));
}

/** Exclusive creation: a concurrent creator (any process) gets "already exists" instead of a second launch. */
async function createScheduleRecord(schedule: StoredSchedule): Promise<void> {
  await ensureSchedulesDir();
  await fs.mkdir(getScheduleLogDir(schedule.id), { recursive: true });
  try {
    await fs.writeFile(getScheduleRecordPath(schedule.id), JSON.stringify(schedule, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err: unknown) {
    if (errorCode(err) !== "EEXIST") throw err;
    const existing = await readScheduleRecord(getScheduleRecordPath(schedule.id));
    throw new Error(`A schedule named "${existing?.name ?? schedule.name}" already exists.`);
  }
}

async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  // Same directory as the target so the rename stays on one device; the
  // suffix keeps it out of the `.json` record listing.
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Reads at most the last `maxBytes` of a file; `truncated` says whether earlier content was skipped. */
async function readFileTail(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: buffer.subarray(0, offset).toString("utf8"), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
