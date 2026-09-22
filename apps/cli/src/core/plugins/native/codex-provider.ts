// Builtin OpenAI Codex provider.
//
// Drives `codex app-server` (newline-delimited JSON-RPC over stdio) as an
// owning adapter via ProviderSession.sendTurn — the same shape as the Claude
// Agent SDK provider. Implements the recipe in the `codex-provider-extension`
// skill against the protocol documented in `codex-app-server` (verified vs the
// generated TS bindings, Codex CLI 0.134).
//
// Lifecycle (singleton per conversation):
//   spawn `codex app-server` → initialize → thread/start → per turn:
//   turn/start, stream ServerNotifications as ProviderStreamEvents, resolve on
//   the turn/completed notification. Auth is the codex CLI's ChatGPT/OpenAI
//   OAuth flow (`codex login`) — advertise oauth mode + wire startAuth so the
//   host can trigger sign-in when logged out.
//
// Framing: one compact JSON object per line. Requests {method,id,params};
// responses {id,result|error}; notifications {method,params}; server requests
// (approvals) {method,id,params} which MUST be answered.

import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderStreamEvent,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { isBinaryInstalled } from "../../../utils/binary-on-path";
import { cachedCliCheck } from "../../../utils/cli-check-cache";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { usageFromRecord } from "../builtin/provider-usage";

const EXTENSION_ID = "builtin.provider-codex";
const PROVIDER_ID = "openai";
const ADAPTER_ID = "openai.codex-app-server";
const CODEX_BIN = "codex";

const SANDBOX_SETTING = `${ADAPTER_ID}.sandbox`;
const APPROVAL_SETTING = `${ADAPTER_ID}.approvalPolicy`;
const EFFORT_SETTING = `${ADAPTER_ID}.effort`;

const DEFAULT_SANDBOX = "workspace-write";
const SANDBOX_OPTIONS = [
  { value: "read-only", label: "Read-only" },
  { value: "workspace-write", label: "Workspace write (default)" },
  { value: "danger-full-access", label: "Full access (no sandbox)" },
];
const DEFAULT_APPROVAL = "on-request";
const APPROVAL_OPTIONS = [
  { value: "untrusted", label: "Untrusted — approve most commands" },
  { value: "on-failure", label: "On failure" },
  { value: "on-request", label: "On request (default)" },
  { value: "never", label: "Never — auto-run in sandbox" },
];
const DEFAULT_EFFORT = "medium";
const EFFORT_OPTIONS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium (default)" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

// Small inline fallback used only if a live `model/list` call fails. The live
// list is authoritative (account/plan dependent).
const FALLBACK_MODELS: ModelSpec[] = [
  {
    id: "gpt-6-astra",
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: "GPT-6 Astra",
    description: "OpenAI Codex (GPT-6 Astra) via `codex app-server`.",
    capabilities: { tools: true, reasoning: true, images: true },
  },
];

// ── NDJSON-RPC client over the codex app-server subprocess ──────────────────

type JsonValue = unknown;
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { code?: number; message?: string };
}

type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
type ServerRequestHandler = (id: number | string, method: string, params: Record<string, unknown>) => void;
/** Fired once when the child terminates on its own (exit, close, or spawn
 *  error). Not fired for a deliberate `stop()`. */
type ExitHandler = (err: Error) => void;

/** Spawn seam — the only thing the transport needs from `node:child_process`.
 *  Tests inject a fake child (EventEmitter + PassThrough stdio). */
export type CodexSpawn = (
  bin: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

const defaultSpawn: CodexSpawn = (bin, args, options) => spawn(bin, args, options) as ChildProcessWithoutNullStreams;

/** Deadline for request/reply RPCs (initialize, thread/start, model/list,
 *  turn/interrupt). `turn/start` is deliberately unbounded: its lifetime is the
 *  turn's, which is settled by turn/completed, host abort, or child exit. */
export const CODEX_RPC_TIMEOUT_MS = 30_000;
/** How long `stop()` waits for the child to close after SIGTERM before
 *  escalating to SIGKILL (and again before giving up). */
export const CODEX_STOP_GRACE_MS = 2_000;
/** Bytes of stderr retained for diagnostics. The pipe is always drained so a
 *  chatty child can never block on a full stderr buffer. */
const STDERR_TAIL_BYTES = 8 * 1024;

interface PendingRequest {
  resolve: (v: JsonValue) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
  onReply?: (v: JsonValue) => void;
}

interface RequestOptions {
  /** Reply deadline; `null` disables it (only `turn/start`, see below). */
  timeoutMs?: number | null;
  /**
   * Invoked synchronously when the reply is dispatched, before the promise
   * settles. Notifications that follow the reply in the same stdout chunk are
   * dispatched before any promise continuation runs, so state that must be in
   * place for them (a turn's upstream id) has to be recorded here.
   */
  onReply?: (result: JsonValue) => void;
}

function waitWithDeadline(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    (timer as { unref?: () => void }).unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** Resolves when the current child's stdio has fully closed. */
  private closed: Promise<void> = Promise.resolve();
  /** Detaches the current child so a deliberate stop does not report an exit. */
  private detach: (() => void) | null = null;
  private stderrTail = "";
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private onNotification: NotificationHandler = () => {};
  private onServerRequest: ServerRequestHandler = () => {};
  private onExit: ExitHandler = () => {};

  constructor(private readonly options: { bin?: string; spawn?: CodexSpawn } = {}) {}

  setHandlers(onNotification: NotificationHandler, onServerRequest: ServerRequestHandler, onExit?: ExitHandler): void {
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    if (onExit) this.onExit = onExit;
  }

  start(): void {
    if (this.child) return;
    const spawnChild = this.options.spawn ?? defaultSpawn;
    const child = spawnChild(this.options.bin ?? CODEX_BIN, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";

    // Exactly one terminal report per child: spawn error, exit, or close —
    // whichever lands first. A deliberate `stop()` detaches first so the owner
    // is not told about an exit it asked for.
    let live = true;
    const settle = (err: Error) => {
      if (!live) return;
      live = false;
      if (this.child === child) this.child = null;
      this.rejectPending(err);
      this.onExit(err);
    };
    this.detach = () => {
      live = false;
    };
    this.closed = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        settle(this.exitError(code, signal));
        resolve();
      });
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Late output from a replaced child must not reach the new child's owner.
      if (this.child === child) this.ingest(chunk);
    });
    // Always drain stderr (bounded) so the child can never stall on a full pipe.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // stdin errors (EPIPE after the child died) are reported through the exit
    // path; without a listener they would be unhandled 'error' events.
    child.stdin.on("error", () => {});
    // Asynchronous spawn failure (ENOENT surfaces here, not from spawn()).
    child.on("error", (err) => settle(new Error(`codex app-server failed to start: ${err.message}`)));
    child.on("exit", (code, signal) => settle(this.exitError(code, signal)));
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const why = signal ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
    const detail = this.stderrTail.trim();
    return new Error(`codex app-server ${why}${detail ? `\n${detail}` : ""}`);
  }

  private rejectPending(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.dispatch(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // ignore non-JSON noise
    }
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message ?? "codex rpc error"));
        else {
          entry.onReply?.(msg.result);
          entry.resolve(msg.result);
        }
      }
      return;
    }
    // Server-initiated request (approval) — has both method and id.
    if (msg.method && msg.id !== undefined) {
      this.onServerRequest(msg.id, msg.method, (msg.params as Record<string, unknown>) ?? {});
      return;
    }
    // Notification — method, no id.
    if (msg.method) {
      this.onNotification(msg.method, (msg.params as Record<string, unknown>) ?? {});
    }
  }

  /**
   * Send a request and await its reply. `timeoutMs` bounds the wait (default
   * `CODEX_RPC_TIMEOUT_MS`); pass `null` only for `turn/start`, whose reply is
   * bounded by the turn lifecycle instead.
   */
  request(method: string, params: JsonValue, options: RequestOptions = {}): Promise<JsonValue> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("codex app-server not started"));
    const timeoutMs = options.timeoutMs === undefined ? CODEX_RPC_TIMEOUT_MS : options.timeoutMs;
    const id = this.nextId++;
    const payload = `${JSON.stringify({ method, id, params })}\n`;
    return new Promise<JsonValue>((resolve, reject) => {
      const fail = (err: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      };
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs !== null && timeoutMs > 0) {
        timer = setTimeout(() => fail(new Error(`codex ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }
      this.pending.set(id, { resolve, reject, timer, onReply: options.onReply });
      child.stdin.write(payload, (err) => {
        if (err) fail(err);
      });
    });
  }

  /** Reply to a server-initiated request (e.g. an approval) by echoing its id. */
  respond(id: number | string, result: JsonValue): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`, () => {});
  }

  /**
   * Terminate the child and wait for its stdio to close: SIGTERM, then SIGKILL
   * after `CODEX_STOP_GRACE_MS`, then give up after one more grace period so a
   * wedged child can never hang disposal. Outstanding requests are rejected
   * immediately; the owner is not sent an exit report for a stop it asked for.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.detach?.();
    this.detach = null;
    this.child = null;
    const closed = this.closed;
    this.rejectPending(new Error("codex app-server stopped"));
    try {
      child.kill();
    } catch {
      // best-effort
    }
    if (await waitWithDeadline(closed, CODEX_STOP_GRACE_MS)) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort
    }
    await waitWithDeadline(closed, CODEX_STOP_GRACE_MS);
  }
}

// Pure Codex notification → ProviderStreamEvent mapping. Stateless so it can be
// unit-tested against canned NDJSON lines with no subprocess. Stateful concerns
// (turn id capture, usage retention, turn resolution) stay in the session.
export function mapCodexNotification(method: string, params: Record<string, unknown>): ProviderStreamEvent[] {
  const delta = typeof params.delta === "string" ? params.delta : "";
  switch (method) {
    case "item/agentMessage/delta":
      return delta ? [{ type: "text-delta", delta }] : [];
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return delta ? [{ type: "reasoning-delta", delta }] : [];
    case "thread/tokenUsage/updated":
      return [{ type: "usage", usage: usageFromTokens(params) }];
    case "item/started": {
      const event = toolCallEventFromItem(params.item);
      return event ? [event] : [];
    }
    case "item/completed": {
      const event = toolResultEventFromItem(params.item);
      return event ? [event] : [];
    }
    case "error": {
      // v2 ErrorNotification: { error: TurnError { message }, willRetry, threadId, turnId }.
      const error = isRecord(params.error) ? params.error : null;
      const message = String(error?.message ?? params.message ?? "codex error");
      // Codex is retrying the request itself; the turn is still live.
      if (params.willRetry === true) return [{ type: "status", status: "streaming", message: `Retrying: ${message}` }];
      return [{ type: "error", message }];
    }
    case "turn/completed":
      return [{ type: "done", stopReason: "stop" }];
    default:
      return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" ? value : undefined;
}

function toolCallEventFromItem(item: unknown): Extract<ProviderStreamEvent, { type: "tool-call" }> | null {
  if (!isRecord(item)) return null;
  const id = stringField(item, "id");
  const type = stringField(item, "type");
  if (!id || !type) return null;

  switch (type) {
    case "commandExecution":
      return {
        type: "tool-call",
        id,
        toolName: "command",
        args: {
          command: stringField(item, "command") ?? "",
          cwd: stringField(item, "cwd") ?? "",
          source: item.source,
        },
      };
    case "fileChange":
      return {
        type: "tool-call",
        id,
        toolName: "fileChange",
        args: {
          changes: Array.isArray(item.changes) ? item.changes : [],
          status: item.status,
        },
      };
    case "mcpToolCall": {
      const server = stringField(item, "server");
      const tool = stringField(item, "tool") ?? "mcpToolCall";
      return {
        type: "tool-call",
        id,
        toolName: server ? `${server}.${tool}` : tool,
        args: item.arguments ?? {},
      };
    }
    case "dynamicToolCall": {
      const namespace = stringField(item, "namespace");
      const tool = stringField(item, "tool") ?? "dynamicToolCall";
      return {
        type: "tool-call",
        id,
        toolName: namespace ? `${namespace}.${tool}` : tool,
        args: item.arguments ?? {},
      };
    }
    case "collabAgentToolCall":
      return {
        type: "tool-call",
        id,
        toolName: stringField(item, "tool") ?? "collabAgentToolCall",
        args: {
          prompt: item.prompt ?? null,
          model: item.model ?? null,
          reasoningEffort: item.reasoningEffort ?? null,
          receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [],
        },
      };
    case "webSearch":
      return {
        type: "tool-call",
        id,
        toolName: "webSearch",
        args: { query: stringField(item, "query") ?? "", action: item.action ?? null },
      };
    case "imageGeneration":
      return {
        type: "tool-call",
        id,
        toolName: "imageGeneration",
        args: { revisedPrompt: item.revisedPrompt ?? null },
      };
    default:
      return null;
  }
}

function toolResultEventFromItem(item: unknown): Extract<ProviderStreamEvent, { type: "tool-result" }> | null {
  if (!isRecord(item)) return null;
  const id = stringField(item, "id");
  const type = stringField(item, "type");
  if (!id || !type) return null;

  switch (type) {
    case "commandExecution": {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      return {
        type: "tool-result",
        id,
        result: {
          output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
          exitCode,
          status: item.status,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        },
        isError: exitCode !== null && exitCode !== 0,
      };
    }
    case "fileChange":
      return {
        type: "tool-result",
        id,
        result: {
          changes: Array.isArray(item.changes) ? item.changes : [],
          status: item.status,
        },
        isError: typeof item.status === "string" && /fail|error|reject/i.test(item.status),
      };
    case "mcpToolCall":
      return {
        type: "tool-result",
        id,
        result: item.error ?? item.result ?? { status: item.status },
        isError: item.error !== null && item.error !== undefined,
      };
    case "dynamicToolCall":
      return {
        type: "tool-result",
        id,
        result: {
          contentItems: Array.isArray(item.contentItems) ? item.contentItems : [],
          status: item.status,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        },
        isError: item.success === false,
      };
    case "collabAgentToolCall":
      return {
        type: "tool-result",
        id,
        result: {
          status: item.status,
          receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [],
          agentsStates: isRecord(item.agentsStates) ? item.agentsStates : {},
        },
        isError: typeof item.status === "string" && /fail|error|cancel/i.test(item.status),
      };
    case "webSearch":
      return {
        type: "tool-result",
        id,
        result: { query: stringField(item, "query") ?? "", action: item.action ?? null },
        isError: false,
      };
    case "imageGeneration":
      return {
        type: "tool-result",
        id,
        result: {
          status: item.status,
          result: item.result ?? null,
          savedPath: item.savedPath ?? null,
          revisedPrompt: item.revisedPrompt ?? null,
        },
        isError: typeof item.status === "string" && /fail|error|cancel/i.test(item.status),
      };
    default:
      return null;
  }
}

// ── ProviderSession ─────────────────────────────────────────────────────────

function usageFromTokens(params: Record<string, unknown>): ProviderUsageSnapshot {
  // Callers ({ type: "usage", usage } events and `this.usage`) require a
  // snapshot, never undefined — keep the `{}` fallback.
  return usageFromRecord((params.usage as Record<string, unknown>) ?? params) ?? {};
}

/** Per-turn state. One is created per `sendTurn`; it owns the controller,
 *  learns its upstream turn id from the `turn/start` reply (or `turn/started`),
 *  and remembers a host cancellation that arrived before that id was known so
 *  the interrupt can still be sent once it is. */
interface CodexTurn {
  readonly controller: ProviderStreamController;
  turnId: string | null;
  /** `turn/start` was written and its reply has not arrived yet. */
  startPending: boolean;
  cancelled: boolean;
  interruptSent: boolean;
  settled: boolean;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Bound on remembered retired turn ids (each is dropped again on its own
 *  `turn/completed`; this only guards against a server that never sends one). */
const MAX_RETIRED_TURN_IDS = 64;

/** Upstream turn identity carried by a notification, if any. */
function notificationTurnId(params: Record<string, unknown>): string | null {
  if (typeof params.turnId === "string") return params.turnId;
  const turn = params.turn;
  if (isRecord(turn) && typeof turn.id === "string") return turn.id;
  return null;
}

export class CodexSession implements ProviderSession {
  readonly adapterId = ADAPTER_ID;
  readonly providerId = PROVIDER_ID;
  readonly mode = "persistent" as const;
  readonly strategy = "singleton" as const;

  private readonly server: CodexAppServer;
  private initialized = false;
  private threadId: string | null = null;
  private connecting: Promise<void> | null = null;
  /** The live turn — at most one per session. */
  private turn: CodexTurn | null = null;
  /** Turns retired (cancelled/failed) locally before their `turn/start` reply
   *  arrived. While any exist, `turn/started` cannot safely name the live turn. */
  private readonly orphanedStarts = new Set<CodexTurn>();
  /** Upstream ids of turns retired locally whose output may still arrive. */
  private readonly retiredTurnIds = new Set<string>();
  private usage: ProviderUsageSnapshot = {};
  // Maps the approvalId we hand the host back to the codex server-request id.
  private readonly approvals = new Map<string, number | string>();

  constructor(
    private readonly ctx: ProviderConnectionContext,
    options: { spawn?: CodexSpawn } = {},
  ) {
    this.server = new CodexAppServer({ spawn: options.spawn });
    this.server.setHandlers(
      (method, params) => this.handleNotification(method, params),
      (id, method, params) => this.handleServerRequest(id, method, params),
      (err) => this.handleTransportExit(err),
    );
  }

  private ensureConnected(modelId: string): Promise<void> {
    if (this.threadId) return Promise.resolve();
    // `warm()` and the first `sendTurn` can overlap; share one handshake so
    // they don't send two `initialize`s or open two threads.
    if (!this.connecting) {
      this.connecting = this.connect(modelId).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(modelId: string): Promise<void> {
    this.server.start();
    if (!this.initialized) {
      await this.server.request("initialize", {
        clientInfo: { name: "codesurf", title: "Codesurf", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.initialized = true;
    }
    const sandbox = this.ctx.settings.get<string>(SANDBOX_SETTING, DEFAULT_SANDBOX);
    const approvalPolicy = this.ctx.settings.get<string>(APPROVAL_SETTING, DEFAULT_APPROVAL);
    const res = (await this.server.request("thread/start", {
      model: modelId,
      cwd: process.cwd(),
      sandbox,
      approvalPolicy,
    })) as { thread?: { id?: string } };
    this.threadId = res?.thread?.id ?? null;
    if (!this.threadId) throw new Error("codex thread/start returned no thread id");
  }

  /** Spawn `codex app-server` and open the thread ahead of the first turn.
   *  See `ProviderSession.warm`. Measured cost being moved off the first
   *  message: ~3.0s from `sendTurn` to the first streamed event. Swallows
   *  errors — `sendTurn` calls `ensureConnected` again and reports there. */
  async warm(): Promise<void> {
    if (this.threadId) return;
    try {
      await this.ensureConnected(this.ctx.modelId ?? FALLBACK_MODELS[0].id);
    } catch {
      // Non-fatal: the real turn retries and surfaces the failure with a
      // controller attached.
    }
  }

  async sendTurn(
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> {
    // One live turn per session. Claim the slot synchronously so two
    // overlapping sends cannot both pass this check while connecting.
    if (this.turn) throw new Error("codex: a turn is already in progress for this session");
    const turn: CodexTurn = {
      controller,
      turnId: null,
      startPending: false,
      cancelled: false,
      interruptSent: false,
      settled: false,
      resolve: () => {},
      reject: () => {},
    };
    const done = new Promise<void>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    // A transport exit can reject `done` while we are still awaiting the
    // connect below; mark it handled so that is never an unhandled rejection.
    done.catch(() => {});
    this.turn = turn;
    try {
      await this.ensureConnected(input.modelId);
      // Already-aborted at entry: a listener registered now would never fire, so
      // bail before starting a turn. (`addEventListener("abort")` does not
      // re-fire for an already-aborted signal.)
      if (input.abortSignal?.aborted) {
        this.settleTurn(turn);
        return { usage: this.usage };
      }
      this.usage = {};
      const effort = this.ctx.settings.get<string>(EFFORT_SETTING, DEFAULT_EFFORT);
      controller.emit({ type: "status", status: "streaming" });

      // Host interrupt (Esc / Agent.abort) → cancel this turn: interrupt
      // upstream (now, or once its id is known) and release `done`.
      const onHostAbort = () => this.cancelTurn(turn);
      input.abortSignal?.addEventListener("abort", onHostAbort, { once: true });
      try {
        turn.startPending = true;
        // `turn/start` replies with the turn's upstream id, recorded in stream
        // order via `onReply`. The request is detached from `done` on purpose:
        // a cancelled turn still needs the reply so the interrupt can be sent
        // and its late output retired.
        this.server
          .request(
            "turn/start",
            {
              threadId: this.threadId,
              input: [{ type: "text", text: input.prompt, text_elements: [] }],
              model: input.modelId,
              effort,
            },
            { timeoutMs: null, onReply: (res) => this.onTurnStartReply(turn, res) },
          )
          .catch((err) => this.onTurnStartFailed(turn, err instanceof Error ? err : new Error(String(err))));
        await done;
      } finally {
        input.abortSignal?.removeEventListener("abort", onHostAbort);
      }
      return { usage: this.usage };
    } finally {
      if (this.turn === turn) this.turn = null;
    }
  }

  private onTurnStartReply(turn: CodexTurn, res: JsonValue): void {
    turn.startPending = false;
    const wasOrphaned = this.orphanedStarts.delete(turn);
    const id = (res as { turn?: { id?: unknown } } | null)?.turn?.id;
    if (typeof id !== "string") return; // fall back to `turn/started`
    if (turn.turnId === null) turn.turnId = id;
    // Retired before its id was known: its late output must be dropped.
    if (wasOrphaned) this.retireTurnId(turn.turnId);
    if (turn.cancelled) this.interruptUpstream(turn);
  }

  private onTurnStartFailed(turn: CodexTurn, err: Error): void {
    turn.startPending = false;
    this.orphanedStarts.delete(turn);
    this.failTurn(turn, err);
  }

  private interruptUpstream(turn: CodexTurn): void {
    if (turn.interruptSent || !turn.turnId || !this.threadId) return;
    turn.interruptSent = true;
    this.server.request("turn/interrupt", { threadId: this.threadId, turnId: turn.turnId }).catch(() => {});
  }

  private retireTurnId(turnId: string): void {
    this.retiredTurnIds.add(turnId);
    while (this.retiredTurnIds.size > MAX_RETIRED_TURN_IDS) {
      const oldest = this.retiredTurnIds.values().next().value;
      if (oldest === undefined) break;
      this.retiredTurnIds.delete(oldest);
    }
  }

  /** Mark a turn finished locally. Not a normal completion ⇒ its upstream
   *  output may still arrive, so remember its identity (or that it has none yet). */
  private retire(turn: CodexTurn, completed: boolean): boolean {
    if (turn.settled) return false;
    turn.settled = true;
    if (this.turn === turn) this.turn = null;
    if (!completed) {
      if (turn.turnId !== null) this.retireTurnId(turn.turnId);
      else if (turn.startPending) this.orphanedStarts.add(turn);
    }
    return true;
  }

  private settleTurn(turn: CodexTurn, completed = false): void {
    if (this.retire(turn, completed)) turn.resolve();
  }

  private failTurn(turn: CodexTurn, err: Error): void {
    if (this.retire(turn, false)) turn.reject(err);
  }

  /** Host cancellation: interrupt upstream (deferred until the id is known)
   *  and release the turn to the host without waiting for the acknowledgement. */
  private cancelTurn(turn: CodexTurn): void {
    if (turn.cancelled) return;
    turn.cancelled = true;
    this.interruptUpstream(turn);
    this.settleTurn(turn);
  }

  private handleTransportExit(err: Error): void {
    const turn = this.turn;
    // The server is gone: nothing can answer an outstanding approval, and the
    // thread it hosted no longer exists. The next `sendTurn` re-spawns.
    this.approvals.clear();
    this.threadId = null;
    this.initialized = false;
    if (turn) this.failTurn(turn, err);
  }

  /** Resolve which live turn a notification/request belongs to, or `null` if
   *  it is from another thread, a retired turn, or an unknown one. */
  private routeToTurn(method: string, params: Record<string, unknown>): CodexTurn | null {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (threadId && this.threadId && threadId !== this.threadId) return null;
    const turnId = notificationTurnId(params);
    if (turnId !== null && this.retiredTurnIds.has(turnId)) {
      if (method === "turn/completed") this.retiredTurnIds.delete(turnId);
      return null;
    }
    const turn = this.turn;
    if (!turn) return null;
    if (turnId === null) return turn; // thread-level notification (e.g. error without a turn)
    if (turn.turnId === null) {
      // Identity normally arrives on the `turn/start` reply. `turn/started` may
      // name the live turn only when no retired turn is still awaiting its own
      // reply — otherwise this could be that turn's start, not ours.
      if (method !== "turn/started" || this.orphanedStarts.size > 0) return null;
      turn.turnId = turnId;
      if (turn.cancelled) this.interruptUpstream(turn);
      return turn;
    }
    return turn.turnId === turnId ? turn : null;
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turn = this.routeToTurn(method, params);
    if (!turn) return;
    if (method === "thread/tokenUsage/updated") this.usage = usageFromTokens(params);
    // Stateless event production via the shared mapper.
    for (const event of mapCodexNotification(method, params)) turn.controller.emit(event);
    if (method === "turn/completed") this.settleTurn(turn, true);
    else if (method === "error" && params.willRetry !== true) this.settleTurn(turn);
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    const turn = this.routeToTurn(method, params);
    // Approval-style server requests → surface through the host's permission UI.
    if (method.endsWith("requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval") {
      if (!turn) {
        // Retired or unknown turn: nobody can answer, so unblock codex now.
        this.server.respond(id, { decision: "decline" });
        return;
      }
      const approvalId = `codex-${id}`;
      this.approvals.set(approvalId, id);
      const toolName = typeof params.command === "string" ? "command" : "fileChange";
      turn.controller.emit({ type: "tool-approval-request", approvalId, toolName, input: params });
      return;
    }
    // Anything else we don't handle: respond defensively so codex isn't blocked.
    this.server.respond(id, {});
  }

  respondToToolApproval(approvalId: string, approved: boolean): void {
    const serverId = this.approvals.get(approvalId);
    if (serverId === undefined) return;
    this.approvals.delete(approvalId);
    // v2 CommandExecutionApprovalDecision: accept | decline.
    this.server.respond(serverId, { decision: approved ? "accept" : "decline" });
  }

  abortTurn(): void {
    const turn = this.turn;
    if (turn) this.cancelTurn(turn);
  }

  async disconnect(): Promise<void> {
    const turn = this.turn;
    if (turn) this.failTurn(turn, new Error("codex session disconnected"));
    this.approvals.clear();
    this.threadId = null;
    this.initialized = false;
    await this.server.stop();
  }
}

// ── Auth + model list ───────────────────────────────────────────────────────

/** Bound on the asynchronous `codex login status` probe. */
export const CODEX_LOGIN_PROBE_TIMEOUT_MS = 5_000;

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: (Error & { code?: unknown }) | null) => void,
) => unknown;

export interface CodexCredentialCheckDeps {
  /** Executable probed — the same one the session spawns. */
  bin?: string;
  /** Auth file written by `codex login` (default `~/.codex/auth.json`). */
  authFile?: string;
  /** Test seam for the bounded asynchronous probe. */
  execFile?: ExecFileLike;
  timeoutMs?: number;
}

interface LoginProbe {
  promise: Promise<CredentialStatus>;
  result: CredentialStatus | null;
}

const CODEX_NOT_INSTALLED: CredentialStatus = {
  ok: false,
  reason: "Codex CLI not found. Install it, then sign in with `codex login`.",
  needsUserAction: "install-cli",
};
const CODEX_LOGGED_OUT: CredentialStatus = {
  ok: false,
  reason: "Not signed in to Codex. Run `codex login` to authenticate with your ChatGPT/OpenAI account.",
  needsUserAction: "start-oauth",
};

/**
 * Credential check. Codex auth is the ChatGPT/OpenAI OAuth flow driven by
 * `codex login`, which writes the auth file on success. Distinguish "CLI
 * missing" (install) from "logged out" (start the OAuth flow) so the host
 * opens the right remediation.
 *
 * Runs on the render-path credential loop, so the sync answers are a file stat
 * and a PATH stat. Only when the auth file is absent but the CLI is present
 * does it fall back to `codex login status` — asynchronously, bounded by
 * `timeoutMs`, and cached through the shared CLI-check cache so the probe runs
 * at most once per TTL. While the probe is in flight the check returns its
 * promise (sync callers treat that as "not ready yet"); once it has settled,
 * the cached result is returned synchronously.
 */
export function createCodexCredentialCheck(
  deps: CodexCredentialCheckDeps = {},
): () => CredentialStatus | Promise<CredentialStatus> {
  const bin = deps.bin ?? CODEX_BIN;
  const authFile = deps.authFile ?? join(homedir(), ".codex", "auth.json");
  const run = deps.execFile ?? (execFile as unknown as ExecFileLike);
  const timeoutMs = deps.timeoutMs ?? CODEX_LOGIN_PROBE_TIMEOUT_MS;

  const startProbe = (): LoginProbe => {
    const entry: LoginProbe = { promise: Promise.resolve(CODEX_LOGGED_OUT), result: null };
    entry.promise = new Promise<CredentialStatus>((resolve) => {
      try {
        run(bin, ["login", "status"], { timeout: timeoutMs }, (err) => {
          if (!err) resolve({ ok: true });
          else resolve(err.code === "ENOENT" ? CODEX_NOT_INSTALLED : CODEX_LOGGED_OUT);
        });
      } catch {
        resolve(CODEX_LOGGED_OUT);
      }
    }).then((status) => {
      entry.result = status;
      return status;
    });
    return entry;
  };

  return () => {
    if (existsSync(authFile)) return { ok: true };
    if (!isBinaryInstalled(bin)) return CODEX_NOT_INSTALLED;
    const entry = cachedCliCheck(`codex-login-status:${bin}`, startProbe);
    return entry.result ?? entry.promise;
  };
}

const checkCodexLogin = createCodexCredentialCheck();

// Kick off the Codex OAuth flow. Bare `codex login` opens the browser-based
// ChatGPT/OpenAI sign-in and writes ~/.codex/auth.json on success. Spawned
// detached so the TUI isn't blocked; the next `check()` poll picks up the
// new credentials. Best-effort — failures surface on the next check.
function startCodexLogin(): void {
  try {
    const child = spawn(CODEX_BIN, ["login"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Best-effort: if the spawn fails, `check()` keeps reporting logged-out.
  }
}

// ── Extension module ────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Codex (app-server)",
  version: "1.0.0",
  description: "OpenAI Codex models via a persistent `codex app-server` subprocess. Auth delegated to the codex CLI.",
  group: CODESURF_PROVIDERS_GROUP,
  enabledByDefault: false,
  protected: false,
  capabilities: ["provider-adapters", "models", "settings"],
  // Advisory metadata only: in-process extension modules are not sandboxed.
};

export const codexProviderPlugin: CodesurfPlugin = {
  name: "codesurf-codex-provider",
  manifest,
  inject: ["contributions", "settings"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: SANDBOX_SETTING,
        title: "Codex sandbox",
        description: "Sandbox policy codex uses for model-run shell commands.",
        type: "select",
        default: DEFAULT_SANDBOX,
        section: "Codex",
        options: SANDBOX_OPTIONS,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: APPROVAL_SETTING,
        title: "Codex approval policy",
        description: "When codex asks the host to approve a command/patch. 'never' auto-runs in the sandbox.",
        type: "select",
        default: DEFAULT_APPROVAL,
        section: "Codex",
        options: APPROVAL_OPTIONS,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: EFFORT_SETTING,
        title: "Codex reasoning effort",
        description: "Reasoning effort sent with each turn.",
        type: "select",
        default: DEFAULT_EFFORT,
        section: "Codex",
        options: EFFORT_OPTIONS,
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Codex (app-server)",
        description: "Persistent `codex app-server` subprocess. Auth delegated to the codex CLI login.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "stdio",
        connectionMode: "persistent",
        sessionStrategy: "singleton",
        capabilities: { streaming: true, tools: true, images: true, reasoning: true },
        auth: { mode: "oauth", check: checkCodexLogin, startAuth: startCodexLogin },
        listModels: async (): Promise<ModelSpec[]> => {
          const probe = new CodexAppServer();
          try {
            probe.start();
            await probe.request("initialize", {
              clientInfo: { name: "codesurf", title: "Codesurf", version: "0.1.0" },
              capabilities: { experimentalApi: true, requestAttestation: false },
            });
            const res = (await probe.request("model/list", { limit: 100 })) as {
              data?: Array<Record<string, unknown>>;
            };
            const data = res?.data ?? [];
            if (data.length === 0) return FALLBACK_MODELS;
            return data
              .filter((m) => m.hidden !== true)
              .map((m) => ({
                id: String(m.id ?? m.model ?? ""),
                providerId: PROVIDER_ID,
                adapterId: ADAPTER_ID,
                label: String(m.displayName ?? m.id ?? "Codex"),
                description: String(m.description ?? "OpenAI Codex via codex app-server."),
                capabilities: { tools: true, reasoning: true, images: true },
              }))
              .filter((m) => m.id.length > 0);
          } catch {
            return FALLBACK_MODELS;
          } finally {
            await probe.stop();
          }
        },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => new CodexSession(ctx),
        },
      }),
    );
  },
};
