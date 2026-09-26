// Host bridge for native Cordis plugins.
//
// The CLI still boots through the V1 loader, which owns the persisted
// enable/disable state, the `/extensions` listing and the activation order. A
// native plugin is therefore presented to the loader as an `PluginModule`
// whose `activate` mounts a real Cordis fiber and whose `deactivate` disposes
// it. Nothing about the plugin is V1: it declares `inject`, receives a real
// `Context`, and its contributions are owned by `ctx.effect`, so the fiber's
// disposal — not the loader — is what removes them.
//
// This is the temporary, clearly labelled direction of travel. Later waves move
// the enable/disable decision itself into the runtime and delete the adapter;
// what must not happen is the inverse (a Cordis wrapper calling `activate(api)`),
// which would leave the plugin V1 in everything but name.

import type {
  ChatDispatchOptions,
  CodesurfPlugin,
  CommandResolverSpec,
  CommandSpec,
  KernelSinks,
  ListingCommandSpec,
  MentionProviderSpec,
  ModelProviderSpec,
  ModelSpec,
  PluginManifest,
  PromptCommandSpec,
  SettingSpec,
  SettingsService,
  ToolSpec,
} from "@codesurf/plugin-api";
import type { ScreenInput, ScreenSpec, StatusIndicatorSpec, ToggleableIndicatorSpec } from "@codesurf/plugin-api/ui";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { listTraces, setFeedback } from "../../../storage/index";
import { loadValidSubAgents } from "../../../utils/settings";
import type { PluginModule } from "../api";
import { EXTENSIONS_V1_API_VERSION } from "../api";
import { getIconResolver } from "../icons";
import {
  getHostServices,
  onProcessExit,
  onUserInterrupt,
  registerNativeCommandResolver,
  registerNativeMentionProvider,
  registerRuntimeShutdownHook,
} from "../loader";
import { assertManifestCapability, type HostCapability, type HostManifest } from "../manifest";
import {
  getPluginRecord,
  registerPluginCommand,
  registerPluginModel,
  registerPluginModelProvider,
  registerPluginPromptSection,
  registerPluginScreen,
  registerPluginSetting,
  registerPluginStatusIndicator,
  registerPluginTool,
  unregisterExtensionStatusIndicator,
  unregisterPluginCommand,
  unregisterPluginModel,
  unregisterPluginModelProvider,
  unregisterPluginPromptSection,
  unregisterPluginScreen,
  unregisterPluginSetting,
  unregisterPluginTool,
} from "../registry";
import { getBashSink, getMcpToolBundleProvider, setBashSink, setMcpToolBundleProvider } from "../sinks";

/**
 * The application's Cordis root.
 *
 * Created on first use and disposed by `disposeNativeRuntime()`. It is host
 * state, not runtime state: `@codesurf/runtime` has no module-level variables,
 * so a test can call `createCodesurfRoot()` twice and get two independent
 * worlds. See `native-runtime.test.ts`.
 */
let appRoot: Context | null = null;

/**
 * The settings view handed to a provider's `listModels`.
 *
 * Discovery runs outside a plugin's `apply`, so it has no `ctx` to read from;
 * this is the same host settings service, shaped to the plugin-api contract.
 */
function hostSettingsService(): SettingsService {
  return {
    get: (key, fallback) => getHostServices().settings.get(key, fallback),
    set: (key, value) => getHostServices().settings.set(key, value),
    subscribe: (key, listener) => getHostServices().settings.subscribe(key, listener),
    list: () =>
      getHostServices()
        .settings.list()
        .map(({ pluginId: _id, ...spec }) => spec),
  };
}

/** Adapt a host registry command down to the structural spec plugins see. */
function toPluginCommand(command: {
  name: string;
  description: string;
  argsHint?: string;
  aliases?: string[];
  handler: (ctx: { args: string; services: never }) => void | Promise<void>;
}): CommandSpec {
  return {
    name: command.name,
    description: command.description,
    argsHint: command.argsHint,
    aliases: command.aliases,
    // A plugin listing commands must not be able to invoke another plugin's
    // handler without the host services it expects; listings are read-only.
    handler: () => {},
  };
}

/** Adapt a plugin's structural command spec to the host registry's shape. */
function toRegisteredCommand(spec: CommandSpec, pluginId: string) {
  return {
    pluginId,
    name: spec.name,
    description: spec.description,
    argsHint: spec.argsHint,
    aliases: spec.aliases,
    visible: spec.visible,
    handler: (commandCtx: { args: string }) => spec.handler({ args: commandCtx.args }),
  };
}

/**
 * Build the bindings that connect runtime services to this host.
 *
 * Resolved lazily on every call so the bridge never captures a stale
 * `getHostServices()` snapshot — the loader replaces its sinks across session
 * resets, and a captured reference would keep writing into the old session.
 */
/**
 * Enforce the manifest's declared capabilities.
 *
 * This guard used to live in the V1 `PluginHostApi`, which is gone. It is not
 * ceremony: the manifest is how `/plugins` describes a plugin to the user, and
 * one that declares `["commands"]` then registers a tool has made that
 * description a lie. Cheaper to fail at registration than to debug later.
 */
/**
 * Whether a plugin's registrations should still be accepted.
 *
 * A plugin whose `apply` awaits can come back to register AFTER the user
 * disabled it — the V1 loader guarded that with an `isCurrentActivation()`
 * check inside every registration shim, and deleting that surface would have
 * silently dropped the guard. Registrations from a disabled plugin are ignored,
 * with a disposer that does nothing, so a late `await` cannot resurrect it.
 */
function acceptsRegistrations(manifest: PluginManifest): boolean {
  if (isSupersededGeneration(manifest)) return false;
  const record = getPluginRecord(manifest.id);
  // No record yet means this is the first activation, mid-bootstrap.
  return record === undefined || record.enabled;
}

/**
 * The manifest object of each plugin's current mount, keyed by plugin id.
 *
 * `createNativePluginModule` mounts every activation with a fresh copy of the
 * manifest, and the runtime attributes each registration to the manifest it
 * was mounted with — so the object's identity is the generation token. A
 * disable whose teardown timed out leaves the old fiber running; once a
 * re-enable mounts a new generation, anything the old one registers or
 * disposes late must not touch the new one's contributions, which share the
 * same plugin id and usually the same names.
 *
 * Plugins mounted outside the bridge (tests calling `mountPlugin` directly)
 * have no entry and are never treated as superseded.
 */
const liveGenerations = new Map<string, PluginManifest>();

/** Re-runnable listModels calls of live provider adapters. */
const dynamicModelListers = new Set<() => Promise<void>>();

/**
 * Re-list every provider adapter that discovers its models dynamically
 * (daemon catalog, codex, opencode, local LLMs…). Resolves when all have
 * settled; a failing listing keeps its last good models.
 */
export async function refreshDynamicModelListings(): Promise<void> {
  await Promise.allSettled([...dynamicModelListers].map((run) => run()));
}

function isSupersededGeneration(manifest: PluginManifest): boolean {
  const live = liveGenerations.get(manifest.id);
  return live !== undefined && live !== manifest;
}

/** Wrap a disposer so a superseded generation's late cleanup is a no-op. */
function staleSafe(manifest: PluginManifest, dispose: () => void): () => void {
  return () => {
    if (isSupersededGeneration(manifest)) return;
    dispose();
  };
}

/** A registration that was refused: valid disposer, no effect. */
const REFUSED = () => {};

function assertCapability(manifest: PluginManifest, capability: HostCapability, contribution: string): void {
  assertManifestCapability(
    { ...(manifest as unknown as HostManifest), capabilities: (manifest.capabilities ?? []) as HostCapability[] },
    capability,
    contribution,
  );
}

function createHostBindings(): HostBindings {
  return {
    registerCommand(spec: CommandSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "commands", "a command");
      registerPluginCommand({
        pluginId: manifest.id,
        name: spec.name,
        description: spec.description,
        argsHint: spec.argsHint,
        aliases: spec.aliases,
        // The registry predicate takes host services; a plugin's closes over
        // its own ctx and takes none, which is assignable. Dropping it would
        // make a gated command visible on every model.
        visible: spec.visible,
        handler: (commandCtx) => spec.handler({ args: commandCtx.args }),
      });
      // Exact: the effect that registered this command is the only thing that
      // removes it, so a plugin contributing several commands can drop one.
      return staleSafe(manifest, () => unregisterPluginCommand(manifest.id, spec.name));
    },
    registerPromptCommand(spec: PromptCommandSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      registerPluginCommand({
        pluginId: manifest.id,
        name: spec.name,
        description: spec.description,
        argsHint: spec.argsHint,
        aliases: spec.aliases,
        hidden: spec.hidden,
        // A prompt command builds its text and hands it to the agent; the V1
        // `registerPromptCommand` did the same through the chat sink.
        handler: async (commandCtx) => {
          const invocation = { args: commandCtx.args };
          const prompt = await spec.buildPrompt(invocation);
          // Mirrors the loader's own resolution, so the transcript bubble and
          // the generated session title keep showing the short invocation
          // rather than the expanded prompt body.
          const displayText = typeof spec.displayText === "function" ? spec.displayText(invocation) : spec.displayText;
          await commandCtx.services.chat.dispatch(prompt, displayText === undefined ? undefined : { displayText });
        },
      });
      return staleSafe(manifest, () => unregisterPluginCommand(manifest.id, spec.name));
    },
    registerListingCommand(spec: ListingCommandSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      registerPluginCommand({
        pluginId: manifest.id,
        name: spec.name,
        description: spec.description,
        argsHint: spec.argsHint,
        aliases: spec.aliases,
        hidden: spec.hidden,
        handler: (commandCtx) => {
          commandCtx.services.chat.appendAssistant(spec.render({ args: commandCtx.args }));
        },
      });
      return staleSafe(manifest, () => unregisterPluginCommand(manifest.id, spec.name));
    },
    registerTool(spec: ToolSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "tools", "a tool");
      registerPluginTool({
        pluginId: manifest.id,
        name: spec.name,
        description: spec.description,
        label: spec.label,
        group: spec.group,
        modes: spec.modes,
        tool: spec.tool as never,
      });
      return staleSafe(manifest, () => unregisterPluginTool(manifest.id, spec.name));
    },
    registerPromptSection(spec: { id: string; title: string; body: string; order?: number }, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      registerPluginPromptSection({
        pluginId: manifest.id,
        id: spec.id,
        title: spec.title,
        body: spec.body,
        order: spec.order ?? 500,
      });
      return staleSafe(manifest, () => unregisterPluginPromptSection(manifest.id, spec.id));
    },
    registerSetting(spec: SettingSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "settings", "a setting");
      registerPluginSetting({ pluginId: manifest.id, ...spec });
      return staleSafe(manifest, () => unregisterPluginSetting(manifest.id, spec.key));
    },
    registerMentionProvider(spec: MentionProviderSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "mentions", "a mentions provider");
      return staleSafe(manifest, registerNativeMentionProvider(manifest.id, spec));
    },
    registerScreen(spec: ScreenSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "screens", "a screen");
      registerPluginScreen({
        pluginId: manifest.id,
        id: spec.id,
        label: spec.label,
        // The host hands its whole services facade to a screen; a plugin sees
        // only what it needs, so narrow it here rather than leaking the facade
        // through the contract.
        render: (screenCtx: { props: unknown; close: () => void; services: { input: ScreenInput } }) =>
          spec.render({
            props: screenCtx.props,
            close: screenCtx.close,
            input: { useKeyboard: (handler) => screenCtx.services.input.useKeyboard(handler as never) },
          }),
      } as never);
      return staleSafe(manifest, () => unregisterPluginScreen(manifest.id, spec.id));
    },
    registerStatusIndicator(spec: StatusIndicatorSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "status-indicators", "a status indicator");
      // The host passes its services to `render`; a plugin's closure takes no
      // argument, which is assignable, so no wrapper is needed.
      registerPluginStatusIndicator({ pluginId: manifest.id, ...spec } as never);
      return staleSafe(manifest, () => unregisterExtensionStatusIndicator(manifest.id, spec.id));
    },
    registerToggleableIndicator(spec: ToggleableIndicatorSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      // It expands into a command, its settings and the indicator, so it needs
      // every one of those capabilities — not just "status-indicators".
      assertCapability(manifest, "commands", "a toggleable indicator's command");
      assertCapability(manifest, "settings", "a toggleable indicator's settings");
      assertCapability(manifest, "status-indicators", "a toggleable indicator");
      // Composition copied from the V1 loader so a toggle cannot drift from
      // what it toggles: boolean settings default to true, the command ORs the
      // current values and flips them all to the inverse, and the toast text
      // falls back to the command name.
      const label = spec.toastLabel ?? spec.command.name;
      const toastShown = spec.command.toastShown ?? `${label} shown.`;
      const toastHidden = spec.command.toastHidden ?? `${label} hidden.`;
      const disposers: Array<() => void> = [];

      for (const setting of spec.settings) {
        registerPluginSetting({
          pluginId: manifest.id,
          key: setting.key,
          title: setting.title,
          description: setting.description,
          type: "boolean",
          default: setting.default ?? true,
          section: setting.section,
        });
        disposers.push(() => unregisterPluginSetting(manifest.id, setting.key));
      }

      registerPluginStatusIndicator({
        pluginId: manifest.id,
        id: spec.id,
        placement: spec.placement,
        render: spec.render,
      } as never);
      disposers.push(() => unregisterExtensionStatusIndicator(manifest.id, spec.id));

      registerPluginCommand({
        pluginId: manifest.id,
        name: spec.command.name,
        description: spec.command.description,
        handler: (commandCtx) => {
          const current = spec.settings.some(
            (setting) =>
              commandCtx.services.settings.get<boolean>(setting.key, setting.default ?? true) ??
              setting.default ??
              true,
          );
          const next = !current;
          for (const setting of spec.settings) commandCtx.services.settings.set(setting.key, next);
          commandCtx.services.toast.show({ style: "info", title: next ? toastShown : toastHidden });
        },
      });
      disposers.push(() => unregisterPluginCommand(manifest.id, spec.command.name));

      return staleSafe(manifest, () => {
        for (const dispose of disposers.reverse()) dispose();
      });
    },
    registerModelProvider(spec: ModelProviderSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "provider-adapters", "a model provider");
      // The provider protocol is structural in plugin-api (SDK values are
      // `unknown` there); the host registry's own types are the concrete ones,
      // so this is the single adaptation point.
      registerPluginModelProvider({ pluginId: manifest.id, ...spec } as never);

      // A provider's inline models are registered as models in their own right,
      // exactly as the V1 loader did — the model picker reads the model list,
      // not the adapter's `models` field. Each inherits the adapter's ids
      // unless it names its own.
      const inline = [...(spec.model ? [spec.model] : []), ...(spec.models ?? [])];
      // Inline models are still models: a provider that ships a catalogue has
      // to declare `models`, exactly as one calling registerModel would.
      if (inline.length > 0) assertCapability(manifest, "models", "models on a provider adapter");
      const registered: string[] = [];
      const inlineIds = new Set(inline.map((model) => model.id));
      for (const model of inline) {
        registerPluginModel({
          ...model,
          providerId: model.providerId || spec.providerId,
          adapterId: model.adapterId || spec.id,
          pluginId: manifest.id,
        });
        registered.push(model.id);
      }

      // Dynamic discovery, for backends whose catalogue is not known until a
      // connection exists. Late results are dropped if the fiber has since been
      // disposed, so a slow listing cannot repopulate a unmounted plugin.
      // Re-run by refreshDynamicModelListings() (the model picker calls it on
      // open): a listing that only ran at boot never picked up new releases, or
      // anything at all if its backend was not up yet.
      let disposed = false;
      let lister: (() => Promise<void>) | null = null;
      if (spec.listModels) {
        const listModels = spec.listModels;
        const listed = new Set<string>();
        lister = async () => {
          let models: Awaited<ReturnType<typeof listModels>>;
          try {
            models = await listModels({
              conversationId: getHostServices().session.id() ?? "ephemeral",
              adapterId: spec.id,
              providerId: spec.providerId,
              settings: hostSettingsService(),
              workspace: { cwd: () => getHostServices().workspace.cwd() },
              mcp: {
                isEnabled: () => getHostServices().mcp.isEnabled(),
                getToolBundle: () => getHostServices().mcp.getToolBundle(),
              },
            });
          } catch (err) {
            console.error(`[extensions] model listing failed for ${spec.id}:`, err);
            return;
          }
          if (disposed || isSupersededGeneration(manifest)) return;
          const next = new Set(models.map((model) => model.id));
          // Drop previously listed models the backend no longer reports —
          // never the adapter's inline ones.
          for (const id of listed) {
            if (next.has(id) || inlineIds.has(id)) continue;
            unregisterPluginModel(manifest.id, id);
            listed.delete(id);
            const at = registered.indexOf(id);
            if (at >= 0) registered.splice(at, 1);
          }
          for (const model of models) {
            registerPluginModel({
              ...model,
              providerId: model.providerId || spec.providerId,
              adapterId: model.adapterId || spec.id,
              pluginId: manifest.id,
            });
            if (!listed.has(model.id)) {
              listed.add(model.id);
              registered.push(model.id);
            }
          }
        };
        dynamicModelListers.add(lister);
        void lister();
      }

      return staleSafe(manifest, () => {
        disposed = true;
        if (lister) dynamicModelListers.delete(lister);
        for (const id of registered) unregisterPluginModel(manifest.id, id);
        unregisterPluginModelProvider(manifest.id, spec.id);
      });
    },
    registerModel(spec: ModelSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "models", "a model");
      registerPluginModel({ pluginId: manifest.id, ...spec });
      return staleSafe(manifest, () => unregisterPluginModel(manifest.id, spec.id));
    },
    registerCommandResolver(spec: CommandResolverSpec, manifest: PluginManifest) {
      if (!acceptsRegistrations(manifest)) return REFUSED;
      assertCapability(manifest, "commands", "a command resolver");
      const release = registerNativeCommandResolver({
        pluginId: manifest.id,
        label: spec.label,
        resolve: (input) => {
          const match = spec.resolve(input);
          if (!match) return null;
          return { command: toRegisteredCommand(match.command, manifest.id), args: match.args };
        },
        enumerate: spec.enumerate
          ? () => (spec.enumerate?.() ?? []).map((command) => toRegisteredCommand(command, manifest.id))
          : undefined,
      });
      return staleSafe(manifest, release);
    },
    ui: {
      action: (payload) => getHostServices().ui.action(payload as never),
      terminalSize: () => getHostServices().ui.terminalSize(),
      screens: { list: () => getHostServices().ui.screens.list() },
    },
    // The registry's commands carry a host `CommandContext`; a plugin only
    // ever sees the structural spec, so drop the host-only parameter.
    listCommands: () => getHostServices().commands.list().map(toPluginCommand),
    listDynamicCommands: () => getHostServices().commands.listDynamic().map(toPluginCommand),
    sessionId: () => getHostServices().session.id(),
    reconnectSession: () => getHostServices().session.reconnect(),
    activeAdapterId: () => getHostServices().models.getActiveAdapterId(),
    // Straight to src/storage, exactly as the V1 /feedback handler did; the
    // stored trace is a superset of TraceRecord, so nothing needs mapping.
    listTraces: (filter) => listTraces(filter ?? {}),
    setTraceFeedback: (traceId, score) => setFeedback(traceId, score),
    listCustomSubagents: () => loadValidSubAgents(),
    runTask: (request, abortSignal) => getHostServices().subagents.runTask(request as never, abortSignal),
    runDelegation: (request, abortSignal) => getHostServices().subagents.runDelegation(request as never, abortSignal),
    readDelegation: (id) => getHostServices().subagents.readDelegation(id),
    listDelegations: () => getHostServices().subagents.listDelegations(),
    tools: {
      setEnabled: (name, enabled) => getHostServices().tools.setEnabled(name, enabled),
      isEnabled: (name) => getHostServices().tools.isEnabled(name),
      safeExecute: (opts) => getHostServices().tools.safeExecute(opts as never) as never,
      runPre: (name, input, sessionId, signal) => getHostServices().hooks.runPre(name, input, sessionId, signal),
      runPost: (name, input, output, sessionId, signal) =>
        getHostServices().hooks.runPost(name, input, output, sessionId, signal),
      runFailure: (name, input, error, sessionId, signal) =>
        getHostServices().hooks.runFailure(name, input, error, sessionId, signal),
      wrapExecute: ((name: string, fn: never) => getHostServices().hooks.wrapExecute(name, fn)) as never,
    },
    toast: { show: (toast) => getHostServices().toast.show(toast as never) },
    hostEvents: {
      subscribe: (event, handler) => getHostServices().events.subscribe(event as never, handler as never),
    },
    input: {
      getValue: () => getHostServices().input.getValue(),
      getCursor: () => getHostServices().input.getCursor(),
      setValueWithCursor: (value, cursor) => getHostServices().input.setValueWithCursor(value, cursor),
      insertText: (text) => getHostServices().input.insertText(text),
      clear: () => getHostServices().input.clear(),
      isFocused: () => getHostServices().input.isFocused(),
      intercept: (handler) => getHostServices().input.intercept(handler as never),
    },
    icons: { setResolver: (resolver) => getHostServices().icons.setResolver(resolver) },
    // Compare-and-release: a plugin disposed after a replacement took over must
    // not clear the newer owner's sink. Each release checks that what is
    // installed is still what this binding installed.
    bindSinks: (sinks: KernelSinks) => {
      const releases: Array<() => void> = [];
      if (sinks.bash) {
        const bash = sinks.bash as never;
        setBashSink(bash);
        releases.push(() => {
          if (getBashSink() === bash) setBashSink(null);
        });
      }
      if (sinks.mcp) {
        const mcp = sinks.mcp as never;
        setMcpToolBundleProvider(mcp);
        releases.push(() => {
          if (getMcpToolBundleProvider() === mcp) setMcpToolBundleProvider(null);
        });
      }
      if (sinks.icons) {
        const icons = sinks.icons;
        getHostServices().icons.setResolver(icons);
        releases.push(() => {
          if (getIconResolver() === icons) getHostServices().icons.setResolver(null);
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const release of releases.reverse()) release();
      };
    },
    schedule: {
      create: (options) => getHostServices().schedule.create(options),
      list: () => getHostServices().schedule.list(),
      remove: (id) => getHostServices().schedule.remove(id),
      readLog: (id, tail) => getHostServices().schedule.readLog(id, tail),
      getDaemonStatus: () => getHostServices().schedule.getDaemonStatus(),
      startDaemon: () => getHostServices().schedule.startDaemon(),
      stopDaemon: () => getHostServices().schedule.stopDaemon(),
    },
    loops: {
      list: () => getHostServices().loops.list(),
      get: (name) => getHostServices().loops.get(name),
      start: (name, maxIterations, goal) => getHostServices().loops.start(name, maxIterations, goal),
      stop: (name) => getHostServices().loops.stop(name),
      advance: (name) => getHostServices().loops.advance(name),
      record: (name, entry) => getHostServices().loops.record(name, entry),
      setSpec: (spec) => getHostServices().loops.setSpec(spec),
      getActive: () => getHostServices().loops.getActive(),
      noteUsage: (totalTokens) => getHostServices().loops.noteUsage(totalTokens),
    },
    mcp: {
      isEnabled: () => getHostServices().mcp.isEnabled(),
      getToolBundle: () => getHostServices().mcp.getToolBundle(),
    },
    telegram: { sendFile: (filePath, abortSignal) => getHostServices().telegram.sendFile(filePath, abortSignal) },
    // The shell itself is a host singleton contributed by the bash plugin;
    // reading it per call means a disable/re-enable cycle is picked up.
    bash: {
      cwd: () => getHostServices().bash.cwd(),
      execute: (command, timeout, signal) => getHostServices().bash.execute(command, timeout, signal),
      startBackground: (command) => getHostServices().bash.startBackground(command),
      getProcessLogs: (id, tail) => getHostServices().bash.getProcessLogs(id, tail),
      stopProcess: (id) => getHostServices().bash.stopProcess(id),
      listProcesses: () => getHostServices().bash.listProcesses(),
      spawnChild: (cwd, options) => getHostServices().bash.spawnChild(cwd, options as never),
      cleanup: () => getHostServices().bash.cleanup(),
      getSandboxMode: () => getHostServices().bash.getSandboxMode(),
      setSandboxMode: (mode) => getHostServices().bash.setSandboxMode(mode as never),
      getSandboxSettings: () => getHostServices().bash.getSandboxSettings(),
      setSandboxSettings: (settings) => getHostServices().bash.setSandboxSettings(settings as never),
    },
    plugins: {
      enable: (id) => getHostServices().extensions.enable(id),
      disable: (id) => getHostServices().extensions.disable(id),
    },
    onUserInterrupt: (listener) => onUserInterrupt(listener),
    onProcessExit: (listener) => onProcessExit(listener),
    appendAssistant(text: string) {
      getHostServices().chat.appendAssistant(text);
    },
    dispatchPrompt(prompt: string, options?: ChatDispatchOptions) {
      return getHostServices().chat.dispatch(prompt, options);
    },
    cwd() {
      return getHostServices().workspace.cwd();
    },
    getSetting(key, fallback) {
      return getHostServices().settings.get(key, fallback);
    },
    setSetting(key, value) {
      getHostServices().settings.set(key, value);
    },
    subscribeSetting(key, listener) {
      return getHostServices().settings.subscribe(key, listener);
    },
    // Drop the host-only `pluginId` so a plugin sees the structural spec.
    listSettings: () =>
      getHostServices()
        .settings.list()
        .map(({ pluginId: _id, ...spec }) => spec),
    getContextStats() {
      return getHostServices().context.getStats();
    },
    getContextBreakdown() {
      return getHostServices().context.getBreakdown();
    },
    compactContext() {
      return getHostServices().context.compact();
    },
  };
}

/** The app root, created on first use. */
export function getNativeRoot(): Context {
  appRoot ??= createCodesurfRoot(createHostBindings());
  return appRoot;
}

/**
 * Tear the app root down, awaiting every mounted plugin's cleanup.
 *
 * Called from the host's shutdown path alongside `shutdownPlugins()`.
 */
export async function disposeNativeRuntime(): Promise<void> {
  const root = appRoot;
  appRoot = null;
  if (!root) return;
  await root.fiber.dispose();
  liveGenerations.clear();
}

/** Test helper: drop the root without awaiting, for suites that boot their own. */
export function __resetNativeRuntimeForTests(): void {
  appRoot = null;
  liveGenerations.clear();
}

// The loader owns the host's teardown order; register here so it disposes the
// root after every extension has been deactivated.
registerRuntimeShutdownHook(disposeNativeRuntime);

/**
 * Present a native plugin to the V1 loader.
 *
 * The returned module carries the plugin's own manifest, so stable ids,
 * default-enabled and protected flags, groups and capabilities are unchanged
 * from the V1 entry it replaces — persisted opt-outs keep applying.
 */
/** How long a disable waits for a plugin's own teardown before moving on. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
let disposeTimeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS;

/** Test helper: shorten the teardown bound; pass nothing to restore it. */
export function __setDisposeTimeoutForTests(ms?: number): void {
  disposeTimeoutMs = ms ?? DEFAULT_DISPOSE_TIMEOUT_MS;
}

export function createNativePluginModule(plugin: CodesurfPlugin): PluginModule {
  const manifest: HostManifest = {
    schemaVersion: 1,
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    hostApiVersion: EXTENSIONS_V1_API_VERSION,
    kind: "builtin",
    description: plugin.manifest.description,
    enabledByDefault: plugin.manifest.enabledByDefault,
    protected: plugin.manifest.protected,
    hidden: plugin.manifest.hidden,
    group: plugin.manifest.group,
    capabilities: plugin.manifest.capabilities,
  };

  let fiber: ReturnType<typeof mountPlugin> | null = null;

  return {
    manifest,
    async activate() {
      // A fresh manifest object per mount is this generation's identity; see
      // `liveGenerations`.
      const generation: PluginManifest = { ...plugin.manifest };
      liveGenerations.set(generation.id, generation);
      const mounted = mountPlugin(getNativeRoot(), { ...plugin, manifest: generation });
      fiber = mounted;
      // Awaiting surfaces a failed `apply` (or a config ValidationError) as an
      // activation failure the loader reports, instead of an unhandled
      // rejection with the extension left listed as active.
      try {
        await mounted;
      } catch (err) {
        // Cordis runs the failed fiber's effects but leaves the fiber itself
        // on the root in the FAILED state, where a later service change can
        // restart it behind the loader's back. Dispose it for good; the
        // loader never calls `deactivate` for a failed activation.
        if (fiber === mounted) fiber = null;
        await Promise.race([
          mounted.dispose().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, disposeTimeoutMs)),
        ]);
        throw err;
      }
    },
    async deactivate() {
      const mounted = fiber;
      fiber = null;
      if (!mounted) return;
      // Disposal awaits the plugin's own cleanup, so contributions are gone
      // from the registry before the loader marks the plugin inactive.
      //
      // Bounded, though: `dispose()` cannot settle until `apply` does, so a
      // plugin still awaiting something never-resolving would wedge the disable
      // — and with it the /plugins toggle and shutdown. The registrations are
      // already refused by then (see `acceptsRegistrations`), so giving up on
      // the wait is safe; hanging the app is not.
      //
      // A timed-out generation keeps running, so its entry in `liveGenerations`
      // stays until a re-enable replaces it — from then on its late
      // registrations are refused and its late disposers do nothing.
      await Promise.race([mounted.dispose(), new Promise<void>((resolve) => setTimeout(resolve, disposeTimeoutMs))]);
    },
  };
}
