// Background server lifecycle: `codesurf server start|stop|status|restart|list`
// and the TUI's auto-start. A "server" is a detached `codesurf node` (the engine
// node that owns sessions over WS), tracked in the registry (./registry.ts).
// Nothing here prints; callers decide how to report.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { resolveToken } from "../gateway/token";
import { DEFAULT_NODE_PORT, probeServer } from "../relay/server-discovery";
import { getCodesurfConfigDir } from "../utils/config-dir";
import { type CliEntry, resolveCliEntry } from "./cli-entry";
import {
  DEFAULT_SERVER_NAME,
  isPidAlive,
  isValidServerName,
  listRecords,
  liveRecord,
  logPath,
  removeRecord,
  type ServerRecord,
  serversDir,
  writeRecord,
} from "./registry";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
const PORT_SCAN_LIMIT = 100;

export interface LifecycleOptions {
  configDir?: string;
}

export interface StartServerOptions extends LifecycleOptions {
  name?: string;
  port?: number;
  host?: string;
  cliVersion: string;
  /** How to run this CLI; defaults to resolveCliEntry(). */
  entry?: CliEntry;
  /** How long to wait for the node to answer ping/pong. */
  readyTimeoutMs?: number;
}

export interface StartServerResult {
  record: ServerRecord;
  /** false when a live server with this name was already registered. */
  started: boolean;
}

export interface ServerStatus {
  record: ServerRecord;
  reachable: boolean;
  uptimeMs: number;
}

export function serverUrl(host: string, port: number): string {
  return `ws://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** True when nothing is listening on host:port (we can bind it). */
export function isPortFree(port: number, host = DEFAULT_SERVER_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** First free port at or above `start`, skipping ports registered servers claim. */
export async function pickFreePort(
  start = DEFAULT_NODE_PORT,
  host = DEFAULT_SERVER_HOST,
  claimed: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let port = start; port < start + PORT_SCAN_LIMIT; port++) {
    if (claimed.has(port)) continue;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`no free port in ${start}-${start + PORT_SCAN_LIMIT - 1}`);
}

function tailLog(file: string, lines = 15): string {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function withLog(message: string, file: string): Error {
  const tail = tailLog(file);
  return new Error(tail ? `${message}\n--- ${file} ---\n${tail}` : `${message} (log: ${file})`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilReachable(
  url: string,
  timeoutMs: number,
  stillAlive: () => boolean,
): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillAlive()) return "exited";
    if (await probeServer(url, 1500)) return "ready";
    await sleep(250);
  }
  return "timeout";
}

/**
 * Start a named background server, or return the live one already registered
 * under that name. Resolves once the node answers ping/pong; throws (with the
 * log tail) when it exits early or never becomes reachable.
 */
export async function startServer(options: StartServerOptions): Promise<StartServerResult> {
  const name = options.name ?? DEFAULT_SERVER_NAME;
  if (!isValidServerName(name)) {
    throw new Error(`invalid server name "${name}" (letters, digits, - and _ only)`);
  }
  const configDir = options.configDir ?? getCodesurfConfigDir();
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const log = logPath(name, configDir);

  const existing = liveRecord(name, configDir);
  if (existing) {
    // Registered and alive: possibly still booting (another start in flight).
    const outcome = await waitUntilReachable(existing.url, readyTimeoutMs, () => isPidAlive(existing.pid));
    if (outcome === "ready") return { record: existing, started: false };
    if (outcome === "exited") removeRecord(name, configDir);
    else throw withLog(`server "${name}" (pid ${existing.pid}) is running but not answering on ${existing.url}`, log);
  }

  const claimed = new Set(listRecords(configDir).map((r) => r.port));
  let port: number;
  if (options.port !== undefined) {
    if (claimed.has(options.port) || !(await isPortFree(options.port, host))) {
      throw new Error(`port ${options.port} on ${host} is already in use`);
    }
    port = options.port;
  } else {
    // 3948 is the default server's; extra servers start looking above it.
    port = await pickFreePort(name === DEFAULT_SERVER_NAME ? DEFAULT_NODE_PORT : DEFAULT_NODE_PORT + 1, host, claimed);
  }

  // Create the node token up front so the child and our readiness probe agree
  // on it instead of racing the child's first write.
  await resolveToken("node");

  fs.mkdirSync(serversDir(configDir), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, "a", 0o600);
  fs.writeSync(fd, `\n[${new Date().toISOString()}] starting server "${name}" on ${host}:${port}\n`);
  const entry = options.entry ?? resolveCliEntry();
  let exited = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(entry.command, [...entry.args, "node", "--port", String(port), "--host", host], {
      // A stable folder, not the caller's cwd: sessions carry their own folder.
      cwd: configDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
  } finally {
    fs.closeSync(fd);
  }
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });
  child.unref();
  if (!child.pid) throw withLog(`could not spawn ${entry.command}`, log);

  const record: ServerRecord = {
    name,
    pid: child.pid,
    port,
    url: serverUrl(host, port),
    startedAt: new Date().toISOString(),
    cliVersion: options.cliVersion,
  };
  writeRecord(record, configDir);

  const pid = child.pid;
  const outcome = await waitUntilReachable(record.url, readyTimeoutMs, () => !exited && isPidAlive(pid));
  if (outcome === "ready") return { record, started: true };

  removeRecord(name, configDir);
  if (outcome === "timeout") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    throw withLog(`server "${name}" did not answer on ${record.url} within ${readyTimeoutMs}ms`, log);
  }
  throw withLog(`server "${name}" exited during startup`, log);
}

export interface StopServerResult {
  record: ServerRecord | null;
  /** true when SIGTERM was not enough and SIGKILL was sent. */
  forced: boolean;
}

/** SIGTERM the named server (the node drains gracefully), SIGKILL after `graceMs`. */
export async function stopServer(
  name = DEFAULT_SERVER_NAME,
  options: LifecycleOptions & { graceMs?: number } = {},
): Promise<StopServerResult> {
  const record = liveRecord(name, options.configDir);
  if (!record) return { record: null, forced: false };
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + (options.graceMs ?? 8_000);
  while (Date.now() < deadline && isPidAlive(record.pid)) await sleep(100);
  let forced = false;
  if (isPidAlive(record.pid)) {
    forced = true;
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && isPidAlive(record.pid)) await sleep(50);
  }
  removeRecord(name, options.configDir);
  return { record, forced };
}

export async function statusOf(record: ServerRecord): Promise<ServerStatus> {
  const started = Date.parse(record.startedAt);
  return {
    record,
    reachable: await probeServer(record.url),
    uptimeMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0,
  };
}

export async function serverStatus(
  name = DEFAULT_SERVER_NAME,
  options: LifecycleOptions = {},
): Promise<ServerStatus | null> {
  const record = liveRecord(name, options.configDir);
  return record ? statusOf(record) : null;
}

export async function listServers(options: LifecycleOptions = {}): Promise<ServerStatus[]> {
  return Promise.all(listRecords(options.configDir).map((record) => statusOf(record)));
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}
