import { BoundedSseJsonDecoder, DaemonChatEventBudget, DaemonSseLimitError, readBoundedResponseDiagnostic, } from './sse.js';
const RETRYABLE_RESPONSE_STATUSES = new Set([401, 408, 502, 503, 504]);
class DaemonResponseError extends Error {
    retryable;
    status;
    constructor(message, status) {
        super(message);
        this.name = 'DaemonResponseError';
        this.status = status;
        this.retryable = RETRYABLE_RESPONSE_STATUSES.has(status);
    }
}
class DaemonMutationOutcomeUnknownError extends Error {
    status;
    constructor(path, cause) {
        super(`Daemon mutation outcome is unknown for ${path}: ${cause.message}. Check daemon state before retrying.`);
        this.name = 'DaemonMutationOutcomeUnknownError';
        this.status = cause instanceof DaemonResponseError ? cause.status : undefined;
        this.cause = cause;
    }
}
class DaemonStreamConsumerError extends Error {
    original;
    constructor(original) {
        super(original instanceof Error ? original.message : String(original));
        this.name = 'DaemonStreamConsumerError';
        this.original = original;
    }
}
class DaemonStreamSequenceGapError extends Error {
    constructor(jobId, expected, received) {
        super(`Daemon event stream sequence gap for job ${jobId}: expected ${expected}, received ${received}`);
        this.name = 'DaemonStreamSequenceGapError';
    }
}
function abortReason(signal) {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortReason(signal);
}
function awaitAbortable(operation, signal) {
    if (!signal)
        return operation;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => {
            finish(() => reject(abortReason(signal)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}
async function waitForReconnect(delayMs, signal) {
    throwIfAborted(signal);
    if (delayMs <= 0)
        return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(signal ? abortReason(signal) : new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function isActiveJobState(state) {
    return state?.status === 'queued' || state?.status === 'running';
}
/** Idempotency key for a job start; Web Crypto when present, otherwise a random string. */
function makeStartRequestId() {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === 'function')
        return webCrypto.randomUUID();
    const part = () => Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${part()}-${part()}`;
}
export function createDaemonClient(hooks) {
    const defaultTimeoutMs = hooks.requestTimeoutMs ?? 5_000;
    async function requestWithPolicy(path, options) {
        let lastError = null;
        const method = options.method ?? (options.body == null ? 'GET' : 'POST');
        const maxAttempts = options.retryPolicy === 'read-only' ? 2 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            throwIfAborted(options.signal);
            try {
                const daemon = await awaitAbortable(hooks.ensureRunning(), options.signal);
                throwIfAborted(options.signal);
                const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs);
                const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
                    method,
                    headers: {
                        Authorization: `Bearer ${daemon.token}`,
                        ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
                    },
                    body: options.body == null ? undefined : JSON.stringify(options.body),
                    signal: options.signal
                        ? AbortSignal.any([options.signal, timeoutSignal])
                        : timeoutSignal,
                });
                if (!response.ok) {
                    const text = await response.text();
                    throw new DaemonResponseError(text || `Daemon request failed: ${response.status}`, response.status);
                }
                return await response.json();
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw abortReason(options.signal);
                lastError = error instanceof Error ? error : new Error(String(error));
                const canRetry = attempt + 1 < maxAttempts;
                if (lastError instanceof DaemonResponseError) {
                    if (lastError.retryable) {
                        hooks.invalidate();
                        if (canRetry)
                            continue;
                    }
                    if (method !== 'GET' && lastError.status === 408) {
                        throw new DaemonMutationOutcomeUnknownError(path, lastError);
                    }
                    throw lastError;
                }
                const status = await awaitAbortable(hooks.getStatus().catch(() => ({ running: false, info: null })), options.signal);
                if (!status.running) {
                    hooks.invalidate();
                }
                if (canRetry) {
                    continue;
                }
                if (method !== 'GET') {
                    throw new DaemonMutationOutcomeUnknownError(path, lastError);
                }
                throw lastError;
            }
        }
        throw (lastError ?? new Error('Daemon request failed'));
    }
    async function request(path, options) {
        const method = options?.method ?? (options?.body == null ? 'GET' : 'POST');
        return await requestWithPolicy(path, {
            ...options,
            retryPolicy: method === 'GET' ? 'read-only' : 'none',
        });
    }
    async function streamJobEvents(options) {
        const jobId = String(options.jobId ?? '').trim();
        if (!jobId)
            throw new Error('jobId is required');
        const since = Number.isFinite(options.since) ? Number(options.since) : 0;
        let lastDeliveredSequence = Math.max(0, since);
        let terminalEventSeen = false;
        let terminalCatchupAttempted = false;
        let reconnectCount = 0;
        const maxReconnectAttempts = Math.min(10, Math.max(0, Math.trunc(Number(options.maxReconnectAttempts ?? 3) || 0)));
        const reconnectDelayMs = Math.min(30_000, Math.max(0, Number(options.reconnectDelayMs ?? 250) || 0));
        const eventBudget = new DaemonChatEventBudget({ expectedJobId: jobId });
        async function deliverParsed(parsed) {
            for (const error of parsed.errors) {
                try {
                    await options.onParseError?.(error);
                }
                catch (consumerError) {
                    throw new DaemonStreamConsumerError(consumerError);
                }
            }
            for (const payload of parsed.events) {
                let event;
                try {
                    event = eventBudget.sanitize(payload);
                }
                catch (error) {
                    if (error instanceof DaemonSseLimitError)
                        throw error;
                    try {
                        await options.onParseError?.(error instanceof Error ? error : new Error(String(error)));
                    }
                    catch (consumerError) {
                        throw new DaemonStreamConsumerError(consumerError);
                    }
                    continue;
                }
                const sequence = Number(event?.sequence);
                if (sequence <= lastDeliveredSequence)
                    continue;
                const expectedSequence = lastDeliveredSequence + 1;
                if (sequence !== expectedSequence) {
                    throw new DaemonStreamSequenceGapError(jobId, expectedSequence, sequence);
                }
                eventBudget.consume(event);
                try {
                    await options.onEvent(event);
                }
                catch (consumerError) {
                    throw new DaemonStreamConsumerError(consumerError);
                }
                lastDeliveredSequence = sequence;
                if (event.type === 'done') {
                    terminalEventSeen = true;
                    return { terminal: true };
                }
            }
            return { terminal: false };
        }
        while (true) {
            throwIfAborted(options.signal);
            const isTerminalCatchupAttempt = terminalCatchupAttempted;
            let disconnectError = null;
            let reader = null;
            try {
                const daemon = await awaitAbortable(hooks.ensureRunning(), options.signal);
                throwIfAborted(options.signal);
                const query = new URLSearchParams({
                    jobId,
                    since: String(lastDeliveredSequence),
                });
                const response = await fetch(`http://127.0.0.1:${daemon.port}/chat/job/events?${query.toString()}`, {
                    headers: {
                        Accept: 'text/event-stream',
                        Authorization: `Bearer ${daemon.token}`,
                    },
                    signal: options.signal,
                });
                if (!response.ok || !response.body) {
                    const text = await readBoundedResponseDiagnostic(response).catch(() => '');
                    if (RETRYABLE_RESPONSE_STATUSES.has(response.status))
                        hooks.invalidate();
                    throw new DaemonResponseError(text || `Daemon event stream failed: ${response.status}`, response.status);
                }
                reader = response.body.getReader();
                const decoder = new BoundedSseJsonDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    const delivered = await deliverParsed(decoder.push(value));
                    if (delivered.terminal)
                        return;
                }
                const delivered = await deliverParsed(decoder.finish());
                if (delivered.terminal)
                    return;
            }
            catch (error) {
                if (error instanceof DaemonStreamConsumerError) {
                    if (error.original instanceof Error)
                        throw error.original;
                    throw new Error(String(error.original));
                }
                if (error instanceof DaemonSseLimitError)
                    throw error;
                if (options.signal?.aborted)
                    throw abortReason(options.signal);
                disconnectError = error instanceof Error ? error : new Error(String(error));
            }
            finally {
                if (reader) {
                    try {
                        // Cancellation is cleanup, not part of successful delivery or
                        // consumer-error settlement. Observe a late rejection without
                        // allowing a non-cooperative underlying stream to hang this call.
                        void reader.cancel().catch(() => { });
                    }
                    catch { }
                    try {
                        reader.releaseLock();
                    }
                    catch { }
                }
            }
            if (terminalEventSeen)
                return;
            if (isTerminalCatchupAttempt) {
                if (disconnectError instanceof DaemonStreamSequenceGapError) {
                    throw disconnectError;
                }
                throw new Error(`Daemon terminal replay ended before delivering the terminal event for job ${jobId}`, { cause: disconnectError ?? undefined });
            }
            if (disconnectError instanceof DaemonResponseError && !disconnectError.retryable) {
                throw disconnectError;
            }
            let state = null;
            try {
                state = await request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`, { signal: options.signal });
            }
            catch (stateError) {
                if (options.signal?.aborted)
                    throw abortReason(options.signal);
                const daemonStatus = await awaitAbortable(hooks.getStatus().catch(() => ({ running: false, info: null })), options.signal);
                if (!daemonStatus.running)
                    hooks.invalidate();
                if (reconnectCount >= maxReconnectAttempts) {
                    throw (disconnectError ?? (stateError instanceof Error ? stateError : new Error(String(stateError))));
                }
            }
            if (state && !isActiveJobState(state)) {
                const terminalLastSequence = Math.max(0, Number(state.lastSequence) || 0);
                if (!terminalCatchupAttempted && terminalLastSequence > lastDeliveredSequence) {
                    terminalCatchupAttempted = true;
                    await waitForReconnect(reconnectDelayMs, options.signal);
                    continue;
                }
                if (disconnectError instanceof DaemonStreamSequenceGapError) {
                    throw disconnectError;
                }
                return;
            }
            if (reconnectCount >= maxReconnectAttempts) {
                if (state && isActiveJobState(state)) {
                    throw new Error(`Daemon event stream ended unexpectedly while job ${jobId} remains active`, { cause: disconnectError ?? undefined });
                }
                throw (disconnectError ?? new Error(`Daemon event stream ended unexpectedly for job ${jobId}`));
            }
            reconnectCount += 1;
            const delay = Math.min(30_000, reconnectDelayMs * (2 ** (reconnectCount - 1)));
            await waitForReconnect(delay, options.signal);
        }
    }
    return {
        /** Escape hatch for routes the typed surface doesn't cover. */
        request,
        startChatJob(requestBody) {
            // D1: a caller that retries a job start after an unknown outcome (lost
            // response, timeout) must reuse the same startRequestId so the daemon
            // coalesces onto the job the first attempt created instead of executing
            // the prompt twice. Generate one when the caller hasn't supplied it.
            const supplied = typeof requestBody.startRequestId === 'string' ? requestBody.startRequestId.trim() : '';
            const startRequestId = supplied || makeStartRequestId();
            return request('/chat/job/start', { body: { request: { ...requestBody, startRequestId } } });
        },
        streamJobEvents,
        getJobState(jobId) {
            return request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`);
        },
        cancelJob(jobId) {
            return request('/chat/job/cancel', { body: { jobId } });
        },
        answerPermission(answer) {
            return request('/chat/job/permission/answer', { body: answer });
        },
        /**
         * READ-ONLY: list Personas (built-ins + the workspace's agents.json overlay)
         * for `codesurf chat --list-personas` and for seeding the soft model binding.
         * The set matches what resolveAuthoritativeAgentMode applies at start time.
         */
        listPersonas(args = {}) {
            const query = new URLSearchParams();
            const workspaceId = String(args.workspaceId ?? '').trim();
            const workspaceDir = String(args.workspaceDir ?? '').trim();
            if (workspaceId)
                query.set('workspaceId', workspaceId);
            if (workspaceDir)
                query.set('workspaceDir', workspaceDir);
            return request(`/personas/list${query.size > 0 ? `?${query.toString()}` : ''}`);
        },
        getJobDashboard() {
            return request('/dashboard/api/jobs');
        },
        listHosts() {
            return request('/host/list');
        },
        upsertHost(host) {
            return request('/host/upsert', { body: { host } });
        },
        deleteHost(id) {
            return request(`/host/${encodeURIComponent(id)}`, { method: 'DELETE' });
        },
        listPermissions() {
            return request('/permissions');
        },
        setPermissionGrant(args) {
            return request('/permissions/grant', { body: args });
        },
        resolvePermission(args) {
            return request('/permissions/resolve', { body: args });
        },
        clearPermissionGrant(id) {
            return request('/permissions/clear', { body: { id } });
        },
        clearAllPermissionGrants() {
            return request('/permissions/clear', { body: { all: true } });
        },
        listWorkspaces() {
            return request('/workspace/list');
        },
        listProjects() {
            return request('/workspace/projects');
        },
        getActiveWorkspace() {
            return request('/workspace/active');
        },
        createWorkspace(name) {
            return request('/workspace/create', { body: { name } });
        },
        createWorkspaceWithPath(name, projectPath) {
            return request('/workspace/create-with-path', { body: { name, projectPath } });
        },
        createWorkspaceFromFolder(folderPath) {
            return request('/workspace/create-from-folder', { body: { folderPath } });
        },
        addProjectFolder(workspaceId, folderPath) {
            return request('/workspace/add-project-folder', { body: { workspaceId, folderPath } });
        },
        removeProjectFolder(workspaceId, folderPath) {
            return request('/workspace/remove-project-folder', { body: { workspaceId, folderPath } });
        },
        renameProject(args) {
            return request('/workspace/project/rename', { body: args });
        },
        createProjectWorktree(args) {
            return request('/workspace/project/worktree', { body: args });
        },
        setActiveWorkspace(id) {
            return request('/workspace/set-active', { body: { id } });
        },
        deleteWorkspace(id) {
            return request(`/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' });
        },
        listLocalSessions(workspaceId) {
            return request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`);
        },
        upsertRuntimeSession(workspaceId, cardId, state) {
            return request('/session/runtime/upsert', { body: { workspaceId, cardId, state } });
        },
        clearRuntimeSession(workspaceId, cardId) {
            return request('/session/runtime/clear', { body: { workspaceId, cardId } });
        },
        getLocalSessionState(workspaceId, sessionEntryId) {
            return request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent(sessionEntryId)}`);
        },
        deleteLocalSession(workspaceId, sessionEntryId) {
            return request('/session/local/delete', { body: { workspaceId, sessionEntryId } });
        },
        renameLocalSession(workspaceId, sessionEntryId, title) {
            return request('/session/local/rename', { body: { workspaceId, sessionEntryId, title } });
        },
        listExternalSessions(workspacePath, force = false) {
            const normalizedPath = String(workspacePath ?? '').trim();
            const query = new URLSearchParams();
            if (normalizedPath)
                query.set('workspacePath', normalizedPath);
            if (force)
                query.set('force', '1');
            return request(`/session/external/list?${query.toString()}`);
        },
        invalidateExternalSessions(workspacePath) {
            return request('/session/external/invalidate', {
                body: { workspacePath: String(workspacePath ?? '').trim() || null },
            });
        },
        getExternalSessionState(workspacePath, sessionEntryId) {
            const normalizedPath = String(workspacePath ?? '').trim();
            const query = new URLSearchParams();
            if (normalizedPath)
                query.set('workspacePath', normalizedPath);
            query.set('sessionEntryId', sessionEntryId);
            return request(`/session/external/state?${query.toString()}`);
        },
        deleteExternalSession(workspacePath, sessionEntryId) {
            return request('/session/external/delete', {
                body: {
                    workspacePath: String(workspacePath ?? '').trim() || null,
                    sessionEntryId,
                },
            });
        },
        renameExternalSession(workspacePath, sessionEntryId, title) {
            return request('/session/external/rename', {
                body: {
                    workspacePath: String(workspacePath ?? '').trim() || null,
                    sessionEntryId,
                    title,
                },
            });
        },
        createCheckpoint(workspaceId, sessionEntryId, payload) {
            return request('/checkpoint/create', { body: { workspaceId, sessionEntryId, ...payload } });
        },
        listCheckpoints(workspaceId, sessionEntryId) {
            return request('/checkpoint/list', { body: { workspaceId, sessionEntryId } });
        },
        restoreCheckpoint(workspaceId, checkpointId, sessionEntryId) {
            return request('/checkpoint/restore', {
                body: { workspaceId, checkpointId, sessionEntryId: sessionEntryId ?? null },
            });
        },
        loadMemoryContext(workspaceId, executionTarget = 'local') {
            return request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=${encodeURIComponent(executionTarget)}`);
        },
        getDreamStatus(workspaceId) {
            return request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`);
        },
        listDreamRuns(workspaceId, limit = 20) {
            return request(`/dreaming/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${encodeURIComponent(String(limit))}`);
        },
        runDream(args) {
            return request('/dreaming/run', { body: args });
        },
        cancelDream(args) {
            return request('/dreaming/cancel', { body: args });
        },
        listSkills(args = {}) {
            const query = new URLSearchParams();
            const workspaceId = String(args.workspaceId ?? '').trim();
            const workspaceDir = String(args.workspaceDir ?? '').trim();
            const cardId = String(args.cardId ?? '').trim();
            if (workspaceId)
                query.set('workspaceId', workspaceId);
            if (workspaceDir)
                query.set('workspaceDir', workspaceDir);
            if (cardId)
                query.set('cardId', cardId);
            return request(`/skills/list${query.size > 0 ? `?${query.toString()}` : ''}`);
        },
        getSkill(args) {
            const query = new URLSearchParams();
            query.set('skillId', String(args.skillId ?? '').trim());
            const workspaceId = String(args.workspaceId ?? '').trim();
            const workspaceDir = String(args.workspaceDir ?? '').trim();
            const cardId = String(args.cardId ?? '').trim();
            if (workspaceId)
                query.set('workspaceId', workspaceId);
            if (workspaceDir)
                query.set('workspaceDir', workspaceDir);
            if (cardId)
                query.set('cardId', cardId);
            return request(`/skills/get?${query.toString()}`);
        },
        installSkill(args) {
            return request('/skills/install', { body: args });
        },
        expandFileReferences(payload) {
            return request('/file-references/expand', {
                body: {
                    message: payload.message,
                    workspaceId: String(payload.workspaceId ?? '').trim() || null,
                    cardId: String(payload.cardId ?? '').trim() || null,
                    workspaceDir: String(payload.workspaceDir ?? '').trim() || null,
                    executionTarget: payload.executionTarget === 'cloud' ? 'cloud' : 'local',
                    supportedImageMediaTypes: payload.supportedImageMediaTypes,
                },
            });
        },
        issueAttachmentCapabilities(payload) {
            return request('/file-references/capabilities/issue', { body: payload });
        },
        inspectAttachmentCapabilities(payload) {
            return request('/file-references/capabilities/inspect', { body: payload });
        },
        getSettings() {
            return request('/settings');
        },
        setSettings(settings) {
            return request('/settings', { body: { settings } });
        },
        getRawSettingsJson() {
            return request('/settings/raw');
        },
        setRawSettingsJson(json) {
            return request('/settings/raw', { body: { json } });
        },
    };
}
