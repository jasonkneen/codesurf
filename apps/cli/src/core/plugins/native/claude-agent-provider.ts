// Builtin Claude Agent SDK provider.
//
// Connection model — per the SDK's documented pattern:
//   1. ONE `query({ prompt: asyncIterable, options })` opens a persistent
//      session. This is the "slow start" — spawns the CLI subprocess,
//      authenticates, initializes tool runtime.
//   2. The input async iterable stays open for the whole conversation;
//      `sendTurn` pushes a new `SDKUserMessage` for each turn.
//   3. A background consumer loop reads the output AsyncGenerator continuously,
//      translating SDK messages into `ProviderStreamEvent`s and dispatching
//      them to whichever turn is currently active.
//   4. `disconnect()` tears down the input queue + aborts the query.
//
// Authentication is handled by the SDK (it uses whatever `claude` CLI the
// user has authenticated — OAuth tokens in ~/.claude or ANTHROPIC_API_KEY).
// We report `auth-sdk` mode so the host knows not to prompt for an API key.

import type {
  CanUseTool,
  Options as ClaudeAgentOptions,
  Query as ClaudeAgentQuery,
  EffortLevel,
  HookCallback,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { tryParseRipgrepCommand } from "../../../tools/bash";
import { executeGrep } from "../../../tools/grep";
import {
  buildCodesurfMcpServer,
  CODESURF_MCP_PREFIX,
  CODESURF_MCP_SERVER_ID,
  codesurfMcpPromptSection,
} from "./codesurf-mcp";

// Always log the SDK's message stream to disk so users can debug without
// re-running with an env var. Truncated on the first write of each process
// so sessions don't accumulate indefinitely.
const LOG_DIR = path.join(os.homedir(), ".grok");
const LOG_FILE = path.join(LOG_DIR, "claude-agent-sdk.log");
let LOG_INITIALIZED = false;

/** Prompt and assistant text stay out of the on-disk log unless explicitly
 *  asked for: the log is always on, and conversation content in a file under
 *  the home directory is a privacy leak nobody opted into. */
function logContentEnabled(): boolean {
  return process.env.CODESURF_CLAUDE_AGENT_LOG_CONTENT === "1";
}

// How long the provider waits for ANY activity from the SDK subprocess before
// declaring the turn stalled. A silent stream (dropped connection, or an
// upstream rate-limit that never resolves) would otherwise hang the turn until
// the user manually interrupts. Reset on every message; paused while a tool
// approval is pending. Override with CODESURF_PROVIDER_STALL_MS; 0 disables.
const STALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CODESURF_PROVIDER_STALL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
})();

function logLine(text: string): void {
  try {
    // CODESURF_CLAUDE_AGENT_LOG_FILE redirects the log (always appended), so a
    // test or a second process never truncates the shared default file.
    const override = process.env.CODESURF_CLAUDE_AGENT_LOG_FILE;
    const line = `[${new Date().toISOString()}] ${text}\n`;
    if (override) {
      fs.appendFileSync(override, line, "utf-8");
      return;
    }
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    if (!LOG_INITIALIZED) {
      fs.writeFileSync(LOG_FILE, line, "utf-8");
      LOG_INITIALIZED = true;
    } else {
      fs.appendFileSync(LOG_FILE, line, "utf-8");
    }
  } catch {
    // Best effort — never fail a turn because logging failed.
  }
}

import type {
  CodesurfPlugin,
  CredentialStatus,
  McpService,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { type McpServerConfig as CodesurfMcpServerConfig, loadMcpServers } from "../../../utils/settings";
import { workspaceRoot } from "../../../utils/workspace-scope";
import { ANTHROPIC_MODELS } from "../builtin/anthropic-models-catalog";
import { registerClaudeSkillsProvider } from "../builtin/claude-skills-provider";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { formatHistoryAsPreface } from "../builtin/provider-history-preface";
import { usageFromRecord } from "../builtin/provider-usage";

const EXTENSION_ID = "builtin.provider-claude-agent";
const PROVIDER_ID = "anthropic";
const ADAPTER_ID = "anthropic.agent-sdk";
// Scoped under the adapter id so each provider can register its own
// permission-mode setting with its own semantics (Codex, xAI, etc. will
// never collide). Setting keys are immutable once registered — rename only
// by migrating persisted values.
const PERMISSION_MODE_SETTING = `${ADAPTER_ID}.permissionMode`;
const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

// All six modes the Claude Agent SDK accepts. Other providers (e.g. Codex
// CLI) will register their own mode setting with different semantics — these
// values are Claude-specific and shouldn't leak into other adapter configs.
const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default — prompt for every tool" },
  { value: "bypassPermissions", label: "Always approve (yolo) — skip every tool prompt" },
  { value: "acceptEdits", label: "Accept edits — auto-approve file edits" },
  { value: "plan", label: "Plan — no tool use, read-only planning" },
  { value: "dontAsk", label: "Don't ask — no host prompts (CLI deny rules still apply)" },
  { value: "auto", label: "Auto — let Claude choose" },
];

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODE_OPTIONS.some((opt) => opt.value === value);
}

/**
 * Host-side decision for when `canUseTool` must not re-prompt.
 *
 * The SDK is supposed to skip `canUseTool` under `bypassPermissions` and
 * auto-deny unlisted tools under `dontAsk`. In practice it still sends
 * `can_use_tool` control requests — especially after a mid-session mode
 * change — and our callback used to always open PermissionPrompt. That
 * made "don't ask" and "always-approve / yolo" look like no-ops.
 *
 * `dontAsk` auto-allows at this boundary (rather than auto-denying) because
 * a real SDK-side deny never reaches `canUseTool`; it arrives as
 * `system/permission_denied`. If we are being asked, the user asked not to
 * be interrupted, so run the tool.
 */
const YOLO_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk"]);
const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "write_file",
  "edit_file",
]);

export function hostAutoAllowsTool(mode: string, toolName: string): boolean {
  if (YOLO_MODES.has(mode)) return true;
  if (mode === "acceptEdits") return ACCEPT_EDITS_TOOLS.has(toolName.toLowerCase());
  return false;
}

// ── Thinking / effort configuration ──────────────────────────────────────────
//
// The SDK exposes two independent knobs:
//   - `thinking` — whether extended thinking happens and how it's modelled
//     (adaptive = Claude decides when/how much; enabled = always on; disabled = off).
//   - `effort` — how hard Claude tries within whatever thinking path is active.
//
// Neither has a live setter on Query — they're baked into the session at
// lazyStart. Changes take effect on the next fresh session (new conversation,
// disable+enable the extension, or consumer-error-triggered reconnect).

type ThinkingSettingValue = "adaptive" | "enabled" | "disabled";

const THINKING_SETTING = `${ADAPTER_ID}.thinking`;
const DEFAULT_THINKING: ThinkingSettingValue = "adaptive";
const THINKING_OPTIONS: Array<{ value: ThinkingSettingValue; label: string }> = [
  { value: "adaptive", label: "Adaptive — Claude decides when and how much to think" },
  { value: "enabled", label: "Enabled — always think (budget guided by effort)" },
  { value: "disabled", label: "Disabled — skip extended thinking entirely" },
];

function isThinkingMode(value: unknown): value is ThinkingSettingValue {
  return typeof value === "string" && THINKING_OPTIONS.some((opt) => opt.value === value);
}

function thinkingConfigFor(mode: ThinkingSettingValue): ThinkingConfig {
  switch (mode) {
    case "disabled":
      return { type: "disabled" };
    case "enabled":
      // No explicit budget — let the SDK pick one from `effort`. Matches the
      // docstring on ThinkingEnabled: "budgetTokens?: number" is optional.
      return { type: "enabled" };
    default:
      return { type: "adaptive" };
  }
}

// ── Skill disclosure ─────────────────────────────────────────────────────────
//
// Owning adapters never receive CodeSurf's system prompt (ProviderTurnInput has
// no `system` field) — the CLI builds its own. So CodeSurf's progressive skill
// disclosure cannot reach this path; the SDK's own `skills` filter is the only
// lever.
//
// It matters here as much as anywhere: ~/.claude/skills holds 296 skills on a
// real install, and with `skills` omitted the CLI's defaults apply and load the
// lot into every session — roughly 33k tokens before the user has typed
// anything. That is the same weight measured on CodeSurf's own catalog, paid
// again on a path the earlier fix does not touch.
//
// Per the SDK docs this is a CONTEXT FILTER, not a sandbox: unlisted skills are
// hidden from the model's listing and refused by the Skill tool, but their
// files stay on disk and remain reachable via Read/Bash — and via subagents,
// which carry their own skill set in their own context and therefore cost the
// main session's prompt cache nothing.
//
// NOTE ON `settingSources`: deliberately left alone. Passing `[]` would be the
// obvious "isolate everything" move, but the SDK requires `'project'` in that
// list to load CLAUDE.md — so isolating would silently drop the user's project
// and personal instructions (~5.5KB here). Skills are the weight; CLAUDE.md is
// the intent. Only the former is filtered.

type SkillsSettingValue = "minimal" | "all";

const SKILLS_SETTING = `${ADAPTER_ID}.skills`;
const DEFAULT_SKILLS: SkillsSettingValue = "minimal";
const SKILLS_OPTIONS: Array<{ value: SkillsSettingValue; label: string }> = [
  { value: "minimal", label: "Minimal — no skills preloaded; reach them via Read or a subagent (fast)" },
  { value: "all", label: "All — preload every discovered skill (~33k tokens on a large install)" },
];

function isSkillsMode(value: unknown): value is SkillsSettingValue {
  return typeof value === "string" && SKILLS_OPTIONS.some((opt) => opt.value === value);
}

/** Translate the setting into the SDK's `skills` option.
 *  `[]` = explicitly none. Omitting the field entirely would instead mean
 *  "no SDK configuration", which leaves the CLI's load-everything default in
 *  place — the exact behaviour being avoided. */
function skillsOptionFor(mode: SkillsSettingValue): "all" | string[] {
  return mode === "all" ? "all" : [];
}

const EFFORT_SETTING = `${ADAPTER_ID}.effort`;
const DEFAULT_EFFORT: EffortLevel = "high";
const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string }> = [
  { value: "low", label: "Low — fastest, minimal thinking" },
  { value: "medium", label: "Medium — balanced" },
  { value: "high", label: "High — deep reasoning (default)" },
  { value: "xhigh", label: "Extra high — Opus 4.7/4.8 only (falls back to high elsewhere)" },
  { value: "max", label: "Max — maximum effort (select models only)" },
];

function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_OPTIONS.some((opt) => opt.value === value);
}

// Agent SDK adapter's per-model label/description overlay. Keyed by canonical
// model id from ANTHROPIC_MODELS in `./anthropic-models-catalog.ts`. New
// Claude releases land there first, then get a row here.
const AGENT_LABELS: Record<string, { label: string; description: string }> = {
  "claude-fable-5-1": {
    label: "Claude Fable 5.1 (Agent SDK)",
    description: "Most capable. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-opus-5-5": {
    label: "Claude Opus 5.5 (Agent SDK)",
    description: "Flagship. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-fable-5": {
    label: "Claude Fable 5 (Agent SDK)",
    description: "Most capable. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-opus-5": {
    label: "Claude Opus 5 (Agent SDK)",
    description: "Flagship. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-opus-4-8": {
    label: "Claude Opus 4.8 (Agent SDK)",
    description: "Opus 4.8. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-opus-4-7": {
    label: "Claude Opus 4.7 (Agent SDK)",
    description: "Opus 4.7. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-opus-4-6": {
    label: "Claude Opus 4.6 (Agent SDK)",
    description: "Opus 4.6. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-sonnet-5": {
    label: "Claude Sonnet 5 (Agent SDK)",
    description: "Latest balanced flagship. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-sonnet-4-6": {
    label: "Claude Sonnet 4.6 (Agent SDK)",
    description: "Balanced flagship. 1M context. Via @anthropic-ai/claude-agent-sdk.",
  },
  "claude-haiku-4-5": {
    label: "Claude Haiku 4.5 (Agent SDK)",
    description: "Fast. 200K context. Via @anthropic-ai/claude-agent-sdk.",
  },
};

function toRegisteredModels(): ModelSpec[] {
  return ANTHROPIC_MODELS.map((model) => {
    const labels = AGENT_LABELS[model.id] ?? { label: model.id, description: "" };
    return {
      id: model.id,
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      label: labels.label,
      description: labels.description,
      contextWindow: model.contextWindow,
      aliases: model.aliases.length > 0 ? [...model.aliases] : undefined,
      capabilities: { tools: true, reasoning: true, images: true },
    };
  });
}

// ── AsyncPushQueue — the input channel for the persistent query() ────────────

/**
 * A minimal push-pull async iterable: producers call `push(value)` or `close()`,
 * consumers iterate with `for await (const v of queue.iterable)`. Used as the
 * `prompt` argument to claude-agent-sdk's `query()`.
 */
class AsyncPushQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  }

  get iterable(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (self.queue.length > 0) {
              return Promise.resolve({ value: self.queue.shift() as T, done: false });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => self.resolvers.push(resolve));
          },
          return(): Promise<IteratorResult<T>> {
            self.close();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

// ── History preface (resume support) ─────────────────────────────────────────
//
// The Claude Agent SDK normally owns conversation history inside its persistent
// subprocess: each SDKUserMessage we push continues the same internal session,
// so the host doesn't need to forward `input.messages`. That breaks down for
// `/sessions` resume — the host disposes the old SDK session, rehydrates its
// own transcript from disk, and the next sendTurn lazyStarts a fresh subprocess
// with no awareness of prior turns.
//
// The fix below: on the first sendTurn after lazyStart, if the host's
// `input.messages` already contains prior turns (i.e. length > 1, since the
// last entry is the current prompt), serialize them into a single preface and
// prepend to the user prompt as ONE SDKUserMessage. This avoids pushing N
// separate user turns (which the SDK would respond to one-by-one) at the cost
// of losing tool-call fidelity — text-only context is preserved.

// `formatHistoryAsPreface` and its previewText helper now live in the shared
// `./provider-history-preface` module — see import at the top of this file.

// ── Session ──────────────────────────────────────────────────────────────────

interface ActiveTurn {
  controller: ProviderStreamController;
  resolve: (result: { usage?: ProviderUsageSnapshot }) => void;
  reject: (err: Error) => void;
  modelId: string;
  /** Set once this turn's prompt was pushed to the SDK. Only a pushed turn
   *  produces a `result` of its own, so only a pushed turn is drained when it
   *  is retired before that result arrives. */
  pushed?: boolean;
  /** Set when the first streamed `text_delta` partial was forwarded for this
   *  turn. The complete `assistant` message still arrives afterwards, so its
   *  `text` blocks must be skipped or the text would be emitted twice. */
  streamedText?: boolean;
  /** Same dedupe guard as `streamedText`, for `thinking_delta` partials vs the
   *  complete message's `thinking` blocks. */
  streamedThinking?: boolean;
  /** Detaches the host AbortSignal listener wired up in sendTurn. Called
   *  whenever the turn settles (normal result, error, steering, disconnect)
   *  so we don't retain the host signal — and the closure that captures
   *  this turn — past the turn lifetime. */
  cleanup?: () => void;
}

class ClaudeAgentSession implements ProviderSession {
  readonly adapterId: string;
  readonly providerId: string = PROVIDER_ID;
  readonly mode = "persistent" as const;
  readonly strategy = "singleton" as const;

  private query: ClaudeAgentQuery | null = null;
  private input = new AsyncPushQueue<SDKUserMessage>();
  private activeTurn: ActiveTurn | null = null;
  /** Number of retired turns (steer / abort / stall) whose prompt reached the
   * SDK but whose `result` has not arrived yet. The SDK answers pushed
   * prompts in order, one `result` each, so the consumer loop drops messages
   * and swallows that many results before the live turn's events flow
   * through. A boolean lost count when two turns were retired back to back:
   * the first swallowed result cleared it and the second retired turn's tail
   * reached the live turn.
   */
  private drainingTurns = 0;
  private consumerTask: Promise<void> | null = null;
  /** Per-turn stall watchdog. Reset on every SDK message; fires `onStall` when
   *  the stream goes silent for STALL_TIMEOUT_MS so a dropped/rate-limited
   *  connection surfaces as an error instead of an indefinite hang. */
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** The turn the current stall timer is guarding. Lets `onStall` ignore a
   *  stale timer left over from a turn that already settled (the next turn may
   *  have started before the old timer fired). */
  private stallTurn: ActiveTurn | null = null;
  private abortController = new AbortController();
  private disconnected = false;
  private lazyStart: (() => Promise<void>) | null = null;
  /** Last model id we successfully selected via setModel(). Avoids a
   *  redundant control-request per turn when the model hasn't changed. */
  private currentModelId: string | undefined;
  /** Last permission mode applied. Mirrors the currentModelId optimization —
   *  we only forward setPermissionMode to the subprocess when it actually
   *  changes, so the common "setting unchanged" turn pays no round-trip. */
  private currentPermissionMode: PermissionMode | undefined;
  /** Whether we've already injected the resume-history preface for this SDK
   *  subprocess. Set false on construction; flipped true on the first sendTurn
   *  regardless of whether a preface was actually emitted. A `/sessions`
   *  resume disposes this entire ClaudeAgentSession (see disposeProviderSession)
   *  so the next instance starts fresh and re-hydrates correctly. */
  private historyReplayed = false;
  private readonly getPermissionMode: () => PermissionMode;
  /** Thinking + effort are resolved once at lazyStart. The SDK has no live
   *  setter for either, so mid-conversation setting changes take effect on
   *  the next fresh session (new conversation / consumer error / reconnect). */
  private readonly getThinking: () => ThinkingConfig;
  private readonly getEffort: () => EffortLevel;
  /** Resolved once at lazyStart — the SDK has no live setter for `skills`, and
   *  changing it mid-session would require respawning the subprocess, which
   *  discards the prompt cache we are trying to protect. */
  private readonly getSkills: () => "all" | string[];
  private readonly emitSkillsInitChip: boolean;

  /** Pending host-side tool approvals keyed by approvalId. Resolved by
   *  `respondToToolApproval` once the user clicks through `PermissionPrompt`. */
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  /** tool_use ids for `AskUserQuestion` calls. These are rendered via the
   *  host's QuestionnaireTabs surface (see `buildCanUseTool`), so we suppress
   *  their generic `tool-call` card and the denied `tool-result` echo to avoid
   *  dumping the raw question JSON into the transcript. */
  private askQuestionToolUseIds = new Set<string>();

  /** Set when we deny+interrupt an `AskUserQuestion` call to hand off to the
   *  questionnaire UI. The SDK ends the turn with an undocumented result
   *  subtype (possibly an error variant); this flag lets the result handler
   *  treat that as a clean turn-end instead of surfacing a spurious
   *  "Claude Agent SDK error" to the user. Consumed by the next `result`. */
  private questionnaireInterruptInFlight = false;

  constructor(params: {
    adapterId: string;
    queryFactory: (params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => ClaudeAgentQuery;
    options: ClaudeAgentOptions;
    /** MCP policy resolved at connect time. Used to assemble `canUseTool` in
     *  lazyStart so the callback closes over `this` (for emitting approval
     *  events on the active turn's controller). Optional for tests — when
     *  omitted defaults to the safest setting (deny all MCP). */
    mcpPolicy?: McpPolicy;
    /** Resolver called at lazyStart AND on every sendTurn so live setting
     *  changes apply to the next turn without reconnecting. Defaults to the
     *  value baked into `options.permissionMode` (mainly for tests). */
    getPermissionMode?: () => PermissionMode;
    /** Start-time-only resolvers. Called once at lazyStart; not re-read per
     *  turn because the SDK provides no live setter for thinking/effort. */
    getThinking?: () => ThinkingConfig;
    getEffort?: () => EffortLevel;
    /** Which skills the SDK preloads. Defaults to none — see the
     *  "Skill disclosure" note above for why that is the right default. */
    getSkills?: () => "all" | string[];
    /** When true, emit a synthetic `tool-call` event for the SDK init
     *  message so the host can render a chip listing the loaded skills.
     *  Used by the isolated Grok-skills variant; off for the normal SDK
     *  adapter to avoid noise on every conversation. */
    emitSkillsInitChip?: boolean;
  }) {
    this.adapterId = params.adapterId;
    this.getPermissionMode =
      params.getPermissionMode ?? ((): PermissionMode => params.options.permissionMode ?? "default");
    this.getThinking = params.getThinking ?? ((): ThinkingConfig => params.options.thinking ?? { type: "adaptive" });
    this.getEffort = params.getEffort ?? ((): EffortLevel => (params.options.effort as EffortLevel) ?? "high");
    this.getSkills = params.getSkills ?? ((): "all" | string[] => []);
    this.emitSkillsInitChip = params.emitSkillsInitChip ?? false;
    // Defer actually starting the subprocess until the first `sendTurn` so
    // switching to this adapter in /models doesn't spawn a process unless the
    // user actually sends a message.
    this.lazyStart = async () => {
      if (this.query) return;
      const initialMode = this.getPermissionMode();
      const initialThinking = this.getThinking();
      const initialEffort = this.getEffort();
      const initialSkills = this.getSkills();
      const canUseTool = this.buildCanUseTool(
        params.mcpPolicy ?? { mcpEnabled: false, allowedPrefixes: new Set(), sdkServers: {} },
      );
      const startOptions: ClaudeAgentOptions = {
        ...params.options,
        permissionMode: initialMode,
        thinking: initialThinking,
        effort: initialEffort,
        canUseTool,
        // Required for any streaming at all: without it the SDK only emits
        // complete assistant messages, so the UI sits silent through the whole
        // thinking phase and then dumps everything in one blob (the
        // `stream_event` handler in dispatchMessage is dead code otherwise).
        includePartialMessages: true,
        // Explicit list, never omitted: omitting means "no SDK configuration",
        // which leaves the CLI's load-every-skill default in place.
        skills: initialSkills,
        // Always set so a mid-session `/permissions yolo` can call
        // setPermissionMode("bypassPermissions") without respawning.
        // The flag enables the mode; it does not itself skip prompts.
        allowDangerouslySkipPermissions: true,
        abortController: this.abortController,
      };
      logLine(
        `lazyStart: adapter=${params.adapterId} model=${startOptions.model ?? "(default)"} cwd=${startOptions.cwd ?? workspaceRoot()} permissionMode=${initialMode} thinking=${initialThinking.type} effort=${initialEffort} skills=${initialSkills === "all" ? "all" : `${initialSkills.length} listed`}`,
      );
      this.query = params.queryFactory({
        prompt: this.input.iterable,
        options: startOptions,
      });
      // Record the bootstrap model + mode so the first sendTurn doesn't issue
      // redundant setModel() / setPermissionMode() for the same values.
      this.currentModelId = params.options.model;
      this.currentPermissionMode = initialMode;
      this.consumerTask = this.consumeOutput();
    };
  }

  /** Boot the SDK subprocess ahead of the first turn. See `ProviderSession.warm`.
   *  Measured cost being moved off the first message: ~1.8s from `lazyStart` to
   *  the SDK's `system:init`. Never throws — a failed warm leaves `this.query`
   *  null and the next `sendTurn` retries `lazyStart` and reports properly. */
  warm = async (): Promise<void> => {
    if (this.disconnected || this.query) return;
    try {
      await this.lazyStart?.();
    } catch (err) {
      logLine(`warm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  sendTurn = (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    if (this.disconnected) {
      return Promise.reject(new Error("Claude Agent SDK session has been disconnected."));
    }
    if (this.activeTurn) {
      // Steering: previous turn is still in flight on the SDK side. The
      // host has already moved on (queued message dispatched mid-turn,
      // or user interrupted with ↑+Enter). Settle the old turn locally,
      // tell the SDK subprocess to stop generating, and drain its
      // in-flight events before starting the new turn.
      const old = this.activeTurn;
      this.activeTurn = null;
      old.cleanup?.();
      try {
        old.controller.emit({ type: "done", stopReason: "aborted" });
        old.resolve({ usage: {} });
      } catch {
        // Old controller may already be torn down — ignore.
      }
      this.retire(old);
      try {
        void this.query?.interrupt();
      } catch {
        // Best-effort — the SDK will still emit a result we drain.
      }
      logLine("sendTurn: steering — interrupted prior turn, draining");
    }

    // Set activeTurn synchronously so the consumer loop never dispatches
    // events to a null turn — even if lazyStart's query begins emitting
    // before this function returns.
    let resolveFn!: (r: { usage?: ProviderUsageSnapshot }) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<{ usage?: ProviderUsageSnapshot }>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const turn: ActiveTurn = {
      controller,
      resolve: resolveFn,
      reject: rejectFn,
      modelId: input.modelId,
    };
    this.activeTurn = turn;
    // Defensive: a prior turn's questionnaire-interrupt flag should never leak
    // into this turn (it's normally consumed by that turn's `result`).
    this.questionnaireInterruptInFlight = false;

    // Wire host AbortSignal → SDK interrupt. The Agent's `abort()` (e.g.
    // when the user hits Esc) flips this signal; without observing it the
    // SDK subprocess would keep generating after the host has moved on,
    // which is exactly the "STOP doesn't work in Claude Agent mode" bug.
    // We settle the turn locally (`done` + resolve) and best-effort tell
    // the subprocess to stop; any in-flight events get swallowed by the
    // `drainingTurns` path until the SDK's own `result` arrives.
    const signal = input.abortSignal;
    if (signal) {
      const onAbort = () => {
        if (this.activeTurn !== turn) return; // already settled (result/error/steer)
        this.activeTurn = null;
        this.retire(turn);
        try {
          turn.controller.emit({ type: "done", stopReason: "aborted" });
          turn.resolve({ usage: {} });
        } catch {
          // Controller already torn down — ignore.
        }
        try {
          void this.query?.interrupt();
        } catch {
          // Subprocess may be dead — the consumer loop will notice.
        }
        logLine("sendTurn: aborted via host signal");
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        turn.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }

    // The turn can be retired (abort / steer / stall / disconnect) while the
    // setup below is suspended. A retired turn's prompt must never be pushed:
    // it would run with nobody listening — tools included, under whatever
    // permission mode is live — and its `result` would be attributed to the
    // next turn.
    const retired = () => this.activeTurn !== turn;

    (async () => {
      try {
        logLine(
          `sendTurn: ${logContentEnabled() ? `prompt=${JSON.stringify(input.prompt.slice(0, 80))} ` : ""}model=${input.modelId}`,
        );
        if (retired()) return;
        await this.lazyStart?.();
        if (retired()) return;
        // Only send a setModel control-request when the model actually
        // changed. setModel is a round-trip to the subprocess so skipping
        // it shaves latency off every turn after the first.
        if (this.query && input.modelId && input.modelId !== this.currentModelId) {
          try {
            await this.query.setModel(input.modelId);
            this.currentModelId = input.modelId;
            logLine(`setModel: ok (${input.modelId})`);
          } catch (err) {
            logLine(`setModel: failed (${input.modelId}) ${err instanceof Error ? err.message : String(err)}`);
          }
          if (retired()) return;
        }
        // Apply any permission-mode change from host settings to the live
        // subprocess. Users can flip `/permissions` mid-conversation and the
        // next turn will honor the new mode — including a switch INTO
        // bypassPermissions, which we enable by always passing
        // allowDangerouslySkipPermissions at start. If the subprocess
        // rejects the switch, canUseTool still honours getPermissionMode()
        // and will auto-allow under yolo / dontAsk.
        if (this.query) {
          const desiredMode = this.getPermissionMode();
          if (desiredMode !== this.currentPermissionMode) {
            try {
              await this.query.setPermissionMode(desiredMode);
              this.currentPermissionMode = desiredMode;
              logLine(`setPermissionMode: ok (${desiredMode})`);
            } catch (err) {
              logLine(`setPermissionMode: failed (${desiredMode}) ${err instanceof Error ? err.message : String(err)}`);
            }
            if (retired()) return;
          }
        }
        controller.emit({ type: "status", status: "streaming" });
        this.armStallWatchdog();
        // The Claude Agent SDK owns conversation history internally across
        // the persistent `prompt` iterable, so on steady-state turns we just
        // push the new user message and the SDK supplies prior context from
        // its own state.
        //
        // The exception is the FIRST sendTurn after lazyStart when the host
        // already has prior messages (i.e. /sessions resume rehydrated a
        // transcript from disk, then disposed the old SDK session). In that
        // case the new SDK subprocess has zero context, so we synthesize a
        // single preface SDKUserMessage carrying the prior history as text
        // and prepend it to the current prompt. This trades tool-call
        // fidelity for the SDK actually seeing what was discussed before.
        let promptToSend = input.prompt;
        if (!this.historyReplayed) {
          this.historyReplayed = true;
          if (input.messages && input.messages.length > 1) {
            // Last entry is the current user prompt — prior turns are everything before.
            const prior = input.messages.slice(0, -1);
            const preface = formatHistoryAsPreface(prior);
            if (preface) {
              promptToSend = `${preface}\n\n${input.prompt}`;
              logLine(`sendTurn: synthesized resume preface (${prior.length} prior messages, ${preface.length} chars)`);
            }
          }
        }
        turn.pushed = true;
        this.input.push({
          type: "user",
          message: { role: "user", content: promptToSend },
          parent_tool_use_id: null,
        });
        logLine("sendTurn: user message pushed to queue");
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logLine(`sendTurn setup failed: ${error.message}`);
        // Only this turn's own failure is ours to report; a replacement turn
        // that took over while setup was suspended is not touched.
        if (retired()) return;
        this.activeTurn = null;
        turn.cleanup?.();
        controller.emit({ type: "error", message: error.message });
        turn.reject(error);
      }
    })();

    return promise;
  };

  abortTurn = async (): Promise<void> => {
    try {
      await this.query?.interrupt();
    } catch {
      // Best effort.
    }
  };

  respondToToolApproval = (approvalId: string, approved: boolean): void => {
    const resolver = this.pendingApprovals.get(approvalId);
    if (!resolver) {
      logLine(`respondToToolApproval: no pending approval for id=${approvalId}`);
      return;
    }
    this.pendingApprovals.delete(approvalId);
    resolver(approved);
  };

  /**
   * Assemble the SDK's `canUseTool` callback. Policy layers, in order:
   *
   *   1. MCP gate (static): deny any `mcp__*` tool that isn't from a
   *      Codesurf-enabled server. This catches Claude.ai-hosted connectors
   *      injected by the gateway plus any disabled local server.
   *   2. AskUserQuestion hand-off to the host questionnaire UI (never runs
   *      the tool; always deny+interrupt).
   *   3. Host authorization — decided before ANY local execution:
   *      a. Yolo / don't-ask / accept-edits shortcut: if the live host
   *         setting says not to prompt, the request is authorized. The SDK
   *         *should* skip this callback under bypassPermissions, but it
   *         still asks after live mode changes — so the host enforces it.
   *      b. No active turn, or a retired turn still draining (abort / steer /
   *         stall until the SDK's `result` arrives): deny. There is no UI
   *         channel to ask, a missing controller is not authorization for a
   *         late request, and a request in the drain window belongs to the
   *         retired turn — never the replacement's controller.
   *      c. Host prompt: emit a `tool-approval-request` on the active turn's
   *         controller and await the user's click via `respondToToolApproval`.
   *   4. Execution choice for an authorized request: native ripgrep fast
   *      path when the Bash command is a simple `rg` and the turn is still
   *      live, otherwise allow so the SDK runs the tool.
   *
   * SDK auto-DENIES (dontAsk allow-list miss, auto-mode classifier, explicit
   * deny rule) never reach this callback; they arrive as
   * `system`/`permission_denied` messages, surfaced in `dispatchMessage`.
   */
  private buildCanUseTool(policy: McpPolicy): CanUseTool {
    return async (toolName, input, options) => {
      // MCP gating (static — never prompts).
      const mcpDenial = mcpDenyReason(policy, toolName);
      if (mcpDenial) {
        return { behavior: "deny", message: mcpDenial };
      }
      // An MCP tool from an enabled server falls through to the host prompt.

      // AskUserQuestion (SDK built-in): the model wants to present a
      // structured multiple-choice prompt. The allow/deny permission channel
      // can't carry an answer back to the built-in tool, and running it
      // headlessly produces a raw-JSON tool result rather than CodeSurf's
      // QuestionnaireTabs UI. So intercept it here: surface the questions to
      // the host's questionnaire surface and DENY+interrupt so the turn ends
      // cleanly. The user's selections arrive as a follow-up "Answered: …"
      // message on the next turn (mirroring the `ask_user_structured` flow on
      // the ai-sdk path). `interrupt` stops generation so the model can't loop
      // on the denied result before that message arrives.
      if (toolName === "AskUserQuestion") {
        // While a retired turn drains, the request is that turn's: never show
        // its questions on the replacement, and never mark the replacement's
        // result as a questionnaire stop (the retired result is swallowed).
        const draining = this.drainingTurns > 0;
        const qTurn = draining ? null : this.activeTurn;
        const q = (input ?? {}) as { title?: string; questions?: unknown };
        if (qTurn) {
          try {
            qTurn.controller.emit({
              type: "questionnaire-request",
              title: typeof q.title === "string" ? q.title : undefined,
              questions: q.questions ?? [],
            });
          } catch (err) {
            logLine(`canUseTool: questionnaire emit failed ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!draining) this.questionnaireInterruptInFlight = true;
        return {
          behavior: "deny",
          interrupt: true,
          message:
            "These questions were presented to the user in the CodeSurf question UI. " +
            "Do not call AskUserQuestion again. The user's selections will arrive as a " +
            'follow-up message beginning with "Answered:" — stop and wait for it before proceeding.',
        };
      }

      // ── Host authorization ─────────────────────────────────────────────
      // Decide whether this request is permitted BEFORE choosing how to run
      // it. Nothing below this block may read or execute anything until the
      // decision is "allowed" — the ripgrep fast path used to run first and
      // performed the read before the user was ever asked.
      //
      // Live permission setting wins over whatever the subprocess last
      // acknowledged. This is what makes `/permissions yolo` take effect on
      // the next tool call of the current turn, not only after a reconnect.
      let turn = this.activeTurn;
      if (this.drainingTurns > 0) {
        // Draining: the host retired a turn (abort / steer / stall) and the
        // SDK has not yet emitted that turn's `result`, so it cannot be
        // processing the replacement yet — every request in this window
        // belongs to the retired turn. Treat it as having no turn: never
        // prompt on the replacement's controller, and never run natively
        // (which would emit onto the replacement and push a synthetic
        // tool_result for the retired turn's toolUseID). `interrupt()` is
        // best-effort, so the SDK-side signal cannot be relied on for this.
        turn = null;
      }
      if (!hostAutoAllowsTool(this.getPermissionMode(), toolName)) {
        if (!turn) {
          // No turn to authorize against: there is no UI channel to ask, and
          // the absence of a controller is not authorization. A request that
          // arrives after the turn retired (result / abort / steer), while a
          // retired turn is still draining, or before any turn was sent is
          // denied unless an explicit policy permitted it above.
          logLine(
            `canUseTool: denied ${toolName} — ${
              this.drainingTurns > 0 ? "retired turn still draining" : "no active turn to authorize it"
            }`,
          );
          return { behavior: "deny", message: "No active Codesurf turn to authorize this tool request." };
        }

        const approvalId = `claude-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const promptTurn = turn;
        const approved = await new Promise<boolean>((resolve) => {
          this.pendingApprovals.set(approvalId, resolve);
          const onAbort = () => {
            if (!this.pendingApprovals.delete(approvalId)) return;
            resolve(false);
          };
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
          try {
            promptTurn.controller.emit({
              type: "tool-approval-request",
              approvalId,
              toolName,
              input,
            });
          } catch (err) {
            logLine(`canUseTool: emit failed (${toolName}) ${err instanceof Error ? err.message : String(err)}`);
            this.pendingApprovals.delete(approvalId);
            resolve(false);
          }
        });

        if (!approved) {
          return { behavior: "deny", message: "User denied the request via Codesurf permission prompt." };
        }
        // The prompt may have outlived its turn (abort / steer while pending).
        // The user's approval stands, but native execution below needs that
        // same turn's controller — without it, let the SDK run the tool.
        if (this.activeTurn !== promptTurn) turn = null;
      }

      // ── Execution: native ripgrep fast path vs SDK ─────────────────────
      // Authorized. When the SDK's Bash tool is a simple `rg`, intercept and
      // run our streaming native grep instead of letting the SDK's buffered
      // Bash subprocess handle it. The result is pushed back as a synthetic
      // tool_use_result so the model sees the output without the SDK actually
      // executing the command. On parse miss or execute failure we fall
      // through so the SDK can run the real shell.
      if (turn && toolName === "Bash" && typeof input?.command === "string") {
        const rgParams = tryParseRipgrepCommand(input.command);
        if (rgParams) {
          const cwd = workspaceRoot();
          const toolUseId = options.toolUseID ?? "";
          try {
            const result = await executeGrep(rgParams, cwd, options.signal);
            const output = result.success ? result.output : (result.error ?? "Grep failed");
            turn.controller.emit({
              type: "tool-call",
              id: toolUseId,
              toolName: "Bash",
              args: input,
            });
            turn.controller.emit({
              type: "tool-result",
              id: toolUseId,
              result: output,
              isError: !result.success,
            });
            this.input.push({
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUseId,
                    content: output,
                    is_error: !result.success,
                  },
                ],
              },
              parent_tool_use_id: null,
              isSynthetic: true,
              tool_use_result: output,
            });
            return {
              behavior: "deny",
              message: "Ripgrep fast-path: result already provided.",
              interrupt: false,
            };
          } catch {
            // Fall through — let the SDK run Bash normally.
          }
        }
      }

      return { behavior: "allow", updatedInput: input };
    };
  }

  disconnect = async (): Promise<void> => {
    if (this.disconnected) return;
    this.clearStallWatchdog();
    this.disconnected = true;
    this.abortController.abort();
    this.input.close();
    // Drain any unresolved approval prompts as denials so the SDK subprocess
    // doesn't sit forever waiting on a host promise that will never resolve.
    for (const [id, resolver] of this.pendingApprovals) {
      try {
        resolver(false);
      } catch {}
      this.pendingApprovals.delete(id);
    }
    if (this.activeTurn) {
      const turn = this.activeTurn;
      this.activeTurn = null;
      turn.cleanup?.();
      try {
        turn.reject(new Error("Session disconnected."));
      } catch {}
    }
    try {
      await this.consumerTask;
    } catch {
      // Consumer task may reject on abort — that's expected.
    }
  };

  private armStallWatchdog(): void {
    if (STALL_TIMEOUT_MS <= 0) return;
    const turn = this.activeTurn;
    if (!turn) return;
    this.stallTurn = turn;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(this.onStall, STALL_TIMEOUT_MS);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.stallTurn = null;
  }

  /** Fired when no SDK message has arrived for STALL_TIMEOUT_MS. Settles the
   *  active turn with an error and interrupts the subprocess so a silent stream
   *  (dropped connection / unresolved rate-limit) doesn't hang forever. Waiting
   *  on a user tool-approval is not a stall — re-arm and keep waiting. */
  private onStall = (): void => {
    this.stallTimer = null;
    const turn = this.activeTurn;
    // Stale timer from a turn that already settled — ignore.
    if (!turn || turn !== this.stallTurn) return;
    // A pending tool-approval is the user thinking, not a dead stream.
    if (this.pendingApprovals.size > 0) {
      this.armStallWatchdog();
      return;
    }
    const seconds = Math.round(STALL_TIMEOUT_MS / 1000);
    const message = `Provider stream stalled — no activity for ${seconds}s. The model connection may have dropped or been rate-limited. Try again.`;
    logLine(`stall watchdog: ${message}`);
    this.activeTurn = null;
    this.stallTurn = null;
    this.retire(turn);
    turn.cleanup?.();
    try {
      turn.controller.emit({ type: "error", message });
    } catch {
      // Controller already torn down — ignore.
    }
    try {
      turn.reject(new Error(message));
    } catch {
      // Already settled — ignore.
    }
    try {
      void this.query?.interrupt();
    } catch {
      // Subprocess may be dead — the consumer loop will notice.
    }
  };

  private async consumeOutput(): Promise<void> {
    if (!this.query) return;
    logLine(`consumer loop starting (adapter=${this.adapterId})`);
    try {
      for await (const message of this.query) {
        if (this.disconnected) break;
        // Any subprocess activity proves the stream is alive — reset the watchdog.
        if (this.activeTurn) this.armStallWatchdog();
        const kind = (message as { type?: string }).type ?? "unknown";
        const sub = (message as { subtype?: string }).subtype;
        if (kind === "assistant") {
          const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content;
          const blockTypes = (content ?? []).map((b) => b.type);
          logLine(`<- assistant blocks=${JSON.stringify(blockTypes)}`);
          // Dump first 200 chars of each text block so we can see what arrived.
          for (const block of logContentEnabled() ? (content ?? []) : []) {
            const b = block as { type?: string; text?: string };
            if (b.type === "text" && typeof b.text === "string") {
              logLine(`   text: ${JSON.stringify(b.text.slice(0, 200))}`);
            }
          }
        } else if (kind === "stream_event") {
          const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (event?.type === "content_block_delta") {
            logLine(
              `<- stream_event delta.type=${event.delta?.type}${
                logContentEnabled() ? ` text=${JSON.stringify(event.delta?.text?.slice(0, 80) ?? "")}` : ""
              }`,
            );
          } else {
            logLine(`<- stream_event ${event?.type}`);
          }
        } else {
          logLine(`<- ${kind}${sub ? `:${sub}` : ""}`);
        }
        if (this.drainingTurns > 0) {
          if (message.type === "result") {
            this.drainingTurns -= 1;
            // A questionnaire hand-off on the retired turn ends with this
            // result; it must not leak onto the live turn's result.
            this.questionnaireInterruptInFlight = false;
            logLine(`drain: interrupted-turn result swallowed (${this.drainingTurns} still draining)`);
          } else {
            logLine(`drain: dropped ${kind}`);
          }
          continue;
        }
        if (!this.activeTurn) continue;
        this.dispatchMessage(message, this.activeTurn);
      }
      this.clearStallWatchdog();
      logLine("consumer loop ended (stream closed)");
      // The SDK closes its stream only when the subprocess is gone. Unless we
      // asked for that (disconnect), it is the same dead session as a throw:
      // a turn in flight would otherwise wait out the stall watchdog.
      if (!this.disconnected) this.failSession(new Error("Claude Agent SDK stream ended unexpectedly."));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logLine(`consumer error: ${error.message}`);
      this.failSession(error);
    }
  }

  /** Settle the active turn with `error` and mark the session dead so the next
   *  sendTurn rejects fast and the host evicts and reconnects. */
  private failSession(error: Error): void {
    const current = this.activeTurn;
    if (current) {
      this.activeTurn = null;
      current.cleanup?.();
      current.controller.emit({ type: "error", message: error.message });
      current.reject(error);
    }
    // The consumer loop is the ONLY reader of `query`. If it throws, the
    // CLI subprocess is almost certainly dead — leaving `query` set would
    // let `lazyStart`'s idempotency short-circuit the next sendTurn into
    // pushing onto a dead input with no consumer, which hangs forever.
    // Mark the session unusable so the next sendTurn rejects fast and the
    // host can evict us from its cache and reconnect.
    this.clearStallWatchdog();
    this.disconnected = true;
    this.input.close();
    this.query = null;
    try {
      this.abortController.abort();
    } catch {
      // Already aborted — ignore.
    }
  }

  /** Account for a turn retired before its `result`. */
  private retire(turn: ActiveTurn): void {
    if (turn.pushed) this.drainingTurns += 1;
  }

  private dispatchMessage(message: SDKMessage, turn: ActiveTurn): void {
    switch (message.type) {
      case "assistant": {
        // Complete assistant message; extract text + tool-use blocks.
        const content = message.message?.content ?? [];
        for (const block of content) {
          const b = block as {
            type?: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
            thinking?: string;
          };
          if (b.type === "text" && typeof b.text === "string") {
            // Skip when partials already streamed this text (dedupe).
            if (!turn.streamedText) {
              turn.controller.emit({ type: "text-delta", delta: b.text });
            }
          } else if (b.type === "tool_use") {
            // AskUserQuestion is surfaced via the questionnaire UI in
            // `buildCanUseTool`; suppress its generic tool-call card (and,
            // later, its denied tool-result echo) so the raw question JSON
            // never lands in the transcript.
            if (b.name === "AskUserQuestion") {
              if (b.id) this.askQuestionToolUseIds.add(b.id);
            } else {
              turn.controller.emit({
                type: "tool-call",
                id: b.id ?? "",
                toolName: b.name ?? "unknown",
                args: b.input,
              });
            }
          } else if (b.type === "thinking" && typeof b.thinking === "string") {
            // Skip when partials already streamed this thinking (dedupe).
            if (!turn.streamedThinking) {
              turn.controller.emit({ type: "reasoning-delta", delta: b.thinking });
            }
          } else if (b.type === "server_tool_use" || b.type === "mcp_tool_use") {
            // Server-side / hosted tools (web_search, code_execution, MCP,
            // etc.) run INSIDE the API, not through `canUseTool` — we don't
            // execute them. But we MUST surface the call as a tool-call chip,
            // otherwise the UI shows nothing while the tool runs and the agent
            // looks frozen (root cause of the "said X then nothing" hang: this
            // block was previously dropped as "unknown assistant block type").
            turn.controller.emit({
              type: "tool-call",
              id: b.id ?? "",
              toolName: b.name ?? b.type,
              args: b.input,
            });
          } else if (typeof b.type === "string" && b.type.endsWith("_tool_result")) {
            // Paired result for a server-side tool (web_search_tool_result,
            // code_execution_tool_result, mcp_tool_result, …). Surface it so
            // the chip resolves instead of spinning forever.
            const rb = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
            turn.controller.emit({
              type: "tool-result",
              id: rb.tool_use_id ?? "",
              result: rb.content,
              isError: rb.is_error === true,
            });
          } else {
            logLine(`dispatch: unknown assistant block type: ${b.type}`);
          }
        }
        break;
      }
      case "stream_event": {
        // Partial assistant deltas (fine-grained streaming — requires
        // `includePartialMessages: true`, set in lazyStart).
        const event = message.event;
        if (event.type === "content_block_delta") {
          const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            turn.streamedText = true;
            turn.controller.emit({ type: "text-delta", delta: delta.text });
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            turn.streamedThinking = true;
            turn.controller.emit({ type: "reasoning-delta", delta: delta.thinking });
          }
          // signature_delta / input_json_delta etc. are ignored: tool args are
          // emitted from the complete assistant message's tool_use blocks.
        }
        break;
      }
      case "user": {
        // Tool results echoed back from the SDK.
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              (block as { type?: string }).type === "tool_result"
            ) {
              const r = block as {
                tool_use_id?: string;
                content?: unknown;
                is_error?: boolean;
              };
              // Suppress the denied AskUserQuestion result — it's handled by
              // the questionnaire UI, and its content is the deny message, not
              // anything the transcript should show.
              if (r.tool_use_id && this.askQuestionToolUseIds.has(r.tool_use_id)) {
                this.askQuestionToolUseIds.delete(r.tool_use_id);
                continue;
              }
              turn.controller.emit({
                type: "tool-result",
                id: r.tool_use_id ?? "",
                result: r.content,
                isError: r.is_error === true,
              });
            }
          }
        }
        break;
      }
      case "result": {
        const usage: ProviderUsageSnapshot =
          message.subtype === "success" ? (usageFromRecord(message.usage) ?? {}) : {};
        turn.controller.emit({ type: "usage", usage });
        // A turn we interrupted to hand off to the questionnaire UI ends with
        // a non-success subtype, but that's an expected, clean stop — settle it
        // as `done` so the user doesn't see a spurious SDK error next to the
        // questions. The pending follow-up "Answered: …" message resumes work.
        const wasQuestionnaireInterrupt = this.questionnaireInterruptInFlight;
        this.questionnaireInterruptInFlight = false;
        this.askQuestionToolUseIds.clear();
        if (message.subtype === "success" || wasQuestionnaireInterrupt) {
          turn.controller.emit({ type: "done", stopReason: message.stop_reason ?? undefined });
          turn.resolve({ usage });
        } else {
          const err = new Error(`Claude Agent SDK error (${message.subtype}).`);
          turn.controller.emit({ type: "error", message: err.message });
          turn.reject(err);
        }
        this.activeTurn = null;
        turn.cleanup?.();
        break;
      }
      default:
        // Init, auth status, compact boundary, etc. — surface as status if
        // useful, otherwise ignore. We intentionally avoid forwarding every
        // SDK event to keep the controller signal focused.
        break;
    }
    if (this.emitSkillsInitChip && message.type === "system" && (message as { subtype?: string }).subtype === "init") {
      const skills = (message as { skills?: unknown }).skills;
      if (Array.isArray(skills) && skills.length > 0) {
        const uuid = (message as { uuid?: string }).uuid ?? "";
        const id = `skills-init-${uuid}`;
        turn.controller.emit({
          type: "tool-call",
          id,
          toolName: "skills_loaded",
          args: { count: skills.length, names: skills },
        });
        // Pair with an immediate tool-result so the chip persists in the
        // transcript. The live-feed pipeline only converts tool calls into
        // persistent ChatEntry rows when a matching tool-result chunk lands;
        // a synthetic init chip without a result would render briefly as a
        // running chip and then disappear from the message feed.
        const lines = (skills as unknown[])
          .map((s) => (typeof s === "string" ? `- ${s}` : `- ${JSON.stringify(s)}`))
          .join("\n");
        turn.controller.emit({
          type: "tool-result",
          id,
          result: `**${skills.length} skills loaded**\n\n${lines}`,
          isError: false,
        });
      }
    }
    // Auto-denied tool calls (dontAsk mode, auto-mode classifier, deny rules)
    // never reach `canUseTool` — the SDK denies them itself and the only
    // model-visible trace is an is_error tool_result. Render a persistent
    // notice chip so the user can see the denial happened and how to get
    // prompting back, instead of the agent appearing to silently lose tools.
    if (message.type === "system" && (message as { subtype?: string }).subtype === "permission_denied") {
      const denial = message as unknown as {
        tool_name?: string;
        tool_use_id?: string;
        decision_reason_type?: string;
        decision_reason?: string;
        message?: string;
        uuid?: string;
      };
      const toolName = denial.tool_name ?? "unknown";
      const mode = this.getPermissionMode();
      const reason =
        denial.decision_reason ??
        (denial.decision_reason_type === "mode"
          ? `permission mode "${mode}" auto-denies tools that are not pre-approved`
          : denial.decision_reason_type === "classifier"
            ? "the auto-mode classifier denied it"
            : denial.decision_reason_type === "rule"
              ? "a deny rule matched it"
              : (denial.message ?? "not pre-approved"));
      const id = `permission-denied-${denial.tool_use_id ?? denial.uuid ?? ""}`;
      turn.controller.emit({
        type: "tool-call",
        id,
        toolName: "permission_denied",
        args: { tool: toolName, mode, reason: denial.decision_reason_type ?? "unknown" },
      });
      turn.controller.emit({
        type: "tool-result",
        id,
        result:
          `**${toolName} was auto-denied without a prompt** — ${reason}.\n\n` +
          `Current permission mode: \`${mode}\`. Run \`/permissions ask\` to be prompted instead.`,
        isError: true,
      });
    }
  }
}

// ── Extension module ─────────────────────────────────────────────────────────

function checkCredential(): CredentialStatus {
  // The SDK drives its own auth (claude CLI). We can't detect this without
  // spawning the subprocess, so report "ok" and let the adapter surface a
  // real error on first use if auth is missing.
  return { ok: true };
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Claude Agent SDK",
  version: "1.0.0",
  description:
    "Claude models via the persistent @anthropic-ai/claude-agent-sdk session. Uses your local claude CLI authentication.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: true,
  capabilities: ["provider-adapters", "models", "settings"],
};

export const claudeAgentProviderPlugin: CodesurfPlugin = {
  name: "codesurf-claude-agent-provider",
  manifest,
  inject: ["contributions", "settings", "mcp"],
  apply(ctx: PluginContext) {
    // Register settings before the provider so the first `connect()` can
    // read persisted values (or their seeded defaults).
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: SKILLS_SETTING,
        title: "Preloaded skills",
        description:
          "How many Agent Skills the SDK loads into every session. 'Minimal' keeps the session lean and the prompt cache stable — unlisted skills stay on disk and are still reachable via Read or a subagent. 'All' preloads the full catalogue (296 skills ≈ 33k tokens here) and makes the first response markedly slower. Applies to new sessions.",
        type: "select",
        default: DEFAULT_SKILLS,
        section: "Claude Agent SDK",
        options: SKILLS_OPTIONS,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: PERMISSION_MODE_SETTING,
        title: "Claude Agent permission mode",
        description:
          "Controls how the Claude Agent SDK handles tool-use permission prompts. Changes apply on the next tool call. Always-approve / yolo (bypassPermissions) and don't-ask skip the host prompt even mid-conversation.",
        type: "select",
        default: DEFAULT_PERMISSION_MODE,
        section: "Claude Agent SDK",
        options: PERMISSION_MODE_OPTIONS,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: THINKING_SETTING,
        title: "Claude Agent thinking mode",
        description:
          "Controls extended thinking. 'adaptive' lets Claude decide when and how much to think (default). 'enabled' always thinks with the budget guided by the effort setting. 'disabled' skips extended thinking. Takes effect on the next fresh session — the SDK has no live setter.",
        type: "select",
        default: DEFAULT_THINKING,
        section: "Claude Agent SDK",
        options: THINKING_OPTIONS,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: EFFORT_SETTING,
        title: "Claude Agent effort level",
        description:
          "How hard Claude tries. 'high' is the default. 'xhigh' is Opus 4.7/4.8 only (falls back to 'high' elsewhere); 'max' is supported by select models only. Takes effect on the next fresh session.",
        type: "select",
        default: DEFAULT_EFFORT,
        section: "Claude Agent SDK",
        options: EFFORT_OPTIONS,
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Claude Agent SDK",
        description:
          "Persistent connection via @anthropic-ai/claude-agent-sdk. One slow-start per conversation; all subsequent turns reuse the same session. Authentication is delegated to the claude CLI.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "stdio",
        connectionMode: "persistent",
        sessionStrategy: "singleton",
        capabilities: {
          streaming: true,
          tools: true,
          images: true,
          reasoning: true,
        },
        models: toRegisteredModels(),
        auth: {
          mode: "agent-sdk",
          check: checkCredential,
        },
        adapter: {
          connect: async (ctx: ProviderConnectionContext): Promise<ProviderSession> => {
            // Lazy-load the SDK so users who never select this adapter don't
            // pay the import cost.
            const sdk = await import("@anthropic-ai/claude-agent-sdk");
            const resolveMode = (): PermissionMode => {
              const raw = ctx.settings.get<unknown>(PERMISSION_MODE_SETTING, DEFAULT_PERMISSION_MODE);
              return isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
            };
            const resolveThinking = (): ThinkingConfig => {
              const raw = ctx.settings.get<unknown>(THINKING_SETTING, DEFAULT_THINKING);
              const mode = isThinkingMode(raw) ? raw : DEFAULT_THINKING;
              return thinkingConfigFor(mode);
            };
            const resolveEffort = (): EffortLevel => {
              const raw = ctx.settings.get<unknown>(EFFORT_SETTING, DEFAULT_EFFORT);
              return isEffortLevel(raw) ? raw : DEFAULT_EFFORT;
            };
            const resolveSkills = (): "all" | string[] => {
              const raw = ctx.settings.get<unknown>(SKILLS_SETTING, DEFAULT_SKILLS);
              return skillsOptionFor(isSkillsMode(raw) ? raw : DEFAULT_SKILLS);
            };
            // ctx.services is always supplied by model-runtime's connect()
            // path. The optional typing is for check()/startAuth() callers.
            const { options, policy } = buildSessionOptions(ctx.modelId, ctx.mcp!);
            return new ClaudeAgentSession({
              adapterId: ctx.adapterId,
              queryFactory: sdk.query as unknown as (params: {
                prompt: AsyncIterable<SDKUserMessage>;
                options: ClaudeAgentOptions;
              }) => ClaudeAgentQuery,
              options,
              mcpPolicy: policy,
              getPermissionMode: resolveMode,
              getThinking: resolveThinking,
              getEffort: resolveEffort,
              getSkills: resolveSkills,
            });
          },
        },
      }),
    );

    // Skills-isolated mode — register the Claude SDK + Grok-skills adapter as an
    // alternate model set on this provider (folded in from the former standalone
    // builtin.provider-claude-skills extension). The shared session class
    // is injected so the skills module needs no runtime import back into here.
    registerClaudeSkillsProvider(ctx, ClaudeAgentSession);
  },
};

/**
 * Translate Codesurf's `McpServerConfig` shape into the Claude Agent SDK's
 * `mcpServers` map shape. Filters to enabled servers only. Returns `null`
 * for malformed entries (no command for stdio, no url for http/sse) so
 * the caller can drop them rather than crash the SDK at session start.
 */
function codesurfMcpToSdkConfig(server: CodesurfMcpServerConfig): Record<string, unknown> | null {
  if (server.transport === "stdio") {
    if (!server.command) return null;
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
    };
  }
  if (!server.url) return null;
  return {
    type: server.transport,
    url: server.url,
    headers: server.headers,
  };
}

/** MCP policy resolved at session start. The session assembles `canUseTool`
 *  from this plus the host approval hook so the same callback can both gate
 *  MCP tools statically AND prompt the host UI for everything else. */
/**
 * The static MCP verdict for a tool name; null when MCP is not involved or
 * the tool comes from an enabled server.
 *
 * Deliberately pure and free of turn state: it is the one rule that must hold
 * no matter how the request arrives, so both the `canUseTool` callback and the
 * PreToolUse hook evaluate exactly this.
 */
export function mcpDenyReason(
  policy: Pick<McpPolicy, "mcpEnabled" | "allowedPrefixes">,
  toolName: string,
): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  if (!policy.mcpEnabled) {
    return "MCP is disabled in Codesurf — enable the MCP extension to use MCP tools.";
  }
  for (const prefix of policy.allowedPrefixes) {
    if (toolName.startsWith(prefix)) return null;
  }
  return "This MCP tool is not from a Codesurf-enabled server. Enable it in Codesurf's `/mcp` settings to allow.";
}

/**
 * Enforce the MCP gate as a PreToolUse hook, not only in `canUseTool`.
 *
 * Under `permissionMode: "bypassPermissions"` the SDK auto-approves every tool
 * call BEFORE consulting `canUseTool` — it says so itself, via the
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning. That left the gate open in yolo
 * mode for exactly the tools it exists to stop: gateway-injected connectors
 * (Gmail, Drive, Calendar, Linear), which `mcpServers` cannot unload and
 * `disallowedTools` cannot express as a wildcard.
 *
 * Hooks run regardless of permission mode, which is what the SDK's own
 * warning recommends. `canUseTool` keeps the same check for the paths it does
 * still serve, so neither is load-bearing alone.
 */
export function buildMcpDenyHook(policy: Pick<McpPolicy, "mcpEnabled" | "allowedPrefixes">): HookCallback {
  return async (input) => {
    const toolName =
      typeof (input as { tool_name?: unknown }).tool_name === "string"
        ? (input as { tool_name: string }).tool_name
        : "";
    const reason = mcpDenyReason(policy, toolName);
    if (!reason) return {};
    logLine(`PreToolUse: denied ${toolName} — ${reason}`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

interface McpPolicy {
  mcpEnabled: boolean;
  /** Prompt text naming CodeSurf's published tools, appended to the SDK prompt. */
  codesurfPrompt?: string;
  /** Set of `mcp__<server>__` prefixes the user has enabled. Empty when MCP
   *  is disabled OR enabled with no servers — both deny all MCP tools. */
  allowedPrefixes: Set<string>;
  /** Pre-built SDK `mcpServers` map. `{}` when MCP is disabled. */
  sdkServers: Record<string, unknown>;
}

/**
 * CodeSurf's own plugin tools, as an in-process MCP server the SDK mounts.
 *
 * This is what closes the gap for SDK-hosted models: they bring their own
 * toolset and prompt, so a plugin's tool was invisible to them. Publishing it
 * over MCP needs no per-provider forwarding — any provider that accepts MCP
 * config picks it up the same way.
 */
function codesurfServerEntry(): {
  sdkServers?: Record<string, unknown>;
  allowedPrefixes?: Set<string>;
  codesurfPrompt?: string;
} {
  try {
    const built = buildCodesurfMcpServer();
    if (!built) return {};
    return {
      sdkServers: { [CODESURF_MCP_SERVER_ID]: built.server },
      allowedPrefixes: new Set([CODESURF_MCP_PREFIX]),
      codesurfPrompt: codesurfMcpPromptSection(built.toolNames),
    };
  } catch {
    // Never block a session on tool publishing.
    return {};
  }
}

function resolveMcpPolicy(services: McpService): McpPolicy {
  // CodeSurf's own tools are resolved FIRST and independently. They are this
  // app's tool surface, not an external server, so they must not disappear
  // because `/mcp` is off or because host services threw while resolving
  // third-party servers — which is exactly what used to happen: the outer
  // catch below returned an empty policy and the model silently lost them.
  const own = codesurfServerEntry();
  const withOwn = (policy: McpPolicy): McpPolicy => {
    for (const [id, cfg] of Object.entries(own.sdkServers ?? {})) policy.sdkServers[id] = cfg;
    for (const prefix of own.allowedPrefixes ?? []) policy.allowedPrefixes.add(prefix);
    policy.codesurfPrompt = own.codesurfPrompt;
    return policy;
  };

  try {
    if (!services.isEnabled()) {
      return withOwn({ mcpEnabled: false, allowedPrefixes: new Set(), sdkServers: {} });
    }
    const enabledServers = loadMcpServers().filter((s) => s.enabled);
    const sdkServers: Record<string, unknown> = {};
    const allowedPrefixes = new Set<string>();
    for (const server of enabledServers) {
      const sdkCfg = codesurfMcpToSdkConfig(server);
      if (sdkCfg) {
        sdkServers[server.id] = sdkCfg;
        allowedPrefixes.add(`mcp__${server.id}__`);
      }
    }
    return withOwn({ mcpEnabled: true, allowedPrefixes, sdkServers });
  } catch {
    // External MCP is unavailable (pre-bootstrap edge cases). CodeSurf's own
    // tools still ship.
    return withOwn({ mcpEnabled: false, allowedPrefixes: new Set(), sdkServers: {} });
  }
}

/**
 * Build the Claude Agent SDK options for a new session.
 *
 * MCP gating contract — based on the official Claude Agent SDK permission
 * docs (https://docs.claude.com/en/api/agent-sdk/permissions):
 *
 *   - `mcpServers` controls which MCP servers the SDK loads locally. Setting
 *     it to `{}` prevents the SDK from picking up `~/.claude` MCP config.
 *     It does NOT affect MCP tools injected by the API gateway (Claude.ai
 *     hosted connectors like Gmail/Calendar/Drive/Linear).
 *   - `disallowedTools` only matches scoped patterns: `mcp__<server>` or
 *     `mcp__<server>__<tool>` / `mcp__<server>__*`. There is NO documented
 *     global `mcp__*` wildcard — so we cannot statically deny "all MCP
 *     tools regardless of server" via this list.
 *   - `canUseTool` is a runtime callback consulted last in the evaluation
 *     flow. The session attaches the real callback in lazyStart — it
 *     statically denies MCP tools the user hasn't approved AND routes every
 *     other tool through the host's permission UI, unless the live
 *     permission mode is yolo / dontAsk (host auto-allows).
 *
 * Caveat: the SDK *should* skip `canUseTool` under `bypassPermissions`, but
 * it still asks after live mode changes. The host callback therefore
 * auto-allows under yolo and dontAsk itself. MCP tools from disabled
 * servers stay denied even in yolo.
 */
export function buildSessionOptions(
  modelId: string | undefined,
  services: McpService,
): { options: ClaudeAgentOptions; policy: McpPolicy } {
  const policy = resolveMcpPolicy(services);
  const base: ClaudeAgentOptions = {
    model: modelId,
    cwd: workspaceRoot(),
    // biome-ignore lint/suspicious/noExplicitAny: SDK union type is wider than our translator covers; cast at the boundary.
    mcpServers: policy.sdkServers as any,
    // Strict MCP enforcement always-on: only Codesurf-managed servers reach the
    // model. Without this the SDK gateway can still inject Claude.ai-hosted
    // connectors alongside the explicit `mcpServers` map.
    strictMcpConfig: true,
    // The MCP gate, enforced where permission mode cannot shadow it. Under
    // bypassPermissions the SDK approves tools before `canUseTool` is
    // consulted, which is precisely when an un-enabled connector must still
    // be refused.
    hooks: {
      PreToolUse: [{ hooks: [buildMcpDenyHook(policy)] }],
    },
    // Append, never replace: the SDK's own prompt is what makes its built-in
    // tools work. This only adds the CodeSurf tools it would otherwise have no
    // idea about, plus whatever plugins contributed via registerPromptSection.
    ...(policy.codesurfPrompt
      ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: policy.codesurfPrompt } }
      : {}),
  };
  return { options: base, policy };
}

// Export internals for tests.
export { AsyncPushQueue, ClaudeAgentSession };
