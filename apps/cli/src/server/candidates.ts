// Find the servers a front could attach to: registered ones plus whatever
// answers on the probed ports (localhost 3948.. and settings.serverHosts),
// each described by its own `info` (scope/project/name) and whether this user
// has used it before.

import fs from "node:fs";
import { discoverTargetsFromSettings, installNodeTokenResolver } from "../relay/server-discovery";
import { type NodeInfo, SessionStreamClient } from "../relay/session-stream";
import { loadUserSettings } from "../utils/settings";
import { serverUrl } from "./lifecycle";
import { listRecords } from "./registry";
import type { ServerCandidate } from "./scope";

/** Reachable → its info (null info = an older node without the info frame); unreachable → undefined. */
async function probeWithInfo(url: string, timeoutMs = 1200): Promise<{ info: NodeInfo | null } | undefined> {
  installNodeTokenResolver();
  const client = new SessionStreamClient(url);
  const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs + 500));
  const attempt = (async () => {
    try {
      await client.connect();
      if (!(await client.ping(timeoutMs))) return undefined;
      return { info: await client.info(timeoutMs) };
    } catch {
      return undefined;
    }
  })();
  try {
    return await Promise.race([attempt, timer]);
  } finally {
    client.close();
  }
}

/** The folder a front compares project roots against (realpath, like nodes do). */
export function realCwd(cwd = process.cwd()): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export async function discoverServerCandidates(configDir?: string): Promise<ServerCandidate[]> {
  const records = listRecords(configDir);
  const known = loadUserSettings().server?.known ?? {};
  const urls = new Set<string>(records.map((r) => r.url));
  for (const target of discoverTargetsFromSettings()) urls.add(serverUrl(target.host, target.port));

  const probed = await Promise.all([...urls].map(async (url) => ({ url, result: await probeWithInfo(url) })));
  const out: ServerCandidate[] = [];
  for (const { url, result } of probed) {
    if (!result) continue;
    const record = records.find((r) => r.url === url);
    const scope = result.info?.scope ?? record?.scope ?? "user";
    const project = scope === "project" ? (result.info?.project ?? record?.project) : undefined;
    out.push({
      url,
      name: result.info?.name ?? record?.name,
      scope,
      ...(project ? { project } : {}),
      known: Boolean(record) || Boolean(known[url]),
      ...(known[url]?.lastConnectedAt ? { lastUsedAt: known[url].lastConnectedAt } : {}),
    });
  }
  return out;
}
