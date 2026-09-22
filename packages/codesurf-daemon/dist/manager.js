import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
const DAEMON_STARTUP_GRACE_MS = 1_200;
const DAEMON_POLL_INTERVAL_MS = 150;
const DAEMON_LOCK_STALE_MS = 30_000;
const DAEMON_STOP_TIMEOUT_MS = 5_000;
const DAEMON_KILL_TIMEOUT_MS = 2_000;
/**
 * Creates a singleton-style daemon supervisor for `codesurfd`. Intended to be
 * instantiated once per host process (Electron main, codesurf TUI, etc.) and
 * shared across all callers in that process.
 */
export function createDaemonManager(config, runtime = {}) {
    const healthTimeoutMs = config.healthTimeoutMs ?? 15_000;
    // Resolved per call, not captured: a manager is created once per home and
    // outlives any host that swaps `globalThis.fetch` afterwards (instrumentation,
    // a proxy, a test stub). Binding it here made the health check reach past
    // every such replacement to the fetch that existed at construction time.
    const resolveFetch = () => runtime.fetch ?? globalThis.fetch;
    const spawnImpl = runtime.spawn ?? spawn;
    const killImpl = runtime.kill ?? ((pid, signal) => process.kill(pid, signal));
    const DAEMON_DIR = join(config.homeDir, 'daemon');
    const DAEMON_PID_PATH = join(DAEMON_DIR, 'pid.json');
    const DAEMON_LOG_PATH = join(DAEMON_DIR, 'daemon.log');
    const DAEMON_LOCK_PATH = join(DAEMON_DIR, 'startup.lock');
    let cachedInfo = null;
    let startupPromise = null;
    let startupForcesRestart = false;
    let queuedForceRestartPromise = null;
    function ensureDaemonDir() {
        mkdirSync(DAEMON_DIR, { recursive: true });
    }
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    function resolveAppVersion() {
        const version = config.getAppVersion();
        return typeof version === 'string' && version.trim().length > 0 ? version.trim() : '0.0.0';
    }
    function readPidInfo() {
        try {
            const parsed = JSON.parse(readFileSync(DAEMON_PID_PATH, 'utf8'));
            const protocolVersion = typeof parsed.protocolVersion === 'number'
                ? parsed.protocolVersion
                : (typeof parsed.version === 'number' ? parsed.version : null);
            if (typeof parsed.pid !== 'number'
                || typeof parsed.port !== 'number'
                || typeof parsed.token !== 'string'
                || typeof parsed.startedAt !== 'string'
                || typeof protocolVersion !== 'number') {
                return null;
            }
            return {
                pid: parsed.pid,
                port: parsed.port,
                token: parsed.token,
                startedAt: parsed.startedAt,
                protocolVersion,
                appVersion: typeof parsed.appVersion === 'string' && parsed.appVersion.trim().length > 0
                    ? parsed.appVersion.trim()
                    : null,
            };
        }
        catch {
            return null;
        }
    }
    function isProcessAlive(pid) {
        try {
            killImpl(pid, 0);
            return true;
        }
        catch (error) {
            const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : '';
            return code === 'EPERM';
        }
    }
    function refersToSameDaemon(first, second) {
        return Boolean(first
            && second
            && first.pid === second.pid
            && first.port === second.port
            && first.token === second.token
            && first.startedAt === second.startedAt);
    }
    async function readAuthenticatedDaemonHealth(info) {
        try {
            const response = await resolveFetch()(`http://127.0.0.1:${info.port}/health`, {
                signal: AbortSignal.timeout(2_000),
                headers: {
                    Authorization: `Bearer ${info.token}`,
                },
            });
            if (!response.ok)
                return null;
            const parsed = await response.json();
            const identityMatches = (parsed.ok === true
                && parsed.pid === info.pid
                && parsed.startedAt === info.startedAt);
            return identityMatches
                ? { shuttingDown: parsed.shuttingDown === true }
                : null;
        }
        catch {
            return null;
        }
    }
    async function healthcheck(info) {
        const health = await readAuthenticatedDaemonHealth(info);
        return health !== null && !health.shuttingDown;
    }
    function clearDaemonCache() {
        cachedInfo = null;
    }
    function removeFileIfPresent(filePath) {
        try {
            rmSync(filePath, { force: true });
        }
        catch {
            // ignore
        }
    }
    function cleanupStalePidFile() {
        const info = readPidInfo();
        if (!info || !isProcessAlive(info.pid)) {
            removeFileIfPresent(DAEMON_PID_PATH);
        }
    }
    function tailDaemonLog(lines = 20) {
        try {
            const content = readFileSync(DAEMON_LOG_PATH, 'utf8')
                .split('\n')
                .filter(Boolean)
                .slice(-lines)
                .join('\n');
            return content.trim();
        }
        catch {
            return '';
        }
    }
    function lockLooksStale() {
        try {
            return (Date.now() - statSync(DAEMON_LOCK_PATH).mtimeMs) > DAEMON_LOCK_STALE_MS;
        }
        catch {
            return false;
        }
    }
    async function waitForDaemonReady() {
        const start = Date.now();
        while ((Date.now() - start) < healthTimeoutMs) {
            const info = readPidInfo();
            if (info && isProcessAlive(info.pid) && await healthcheck(info)) {
                cachedInfo = info;
                return info;
            }
            await sleep(DAEMON_POLL_INTERVAL_MS);
        }
        const recentLogs = tailDaemonLog();
        throw new Error(recentLogs
            ? `CodeSurf daemon did not become healthy in time.\n\nRecent daemon logs:\n${recentLogs}`
            : 'CodeSurf daemon did not become healthy in time');
    }
    async function waitForChildStartupGrace(child) {
        if (runtime.waitForChildStartupGrace) {
            await runtime.waitForChildStartupGrace(child);
            return;
        }
        const exitedEarly = await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                resolve(value);
            };
            const timer = setTimeout(() => finish(false), DAEMON_STARTUP_GRACE_MS);
            child.once('error', () => {
                clearTimeout(timer);
                finish(true);
            });
            child.once('exit', () => {
                clearTimeout(timer);
                finish(true);
            });
        });
        if (!exitedEarly)
            return;
        const recentLogs = tailDaemonLog();
        throw new Error(recentLogs
            ? `CodeSurf daemon exited during startup.\n\nRecent daemon logs:\n${recentLogs}`
            : 'CodeSurf daemon exited during startup');
    }
    function spawnDaemonProcess() {
        ensureDaemonDir();
        const out = openSync(DAEMON_LOG_PATH, 'a');
        const daemonScriptPath = config.resolveDaemonScriptPath();
        if (!existsSync(daemonScriptPath)) {
            throw new Error(`Resolved daemon script path does not exist: ${daemonScriptPath}`);
        }
        const child = spawnImpl(process.execPath, [daemonScriptPath], {
            detached: true,
            stdio: ['ignore', out, out],
            env: {
                ...process.env,
                ...(config.extraEnv ? config.extraEnv() : {}),
                // ELECTRON_RUN_AS_NODE is harmless outside Electron; required when the
                // host process is the Electron main bundle so the spawned interpreter
                // behaves as plain Node.
                ELECTRON_RUN_AS_NODE: '1',
                CODESURF_HOME: config.homeDir,
                CODESURF_DAEMON_PID_PATH: DAEMON_PID_PATH,
                CODESURF_APP_VERSION: resolveAppVersion(),
            },
        });
        child.unref();
        closeSync(out);
        return child;
    }
    async function withStartupLock(work, canReuseExisting) {
        ensureDaemonDir();
        const deadline = Date.now() + healthTimeoutMs;
        while (Date.now() < deadline) {
            cleanupStalePidFile();
            try {
                const fd = openSync(DAEMON_LOCK_PATH, 'wx');
                try {
                    return await work();
                }
                finally {
                    closeSync(fd);
                    removeFileIfPresent(DAEMON_LOCK_PATH);
                }
            }
            catch (error) {
                const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : '';
                if (code !== 'EEXIST')
                    throw error;
                const existing = readPidInfo();
                if (existing
                    && canReuseExisting(existing)
                    && isProcessAlive(existing.pid)
                    && await healthcheck(existing)) {
                    cachedInfo = existing;
                    return existing;
                }
                if (lockLooksStale()) {
                    removeFileIfPresent(DAEMON_LOCK_PATH);
                    continue;
                }
                await sleep(DAEMON_POLL_INTERVAL_MS);
            }
        }
        throw new Error('Timed out acquiring CodeSurf daemon startup lock');
    }
    function signalProcessSafely(pid, signal) {
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid)
            return false;
        try {
            killImpl(pid, signal);
            return true;
        }
        catch (error) {
            const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : '';
            if (code === 'ESRCH')
                return false;
            if (code === 'EPERM')
                return true;
            throw error;
        }
    }
    function signalProcessGroupSafely(pid, signal) {
        if (process.platform === 'win32') {
            return signalProcessSafely(pid, signal);
        }
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid)
            return false;
        try {
            killImpl(-pid, signal);
            return true;
        }
        catch (error) {
            const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : '';
            if (code === 'ESRCH')
                return signalProcessSafely(pid, signal);
            if (code === 'EPERM')
                return true;
            throw error;
        }
    }
    async function waitForPidExit(pid, timeoutMs) {
        if (runtime.waitForPidExit) {
            return await runtime.waitForPidExit(pid, timeoutMs);
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!isProcessAlive(pid))
                return true;
            await sleep(DAEMON_POLL_INTERVAL_MS);
        }
        return !isProcessAlive(pid);
    }
    async function authenticateDaemonBeforeSignal(info, signal) {
        const currentBeforeHealth = readPidInfo();
        if (!refersToSameDaemon(currentBeforeHealth, info)
            || !(await readAuthenticatedDaemonHealth(info))) {
            throw new Error(`Refusing to send ${signal} to PID ${info.pid}: daemon identity could not be authenticated`);
        }
        const currentAfterHealth = readPidInfo();
        if (!refersToSameDaemon(currentAfterHealth, info)) {
            throw new Error(`Refusing to send ${signal} to PID ${info.pid}: daemon identity changed during verification`);
        }
    }
    async function stopDaemonProcess(info) {
        if (!info) {
            if (!readPidInfo()) {
                removeFileIfPresent(DAEMON_PID_PATH);
            }
            return;
        }
        if (!isProcessAlive(info.pid)) {
            const current = readPidInfo();
            if (!current || refersToSameDaemon(current, info)) {
                removeFileIfPresent(DAEMON_PID_PATH);
            }
            return;
        }
        await authenticateDaemonBeforeSignal(info, 'SIGTERM');
        signalProcessSafely(info.pid, 'SIGTERM');
        let stopped = await waitForPidExit(info.pid, DAEMON_STOP_TIMEOUT_MS);
        if (!stopped) {
            // Re-authenticate before escalation. If SIGTERM closes HTTP while the
            // process remains alive, fail closed rather than risk sending SIGKILL to
            // a recycled PID. The caller receives the explicit refusal from the
            // identity check and can inspect/remove stale daemon state deliberately.
            await authenticateDaemonBeforeSignal(info, 'SIGKILL');
            signalProcessGroupSafely(info.pid, 'SIGKILL');
            stopped = await waitForPidExit(info.pid, DAEMON_KILL_TIMEOUT_MS);
        }
        if (!stopped) {
            throw new Error(`Timed out stopping CodeSurf daemon PID ${info.pid}`);
        }
        const current = readPidInfo();
        if (!current || refersToSameDaemon(current, info)) {
            removeFileIfPresent(DAEMON_PID_PATH);
        }
    }
    async function runEnsureDaemon(forceRestart) {
        const appVersion = resolveAppVersion();
        const hasCompatibleVersion = (info) => (!info.appVersion || info.appVersion === appVersion);
        const canReuse = (info) => !forceRestart && hasCompatibleVersion(info);
        if (cachedInfo && isProcessAlive(cachedInfo.pid) && await healthcheck(cachedInfo)) {
            if (canReuse(cachedInfo)) {
                return cachedInfo;
            }
        }
        const existing = readPidInfo();
        const existingHealthy = Boolean(existing
            && isProcessAlive(existing.pid)
            && await healthcheck(existing));
        if (forceRestart || (existingHealthy && existing && !hasCompatibleVersion(existing))) {
            await stopDaemonProcess(existing);
            clearDaemonCache();
        }
        else if (existing
            && existingHealthy
            && hasCompatibleVersion(existing)) {
            cachedInfo = existing;
            return existing;
        }
        return await withStartupLock(async () => {
            const lockedExisting = readPidInfo();
            const lockedExistingHealthy = Boolean(lockedExisting
                && isProcessAlive(lockedExisting.pid)
                && await healthcheck(lockedExisting));
            if (lockedExisting
                && lockedExistingHealthy
                && canReuse(lockedExisting)) {
                cachedInfo = lockedExisting;
                return lockedExisting;
            }
            if (lockedExisting
                && (forceRestart
                    || (lockedExistingHealthy && !hasCompatibleVersion(lockedExisting)))) {
                await stopDaemonProcess(lockedExisting);
                clearDaemonCache();
            }
            const child = spawnDaemonProcess();
            await waitForChildStartupGrace(child);
            return await waitForDaemonReady();
        }, canReuse);
    }
    function beginStartup(forceRestart) {
        const operation = runEnsureDaemon(forceRestart);
        startupPromise = operation;
        startupForcesRestart = forceRestart;
        const clearOperation = () => {
            if (startupPromise !== operation)
                return;
            startupPromise = null;
            startupForcesRestart = false;
        };
        void operation.then(clearOperation, clearOperation);
        return operation;
    }
    function ensureDaemonRunning(options) {
        const forceRestart = options?.forceRestart === true;
        // Once a forced restart is queued, all later callers must observe its
        // replacement. Returning the original startup here would hand out a daemon
        // that is about to be terminated.
        if (queuedForceRestartPromise) {
            return queuedForceRestartPromise;
        }
        if (startupPromise) {
            if (!forceRestart || startupForcesRestart) {
                return startupPromise;
            }
            const activeStartup = startupPromise;
            const queuedRestart = activeStartup
                .catch(() => undefined)
                .then(() => beginStartup(true));
            queuedForceRestartPromise = queuedRestart;
            const clearQueuedRestart = () => {
                if (queuedForceRestartPromise === queuedRestart) {
                    queuedForceRestartPromise = null;
                }
            };
            void queuedRestart.then(clearQueuedRestart, clearQueuedRestart);
            return queuedRestart;
        }
        return beginStartup(forceRestart);
    }
    async function getDaemonStatus() {
        const info = readPidInfo();
        if (!info || !isProcessAlive(info.pid) || !(await healthcheck(info))) {
            clearDaemonCache();
            return { running: false, info: null };
        }
        cachedInfo = info;
        return { running: true, info };
    }
    function invalidateDaemonCache() {
        clearDaemonCache();
    }
    async function restartDaemon() {
        invalidateDaemonCache();
        return await ensureDaemonRunning({ forceRestart: true });
    }
    async function stopDaemon() {
        const info = readPidInfo();
        await stopDaemonProcess(info);
        clearDaemonCache();
    }
    return {
        ensureDaemonRunning,
        getDaemonStatus,
        invalidateDaemonCache,
        restartDaemon,
        stopDaemon,
    };
}
/**
 * Resolves a path to `codesurfd.mjs` by trying a list of candidate paths in
 * order. Returns the first path that exists, or throws if none do. Helper for
 * implementations of `DaemonManagerConfig.resolveDaemonScriptPath`.
 */
export function resolveDaemonScriptFromCandidates(candidates) {
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    throw new Error(`Unable to locate codesurfd.mjs in any of:\n  ${candidates.join('\n  ')}`);
}
