// Extension kernel — sink state, sink types, and sink-binding setters.
//
// Extracted from loader.ts (2026-06-22 review, §1.3). Owns the mutable sink
// state object that the host (app.tsx, agent.ts, bridge.ts) binds at runtime
// and that `buildHostServices()` in loader.ts reads through. Self-contained:
// no lifecycle, no registry, no services — just typed state + setters.
//
// The `sinks` object is a stable reference. `resetSinkState()` mutates it
// in place (Object.assign) so every module holding a reference sees the
// reset. This avoids the old `let sinks = ...` reassignment pattern that
// would break captured references.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AggregatedHookResult, HookInput } from "../../hooks/index";
import type { McpToolBundle } from "../../mcp/runtime";
import type { BashTool } from "../../tools/bash";
import type {
  ScheduleCreateOptions,
  ScheduleCreateResult,
  ScheduleDaemonStartResult,
  ScheduleDaemonStatus,
  ScheduleDaemonStopResult,
  StoredSchedule,
} from "../../tools/schedule";
import type { TaskRequest, ToolResult } from "../../types/index";
import type { SandboxMode, SandboxSettings } from "../../utils/settings";
import { currentWorkspaceScope } from "../../utils/workspace-scope";
import type {
  ChatDispatchOptions,
  ContextBreakdown,
  ContextStats,
  HostAction,
  HostToast,
  InputInterceptor,
} from "./api";

// ── Sink type definitions ────────────────────────────────────────────────────

export type ChatSink = (prompt: string, options?: ChatDispatchOptions) => Promise<void> | void;

export interface InputSink {
  getValue: () => string;
  getCursor: () => number;
  setValueWithCursor: (value: string, cursor: number) => void;
  insertText: (text: string) => void;
  clear: () => void;
  isFocused: () => boolean;
}

export type TelegramSink = (filePath: string, abortSignal?: AbortSignal) => Promise<ToolResult>;

/** Disposes the cached provider session for the active conversation so the
 *  next turn reconnects fresh (new system prompt, re-scanned Agent Skills
 *  catalogue, etc). Returns whether a session was actually cached/disposed —
 *  `false` means there was nothing to tear down (the next turn just connects
 *  fresh anyway). Bound to `Agent.reconnectProviderSession()`. */
export type SessionReconnectSink = () => Promise<boolean>;

export interface SubagentsSink {
  runTask: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDelegation: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation: (id: string) => Promise<ToolResult>;
  listDelegations: () => Promise<ToolResult>;
}

export interface ScheduleSink {
  create: (options: ScheduleCreateOptions) => Promise<ScheduleCreateResult>;
  list: () => Promise<StoredSchedule[]>;
  remove: (id: string) => Promise<StoredSchedule | null>;
  readLog: (id: string, tail?: number) => Promise<string>;
  getDaemonStatus: () => Promise<ScheduleDaemonStatus>;
  startDaemon: () => Promise<ScheduleDaemonStartResult>;
  stopDaemon: () => Promise<ScheduleDaemonStopResult>;
}

export interface BashSink {
  cwd: () => string;
  execute: (command: string, timeout?: number, abortSignal?: AbortSignal) => Promise<ToolResult>;
  startBackground: (command: string) => Promise<ToolResult>;
  getProcessLogs: (id: number, tail?: number) => Promise<ToolResult>;
  stopProcess: (id: number) => Promise<ToolResult>;
  listProcesses: () => ToolResult;
  spawnChild: (
    initialCwd: string,
    options?: { sandboxMode?: SandboxMode; sandboxSettings?: SandboxSettings },
  ) => BashTool;
  cleanup: () => Promise<void>;
  getSandboxMode: () => SandboxMode;
  setSandboxMode: (mode: SandboxMode) => void;
  getSandboxSettings: () => SandboxSettings;
  setSandboxSettings: (settings: SandboxSettings) => void;
}

export type McpToolBundleProvider = () => Promise<McpToolBundle>;

export interface HooksSink {
  runPre: (
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ) => Promise<AggregatedHookResult>;
  runPost: (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: Record<string, unknown>,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ) => Promise<AggregatedHookResult>;
  runFailure: (
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ) => Promise<AggregatedHookResult>;
  runEvent: (input: HookInput, abortSignal?: AbortSignal) => Promise<AggregatedHookResult>;
}

// ── Sink state ───────────────────────────────────────────────────────────────

export interface LoaderSinkState {
  toast: ((toast: HostToast) => void) | null;
  chat: ((prompt: string, options?: ChatDispatchOptions) => void) | null;
  assistant: ((content: string) => void) | null;
  uiAction: ((action: HostAction) => void) | null;
  input: InputSink | null;
  cwdProvider: (() => string) | null;
  sessionIdProvider: (() => string | null) | null;
  contextStatsProvider: (() => ContextStats | null) | null;
  contextBreakdownProvider: (() => ContextBreakdown | null) | null;
  contextCompactProvider: (() => Promise<boolean>) | null;
  activeModelAdapterIdProvider: (() => string | null) | null;
  keyboardHook: ((handler: (key: import("./api").InputKey) => void) => void) | null;
  telegram: TelegramSink | null;
  sessionReconnect: SessionReconnectSink | null;
  subagents: SubagentsSink | null;
  schedule: ScheduleSink | null;
  bash: BashSink | null;
  mcpToolBundleProvider: McpToolBundleProvider | null;
  hooks: HooksSink | null;
}

function createEmptySinkState(): LoaderSinkState {
  return {
    toast: null,
    chat: null,
    assistant: null,
    uiAction: null,
    input: null,
    cwdProvider: null,
    sessionIdProvider: null,
    contextStatsProvider: null,
    contextBreakdownProvider: null,
    contextCompactProvider: null,
    activeModelAdapterIdProvider: null,
    keyboardHook: null,
    telegram: null,
    sessionReconnect: null,
    subagents: null,
    schedule: null,
    bash: null,
    mcpToolBundleProvider: null,
    hooks: null,
  };
}

/**
 * The mutable sink state. Stable reference — `resetSinkState()` mutates in
 * place so captured references in `buildHostServices()` closures stay valid.
 */
export const sinks: LoaderSinkState = createEmptySinkState();

/** Input interceptors registered via `services.input.intercept`. */
export const inputInterceptors: Set<InputInterceptor> = new Set();

// ── Setters (host binds these at startup / per-turn) ─────────────────────────

export function setToastSink(sink: ((toast: HostToast) => void) | null) {
  sinks.toast = sink;
}

export function setChatSink(sink: ChatSink | null) {
  sinks.chat = sink;
}

export function setAssistantSink(sink: ((content: string) => void) | null) {
  sinks.assistant = sink;
}

export function setUiActionSink(sink: ((action: HostAction) => void) | null) {
  sinks.uiAction = sink;
}

export function setInputSink(sink: InputSink | null) {
  sinks.input = sink;
}

export function setCwdProvider(provider: (() => string) | null) {
  sinks.cwdProvider = provider;
}

export function setSessionIdProvider(provider: (() => string | null) | null) {
  sinks.sessionIdProvider = provider;
}

export function setContextStatsProvider(provider: (() => ContextStats | null) | null) {
  sinks.contextStatsProvider = provider;
}

export function setContextBreakdownProvider(provider: (() => ContextBreakdown | null) | null) {
  sinks.contextBreakdownProvider = provider;
}

export function setContextCompactProvider(provider: (() => Promise<boolean>) | null) {
  sinks.contextCompactProvider = provider;
}

export function setActiveModelAdapterIdProvider(provider: (() => string | null) | null) {
  sinks.activeModelAdapterIdProvider = provider;
}

export function setKeyboardHookProvider(hook: ((handler: (key: import("./api").InputKey) => void) => void) | null) {
  sinks.keyboardHook = hook;
}

/** Unconditional legacy bind. Drops any ownership token so a stale
 *  `releaseTelegramSink` cannot clear what this call installed. */
export function setTelegramSink(sink: TelegramSink | null) {
  telegramSinkOwner = null;
  sinks.telegram = sink;
}

/** Opaque ownership token returned by `acquireTelegramSink`. */
export type TelegramSinkOwnerToken = symbol;

let telegramSinkOwner: TelegramSinkOwnerToken | null = null;

/**
 * Bind the Telegram sink for one turn and return an ownership token. A later
 * `acquireTelegramSink` (a newer turn after `coordinator.reset()`) replaces the
 * sink and takes ownership; the older turn's token no longer matches.
 */
export function acquireTelegramSink(sink: TelegramSink): TelegramSinkOwnerToken {
  const token = Symbol("telegram-sink-owner");
  telegramSinkOwner = token;
  sinks.telegram = sink;
  return token;
}

/**
 * Compare-and-release: clear the sink only while `token` still owns it.
 * Returns `false` (and leaves the current sink untouched) when a newer turn
 * has taken over — a late finalizer must never unbind its successor.
 */
export function releaseTelegramSink(token: TelegramSinkOwnerToken): boolean {
  if (telegramSinkOwner !== token) return false;
  telegramSinkOwner = null;
  sinks.telegram = null;
  return true;
}

// ── Turn-context destination dispatch (NET-6) ────────────────────────────────
//
// Compare-and-release stops a stale finalizer UNBINDING a newer turn's sink.
// It does not stop a stale turn from SENDING: the loader reads whatever sink is
// globally installed, so a tool call still in flight from turn A — because its
// caller passed no abort signal, or its provider ignored `agent.abort()` —
// would deliver into turn B's chat.
//
// The turn's own ownership token is therefore ambient. A send from inside a
// Telegram turn is allowed only while that turn still owns the sink. Callers
// with no ambient turn (the legacy `setTelegramSink` bind, and anything not
// driven by the bridge) are unaffected: there is no turn to fence against, and
// refusing them would break the surface rather than protect it.

const telegramTurnScope = new AsyncLocalStorage<TelegramSinkOwnerToken>();

/** Run a Telegram-driven turn with its sink ownership as ambient context. */
export function runInTelegramTurn<T>(token: TelegramSinkOwnerToken, fn: () => T): T {
  return telegramTurnScope.run(token, fn);
}

/**
 * Whether the calling turn may send to the installed Telegram sink.
 *
 * True outside a Telegram turn (nothing to fence), and inside one only while
 * that turn is still the sink's owner.
 */
export function callerOwnsTelegramSink(): boolean {
  const caller = telegramTurnScope.getStore();
  if (caller === undefined) return true;
  return caller === telegramSinkOwner;
}

export function setSessionReconnectProvider(sink: SessionReconnectSink | null) {
  sinks.sessionReconnect = sink;
}

// Inside a session's workspace scope (a node session), the Agent's bridges bind
// to that scope so sessions never route through each other's Agent. Outside a
// scope they are process-global, last-bind-wins, as before.
export function setSubagentsSink(sink: SubagentsSink | null) {
  const scope = currentWorkspaceScope();
  if (scope) scope.subagents = sink;
  else sinks.subagents = sink;
}

export function setScheduleSink(sink: ScheduleSink | null) {
  const scope = currentWorkspaceScope();
  if (scope) scope.schedule = sink;
  else sinks.schedule = sink;
}

/** The subagents bridge for the calling session: its scope's, else the global. */
export function getSubagentsSink(): SubagentsSink | null {
  const scope = currentWorkspaceScope();
  return scope ? scope.subagents : sinks.subagents;
}

/** The hooks bridge for the calling session: its scope's, else the global. */
export function getHooksSink(): HooksSink | null {
  const scope = currentWorkspaceScope();
  return scope ? scope.hooks : sinks.hooks;
}

export function setBashSink(sink: BashSink | null) {
  sinks.bash = sink;
}

export function setMcpToolBundleProvider(provider: McpToolBundleProvider | null) {
  sinks.mcpToolBundleProvider = provider;
}

/**
 * Read the installed bash sink and MCP provider.
 *
 * Used by the native bridge to compare-and-release: a plugin disposed after a
 * replacement took over must not clear the newer owner's sink.
 */
export function getBashSink(): BashSink | null {
  return sinks.bash ?? null;
}

export function getMcpToolBundleProvider(): McpToolBundleProvider | null {
  return sinks.mcpToolBundleProvider ?? null;
}

export function setHooksSink(sink: HooksSink | null) {
  const scope = currentWorkspaceScope();
  if (scope) scope.hooks = sink;
  else sinks.hooks = sink;
}

// ── Guards + helpers ─────────────────────────────────────────────────────────

const SCHEDULE_NOT_ACTIVE_MESSAGE = "Schedule manager is not active. An Agent must be constructed and the sink bound.";

export function requireScheduleSink(): ScheduleSink {
  const scope = currentWorkspaceScope();
  const schedule = scope ? scope.schedule : sinks.schedule;
  if (!schedule) throw new Error(SCHEDULE_NOT_ACTIVE_MESSAGE);
  return schedule;
}

const BASH_NOT_ACTIVE_MESSAGE = "Bash sink is not active. The builtin bash extension must be active.";

export function requireBashSink(): BashSink {
  // A session's workspace scope carries its own shell.
  const scoped = currentWorkspaceScope()?.bash;
  if (scoped) return scoped;
  if (!sinks.bash) throw new Error(BASH_NOT_ACTIVE_MESSAGE);
  return sinks.bash;
}

export function emptyMcpToolBundle(): McpToolBundle {
  return {
    tools: {},
    serverIds: [],
    toolCountsByServerId: new Map(),
    listResources: async () => [],
    listPrompts: async () => [],
    readResource: async () => null,
    getPrompt: async () => null,
    errors: [],
    close: async () => {},
  };
}

export function emptyHookResult(): AggregatedHookResult {
  return {
    blocked: false,
    blockingErrors: [],
    preventContinuation: false,
    additionalContexts: [],
    results: [],
  };
}

export function noopKeyboardHook(_handler: (key: import("./api").InputKey) => void): void {}

/**
 * Run all registered input interceptors against a key. Returns `true` if any
 * interceptor swallowed the key. Iteration order = registration order; first
 * `true` short-circuits. Thrown interceptors are logged and treated as
 * `false` so a single crashy extension can't lock up the input.
 */
export function dispatchInputInterceptors(key: import("./api").InputKey): boolean {
  for (const handler of inputInterceptors) {
    try {
      if (handler(key)) return true;
    } catch (err) {
      console.error("[extensions] input interceptor threw:", err);
    }
  }
  return false;
}

/**
 * Reset all sinks to their unbound state + clear input interceptors. Called
 * by `clearAllSinks()` in loader.ts during shutdown / test reset. Mutates the
 * stable `sinks` object in place so captured references stay valid.
 */
export function resetSinkState() {
  Object.assign(sinks, createEmptySinkState());
  telegramSinkOwner = null;
  inputInterceptors.clear();
}
