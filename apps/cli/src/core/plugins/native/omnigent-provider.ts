// Builtin Omnigent provider.
//
// Bridges CodeSurf turns into an Omnigent backend session:
//   POST /v1/sessions                 -> create persistent Omnigent session
//   GET  /v1/sessions/{id}/stream     -> live SSE stream
//   POST /v1/sessions/{id}/events     -> user message / interrupt

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { workspaceRoot } from "../../../utils/workspace-scope";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { usageFromRecord } from "../builtin/provider-usage";

const execFileAsync = promisify(execFile);

const EXTENSION_ID = "builtin.provider-omnigent";
const PROVIDER_ID = "omnigent";
const ADAPTER_ID = "omnigent.server";

const BASE_URL_SETTING = `${ADAPTER_ID}.baseUrl`;
const API_KEY_SETTING = `${ADAPTER_ID}.apiKey`;
const AUTO_START_SETTING = `${ADAPTER_ID}.autoStart`;
const CLI_SETTING = `${ADAPTER_ID}.cli`;
const DATA_DIR_SETTING = `${ADAPTER_ID}.dataDir`;
const HOST_ID_SETTING = `${ADAPTER_ID}.hostId`;
const AGENT_ID_SETTING = `${ADAPTER_ID}.agentId`;
const AGENT_NAME_SETTING = `${ADAPTER_ID}.agentName`;
const MODEL_OVERRIDE_SETTING = `${ADAPTER_ID}.modelOverride`;
const TIMEOUT_MS_SETTING = `${ADAPTER_ID}.timeoutMs`;

const FALLBACK_MODEL_ID = "omnigent:default";
const MODEL_PREFIX = "omnigent:";
const DEFAULT_CLI = "omni";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:6767";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

interface OmnigentAgentSpec {
  id: string;
  name: string;
  description?: string;
  harness?: string;
}

interface OmnigentServerStatus {
  running?: boolean;
  url?: string | null;
  pid?: number | null;
  port?: number | null;
  log_path?: string | null;
  live_sessions?: number | null;
  daemon_attached?: boolean | null;
}

interface OmnigentHostSpec {
  id: string;
  name?: string;
  status?: string;
}

type CliRunner = (command: string, args: string[], env: Record<string, string>) => Promise<string>;

function normalizeServerRoot(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "") || DEFAULT_LOCAL_BASE_URL;
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${normalizeServerRoot(baseUrl)}${path}`;
}

function docsUrl(baseUrl: string): string {
  return endpointUrl(baseUrl, "/docs");
}

function healthUrl(baseUrl: string): string {
  return endpointUrl(baseUrl, "/health");
}

function encodeOmnigentModelId(agentId: string): string {
  return `${MODEL_PREFIX}${encodeURIComponent(agentId)}`;
}

function decodeOmnigentModelId(modelId: string): string | null {
  if (modelId === FALLBACK_MODEL_ID) return null;
  if (!modelId.startsWith(MODEL_PREFIX)) return null;
  const encoded = modelId.slice(MODEL_PREFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseOmnigentServerUrl(output: string): string | null {
  const match = output.match(/https?:\/\/[^\s)]+/i);
  return match ? normalizeServerRoot(match[0]!) : null;
}

function parseOmnigentStatusJson(output: string): OmnigentServerStatus | null {
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1));
    return parsed && typeof parsed === "object" ? (parsed as OmnigentServerStatus) : null;
  } catch {
    return null;
  }
}

function cliEnv(dataDir: string): Record<string, string> {
  return dataDir.trim() ? { OMNIGENT_DATA_DIR: dataDir.trim() } : {};
}

async function defaultCliRunner(command: string, args: string[], env: Record<string, string>): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
  const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "");
  return `${stdout}${stderr ? `\n${stderr}` : ""}`;
}

async function readLocalOmnigentStatus(
  cli: string,
  dataDir: string,
  runner: CliRunner = defaultCliRunner,
): Promise<OmnigentServerStatus | null> {
  const output = await runner(cli, ["server", "status", "--json"], cliEnv(dataDir));
  return parseOmnigentStatusJson(output);
}

async function startLocalOmnigentServer(
  cli: string,
  dataDir: string,
  runner: CliRunner = defaultCliRunner,
): Promise<string> {
  const output = await runner(cli, ["server", "start"], cliEnv(dataDir));
  const fromStart = parseOmnigentServerUrl(output);
  if (fromStart) return fromStart;
  const status = await readLocalOmnigentStatus(cli, dataDir, runner);
  if (status?.running && status.url) return normalizeServerRoot(status.url);
  throw new Error("Omnigent server start did not report a server URL.");
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};
}

async function fetchJson(
  baseUrl: string,
  path: string,
  apiKey: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(endpointUrl(baseUrl, path), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(apiKey),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: init.signal ?? abortController.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `${path} returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseOmnigentAgents(payload: unknown): OmnigentAgentSpec[] {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.agents)
        ? record.agents
        : [];

  return rows
    .map((item): OmnigentAgentSpec | null => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const id = typeof row?.id === "string" ? row.id.trim() : "";
      if (!id) return null;
      const name = typeof row?.name === "string" && row.name.trim() ? row.name.trim() : id;
      const description =
        typeof row?.description === "string" && row.description.trim() ? row.description.trim() : undefined;
      const harness = typeof row?.harness === "string" && row.harness.trim() ? row.harness.trim() : undefined;
      return { id, name, description, harness };
    })
    .filter((item): item is OmnigentAgentSpec => item !== null);
}

function parseOmnigentHosts(payload: unknown): OmnigentHostSpec[] {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(record.hosts)
      ? record.hosts
      : Array.isArray(record.data)
        ? record.data
        : [];

  return rows
    .map((item): OmnigentHostSpec | null => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const id =
        typeof row?.host_id === "string" ? row.host_id.trim() : typeof row?.id === "string" ? row.id.trim() : "";
      if (!id) return null;
      const name = typeof row?.name === "string" && row.name.trim() ? row.name.trim() : undefined;
      const status = typeof row?.status === "string" && row.status.trim() ? row.status.trim() : undefined;
      return { id, name, status };
    })
    .filter((item): item is OmnigentHostSpec => item !== null);
}

function chooseOmnigentHost(hosts: OmnigentHostSpec[]): OmnigentHostSpec | null {
  return hosts.find((host) => host.status === "online") ?? hosts[0] ?? null;
}

function toRegisteredModels(agents: OmnigentAgentSpec[] = []): ModelSpec[] {
  const models: ModelSpec[] = [
    {
      id: FALLBACK_MODEL_ID,
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      label: "Omnigent default",
      description:
        "Route turns through the configured Omnigent backend. Uses the selected Omnigent agent setting, or the first available backend agent.",
      capabilities: { tools: true, reasoning: true, images: false },
    },
  ];

  for (const agent of agents) {
    models.push({
      id: encodeOmnigentModelId(agent.id),
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      label: agent.name,
      description: [agent.description, agent.harness ? `Harness: ${agent.harness}.` : ""].filter(Boolean).join(" "),
      capabilities: { tools: true, reasoning: true, images: false },
    });
  }
  return models;
}

async function fetchOmnigentAgents(baseUrl: string, apiKey: string, timeoutMs: number): Promise<OmnigentAgentSpec[]> {
  const payload = await fetchJson(baseUrl, "/v1/agents?limit=100&order=asc", apiKey, timeoutMs);
  return parseOmnigentAgents(payload);
}

async function fetchOmnigentHosts(baseUrl: string, apiKey: string, timeoutMs: number): Promise<OmnigentHostSpec[]> {
  const payload = await fetchJson(baseUrl, "/v1/hosts", apiKey, timeoutMs);
  return parseOmnigentHosts(payload);
}

function usageFromValue(value: unknown): ProviderUsageSnapshot | undefined {
  return usageFromRecord(value);
}

function usageFromResponseEvent(event: Record<string, unknown>): ProviderUsageSnapshot | undefined {
  const response =
    event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : null;
  return usageFromValue(response?.usage);
}

function failureMessageFromEvent(event: Record<string, unknown>): string {
  const response =
    event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : null;
  const error =
    response?.error && typeof response.error === "object" ? (response.error as Record<string, unknown>) : null;
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof event.error === "string" && event.error.trim()) return event.error.trim();
  return "Omnigent turn failed.";
}

function omnigentFunctionCallId(item: Record<string, unknown>): string | null {
  const callId = typeof item.call_id === "string" && item.call_id.trim() ? item.call_id.trim() : null;
  if (callId) return callId;
  return typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
}

function parseOmnigentToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Surface the raw string if the backend ever sends non-JSON arguments.
    return raw;
  }
}

function mapOmnigentEvent(
  raw: unknown,
  controller: ProviderStreamController,
): { terminal?: "done" | "error"; usage?: ProviderUsageSnapshot; error?: string; ready?: boolean } {
  const event = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const type = typeof event?.type === "string" ? event.type : "";

  switch (type) {
    case "session.heartbeat":
      return { ready: true };
    case "session.status": {
      const status = typeof event?.status === "string" ? event.status : "";
      if (status)
        controller.emit({ type: "status", status: status === "failed" ? "error" : "streaming", message: status });
      if (status === "failed") {
        const error =
          event?.error && typeof event.error === "object"
            ? String((event.error as Record<string, unknown>).message ?? "Omnigent session failed.")
            : "Omnigent session failed.";
        controller.emit({ type: "error", message: error });
        return { terminal: "error", error };
      }
      return {};
    }
    case "session.usage": {
      const usage = usageFromValue({
        input_tokens: event?.context_tokens,
        output_tokens: undefined,
      });
      if (usage) controller.emit({ type: "usage", usage });
      return { usage };
    }
    case "response.output_text.delta": {
      const delta = typeof event?.delta === "string" ? event.delta : "";
      if (delta) controller.emit({ type: "text-delta", delta });
      return {};
    }
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta": {
      const delta = typeof event?.delta === "string" ? event.delta : "";
      if (delta) controller.emit({ type: "reasoning-delta", delta });
      return {};
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      // Tool calls arrive as Responses-API output items. The item is a flat dict
      // merging common fields (id, type, status) with type-specific data. Field
      // shapes are verified against the Omnigent backend source of truth:
      //   - omnigent/server/schemas.py OutputItemDoneEvent (function_call example:
      //     {id, type:"function_call", status, name, arguments (JSON string), call_id})
      //   - omnigent/entities/conversation.py FunctionCallData (name, arguments,
      //     call_id) and FunctionCallOutputData (call_id, output)
      // The server publishes these as `response.output_item.done` (sessions.py); a
      // captured live outbound /stream byte sample was NOT exercised, but the
      // backend's own Databricks gateway fixture confirms `arguments` arrive fully
      // on `.done` (not as an incremental `function_call_arguments.delta`). Mirrors
      // the daemon's mapOmnigentStreamEvent.
      const item = event?.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
      const itemType = typeof item?.type === "string" ? item.type : "";
      // Emit the tool-call once, on `.done`, where `arguments` is fully populated.
      // The `.added` event (args not yet available) is ignored to avoid a doubled chip.
      if (item && itemType === "function_call" && type === "response.output_item.done") {
        const id = omnigentFunctionCallId(item);
        if (id) {
          const toolName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "tool";
          controller.emit({ type: "tool-call", id, toolName, args: parseOmnigentToolArgs(item.arguments) });
        }
        return {};
      }
      if (item && itemType === "function_call_output" && type === "response.output_item.done") {
        const id = omnigentFunctionCallId(item);
        if (id) {
          const result = typeof item.output === "string" ? item.output : (item.output ?? "");
          controller.emit({ type: "tool-result", id, result });
        }
        return {};
      }
      // message / reasoning items + the function_call `.added` event are ignored;
      // their text/reasoning content is surfaced via the delta cases above.
      return {};
    }
    case "response.completed": {
      const usage = usageFromResponseEvent(event ?? {});
      if (usage) controller.emit({ type: "usage", usage });
      controller.emit({ type: "done", stopReason: "complete" });
      return { terminal: "done", usage };
    }
    case "response.cancelled": {
      controller.emit({ type: "done", stopReason: "cancelled" });
      return { terminal: "done" };
    }
    case "response.incomplete": {
      const usage = usageFromResponseEvent(event ?? {});
      if (usage) controller.emit({ type: "usage", usage });
      controller.emit({ type: "done", stopReason: "incomplete" });
      return { terminal: "done", usage };
    }
    case "response.failed": {
      const message = failureMessageFromEvent(event ?? {});
      controller.emit({ type: "error", message });
      return { terminal: "error", error: message, usage: usageFromResponseEvent(event ?? {}) };
    }
    default:
      return {};
  }
}

function parseSseChunk(chunk: string): { eventName: string | null; data: string | null } {
  const eventLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("event:"))
    .map((line) => line.slice(6).trim());
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return {
    eventName: eventLines[0] ?? null,
    data: dataLines.length > 0 ? dataLines.join("\n") : null,
  };
}

async function readOmnigentSseStream(
  stream: ReadableStream<Uint8Array>,
  controller: ProviderStreamController,
  signal: AbortSignal,
): Promise<{ usage?: ProviderUsageSnapshot }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalUsage: ProviderUsageSnapshot | undefined;
  const throwIfAborted = () => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      throwIfAborted();
      const { done, value } = await reader.read();
      throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const { eventName, data } = parseSseChunk(chunk);
        if (data === "[DONE]") return { usage: finalUsage };
        if (data) {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const event = eventName && typeof parsed.type !== "string" ? { ...parsed, type: eventName } : parsed;
            const result = mapOmnigentEvent(event, controller);
            if (result.usage) finalUsage = { ...(finalUsage ?? {}), ...result.usage };
            if (result.terminal === "done") return { usage: finalUsage };
            if (result.terminal === "error") throw new Error(result.error ?? "Omnigent turn failed.");
          } catch (err) {
            // One malformed frame must not end the turn: an `error` event is
            // terminal for the host, so skip the frame and keep reading.
            if (!(err instanceof SyntaxError)) {
              throw err;
            }
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    return { usage: finalUsage };
  } finally {
    signal.removeEventListener("abort", cancelReader);
    // Returning on `[DONE]` / a terminal event leaves the SSE body open;
    // cancel it so the connection is released with the turn.
    cancelReader();
    reader.releaseLock();
  }
}

function extractSessionId(payload: unknown): string | null {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  for (const key of ["id", "session_id", "conversation_id"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested =
    record?.session && typeof record.session === "object" ? (record.session as Record<string, unknown>) : null;
  const nestedId = nested?.id ?? nested?.session_id ?? nested?.conversation_id;
  return typeof nestedId === "string" && nestedId.trim() ? nestedId.trim() : null;
}

/**
 * Join the two tasks of one Omnigent turn. The first rejection aborts the
 * shared controller (cancelling the sibling's fetch / reader), then both are
 * awaited so nothing outlives the turn. The first failure is the one reported;
 * the sibling's derived AbortError is swallowed.
 */
async function joinTurnTasks<T>(post: Promise<void>, stream: Promise<T>, abortController: AbortController): Promise<T> {
  const failure: { failed: boolean; error: unknown } = { failed: false, error: undefined };
  const own = <R>(task: Promise<R>): Promise<R> =>
    task.catch((err: unknown) => {
      if (!failure.failed) {
        failure.failed = true;
        failure.error = err;
      }
      abortController.abort();
      throw err;
    });
  const [, streamResult] = await Promise.allSettled([own(post), own(stream)]);
  if (failure.failed) throw failure.error;
  if (streamResult.status === "rejected") throw streamResult.reason;
  return streamResult.value;
}

function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine || "CodeSurf session";
}

class OmnigentSession implements ProviderSession {
  readonly adapterId = ADAPTER_ID;
  readonly providerId = PROVIDER_ID;
  readonly mode = "persistent" as const;
  readonly strategy = "per-conversation" as const;

  private sessionId: string | null = null;
  private autoStartedBaseUrl: string | null = null;
  private activeAbort: AbortController | null = null;
  private disconnected = false;

  constructor(
    private readonly resolvers: {
      baseUrl: () => string;
      apiKey: () => string;
      autoStart: () => boolean;
      cli: () => string;
      dataDir: () => string;
      hostId: () => string;
      agentId: () => string;
      agentName: () => string;
      modelOverride: () => string;
      timeoutMs: () => number;
      cliRunner?: CliRunner;
    },
  ) {}

  sendTurn = async (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    if (this.disconnected) throw new Error("Omnigent session has been disconnected.");
    if (this.activeAbort) throw new Error("Omnigent session already has an active turn.");

    const baseUrl = await this.ensureBaseUrl(true);
    const apiKey = this.resolvers.apiKey();
    const timeoutMs = this.resolvers.timeoutMs();

    controller.emit({ type: "status", status: "connecting", message: "Connecting to Omnigent" });

    if (!this.sessionId) {
      this.sessionId = await this.createSession(input, baseUrl, apiKey, timeoutMs);
    }
    const sessionId = this.sessionId;

    const abortController = new AbortController();
    this.activeAbort = abortController;
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const onHostAbort = () => abortController.abort();
    if (input.abortSignal?.aborted) abortController.abort();
    else input.abortSignal?.addEventListener("abort", onHostAbort, { once: true });

    try {
      const streamResponse = await fetch(endpointUrl(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/stream`), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...authHeaders(apiKey),
        },
        signal: abortController.signal,
      });
      if (!streamResponse.ok || !streamResponse.body) {
        const text = await streamResponse.text().catch(() => "");
        throw new Error(text || `Omnigent stream returned HTTP ${streamResponse.status}`);
      }

      const streamPromise = readOmnigentSseStream(streamResponse.body, controller, abortController.signal);
      controller.emit({ type: "status", status: "streaming", message: "Omnigent streaming" });

      // One turn scope: the reader and the POST are siblings. Whichever fails
      // first aborts the other, and both are joined before ownership is
      // released — a rejected POST must not leave the reader open and emitting
      // after sendTurn has already failed.
      return await joinTurnTasks(
        this.postMessageEvent(sessionId, input.prompt, baseUrl, apiKey, timeoutMs, abortController.signal),
        streamPromise,
        abortController,
      );
    } catch (err) {
      // The auto-started server may have died; rediscover it next turn.
      if (!abortController.signal.aborted) this.autoStartedBaseUrl = null;
      const message = err instanceof Error ? err.message : String(err);
      controller.emit({ type: "error", message });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener("abort", onHostAbort);
      // Tear down anything still bound to this turn (the stream fetch).
      abortController.abort();
      this.activeAbort = null;
    }
  };

  abortTurn = async (): Promise<void> => {
    const sessionId = this.sessionId;
    const abort = this.activeAbort;
    if (!sessionId || !abort) return;
    abort.abort();
    try {
      const baseUrl = await this.ensureBaseUrl(false);
      await fetch(endpointUrl(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(this.resolvers.apiKey()),
        },
        body: JSON.stringify({ type: "interrupt", data: {} }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Local stream abort already happened; remote interrupt is best effort.
    }
  };

  disconnect = async (): Promise<void> => {
    this.disconnected = true;
    this.activeAbort?.abort();
    this.activeAbort = null;
  };

  private async ensureBaseUrl(allowStart: boolean): Promise<string> {
    const configured = this.resolvers.baseUrl().trim();
    if (configured) return normalizeServerRoot(configured);
    if (this.autoStartedBaseUrl) return this.autoStartedBaseUrl;
    if (allowStart && this.resolvers.autoStart()) {
      // `omni server start` is an execFile round trip; run it once per session.
      this.autoStartedBaseUrl = await startLocalOmnigentServer(
        this.resolvers.cli(),
        this.resolvers.dataDir(),
        this.resolvers.cliRunner,
      );
      return this.autoStartedBaseUrl;
    }
    const status = await readLocalOmnigentStatus(
      this.resolvers.cli(),
      this.resolvers.dataDir(),
      this.resolvers.cliRunner,
    );
    if (status?.running && status.url) return normalizeServerRoot(status.url);
    throw new Error("Omnigent server is not running. Run `omni server start`, or enable Omnigent auto-start.");
  }

  private async resolveAgentId(
    input: ProviderTurnInput,
    baseUrl: string,
    apiKey: string,
    timeoutMs: number,
  ): Promise<string> {
    const fromModel = decodeOmnigentModelId(input.modelId);
    if (fromModel) return fromModel;
    const configuredId = this.resolvers.agentId().trim();
    if (configuredId) return configuredId;

    const agents = await fetchOmnigentAgents(baseUrl, apiKey, timeoutMs);
    const configuredName = this.resolvers.agentName().trim().toLowerCase();
    if (configuredName) {
      const byName = agents.find(
        (agent) => agent.name.toLowerCase() === configuredName || agent.id.toLowerCase() === configuredName,
      );
      if (byName) return byName.id;
      throw new Error(`Omnigent agent not found: ${this.resolvers.agentName()}`);
    }
    const first = agents[0];
    if (!first) throw new Error("Omnigent did not return any agents from /v1/agents.");
    return first.id;
  }

  private async createSession(
    input: ProviderTurnInput,
    baseUrl: string,
    apiKey: string,
    timeoutMs: number,
  ): Promise<string> {
    const agentId = await this.resolveAgentId(input, baseUrl, apiKey, timeoutMs);
    const hostId = await this.resolveHostId(baseUrl, apiKey, timeoutMs);
    const modelOverride = this.resolvers.modelOverride().trim();
    const body: Record<string, unknown> = {
      agent_id: agentId,
      title: titleFromPrompt(input.prompt),
      workspace: workspaceRoot(),
    };
    if (hostId) body.host_id = hostId;
    if (modelOverride) body.model_override = modelOverride;

    const payload = await fetchJson(baseUrl, "/v1/sessions", apiKey, timeoutMs, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const sessionId = extractSessionId(payload);
    if (!sessionId) throw new Error("Omnigent session create response did not include an id.");
    return sessionId;
  }

  private async resolveHostId(baseUrl: string, apiKey: string, timeoutMs: number): Promise<string | null> {
    const configuredHostId = this.resolvers.hostId().trim();
    if (configuredHostId) return configuredHostId;
    try {
      return chooseOmnigentHost(await fetchOmnigentHosts(baseUrl, apiKey, timeoutMs))?.id ?? null;
    } catch {
      return null;
    }
  }

  private async postMessageEvent(
    sessionId: string,
    prompt: string,
    baseUrl: string,
    apiKey: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const modelOverride = this.resolvers.modelOverride().trim();
    const body: Record<string, unknown> = {
      type: "message",
      data: {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    };
    if (modelOverride) body.model_override = modelOverride;

    await fetchJson(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`, apiKey, timeoutMs, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
  }
}

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  const baseUrl = ctx.settings.get<string>(BASE_URL_SETTING, "")?.trim() ?? "";
  if (baseUrl) return { ok: true };
  const autoStart = ctx.settings.get<boolean>(AUTO_START_SETTING, true) !== false;
  if (!autoStart) {
    return {
      ok: false,
      reason: "Omnigent base URL is blank and auto-start is disabled.",
      needsUserAction: "install-cli",
    };
  }
  return { ok: true };
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Omnigent",
  version: "1.0.0",
  description:
    "Provider adapter for an Omnigent backend service. Starts the local omni server on demand and streams Omnigent session events into CodeSurf.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: false,
  capabilities: ["provider-adapters", "models", "settings", "commands"],
  // Advisory metadata only: in-process extension modules are not sandboxed.
};

export const omnigentProviderPlugin: CodesurfPlugin = {
  name: "codesurf-omnigent-provider",
  manifest,
  inject: ["contributions", "settings", "chat", "ui", "session"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BASE_URL_SETTING,
        title: "Omnigent base URL",
        description: "Omnigent server root URL. Leave blank to auto-start or discover the local omni server.",
        type: "string",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: API_KEY_SETTING,
        title: "Omnigent bearer token",
        description: "Optional bearer token for auth-enabled Omnigent servers.",
        type: "secret",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: AUTO_START_SETTING,
        title: "Auto-start local Omnigent server",
        description: "Run `omni server start` when this provider is used and no base URL is configured.",
        type: "boolean",
        default: true,
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: CLI_SETTING,
        title: "Omnigent CLI command",
        description: "Command used for local server status/start.",
        type: "string",
        default: DEFAULT_CLI,
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: DATA_DIR_SETTING,
        title: "Omnigent data directory",
        description: "Optional OMNIGENT_DATA_DIR for the local omni CLI process.",
        type: "string",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: HOST_ID_SETTING,
        title: "Omnigent host id",
        description: "Host to launch Omnigent runners on. Leave blank to use the first online host from /v1/hosts.",
        type: "string",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: AGENT_ID_SETTING,
        title: "Omnigent agent id",
        description:
          "Agent id to use when the fallback Omnigent model row is selected. Blank uses agent name or first available agent.",
        type: "string",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: AGENT_NAME_SETTING,
        title: "Omnigent agent name",
        description: "Agent name/id to resolve when no explicit agent id is configured.",
        type: "string",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: MODEL_OVERRIDE_SETTING,
        title: "Omnigent model override",
        description: "Optional per-session/per-turn LLM model override forwarded to Omnigent.",
        type: "string",
        default: "",
        section: "Omnigent",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TIMEOUT_MS_SETTING,
        title: "Omnigent turn timeout (ms)",
        description: "Maximum time to wait for a turn stream before aborting.",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        section: "Omnigent",
      }),
    );

    const resolveBaseUrl = (): string => settings.get<string>(BASE_URL_SETTING, "")?.trim() ?? "";
    const resolveApiKey = (): string => settings.get<string>(API_KEY_SETTING, "")?.trim() ?? "";
    const resolveAutoStart = (): boolean => settings.get<boolean>(AUTO_START_SETTING, true) !== false;
    const resolveCli = (): string => settings.get<string>(CLI_SETTING, DEFAULT_CLI)?.trim() || DEFAULT_CLI;
    const resolveDataDir = (): string => settings.get<string>(DATA_DIR_SETTING, "")?.trim() ?? "";
    const resolveHostId = (): string => settings.get<string>(HOST_ID_SETTING, "")?.trim() ?? "";
    const resolveAgentId = (): string => settings.get<string>(AGENT_ID_SETTING, "")?.trim() ?? "";
    const resolveAgentName = (): string => settings.get<string>(AGENT_NAME_SETTING, "")?.trim() ?? "";
    const resolveModelOverride = (): string => settings.get<string>(MODEL_OVERRIDE_SETTING, "")?.trim() ?? "";
    const resolveTimeoutMs = (): number => {
      const raw = settings.get<unknown>(TIMEOUT_MS_SETTING, DEFAULT_TIMEOUT_MS);
      return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
    };

    ctx.effect(async () =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Omnigent",
        description:
          "HTTP/SSE bridge to Omnigent sessions. Uses /v1/agents for models, /v1/sessions for session creation, and /stream for turn output.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "sse",
        connectionMode: "persistent",
        sessionStrategy: "per-conversation",
        capabilities: { streaming: true, tools: true, images: false, reasoning: true },
        models: toRegisteredModels(),
        listModels: async () => {
          const configured = resolveBaseUrl();
          if (!configured) return [];
          try {
            const agents = await fetchOmnigentAgents(configured, resolveApiKey(), Math.min(resolveTimeoutMs(), 10_000));
            return toRegisteredModels(agents);
          } catch {
            return [];
          }
        },
        auth: { mode: "none", check: checkCredential },
        adapter: {
          connect: (): ProviderSession =>
            new OmnigentSession({
              baseUrl: resolveBaseUrl,
              apiKey: resolveApiKey,
              autoStart: resolveAutoStart,
              cli: resolveCli,
              dataDir: resolveDataDir,
              hostId: resolveHostId,
              agentId: resolveAgentId,
              agentName: resolveAgentName,
              modelOverride: resolveModelOverride,
              timeoutMs: resolveTimeoutMs,
            }),
        },
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/omnigent",
        aliases: ["/omni"],
        description: "Show Omnigent server status, agents, docs URL, or start the local server.",
        argsHint: "[status|agents|docs|start]",
        handler: async ({ args }) => {
          const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
          const configuredBaseUrl = resolveBaseUrl();
          const apiKey = resolveApiKey();
          const timeoutMs = Math.min(resolveTimeoutMs(), 10_000);

          if (subcommand === "docs") {
            ctx.chat.appendAssistant(`Omnigent docs: ${docsUrl(configuredBaseUrl || DEFAULT_LOCAL_BASE_URL)}`);
            return;
          }

          if (subcommand === "start") {
            try {
              const baseUrl = configuredBaseUrl || (await startLocalOmnigentServer(resolveCli(), resolveDataDir()));
              ctx.chat.appendAssistant(`Omnigent server: ${baseUrl}\nDocs: ${docsUrl(baseUrl)}`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              ctx.chat.appendAssistant(`Omnigent server start failed: ${message}`);
            }
            return;
          }

          if (subcommand === "agents") {
            try {
              const baseUrl = configuredBaseUrl || (await startLocalOmnigentServer(resolveCli(), resolveDataDir()));
              const agents = await fetchOmnigentAgents(baseUrl, apiKey, timeoutMs);
              const lines = agents.map((agent) =>
                [agent.name, `id=${agent.id}`, agent.harness ? `harness=${agent.harness}` : ""]
                  .filter(Boolean)
                  .join("  "),
              );
              ctx.chat.appendAssistant(
                lines.length > 0 ? `Omnigent agents\n${lines.join("\n")}` : "No Omnigent agents returned.",
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              ctx.chat.appendAssistant(`Omnigent agents unavailable: ${message}`);
            }
            return;
          }

          if (subcommand !== "status") {
            ctx.chat.appendAssistant("Usage: /omnigent [status|agents|docs|start]");
            return;
          }

          const lines = ["Omnigent"];
          if (configuredBaseUrl) {
            lines.push(`Base URL: ${normalizeServerRoot(configuredBaseUrl)}`);
            try {
              const health = await fetchJson(configuredBaseUrl, "/health", apiKey, timeoutMs);
              lines.push("Health: ok", formatJsonSummary(health));
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              lines.push(`Health: unavailable (${message})`);
            }
          } else {
            try {
              const status = await readLocalOmnigentStatus(resolveCli(), resolveDataDir());
              lines.push(`Background server: ${status?.running ? "running" : "not running"}`);
              if (status?.url) lines.push(`Base URL: ${normalizeServerRoot(status.url)}`);
              if (status?.pid) lines.push(`PID: ${status.pid}`);
              if (status?.log_path) lines.push(`Log: ${status.log_path}`);
              if (typeof status?.live_sessions === "number") lines.push(`Live sessions: ${status.live_sessions}`);
              if (typeof status?.daemon_attached === "boolean") {
                lines.push(`Host daemon attached: ${status.daemon_attached ? "yes" : "no"}`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              lines.push(`Background server status unavailable: ${message}`);
            }
          }
          ctx.chat.appendAssistant(lines.filter(Boolean).join("\n"));
        },
      }),
    );
  },
};

function formatJsonSummary(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "ok");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 8);
  return keys.map((key) => `${key}: ${JSON.stringify(record[key])}`).join("\n");
}

export {
  checkCredential,
  chooseOmnigentHost,
  decodeOmnigentModelId,
  docsUrl,
  encodeOmnigentModelId,
  endpointUrl,
  FALLBACK_MODEL_ID,
  fetchOmnigentAgents,
  fetchOmnigentHosts,
  healthUrl,
  mapOmnigentEvent,
  normalizeServerRoot,
  OmnigentSession,
  parseOmnigentAgents,
  parseOmnigentHosts,
  parseOmnigentServerUrl,
  parseOmnigentStatusJson,
  readOmnigentSseStream,
  startLocalOmnigentServer,
  toRegisteredModels,
};
