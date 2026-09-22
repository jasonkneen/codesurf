import type { Context } from "@deepseek-ai/cordis";
/** Contribution kinds a plugin may declare. Mirrors the V1 capability list. */
export type PluginCapability = "commands" | "tools" | "settings" | "models" | "provider-adapters" | "screens" | "status-indicators" | "mentions";
/**
 * Presentation grouping for plugin browsers. Carried through unchanged from
 * the V1 manifest so `/extensions` keeps its existing sections.
 */
export interface PluginGroupMetadata {
    id: string;
    name: string;
    description?: string;
    order?: number;
}
/**
 * Identity and default state of a native plugin.
 *
 * These fields are compatibility surface: the id is the key of every persisted
 * enable/disable preference and settings bucket, and `enabledByDefault` /
 * `protected` decide what a user sees after an upgrade. A conversion that
 * changes any of them is a breaking change, not a refactor.
 */
export interface PluginManifest {
    /** Stable identifier, e.g. `builtin.commands.context`. Never change it. */
    id: string;
    name: string;
    version: string;
    description?: string;
    /** Protected plugins cannot be disabled by users. */
    protected?: boolean;
    /** Hidden from plugin browsers (internal shims). */
    hidden?: boolean;
    /** Default enabled state when no persisted preference exists. */
    enabledByDefault?: boolean;
    group?: PluginGroupMetadata;
    capabilities: PluginCapability[];
}
/**
 * A key as the host reports it.
 *
 * Mirrors the renderer's parsed-key shape so a plugin need not import the
 * terminal renderer to read keyboard input.
 */
export interface InputKey {
    /** Normalised name, e.g. "space", "return", "a", "f9". */
    name: string;
    /** Raw sequence as received from stdin. */
    sequence: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    /** Alt/option; terminals fold these together. */
    option?: boolean;
    super?: boolean;
}
/** What a command handler is given when the user invokes it. */
export interface CommandInvocation {
    /** Raw argument string after the command name, already trimmed of the name. */
    args: string;
}
/** A slash command contributed by a plugin. */
export interface CommandSpec {
    /** Including the leading slash, e.g. `/context`. */
    name: string;
    description: string;
    /** Shown after the name in the command menu, e.g. `[compact|help]`. */
    argsHint?: string;
    /** Alternate names that dispatch to the same handler. */
    aliases?: string[];
    handler: (invocation: CommandInvocation) => void | Promise<void>;
    /**
     * Slash-menu / command-palette visibility. Omitted or returning `true`
     * shows the command; `false` hides it from the menu WITHOUT affecting
     * typed-input dispatch, which still resolves the name. Consulted on every
     * menu render, so it must be cheap and side-effect free.
     */
    visible?: () => boolean;
}
/**
 * A command whose body is a prompt sent to the model rather than local code.
 * The host expands `$ARGUMENTS`/`$1`-style placeholders before dispatching.
 */
export interface PromptCommandSpec {
    name: string;
    description: string;
    argsHint?: string;
    aliases?: string[];
    hidden?: boolean;
    /** Built at invocation time so the prompt can read the current workspace. */
    buildPrompt: (invocation: CommandInvocation) => string | Promise<string>;
    /**
     * What the transcript shows as the user's message, in place of the expanded
     * prompt. The host also derives the auto-generated session title from it, so
     * a 6KB prompt still reads as `/workflow audit auth`. Defaults to the prompt
     * itself when omitted.
     */
    displayText?: string | ((invocation: CommandInvocation) => string);
}
/**
 * A command that prints a rendered listing into the transcript without
 * invoking the model — `/skills`, `/extensions` and friends.
 */
export interface ListingCommandSpec {
    name: string;
    description: string;
    argsHint?: string;
    aliases?: string[];
    hidden?: boolean;
    render: (invocation: CommandInvocation) => string;
}
/** Agent modes a tool may be restricted to. Matches the host's own union. */
export type AgentMode = "agent" | "plan" | "ask";
/**
 * A tool contributed by a plugin.
 *
 * `tool` is intentionally structural rather than the AI SDK's `Tool` type: the
 * plugin API must not depend on the model SDK. The host validates and adapts it
 * when registering.
 */
export interface ToolSpec {
    name: string;
    description: string;
    label?: string;
    group?: string;
    modes?: AgentMode[];
    tool?: unknown;
}
/** A user-visible setting contributed by a plugin. */
/**
 * Guidance a plugin adds to the system prompt.
 *
 * Registering a tool tells the model the tool EXISTS. It does not tell it that
 * a plugin is installed, or when to prefer its tool over a built-in one the
 * model already knows. This is how a plugin says that in its own words.
 *
 * Sections land in the prompt's stable prefix, so keep the body constant for
 * the life of a session — text that changes between turns re-prefills
 * everything after it.
 */
export interface PromptSectionSpec {
    /** Stable id; also the dedupe key within one plugin. */
    id: string;
    /** Heading, upper-cased in the prompt. */
    title: string;
    /** The guidance itself. */
    body: string;
    /** Lower sorts earlier. Defaults to 500. */
    order?: number;
}
export interface SettingSpec {
    key: string;
    title: string;
    description?: string;
    /** `secret` values are masked by editors and never carry a baked-in default. */
    type: "string" | "boolean" | "number" | "select" | "secret";
    default: string | number | boolean;
    section?: string;
    options?: Array<{
        value: string;
        label: string;
    }>;
    requiresRestart?: boolean;
}
/**
 * Registry of everything a plugin contributes. Each registration returns a
 * disposer; register inside `ctx.effect` so the fiber owns it and unmounting
 * the plugin removes the contribution.
 */
export interface ContributionsService {
    registerCommand(spec: CommandSpec): () => void;
    registerPromptCommand(spec: PromptCommandSpec): () => void;
    registerListingCommand(spec: ListingCommandSpec): () => void;
    registerTool(spec: ToolSpec): () => void;
    registerSetting(spec: SettingSpec): () => void;
    registerPromptSection(spec: PromptSectionSpec): () => void;
    registerCommandResolver(spec: CommandResolverSpec): () => void;
    registerModelProvider(spec: ModelProviderSpec): () => void;
    registerModel(spec: ModelSpec): () => void;
    registerMentionProvider(spec: MentionProviderSpec): () => void;
    /** Commands currently registered on this root, in registration order. */
    listCommands(): readonly CommandSpec[];
    listTools(): readonly ToolSpec[];
    listSettings(): readonly SettingSpec[];
    listModels(): readonly ModelSpec[];
}
/**
 * How a dispatched prompt appears in the transcript. `displayText` is what the
 * user bubble, the generated session title and the queue banner show; without
 * it they render the whole expanded prompt body.
 */
export interface ChatDispatchOptions {
    displayText?: string;
}
/** Writing to, and driving, the active conversation. */
export interface ChatService {
    /** Write an assistant message straight into the transcript, no model turn. */
    appendAssistant(text: string): void;
    /** Send a user-style prompt through the agent, producing a real response. */
    dispatch(prompt: string, options?: ChatDispatchOptions): Promise<void>;
}
/** Workspace facts a plugin needs at invocation time. */
export interface WorkspaceService {
    /** The agent's current directory, which may have drifted from process.cwd(). */
    cwd(): string;
}
/** Reading and writing this plugin's settings. */
export interface SettingsService {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
    set<T = unknown>(key: string, value: T): void;
    subscribe(key: string, listener: (value: unknown, previous: unknown) => void): () => void;
    /**
     * Every setting currently registered on this host, by any plugin. Needed by
     * commands that fan a value out across a family of keys (`/permission`
     * writes every registered `*.permissionMode` select).
     */
    list(): readonly SettingSpec[];
}
/**
 * A resolver that produces commands dynamically — `.claude/commands/*.md`
 * files, user workflows, custom subagents. `resolve` dispatches typed input;
 * `enumerate` (optional) is what makes them visible in the slash menu. The two
 * are independent: a resolver may dispatch without enumerating.
 */
export interface CommandResolverSpec {
    /** Human-readable label for plugin listings. */
    label?: string;
    resolve: (input: string) => {
        command: CommandSpec;
        args: string;
    } | null;
    enumerate?: () => CommandSpec[];
}
/** Host actions a plugin can ask the shell to perform. */
export type HostActionPayload = {
    type: string;
} & Record<string, unknown>;
/** Shell-level affordances: dispatching host actions, reading the viewport. */
export interface UiService {
    action(payload: HostActionPayload): void;
    terminalSize(): {
        columns: number;
        rows: number;
    };
    screens: {
        list(): Array<{
            id: string;
            label?: string;
            pluginId: string;
        }>;
    };
}
/** Reading the commands currently available, including dynamic ones. */
export interface CommandsService {
    list(): readonly CommandSpec[];
    listDynamic(): readonly CommandSpec[];
}
/** Active-session facts. `id()` is null before the host binds a session. */
export interface SessionService {
    id(): string | null;
    /**
     * Drop the active model session so the next turn reconnects. Used after
     * changing something the provider reads only at connect time.
     */
    reconnect(): Promise<{
        reconnected: boolean;
        message: string;
    }>;
}
/** Which model adapter is currently active. */
export interface ModelsService {
    getActiveAdapterId(): string | null;
}
/**
 * One recorded turn. A structural subset of the host's stored trace: the plugin
 * API must not depend on `src/storage`, and rating a turn needs only its
 * identity and score.
 */
export interface TraceRecord {
    traceId: string;
    sessionId: string;
    model: string;
    /** `[0,1]`, or null when the turn has not been rated. */
    feedback: number | null;
}
/** Filter accepted by `TracesService.listTraces`. */
export interface TraceFilter {
    sessionId?: string;
    queryClass?: string;
    /** Only traces with feedback >= this value. */
    minFeedback?: number;
    limit?: number;
}
/**
 * Reading recorded turns and rating them. The score feeds adaptive routing.
 * A host that omits the bindings makes rating a no-op rather than an error.
 */
export interface TracesService {
    /** Most recent first. */
    listTraces(filter?: TraceFilter): readonly TraceRecord[];
    /** Clamped to [0,1] by the host. */
    setFeedback(traceId: string, score: number): void;
}
/**
 * Running work in a child agent.
 *
 * The request and result are deliberately loose: their concrete shapes belong
 * to the agent runtime, which the plugin API must not depend on. A plugin
 * forwards what it was given and reports what came back.
 */
/** One user-defined sub-agent, as configured in the user's settings file. */
export interface CustomSubagentInfo {
    name: string;
    model: string;
    instruction: string;
}
export interface SubagentsService {
    runTask(request: unknown, abortSignal?: AbortSignal): Promise<unknown>;
    /**
     * User-defined sub-agents currently configured. Read per call rather than
     * cached: the settings UI edits them at runtime.
     */
    listCustom(): readonly CustomSubagentInfo[];
    runDelegation(request: unknown, abortSignal?: AbortSignal): Promise<unknown>;
    readDelegation(id: string): Promise<unknown>;
    listDelegations(): Promise<unknown>;
}
/**
 * The result shape every tool returns.
 *
 * Deliberately the common subset, with no index signature: the host's own
 * result type carries richer optional fields (diffs, plans, media) and is
 * assignable to this, which it would not be if an index signature were
 * required. A plugin reads these three and passes the rest through.
 */
export interface ToolOutcome {
    success: boolean;
    output?: string;
    error?: string;
}
/** Execution context handed to a tool body. */
export interface ToolExecutionContext {
    abortSignal?: AbortSignal;
}
/**
 * What the host's hooks decided about one tool invocation.
 *
 * `blocked` is the one a tool must honour: a hook refused the call, and
 * `blockingErrors` says why.
 */
export interface HookOutcome {
    blocked: boolean;
    blockingErrors: Array<{
        command: string;
        stderr: string;
    }>;
    preventContinuation: boolean;
    stopReason?: string;
    additionalContexts: string[];
    decision?: "approve" | "block";
}
/**
 * Tool-lifecycle services.
 *
 * `wrapExecute` is the important one: it runs the host's pre/post/failure hooks
 * around a tool body. A converted tool plugin must keep using it, or user hooks
 * silently stop firing for that tool.
 */
export interface ToolsService {
    setEnabled(toolName: string, enabled: boolean): void;
    isEnabled(toolName: string): boolean;
    /** Run `fn`, converting a throw into a failed ToolOutcome with `label`. */
    safeExecute<T extends ToolOutcome>(opts: {
        label: string;
        fn: () => Promise<T>;
    }): Promise<T | ToolOutcome>;
    /**
     * The raw hook calls, for a tool that drives its own lifecycle rather than
     * wrapping one body. `wrapExecute` is the usual way in; these exist because
     * a long-running shell reports start, finish and failure at points a single
     * wrapper cannot see.
     */
    runPre(toolName: string, input: Record<string, unknown>, sessionId?: string, abortSignal?: AbortSignal): Promise<HookOutcome>;
    runPost(toolName: string, input: Record<string, unknown>, output: Record<string, unknown>, sessionId?: string, abortSignal?: AbortSignal): Promise<HookOutcome>;
    runFailure(toolName: string, input: Record<string, unknown>, error: string, sessionId?: string, abortSignal?: AbortSignal): Promise<HookOutcome>;
    /** Wrap a tool body so the host's hooks run around every invocation. */
    wrapExecute<I>(toolName: string, fn: (input: I, ctx: ToolExecutionContext) => Promise<ToolOutcome>): (input: I, ctx?: ToolExecutionContext) => Promise<ToolOutcome>;
}
/**
 * The glyph shown beside a named thing (a tool chip, the mode label).
 *
 * One resolver is active process-wide, so a plugin that sets one owns the whole
 * surface while mounted; its effect must clear it on disposal or the glyphs
 * outlive the plugin.
 */
export interface IconsService {
    setResolver(resolver: ((name: string) => string | null) | null): void;
}
/**
 * Host lifecycle events — turn started, stopped, failed, and the hook events.
 *
 * Named `hostEvents` on the context because Cordis owns `ctx.events` for its
 * own plugin bus; these are CodeSurf's turn and hook events, not that.
 *
 * The event name is a string and the payload structural: the concrete hook
 * union lives in the host, and a plugin narrows what it needs. Returns a
 * disposer, so register inside `ctx.effect`.
 */
export interface HostEventsService {
    subscribe(event: string, handler: (input: unknown) => void): () => void;
}
/**
 * The prompt input line.
 *
 * `intercept` sees every key before the textarea does; returning true swallows
 * it. It returns a disposer, so register inside `ctx.effect` — an interceptor
 * that outlived its plugin would keep eating keystrokes.
 */
export interface InputService {
    getValue(): string;
    getCursor(): number;
    setValueWithCursor(value: string, cursor: number): void;
    insertText(text: string): void;
    clear(): void;
    isFocused(): boolean;
    intercept(handler: (key: InputKey) => boolean): () => void;
}
/**
 * Transient notifications in the shell.
 *
 * `title` is the line the user reads; `message` is optional detail beneath it.
 * The field names match the host's own toast so nothing is lost in translation.
 */
export interface ToastService {
    show(toast: {
        title: string;
        message?: string;
        style?: "success" | "failure" | "info";
        timeoutMs?: number;
    }): void;
}
/** Enabling and disabling plugins from within a plugin. */
export interface PluginsService {
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
}
export type ProviderTransport = "sdk" | "sse" | "http" | "stdio" | "custom";
export type ProviderConnectionMode = "stateless" | "persistent";
export type ProviderAdapterShape = "provider-family" | "single-model";
/** Whether a session is reused per turn, per conversation, or process-wide. */
export type ProviderSessionStrategy = "per-turn" | "per-conversation" | "singleton";
export type AuthMode = "api-key" | "oauth" | "agent-sdk" | "none";
export type CredentialUserAction = "paste-api-key" | "start-oauth" | "install-cli" | "reauth";
export interface CredentialStatus {
    ok: boolean;
    reason?: string;
    needsUserAction?: CredentialUserAction;
}
export interface ProviderUsageSnapshot {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/** Everything a provider learns when the host asks it to connect. */
export interface ProviderConnectionContext {
    conversationId: string;
    adapterId: string;
    providerId: string;
    modelId?: string;
    settings: SettingsService;
    /** MCP state, for a provider that forwards servers to its backend. */
    mcp?: McpService;
    /**
     * The agent's working directory. A provider that spawns a CLI needs it, and
     * it may differ from `process.cwd()` after the shell has changed directory.
     */
    workspace?: WorkspaceService;
}
/** One event in a provider-owned turn. */
export type ProviderStreamEvent = {
    type: "status";
    status: "connecting" | "ready" | "streaming" | "complete" | "error";
    message?: string;
} | {
    type: "text-delta";
    delta: string;
} | {
    type: "reasoning-delta";
    delta: string;
} | {
    type: "tool-call";
    id: string;
    toolName: string;
    args: unknown;
} | {
    type: "tool-result";
    id: string;
    result: unknown;
    isError?: boolean;
} | {
    type: "usage";
    usage: ProviderUsageSnapshot;
} | {
    type: "error";
    message: string;
    data?: unknown;
} | {
    type: "done";
    stopReason?: string;
} | {
    type: "tool-approval-request";
    approvalId: string;
    toolName: string;
    input: unknown;
} | {
    type: "questionnaire-request";
    title?: string;
    questions: unknown;
};
export interface ProviderStreamController {
    emit: (event: ProviderStreamEvent) => void;
}
export interface ProviderTurnInput {
    conversationId: string;
    providerId: string;
    adapterId: string;
    modelId: string;
    prompt: string;
    messages: readonly unknown[];
    /** The host's assembled ToolSet. `unknown` so this package need not import the model SDK. */
    tools?: unknown;
    abortSignal?: AbortSignal;
    metadata?: Record<string, unknown>;
}
/**
 * A live connection to a backend.
 *
 * Two shapes are supported and a session implements whichever fits: a
 * `getModel` provider hands the host an SDK model and the host drives the turn,
 * while a `sendTurn` provider owns the turn itself and reports progress through
 * the controller. Everything else is lifecycle.
 */
export interface ProviderSession {
    readonly adapterId: string;
    readonly providerId: string;
    readonly mode: ProviderConnectionMode;
    readonly strategy?: ProviderSessionStrategy;
    /** Returns an AI SDK `LanguageModel`; `unknown` keeps the SDK out of this package. */
    getModel?: (modelId: string) => unknown;
    getResponsesModel?: (modelId: string) => unknown;
    getRawProvider?: () => unknown;
    sendTurn?: (input: ProviderTurnInput, controller: ProviderStreamController) => Promise<{
        usage?: ProviderUsageSnapshot;
    }>;
    abortTurn?: () => void | Promise<void>;
    warm?: () => void | Promise<void>;
    respondToToolApproval?: (approvalId: string, approved: boolean) => void;
    /**
     * Release the connection. Must resolve only once the underlying resource is
     * actually gone — a transport that returns after merely signalling a child
     * lets the host tear down while the process is still alive.
     */
    disconnect?: () => void | Promise<void>;
}
export interface ModelProviderAdapter {
    connect: (ctx: ProviderConnectionContext) => ProviderSession | Promise<ProviderSession>;
}
export interface ModelProviderAuth {
    mode: AuthMode;
    check: (ctx: ProviderConnectionContext) => CredentialStatus | Promise<CredentialStatus>;
    startAuth?: (ctx: ProviderConnectionContext) => void | Promise<void>;
}
/** A model a provider exposes. Identity here is user-facing and must stay stable. */
export interface ModelSpec {
    id: string;
    providerId: string;
    adapterId?: string;
    label: string;
    description?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputPrice?: number;
    outputPrice?: number;
    capabilities?: {
        tools?: boolean;
        images?: boolean;
        reasoning?: boolean;
    };
    aliases?: string[];
}
/** A provider adapter contributed by a plugin. */
export interface ModelProviderSpec {
    id: string;
    label: string;
    description?: string;
    providerId: string;
    shape: ProviderAdapterShape;
    transport: ProviderTransport;
    connectionMode: ProviderConnectionMode;
    sessionStrategy?: ProviderSessionStrategy;
    capabilities: {
        streaming: boolean;
        tools?: boolean;
        images?: boolean;
        reasoning?: boolean;
    };
    adapter: ModelProviderAdapter;
    auth: ModelProviderAuth;
    model?: ModelSpec;
    models?: ModelSpec[];
    /** Discovered at connect time, for backends whose catalogue is dynamic. */
    listModels?: (ctx: ProviderConnectionContext) => ModelSpec[] | Promise<ModelSpec[]>;
}
/**
 * An @-mention source: how a plugin resolves what the user typed after `@`.
 *
 * Registering one replaces the host's default file-mention provider, so a
 * plugin that offers richer completion owns the whole surface while it is
 * mounted and the default returns when it unmounts.
 */
export interface MentionProviderSpec {
    match(query: string, maxResults?: number): Promise<string[]>;
    resolvePath(relativePath: string): string;
    expand(text: string, cwd: string): Promise<{
        enhancedMessage: string;
        mentionedFiles: string[];
    }>;
}
/** The shell surface a bash plugin provides and other plugins consume. */
export interface BashService {
    cwd(): string;
    execute(command: string, timeout?: number, abortSignal?: AbortSignal): Promise<ToolOutcome>;
    startBackground(command: string): Promise<ToolOutcome>;
    getProcessLogs(id: number, tail?: number): Promise<ToolOutcome>;
    stopProcess(id: number): Promise<ToolOutcome>;
    listProcesses(): ToolOutcome;
    /**
     * A child shell rooted at `initialCwd`. Sub-agents get their own so a child's
     * `cd` cannot move the parent's working directory.
     */
    spawnChild(initialCwd: string, options?: {
        sandboxMode?: string;
        sandboxSettings?: unknown;
    }): unknown;
    /** Resolves only once owned process trees have actually exited. */
    cleanup(): Promise<void>;
    getSandboxMode(): string;
    setSandboxMode(mode: string): void;
    getSandboxSettings(): unknown;
    setSandboxSettings(settings: unknown): void;
}
/**
 * Singletons a plugin supplies to the host.
 *
 * Each is optional; a plugin binds only what it owns. The returned disposer
 * releases every sink it bound, and only if this binding is still the current
 * owner — a compare-and-release, so a late disposal is a no-op rather than
 * clearing whoever replaced it.
 */
export interface KernelSinks {
    bash?: BashService;
    /** Resolves the MCP tool bundle for the session. */
    mcp?: () => Promise<unknown>;
    icons?: (name: string) => string | null;
}
export interface KernelSinkService {
    bind(sinks: KernelSinks): () => void;
}
/** A scheduled job as stored on disk. */
export interface StoredSchedule {
    id: string;
    name: string;
    instruction: string;
    cron?: string;
    model: string;
    directory: string;
    enabled: boolean;
    maxToolRounds: number;
    lastRunAt?: string;
    createdAt: string;
    updatedAt: string;
}
export interface ScheduleCreateOptions {
    name: string;
    instruction: string;
    cron?: string;
    model?: string;
    directory?: string;
    maxToolRounds?: number;
}
export interface ScheduleDaemonStatus {
    running: boolean;
    pid: number | null;
}
export interface ScheduleCreateResult {
    schedule: StoredSchedule;
    daemonStatus: ScheduleDaemonStatus;
    startedPid: number | null;
}
export interface ScheduleDaemonStartResult {
    status: ScheduleDaemonStatus;
    pid: number | null;
    alreadyRunning: boolean;
}
export interface ScheduleDaemonStopResult {
    status: ScheduleDaemonStatus;
    pid: number | null;
    wasRunning: boolean;
}
/** Creating and running scheduled work. */
export interface ScheduleService {
    create(options: ScheduleCreateOptions): Promise<ScheduleCreateResult>;
    list(): Promise<StoredSchedule[]>;
    remove(id: string): Promise<StoredSchedule | null>;
    readLog(id: string, tail?: number): Promise<string>;
    getDaemonStatus(): Promise<ScheduleDaemonStatus>;
    startDaemon(): Promise<ScheduleDaemonStartResult>;
    stopDaemon(): Promise<ScheduleDaemonStopResult>;
}
/**
 * Closed-loop agent looping.
 *
 * A loop spec is the human-authored standard the loop is held to: the goal,
 * the ordered phases, the verification criteria, and the iteration budget.
 * The host owns durability — specs and running state persist across restarts —
 * so a plugin only reads and drives.
 */
export interface LoopPhaseSpec {
    name: string;
    instructions: string;
    verification?: string;
}
export interface LoopSpec {
    name: string;
    goal: string;
    maxIterations: number;
    closed: boolean;
    phases: LoopPhaseSpec[];
    verificationCriteria: string;
    rules?: string;
    useFleet?: boolean;
    notes?: string;
}
export interface LoopIterationRecord {
    iteration: number;
    startedAt: string;
    status: "in-progress" | "passed" | "failed" | "complete";
    summary?: string;
    verificationNotes?: string;
    tokensUsed?: number;
}
export interface LoopState {
    spec: LoopSpec;
    currentIteration: number;
    status: "idle" | "running" | "complete" | "blocked" | "stopped";
    history: LoopIterationRecord[];
    lastMessage?: string;
    pendingTokens?: number;
}
/** Driving named, spec-governed agent loops. */
export interface LoopsService {
    list(): LoopSpec[];
    get(name: string): LoopState | null;
    start(name: string, maxIterations?: number, goal?: string): {
        started: boolean;
        message: string;
        state: LoopState;
    };
    stop(name?: string): {
        stopped: boolean;
        message: string;
    };
    advance(name: string): Promise<{
        advanced: boolean;
        message: string;
        state?: LoopState;
    }>;
    record(name: string, entry: {
        status: LoopIterationRecord["status"];
        summary?: string;
        verificationNotes?: string;
    }): {
        ok: boolean;
        message: string;
        state?: LoopState;
    };
    setSpec(spec: LoopSpec): {
        ok: boolean;
        message: string;
    };
    getActive(): LoopState | null;
    noteUsage(totalTokens: number): void;
}
/**
 * Model Context Protocol state.
 *
 * A provider that forwards MCP servers to its backend needs to know whether
 * the user has MCP on at all; the bundle itself is a kernel sink.
 */
export interface McpService {
    isEnabled(): boolean;
    getToolBundle(): Promise<unknown>;
}
/** Sending to the paired Telegram chat. */
export interface TelegramService {
    sendFile(filePath: string, abortSignal?: AbortSignal): Promise<ToolOutcome>;
}
/** Context-window accounting for the active session. */
export interface ContextStats {
    usedTokens: number;
    contextWindow: number;
    remainingTokens: number;
    ratioUsed: number;
    ratioRemaining: number;
}
export interface ContextBreakdown extends ContextStats {
    systemTokens: number;
    inFlightTokens: number;
    compactionSummaryTokens: number;
    historyTokens: number;
}
export interface ContextService {
    getStats(): ContextStats | null;
    getBreakdown(): ContextBreakdown | null;
    compact(): Promise<{
        compacted: boolean;
        message: string;
    }>;
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        contributions: ContributionsService;
        chat: ChatService;
        workspace: WorkspaceService;
        settings: SettingsService;
        ui: UiService;
        commands: CommandsService;
        session: SessionService;
        models: ModelsService;
        traces: TracesService;
        subagents: SubagentsService;
        lifecycle: LifecycleService;
        tools: ToolsService;
        toast: ToastService;
        icons: IconsService;
        input: InputService;
        hostEvents: HostEventsService;
        sinks: KernelSinkService;
        schedule: ScheduleService;
        loops: LoopsService;
        telegram: TelegramService;
        mcp: McpService;
        bash: BashService;
        plugins: PluginsService;
        /**
         * Named `contextMeter` rather than `context`: `ctx.context` would read as
         * the Cordis context itself at every call site.
         */
        contextMeter: ContextService;
    }
}
/**
 * Lifecycle signals a plugin can subscribe to. Each returns a disposer; hand it
 * to `ctx.effect` so the subscription dies with the fiber.
 */
export interface LifecycleService {
    /** The user pressed the interrupt key. Distinct from a turn simply ending. */
    onUserInterrupt(listener: () => void): () => void;
    /** The process is exiting. Best-effort, synchronous work only. */
    onProcessExit(listener: () => void): () => void;
}
/** The augmented context a CodeSurf plugin's `apply` receives. */
export type PluginContext = Context;
/**
 * Shape of a native CodeSurf plugin module. Cordis only requires `apply`; the
 * manifest is CodeSurf's own metadata and is read by the host when mounting.
 */
export interface CodesurfPlugin<Config = void> {
    name: string;
    manifest: PluginManifest;
    inject?: string[];
    apply: (ctx: PluginContext, config: Config) => void | Promise<void>;
}
//# sourceMappingURL=index.d.ts.map