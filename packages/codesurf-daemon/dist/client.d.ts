import type { DaemonStatusInfo } from './manager.js';
import type { AggregatedSessionEntry, DaemonChatJobEvent, DaemonChatJobRequest, DaemonChatJobState, DaemonChatPermissionAnswer, DaemonPersonaListResult, DaemonSkillEntry, DaemonSkillIndex, DaemonToolPermissionGrant, DaemonToolPermissionListResult, DaemonToolPermissionRequest, DaemonToolPermissionScope, DashboardDreamingSummary, DreamRunSummary, ExecutionHostRecord, ProjectRecord, Workspace } from './types.js';
export interface DaemonClientHooks {
    /**
     * Resolves the live daemon connection (port + token). Typically
     * `manager.ensureDaemonRunning`.
     */
    ensureRunning: (options?: {
        forceRestart?: boolean;
    }) => Promise<DaemonStatusInfo>;
    /**
     * Returns whether the daemon is currently healthy. Used to decide whether to
     * invalidate the cache after a transport failure. Typically
     * `manager.getDaemonStatus`.
     */
    getStatus: () => Promise<{
        running: boolean;
        info: DaemonStatusInfo | null;
    }>;
    /** Drops the cached daemon connection so the next request re-discovers it. */
    invalidate: () => void;
    /** Optional override for per-request timeout (ms). Defaults to 5000. */
    requestTimeoutMs?: number;
}
export interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    /** Per-request override of the request timeout (ms). */
    timeoutMs?: number;
    /** Cancels the request and any read-only retry immediately. */
    signal?: AbortSignal;
}
export interface StreamJobEventsOptions {
    jobId: string;
    since?: number;
    signal?: AbortSignal;
    /** Maximum reconnects after the initial stream. Defaults to 3, capped at 10. */
    maxReconnectAttempts?: number;
    /** Initial reconnect delay in milliseconds. Doubles per retry, capped at 30s. */
    reconnectDelayMs?: number;
    onEvent: (event: DaemonChatJobEvent) => void | Promise<void>;
    onParseError?: (error: Error) => void | Promise<void>;
}
export type DaemonClient = ReturnType<typeof createDaemonClient>;
export declare function createDaemonClient(hooks: DaemonClientHooks): {
    /** Escape hatch for routes the typed surface doesn't cover. */
    request: <T>(path: string, options?: RequestOptions) => Promise<T>;
    startChatJob(requestBody: DaemonChatJobRequest): Promise<DaemonChatJobState>;
    streamJobEvents: (options: StreamJobEventsOptions) => Promise<void>;
    getJobState(jobId: string): Promise<DaemonChatJobState>;
    cancelJob(jobId: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    answerPermission(answer: DaemonChatPermissionAnswer): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /**
     * READ-ONLY: list Personas (built-ins + the workspace's agents.json overlay)
     * for `codesurf chat --list-personas` and for seeding the soft model binding.
     * The set matches what resolveAuthoritativeAgentMode applies at start time.
     */
    listPersonas(args?: {
        workspaceId?: string | null;
        workspaceDir?: string | null;
    }): Promise<DaemonPersonaListResult>;
    getJobDashboard(): Promise<{
        jobs: Array<{
            id: string;
            taskLabel: string | null;
            status: string;
            runMode?: string | null;
            workspaceId?: string | null;
            cardId?: string | null;
            provider: string | null;
            model: string | null;
            workspaceDir: string | null;
            requestedAt: string | null;
            updatedAt: string | null;
            completedAt?: string | null;
            lastSequence: number;
            sessionId?: string | null;
            initialPrompt?: string | null;
            error: string | null;
        }>;
        summary: {
            total: number;
            active: number;
            backgroundActive: number;
            completed: number;
            failed: number;
            cancelled: number;
            other: number;
        };
        daemon: {
            pid: number;
            startedAt: string;
            appVersion: string | null;
        };
        dreaming?: DashboardDreamingSummary | null;
    }>;
    listHosts(): Promise<ExecutionHostRecord[]>;
    upsertHost(host: ExecutionHostRecord): Promise<ExecutionHostRecord[]>;
    deleteHost(id: string): Promise<{
        ok: true;
        hosts: ExecutionHostRecord[];
    }>;
    listPermissions(): Promise<DaemonToolPermissionListResult>;
    setPermissionGrant(args: DaemonToolPermissionRequest & {
        action?: "allow" | "deny";
        scope?: Exclude<DaemonToolPermissionScope, "session"> | null;
    }): Promise<DaemonToolPermissionListResult & {
        grant: DaemonToolPermissionGrant;
    }>;
    resolvePermission(args: DaemonToolPermissionRequest): Promise<{
        decision: "allow" | "deny" | null;
        grant: DaemonToolPermissionGrant | null;
    }>;
    clearPermissionGrant(id: string): Promise<DaemonToolPermissionListResult>;
    clearAllPermissionGrants(): Promise<DaemonToolPermissionListResult>;
    listWorkspaces(): Promise<Workspace[]>;
    listProjects(): Promise<ProjectRecord[]>;
    getActiveWorkspace(): Promise<Workspace | null>;
    createWorkspace(name: string): Promise<Workspace>;
    createWorkspaceWithPath(name: string, projectPath: string): Promise<Workspace>;
    createWorkspaceFromFolder(folderPath: string): Promise<Workspace>;
    addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null>;
    removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null>;
    renameProject(args: {
        projectId?: string;
        projectPath?: string;
        name: string;
    }): Promise<{
        ok: boolean;
        error?: string;
        project?: ProjectRecord;
    }>;
    createProjectWorktree(args: {
        projectId?: string;
        projectPath?: string;
        name: string;
        branch?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
        project?: ProjectRecord;
        path?: string;
        branch?: string;
    }>;
    setActiveWorkspace(id: string): Promise<{
        ok: true;
    }>;
    deleteWorkspace(id: string): Promise<{
        ok: true;
    }>;
    listLocalSessions(workspaceId: string): Promise<AggregatedSessionEntry[]>;
    upsertRuntimeSession(workspaceId: string, cardId: string, state: unknown): Promise<{
        ok: boolean;
        summary?: unknown;
        error?: string;
    }>;
    clearRuntimeSession(workspaceId: string, cardId: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    getLocalSessionState(workspaceId: string, sessionEntryId: string): Promise<unknown | null>;
    deleteLocalSession(workspaceId: string, sessionEntryId: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    renameLocalSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{
        ok: boolean;
        error?: string;
        title?: string;
    }>;
    listExternalSessions(workspacePath: string | null, force?: boolean): Promise<AggregatedSessionEntry[]>;
    invalidateExternalSessions(workspacePath: string | null): Promise<{
        ok: boolean;
    }>;
    getExternalSessionState(workspacePath: string | null, sessionEntryId: string): Promise<unknown | null>;
    deleteExternalSession(workspacePath: string | null, sessionEntryId: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    renameExternalSession(workspacePath: string | null, sessionEntryId: string, title: string): Promise<{
        ok: boolean;
        error?: string;
        title?: string;
    }>;
    createCheckpoint(workspaceId: string, sessionEntryId: string, payload: {
        label?: string | null;
        reason?: string | null;
        files?: string[];
        metadata?: Record<string, unknown>;
        source?: string | null;
    }): Promise<{
        ok: boolean;
        checkpoint?: {
            id: string;
        };
        error?: string;
    }>;
    listCheckpoints(workspaceId: string, sessionEntryId: string): Promise<Array<{
        id: string;
        sessionEntryId: string;
        createdAt: string;
        restoredAt?: string | null;
        label: string;
        reason?: string | null;
        fileCount: number;
        files: string[];
    }>>;
    restoreCheckpoint(workspaceId: string, checkpointId: string, sessionEntryId?: string | null): Promise<{
        ok: boolean;
        checkpoint?: {
            id: string;
        };
        filesRestored?: number;
        filesDeleted?: number;
        error?: string;
    }>;
    loadMemoryContext(workspaceId: string, executionTarget?: "local" | "cloud"): Promise<{
        executionTarget: "local" | "cloud";
        includedBuckets: string[];
        sections: Array<{
            scope: string;
            bucket: string;
            displayPath: string;
            path: string;
            importedFrom?: string | null;
            content: string;
        }>;
        prompt?: string;
        contextBuckets?: {
            version: number;
            includedBuckets: string[];
            buckets: Array<{
                bucket: string;
                included: boolean;
                sectionCount: number;
                sections: Array<{
                    scope: string;
                    displayPath: string;
                    importedFrom?: string | null;
                }>;
            }>;
            inspect?: {
                summary?: string;
                input?: string;
            };
        };
    }>;
    getDreamStatus(workspaceId: string): Promise<{
        workspaceId: string;
        running: boolean;
        activeRun: DreamRunSummary | null;
        lastRun: DreamRunSummary | null;
        state: {
            workspaceId: string;
            lastRunId: string | null;
            lastCompletedAt: string | null;
            lastSuccessfulRunId: string | null;
            lastSuccessfulCompletedAt: string | null;
            lastReviewedAt: string | null;
            latestMemoryPath: string | null;
        };
    }>;
    listDreamRuns(workspaceId: string, limit?: number): Promise<{
        workspaceId: string;
        runs: DreamRunSummary[];
    }>;
    runDream(args: {
        workspaceId: string;
        provider?: string;
        model?: string;
        maxSessions?: number;
    }): Promise<{
        started: boolean;
        run: DreamRunSummary;
    }>;
    cancelDream(args: {
        workspaceId: string;
        runId?: string | null;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    listSkills(args?: {
        workspaceId?: string | null;
        workspaceDir?: string | null;
        cardId?: string | null;
    }): Promise<DaemonSkillIndex>;
    getSkill(args: {
        skillId: string;
        workspaceId?: string | null;
        workspaceDir?: string | null;
        cardId?: string | null;
    }): Promise<DaemonSkillEntry | null>;
    installSkill(args: {
        zipPath: string;
        scope?: "global" | "workspace";
        overwrite?: boolean;
        workspaceId?: string | null;
        workspaceDir?: string | null;
        cardId?: string | null;
    }): Promise<{
        ok: boolean;
        scope: "global" | "workspace";
        targetRoot: string;
        installedPath: string;
        skill: DaemonSkillEntry;
    }>;
    expandFileReferences(payload: {
        message: string;
        workspaceId?: string | null;
        cardId?: string | null;
        workspaceDir?: string | null;
        executionTarget?: "local" | "cloud";
        supportedImageMediaTypes?: string[];
    }): Promise<{
        changed: boolean;
        message: string;
        bodyText: string;
        contextText?: string;
        references: Array<{
            source: string;
            displayPath: string;
            byteCount: number;
            truncated: boolean;
            binary?: boolean;
            mediaType?: string;
            resolvedPath?: string;
            device?: string;
            inode?: string;
            mtimeMs?: number;
            ctimeMs?: number;
            ownedTemporary?: boolean;
        }>;
        ownedTemporaryAttachments?: Array<{
            capability: string;
            path: string;
            mediaType?: string;
            displayPath: string;
            byteCount: number;
            device: string;
            inode: string;
            mtimeMs: number;
            ctimeMs: number;
            ownedTemporary: true;
        }>;
        summaryText?: string;
        inputText?: string;
    }>;
    issueAttachmentCapabilities(payload: {
        workspaceId: string;
        cardId: string;
        paths: string[];
        ownedTemporary?: boolean;
    }): Promise<{
        attachments: Array<{
            capability: string;
            displayName: string;
        }>;
    }>;
    inspectAttachmentCapabilities(payload: {
        workspaceId: string;
        cardId: string;
        capabilities: string[];
    }): Promise<{
        hasAttachments: boolean;
    }>;
    getSettings<T = unknown>(): Promise<T>;
    setSettings<T = unknown>(settings: T): Promise<T>;
    getRawSettingsJson(): Promise<{
        path: string;
        content: string;
    }>;
    setRawSettingsJson<T = unknown>(json: string): Promise<{
        ok: boolean;
        error?: string;
        settings?: T;
    }>;
};
