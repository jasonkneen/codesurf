// Builtin Codesurf daemon provider.
//
// Streams chat turns through the locally-running shared CodeSurf daemon
// (`codesurfd`) using the same HTTP + SSE contract the desktop app uses:
//
//   POST /chat/job/start        → { id, status, ... }
//   GET  /chat/job/events?jobId → text/event-stream of `data: <json>\n\n`
//   POST /chat/job/cancel       → { ok }
//   GET  /health                → { ok: true }
//
// The daemon is shared by the CodeSurf desktop app and this CLI. The provider
// attaches to an existing daemon when one is already running, and otherwise
// uses the same @codesurf/daemon manager as the TUI to start it.
//
// Each `sendTurn` posts ONE new chat job and consumes its event stream.
// Conversation continuity comes from the `sessionId` the daemon emits and
// records in job metadata. We keep it in memory for the live process and
// recover it from the daemon dashboard when a fresh provider session starts.
// There's no socket-level persistence — `sessionId` IS the persistent
// connection, server-side.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
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
import {
  CODESURF_HOME,
  type DaemonStatusInfo,
  daemonBinaryAvailable,
  getCodesurfDaemonBridge,
} from "../../../daemon/codesurf-daemon";
import {
  findLatestDaemonSessionIdForCard,
  patchDaemonJobSession,
  patchDaemonTimelineSession,
} from "../../../daemon/session-repair";
import { saveLastCardId } from "../../../storage/index";
import { workspaceRoot } from "../../../utils/workspace-scope";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { stringifyContent } from "../builtin/openai-chat-utils";
import { getTileSessionContext, type TileSessionContext } from "../tile-state-integration";

const EXTENSION_ID = "builtin.provider-codesurf-desktop";
const PROVIDER_ID = "codesurf";
const ADAPTER_ID = "codesurf.daemon";

// Settings keys (scoped to adapter id; immutable once shipped).
const EXECUTION_TARGET_SETTING = `${ADAPTER_ID}.executionTarget`;
const RUN_MODE_SETTING = `${ADAPTER_ID}.runMode`;
const PERMISSION_MODE_SETTING = `${ADAPTER_ID}.permissionMode`;
const HOME_OVERRIDE_SETTING = `${ADAPTER_ID}.codesurfHome`;
// When set, jobs are submitted under this cardId so they appear in the
// matching desktop tile's chat. Blank => synthesize `codesurf-<conv>` and
// run as an isolated CLI conversation (no desktop visibility). Sessions that
// previously synthesized `grok-cli-<conv>` are still recoverable via the
// legacy-prefix fallback in readDaemonSessionId / findLatestDaemonSessionId.
const CARD_ID_SETTING = `${ADAPTER_ID}.cardId`;
const SYNTHESIZED_CARD_ID_PREFIX = "codesurf-";
const LEGACY_SYNTHESIZED_CARD_ID_PREFIX = "grok-cli-";

const DEFAULT_EXECUTION_TARGET = "local" as const;
const DEFAULT_RUN_MODE = "foreground" as const;
const DEFAULT_PERMISSION_MODE = "default" as const;

type ExecutionTarget = "local" | "cloud";
type RunMode = "foreground" | "background";
type PermissionMode = "default" | "bypassPermissions" | "acceptEdits" | "plan" | "dontAsk" | "auto";

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Ask for tool permissions" },
  { value: "bypassPermissions", label: "Always approve (yolo)" },
  { value: "dontAsk", label: "Use saved grants only" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan/read-only" },
  { value: "auto", label: "Auto" },
];

// ── Daemon discovery ─────────────────────────────────────────────────────────

type DaemonPidInfo = DaemonStatusInfo;

/**
 * Resolve the daemon home the shared @codesurf/daemon manager should use.
 * The manager owns pid-file parsing, health checks, startup locking, and
 * cache invalidation; this provider only chooses which home to hand it.
 */
/** Canonical path for comparison; the raw value when it cannot be resolved,
 *  so a deleted or unmounted project root still compares equal to itself
 *  instead of throwing. The daemon canonicalizes the same way before checking
 *  `workspaceDir` against the registered root. */
function realpathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function resolveCodesurfHome(override?: string): string {
  const fromOverride = override?.trim();
  if (fromOverride) return fromOverride;
  const fromEnv = process.env.CODESURF_HOME?.trim();
  if (fromEnv) return fromEnv;
  return CODESURF_HOME;
}

// ── Models ───────────────────────────────────────────────────────────────────

interface CodesurfModelSpec {
  /** Daemon's `request.provider` value. */
  downstream: "claude" | "codex" | "opencode" | "hermes";
  /** Daemon's `request.model` value. */
  model: string;
  label: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: { tools?: boolean; reasoning?: boolean; images?: boolean };
}

// Static picker bootstrap for offline startup. The daemon-provided catalog
// replaces these rows as soon as `/chat/model-catalog` is available.
const MODELS: CodesurfModelSpec[] = [
  // Claude (via desktop's @anthropic-ai/claude-agent-sdk path).
  {
    downstream: "claude",
    model: "claude-opus-4-7",
    label: "Opus 4.7 (Codesurf)",
    description: "Routed through the shared Codesurf daemon's Claude Agent SDK adapter.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: true },
  },
  {
    downstream: "claude",
    model: "claude-opus-4-6",
    label: "Opus 4.6 (Codesurf)",
    description: "Routed through the shared Codesurf daemon's Claude Agent SDK adapter.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: true },
  },
  {
    downstream: "claude",
    model: "claude-sonnet-5",
    label: "Sonnet 5 (Codesurf)",
    description: "Routed through the shared Codesurf daemon's Claude Agent SDK adapter.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: true },
  },
  {
    downstream: "claude",
    model: "claude-sonnet-4-6",
    label: "Sonnet 4.6 (Codesurf)",
    description: "Routed through the shared Codesurf daemon's Claude Agent SDK adapter.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: true },
  },
  {
    downstream: "claude",
    model: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5 (Codesurf)",
    description: "Routed through the shared Codesurf daemon's Claude Agent SDK adapter.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: true },
  },
  {
    downstream: "claude",
    model: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5 (Codesurf)",
    description: "Fast Claude model via the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: true },
  },
  // Codex (via desktop's `codex` CLI subprocess).
  {
    downstream: "codex",
    model: "gpt-5.5",
    label: "GPT-5.5 (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 258_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "codex",
    model: "gpt-5.4",
    label: "GPT-5.4 (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 258_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "codex",
    model: "gpt-5.3-codex",
    label: "Codex 5.3 (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 258_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "codex",
    model: "gpt-5.1-codex-mini",
    label: "Codex Mini (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 258_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "codex",
    model: "o4-mini",
    label: "o4-mini (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "codex",
    model: "o3",
    label: "o3 (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "codex",
    model: "o3-mini",
    label: "o3-mini (Codesurf)",
    description: "OpenAI Codex CLI driven by the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  // OpenCode (via @opencode-ai/sdk in the shared daemon).
  {
    downstream: "opencode",
    model: "anthropic/claude-sonnet-5",
    label: "Sonnet 5 (Codesurf via OpenCode)",
    description: "OpenCode SDK in the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    label: "Sonnet 4.6 (Codesurf via OpenCode)",
    description: "OpenCode SDK in the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "opencode",
    model: "anthropic/claude-opus-4-6",
    label: "Opus 4.6 (Codesurf via OpenCode)",
    description: "OpenCode SDK in the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "opencode",
    model: "openai/gpt-5.4",
    label: "GPT-5.4 (Codesurf via OpenCode)",
    description: "OpenCode SDK in the shared Codesurf daemon.",
    contextWindow: 258_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "opencode",
    model: "openai/o4-mini",
    label: "o4-mini (Codesurf via OpenCode)",
    description: "OpenCode SDK in the shared Codesurf daemon.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true },
  },
  {
    downstream: "opencode",
    model: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro (Codesurf via OpenCode)",
    description: "OpenCode SDK in the shared Codesurf daemon.",
    contextWindow: 1_000_000,
    capabilities: { tools: true, reasoning: true },
  },
];

const KNOWN_DOWNSTREAMS = new Set<CodesurfModelSpec["downstream"]>(["claude", "codex", "opencode", "hermes"]);
const DAEMON_MODEL_CATALOG_PATH = "/chat/model-catalog";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function parseCapabilities(value: unknown): CodesurfModelSpec["capabilities"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const capabilities = {
    tools: booleanField(record, ["tools", "toolUse"]),
    reasoning: booleanField(record, ["reasoning", "thinking"]),
    images: booleanField(record, ["images", "vision"]),
  };
  return Object.values(capabilities).some((entry) => entry !== undefined) ? capabilities : undefined;
}

function normalizeDownstream(value: string): CodesurfModelSpec["downstream"] | null {
  const normalized = value.trim().toLowerCase();
  return KNOWN_DOWNSTREAMS.has(normalized as CodesurfModelSpec["downstream"])
    ? (normalized as CodesurfModelSpec["downstream"])
    : null;
}

function parseCatalogModel(
  value: unknown,
  providerDefaults: { downstream?: string; providerLabel?: string } = {},
): CodesurfModelSpec | null {
  const record = asRecord(value);
  if (!record) return null;
  const downstream = normalizeDownstream(
    stringField(record, ["downstream", "provider", "providerId"]) || providerDefaults.downstream || "",
  );
  const model = stringField(record, ["model", "modelId", "id"]);
  if (!downstream || !model) return null;

  const label = stringField(record, ["label", "name", "displayName"]) || model;
  const description =
    stringField(record, ["description", "subtitle", "family"]) ||
    (providerDefaults.providerLabel ? `Routed through Codesurf ${providerDefaults.providerLabel}.` : undefined);

  return {
    downstream,
    model,
    label,
    description,
    contextWindow: numberField(record, ["contextWindow", "context_window", "contextLength", "context"]),
    maxOutputTokens: numberField(record, ["maxOutputTokens", "max_output_tokens"]),
    capabilities: parseCapabilities(record.capabilities),
  };
}

function parseCodesurfModelCatalog(value: unknown): CodesurfModelSpec[] {
  const root = asRecord(value);
  const source = root?.providers ?? root?.catalog ?? root?.models ?? value;
  const items = Array.isArray(source) ? source : [source];
  const parsed: CodesurfModelSpec[] = [];

  for (const item of items) {
    const provider = asRecord(item);
    if (provider && Array.isArray(provider.models)) {
      const downstream = stringField(provider, ["downstream", "provider", "providerId", "id"]);
      const providerLabel = stringField(provider, ["label", "name"]);
      for (const model of provider.models) {
        const spec = parseCatalogModel(model, { downstream, providerLabel });
        if (spec) parsed.push(spec);
      }
      continue;
    }
    const spec = parseCatalogModel(item);
    if (spec) parsed.push(spec);
  }

  const seen = new Set<string>();
  return parsed.filter((spec) => {
    const key = `${spec.downstream}\0${spec.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchDaemonModelCatalog(resolveHome: () => string): Promise<CodesurfModelSpec[]> {
  const bridge = getCodesurfDaemonBridge(resolveHome());
  const status = await bridge.manager.getDaemonStatus().catch(() => ({ running: false, info: null }));
  if (!status.running || !status.info) return [];
  const response = await fetch(`http://127.0.0.1:${status.info.port}${DAEMON_MODEL_CATALOG_PATH}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${status.info.token}`,
    },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`${DAEMON_MODEL_CATALOG_PATH} returned ${response.status}`);
  const payload = await response.json();
  return parseCodesurfModelCatalog(payload);
}

/** Public id we expose to the kernel: `codesurf:<downstream>/<model>`. */
function encodeModelId(spec: CodesurfModelSpec): string {
  return `codesurf:${spec.downstream}/${spec.model}`;
}

/** Inverse of {@link encodeModelId}. Returns null on malformed input. */
function decodeModelId(id: string): { downstream: CodesurfModelSpec["downstream"]; model: string } | null {
  if (!id.startsWith("codesurf:")) return null;
  const rest = id.slice("codesurf:".length);
  const slashAt = rest.indexOf("/");
  if (slashAt <= 0 || slashAt === rest.length - 1) return null;
  const downstream = rest.slice(0, slashAt) as CodesurfModelSpec["downstream"];
  const model = rest.slice(slashAt + 1);
  if (!["claude", "codex", "opencode", "hermes"].includes(downstream)) return null;
  return { downstream, model };
}

function toRegisteredModels(models: CodesurfModelSpec[] = MODELS): ModelSpec[] {
  return models.map((spec) => ({
    id: encodeModelId(spec),
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: spec.label,
    description: spec.description,
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    capabilities: spec.capabilities,
    // No aliases. The bare downstream model name (e.g. `claude-sonnet-4-5`)
    // is also registered by the Anthropic API-key and Claude Agent SDK
    // providers; aliasing here would let the kernel's adapter resolver fall
    // back to those whenever the daemon is offline, surfacing a misleading
    // "API key required" error instead of "Codesurf daemon not
    // running". Users select Codesurf explicitly via the `codesurf:...` id.
  }));
}

// ── Daemon event types ───────────────────────────────────────────────────────

interface DaemonEvent {
  jobId?: string;
  sequence?: number;
  timestamp?: number;
  type: string;
  // Common payload fields across daemon event types:
  text?: string;
  delta?: string;
  toolId?: string;
  toolName?: string;
  /** Complete tool input (JSON text) on a `tool_use` event. */
  toolInput?: string;
  /** Set on a `tool_summary` carrying a failed tool result. */
  isError?: boolean;
  sessionId?: string;
  error?: string;
  index?: number;
}

interface DaemonJobState {
  id?: string;
  status?: string;
  lastSequence?: number;
  error?: string | null;
  sessionId?: string | null;
}

function isDaemonJobActive(status: string | undefined): boolean {
  return status === "running" || status === "starting" || status === "queued" || status === "reconnecting";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Session ──────────────────────────────────────────────────────────────────

interface PendingTool {
  toolName: string;
  argsBuffer: string;
  callEmitted: boolean;
}

class CodesurfDesktopSession implements ProviderSession {
  readonly adapterId: string = ADAPTER_ID;
  readonly providerId: string = PROVIDER_ID;
  readonly mode = "persistent" as const;
  readonly strategy = "per-conversation" as const;

  private readonly conversationId: string;
  private readonly cardId: string;
  /** Set when cardId was synthesized (no user override); holds the legacy
   *  `grok-cli-<conv>` id so historical jobs/sessions remain discoverable. */
  private readonly legacyCardId: string | null;
  private readonly resolveHome: () => string;
  private readonly resolveExecutionTarget: () => ExecutionTarget;
  private readonly resolveRunMode: () => RunMode;
  private readonly resolvePermissionMode: (downstream: CodesurfModelSpec["downstream"]) => string;
  private readonly autoStartDaemon: boolean;
  private readonly ensureRunning?: () => Promise<DaemonStatusInfo>;

  /** Daemon-issued conversation id, threaded across turns for context continuity. */
  private sessionId: string | null = null;

  /** Registered workspace this cwd belongs to. Resolved once per session —
   *  the registry only changes when the user adds a project in CodeSurf. */
  private workspaceId: string | null = null;
  /** Registered root `workspaceId` resolved to. The daemon requires
   *  `workspaceDir` to equal that root exactly, so a cwd inside the project
   *  sends the root, not the subdirectory. */
  private workspaceDir: string | null = null;

  /** Session ids emitted by upstreams that ignored resume; retained for diagnostics. */
  private ignoredSessionIds = new Set<string>();

  /** Current job + abort handle. Reset between turns. */
  private activeJobId: string | null = null;
  private activeAbort: AbortController | null = null;

  /** Text-block boundary tracking, reset per turn. */
  private textInBlock = false;
  private textBreakPending = false;

  /** Per-turn buffer of tool_input chunks keyed by toolId. */
  private pendingTools = new Map<string, PendingTool>();
  private orphanToolSummaryCounts = new Map<string, number>();

  private disconnected = false;

  /** Tile state context for persistent session recovery */
  private tileSessionContext: TileSessionContext | null = null;

  constructor(params: {
    conversationId: string;
    resolveHome: () => string;
    resolveExecutionTarget: () => ExecutionTarget;
    resolveRunMode: () => RunMode;
    resolvePermissionMode?: (downstream: CodesurfModelSpec["downstream"]) => string;
    autoStartDaemon?: boolean;
    ensureRunning?: () => Promise<DaemonStatusInfo>;
    /** When set, overrides the synthesized cardId so this session's jobs
     *  appear under the matching desktop tile's chat. Read once per session
     *  start because changing the binding mid-conversation would split the
     *  history across two tiles. */
    cardIdOverride?: string;
  }) {
    this.conversationId = params.conversationId;
    // Stable id the daemon writes into job metadata. The desktop uses canvas
    // tile ids; if the user pasted a tile id into the setting, route through
    // that — otherwise synthesize one per conversation so jobs from this CLI
    // run can be correlated in the daemon's job dashboard. The global
    // ~/.contex/.last-card-id is deliberately NOT read here: it is shared by
    // every conversation, so recovering it made each new chat resume the
    // previous chat's daemon session, and kept routing to a tile after the
    // user cleared the override.
    const override = params.cardIdOverride?.trim();
    if (override && override.length > 0) {
      this.cardId = override;
      this.legacyCardId = null;
      saveLastCardId(override);
    } else {
      this.cardId = `${SYNTHESIZED_CARD_ID_PREFIX}${params.conversationId}`;
      this.legacyCardId = `${LEGACY_SYNTHESIZED_CARD_ID_PREFIX}${params.conversationId}`;
    }
    this.resolveHome = params.resolveHome;
    this.resolveExecutionTarget = params.resolveExecutionTarget;
    this.resolveRunMode = params.resolveRunMode;
    this.resolvePermissionMode = params.resolvePermissionMode ?? (() => DEFAULT_PERMISSION_MODE);
    this.autoStartDaemon = params.autoStartDaemon !== false;
    this.ensureRunning = params.ensureRunning;

    // Initialize tile state context for persistent session recovery
    this.tileSessionContext = getTileSessionContext(this.cardId);
  }

  sendTurn = async (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    if (this.disconnected) {
      throw new Error("Codesurf desktop session has been disconnected.");
    }
    if (this.activeJobId) {
      throw new Error("Codesurf desktop session already has an active turn. Await the previous sendTurn first.");
    }

    // Errors below are reported ONLY by rejecting: the host turns a rejected
    // sendTurn into the turn's error event, so also emitting one here painted
    // the same failure twice.
    const decoded = decodeModelId(input.modelId);
    if (!decoded) {
      throw new Error(`Unknown Codesurf model id: ${input.modelId}. Expected "codesurf:<provider>/<model>".`);
    }

    const home = this.resolveHome();
    const info = await this.resolveDaemonInfo(home);
    if (!info) {
      throw new Error(
        "Codesurf daemon is not running and could not be started. Run `codesurf daemon start`, then retry.",
      );
    }
    const baseUrl = `http://127.0.0.1:${info.port}`;

    controller.emit({ type: "status", status: "connecting" });

    // Build the request. The daemon accepts the desktop's full ChatRequest
    // shape but every field beyond {provider, model, messages, cardId,
    // workspaceDir} is optional. See chat-jobs.mjs:startJob.
    const messages = this.normalizeMessages(input);
    // Resolved before session recovery: the daemon records the registered
    // root as each job's workspaceDir, so recovery must filter on it too.
    const workspaceId = await this.resolveWorkspaceId(baseUrl, info, input.abortSignal);
    const workspaceDir = this.workspaceDir ?? workspaceRoot();
    const sessionId = this.sessionId ?? (await this.readDaemonSessionId(home, baseUrl, info, input.abortSignal));
    if (sessionId) this.sessionId = sessionId;

    // Interrupted (or disconnected) during setup: bail before a job exists
    // rather than start one nobody will consume.
    if (input.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.disconnected) throw new Error("Codesurf session disconnected.");

    const requestPayload = {
      cardId: this.cardId,
      provider: decoded.downstream,
      model: decoded.model,
      messages,
      workspaceId,
      workspaceDir,
      executionTarget: this.resolveExecutionTarget(),
      runMode: this.resolveRunMode(),
      mode: this.resolvePermissionMode(decoded.downstream),
      sessionId: this.sessionId,
    };

    let job: { id: string; status?: string };
    try {
      const response = await fetch(`${baseUrl}/chat/job/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${info.token}`,
        },
        body: JSON.stringify({ request: requestPayload }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `chat/job/start returned ${response.status}`);
      }
      job = (await response.json()) as { id: string; status?: string };
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.activeJobId = job.id;
    this.pendingTools.clear();
    this.textInBlock = false;
    this.textBreakPending = false;
    this.orphanToolSummaryCounts.clear();

    const abortController = new AbortController();
    this.activeAbort = abortController;

    // Honor the host interrupt (Esc / Agent.abort). The poll loop and its
    // `sleep`s key off `abortController.signal`, so linking the host signal in
    // makes an interrupt break the loop and cancel the daemon job (via the
    // finally below). If the signal already fired during the pre-poll setup
    // above (daemon resolve / job start), abort immediately so we don't enter
    // the loop. `addEventListener("abort")` does not re-fire for an
    // already-aborted signal, hence the explicit check.
    const onHostAbort = () => abortController.abort();
    if (input.abortSignal?.aborted || this.disconnected) abortController.abort();
    else input.abortSignal?.addEventListener("abort", onHostAbort, { once: true });

    let finalUsage: ProviderUsageSnapshot | undefined;
    let terminalEvent: "done" | "error" | null = null;
    let terminalError: string | null = null;
    let lastSequence = 0;
    let reconnects = 0;

    try {
      while (!terminalEvent) {
        const streamResponse = await fetch(
          `${baseUrl}/chat/job/events?jobId=${encodeURIComponent(job.id)}&since=${encodeURIComponent(String(lastSequence))}`,
          {
            method: "GET",
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${info.token}`,
            },
            signal: abortController.signal,
          },
        );

        if (!streamResponse.ok || !streamResponse.body) {
          const text = await streamResponse.text().catch(() => "");
          throw new Error(text || `chat/job/events returned ${streamResponse.status}`);
        }

        controller.emit({
          type: "status",
          status: "streaming",
          message: lastSequence > 0 ? `Resumed daemon stream at event ${lastSequence}.` : undefined,
        });

        // SSE parser: copied from the desktop's chat.ts:1331-1345 (boundary
        // `\n\n`, lines starting with `data:`, multi-line `data:` payloads
        // joined with `\n` before JSON.parse).
        const reader = streamResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sawEvent = false;
        let streamReadError: unknown = null;

        while (true) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (err) {
            streamReadError = err;
            break;
          }
          const { done, value } = read;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLines = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());
            if (dataLines.length > 0) {
              try {
                const payload = JSON.parse(dataLines.join("\n")) as DaemonEvent;
                sawEvent = true;
                if (typeof payload.sequence === "number" && Number.isFinite(payload.sequence)) {
                  lastSequence = Math.max(lastSequence, payload.sequence);
                }
                const result = this.handleDaemonEvent(payload, controller);
                if (result.terminal === "done") terminalEvent = "done";
                if (result.terminal === "error") {
                  terminalEvent = "error";
                  terminalError = result.error ?? "Unknown error";
                }
                if (result.usage) finalUsage = { ...(finalUsage ?? {}), ...result.usage };
              } catch (parseErr) {
                // Don't fail the whole turn on a single corrupt line — the
                // daemon's timeline file occasionally contains partial writes
                // when its log is rotated. An `error` event is a turn
                // terminator to the host, so note it as status and skip.
                controller.emit({
                  type: "status",
                  status: "streaming",
                  message: `Skipped an unreadable daemon event: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                });
              }
            }
            boundary = buffer.indexOf("\n\n");
          }

          if (terminalEvent) break;
        }

        if (terminalEvent) break;
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const state = await this.fetchJobState(baseUrl, info, job.id, abortController.signal);
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (!state) {
          reconnects = sawEvent ? 0 : reconnects + 1;
          if (reconnects > 10) {
            throw new Error(`Codesurf daemon stream closed repeatedly while job ${job.id} state was unavailable.`);
          }
          const delayMs = sawEvent ? 0 : Math.min(250 * Math.max(1, reconnects), 2_000);
          if (delayMs > 0) await sleep(delayMs, abortController.signal);
          continue;
        }
        if (typeof state?.lastSequence === "number" && state.lastSequence > lastSequence) {
          reconnects = 0;
          continue;
        }
        if (typeof state?.sessionId === "string" && state.sessionId.trim()) {
          this.setSessionId(state.sessionId);
        }
        if (!isDaemonJobActive(state?.status)) {
          if (state?.error) {
            terminalEvent = "error";
            terminalError = state.error;
          } else {
            controller.emit({ type: "done" });
            terminalEvent = "done";
          }
          break;
        }

        reconnects = sawEvent ? 0 : reconnects + 1;
        if (streamReadError) {
          controller.emit({
            type: "status",
            status: "streaming",
            message: `Daemon stream interrupted; reconnecting at event ${lastSequence}.`,
          });
        }
        if (reconnects > 10) {
          throw new Error(`Codesurf daemon stream closed repeatedly while job ${job.id} was still running.`);
        }
        const delayMs = sawEvent ? 0 : Math.min(250 * Math.max(1, reconnects), 2_000);
        if (delayMs > 0) await sleep(delayMs, abortController.signal);
      }

      // Flush any tool that received tool_start but never a follow-up — emit
      // a tool-call so the UI doesn't silently drop activity.
      this.flushPendingTools(controller);

      if (terminalEvent === "error") {
        throw new Error(terminalError ?? "Codesurf daemon reported an error");
      }
    } catch (err) {
      if (abortController.signal.aborted && this.disconnected) {
        // Disconnect was the cause; surface a clean abort.
        throw new Error("Codesurf session disconnected.");
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      // Drop the host-abort listener — this is a persistent session reused
      // across turns, so an un-removed listener would leak and fire stale
      // callbacks against the next turn's controller.
      input.abortSignal?.removeEventListener("abort", onHostAbort);
      // Aborting only tears down our local stream; the daemon keeps running
      // the job (and its tools) until told otherwise. This also covers an
      // interrupt that landed while /chat/job/start was in flight — the id is
      // only known now.
      if (abortController.signal.aborted && !terminalEvent) {
        await this.cancelJob(baseUrl, info, job.id);
      }
      if (this.sessionId) {
        await this.patchJobSession(home, job.id, this.sessionId).catch(() => {});
      }
      if (this.activeJobId === job.id) {
        this.activeJobId = null;
        this.activeAbort = null;
      }
    }

    // Persist tile state after successful turn
    if (this.tileSessionContext) {
      this.tileSessionContext.recordTurn(input as never);
      this.tileSessionContext.updatePeerStatus("idle");
      // Update model from the request
      const decoded = decodeModelId(input.modelId);
      if (decoded) {
        this.tileSessionContext.updateModel(input.modelId);
      }
    }

    return { usage: finalUsage };
  };

  abortTurn = async (): Promise<void> => {
    const jobId = this.activeJobId;
    const abort = this.activeAbort;
    if (!jobId) return;
    // Clear the guard synchronously so a replacement turn (e.g. queue
    // send-now, which fires abort() without awaiting it) can call sendTurn()
    // immediately instead of racing the in-flight sendTurn's own `finally`,
    // which only clears these after awaiting /chat/job/cancel +
    // /chat/job/session. Mirrors disconnect()'s synchronous clear below.
    this.activeJobId = null;
    this.activeAbort = null;
    abort?.abort();
    await this.cancelActiveJob(jobId);
  };

  disconnect = async (): Promise<void> => {
    if (this.disconnected) return;
    this.disconnected = true;
    const jobId = this.activeJobId;
    this.activeAbort?.abort();
    this.activeJobId = null;
    this.activeAbort = null;
    // Closing the session must not leave its daemon job running unattended.
    if (jobId) await this.cancelActiveJob(jobId);
  };

  private async cancelActiveJob(jobId: string): Promise<void> {
    const home = this.resolveHome();
    const status = await getCodesurfDaemonBridge(home)
      .manager.getDaemonStatus()
      .catch(() => ({ running: false, info: null }));
    const info = status.info;
    if (!status.running || !info) return;
    await this.cancelJob(`http://127.0.0.1:${info.port}`, info, jobId);
  }

  private async cancelJob(baseUrl: string, info: DaemonPidInfo, jobId: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/chat/job/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${info.token}`,
        },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Best effort — the local stream is already aborted.
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async resolveDaemonInfo(home: string): Promise<DaemonPidInfo | null> {
    const bridge = getCodesurfDaemonBridge(home);
    const status = await bridge.manager.getDaemonStatus().catch(() => ({ running: false, info: null }));
    if (status.running) return status.info;
    if (!this.autoStartDaemon) return null;

    try {
      return await (this.ensureRunning ?? bridge.manager.ensureDaemonRunning)();
    } catch {
      const status = await bridge.manager.getDaemonStatus().catch(() => ({ running: false, info: null }));
      return status.running ? status.info : null;
    }
  }

  /**
   * Find the registered workspace whose root is this cwd.
   *
   * The daemon rejects a chat request without a `workspaceId`, and then
   * cross-checks the supplied `workspaceDir` against that workspace's
   * registered root — so the id has to be resolved BY PATH. The active
   * workspace is the wrong answer: it is whatever the desktop app last
   * focused, frequently a canvas with no project root at all.
   */
  private async resolveWorkspaceId(baseUrl: string, info: DaemonPidInfo, signal?: AbortSignal): Promise<string> {
    if (this.workspaceId) return this.workspaceId;

    const cwd = workspaceRoot();
    const canonical = realpathOrSelf(cwd);

    let workspaces: Array<{ id?: unknown; name?: unknown; path?: unknown; projectPaths?: unknown }>;
    try {
      // Always bounded: the host signal only fires on Esc, so using it in
      // place of the timeout let a wedged daemon hang the turn indefinitely.
      const timeout = AbortSignal.timeout(5_000);
      const response = await fetch(`${baseUrl}/workspace/list`, {
        method: "GET",
        headers: { Authorization: `Bearer ${info.token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        throw new Error(`daemon returned ${response.status}`);
      }
      const parsed = (await response.json()) as unknown;
      workspaces = Array.isArray(parsed) ? (parsed as typeof workspaces) : [];
    } catch (err) {
      throw new Error(
        `Could not read the CodeSurf workspace list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // cwd may be the project root or anywhere inside it; the deepest
    // enclosing root wins so a nested project beats its parent.
    let best: { id: string; root: string; depth: number } | null = null;
    for (const workspace of workspaces) {
      if (typeof workspace.id !== "string" || !workspace.id) continue;
      const roots = [workspace.path, ...(Array.isArray(workspace.projectPaths) ? workspace.projectPaths : [])];
      for (const root of roots) {
        if (typeof root !== "string" || root.trim() === "") continue;
        const canonicalRoot = realpathOrSelf(root);
        if (!isSameOrInside(canonicalRoot, canonical)) continue;
        if (!best || canonicalRoot.length > best.depth) {
          best = { id: workspace.id, root, depth: canonicalRoot.length };
        }
      }
    }
    if (best) {
      this.workspaceId = best.id;
      this.workspaceDir = best.root;
      return best.id;
    }

    // First use in this folder: register it rather than refuse the turn. The
    // repository root is registered (the folder itself outside a repo) so a
    // later run from any subdirectory lands in the same project, and
    // `activate: false` keeps the desktop app on whatever it was showing.
    const folder = (await gitTopLevel(cwd)) ?? cwd;
    const registered = await this.registerWorkspace(baseUrl, info, folder, signal);
    this.workspaceId = registered;
    this.workspaceDir = folder;
    return registered;
  }

  private async registerWorkspace(
    baseUrl: string,
    info: DaemonPidInfo,
    folder: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const timeout = AbortSignal.timeout(5_000);
      const response = await fetch(`${baseUrl}/workspace/create-from-folder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: folder, activate: false }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`daemon returned ${response.status}`);
      const created = asRecord((await response.json()) as unknown);
      const id = created && typeof created.id === "string" ? created.id : "";
      if (!id) throw new Error("daemon returned no workspace id");
      return id;
    } catch (err) {
      throw new Error(
        `Could not register ${folder} as a CodeSurf project: ${err instanceof Error ? err.message : String(err)}. ` +
          `Add it under Projects in CodeSurf, then try again.`,
      );
    }
  }

  private async readDaemonSessionId(
    home: string,
    baseUrl: string,
    info: DaemonPidInfo,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const workspaceDir = this.workspaceDir ?? workspaceRoot();
    const fromDisk = findLatestDaemonSessionIdForCard(home, this.cardId, workspaceDir);
    if (fromDisk) return fromDisk;
    if (this.legacyCardId) {
      const fromDiskLegacy = findLatestDaemonSessionIdForCard(home, this.legacyCardId, workspaceDir);
      if (fromDiskLegacy) return fromDiskLegacy;
    }

    try {
      const response = await fetch(`${baseUrl}/dashboard/api/jobs`, {
        method: "GET",
        headers: { Authorization: `Bearer ${info.token}` },
        signal: signal ?? AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const parsed = (await response.json()) as {
        jobs?: Array<{
          cardId?: unknown;
          sessionId?: unknown;
          workspaceDir?: unknown;
          updatedAt?: unknown;
          requestedAt?: unknown;
        }>;
      };
      const acceptedCardIds = new Set<string>([this.cardId]);
      if (this.legacyCardId) acceptedCardIds.add(this.legacyCardId);
      const candidates = (Array.isArray(parsed.jobs) ? parsed.jobs : [])
        .filter(
          (job) =>
            typeof job.cardId === "string" &&
            acceptedCardIds.has(job.cardId) &&
            typeof job.sessionId === "string" &&
            job.sessionId.trim() &&
            (typeof job.workspaceDir !== "string" || job.workspaceDir === workspaceDir),
        )
        .sort((a, b) => timestampOf(b.updatedAt ?? b.requestedAt) - timestampOf(a.updatedAt ?? a.requestedAt));
      const sessionId = candidates[0]?.sessionId;
      return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    } catch {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return null;
    }
  }

  private async fetchJobState(
    baseUrl: string,
    info: DaemonPidInfo,
    jobId: string,
    signal: AbortSignal,
  ): Promise<DaemonJobState | null> {
    try {
      const response = await fetch(`${baseUrl}/chat/job/state?jobId=${encodeURIComponent(jobId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${info.token}` },
        signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as DaemonJobState;
    } catch {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return null;
    }
  }

  /**
   * The daemon expects `messages: [{role, content: string}]`. Most of the
   * time the agent passes ai-sdk-shaped ModelMessages with array content;
   * we flatten those to plain strings via the shared `stringifyContent`
   * (text parts joined with newlines, images as `[image: url]` placeholders).
   * The current user prompt arrives separately on `input.prompt` — append it
   * as the final user turn so the daemon sees the full context.
   */
  private normalizeMessages(
    input: ProviderTurnInput,
  ): Array<{ role: "user" | "assistant" | "system"; content: string }> {
    const out: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
    for (const raw of input.messages ?? []) {
      const msg = raw as { role?: string; content?: unknown };
      const role = msg.role === "user" || msg.role === "assistant" || msg.role === "system" ? msg.role : null;
      if (!role) continue;
      out.push({ role, content: stringifyContent(msg.content) });
    }
    // Ensure the active user prompt is the final entry. If the agent already
    // included it in `messages`, don't duplicate.
    //
    // Dedup is plain string equality on `content`. That's correct for the
    // common CLI case where `input.prompt` is a string and the agent passes
    // the same string as the last user message's content. If a future caller
    // passes structured array content for the last user turn, this would
    // append a duplicate text-only copy — fine semantically but wasteful.
    const last = out[out.length - 1];
    if (!last || last.role !== "user" || last.content !== input.prompt) {
      out.push({ role: "user", content: input.prompt });
    }
    return out;
  }

  /**
   * Tool event strategy (a) — buffered. We collect tool_input chunks per
   * toolId and emit a single `tool-call` with the joined args once a non-
   * input event for that tool arrives (typically tool_summary). This trades
   * a little UI latency for fidelity on tool arguments.
   */
  private handleDaemonEvent(
    event: DaemonEvent,
    controller: ProviderStreamController,
  ): { terminal?: "done" | "error"; error?: string; usage?: ProviderUsageSnapshot } {
    switch (event.type) {
      case "session": {
        if (typeof event.sessionId === "string" && event.sessionId.trim()) {
          this.setSessionId(event.sessionId);
          // Update tile state with daemon session
          if (this.tileSessionContext) {
            this.tileSessionContext.setDaemonSessionId(event.sessionId);
          }
        }
        return {};
      }
      case "text": {
        const delta = typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
        if (!delta) return {};
        // Separate text blocks (split by tools) with a paragraph break;
        // otherwise consecutive blocks ran together ("…match.Good, that…").
        if (this.textBreakPending) controller.emit({ type: "text-delta", delta: "\n\n" });
        this.textBreakPending = false;
        this.textInBlock = true;
        controller.emit({ type: "text-delta", delta });
        return {};
      }
      case "thinking_start": {
        // Emit a zero-length reasoning delta so the host can show a thinking
        // indicator before any content arrives.
        controller.emit({ type: "reasoning-delta", delta: "" });
        return {};
      }
      case "thinking": {
        const delta = typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
        if (delta) controller.emit({ type: "reasoning-delta", delta });
        return {};
      }
      case "tool_start": {
        const toolId = String(event.toolId ?? "");
        const toolName = String(event.toolName ?? "tool");
        if (!toolId) return {};
        this.pendingTools.set(toolId, { toolName, argsBuffer: "", callEmitted: false });
        return {};
      }
      case "tool_input": {
        const toolId = String(event.toolId ?? "");
        const piece = typeof event.text === "string" ? event.text : "";
        if (!toolId || !piece) return {};
        const pending = this.pendingTools.get(toolId);
        if (pending) {
          pending.argsBuffer += piece;
        } else {
          // tool_input without a preceding tool_start — synthesize a default.
          this.pendingTools.set(toolId, { toolName: "tool", argsBuffer: piece, callEmitted: false });
        }
        return {};
      }
      case "tool_use": {
        // The claude runner sends the complete input once the tool_use block
        // closes. Show the call now: waiting for a tool_summary left a long
        // turn looking like it was only "thinking" until it finished.
        const toolId = String(event.toolId ?? "");
        if (!toolId) return {};
        const pending = this.pendingTools.get(toolId);
        if (pending?.callEmitted) return {};
        const toolName = String(event.toolName ?? pending?.toolName ?? "tool");
        const rawInput = typeof event.toolInput === "string" ? event.toolInput : (pending?.argsBuffer ?? "");
        controller.emit({ type: "tool-call", id: toolId, toolName, args: parseToolArgs(rawInput) });
        this.pendingTools.set(toolId, { toolName, argsBuffer: rawInput, callEmitted: true });
        return {};
      }
      case "tool_summary": {
        const toolId = String(event.toolId ?? "");
        const pending = toolId ? this.pendingTools.get(toolId) : null;
        let resultId = toolId;
        if (toolId && pending && !pending.callEmitted) {
          controller.emit({
            type: "tool-call",
            id: toolId,
            toolName: pending.toolName,
            args: parseToolArgs(pending.argsBuffer),
          });
          pending.callEmitted = true;
        } else if (!pending) {
          const toolName =
            typeof event.toolName === "string" && event.toolName.trim() ? event.toolName : "Tool summary";
          resultId = this.orphanToolSummaryId(toolId, event);
          controller.emit({
            type: "tool-call",
            id: resultId,
            toolName,
            args: {},
          });
        }
        controller.emit({
          type: "tool-result",
          id: resultId,
          result: typeof event.text === "string" && event.text.length > 0 ? event.text : "Success",
          isError: event.isError === true,
        });
        if (toolId) this.pendingTools.delete(toolId);
        return {};
      }
      case "block_stop": {
        // Block boundary in the SDK stream. A closed text block means the
        // next text starts a new paragraph.
        if (this.textInBlock) {
          this.textInBlock = false;
          this.textBreakPending = true;
        }
        return {};
      }
      case "error": {
        // sendTurn rejects with this message once the stream stops; emitting
        // it here as well would report the failure twice.
        const message = typeof event.error === "string" ? event.error : "Codesurf daemon error";
        return { terminal: "error", error: message };
      }
      case "done": {
        controller.emit({ type: "done" });
        return { terminal: "done" };
      }
      default: {
        // Unknown event types from codex/opencode/hermes paths — ignore
        // rather than fail. The daemon's event vocabulary may grow without
        // breaking us.
        return {};
      }
    }
  }

  private flushPendingTools(controller: ProviderStreamController): void {
    for (const [toolId, pending] of this.pendingTools) {
      if (pending.callEmitted) continue;
      controller.emit({
        type: "tool-call",
        id: toolId,
        toolName: pending.toolName,
        args: parseToolArgs(pending.argsBuffer),
      });
      pending.callEmitted = true;
    }
    this.pendingTools.clear();
  }

  private orphanToolSummaryId(toolId: string, event: DaemonEvent): string {
    if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) {
      return `${toolId || "tool-summary"}:${event.sequence}`;
    }
    const key = toolId || "tool-summary";
    const next = (this.orphanToolSummaryCounts.get(key) ?? 0) + 1;
    this.orphanToolSummaryCounts.set(key, next);
    return `${key}:summary-${next}`;
  }

  private setSessionId(sessionId: string): void {
    const trimmed = sessionId.trim();
    if (!trimmed || trimmed === this.sessionId) return;
    if (this.sessionId) {
      this.ignoredSessionIds.add(trimmed);
      return;
    }
    this.sessionId = trimmed;
    // Persist the daemon session ID to tile state
    if (this.tileSessionContext) {
      this.tileSessionContext.setDaemonSessionId(trimmed);
    }
  }

  private async patchJobSession(home: string, jobId: string, sessionId: string): Promise<void> {
    patchDaemonJobSession(home, jobId, sessionId);
    patchDaemonTimelineSession(home, jobId, sessionId);
    this.ignoredSessionIds.clear();
  }
}

/** True when `child` is `parent` or a path below it (both canonical). */
/** The git repository root containing `cwd`, or null outside a repository. */
function gitTopLevel(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2_000 }, (err, stdout) => {
      const top = err ? "" : String(stdout).trim();
      resolve(top ? top : null);
    });
  });
}

function isSameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function timestampOf(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseToolArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Daemon's tool_input chunks may not be valid JSON yet (partial stream).
    // Return the raw text under a `_partial` key so consumers see something.
    return { _partial: raw };
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Synchronous credential check. The daemon manager owns pid/health truth, but
 * `auth.check` must stay sync because the host model-picker reads it inline.
 * So this only checks whether the daemon binary is installed; `sendTurn`
 * performs the authoritative daemon manager check/start before sending.
 */
function makeCheckCredential(): (ctx: ProviderConnectionContext) => CredentialStatus {
  return (): CredentialStatus => {
    if (daemonBinaryAvailable()) {
      return { ok: true };
    }
    return {
      ok: false,
      reason:
        "codesurfd binary not found. Install @codesurf/daemon, or run from a checkout where the daemon source is available.",
      needsUserAction: "install-cli",
    };
  };
}

// ── Extension module ─────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Codesurf Daemon",
  version: "1.0.0",
  description:
    "Stream chat turns through the shared Codesurf daemon (codesurfd). Reuses or starts the local daemon used by both the desktop app and CLI.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  // Off by default. Models only appear in /models after the user opts in
  // via /extensions, matching the anthropic API-key provider.
  enabledByDefault: false,
  capabilities: ["provider-adapters", "models", "settings"],
};

export const codesurfDesktopProviderPlugin: CodesurfPlugin = {
  name: "codesurf-desktop-provider",
  manifest,
  inject: ["contributions", "settings"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: HOME_OVERRIDE_SETTING,
        title: "Codesurf home directory override",
        description:
          "Override the daemon discovery path. Leave blank to use $CODESURF_HOME or the default ~/.codesurf.",
        type: "string",
        default: "",
        section: "Codesurf Daemon",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: CARD_ID_SETTING,
        title: "Desktop tile id (cardId) to bind to",
        description:
          "Paste the desktop chat tile's cardId here to mirror Codesurf CLI turns into that tile. Leave blank to keep the Codesurf CLI isolated (its own conversation, not visible in the desktop).",
        type: "string",
        default: "",
        section: "Codesurf Daemon",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: EXECUTION_TARGET_SETTING,
        title: "Execution target",
        description:
          "Where the daemon runs the job. 'local' runs in the shared local daemon; 'cloud' delegates to the configured cloud host.",
        type: "select",
        default: DEFAULT_EXECUTION_TARGET,
        section: "Codesurf Daemon",
        options: [
          { value: "local", label: "Local daemon" },
          { value: "cloud", label: "Cloud host (configured in desktop)" },
        ],
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: RUN_MODE_SETTING,
        title: "Run mode",
        description:
          "Foreground turns block until done. Background turns return immediately and surface results via the daemon's job dashboard.",
        type: "select",
        default: DEFAULT_RUN_MODE,
        section: "Codesurf Daemon",
        options: [
          { value: "foreground", label: "Foreground" },
          { value: "background", label: "Background" },
        ],
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: PERMISSION_MODE_SETTING,
        title: "Permission mode",
        description:
          "Controls tool permission handling for turns routed through the shared daemon. Bypass is explicit; ask is the default.",
        type: "select",
        default: DEFAULT_PERMISSION_MODE,
        section: "Codesurf Daemon",
        options: PERMISSION_MODE_OPTIONS,
      }),
    );

    const resolveHome = (): string => {
      const raw = settings.get<unknown>(HOME_OVERRIDE_SETTING, "");
      const override = typeof raw === "string" ? raw : "";
      return resolveCodesurfHome(override);
    };

    const resolveExecutionTarget = (): ExecutionTarget => {
      const raw = settings.get<unknown>(EXECUTION_TARGET_SETTING, DEFAULT_EXECUTION_TARGET);
      return raw === "cloud" ? "cloud" : "local";
    };

    const resolveRunMode = (): RunMode => {
      const raw = settings.get<unknown>(RUN_MODE_SETTING, DEFAULT_RUN_MODE);
      return raw === "background" ? "background" : "foreground";
    };

    const resolvePermissionMode = (downstream: CodesurfModelSpec["downstream"]): string => {
      const raw = settings.get<unknown>(PERMISSION_MODE_SETTING, DEFAULT_PERMISSION_MODE);
      const mode: PermissionMode = PERMISSION_MODE_OPTIONS.some((option) => option.value === raw)
        ? (raw as PermissionMode)
        : DEFAULT_PERMISSION_MODE;
      if (downstream === "codex") {
        if (mode === "bypassPermissions") return "full-access";
        if (mode === "plan") return "read-only";
        if (mode === "auto") return "auto";
        return "default";
      }
      if (downstream === "claude") {
        if (mode === "dontAsk") return "dontAsk";
        if (mode === "auto") return "default";
        return mode;
      }
      return mode === "bypassPermissions" ? "bypassPermissions" : "default";
    };

    const resolveCardIdOverride = (): string => {
      const raw = settings.get<unknown>(CARD_ID_SETTING, "");
      return typeof raw === "string" ? raw : "";
    };

    ctx.effect(async () =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Codesurf Daemon",
        description:
          "HTTP+SSE bridge to the shared local Codesurf daemon. Streams Claude / Codex / OpenCode / Hermes turns with full conversation continuity.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "sse",
        connectionMode: "persistent",
        sessionStrategy: "per-conversation",
        capabilities: {
          streaming: true,
          tools: true,
          images: false, // image attachments not yet wired through the bridge
          reasoning: true,
        },
        models: toRegisteredModels(),
        listModels: async () => {
          let daemonModels: CodesurfModelSpec[] = [];
          try {
            daemonModels = await fetchDaemonModelCatalog(resolveHome);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/not found|404/i.test(message)) return [];
            throw err;
          }
          return daemonModels.length > 0 ? toRegisteredModels(daemonModels) : [];
        },
        auth: {
          mode: "none",
          check: makeCheckCredential(),
        },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => {
            return new CodesurfDesktopSession({
              conversationId: ctx.conversationId,
              resolveHome,
              resolveExecutionTarget,
              resolveRunMode,
              resolvePermissionMode,
              cardIdOverride: resolveCardIdOverride(),
            });
          },
        },
      }),
    );
  },
};

// Exports for tests.
export {
  CodesurfDesktopSession,
  decodeModelId,
  encodeModelId,
  fetchDaemonModelCatalog,
  MODELS,
  parseCodesurfModelCatalog,
  resolveCodesurfHome,
};
