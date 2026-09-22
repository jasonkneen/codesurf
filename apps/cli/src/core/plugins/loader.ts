// Extension loader — boots modules, wires the host API, handles enable/disable.
//
// The loader is the *only* mutable entry point into the registry from extension
// code. Everything else (app.tsx, agent loop) consumes the registry read-only
// through `getRegistrySnapshot()` or the React hooks in registry.ts.

import type { ToolSet } from "ai";
import type { ToolResult } from "../../types/index";
import { processAtMentionsAsync } from "../../utils/at-mentions.js";
import { FileIndex } from "../../utils/file-index.js";
import { loadPersistedLoops, savePersistedLoops } from "../persistence/loops";
import {
  addDisabledPluginId,
  loadDisabledPluginIds,
  loadEnabledPluginIds,
  loadPluginSettings,
  loadToolOverrides,
  removeDisabledPluginId,
  saveEnabledPluginIds,
  savePluginSetting,
  saveToolOverride,
} from "../persistence/plugins";
import type {
  AgentMode,
  HostMentionProvider,
  PluginHostServices,
  PluginLifecycleStatus,
  PluginListEntry,
  PluginModule,
  RegisteredCommand,
  RegisteredCommandResolver,
  RegisteredModel,
} from "./api";
import { subscribeAgentEvent } from "./event-bus";
import { getIcon, setIconResolver } from "./icons";
import { createLoopManager } from "./loops";
import { assertManifest } from "./manifest";
import {
  __resetRegistryForTests,
  getRegistrySnapshot,
  registerPluginModel,
  registerPluginRecord,
  unregisterExtensionContributions,
  updatePluginRecord,
} from "./registry";

// Sink state, sink types, and sink-binding setters live in ./sinks
// (extracted 2026-06-22). Re-exported here so the public barrel in
// ./index.ts and all consumers continue importing from "./loader".
export {
  type BashSink,
  type ChatSink,
  callerOwnsTelegramSink,
  dispatchInputInterceptors,
  emptyHookResult,
  emptyMcpToolBundle,
  type HooksSink,
  type InputSink,
  inputInterceptors,
  type LoaderSinkState,
  type McpToolBundleProvider,
  noopKeyboardHook,
  requireBashSink,
  requireScheduleSink,
  runInTelegramTurn,
  type ScheduleSink,
  type SubagentsSink,
  setActiveModelAdapterIdProvider,
  setAssistantSink,
  setBashSink,
  setChatSink,
  setContextBreakdownProvider,
  setContextCompactProvider,
  setContextStatsProvider,
  setCwdProvider,
  setHooksSink,
  setInputSink,
  setKeyboardHookProvider,
  setMcpToolBundleProvider,
  setScheduleSink,
  setSessionIdProvider,
  setSessionReconnectProvider,
  setSubagentsSink,
  setTelegramSink,
  setToastSink,
  setUiActionSink,
  sinks,
  type TelegramSink,
} from "./sinks";

import {
  callerOwnsTelegramSink,
  emptyHookResult,
  emptyMcpToolBundle,
  inputInterceptors,
  noopKeyboardHook,
  requireBashSink,
  requireScheduleSink,
  resetSinkState,
  sinks,
} from "./sinks";

// ── Internal state ────────────────────────────────────────────────────────────

interface PluginInstance {
  module: PluginModule;
  enabled: boolean;
  active: boolean;
  status: PluginLifecycleStatus;
  disposeScope: DisposeScope;
  activationToken: number;
  activationPromise: Promise<void> | null;
  /**
   * Active teardown, if any. A rapid disable → enable waits for this before
   * a fresh activation can register providers or create a new session.
   */
  deactivationPromise: Promise<void> | null;
}

const instances = new Map<string, PluginInstance>();

// Tool overrides persisted in ~/.grok/extensions.json — tool name → enabled.
let toolOverrides: Record<string, boolean> = {};

// Tool names belonging to currently-disabled extensions. Populated on
// deactivate, cleared on re-activate. The filter uses this to keep the
// Agent's externally-produced ToolSet in sync when an extension is disabled
// (the registry has already torn down its metadata at that point).
const disabledPluginToolNames = new Set<string>();

// Aggregated process-exit handlers contributed by extensions via
// `api.onProcessExit`. A single pair of process listeners fans out to every
// registered callback, so extensions don't each attach their own
// `process.once` handlers that leak across enable/disable cycles.
const processExitCallbacks = new Set<() => void>();

// Aggregated user-interrupt handlers contributed via `api.onUserInterrupt`.
// Fired by `Agent.abort()` — i.e. the human pressed Esc — so long-running
// extension work (workflow scripts driving sub-agents) can cancel instead of
// running to completion after the user has already stopped the turn.
const userInterruptCallbacks = new Set<() => void>();

/**
 * Subscribe to the user-interrupt signal outside the V1 activation path.
 *
 * `api.onUserInterrupt` ties the subscription to an extension's dispose scope;
 * a native plugin owns its own lifetime through `ctx.effect`, so it needs the
 * bare registration and the disposer back.
 */
export function onUserInterrupt(listener: () => void): () => void {
  userInterruptCallbacks.add(listener);
  return () => {
    userInterruptCallbacks.delete(listener);
  };
}

/** Subscribe to process exit outside the V1 activation path. See `onUserInterrupt`. */
export function onProcessExit(listener: () => void): () => void {
  ensureProcessExitHooks();
  processExitCallbacks.add(listener);
  return () => {
    processExitCallbacks.delete(listener);
  };
}

/** Notify every registered interrupt handler. Never throws. */
export function fireUserInterrupt(): void {
  for (const cb of userInterruptCallbacks) {
    try {
      cb();
    } catch {
      // interrupt handlers must never break abort
    }
  }
}

let processExitHooksInstalled = false;
function ensureProcessExitHooks(): void {
  if (processExitHooksInstalled) return;
  processExitHooksInstalled = true;
  const runAll = () => {
    for (const cb of processExitCallbacks) {
      try {
        cb();
      } catch {
        // exit handlers must never throw
      }
    }
  };
  process.once("exit", runAll);
  process.once("SIGHUP", () => {
    runAll();
    process.exit(0);
  });
}

// Current agent mode tracked at the kernel level. Set via `setKernelMode()`
// on each Agent turn (and on `setMode()` transitions). When non-null, both
// `buildEnabledToolSet()` and `filterToolSetByEnabled()` drop any tool whose
// `RegisteredTool.modes` field is set and doesn't include the current mode.
// When null (the default at boot, in tests, and after shutdown) the kernel
// preserves the pre-Phase-2 "always available" behavior — tools with `modes`
// pass through unfiltered, matching the legacy registration-time gating.
let currentKernelMode: AgentMode | null = null;

// Extension settings cache (loaded from disk at boot).
let settingsCache: Record<string, unknown> = {};

// Per-key subscribers for `services.settings.subscribe`.
const settingSubscribers = new Map<string, Set<(value: unknown, previous: unknown) => void>>();

// Dynamic command resolvers, keyed by pluginId. Lookup order during
// `services.commands.resolveInput` is: static commands first, then resolvers
// in registration order. Cleared on extension deactivate / shutdown.
const commandResolvers = new Map<string, RegisteredCommandResolver[]>();
const mentionProviders: { pluginId: string; provider: HostMentionProvider }[] = [];

interface MentionProviderToken {
  pluginId: string;
  provider: HostMentionProvider;
  dispose: () => void;
}

// LRU-bounded mentions cache — evicts the least-recently-used entry when over
// limit. Uses Map insertion order (ES2015+): get() re-inserts to bump recency,
// set() evicts the oldest (first) key when over MAX_CACHED_CWDS.
const MAX_CACHED_CWDS = 10;
const mentionsIndexByCwd = new Map<string, FileIndex>();

function touchMentionsCache(key: string): void {
  const value = mentionsIndexByCwd.get(key);
  if (value !== undefined) {
    // Bump to end (most recently used) by re-inserting.
    mentionsIndexByCwd.delete(key);
    mentionsIndexByCwd.set(key, value);
  }
}

function evictOldestMentionsEntry(): void {
  const oldest = mentionsIndexByCwd.keys().next();
  if (!oldest.done) {
    mentionsIndexByCwd.delete(oldest.value);
  }
}

function currentWorkspaceCwd(): string {
  if (sinks.cwdProvider) {
    try {
      return sinks.cwdProvider();
    } catch (err) {
      console.error("[extensions] cwd provider for mentions threw:", err);
    }
  }
  return process.cwd();
}

function getMentionsIndex(cwd: string): FileIndex {
  const existing = mentionsIndexByCwd.get(cwd);
  if (existing) {
    existing.updateCwd(cwd);
    touchMentionsCache(cwd);
    return existing;
  }
  if (mentionsIndexByCwd.size >= MAX_CACHED_CWDS) {
    evictOldestMentionsEntry();
  }
  const created = new FileIndex(cwd);
  mentionsIndexByCwd.set(cwd, created);
  return created;
}

function getActiveMentionProvider(): HostMentionProvider {
  const active = mentionProviders[mentionProviders.length - 1];
  return active?.provider ?? defaultMentionProvider;
}

function registerMentionProvider(pluginId: string, provider: HostMentionProvider): MentionProviderToken {
  const token: MentionProviderToken = {
    pluginId,
    provider,
    dispose: () => {
      const idx = mentionProviders.indexOf(token);
      if (idx >= 0) {
        mentionProviders.splice(idx, 1);
      }
    },
  };
  mentionProviders.push(token);
  return token;
}

/**
 * Register a mention provider for a native plugin and return its disposer.
 *
 * `api.registerMentionsService` ties the registration to an extension's dispose
 * scope; a native plugin owns its own lifetime through `ctx.effect`.
 */
export function registerNativeMentionProvider(pluginId: string, provider: HostMentionProvider): () => void {
  return registerMentionProvider(pluginId, provider).dispose;
}

function _registerProviderModels(
  pluginId: string,
  providerId: string,
  adapterId: string,
  models: Array<Omit<RegisteredModel, "pluginId">>,
) {
  for (const model of models) {
    registerPluginModel({
      ...model,
      providerId: model.providerId || providerId,
      adapterId: model.adapterId || adapterId,
      pluginId,
    });
  }
}

const defaultMentionProvider: HostMentionProvider = {
  match: (query, maxResults) => {
    const cwd = currentWorkspaceCwd();
    const index = getMentionsIndex(cwd);
    return index.match(query, maxResults);
  },
  resolvePath: (relativePath) => {
    const cwd = currentWorkspaceCwd();
    const index = getMentionsIndex(cwd);
    return index.resolvePath(relativePath);
  },
  expand: (text, cwd) => processAtMentionsAsync(text, cwd),
};

function registerExtensionCommandResolver(resolver: RegisteredCommandResolver) {
  const existing = commandResolvers.get(resolver.pluginId) ?? [];
  commandResolvers.set(resolver.pluginId, [...existing, resolver]);
}

/**
 * Register a command resolver for a native plugin and return its exact
 * disposer, so the owning `ctx.effect` removes only this resolver.
 */
export function registerNativeCommandResolver(resolver: RegisteredCommandResolver): () => void {
  registerExtensionCommandResolver(resolver);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const list = commandResolvers.get(resolver.pluginId);
    if (!list) return;
    const next = list.filter((item) => item !== resolver);
    if (next.length === 0) commandResolvers.delete(resolver.pluginId);
    else commandResolvers.set(resolver.pluginId, next);
  };
}

function unregisterExtensionCommandResolvers(pluginId: string) {
  commandResolvers.delete(pluginId);
}

function resolveCommandInput(
  input: string,
  services: PluginHostServices,
): { command: RegisteredCommand; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Static exact match on the first whitespace-delimited token. The input is
  // taken verbatim — callers that conventionally prefix commands with `/`
  // (the typed-input dispatcher in app.tsx) will register their commands
  // with the same prefix, so matching is symmetric.
  const firstWs = trimmed.search(/\s/);
  const name = firstWs === -1 ? trimmed : trimmed.slice(0, firstWs);
  const args = firstWs === -1 ? "" : trimmed.slice(firstWs + 1).trimStart();
  const allCommands = getRegistrySnapshot().commands;
  const exact = allCommands.find((cmd) => cmd.name === name);
  if (exact) return { command: exact, args };
  // Alias match — a command can declare `aliases: ["/q", "/exit"]` so typed
  // input resolves to the canonical entry without registering N duplicates.
  const byAlias = allCommands.find((cmd) => cmd.aliases?.includes(name));
  if (byAlias) return { command: byAlias, args };

  // Resolver chain — first non-null wins. Resolvers receive the trimmed
  // input verbatim and decide their own matching rules.
  for (const resolverList of commandResolvers.values()) {
    for (const resolver of resolverList) {
      try {
        const result = resolver.resolve(trimmed, services);
        if (result) return result;
      } catch (err) {
        console.error(`[extensions] command resolver for ${resolver.pluginId} threw:`, err);
      }
    }
  }

  return null;
}

function enumerateDynamicCommands(services: PluginHostServices): RegisteredCommand[] {
  const staticNames = new Set(getRegistrySnapshot().commands.map((c) => c.name));
  const seen = new Set<string>();
  const out: RegisteredCommand[] = [];
  for (const resolverList of commandResolvers.values()) {
    for (const resolver of resolverList) {
      if (!resolver.enumerate) continue;
      let produced: RegisteredCommand[] = [];
      try {
        produced = resolver.enumerate(services) ?? [];
      } catch (err) {
        console.error(`[extensions] command resolver enumerate for ${resolver.pluginId} threw:`, err);
        continue;
      }
      for (const cmd of produced) {
        if (staticNames.has(cmd.name) || seen.has(cmd.name)) continue;
        seen.add(cmd.name);
        out.push(cmd);
      }
    }
  }
  return out;
}

// ── Host services ─────────────────────────────────────────────────────────────

function settingDefaultFor(key: string): unknown {
  const def = getRegistrySnapshot().settings.find((s) => s.key === key);
  return def?.default;
}

function notifySettingSubscribers(key: string, value: unknown, previous: unknown) {
  const subs = settingSubscribers.get(key);
  if (!subs) return;
  for (const listener of subs) {
    try {
      listener(value, previous);
    } catch (err) {
      console.error(`[extensions] settings subscriber for ${key} threw:`, err);
    }
  }
}

function buildHostServices(): PluginHostServices {
  const services: PluginHostServices = {
    toast: {
      show: (toast) => {
        if (sinks.toast) {
          try {
            sinks.toast(toast);
          } catch (err) {
            console.error("[extensions] toast sink threw:", err);
          }
        }
      },
    },
    commands: {
      list: () => getRegistrySnapshot().commands,
      resolve: (name) => {
        const matches = getRegistrySnapshot().commands.filter((cmd) => cmd.name === name);
        return matches.length > 0 ? matches[0]! : null;
      },
      resolveInput: (input) => resolveCommandInput(input, services),
      listDynamic: () => enumerateDynamicCommands(services),
    },
    mentions: {
      match: (query, maxResults) => getActiveMentionProvider().match(query, maxResults),
      resolvePath: (relativePath) => getActiveMentionProvider().resolvePath(relativePath),
      expand: (text, cwd) => getActiveMentionProvider().expand(text, cwd),
    },
    tools: {
      list: () => getRegistrySnapshot().tools,
      listEnabled: () => getRegistrySnapshot().tools.filter((tool) => isToolEnabled(tool.name)),
      toolSet: () => buildEnabledToolSet(currentKernelMode),
      setEnabled: (toolName, enabled) => {
        toolOverrides = { ...toolOverrides, [toolName]: enabled };
        persistSafely(() => saveToolOverride(toolName, enabled));
      },
      isEnabled: isToolEnabled,
      safeExecute: async <T extends ToolResult>(opts: {
        label: string;
        fn: () => Promise<T>;
      }): Promise<T | ToolResult> => {
        try {
          return await opts.fn();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: `Failed to ${opts.label}: ${msg}` };
        }
      },
    },
    codeRuntime: {
      run: async (request) => {
        const module = await import("../code-runtime");
        return (await module.getCodeRuntimeService()).run(request);
      },
    },
    models: {
      list: () => getRegistrySnapshot().models,
      get: (id) => getRegistrySnapshot().models.find((m) => m.id === id || m.aliases?.includes(id)),
      listProviders: () => getRegistrySnapshot().modelProviders,
      getProvider: (id) => getRegistrySnapshot().modelProviders.find((p) => p.id === id),
      getActiveAdapterId: () => sinks.activeModelAdapterIdProvider?.() ?? null,
    },
    settings: {
      get: <T = unknown>(key: string, fallback?: T) => {
        if (key in settingsCache) {
          return settingsCache[key] as T;
        }
        const def = settingDefaultFor(key);
        if (def !== undefined) return def as T;
        return fallback as T | undefined;
      },
      set: <T = unknown>(key: string, value: T) => {
        const previous = settingsCache[key];
        settingsCache = { ...settingsCache, [key]: value };
        persistSafely(() => savePluginSetting(key, value as unknown));
        notifySettingSubscribers(key, value, previous);
      },
      list: () => getRegistrySnapshot().settings,
      subscribe: (key, listener) => {
        let subs = settingSubscribers.get(key);
        if (!subs) {
          subs = new Set();
          settingSubscribers.set(key, subs);
        }
        subs.add(listener);
        return () => {
          subs?.delete(listener);
        };
      },
    },
    extensions: {
      list: listPlugins,
      enable: (id) => enablePlugin(id),
      disable: (id) => disablePlugin(id),
      setEnabled: async (id, enabled) => {
        if (enabled) await enablePlugin(id);
        else await disablePlugin(id);
      },
    },
    chat: {
      dispatch: async (prompt, options) => {
        if (sinks.chat) {
          try {
            await sinks.chat(prompt, options);
          } catch (err) {
            console.error("[extensions] chat sink threw:", err);
          }
        }
      },
      appendAssistant: (content) => {
        if (sinks.assistant) {
          try {
            sinks.assistant(content);
          } catch (err) {
            console.error("[extensions] assistant sink threw:", err);
          }
        }
      },
    },
    workspace: {
      cwd: () => {
        if (sinks.cwdProvider) {
          try {
            return sinks.cwdProvider();
          } catch (err) {
            console.error("[extensions] cwd provider threw:", err);
          }
        }
        return process.cwd();
      },
    },
    session: {
      id: () => {
        if (sinks.sessionIdProvider) {
          try {
            return sinks.sessionIdProvider();
          } catch (err) {
            console.error("[extensions] session-id provider threw:", err);
          }
        }
        return null;
      },
      reconnect: async () => {
        if (!sinks.sessionReconnect) {
          return {
            reconnected: false,
            message: "No active agent session to reconnect (headless boot or no session bound yet).",
          };
        }
        try {
          const did = await sinks.sessionReconnect();
          return {
            reconnected: did,
            message: did
              ? "Active model session reconnected. Fresh state (including a re-scanned Agent Skills catalogue) takes effect on your next message."
              : "No provider session was cached — nothing to reconnect (it connects fresh on your next message anyway).",
          };
        } catch (err) {
          console.error("[extensions] session-reconnect threw:", err);
          return {
            reconnected: false,
            message: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    context: {
      getStats: () => {
        if (sinks.contextStatsProvider) {
          try {
            return sinks.contextStatsProvider();
          } catch (err) {
            console.error("[extensions] context-stats provider threw:", err);
          }
        }
        return null;
      },
      getBreakdown: () => {
        if (sinks.contextBreakdownProvider) {
          try {
            return sinks.contextBreakdownProvider();
          } catch (err) {
            console.error("[extensions] context-breakdown provider threw:", err);
          }
        }
        return null;
      },
      compact: async () => {
        if (!sinks.contextCompactProvider) {
          return {
            compacted: false,
            message: "Context compact bridge is not active (no agent session).",
          };
        }
        try {
          const did = await sinks.contextCompactProvider();
          return {
            compacted: did,
            message: did
              ? "Context compacted. History replaced by checkpoint summary + recent tail. (Effective on next turn; reload session to see compacted view in transcript.)"
              : "No compaction was needed or possible.",
          };
        } catch (err) {
          console.error("[extensions] context-compact threw:", err);
          return {
            compacted: false,
            message: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    // Kernel loop manager (see loops.ts), durable via loops.json in the
    // config dir. Loops running at last exit rehydrate as stopped with
    // history intact; the /loop builtin command drives the manager.
    loops: createLoopManager({ load: loadPersistedLoops, save: savePersistedLoops }),
    telegram: {
      sendFile: async (filePath, abortSignal) => {
        if (!sinks.telegram) {
          return {
            success: false,
            error: "Telegram bridge is not active. The bot must be running and a chat-driven turn in flight.",
          };
        }
        // NET-6: dispatch by turn context, not by whatever sink is globally
        // installed. A tool call still in flight from a superseded turn would
        // otherwise deliver into the newer turn's chat.
        if (!callerOwnsTelegramSink()) {
          return {
            success: false,
            error: "This turn no longer owns the Telegram destination — a newer turn took over. Nothing was sent.",
          };
        }
        try {
          return await sinks.telegram(filePath, abortSignal);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Telegram send threw: ${msg}` };
        }
      },
    },
    subagents: {
      runTask: async (request, abortSignal) => {
        if (!sinks.subagents) {
          return {
            success: false,
            error: "Subagents bridge is not active. An Agent must be constructed and the sink bound.",
          };
        }
        try {
          return await sinks.subagents.runTask(request, abortSignal);
        } catch (err: unknown) {
          // An abort is a deliberate rethrow from `runTaskRequest`, not a tool
          // failure. Converting it to `{success:false}` made the model treat a
          // user interrupt as a recoverable error and retry into the abort.
          if (abortSignal?.aborted) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Subagent task threw: ${msg}` };
        }
      },
      runDelegation: async (request, abortSignal) => {
        if (!sinks.subagents) {
          return {
            success: false,
            error: "Subagents bridge is not active. An Agent must be constructed and the sink bound.",
          };
        }
        try {
          return await sinks.subagents.runDelegation(request, abortSignal);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Subagent delegation threw: ${msg}` };
        }
      },
      readDelegation: async (id) => {
        if (!sinks.subagents) {
          return {
            success: false,
            error: "Subagents bridge is not active. An Agent must be constructed and the sink bound.",
          };
        }
        try {
          return await sinks.subagents.readDelegation(id);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Subagent delegation_read threw: ${msg}` };
        }
      },
      listDelegations: async () => {
        if (!sinks.subagents) {
          return {
            success: false,
            error: "Subagents bridge is not active. An Agent must be constructed and the sink bound.",
          };
        }
        try {
          return await sinks.subagents.listDelegations();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Subagent delegation_list threw: ${msg}` };
        }
      },
    },
    schedule: {
      // Each method proxies straight through to the bound sink. Unbound ⇒
      // throw; the kernel-owned schedule tools' existing try/catch wrappers
      // turn the throw into the standard "Failed to <op>: ..." failure shape.
      // Structured-data return types make a friendly-error short-circuit
      // awkward at this layer, so we keep the throw + tool-level catch
      // pattern instead of the `{ success, error }` envelope used by the
      // subagents/telegram bridges (whose underlying methods already return
      // ToolResult).
      create: (options) => requireScheduleSink().create(options),
      list: () => requireScheduleSink().list(),
      remove: (id) => requireScheduleSink().remove(id),
      readLog: (id, tail) => requireScheduleSink().readLog(id, tail),
      getDaemonStatus: () => requireScheduleSink().getDaemonStatus(),
      startDaemon: () => requireScheduleSink().startDaemon(),
      stopDaemon: () => requireScheduleSink().stopDaemon(),
    },
    mcp: {
      // True iff `builtin.mcp` has bound the tool-bundle provider. Sync so
      // adapters that pass MCP config to upstream agents (e.g. Claude
      // Agent SDK) can gate at option-building time without awaiting.
      isEnabled: () => sinks.mcpToolBundleProvider !== null,
      // Returns the active MCP tool bundle when `builtin.mcp` is enabled, or
      // an empty bundle when it isn't. Empty-bundle semantics mean the
      // agent's three call sites (and the modal) get a uniform shape with
      // zero MCP tools / servers / resources / prompts when the extension is
      // disabled — no kernel-side branching required.
      getToolBundle: async () => {
        if (!sinks.mcpToolBundleProvider) return emptyMcpToolBundle();
        try {
          return await sinks.mcpToolBundleProvider();
        } catch (err) {
          console.error("[extensions] mcp tool-bundle provider threw:", err);
          return emptyMcpToolBundle();
        }
      },
    },
    bash: {
      // Each accessor proxies straight through to the bound sink. Unbound ⇒
      // throw `BASH_NOT_ACTIVE_MESSAGE`. The `builtin.tools.bash` extension
      // binds the sink at activation and is `protected: true`, so under
      // normal runtime conditions the throw path is unreachable. Tests and
      // shutdown paths that reach the unbound state should wrap in try/catch.
      cwd: () => requireBashSink().cwd(),
      execute: (command, timeout, abortSignal) => requireBashSink().execute(command, timeout, abortSignal),
      startBackground: (command) => requireBashSink().startBackground(command),
      getProcessLogs: (id, tail) => requireBashSink().getProcessLogs(id, tail),
      stopProcess: (id) => requireBashSink().stopProcess(id),
      listProcesses: () => requireBashSink().listProcesses(),
      spawnChild: (initialCwd, options) => requireBashSink().spawnChild(initialCwd, options),
      cleanup: () => requireBashSink().cleanup(),
      getSandboxMode: () => requireBashSink().getSandboxMode(),
      setSandboxMode: (mode) => requireBashSink().setSandboxMode(mode),
      getSandboxSettings: () => requireBashSink().getSandboxSettings(),
      setSandboxSettings: (settings) => requireBashSink().setSandboxSettings(settings),
    },
    hooks: {
      // Each method forwards through to the bound sink, which closes over the
      // hooks-module functions and the live `services.bash.cwd()`. Unbound ⇒
      // resolve a no-op `AggregatedHookResult` (blocked: false). This matches
      // the swallow-error semantics inside `executeEventHooks` itself; hooks
      // are optional, the agent must run without them.
      runPre: async (toolName, toolInput, sessionId, abortSignal) => {
        if (!sinks.hooks) return emptyHookResult();
        try {
          return await sinks.hooks.runPre(toolName, toolInput, sessionId, abortSignal);
        } catch (err) {
          console.error("[extensions] hooks.runPre threw:", err);
          return emptyHookResult();
        }
      },
      runPost: async (toolName, toolInput, toolOutput, sessionId, abortSignal) => {
        if (!sinks.hooks) return emptyHookResult();
        try {
          return await sinks.hooks.runPost(toolName, toolInput, toolOutput, sessionId, abortSignal);
        } catch (err) {
          console.error("[extensions] hooks.runPost threw:", err);
          return emptyHookResult();
        }
      },
      runFailure: async (toolName, toolInput, error, sessionId, abortSignal) => {
        if (!sinks.hooks) return emptyHookResult();
        try {
          return await sinks.hooks.runFailure(toolName, toolInput, error, sessionId, abortSignal);
        } catch (err) {
          console.error("[extensions] hooks.runFailure threw:", err);
          return emptyHookResult();
        }
      },
      runEvent: async (input, abortSignal) => {
        if (!sinks.hooks) return emptyHookResult();
        try {
          return await sinks.hooks.runEvent(input, abortSignal);
        } catch (err) {
          console.error("[extensions] hooks.runEvent threw:", err);
          return emptyHookResult();
        }
      },
      wrapExecute: <I>(
        toolName: string,
        fn: (input: I, ctx: { abortSignal?: AbortSignal }) => Promise<ToolResult>,
      ): ((input: I, ctx?: { abortSignal?: AbortSignal }) => Promise<ToolResult>) => {
        return async (input, ctx) => {
          const abortSignal = ctx?.abortSignal;
          const services = getHostServices();
          const sessionId = services.session.id() ?? undefined;
          const toolInput = input as unknown as Record<string, unknown>;

          const pre = await services.hooks.runPre(toolName, toolInput, sessionId, abortSignal);
          if (pre.blocked) {
            const reason = pre.blockingErrors.map((e) => e.stderr).join("; ") || "Blocked by hook";
            return { success: false, output: `[Hook blocked] ${reason}` };
          }

          const result = await fn(input, { abortSignal });

          // Fire-and-forget — hooks must never gate the return.
          if (result.success) {
            const output = result as unknown as Record<string, unknown>;
            services.hooks.runPost(toolName, toolInput, output, sessionId, abortSignal).catch(() => {});
          } else {
            const errMsg = result.error || result.output || `${toolName} failed`;
            services.hooks.runFailure(toolName, toolInput, errMsg, sessionId, abortSignal).catch(() => {});
          }

          return result;
        };
      },
    },
    events: {
      // Direct passthrough — the in-process event bus has no sink because
      // there's nothing to bind. `emitAgentEvent` is called unconditionally
      // by `executeEventHooks`, so subscriptions live in the bus regardless
      // of whether any Agent has been constructed yet.
      subscribe: subscribeAgentEvent,
    },
    icons: {
      // Thin façade over ./icons.ts so the public surface stays through
      // `api.services.icons` instead of having extensions import the
      // module directly.
      setResolver: setIconResolver,
      resolve: getIcon,
    },
    ui: {
      action: (action) => {
        if (sinks.uiAction) {
          try {
            sinks.uiAction(action);
          } catch (err) {
            console.error("[extensions] ui action sink threw:", err);
          }
        }
      },
      terminalSize: () => ({
        columns: process.stdout.columns ?? 100,
        rows: process.stdout.rows ?? 30,
      }),
      screens: {
        list: () => getRegistrySnapshot().screens.map((s) => ({ id: s.id, label: s.label, pluginId: s.pluginId })),
      },
    },
    input: {
      getValue: () => sinks.input?.getValue() ?? "",
      getCursor: () => sinks.input?.getCursor() ?? 0,
      setValueWithCursor: (value, cursor) => {
        if (!sinks.input) return;
        try {
          sinks.input.setValueWithCursor(value, cursor);
        } catch (err) {
          console.error("[extensions] input.setValueWithCursor threw:", err);
        }
      },
      insertText: (text) => {
        if (!sinks.input) return;
        try {
          sinks.input.insertText(text);
        } catch (err) {
          console.error("[extensions] input.insertText threw:", err);
        }
      },
      clear: () => {
        if (!sinks.input) return;
        try {
          sinks.input.clear();
        } catch (err) {
          console.error("[extensions] input.clear threw:", err);
        }
      },
      isFocused: () => sinks.input?.isFocused() ?? false,
      intercept: (handler) => {
        inputInterceptors.add(handler);
        return () => {
          inputInterceptors.delete(handler);
        };
      },
      useKeyboard: (handler) => {
        // Wrap the renderer's keyboard hook (injected by app.tsx via
        // setKeyboardHookProvider, so the loader stays free of the
        // @opentui/react import). The raw host input pipeline already runs
        // interceptors before OpenTUI emits this event, so redispatching here
        // would invoke stateful interceptors twice per physical keypress.
        const hook = sinks.keyboardHook ?? noopKeyboardHook;
        hook(handler);
      },
    },
  };
  return services;
}

// Single lazily-constructed host services instance — all extensions share it.
let hostServices: PluginHostServices | null = null;

export function getHostServices(): PluginHostServices {
  if (!hostServices) hostServices = buildHostServices();
  return hostServices;
}

// ── Tool enablement ───────────────────────────────────────────────────────────

export function isToolEnabled(toolName: string): boolean {
  if (toolName in toolOverrides) return toolOverrides[toolName] === true;
  return true;
}

/**
 * Set the kernel's current agent mode. Called from the Agent loop before
 * each turn (and on `setMode()` transitions) so mode-gated tools (e.g.
 * `write_file`/`edit_file`/`computer_*`) can be filtered out of the active
 * ToolSet when the user is in plan/ask mode.
 *
 * Pass `null` to clear the mode and restore the pre-Phase-2 "always
 * available" behavior — tools whose `modes` field is set will pass through
 * the filters unconditionally. Boot, tests, and `shutdownPlugins()` all
 * leave the mode at `null`.
 */
export function setKernelMode(mode: AgentMode | null) {
  currentKernelMode = mode;
}

/**
 * Read the current kernel mode. Callers that temporarily switch modes (e.g.
 * building a sub-agent's ToolSet) must snapshot this first and restore it in a
 * `finally`, or the parent is left running under the child's mode.
 */
export function getKernelMode(): AgentMode | null {
  return currentKernelMode;
}

/** Internal: returns true when a tool entry should be filtered out by mode. */
function isModeFilteredOut(modes: AgentMode[] | undefined, mode: AgentMode | null): boolean {
  if (!modes || modes.length === 0) return false;
  if (mode === null) return false;
  return !modes.includes(mode);
}

function buildEnabledToolSet(mode: AgentMode | null): ToolSet {
  const set: ToolSet = {};
  for (const entry of getRegistrySnapshot().tools) {
    if (!entry.tool) continue; // metadata-only entries don't contribute execution
    if (!isToolEnabled(entry.name)) continue;
    if (isModeFilteredOut(entry.modes, mode)) continue;
    set[entry.name] = entry.tool;
  }
  return set;
}

/**
 * Public helper used by the agent loop. Returns a ToolSet merged from all
 * enabled extension contributions that own their execution.
 */
export function getEnabledToolSet(mode?: AgentMode | null): ToolSet {
  // Explicit mode wins. Concurrent sub-agent builds interleave across the MCP
  // await, so relying on the module global here let a sibling's mode strip a
  // child's tools mid-build. Callers that own a mode MUST pass it.
  return buildEnabledToolSet(mode === undefined ? currentKernelMode : mode);
}

/**
 * Filter an externally-produced ToolSet (e.g. the Agent's `createTools()`
 * output) by kernel enablement.
 *
 * Rules:
 *   1. Tool name belongs to a **disabled** extension → dropped.
 *   2. Tool name belongs to an **enabled** extension but has been
 *      individually disabled via `services.tools.setEnabled` → dropped.
 *   3. Tool name is registered with `modes` and the current kernel mode is
 *      not in that list → dropped (mode gating).
 *   4. Tool name is unknown to the kernel (e.g. an MCP-provided tool whose
 *      owning server isn't mirrored as an extension yet) → passes through.
 */
export function filterToolSetByEnabled(toolSet: ToolSet, mode?: AgentMode | null): ToolSet {
  const effectiveMode = mode === undefined ? currentKernelMode : mode;
  const snapshot = getRegistrySnapshot();
  const knownByName = new Map(snapshot.tools.map((entry) => [entry.name, entry] as const));
  const filtered: ToolSet = {};
  for (const [name, tool] of Object.entries(toolSet)) {
    if (disabledPluginToolNames.has(name)) continue;
    const entry = knownByName.get(name);
    if (entry) {
      if (!isToolEnabled(name)) continue;
      if (isModeFilteredOut(entry.modes, effectiveMode)) continue;
    }
    filtered[name] = tool;
  }
  return filtered;
}

// ── Extension lifecycle ───────────────────────────────────────────────────────

type DisposeCallback = () => void | Promise<void>;

/**
 * Dispose callbacks captured by one activation scope. `running` is shared so
 * a deactivation and a superseded activation that both reach the same scope
 * await one teardown instead of racing it.
 */
interface DisposeScope {
  callbacks: DisposeCallback[];
  running: Promise<void> | null;
}

function createDisposeScope(): DisposeScope {
  return { callbacks: [], running: null };
}

function reportDisposeError(id: string, err: unknown): void {
  console.error(`[extensions] dispose callback for ${id} threw:`, err);
}

/**
 * Run every captured dispose callback once, in reverse registration order,
 * awaiting each returned promise before starting the next. A throwing or
 * rejecting callback is logged and does not skip the rest. Concurrent calls
 * share the in-flight run; once the scope is drained, calls resolve
 * immediately.
 */
function runDisposeCallbacks(scope: DisposeScope, id: string): Promise<void> {
  if (scope.running) return scope.running;
  if (scope.callbacks.length === 0) return Promise.resolve();
  const callbacks = scope.callbacks.splice(0).reverse();
  const running: Promise<void> = (async () => {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (err) {
        reportDisposeError(id, err);
      }
    }
  })().finally(() => {
    if (scope.running === running) scope.running = null;
  });
  scope.running = running;
  return running;
}

/** Run a callback registered after its activation scope was superseded. */
function _runDisposeCallbackNow(callback: DisposeCallback, id: string): void {
  try {
    void Promise.resolve(callback()).catch((err) => reportDisposeError(id, err));
  } catch (err) {
    reportDisposeError(id, err);
  }
}

/** Adapter ids of the model providers an extension currently has registered. */
function ownedProviderAdapterIds(id: string): string[] {
  return getRegistrySnapshot()
    .modelProviders.filter((p) => p.pluginId === id)
    .map((p) => p.id);
}

async function clearExtensionRuntimeState(id: string, capturedAdapterIds: string[] = []): Promise<void> {
  // Capture provider adapter ids BEFORE unregistering so we can dispose their
  // cached ProviderSessions. Without this, disabling a provider extension
  // leaves stale sessions in model-runtime's cache that get reused on
  // re-enable (audit rec #6). Lazy import avoids a static loader <->
  // model-runtime dependency cycle.
  //
  // A native plugin's `deactivate` disposes its fiber, which unregisters its
  // providers itself — so by the time a disable reaches here the registry no
  // longer lists them. The disable path captures them before `deactivate` and
  // passes them in.
  const providerAdapterIds = Array.from(new Set([...capturedAdapterIds, ...ownedProviderAdapterIds(id)]));
  unregisterExtensionContributions(id);
  unregisterExtensionCommandResolvers(id);
  if (providerAdapterIds.length === 0) return;

  try {
    // Await disposal before a later enable can activate the same adapter id.
    // The model runtime snapshots and removes matching cache entries before
    // awaiting disconnect, so this only ever tears down the disabled
    // generation's sessions.
    const { disposeProviderSessionsByAdapter } = await import("./model-runtime");
    await Promise.all(providerAdapterIds.map((adapterId) => disposeProviderSessionsByAdapter(adapterId)));
  } catch (err) {
    console.error(`[extensions] provider session disposal failed for ${id}:`, err);
  }
}

async function activateInstance(instance: PluginInstance): Promise<void> {
  if (instance.status === "active") return;
  if (instance.status === "activating" && instance.activationPromise) return instance.activationPromise;

  const manifest = assertManifest(instance.module.manifest);
  const _services = getHostServices();
  const disposeScope = createDisposeScope();
  const _disposeCallbacks = disposeScope.callbacks;
  const activationToken = instance.activationToken + 1;
  instance.activationToken = activationToken;
  instance.disposeScope = disposeScope;
  instance.active = false;
  instance.status = "activating";
  updatePluginRecord(manifest.id, { active: false, status: "activating", error: undefined });

  const _isCurrentActivation = () => activationToken === instance.activationToken && instance.enabled;
  // The V1 `PluginHostApi` was built here — 200+ lines of registration shims
  // handed to `activate(api)`. Every built-in is a Cordis plugin now and
  // reaches the host through `@codesurf/plugin-api`, so nothing read it: the
  // only `activate` left (the native bridge) ignored its argument entirely.
  // Activation is a plain call.

  const activationPromise: Promise<void> = (async () => {
    try {
      await Promise.resolve(instance.module.activate());
      if (activationToken !== instance.activationToken || !instance.enabled || instance.status !== "activating") {
        // A newer activation or teardown owns the registry now. Its
        // deactivation path has already cleared the old generation's
        // contributions and provider sessions; only release this activation
        // scope's own callbacks here (joining the teardown's run if it is
        // already draining this scope).
        await runDisposeCallbacks(disposeScope, manifest.id);
        return;
      }
      instance.active = true;
      instance.status = "active";
      updatePluginRecord(manifest.id, { active: true, status: "active", error: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[extensions] activation failed for ${manifest.id}:`, err);
      if (activationToken === instance.activationToken && instance.enabled) {
        await clearExtensionRuntimeState(manifest.id);
        await runDisposeCallbacks(disposeScope, manifest.id);
        instance.active = false;
        instance.status = "failed";
        updatePluginRecord(manifest.id, { active: false, status: "failed", error: message });
      } else {
        // A newer generation already owns runtime state. Do not clear it
        // from this stale failure; dispose only the callbacks captured by the
        // stale activation scope.
        await runDisposeCallbacks(disposeScope, manifest.id);
      }
    } finally {
      if (instance.activationToken === activationToken) {
        instance.activationPromise = null;
      }
    }
  })();

  instance.activationPromise = activationPromise;
  return activationPromise;
}

async function deactivateInstance(instance: PluginInstance): Promise<void> {
  if (instance.deactivationPromise) return instance.deactivationPromise;
  if (instance.status === "inactive") return;
  const id = instance.module.manifest.id;
  instance.activationToken += 1;
  const disposeScope = instance.disposeScope;
  instance.disposeScope = createDisposeScope();

  const deactivationPromise = (async () => {
    // Capture contributed tool names BEFORE unregistering so the filter keeps
    // them hidden from the Agent's ToolSet while the extension is disabled.
    for (const toolEntry of getRegistrySnapshot().tools) {
      if (toolEntry.pluginId === id) {
        disabledPluginToolNames.add(toolEntry.name);
      }
    }
    // Likewise the provider adapters: `deactivate` unregisters them, and
    // their cached sessions must still be disposed afterwards.
    const providerAdapterIds = ownedProviderAdapterIds(id);

    await Promise.resolve(instance.module.deactivate?.()).catch((err) => {
      console.error(`[extensions] deactivate failed for ${id}:`, err);
    });
    await runDisposeCallbacks(disposeScope, id);
    await clearExtensionRuntimeState(id, providerAdapterIds);
    instance.active = false;
    instance.status = "inactive";
    updatePluginRecord(id, { active: false, status: "inactive" });
  })();

  instance.deactivationPromise = deactivationPromise;
  try {
    await deactivationPromise;
  } finally {
    if (instance.deactivationPromise === deactivationPromise) {
      instance.deactivationPromise = null;
    }
  }
}

function enabledIdsSnapshot(): string[] {
  return Array.from(instances.values())
    .filter((instance) => instance.enabled)
    .map((instance) => instance.module.manifest.id);
}

/**
 * Run a plugins.json write, reporting instead of throwing.
 *
 * The persistence layer refuses to overwrite a preferences file it cannot
 * read (so defaults never clobber the user's choices). That refusal must not
 * take down bootstrap or a settings toggle: the in-memory state still
 * applies for this session, and the error says how to recover.
 */
function persistSafely(write: () => void): void {
  try {
    write();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}

function persistEnabledState() {
  persistSafely(() => saveEnabledPluginIds(enabledIdsSnapshot()));
}

export async function enablePlugin(id: string): Promise<void> {
  const instance = instances.get(id);
  if (!instance) return;
  if (instance.enabled && instance.status === "active" && !instance.deactivationPromise) return;
  instance.enabled = true;
  updatePluginRecord(id, { enabled: true, error: undefined });
  if (instance.deactivationPromise) await instance.deactivationPromise;
  // A later disable may have superseded this enable while teardown ran.
  if (!instance.enabled) return;
  await activateInstance(instance);
  if (!instance.enabled) return;
  // Clear ghost entries — re-activation will re-register the live metadata.
  for (const toolEntry of getRegistrySnapshot().tools) {
    if (toolEntry.pluginId === id) {
      disabledPluginToolNames.delete(toolEntry.name);
    }
  }
  // Clear any prior explicit opt-out so additive-defaults logic stops
  // forcing this extension off on next boot.
  persistSafely(() => removeDisabledPluginId(id));
  persistEnabledState();
}

export async function disablePlugin(id: string): Promise<void> {
  const instance = instances.get(id);
  if (!instance) return;
  if (instance.module.manifest.protected) return;
  instance.enabled = false;
  await deactivateInstance(instance);
  // A later enable may have superseded this disable while teardown ran.
  if (instance.enabled) return;
  updatePluginRecord(id, { enabled: false });
  // Record an explicit opt-out so additive defaults don't re-enable this
  // on next boot just because its manifest has `enabledByDefault: true`.
  persistSafely(() => addDisabledPluginId(id));
  persistEnabledState();
}

export function listPlugins(): PluginListEntry[] {
  const snapshot = getRegistrySnapshot();
  return snapshot.extensions.map((record) => {
    const id = record.manifest.id;
    const commands = snapshot.commands.filter((c) => c.pluginId === id).length;
    const tools = snapshot.tools.filter((t) => t.pluginId === id).length;
    const models = snapshot.models.filter((m) => m.pluginId === id).length;
    return {
      id,
      title: record.manifest.name,
      description: record.manifest.description,
      group: record.manifest.group,
      source: record.manifest.kind,
      enabled: record.enabled,
      active: record.active,
      status: record.status,
      protected: record.manifest.protected ?? false,
      hidden: record.manifest.hidden ?? false,
      commands,
      tools,
      models,
      error: record.error,
    };
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Load and activate a list of extension modules. Call once at process startup,
 * before the Agent is constructed.
 */
export async function bootstrapPlugins(modules: PluginModule[]): Promise<void> {
  // Load persisted state up front.
  toolOverrides = { ...loadToolOverrides() };
  settingsCache = { ...loadPluginSettings() };

  const persistedEnabled = loadEnabledPluginIds();
  const persistedEnabledSet = persistedEnabled ? new Set(persistedEnabled) : null;
  const persistedDisabledSet = new Set(loadDisabledPluginIds());

  for (const module of modules) {
    const manifest = assertManifest(module.manifest);
    if (instances.has(manifest.id)) {
      console.warn(`[extensions] duplicate extension id: ${manifest.id}`);
      continue;
    }

    // Resolution order (additive defaults so new builtins ship enabled):
    //   1. `protected: true` manifests are always enabled.
    //   2. Explicit user opt-out (`disabled` list) wins over everything.
    //   3. Explicit user opt-in (`enabled` list) flips it on.
    //   4. Otherwise fall back to `manifest.enabledByDefault` — this is the
    //      branch that lets new builtins activate on upgrade even when the
    //      user has a non-null `enabled` list from a prior version.
    const enabled = manifest.protected
      ? true
      : persistedDisabledSet.has(manifest.id)
        ? false
        : persistedEnabledSet?.has(manifest.id)
          ? true
          : manifest.enabledByDefault !== false;

    const instance: PluginInstance = {
      module,
      enabled,
      active: false,
      status: "inactive",
      disposeScope: createDisposeScope(),
      activationToken: 0,
      activationPromise: null,
      deactivationPromise: null,
    };
    instances.set(manifest.id, instance);
    registerPluginRecord({
      manifest,
      enabled,
      active: false,
      status: "inactive",
    });
  }

  for (const instance of instances.values()) {
    if (instance.enabled) await activateInstance(instance);
  }

  // Always persist the resolved enabled set so newly-added builtins show up in
  // the config file after an upgrade. enabledIdsSnapshot() already respects
  // any user disables captured in persistedEnabledSet above.
  persistEnabledState();
}

/**
 * Clear every host-service sink/provider in one place. Each new sink added to
 * the loader (toast, chat, bash, hooks, …) wires through here so the shutdown
 * + test-reset paths don't drift apart. Note: `hostServices`, `currentKernelMode`,
 * and `disabledPluginToolNames` are NOT sinks — those are singleton/state
 * concerns and live alongside the call site.
 */
export function clearAllSinks() {
  resetSinkState();
  mentionProviders.length = 0;
  mentionsIndexByCwd.clear();
}

/** Tear down all extensions — call from graceful shutdown paths. */
/**
 * Teardown callbacks contributed by runtimes layered on top of this loader.
 *
 * The native Cordis bridge registers its root disposal here rather than being
 * imported by the loader: the dependency runs bridge -> loader only, so the
 * loader stays unaware of anything above it.
 */
const runtimeShutdownHooks: Array<() => void | Promise<void>> = [];

/** Register a teardown callback run by `shutdownPlugins` and the test reset. */
export function registerRuntimeShutdownHook(hook: () => void | Promise<void>): void {
  runtimeShutdownHooks.push(hook);
}

async function runRuntimeShutdownHooks(): Promise<void> {
  for (const hook of runtimeShutdownHooks) {
    try {
      await hook();
    } catch (err) {
      console.error("[extensions] runtime shutdown hook failed:", err);
    }
  }
}

export async function shutdownPlugins(): Promise<void> {
  // Reverse boot order so dependents (tools reading the bash sink, UI chips
  // watching provider state) tear down before what they depend on.
  for (const instance of Array.from(instances.values()).reverse()) {
    await deactivateInstance(instance);
  }
  instances.clear();
  settingSubscribers.clear();
  commandResolvers.clear();
  hostServices = null;
  clearAllSinks();
  currentKernelMode = null;
  await runRuntimeShutdownHooks();
}

/** Test helper: reset all loader + registry state without writing to disk. */
export function __resetPluginsForTests() {
  instances.clear();
  toolOverrides = {};
  settingsCache = {};
  settingSubscribers.clear();
  commandResolvers.clear();
  mentionProviders.length = 0;
  mentionsIndexByCwd.clear();
  hostServices = null;
  clearAllSinks();
  disabledPluginToolNames.clear();
  currentKernelMode = null;
  void runRuntimeShutdownHooks();
  __resetRegistryForTests();
}

// Re-export the registry snapshot getter so the agent loop can consume it
// without importing the registry directly.
export { getRegistrySnapshot } from "./registry";
