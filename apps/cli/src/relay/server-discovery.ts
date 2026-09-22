// Server discovery — "super simple" localhost-first detection of reachable
// `codesurf node` workers so the TUI can offer a server picker.
//
// Discovery probes candidate WebSocket endpoints by opening the session channel
// and running a ping/pong handshake: a port that answers pong is a live
// `codesurf node`. Probing is bounded (timeout + concurrency) so opening the
// picker never hangs on dead ports. Probes authenticate with the node token
// (see installNodeTokenResolver) — a node rejects unauthenticated sockets.

import { readTokenSync } from "../gateway/token";
import { loadUserSettings } from "../utils/settings";
import { SessionStreamClient } from "./session-stream";

export interface ServerInfo {
  url: string;
  host: string;
  port: number;
  /** Reachability confirmed by ping/pong. */
  reachable: true;
}

export const DEFAULT_NODE_PORT = 3948;
/** Probe the default port plus this many subsequent ports (3948..3948+n-1). */
export const PROBE_RANGE = 8;

export interface DiscoverTarget {
  host: string;
  port: number;
}

export function targetsForHost(host: string, range = PROBE_RANGE): DiscoverTarget[] {
  const out: DiscoverTarget[] = [];
  for (let i = 0; i < range; i++) out.push({ host, port: DEFAULT_NODE_PORT + i });
  return out;
}

export function defaultDiscoverTargets(host = "127.0.0.1", range = PROBE_RANGE): DiscoverTarget[] {
  const out: DiscoverTarget[] = [];
  for (let i = 0; i < range; i++) out.push({ host, port: DEFAULT_NODE_PORT + i });
  return out;
}

/** Targets for localhost plus any configured remote `serverHosts` (network discovery). */
export function discoverTargetsFromSettings(range = PROBE_RANGE): DiscoverTarget[] {
  const targets = targetsForHost("127.0.0.1", range);
  try {
    const settings = loadUserSettings();
    for (const host of settings.serverHosts ?? []) {
      targets.push(...targetsForHost(host, range));
    }
  } catch {
    /* no settings — localhost only */
  }
  return targets;
}

/** Probe a single endpoint; true when it answers the ping/pong handshake. */
export async function probeServer(url: string, timeoutMs = 1800): Promise<boolean> {
  installNodeTokenResolver();
  const client = new SessionStreamClient(url);
  try {
    await client.connect();
    const ok = await client.ping(timeoutMs - 300);
    client.close();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Discover reachable node WS endpoints by probing candidates with bounded
 * concurrency. Returns discovered servers sorted by port.
 */
export async function discoverLocalServers(
  targets: DiscoverTarget[] = defaultDiscoverTargets(),
  concurrency = 6,
): Promise<ServerInfo[]> {
  const found: ServerInfo[] = [];
  const queue = [...targets];
  let active = 0;
  let cursor = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < concurrency && cursor < queue.length) {
        const target = queue[cursor++];
        active++;
        void probeServer(`ws://${target.host}:${target.port}`)
          .then((ok) => {
            if (ok)
              found.push({
                url: `ws://${target.host}:${target.port}`,
                host: target.host,
                port: target.port,
                reachable: true,
              });
          })
          .finally(() => {
            active--;
            if (cursor >= queue.length && active === 0) resolve();
            else pump();
          });
      }
      if (cursor >= queue.length && active === 0) resolve();
    };
    pump();
  });
  return found.sort((a, b) => a.port - b.port);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * Node token for a front connecting to `url`: CODESURF_NODE_TOKEN when set,
 * else the machine-local token file — but only for loopback nodes, so this
 * machine's token is never sent to a remote host.
 */
export function localNodeTokenFor(url: string): string | null {
  const fromEnv = process.env.CODESURF_NODE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return isLoopbackHost(new URL(url).hostname) ? readTokenSync("node") : null;
  } catch {
    return null;
  }
}

/** Install localNodeTokenFor as the SessionStreamClient token source (node-side entrypoints only). */
export function installNodeTokenResolver(): void {
  SessionStreamClient.tokenResolver ??= localNodeTokenFor;
}
