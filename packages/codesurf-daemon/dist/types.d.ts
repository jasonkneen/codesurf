/**
 * Wire types for the codesurfd HTTP API. These match the shapes the daemon
 * actually serializes; they are the canonical definitions. Hosts may extend or
 * re-export them as needed.
 */
export interface Workspace {
    id: string;
    name: string;
    /** Primary project folder for legacy callers. */
    path: string;
    /** All project folders attached to this workspace/canvas tab. */
    projectPaths?: string[];
}
export interface ProjectRecord {
    id: string;
    name: string;
    path: string;
}
export type ExecutionHostType = 'runtime' | 'local-daemon' | 'remote-daemon';
export interface ExecutionHostRecord {
    id: string;
    type: ExecutionHostType;
    label: string;
    enabled: boolean;
    url?: string | null;
    authToken?: string | null;
}
export type SessionSource = 'codesurf' | 'claude' | 'codex' | 'cursor' | 'hermes' | 'openclaw' | 'opencode';
export type SessionScope = 'workspace' | 'project' | 'user';
export interface AggregatedSessionEntry {
    id: string;
    source: SessionSource;
    scope: SessionScope;
    tileId: string | null;
    sessionId: string | null;
    provider: string;
    model: string;
    messageCount: number;
    lastMessage: string | null;
    updatedAt: number;
    sizeBytes?: number;
    filePath?: string;
    title: string;
    projectPath?: string | null;
    sourceLabel: string;
    sourceDetail?: string;
    checkpointCount?: number;
    isArchived?: boolean;
    canOpenInChat?: boolean;
    canOpenInApp?: boolean;
    resumeBin?: string;
    resumeArgs?: string[];
    relatedGroupId?: string | null;
    nestingLevel?: number;
}
export interface DreamRunSummary {
    id: string;
    workspaceId: string;
    workspaceName: string | null;
    workspaceDir: string;
    provider: string;
    model: string;
    status: string;
    requestedAt: string;
    startedAt: string;
    completedAt: string | null;
    sessionsReviewed: number;
    reviewedSessionIds: string[];
    latestSessionUpdatedAt: string | null;
    outputPath: string | null;
    artifactPath: string | null;
    summary: string | null;
    promptPreview: string | null;
    error: string | null;
}
export interface AutoDreamSettings {
    enabled: boolean;
    minSessions: number;
    minIntervalMs: number;
    debounceMs: number;
    sweepMs: number;
}
export interface AutoDreamPolicySummary extends AutoDreamSettings {
    pending: boolean;
}
export interface DashboardDreamingSummary {
    workspaceId: string;
    workspaceName: string | null;
    workspaceDir: string | null;
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
    } | null;
    auto: AutoDreamPolicySummary | null;
}
export interface DaemonSkillEntry {
    id: string;
    name: string;
    description: string;
    scope: 'global' | 'workspace' | 'command';
    kind: 'skill' | 'command';
    rootKind: string;
    path: string;
    displayPath: string;
    sourcePath: string;
    content?: string;
}
export interface DaemonSkillRoot {
    id: string;
    path: string;
    displayPath: string;
    scope: 'global' | 'workspace';
    kind: string;
    label: string;
    exists: boolean;
    sourceType: 'directory' | 'file';
}
export interface DaemonSkillSelection {
    enabledIds: string[];
    disabledIds: string[];
    resolved: DaemonSkillEntry[];
    unresolvedIds: string[];
    summary?: string;
    prompt?: string;
}
export interface DaemonSkillSkippedLocation {
    path: string;
    code: string;
}
export interface DaemonSkillIndex {
    workspaceDir: string | null;
    roots: DaemonSkillRoot[];
    skills: DaemonSkillEntry[];
    skippedLocations: DaemonSkillSkippedLocation[];
    selection: DaemonSkillSelection;
}
export type DaemonToolPermissionScope = 'session' | 'today' | 'forever' | 'never';
export interface DaemonToolPermissionGrant {
    id: string;
    provider: string;
    toolName: string;
    action: 'allow' | 'deny';
    scope: DaemonToolPermissionScope;
    workspaceDir: string | null;
    title?: string | null;
    description?: string | null;
    blockedPath?: string | null;
    createdAt: string;
    expiresAt?: string | null;
}
export interface DaemonToolPermissionRequest {
    provider: string;
    toolName: string;
    workspaceDir?: string | null;
    title?: string | null;
    description?: string | null;
    blockedPath?: string | null;
}
export interface DaemonToolPermissionListResult {
    path: string;
    grants: DaemonToolPermissionGrant[];
}
export type DaemonChatJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
export type DaemonToolPermissionDecision = 'deny' | 'never' | 'once' | 'session' | 'today' | 'forever';
export interface DaemonChatMessage {
    role: string;
    content: unknown;
    [key: string]: unknown;
}
export interface DaemonPersonaBinding {
    provider?: string;
    model?: string;
}
/**
 * A Persona (a.k.a. agent) as returned by the read-only `/personas/list` route:
 * built-ins + the workspace's agents.json overlay. The on-disk store and the
 * request/wire field are still named `agentMode`/`agents.json` for back-compat.
 */
export interface DaemonPersona {
    id: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    tools?: string[] | null;
    icon?: string;
    color?: string;
    isBuiltin?: boolean;
    extends?: string;
    defaultBinding?: DaemonPersonaBinding;
    [key: string]: unknown;
}
export interface DaemonPersonaListResult {
    personas: DaemonPersona[];
}
export interface DaemonChatJobRequest {
    provider: string;
    model?: string | null;
    mode?: string | null;
    runMode?: 'foreground' | 'background' | string | null;
    workspaceId?: string | null;
    workspaceDir?: string | null;
    cardId?: string | null;
    sessionId?: string | null;
    /**
     * Selected Persona id. The daemon resolves its tools/permissions
     * authoritatively from trusted local sources — callers must NOT send a trusted
     * `agentMode` payload alongside it (the CLI sends agentId ONLY).
     */
    agentId?: string | null;
    messages?: DaemonChatMessage[];
    /**
     * D1: client-supplied idempotency key for job start. A retry after an
     * unknown outcome (lost response, timeout) should reuse the same value so
     * the daemon coalesces onto the job the first attempt created instead of
     * executing the prompt twice. `createDaemonClient().startChatJob` generates
     * one automatically when the caller does not supply it.
     */
    startRequestId?: string | null;
    [key: string]: unknown;
}
export interface DaemonChatJobState {
    id: string;
    taskLabel: string | null;
    status: DaemonChatJobStatus;
    provider: string | null;
    model: string | null;
    mode?: string | null;
    runMode?: string | null;
    workspaceId?: string | null;
    cardId?: string | null;
    workspaceDir: string | null;
    requestedAt: string | null;
    updatedAt: string | null;
    completedAt?: string | null;
    lastSequence: number;
    sessionId?: string | null;
    initialPrompt?: string | null;
    error: string | null;
}
export interface DaemonChatJobEvent {
    jobId: string;
    sequence: number;
    timestamp: number;
    type: string;
    sessionId?: string | null;
    text?: string;
    error?: string;
    toolId?: string | null;
    toolName?: string | null;
    title?: string | null;
    description?: string | null;
    blockedPath?: string | null;
    workspaceDir?: string | null;
    provider?: string | null;
    [key: string]: unknown;
}
export interface DaemonChatPermissionAnswer {
    jobId: string;
    toolId: string;
    decision: DaemonToolPermissionDecision;
}
/**
 * AppSettings is host-specific (the daemon stores opaque JSON). Use `unknown`
 * here and re-cast in the host adapter. See collaborator-clone's
 * `src/shared/types.ts` for the desktop's full schema.
 */
export type DaemonAppSettings = unknown;
