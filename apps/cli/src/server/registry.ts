// Registry of background servers (`codesurf server start`). One JSON record per
// server at <configDir>/servers/<name>.json, its output in <name>.log. The
// config dir is resolved per call (not at module load) so tests and overrides
// that set CODESURF_CONFIG_DIR late still land in the right place.

import fs from "node:fs";
import path from "node:path";
import { getCodesurfConfigDir } from "../utils/config-dir";

export interface ServerRecord {
  name: string;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  cliVersion: string;
  /** "user" serves any folder; "project" only `project` and below. */
  scope: "user" | "project";
  /** Absolute project root (realpath), for a project server. */
  project?: string;
}

export const DEFAULT_SERVER_NAME = "default";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidServerName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function serversDir(configDir = getCodesurfConfigDir()): string {
  return path.join(configDir, "servers");
}

export function recordPath(name: string, configDir?: string): string {
  return path.join(serversDir(configDir), `${name}.json`);
}

export function logPath(name: string, configDir?: string): string {
  return path.join(serversDir(configDir), `${name}.log`);
}

/** True while `pid` names a live process (EPERM = alive but not ours). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRecord(raw: string): ServerRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ServerRecord>;
    if (
      typeof value.name !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.port !== "number" ||
      typeof value.url !== "string"
    ) {
      return null;
    }
    return {
      name: value.name,
      pid: value.pid,
      port: value.port,
      url: value.url,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
      cliVersion: typeof value.cliVersion === "string" ? value.cliVersion : "unknown",
      // Records written before scopes existed were all user servers.
      scope: value.scope === "project" && typeof value.project === "string" ? "project" : "user",
      ...(value.scope === "project" && typeof value.project === "string" ? { project: value.project } : {}),
    };
  } catch {
    return null;
  }
}

export function readRecord(name: string, configDir?: string): ServerRecord | null {
  try {
    return parseRecord(fs.readFileSync(recordPath(name, configDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeRecord(record: ServerRecord, configDir?: string): void {
  fs.mkdirSync(serversDir(configDir), { recursive: true, mode: 0o700 });
  const target = recordPath(record.name, configDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function removeRecord(name: string, configDir?: string): void {
  fs.rmSync(recordPath(name, configDir), { force: true });
}

/**
 * All registered servers, sorted by name. Records whose pid is dead are
 * removed from disk and left out (a server that crashed or was killed).
 */
export function listRecords(configDir?: string): ServerRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(serversDir(configDir));
  } catch {
    return [];
  }
  const out: ServerRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    const record = readRecord(name, configDir);
    if (!record || !isPidAlive(record.pid)) {
      removeRecord(name, configDir);
      continue;
    }
    out.push(record);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The live record for `name`, removing it first when its pid is dead. */
export function liveRecord(name: string, configDir?: string): ServerRecord | null {
  const record = readRecord(name, configDir);
  if (!record) return null;
  if (!isPidAlive(record.pid)) {
    removeRecord(name, configDir);
    return null;
  }
  return record;
}
