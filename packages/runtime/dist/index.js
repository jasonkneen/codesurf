// @codesurf/runtime — Cordis root composition for CodeSurf.
//
// Depends on @codesurf/plugin-api (contracts) and @deepseek-ai/cordis, never on
// the CLI, the TUI, the Agent or any concrete tool. The host supplies its
// capabilities as `HostBindings`; everything a plugin can reach is a service on
// the root, owned per root, so two roots in one process share no state.
import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Service } from "@deepseek-ai/cordis";
/**
 * Per-root contribution registry.
 *
 * Registrations are owned twice over: this service's own map (so the root can
 * be inspected and isolation proven) and the host's registry (so the TUI sees
 * them). Both are released by the disposer, which the plugin is expected to
 * hand to `ctx.effect`.
 */
export class ContributionsServiceImpl extends Service {
    commands = new Map();
    promptCommands = new Map();
    listingCommands = new Map();
    tools = new Map();
    settings = new Map();
    resolvers = new Map();
    providers = new Map();
    models = new Map();
    mentions = new Map();
    promptSections = new Map();
    bindings;
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
    mounting = new AsyncLocalStorage();
    constructor(ctx, bindings) {
        super(ctx, "contributions");
        this.bindings = bindings;
    }
    /** @internal — the plugin whose `apply` is currently running, if any. */
    currentManifest() {
        return this.mounting.getStore() ?? null;
    }
    /** @internal — used by `mountPlugin` to attribute registrations. */
    withManifest(manifest, run) {
        return this.mounting.run(manifest, run);
    }
    /**
     * Shared registration path: record locally, mirror into the host, and return
     * a single-shot disposer that undoes both. Every `register*` is this with a
     * different store and host binding.
     */
    track(store, label, spec, mirror) {
        const key = Symbol(label);
        store.set(key, spec);
        const manifest = this.mounting.getStore() ?? null;
        const releaseHost = manifest && mirror ? mirror(manifest) : undefined;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            store.delete(key);
            releaseHost?.();
        };
    }
    registerPromptSection(spec) {
        return this.track(this.promptSections, spec.id, spec, (manifest) => this.bindings.registerPromptSection?.(spec, manifest) ?? (() => { }));
    }
    registerCommand(spec) {
        return this.track(this.commands, spec.name, spec, (manifest) => this.bindings.registerCommand?.(spec, manifest) ?? (() => { }));
    }
    registerPromptCommand(spec) {
        return this.track(this.promptCommands, spec.name, spec, (manifest) => this.bindings.registerPromptCommand?.(spec, manifest) ?? (() => { }));
    }
    registerListingCommand(spec) {
        return this.track(this.listingCommands, spec.name, spec, (manifest) => this.bindings.registerListingCommand?.(spec, manifest) ?? (() => { }));
    }
    registerTool(spec) {
        return this.track(this.tools, spec.name, spec, (manifest) => this.bindings.registerTool?.(spec, manifest) ?? (() => { }));
    }
    registerSetting(spec) {
        return this.track(this.settings, spec.key, spec, (manifest) => this.bindings.registerSetting?.(spec, manifest) ?? (() => { }));
    }
    registerCommandResolver(spec) {
        return this.track(this.resolvers, spec.label ?? "resolver", spec, (manifest) => this.bindings.registerCommandResolver?.(spec, manifest) ?? (() => { }));
    }
    registerModelProvider(spec) {
        return this.track(this.providers, spec.id, spec, (manifest) => this.bindings.registerModelProvider?.(spec, manifest) ?? (() => { }));
    }
    registerMentionProvider(spec) {
        return this.track(this.mentions, "mentions", spec, (manifest) => this.bindings.registerMentionProvider?.(spec, manifest) ?? (() => { }));
    }
    registerModel(spec) {
        return this.track(this.models, spec.id, spec, (manifest) => this.bindings.registerModel?.(spec, manifest) ?? (() => { }));
    }
    listCommands() {
        return [...this.commands.values()];
    }
    listModels() {
        return [...this.models.values()];
    }
    listTools() {
        return [...this.tools.values()];
    }
    listSettings() {
        return [...this.settings.values()];
    }
}
class ChatServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "chat");
        this.bindings = bindings;
    }
    appendAssistant(text) {
        this.bindings.appendAssistant?.(text);
    }
    async dispatch(prompt, options) {
        await this.bindings.dispatchPrompt?.(prompt, options);
    }
}
class WorkspaceServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "workspace");
        this.bindings = bindings;
    }
    cwd() {
        return this.bindings.cwd?.() ?? process.cwd();
    }
}
class SettingsServiceImpl extends Service {
    bindings;
    /** Fallback store so a root booted without host bindings is still usable. */
    local = new Map();
    constructor(ctx, bindings) {
        super(ctx, "settings");
        this.bindings = bindings;
    }
    get(key, fallback) {
        if (this.bindings.getSetting)
            return this.bindings.getSetting(key, fallback);
        return this.local.has(key) ? this.local.get(key) : fallback;
    }
    set(key, value) {
        if (this.bindings.setSetting) {
            this.bindings.setSetting(key, value);
            return;
        }
        this.local.set(key, value);
    }
    subscribe(key, listener) {
        return this.bindings.subscribeSetting?.(key, listener) ?? (() => { });
    }
    list() {
        return this.bindings.listSettings?.() ?? [];
    }
}
class ContextServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "contextMeter");
        this.bindings = bindings;
    }
    getStats() {
        return this.bindings.getContextStats?.() ?? null;
    }
    getBreakdown() {
        return this.bindings.getContextBreakdown?.() ?? null;
    }
    async compact() {
        if (!this.bindings.compactContext) {
            return { compacted: false, message: "Compaction is not available in this host." };
        }
        return this.bindings.compactContext();
    }
}
/** Shell affordances. Inert when the host lends none (headless tests). */
class UiServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "ui");
        this.bindings = bindings;
    }
    action(payload) {
        this.bindings.ui?.action(payload);
    }
    terminalSize() {
        return this.bindings.ui?.terminalSize() ?? { columns: 80, rows: 24 };
    }
    get screens() {
        return this.bindings.ui?.screens ?? { list: () => [] };
    }
}
class CommandsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "commands");
        this.bindings = bindings;
    }
    list() {
        return this.bindings.listCommands?.() ?? [];
    }
    listDynamic() {
        return this.bindings.listDynamicCommands?.() ?? [];
    }
}
class SessionServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "session");
        this.bindings = bindings;
    }
    id() {
        return this.bindings.sessionId?.() ?? null;
    }
    async reconnect() {
        return (this.bindings.reconnectSession?.() ?? {
            reconnected: false,
            message: "Session reconnect is not available in this host.",
        });
    }
}
class ModelsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "models");
        this.bindings = bindings;
    }
    getActiveAdapterId() {
        return this.bindings.activeAdapterId?.() ?? null;
    }
}
class SubagentsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "subagents");
        this.bindings = bindings;
    }
    async runTask(request, abortSignal) {
        if (!this.bindings.runTask)
            throw new Error("Sub-agent execution is not available in this host.");
        return this.bindings.runTask(request, abortSignal);
    }
    listCustom() {
        return this.bindings.listCustomSubagents?.() ?? [];
    }
    async runDelegation(request, abortSignal) {
        if (!this.bindings.runDelegation)
            throw new Error("Delegation is not available in this host.");
        return this.bindings.runDelegation(request, abortSignal);
    }
    async readDelegation(id) {
        if (!this.bindings.readDelegation)
            throw new Error("Delegation is not available in this host.");
        return this.bindings.readDelegation(id);
    }
    async listDelegations() {
        if (!this.bindings.listDelegations)
            throw new Error("Delegation is not available in this host.");
        return this.bindings.listDelegations();
    }
}
class TracesServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "traces");
        this.bindings = bindings;
    }
    listTraces(filter) {
        return this.bindings.listTraces?.(filter) ?? [];
    }
    setFeedback(traceId, score) {
        this.bindings.setTraceFeedback?.(traceId, score);
    }
}
/**
 * Rendering registrations.
 *
 * Provided unconditionally so a plugin can register a screen without the host
 * having to know in advance whether one will; a headless host simply lends no
 * bindings and the registrations become inert.
 */
class ScreensServiceImpl extends Service {
    bindings;
    /** Manifest of the plugin currently mounting, shared with contributions. */
    owner;
    constructor(ctx, bindings, owner) {
        super(ctx, "screens");
        this.bindings = bindings;
        this.owner = owner;
    }
    attribute(mirror) {
        const manifest = this.owner();
        const release = manifest ? mirror(manifest) : undefined;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            release?.();
        };
    }
    registerScreen(spec) {
        return this.attribute((manifest) => this.bindings.registerScreen?.(spec, manifest));
    }
    registerStatusIndicator(spec) {
        return this.attribute((manifest) => this.bindings.registerStatusIndicator?.(spec, manifest));
    }
    registerToggleableIndicator(spec) {
        return this.attribute((manifest) => this.bindings.registerToggleableIndicator?.(spec, manifest));
    }
}
/**
 * Tool lifecycle. Without host bindings `wrapExecute` runs the body directly,
 * so a plugin under test behaves the same minus the host's hooks.
 */
class ToolsServiceImpl extends Service {
    bindings;
    disabled = new Set();
    constructor(ctx, bindings) {
        super(ctx, "tools");
        this.bindings = bindings;
    }
    setEnabled(toolName, enabled) {
        if (this.bindings.tools) {
            this.bindings.tools.setEnabled(toolName, enabled);
            return;
        }
        if (enabled)
            this.disabled.delete(toolName);
        else
            this.disabled.add(toolName);
    }
    isEnabled(toolName) {
        return this.bindings.tools?.isEnabled(toolName) ?? !this.disabled.has(toolName);
    }
    async safeExecute(opts) {
        if (this.bindings.tools)
            return this.bindings.tools.safeExecute(opts);
        try {
            return await opts.fn();
        }
        catch (err) {
            return { success: false, error: `${opts.label} failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    runPre(toolName, input, sessionId, abortSignal) {
        return requireBinding(this.bindings.tools, "tools").runPre(toolName, input, sessionId, abortSignal);
    }
    runPost(toolName, input, output, sessionId, abortSignal) {
        return requireBinding(this.bindings.tools, "tools").runPost(toolName, input, output, sessionId, abortSignal);
    }
    runFailure(toolName, input, error, sessionId, abortSignal) {
        return requireBinding(this.bindings.tools, "tools").runFailure(toolName, input, error, sessionId, abortSignal);
    }
    wrapExecute(toolName, fn) {
        if (this.bindings.tools)
            return this.bindings.tools.wrapExecute(toolName, fn);
        return (input, ctx) => fn(input, ctx ?? {});
    }
}
class ToastServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "toast");
        this.bindings = bindings;
    }
    show(toast) {
        this.bindings.toast?.show(toast);
    }
}
class HostEventsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "hostEvents");
        this.bindings = bindings;
    }
    subscribe(event, handler) {
        return this.bindings.hostEvents?.subscribe(event, handler) ?? (() => { });
    }
}
class InputServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "input");
        this.bindings = bindings;
    }
    getValue() {
        return this.bindings.input?.getValue() ?? "";
    }
    getCursor() {
        return this.bindings.input?.getCursor() ?? 0;
    }
    setValueWithCursor(value, cursor) {
        this.bindings.input?.setValueWithCursor(value, cursor);
    }
    insertText(text) {
        this.bindings.input?.insertText(text);
    }
    clear() {
        this.bindings.input?.clear();
    }
    isFocused() {
        return this.bindings.input?.isFocused() ?? false;
    }
    intercept(handler) {
        return this.bindings.input?.intercept(handler) ?? (() => { });
    }
}
class IconsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "icons");
        this.bindings = bindings;
    }
    setResolver(resolver) {
        this.bindings.icons?.setResolver(resolver);
    }
}
/**
 * Handing host-owned singletons to the host.
 *
 * Binding returns a disposer; the host's own binding is expected to
 * compare-and-release, so a plugin disposed after a replacement took over
 * cannot clear the newer owner.
 */
class KernelSinkServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "sinks");
        this.bindings = bindings;
    }
    bind(sinks) {
        return this.bindings.bindSinks?.(sinks) ?? (() => { });
    }
}
/** Delegating service: throws only when the host lends no implementation. */
function requireBinding(value, name) {
    if (!value)
        throw new Error(`The ${name} service is not available in this host.`);
    return value;
}
class ScheduleServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "schedule");
        this.bindings = bindings;
    }
    get host() {
        return requireBinding(this.bindings.schedule, "schedule");
    }
    create(options) {
        return this.host.create(options);
    }
    list() {
        return this.host.list();
    }
    remove(id) {
        return this.host.remove(id);
    }
    readLog(id, tail) {
        return this.host.readLog(id, tail);
    }
    getDaemonStatus() {
        return this.host.getDaemonStatus();
    }
    startDaemon() {
        return this.host.startDaemon();
    }
    stopDaemon() {
        return this.host.stopDaemon();
    }
}
class LoopsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "loops");
        this.bindings = bindings;
    }
    get host() {
        return requireBinding(this.bindings.loops, "loops");
    }
    list() {
        return this.host.list();
    }
    get(name) {
        return this.host.get(name);
    }
    start(name, maxIterations, goal) {
        return this.host.start(name, maxIterations, goal);
    }
    stop(name) {
        return this.host.stop(name);
    }
    advance(name) {
        return this.host.advance(name);
    }
    record(name, entry) {
        return this.host.record(name, entry);
    }
    setSpec(spec) {
        return this.host.setSpec(spec);
    }
    getActive() {
        return this.host.getActive();
    }
    noteUsage(totalTokens) {
        this.host.noteUsage(totalTokens);
    }
}
class McpServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "mcp");
        this.bindings = bindings;
    }
    isEnabled() {
        return this.bindings.mcp?.isEnabled() ?? false;
    }
    getToolBundle() {
        return requireBinding(this.bindings.mcp, "mcp").getToolBundle();
    }
}
class TelegramServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "telegram");
        this.bindings = bindings;
    }
    sendFile(filePath, abortSignal) {
        return requireBinding(this.bindings.telegram, "telegram").sendFile(filePath, abortSignal);
    }
}
/**
 * The shell, as other plugins consume it.
 *
 * Reads the binding per call rather than caching: the bash plugin can be
 * disabled and re-enabled, and a cached reference would keep addressing the
 * torn-down instance.
 */
class BashServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "bash");
        this.bindings = bindings;
    }
    get host() {
        return requireBinding(this.bindings.bash, "bash");
    }
    cwd() {
        return this.host.cwd();
    }
    execute(command, timeout, abortSignal) {
        return this.host.execute(command, timeout, abortSignal);
    }
    startBackground(command) {
        return this.host.startBackground(command);
    }
    getProcessLogs(id, tail) {
        return this.host.getProcessLogs(id, tail);
    }
    stopProcess(id) {
        return this.host.stopProcess(id);
    }
    listProcesses() {
        return this.host.listProcesses();
    }
    spawnChild(initialCwd, options) {
        return this.host.spawnChild(initialCwd, options);
    }
    cleanup() {
        return this.host.cleanup();
    }
    getSandboxMode() {
        return this.host.getSandboxMode();
    }
    setSandboxMode(mode) {
        this.host.setSandboxMode(mode);
    }
    getSandboxSettings() {
        return this.host.getSandboxSettings();
    }
    setSandboxSettings(settings) {
        this.host.setSandboxSettings(settings);
    }
}
class PluginsServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "plugins");
        this.bindings = bindings;
    }
    async enable(id) {
        await this.bindings.plugins?.enable(id);
    }
    async disable(id) {
        await this.bindings.plugins?.disable(id);
    }
}
class LifecycleServiceImpl extends Service {
    bindings;
    constructor(ctx, bindings) {
        super(ctx, "lifecycle");
        this.bindings = bindings;
    }
    onUserInterrupt(listener) {
        return this.bindings.onUserInterrupt?.(listener) ?? (() => { });
    }
    onProcessExit(listener) {
        return this.bindings.onProcessExit?.(listener) ?? (() => { });
    }
}
/**
 * Create a root context with CodeSurf's services provided.
 *
 * The services are constructed directly against the root rather than mounted as
 * plugins so they are available synchronously — `ctx.plugin(ServiceClass)`
 * provides one microtask later, which would make every caller await before it
 * could mount anything.
 */
export function createCodesurfRoot(bindings = {}) {
    const root = new Context();
    const contributions = new ContributionsServiceImpl(root, bindings);
    new ScreensServiceImpl(root, bindings, () => contributions.currentManifest());
    new ChatServiceImpl(root, bindings);
    new WorkspaceServiceImpl(root, bindings);
    new SettingsServiceImpl(root, bindings);
    new ContextServiceImpl(root, bindings);
    new UiServiceImpl(root, bindings);
    new CommandsServiceImpl(root, bindings);
    new SessionServiceImpl(root, bindings);
    new ModelsServiceImpl(root, bindings);
    new TracesServiceImpl(root, bindings);
    new SubagentsServiceImpl(root, bindings);
    new LifecycleServiceImpl(root, bindings);
    new ToolsServiceImpl(root, bindings);
    new ToastServiceImpl(root, bindings);
    new IconsServiceImpl(root, bindings);
    new InputServiceImpl(root, bindings);
    new HostEventsServiceImpl(root, bindings);
    new PluginsServiceImpl(root, bindings);
    new KernelSinkServiceImpl(root, bindings);
    new ScheduleServiceImpl(root, bindings);
    new LoopsServiceImpl(root, bindings);
    new TelegramServiceImpl(root, bindings);
    new McpServiceImpl(root, bindings);
    new BashServiceImpl(root, bindings);
    return root;
}
/**
 * Mount a native plugin on a root and return its fiber.
 *
 * Await the fiber to know the plugin is active (or to see `apply` throw);
 * `fiber.dispose()` awaits the plugin's own async cleanup before resolving.
 * The manifest is attributed to every contribution the plugin registers during
 * `apply`, so the host registry can group and label them.
 */
export function mountPlugin(root, plugin, config) {
    const contributions = root.get("contributions");
    const apply = plugin.apply;
    const wrapped = {
        name: plugin.name,
        inject: plugin.inject,
        apply: (ctx, resolved) => contributions ? contributions.withManifest(plugin.manifest, () => apply(ctx, resolved)) : apply(ctx, resolved),
    };
    return root.plugin(wrapped, config);
}
export { Context, Service } from "@deepseek-ai/cordis";
//# sourceMappingURL=index.js.map