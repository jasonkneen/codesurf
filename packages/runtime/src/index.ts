// @codesurf/runtime — Cordis root composition for CodeSurf.
//
// Depends on @codesurf/plugin-api (contracts) and @deepseek-ai/cordis, never on
// the CLI, the TUI, the Agent or any concrete tool. The host supplies its
// capabilities as `HostBindings`; everything a plugin can reach is a service on
// the root, owned per root, so two roots in one process share no state.

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  BashService,
  ChatDispatchOptions,
  ChatService,
  CodesurfPlugin,
  CommandResolverSpec,
  CommandSpec,
  CommandsService,
  ContextBreakdown,
  ContextService,
  ContextStats,
  ContributionsService,
  CustomSubagentInfo,
  HostEventsService,
  IconsService,
  InputService,
  KernelSinkService,
  KernelSinks,
  LifecycleService,
  ListingCommandSpec,
  LoopIterationRecord,
  LoopSpec,
  LoopsService,
  McpService,
  MentionProviderSpec,
  ModelProviderSpec,
  ModelSpec,
  ModelsService,
  PluginManifest,
  PluginsService,
  PromptCommandSpec,
  PromptSectionSpec,
  ScheduleCreateOptions,
  ScheduleService,
  SessionService,
  SettingSpec,
  SettingsService,
  SubagentsService,
  TelegramService,
  ToastService,
  ToolOutcome,
  ToolSpec,
  ToolsService,
  TraceFilter,
  TraceRecord,
  TracesService,
  UiService,
  WorkspaceService,
} from "@codesurf/plugin-api";
import type { ScreenSpec, ScreensService, StatusIndicatorSpec, ToggleableIndicatorSpec } from "@codesurf/plugin-api/ui";
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
  reconnectSession?: () => Promise<{ reconnected: boolean; message: string }>;
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
  compactContext?: () => Promise<{ compacted: boolean; message: string }>;
}

/**
 * Per-root contribution registry.
 *
 * Registrations are owned twice over: this service's own map (so the root can
 * be inspected and isolation proven) and the host's registry (so the TUI sees
 * them). Both are released by the disposer, which the plugin is expected to
 * hand to `ctx.effect`.
 */
export class ContributionsServiceImpl extends Service implements ContributionsService {
  private readonly commands = new Map<symbol, CommandSpec>();
  private readonly promptCommands = new Map<symbol, PromptCommandSpec>();
  private readonly listingCommands = new Map<symbol, ListingCommandSpec>();
  private readonly tools = new Map<symbol, ToolSpec>();
  private readonly settings = new Map<symbol, SettingSpec>();
  private readonly resolvers = new Map<symbol, CommandResolverSpec>();
  private readonly providers = new Map<symbol, ModelProviderSpec>();
  private readonly models = new Map<symbol, ModelSpec>();
  private readonly mentions = new Map<symbol, MentionProviderSpec>();
  private readonly promptSections = new Map<symbol, PromptSectionSpec>();
  private readonly bindings: HostBindings;
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
  private readonly mounting = new AsyncLocalStorage<PluginManifest>();

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "contributions");
    this.bindings = bindings;
  }

  /** @internal — the plugin whose `apply` is currently running, if any. */
  currentManifest(): PluginManifest | null {
    return this.mounting.getStore() ?? null;
  }

  /** @internal — used by `mountPlugin` to attribute registrations. */
  withManifest<T>(manifest: PluginManifest, run: () => T): T {
    return this.mounting.run(manifest, run);
  }

  /**
   * Shared registration path: record locally, mirror into the host, and return
   * a single-shot disposer that undoes both. Every `register*` is this with a
   * different store and host binding.
   */
  private track<T>(store: Map<symbol, T>, label: string, spec: T, mirror?: (manifest: PluginManifest) => () => void) {
    const key = Symbol(label);
    store.set(key, spec);
    const manifest = this.mounting.getStore() ?? null;
    const releaseHost = manifest && mirror ? mirror(manifest) : undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      store.delete(key);
      releaseHost?.();
    };
  }

  registerPromptSection(spec: PromptSectionSpec): () => void {
    return this.track(
      this.promptSections,
      spec.id,
      spec,
      (manifest) => this.bindings.registerPromptSection?.(spec, manifest) ?? (() => {}),
    );
  }

  registerCommand(spec: CommandSpec): () => void {
    return this.track(
      this.commands,
      spec.name,
      spec,
      (manifest) => this.bindings.registerCommand?.(spec, manifest) ?? (() => {}),
    );
  }

  registerPromptCommand(spec: PromptCommandSpec): () => void {
    return this.track(
      this.promptCommands,
      spec.name,
      spec,
      (manifest) => this.bindings.registerPromptCommand?.(spec, manifest) ?? (() => {}),
    );
  }

  registerListingCommand(spec: ListingCommandSpec): () => void {
    return this.track(
      this.listingCommands,
      spec.name,
      spec,
      (manifest) => this.bindings.registerListingCommand?.(spec, manifest) ?? (() => {}),
    );
  }

  registerTool(spec: ToolSpec): () => void {
    return this.track(
      this.tools,
      spec.name,
      spec,
      (manifest) => this.bindings.registerTool?.(spec, manifest) ?? (() => {}),
    );
  }

  registerSetting(spec: SettingSpec): () => void {
    return this.track(
      this.settings,
      spec.key,
      spec,
      (manifest) => this.bindings.registerSetting?.(spec, manifest) ?? (() => {}),
    );
  }

  registerCommandResolver(spec: CommandResolverSpec): () => void {
    return this.track(
      this.resolvers,
      spec.label ?? "resolver",
      spec,
      (manifest) => this.bindings.registerCommandResolver?.(spec, manifest) ?? (() => {}),
    );
  }

  registerModelProvider(spec: ModelProviderSpec): () => void {
    return this.track(
      this.providers,
      spec.id,
      spec,
      (manifest) => this.bindings.registerModelProvider?.(spec, manifest) ?? (() => {}),
    );
  }

  registerMentionProvider(spec: MentionProviderSpec): () => void {
    return this.track(
      this.mentions,
      "mentions",
      spec,
      (manifest) => this.bindings.registerMentionProvider?.(spec, manifest) ?? (() => {}),
    );
  }

  registerModel(spec: ModelSpec): () => void {
    return this.track(
      this.models,
      spec.id,
      spec,
      (manifest) => this.bindings.registerModel?.(spec, manifest) ?? (() => {}),
    );
  }

  listCommands(): readonly CommandSpec[] {
    return [...this.commands.values()];
  }

  listModels(): readonly ModelSpec[] {
    return [...this.models.values()];
  }

  listTools(): readonly ToolSpec[] {
    return [...this.tools.values()];
  }

  listSettings(): readonly SettingSpec[] {
    return [...this.settings.values()];
  }
}

class ChatServiceImpl extends Service implements ChatService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "chat");
    this.bindings = bindings;
  }

  appendAssistant(text: string): void {
    this.bindings.appendAssistant?.(text);
  }

  async dispatch(prompt: string, options?: ChatDispatchOptions): Promise<void> {
    await this.bindings.dispatchPrompt?.(prompt, options);
  }
}

class WorkspaceServiceImpl extends Service implements WorkspaceService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "workspace");
    this.bindings = bindings;
  }

  cwd(): string {
    return this.bindings.cwd?.() ?? process.cwd();
  }
}

class SettingsServiceImpl extends Service implements SettingsService {
  private readonly bindings: HostBindings;
  /** Fallback store so a root booted without host bindings is still usable. */
  private readonly local = new Map<string, unknown>();

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "settings");
    this.bindings = bindings;
  }

  get<T = unknown>(key: string, fallback?: T): T | undefined {
    if (this.bindings.getSetting) return this.bindings.getSetting<T>(key, fallback);
    return this.local.has(key) ? (this.local.get(key) as T) : fallback;
  }

  set<T = unknown>(key: string, value: T): void {
    if (this.bindings.setSetting) {
      this.bindings.setSetting<T>(key, value);
      return;
    }
    this.local.set(key, value);
  }

  subscribe(key: string, listener: (value: unknown, previous: unknown) => void): () => void {
    return this.bindings.subscribeSetting?.(key, listener) ?? (() => {});
  }

  list(): readonly SettingSpec[] {
    return this.bindings.listSettings?.() ?? [];
  }
}

class ContextServiceImpl extends Service implements ContextService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "contextMeter");
    this.bindings = bindings;
  }

  getStats(): ContextStats | null {
    return this.bindings.getContextStats?.() ?? null;
  }

  getBreakdown(): ContextBreakdown | null {
    return this.bindings.getContextBreakdown?.() ?? null;
  }

  async compact(): Promise<{ compacted: boolean; message: string }> {
    if (!this.bindings.compactContext) {
      return { compacted: false, message: "Compaction is not available in this host." };
    }
    return this.bindings.compactContext();
  }
}

/** Shell affordances. Inert when the host lends none (headless tests). */
class UiServiceImpl extends Service implements UiService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "ui");
    this.bindings = bindings;
  }

  action(payload: Parameters<UiService["action"]>[0]): void {
    this.bindings.ui?.action(payload);
  }

  terminalSize(): { columns: number; rows: number } {
    return this.bindings.ui?.terminalSize() ?? { columns: 80, rows: 24 };
  }

  get screens() {
    return this.bindings.ui?.screens ?? { list: () => [] };
  }
}

class CommandsServiceImpl extends Service implements CommandsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "commands");
    this.bindings = bindings;
  }

  list(): readonly CommandSpec[] {
    return this.bindings.listCommands?.() ?? [];
  }

  listDynamic(): readonly CommandSpec[] {
    return this.bindings.listDynamicCommands?.() ?? [];
  }
}

class SessionServiceImpl extends Service implements SessionService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "session");
    this.bindings = bindings;
  }

  id(): string | null {
    return this.bindings.sessionId?.() ?? null;
  }

  async reconnect(): Promise<{ reconnected: boolean; message: string }> {
    return (
      this.bindings.reconnectSession?.() ?? {
        reconnected: false,
        message: "Session reconnect is not available in this host.",
      }
    );
  }
}

class ModelsServiceImpl extends Service implements ModelsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "models");
    this.bindings = bindings;
  }

  getActiveAdapterId(): string | null {
    return this.bindings.activeAdapterId?.() ?? null;
  }
}

class SubagentsServiceImpl extends Service implements SubagentsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "subagents");
    this.bindings = bindings;
  }

  async runTask(request: unknown, abortSignal?: AbortSignal): Promise<unknown> {
    if (!this.bindings.runTask) throw new Error("Sub-agent execution is not available in this host.");
    return this.bindings.runTask(request, abortSignal);
  }

  listCustom(): readonly CustomSubagentInfo[] {
    return this.bindings.listCustomSubagents?.() ?? [];
  }

  async runDelegation(request: unknown, abortSignal?: AbortSignal): Promise<unknown> {
    if (!this.bindings.runDelegation) throw new Error("Delegation is not available in this host.");
    return this.bindings.runDelegation(request, abortSignal);
  }

  async readDelegation(id: string): Promise<unknown> {
    if (!this.bindings.readDelegation) throw new Error("Delegation is not available in this host.");
    return this.bindings.readDelegation(id);
  }

  async listDelegations(): Promise<unknown> {
    if (!this.bindings.listDelegations) throw new Error("Delegation is not available in this host.");
    return this.bindings.listDelegations();
  }
}

class TracesServiceImpl extends Service implements TracesService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "traces");
    this.bindings = bindings;
  }

  listTraces(filter?: TraceFilter): readonly TraceRecord[] {
    return this.bindings.listTraces?.(filter) ?? [];
  }

  setFeedback(traceId: string, score: number): void {
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
class ScreensServiceImpl extends Service implements ScreensService {
  private readonly bindings: HostBindings;
  /** Manifest of the plugin currently mounting, shared with contributions. */
  private readonly owner: () => PluginManifest | null;

  constructor(ctx: Context, bindings: HostBindings, owner: () => PluginManifest | null) {
    super(ctx, "screens");
    this.bindings = bindings;
    this.owner = owner;
  }

  private attribute(mirror: (manifest: PluginManifest) => (() => void) | undefined): () => void {
    const manifest = this.owner();
    const release = manifest ? mirror(manifest) : undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release?.();
    };
  }

  registerScreen(spec: ScreenSpec): () => void {
    return this.attribute((manifest) => this.bindings.registerScreen?.(spec, manifest));
  }

  registerStatusIndicator(spec: StatusIndicatorSpec): () => void {
    return this.attribute((manifest) => this.bindings.registerStatusIndicator?.(spec, manifest));
  }

  registerToggleableIndicator(spec: ToggleableIndicatorSpec): () => void {
    return this.attribute((manifest) => this.bindings.registerToggleableIndicator?.(spec, manifest));
  }
}

/**
 * Tool lifecycle. Without host bindings `wrapExecute` runs the body directly,
 * so a plugin under test behaves the same minus the host's hooks.
 */
class ToolsServiceImpl extends Service implements ToolsService {
  private readonly bindings: HostBindings;
  private readonly disabled = new Set<string>();

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "tools");
    this.bindings = bindings;
  }

  setEnabled(toolName: string, enabled: boolean): void {
    if (this.bindings.tools) {
      this.bindings.tools.setEnabled(toolName, enabled);
      return;
    }
    if (enabled) this.disabled.delete(toolName);
    else this.disabled.add(toolName);
  }

  isEnabled(toolName: string): boolean {
    return this.bindings.tools?.isEnabled(toolName) ?? !this.disabled.has(toolName);
  }

  async safeExecute<T extends ToolOutcome>(opts: { label: string; fn: () => Promise<T> }): Promise<T | ToolOutcome> {
    if (this.bindings.tools) return this.bindings.tools.safeExecute(opts);
    try {
      return await opts.fn();
    } catch (err) {
      return { success: false, error: `${opts.label} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  runPre(toolName: string, input: Record<string, unknown>, sessionId?: string, abortSignal?: AbortSignal) {
    return requireBinding(this.bindings.tools, "tools").runPre(toolName, input, sessionId, abortSignal);
  }

  runPost(
    toolName: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ) {
    return requireBinding(this.bindings.tools, "tools").runPost(toolName, input, output, sessionId, abortSignal);
  }

  runFailure(
    toolName: string,
    input: Record<string, unknown>,
    error: string,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ) {
    return requireBinding(this.bindings.tools, "tools").runFailure(toolName, input, error, sessionId, abortSignal);
  }

  wrapExecute<I>(
    toolName: string,
    fn: (input: I, ctx: { abortSignal?: AbortSignal }) => Promise<ToolOutcome>,
  ): (input: I, ctx?: { abortSignal?: AbortSignal }) => Promise<ToolOutcome> {
    if (this.bindings.tools) return this.bindings.tools.wrapExecute(toolName, fn);
    return (input, ctx) => fn(input, ctx ?? {});
  }
}

class ToastServiceImpl extends Service implements ToastService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "toast");
    this.bindings = bindings;
  }

  show(toast: Parameters<ToastService["show"]>[0]): void {
    this.bindings.toast?.show(toast);
  }
}

class HostEventsServiceImpl extends Service implements HostEventsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "hostEvents");
    this.bindings = bindings;
  }

  subscribe(event: string, handler: (input: unknown) => void): () => void {
    return this.bindings.hostEvents?.subscribe(event, handler) ?? (() => {});
  }
}

class InputServiceImpl extends Service implements InputService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "input");
    this.bindings = bindings;
  }

  getValue(): string {
    return this.bindings.input?.getValue() ?? "";
  }
  getCursor(): number {
    return this.bindings.input?.getCursor() ?? 0;
  }
  setValueWithCursor(value: string, cursor: number): void {
    this.bindings.input?.setValueWithCursor(value, cursor);
  }
  insertText(text: string): void {
    this.bindings.input?.insertText(text);
  }
  clear(): void {
    this.bindings.input?.clear();
  }
  isFocused(): boolean {
    return this.bindings.input?.isFocused() ?? false;
  }
  intercept(
    handler: (key: Parameters<InputService["intercept"]>[0] extends (k: infer K) => boolean ? K : never) => boolean,
  ): () => void {
    return this.bindings.input?.intercept(handler as never) ?? (() => {});
  }
}

class IconsServiceImpl extends Service implements IconsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "icons");
    this.bindings = bindings;
  }

  setResolver(resolver: ((name: string) => string | null) | null): void {
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
class KernelSinkServiceImpl extends Service implements KernelSinkService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "sinks");
    this.bindings = bindings;
  }

  bind(sinks: KernelSinks): () => void {
    return this.bindings.bindSinks?.(sinks) ?? (() => {});
  }
}

/** Delegating service: throws only when the host lends no implementation. */
function requireBinding<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`The ${name} service is not available in this host.`);
  return value;
}

class ScheduleServiceImpl extends Service implements ScheduleService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "schedule");
    this.bindings = bindings;
  }

  private get host(): ScheduleService {
    return requireBinding(this.bindings.schedule, "schedule");
  }

  create(options: ScheduleCreateOptions) {
    return this.host.create(options);
  }
  list() {
    return this.host.list();
  }
  remove(id: string) {
    return this.host.remove(id);
  }
  readLog(id: string, tail?: number) {
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

class LoopsServiceImpl extends Service implements LoopsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "loops");
    this.bindings = bindings;
  }

  private get host(): LoopsService {
    return requireBinding(this.bindings.loops, "loops");
  }

  list() {
    return this.host.list();
  }
  get(name: string) {
    return this.host.get(name);
  }
  start(name: string, maxIterations?: number, goal?: string) {
    return this.host.start(name, maxIterations, goal);
  }
  stop(name?: string) {
    return this.host.stop(name);
  }
  advance(name: string) {
    return this.host.advance(name);
  }
  record(name: string, entry: { status: LoopIterationRecord["status"]; summary?: string; verificationNotes?: string }) {
    return this.host.record(name, entry);
  }
  setSpec(spec: LoopSpec) {
    return this.host.setSpec(spec);
  }
  getActive() {
    return this.host.getActive();
  }
  noteUsage(totalTokens: number) {
    this.host.noteUsage(totalTokens);
  }
}

class McpServiceImpl extends Service implements McpService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "mcp");
    this.bindings = bindings;
  }

  isEnabled(): boolean {
    return this.bindings.mcp?.isEnabled() ?? false;
  }

  getToolBundle(): Promise<unknown> {
    return requireBinding(this.bindings.mcp, "mcp").getToolBundle();
  }
}

class TelegramServiceImpl extends Service implements TelegramService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "telegram");
    this.bindings = bindings;
  }

  sendFile(filePath: string, abortSignal?: AbortSignal) {
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
class BashServiceImpl extends Service implements BashService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "bash");
    this.bindings = bindings;
  }

  private get host(): BashService {
    return requireBinding(this.bindings.bash, "bash");
  }

  cwd() {
    return this.host.cwd();
  }
  execute(command: string, timeout?: number, abortSignal?: AbortSignal) {
    return this.host.execute(command, timeout, abortSignal);
  }
  startBackground(command: string) {
    return this.host.startBackground(command);
  }
  getProcessLogs(id: number, tail?: number) {
    return this.host.getProcessLogs(id, tail);
  }
  stopProcess(id: number) {
    return this.host.stopProcess(id);
  }
  listProcesses() {
    return this.host.listProcesses();
  }
  spawnChild(initialCwd: string, options?: { sandboxMode?: string; sandboxSettings?: unknown }) {
    return this.host.spawnChild(initialCwd, options);
  }
  cleanup() {
    return this.host.cleanup();
  }
  getSandboxMode() {
    return this.host.getSandboxMode();
  }
  setSandboxMode(mode: string) {
    this.host.setSandboxMode(mode);
  }
  getSandboxSettings() {
    return this.host.getSandboxSettings();
  }
  setSandboxSettings(settings: unknown) {
    this.host.setSandboxSettings(settings);
  }
}

class PluginsServiceImpl extends Service implements PluginsService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "plugins");
    this.bindings = bindings;
  }

  async enable(id: string): Promise<void> {
    await this.bindings.plugins?.enable(id);
  }

  async disable(id: string): Promise<void> {
    await this.bindings.plugins?.disable(id);
  }
}

class LifecycleServiceImpl extends Service implements LifecycleService {
  private readonly bindings: HostBindings;

  constructor(ctx: Context, bindings: HostBindings) {
    super(ctx, "lifecycle");
    this.bindings = bindings;
  }

  onUserInterrupt(listener: () => void): () => void {
    return this.bindings.onUserInterrupt?.(listener) ?? (() => {});
  }

  onProcessExit(listener: () => void): () => void {
    return this.bindings.onProcessExit?.(listener) ?? (() => {});
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
export function createCodesurfRoot(bindings: HostBindings = {}): Context {
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
export function mountPlugin<Config>(root: Context, plugin: CodesurfPlugin<Config>, config?: Config) {
  const contributions = root.get("contributions") as ContributionsServiceImpl | undefined;
  const apply = plugin.apply;
  const wrapped = {
    name: plugin.name,
    inject: plugin.inject,
    apply: (ctx: Context, resolved: Config) =>
      contributions ? contributions.withManifest(plugin.manifest, () => apply(ctx, resolved)) : apply(ctx, resolved),
  };
  return root.plugin(wrapped as never, config as never);
}

export { Context, Service } from "@deepseek-ai/cordis";
export type { HostBindings as CodesurfHostBindings };
