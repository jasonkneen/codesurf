import type { BashService, ChatDispatchOptions, CodesurfPlugin, CommandResolverSpec, CommandSpec, ContextBreakdown, ContextStats, ContributionsService, CustomSubagentInfo, HostEventsService, IconsService, InputService, KernelSinks, ListingCommandSpec, LoopsService, McpService, MentionProviderSpec, ModelProviderSpec, ModelSpec, PluginManifest, PluginsService, PromptCommandSpec, PromptSectionSpec, ScheduleService, SettingSpec, TelegramService, ToastService, ToolSpec, ToolsService, TraceFilter, TraceRecord, UiService } from "@codesurf/plugin-api";
import type { ScreenSpec, StatusIndicatorSpec, ToggleableIndicatorSpec } from "@codesurf/plugin-api/ui";
import { Context, Service } from "@deepseek-ai/cordis";
/**
 * What the host lends to a root. Every field is optional so a test can boot a
 * root with none of them and still exercise plugin lifecycle; the CLI passes
 * adapters over its existing loader/registry/agent services.
 */
export interface HostBindings {
    /**
     * Mirrors a command registration into the host's own registry (the TUI reads
     * that registry, not this one). Returns a disposer that removes it again.
     * Absent in tests, which then assert on `ctx.contributions.listCommands()`.
     */
    registerCommand?: (spec: CommandSpec, manifest: PluginManifest) => () => void;
    registerPromptCommand?: (spec: PromptCommandSpec, manifest: PluginManifest) => () => void;
    registerListingCommand?: (spec: ListingCommandSpec, manifest: PluginManifest) => () => void;
    registerTool?: (spec: ToolSpec, manifest: PluginManifest) => () => void;
    registerSetting?: (spec: SettingSpec, manifest: PluginManifest) => () => void;
    registerPromptSection?: (spec: PromptSectionSpec, manifest: PluginManifest) => () => void;
    registerCommandResolver?: (spec: CommandResolverSpec, manifest: PluginManifest) => () => void;
    registerModelProvider?: (spec: ModelProviderSpec, manifest: PluginManifest) => () => void;
    registerModel?: (spec: ModelSpec, manifest: PluginManifest) => () => void;
    registerMentionProvider?: (spec: MentionProviderSpec, manifest: PluginManifest) => () => void;
    registerScreen?: (spec: ScreenSpec, manifest: PluginManifest) => () => void;
    registerStatusIndicator?: (spec: StatusIndicatorSpec, manifest: PluginManifest) => () => void;
    registerToggleableIndicator?: (spec: ToggleableIndicatorSpec, manifest: PluginManifest) => () => void;
    appendAssistant?: (text: string) => void;
    dispatchPrompt?: (prompt: string, options?: ChatDispatchOptions) => Promise<void>;
    cwd?: () => string;
    getSetting?: <T>(key: string, fallback?: T) => T | undefined;
    setSetting?: <T>(key: string, value: T) => void;
    subscribeSetting?: (key: string, listener: (value: unknown, previous: unknown) => void) => () => void;
    ui?: UiService;
    listCommands?: () => readonly CommandSpec[];
    listDynamicCommands?: () => readonly CommandSpec[];
    sessionId?: () => string | null;
    reconnectSession?: () => Promise<{
        reconnected: boolean;
        message: string;
    }>;
    activeAdapterId?: () => string | null;
    listTraces?: (filter?: TraceFilter) => readonly TraceRecord[];
    setTraceFeedback?: (traceId: string, score: number) => void;
    listCustomSubagents?: () => readonly CustomSubagentInfo[];
    listSettings?: () => readonly SettingSpec[];
    runTask?: (request: unknown, abortSignal?: AbortSignal) => Promise<unknown>;
    onUserInterrupt?: (listener: () => void) => () => void;
    onProcessExit?: (listener: () => void) => () => void;
    runDelegation?: (request: unknown, abortSignal?: AbortSignal) => Promise<unknown>;
    readDelegation?: (id: string) => Promise<unknown>;
    listDelegations?: () => Promise<unknown>;
    tools?: ToolsService;
    toast?: ToastService;
    icons?: IconsService;
    input?: InputService;
    hostEvents?: HostEventsService;
    bindSinks?: (sinks: KernelSinks) => () => void;
    schedule?: ScheduleService;
    loops?: LoopsService;
    telegram?: TelegramService;
    mcp?: McpService;
    bash?: BashService;
    plugins?: PluginsService;
    getContextStats?: () => ContextStats | null;
    getContextBreakdown?: () => ContextBreakdown | null;
    compactContext?: () => Promise<{
        compacted: boolean;
        message: string;
    }>;
}
/**
 * Per-root contribution registry.
 *
 * Registrations are owned twice over: this service's own map (so the root can
 * be inspected and isolation proven) and the host's registry (so the TUI sees
 * them). Both are released by the disposer, which the plugin is expected to
 * hand to `ctx.effect`.
 */
export declare class ContributionsServiceImpl extends Service implements ContributionsService {
    private readonly commands;
    private readonly promptCommands;
    private readonly listingCommands;
    private readonly tools;
    private readonly settings;
    private readonly resolvers;
    private readonly providers;
    private readonly models;
    private readonly mentions;
    private readonly promptSections;
    private readonly bindings;
    /**
     * Manifest of the plugin currently mounting, set by `mountPlugin`.
     *
     * An AsyncLocalStorage rather than a field, because `apply` may register
     * asynchronously. A plain field is restored when `apply` RETURNS, so a
     * registration after an `await` found no manifest, skipped the host mirror
     * and never reached the app — while still handing back a working disposer,
     * which made it look like it had worked. The store follows async
     * continuations, so late registrations are attributed to the right plugin.
     */
    private readonly mounting;
    constructor(ctx: Context, bindings: HostBindings);
    /** @internal — the plugin whose `apply` is currently running, if any. */
    currentManifest(): PluginManifest | null;
    /** @internal — used by `mountPlugin` to attribute registrations. */
    withManifest<T>(manifest: PluginManifest, run: () => T): T;
    /**
     * Shared registration path: record locally, mirror into the host, and return
     * a single-shot disposer that undoes both. Every `register*` is this with a
     * different store and host binding.
     */
    private track;
    registerPromptSection(spec: PromptSectionSpec): () => void;
    registerCommand(spec: CommandSpec): () => void;
    registerPromptCommand(spec: PromptCommandSpec): () => void;
    registerListingCommand(spec: ListingCommandSpec): () => void;
    registerTool(spec: ToolSpec): () => void;
    registerSetting(spec: SettingSpec): () => void;
    registerCommandResolver(spec: CommandResolverSpec): () => void;
    registerModelProvider(spec: ModelProviderSpec): () => void;
    registerMentionProvider(spec: MentionProviderSpec): () => void;
    registerModel(spec: ModelSpec): () => void;
    listCommands(): readonly CommandSpec[];
    listModels(): readonly ModelSpec[];
    listTools(): readonly ToolSpec[];
    listSettings(): readonly SettingSpec[];
}
/**
 * Create a root context with CodeSurf's services provided.
 *
 * The services are constructed directly against the root rather than mounted as
 * plugins so they are available synchronously — `ctx.plugin(ServiceClass)`
 * provides one microtask later, which would make every caller await before it
 * could mount anything.
 */
export declare function createCodesurfRoot(bindings?: HostBindings): Context;
/**
 * Mount a native plugin on a root and return its fiber.
 *
 * Await the fiber to know the plugin is active (or to see `apply` throw);
 * `fiber.dispose()` awaits the plugin's own async cleanup before resolving.
 * The manifest is attributed to every contribution the plugin registers during
 * `apply`, so the host registry can group and label them.
 */
export declare function mountPlugin<Config>(root: Context, plugin: CodesurfPlugin<Config>, config?: Config): import("@deepseek-ai/cordis").Fiber & PromiseLike<import("@deepseek-ai/cordis").Fiber>;
export { Context, Service } from "@deepseek-ai/cordis";
export type { HostBindings as CodesurfHostBindings };
//# sourceMappingURL=index.d.ts.map