/**
 * Adapter wiring the Codesurf CLI TUI to the shared @codesurf/daemon
 * package. The TUI talks to the same `codesurfd` HTTP daemon the desktop app
 * spawns; both clients resolve to the same `~/.codesurf/daemon/pid.json`, so
 * starting one warms the other.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDaemonClient,
  createDaemonManager,
  DAEMON_PACKAGE_VERSION,
  type DaemonClient,
  type DaemonManager,
  type DaemonStatusInfo,
  defaultCodesurfHome,
  resolveDaemonScriptFromCandidates,
} from "@codesurf/daemon";
import packageJson from "../../package.json";

export type { DaemonStatusInfo };

const CODESURF_HOME = defaultCodesurfHome();

/**
 * Candidate locations for `codesurfd.mjs`, most preferred first. Every
 * candidate is relative to this module, the installed `@codesurf/daemon`
 * package, or the running executable — never to `process.cwd()`: a cloned
 * repository containing `bin/codesurfd.mjs` would otherwise be executed as
 * the daemon just by starting the CLI inside it.
 */
export function buildDaemonScriptCandidates(
  moduleDir: string,
  execPath: string = process.execPath,
  resolveDaemonPackageJson: () => string = () =>
    createRequire(import.meta.url).resolve("@codesurf/daemon/package.json"),
): string[] {
  const candidates: string[] = [];
  // 1. Prefer the package-local launcher shim (src/daemon or dist/daemon ->
  // <pkg>/bin). It only forwards to the shared @codesurf/daemon binary, the
  // same as the desktop app's shim, so the daemon is identical whichever host
  // starts it.
  candidates.push(join(moduleDir, "..", "..", "bin", "codesurfd.mjs"));
  // 2. Resolve the installed package, then add its `bin/codesurfd.mjs`.
  try {
    candidates.push(join(dirname(resolveDaemonPackageJson()), "bin", "codesurfd.mjs"));
  } catch {
    // Package not installed via Node's resolver (e.g. running from raw source).
  }
  // 3. Bundled / packaged Codesurf CLI layouts, anchored to this install.
  candidates.push(
    join(moduleDir, "..", "..", "node_modules", "@codesurf", "daemon", "bin", "codesurfd.mjs"),
    join(moduleDir, "..", "bin", "codesurfd.mjs"),
    join(dirname(execPath), "bin", "codesurfd.mjs"),
  );
  return candidates.filter((path) => path.length > 0);
}

/**
 * Resolve the absolute path to `codesurfd.mjs`. Prefers the file shipped
 * with this install (so the TUI uses the same binary it was built against).
 */
function resolveDaemonScriptPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolveDaemonScriptFromCandidates(buildDaemonScriptCandidates(moduleDir));
}

/**
 * Report the @codesurf/daemon package version (not the Codesurf CLI's TUI version) so
 * we don't fight the desktop app for daemon ownership: any host that pins the
 * same daemon package will agree, and the daemon won't force-restart on the
 * boundary between desktop and TUI sessions. Override with
 * `CODESURF_DAEMON_VERSION_PIN` if you need a different value.
 */
function resolveDaemonAppVersion(): string {
  return process.env.CODESURF_DAEMON_VERSION_PIN?.trim() || DAEMON_PACKAGE_VERSION;
}

export interface CodesurfDaemonBridge {
  homeDir: string;
  manager: DaemonManager;
  client: DaemonClient;
}

const bridgesByHome = new Map<string, CodesurfDaemonBridge>();

export function getCodesurfDaemonBridge(homeDir = CODESURF_HOME): CodesurfDaemonBridge {
  const normalizedHome = homeDir.trim() || CODESURF_HOME;
  const existing = bridgesByHome.get(normalizedHome);
  if (existing) return existing;

  const manager = createDaemonManager({
    homeDir: normalizedHome,
    getAppVersion: resolveDaemonAppVersion,
    resolveDaemonScriptPath,
    // Surface the host TUI's actual version through the daemon's env for
    // diagnostics; the daemon's appVersion stays pinned to the package version.
    extraEnv: () => ({ CODESURF_HOST_APP_VERSION: packageJson.version }),
  });

  const client = createDaemonClient({
    ensureRunning: manager.ensureDaemonRunning,
    getStatus: manager.getDaemonStatus,
    invalidate: manager.invalidateDaemonCache,
  });

  const bridge = { homeDir: normalizedHome, manager, client };
  bridgesByHome.set(normalizedHome, bridge);
  return bridge;
}

const defaultBridge = getCodesurfDaemonBridge(CODESURF_HOME);

export const ensureDaemonRunning = defaultBridge.manager.ensureDaemonRunning;
export const getDaemonStatus = defaultBridge.manager.getDaemonStatus;
export const invalidateDaemonCache = defaultBridge.manager.invalidateDaemonCache;
export const restartDaemon = defaultBridge.manager.restartDaemon;
export const stopDaemon = defaultBridge.manager.stopDaemon;

export const daemonClient: DaemonClient = defaultBridge.client;

/**
 * Best-effort warm start. Use at TUI boot so the daemon is healthy by the time
 * a panel needs it. Never throws; logs errors via the optional sink.
 */
export async function warmStartDaemon(options: { onError?: (err: Error) => void } = {}): Promise<void> {
  try {
    await ensureDaemonRunning();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    options.onError?.(error);
  }
}

/**
 * Returns true if the daemon's binary is reachable from this install. Used by
 * the `codesurf daemon` CLI commands to surface a clear error message rather
 * than the raw resolver throw.
 */
export function daemonBinaryAvailable(): boolean {
  try {
    return existsSync(resolveDaemonScriptPath());
  } catch {
    return false;
  }
}

export { CODESURF_HOME };
