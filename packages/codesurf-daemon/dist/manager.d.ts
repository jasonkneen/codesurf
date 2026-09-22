import { spawn, type ChildProcess } from 'node:child_process';
export interface DaemonStatusInfo {
    pid: number;
    port: number;
    token: string;
    startedAt: string;
    protocolVersion: number;
    appVersion: string | null;
}
export interface DaemonManagerConfig {
    /**
     * Root directory for daemon state (`pid.json`, `daemon.log`, `startup.lock`).
     * Typically `~/.codesurf`. Use `defaultCodesurfHome()` from `./paths`.
     */
    homeDir: string;
    /**
     * Returns the host application's version string. Forwarded to the daemon
     * via the `CODESURF_APP_VERSION` env var so the manager can detect drift
     * and force-restart if the host upgrades.
     */
    getAppVersion: () => string;
    /**
     * Locates the absolute path to `codesurfd.mjs` to spawn. Implementations
     * should check release-bundled paths first (e.g. inside `app.asar.unpacked`
     * or `node_modules/@codesurf/daemon/bin`) and fall back to a dev path.
     * Throws if no candidate is found.
     */
    resolveDaemonScriptPath: () => string;
    /**
     * Optional: extra env vars to pass to the spawned daemon. Merged on top of
     * `process.env` and the manager's own additions (CODESURF_HOME, etc.).
     */
    extraEnv?: () => NodeJS.ProcessEnv;
    /**
     * Optional: how long to wait for the daemon's HTTP socket to come up.
     * Default 15s.
     */
    healthTimeoutMs?: number;
}
export interface DaemonManagerRuntime {
    /** Test seam for daemon health requests. Defaults to global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Test seam for detached child creation. Defaults to `node:child_process.spawn`. */
    spawn?: typeof spawn;
    /** Test seam for process liveness checks and TERM/KILL delivery. */
    kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
    /** Test seam that bypasses the real startup grace timer. */
    waitForChildStartupGrace?: (child: ChildProcess) => Promise<void>;
    /** Test seam for the bounded TERM/KILL wait without a wall-clock delay. */
    waitForPidExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
}
export interface DaemonManager {
    ensureDaemonRunning: (options?: {
        forceRestart?: boolean;
    }) => Promise<DaemonStatusInfo>;
    getDaemonStatus: () => Promise<{
        running: boolean;
        info: DaemonStatusInfo | null;
    }>;
    invalidateDaemonCache: () => void;
    restartDaemon: () => Promise<DaemonStatusInfo>;
    stopDaemon: () => Promise<void>;
}
/**
 * Creates a singleton-style daemon supervisor for `codesurfd`. Intended to be
 * instantiated once per host process (Electron main, codesurf TUI, etc.) and
 * shared across all callers in that process.
 */
export declare function createDaemonManager(config: DaemonManagerConfig, runtime?: DaemonManagerRuntime): DaemonManager;
/**
 * Resolves a path to `codesurfd.mjs` by trying a list of candidate paths in
 * order. Returns the first path that exists, or throws if none do. Helper for
 * implementations of `DaemonManagerConfig.resolveDaemonScriptPath`.
 */
export declare function resolveDaemonScriptFromCandidates(candidates: readonly string[]): string;
