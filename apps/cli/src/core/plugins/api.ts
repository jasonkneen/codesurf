// Extension Host API (codesurf).
//
// Trimmed from the termcast V1 spec. Scope:
//   - Commands (slash commands)
//   - Tools (ai-sdk ToolSet entries)
//   - Model providers + models (multi-provider support)
//   - Settings definitions
//   - Toasts / notifications
// Intentionally NOT included: popups, surface providers, actions,
// message renderers, focus, dialogs, attachments. Grok's app.tsx keeps its
// own hand-tuned rendering for those.

import type { Tool as AiTool, LanguageModel, ToolSet } from "ai";
import type { ReactNode } from "react";
import type { AggregatedHookResult, HookEvent, HookInput } from "../../hooks/index";
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
import type { AgentMode, TaskRequest, ToolResult } from "../../types/index";
import type { ClaudeAgentGroup } from "../../ui/claude-agent-modal";
import type { McpEditorDraft } from "../../ui/mcp-modal-types";
import type { SandboxMode, SandboxSettings, UiMode } from "../../utils/settings";
import type { HostGroupMetadata, HostManifest } from "./manifest";

// ── Input observation / interception ──────────────────────────────────────────

/**
 * Minimal key descriptor passed to input interceptors. Mirrors the relevant
 * subset of `@opentui/core`'s `ParsedKey` so extensions don't need to import
 * from the renderer package.
 */
export interface InputKey {
  /** Normalised key name (e.g. `"space"`, `"return"`, `"a"`, `"f9"`). */
  name: string;
  /** Raw character sequence as received from stdin. */
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Alt/option modifier — terminals fold these together. */
  option?: boolean;
  super?: boolean;
}

/**
 * Return value contract for an input interceptor:
 *   - `true`  → swallow this key (textarea + downstream handlers won't see it)
 *   - `false` → let the key propagate normally (default)
 */
export type InputInterceptor = (key: InputKey) => boolean;

/**
 * Context-window usage snapshot for the active session against the active
 * model. Mirrors `Agent.getContextStats()`. Surfaced to extensions via
 * `services.context.getStats()`.
 */
export interface ContextStats {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  ratioUsed: number;
  ratioRemaining: number;
}

/**
 * Detailed token breakdown for the active session.
 * Useful for /context command and diagnostics.
 * All token counts are estimates (chars/4).
 */
export interface ContextBreakdown extends ContextStats {
  /** Estimated tokens for the (rebuilt) system prompt. */
  systemTokens: number;
  /** If a compaction summary is the first message, its estimated tokens. */
  compactionSummaryTokens: number;
  /** Estimated tokens for the kept history messages (after any summary). */
  historyTokens: number;
  /** Tokens from the current in-flight / composing text (added to system est for live meter). */
  inFlightTokens: number;
}

/**
 * Closed-loop agent looping (inspired by the "agent looping" model:
 * discovery → planning → execution → verification → iteration until goal met
 * within explicit standards).
 *
 * A LoopSpec is the human-designed "standard" that keeps the loop honest.
 * It is intentionally extensible so later we can add phases, sub-specs for
 * fleet decomposition, eval harness hooks, cost budgets, etc.
 */
export interface LoopPhaseSpec {
  /** One of the canonical 5, or a custom named phase. */
  name: string;
  /** What the agent must do in this phase. */
  instructions: string;
  /** Optional verification criteria for this phase (used in verification step). */
  verification?: string;
}

export interface LoopSpec {
  /** Stable name for the loop (e.g. "ralph", "marketing-landing", "review-23"). */
  name: string;
  /** The overall goal the loop is trying to achieve. */
  goal: string;
  /** Max iterations before the loop must stop or hand back (the "length"). */
  maxIterations: number;
  /** Whether this is a tight, human-bounded closed loop (recommended for normal budgets). */
  closed: boolean;
  /** Ordered phases the agent must cycle through each iteration. */
  phases: LoopPhaseSpec[];
  /** Global verification standard applied at the end of each iteration. */
  verificationCriteria: string;
  /** Optional extra rules / human taste notes / governance. */
  rules?: string;
  /** Hint that the orchestrator should decompose to subagents / fleet. */
  useFleet?: boolean;
  /** Freeform notes for the human (not injected into prompts unless rules). */
  notes?: string;
}

export interface LoopIterationRecord {
  iteration: number;
  startedAt: string;
  status: "in-progress" | "passed" | "failed" | "complete";
  summary?: string;
  verificationNotes?: string;
  /** Total tokens consumed during this iteration (folded in from pendingTokens on record). */
  tokensUsed?: number;
}

export interface LoopState {
  spec: LoopSpec;
  currentIteration: number;
  status: "idle" | "running" | "complete" | "blocked" | "stopped";
  history: LoopIterationRecord[];
  lastMessage?: string;
  /** Tokens accumulated in the current iteration, not yet folded into history. */
  pendingTokens?: number;
}

// ── Status indicators (footer chips) ──────────────────────────────────────────

/**
 * Where a status indicator should mount in the host chrome.
 *
 *   - `"input-footer"` (default): the line directly under the prompt input,
 *     next to the model name and context meter. Used for live state during
 *     background work — voice recording, fetch progress, etc.
 *   - `"mode-line"`: the right-hand side of the bottom-most footer line —
 *     sits immediately to the left of the prompt mode label
 *     (`agent` / `plan` / `ask`). Use for compact persistent counters and
 *     badges that mirror the mode label's "always-visible-while-typing"
 *     semantics (e.g. context-window usage bar).
 *   - `"mode-line-left"`: the left-hand side of the same bottom-most footer
 *     line. Used for chips that sit where the keyboard hint text lives
 *     (cwd / sandbox / counts).
 */
export type StatusIndicatorPlacement = "input-footer" | "mode-line" | "mode-line-left";

/**
 * Small, live-updating chip rendered in the prompt chrome. The host calls
 * `render()` on each app render — return `null` to opt out. Use this for
 * state that should always be visible while an extension is doing
 * background work (e.g. voice recording, fetch progress, indexing status)
 * or compact counters that travel with the mode label.
 *
 * Indicators are rendered in registration order, left-to-right, within
 * their `placement` slot. Keep them narrow (one or two glyphs + short
 * label) — there's limited horizontal space.
 */
/**
 * Shorthand specification for `api.registerToggleableIndicator` — the
 * common "N boolean toggles + one status indicator + one slash command
 * that flips them all together" shape used by footer chips like the
 * context-bar usage meter and the resource-counter chip. See the helper
 * for semantics.
 */
export interface ToggleableIndicatorSpec {
  /** Unique indicator id. */
  id: string;
  /** Where the chip mounts. Defaults to `"input-footer"`. */
  placement?: StatusIndicatorPlacement;
  /** Slash command that toggles the whole group together. */
  command: {
    name: string;
    description: string;
    /** Optional override; defaults to `<label> shown / <label> hidden`. */
    toastShown?: string;
    toastHidden?: string;
  };
  /**
   * The boolean settings that this chip's visibility decomposes into.
   * Registered as individual settings; the slash command flips them
   * together by ORing the current values and setting the inverse.
   */
  settings: Array<{
    key: string;
    title: string;
    description?: string;
    default?: boolean;
    section?: string;
  }>;
  /** Renders the indicator. Same shape as `RegisteredStatusIndicator.render`. */
  render: RegisteredStatusIndicator["render"];
  /**
   * Short noun used in the toast text (e.g. "Context bar" → "Context bar
   * shown."). Omit to use the command name.
   */
  toastLabel?: string;
}

export interface RegisteredStatusIndicator {
  pluginId: string;
  /** Unique id used for de-dup + ordering within the owning extension. */
  id: string;
  /** Render function. Re-runs on every host render — keep it cheap. */
  render: (ctx: { services: PluginHostServices }) => ReactNode | null;
  /** Where to mount. Default `"input-footer"`. */
  placement?: StatusIndicatorPlacement;
}

export { EXTENSIONS_V1_API_VERSION } from "./manifest";
export type { AgentMode };

// ── Toasts ────────────────────────────────────────────────────────────────────

export interface HostToast {
  title: string;
  message?: string;
  style?: "success" | "failure" | "info";
  timeoutMs?: number;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** Raw argument string entered after the command name. */
  args: string;
  /** Host services, as the loader assembles them. */
  services: PluginHostServices;
}

/**
 * Shorthand specification consumed by `api.registerPromptCommand`. The
 * resulting `RegisteredCommand` builds the prompt at dispatch time and hands
 * it to `services.chat.dispatch`, collapsing the 7-line "dispatch a canned
 * prompt" shim that workflow-prompts / knowledge / skills-listing each used
 * to hand-roll.
 *
 * `prompt` accepts a string or a `CommandContext`-aware builder (so commands
 * like `/verify` can read `services.workspace.cwd()` at dispatch time).
 * `displayText` is forwarded to `chat.dispatch` so the transcript can show
 * an abbreviated header instead of the full prompt body.
 */
export interface PromptCommandSpec {
  name: string;
  description: string;
  argsHint?: string;
  aliases?: string[];
  hidden?: boolean;
  prompt: string | ((ctx: CommandContext) => string);
  displayText?: string | ((ctx: CommandContext) => string);
}

/**
 * Shorthand spec consumed by `api.registerListingCommand`. For read-only
 * "listing" commands that compute a string and write it straight to the
 * transcript via `services.chat.appendAssistant` (no model round-trip) —
 * collapsing the `appendAssistant(format(...))` shim used by `/skills`.
 *
 * `render` returns the text to append; it may perform a side effect (e.g.
 * mining overlays) before returning its summary line.
 */
export interface ListingCommandSpec {
  name: string;
  description: string;
  argsHint?: string;
  aliases?: string[];
  hidden?: boolean;
  render: (ctx: CommandContext) => string;
}

export interface RegisteredCommand {
  pluginId: string;
  name: string;
  description: string;
  /** Optional short arg hint, e.g. "<model>" */
  argsHint?: string;
  /**
   * Alternate names that resolve to the same command. Used by the input
   * resolver (so `/q` routes to `/quit`) but NOT shown as separate rows in
   * the slash menu or command palette.
   */
  aliases?: string[];
  /**
   * When true, the command is callable via typed input but suppressed from
   * the slash menu / command palette. Use for low-level diagnostic commands
   * or aliases that share a single canonical menu row.
   */
  hidden?: boolean;
  handler: (ctx: CommandContext) => void | Promise<void>;
  /**
   * Optional visibility predicate. When provided and it returns `false`, the
   * command is hidden from the slash menu / command palette for the current
   * host state (e.g. adapter-specific commands when their adapter isn't the
   * active model). Omitted / `true` ⇒ always shown. Evaluated at menu-render
   * time; it does NOT gate typed-input dispatch.
   */
  visible?: (services: PluginHostServices) => boolean;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * A tool contribution. Extensions can register tools in two modes:
 *   1. **Metadata only** (`tool` omitted) — registers the tool name for
 *      toggling in `/extensions`; execution is still owned by the Agent's
 *      existing `createTools()` output. Used by the builtin tool groups.
 *   2. **Full ownership** (`tool` provided) — the kernel owns execution; the
 *      tool is included in `services.tools.toolSet()`. Used by user
 *      extensions that contribute genuinely new tools.
 */
export interface RegisteredTool {
  pluginId: string;
  /** Canonical tool name used in the ai-sdk ToolSet. Must be unique. */
  name: string;
  /** Short human-readable label for UI lists. */
  label?: string;
  description: string;
  /**
   * Optional set of agent modes in which this tool is available. When set and
   * non-empty, the kernel filters this tool out of the active ToolSet whenever
   * the current agent mode (set via `setKernelMode`) is not in this list.
   * Omitting `modes` (or leaving the kernel mode unset) preserves the previous
   * "always available" behavior.
   *
   * Example: `modes: ["agent"]` hides write_file/edit_file in plan/ask modes.
   */
  modes?: AgentMode[];
  /** The ai-sdk tool definition (inputSchema + execute). Optional. */
  tool?: AiTool;
  /** Optional grouping for display (e.g. "bash", "file", "media"). */
  group?: string;
}

/**
 * Dynamic command resolver. Where {@link RegisteredCommand} fixes the
 * command name + handler at registration time, a resolver runs at dispatch
 * time and can synthesize a {@link RegisteredCommand} on the fly. Used for
 * dynamic command sets whose names aren't known up front (e.g. user-defined
 * subagents whose names can include spaces). Resolvers run AFTER static
 * lookup fails; the kernel returns the first non-null result.
 */
export interface RegisteredCommandResolver {
  pluginId: string;
  /** Optional human-readable label, e.g. for `/extensions` listings. */
  label?: string;
  /**
   * Given the full slash-command input (with leading `/`), return the
   * matched command and the args portion, or `null` if not matched. The
   * `args` value is forwarded to the synthesized handler via
   * `CommandContext.args`.
   */
  resolve: (input: string, services: PluginHostServices) => { command: RegisteredCommand; args: string } | null;
  /**
   * Optional enumerator. Returns the dynamic commands this resolver can
   * currently produce so they appear in the `/` menu and Ctrl+K palette
   * (e.g. `.claude/commands` markdown files, custom subagents). Resolvers
   * whose match space isn't enumerable may omit it. Called at menu-render
   * time — keep it cheap (it may run on menu open). Names colliding with a
   * static registered command are dropped by the host (static wins).
   */
  enumerate?: (services: PluginHostServices) => RegisteredCommand[];
}

// ── Screens ───────────────────────────────────────────────────────────────────

/**
 * Runtime context handed to a registered screen's `render` function.
 *
 * - `props` is the runtime payload supplied by the caller of
 *   `services.ui.action({ type: "open-screen", id, props })`. The shape is
 *   defined by the screen author; consumers cast as needed.
 * - `close` is a convenience that fires `{ type: "close-screen", id }` for the
 *   owning screen. Equivalent to calling
 *   `services.ui.action({ type: "close-screen", id })` directly.
 * - `services` is the same shared host service object available everywhere.
 */
export interface ScreenContext {
  props: unknown;
  close: () => void;
  services: PluginHostServices;
}

/**
 * A registered screen contribution. Screens are extension-owned UI views the
 * host can open by id via `services.ui.action({ type: "open-screen", id })`.
 *
 * The render function returns a React element; the host's screen-slot is
 * responsible for mounting it. Multiple screens may be open simultaneously —
 * the host renders them in registration order on top of each other.
 */
export interface RegisteredScreen {
  pluginId: string;
  /** Unique screen id used as the discriminator for `open-screen`. */
  id: string;
  /** Optional human-readable label for `/extensions` listings. */
  label?: string;
  /** Renders the screen for a given runtime context. */
  render: (ctx: ScreenContext) => ReactNode;
}

// ── Models / Providers ────────────────────────────────────────────────────────

export type ProviderTransport = "sdk" | "sse" | "http" | "stdio" | "custom";
export type ProviderConnectionMode = "stateless" | "persistent";
export type ProviderAdapterShape = "provider-family" | "single-model";
export type ProviderSessionStrategy = "per-turn" | "per-conversation" | "singleton";

/** Authentication mode advertised by an adapter. */
export type AuthMode = "api-key" | "oauth" | "agent-sdk" | "none";

export type CredentialUserAction = "paste-api-key" | "start-oauth" | "install-cli" | "reauth";

export interface CredentialStatus {
  /** true ⇒ adapter can be used right now. */
  ok: boolean;
  /** Human-readable hint for the UI (what's missing, why). */
  reason?: string;
  /** Which interactive flow the host should trigger to remediate. */
  needsUserAction?: CredentialUserAction;
}

export interface ProviderUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProviderTurnInput {
  conversationId: string;
  providerId: string;
  adapterId: string;
  modelId: string;
  prompt: string;
  /** Full message history normalized to ai-sdk ModelMessage shape. */
  messages: readonly unknown[];
  tools?: ToolSet;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export type ProviderStreamEvent =
  | { type: "status"; status: "connecting" | "ready" | "streaming" | "complete" | "error"; message?: string }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; id: string; toolName: string; args: unknown }
  | { type: "tool-result"; id: string; result: unknown; isError?: boolean }
  | { type: "usage"; usage: ProviderUsageSnapshot }
  | { type: "error"; message: string; data?: unknown }
  | { type: "done"; stopReason?: string }
  /**
   * Owning adapter (Claude Agent SDK, Codex CLI) is asking the host to gate a
   * tool call through its UI before the upstream subprocess actually runs it.
   * The host should surface its standard permission UI and call
   * `ProviderSession.respondToToolApproval(approvalId, approved)` when the
   * user responds. The adapter is responsible for pausing tool execution
   * until that response arrives.
   */
  | { type: "tool-approval-request"; approvalId: string; toolName: string; input: unknown }
  /**
   * Owning adapter wants the host to present a structured multiple-choice
   * questionnaire (e.g. the Claude Agent SDK's built-in `AskUserQuestion`
   * tool, which the host can't answer through the allow/deny permission
   * channel). The host renders its questionnaire surface; the user's
   * selections are delivered back as a follow-up user message on the next
   * turn — so unlike `tool-approval-request` there is no approvalId to
   * resolve. The adapter is responsible for terminating the current turn
   * (e.g. deny + interrupt) so the model stops and waits for that message.
   */
  | { type: "questionnaire-request"; title?: string; questions: unknown };

export interface ProviderStreamController {
  emit: (event: ProviderStreamEvent) => void;
}

export interface RegisteredModel {
  pluginId: string;
  /** Canonical model id (e.g. "grok-4-1-fast-reasoning", "claude-sonnet-4-5"). */
  id: string;
  /** Which provider adapter owns this model. */
  providerId: string;
  /** Specific adapter id within a provider (for cases like local vs cloud). */
  adapterId?: string;
  label: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
  capabilities?: {
    tools?: boolean;
    images?: boolean;
    reasoning?: boolean;
  };
  aliases?: string[];
}

export interface ProviderConnectionContext {
  conversationId: string;
  adapterId: string;
  providerId: string;
  modelId?: string;
  settings: PluginHostServices["settings"];
  /**
   * Full host services handle. Always present when `connect()` is invoked
   * (model-runtime supplies it). May be omitted by `check()` / `startAuth()`
   * callers that only need `settings`. Provider adapters that need services
   * (e.g. to read MCP enablement) should access it via this field instead of
   * reaching around the SDK via `import { getHostServices } from "../loader"`.
   */
  services?: PluginHostServices;
  /**
   * The agent's working directory, mirroring the plugin-api contract. It can
   * differ from `process.cwd()` after the shell changes directory.
   */
  workspace?: PluginHostServices["workspace"];
}

/**
 * A provider session is the runtime handle the Agent loop uses to talk to an
 * upstream model. Each session MUST implement exactly one of:
 *
 *   - `getModel(modelId)` — simple adapters (API key, OAuth key) that can
 *     return an ai-sdk LanguageModel. The Agent drives the turn loop and
 *     passes the model to `streamText`.
 *
 *   - `sendTurn(input, controller)` — owning adapters (Claude Agent SDK,
 *     Codex CLI) that hold a persistent connection and stream their own
 *     deltas. The Agent hands user messages in and receives normalized
 *     `ProviderStreamEvent`s back.
 *
 * The Agent picks `getModel` first and falls back to `sendTurn`.
 */
export interface ProviderSession {
  readonly adapterId: string;
  readonly providerId: string;
  readonly mode: ProviderConnectionMode;
  readonly strategy?: ProviderSessionStrategy;

  /** Fast path — used by xAI, Anthropic API-key, OpenAI API-key. */
  getModel?: (modelId: string) => LanguageModel;

  /**
   * xAI-only: returns the responses-API LanguageModel for `modelId`,
   * regardless of the model's `responsesOnly` metadata. Used by the vision
   * sub-agent and the search_web/search_x tools (which always need the
   * responses endpoint to attach provider tools).
   */
  getResponsesModel?: (modelId: string) => LanguageModel;

  /**
   * Escape hatch for adapter-specific consumers that need the raw upstream
   * provider object (xAI's image/video/tools surface). Type is `unknown` —
   * callers must narrow inside their own module. Only xAI implements this.
   */
  getRawProvider?: () => unknown;

  /** Owning path — used by Claude Agent SDK, Codex CLI. */
  sendTurn?: (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ) => Promise<{ usage?: ProviderUsageSnapshot }>;

  /** Cancel an in-flight `sendTurn`. No-op for `getModel`-style sessions. */
  abortTurn?: () => void | Promise<void>;

  /**
   * Pre-establish whatever this session defers until its first turn.
   *
   * Owning adapters (Claude Agent SDK, Codex app-server, amp) deliberately do
   * not spawn their subprocess in `connect()` — selecting a model in `/models`
   * should not launch a process the user may never talk to. The cost is that
   * the spawn lands INSIDE the user's first message instead: measured at ~1.8s
   * for the Claude SDK and ~3.0s for `codex app-server`, which reads as "the
   * provider is slow" when it is really "the provider started late".
   *
   * `warm()` resolves that: the host calls it when the user commits to a model,
   * so the boot overlaps with them typing. Must be idempotent, must never
   * throw (report failures on the next `sendTurn`, which has a controller to
   * render them), and must be cheap when already warm. Optional — one-shot and
   * direct-API adapters have nothing to warm.
   */
  warm?: () => void | Promise<void>;

  /**
   * Resolve a host-side approval for a `tool-approval-request` previously
   * emitted by this session. Only implemented by owning adapters whose
   * upstream tool runner pauses on `canUseTool` (Claude Agent SDK). The Agent
   * forwards user responses here so the SDK subprocess can resume.
   */
  respondToToolApproval?: (approvalId: string, approved: boolean) => void;

  /** Close any persistent resources. Called on extension disable + shutdown. */
  disconnect?: () => void | Promise<void>;
}

export interface ModelProviderAdapter {
  connect: (ctx: ProviderConnectionContext) => ProviderSession | Promise<ProviderSession>;
}

export interface ModelProviderAuth {
  mode: AuthMode;
  /**
   * Runtime credential check. Return `{ ok: true }` when the adapter can
   * make real calls; otherwise populate `needsUserAction` so the host can
   * open the right remediation flow.
   */
  check: (ctx: ProviderConnectionContext) => CredentialStatus | Promise<CredentialStatus>;
  /** Optional interactive auth trigger (OAuth flow, CLI install prompt, etc.). */
  startAuth?: (ctx: ProviderConnectionContext) => void | Promise<void>;
}

export interface RegisteredModelProvider {
  pluginId: string;
  /** Adapter id — unique across the host (e.g. "xai.default"). */
  id: string;
  label: string;
  description?: string;
  /** Logical provider id — e.g. "xai", "anthropic", "openai". */
  providerId: string;
  shape: ProviderAdapterShape;
  transport: ProviderTransport;
  connectionMode: ProviderConnectionMode;
  /** Session lifetime hint — "singleton" for persistent subprocess adapters. */
  sessionStrategy?: ProviderSessionStrategy;
  capabilities: {
    streaming: boolean;
    tools?: boolean;
    images?: boolean;
    reasoning?: boolean;
  };
  adapter: ModelProviderAdapter;
  /** Auth metadata: mode + runtime credential check + optional auth trigger. */
  auth: ModelProviderAuth;
  /** Inline models (for single-model adapters or small catalogs). */
  model?: Omit<RegisteredModel, "pluginId">;
  models?: Array<Omit<RegisteredModel, "pluginId">>;
  /** Dynamic model listing (for adapters that fetch from the upstream API). */
  listModels?: (
    ctx: ProviderConnectionContext,
  ) => Array<Omit<RegisteredModel, "pluginId">> | Promise<Array<Omit<RegisteredModel, "pluginId">>>;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export interface RegisteredSetting {
  pluginId: string;
  key: string;
  title: string;
  description?: string;
  /**
   * Value kind. `"secret"` marks credential-like values (API keys, tokens):
   * the host coerces their `default` to `""` at registration (an extension
   * MUST NOT ship a baked-in secret default — see `loader.ts registerSetting`)
   * and any settings-value editor should mask the stored value on display.
   */
  type: "string" | "boolean" | "number" | "select" | "secret";
  default: string | number | boolean;
  section?: string;
  options?: Array<{ value: string; label: string }>;
  requiresRestart?: boolean;
}

// ── Host UI Actions ───────────────────────────────────────────────────────────

/**
 * Discriminated-union payload for `services.ui.action`. Used by builtin
 * command extensions (e.g. `host-actions.ts`) to ask the host to open a
 * modal or trigger a host-side effect. The host owns the implementation;
 * the extension just fires the action and forgets.
 *
 * Adding a new modal/action: add a variant here, register the command in
 * `host-actions.ts`, handle it in `handleUiAction` in `app.tsx`.
 */
export type HostAction =
  // Modal opens (no args)
  | { type: "model" }
  | { type: "api-key" }
  | { type: "sandbox" }
  | { type: "wallet" }
  | { type: "remote-control" }
  | { type: "telegram"; openTokenModal?: boolean }
  | { type: "agents" }
  | { type: "schedule" }
  | { type: "extensions" }
  | { type: "sessions" }
  | { type: "theme" }
  | { type: "flags" }
  | { type: "showcase" }
  | { type: "terms" }
  | { type: "term"; command: string }
  | { type: "term-modal"; command?: string }
  | { type: "btw"; question: string }
  // Modal opens (with args)
  | { type: "mcp"; openEditor?: McpEditorDraft; editingId?: string | null }
  | { type: "claude-agent"; focusGroup?: ClaudeAgentGroup }
  // Extension-owned screens (see RegisteredScreen)
  | { type: "open-screen"; id: string; props?: unknown }
  | { type: "close-screen"; id: string }
  // Simple host actions (no modal)
  | { type: "clear" }
  | { type: "quit" }
  | { type: "set-ui-mode"; mode: UiMode }
  | { type: "update" }
  | { type: "toggle-ui-mode" };

// ── Host Services ─────────────────────────────────────────────────────────────

export interface PluginListEntry {
  id: string;
  title: string;
  description?: string;
  group?: HostGroupMetadata;
  source: "builtin" | "user";
  enabled: boolean;
  active: boolean;
  status?: PluginLifecycleStatus;
  protected: boolean;
  hidden: boolean;
  commands: number;
  tools: number;
  models: number;
  error?: string;
}

export type PluginLifecycleStatus = "inactive" | "activating" | "active" | "failed";

export interface ChatDispatchOptions {
  displayText?: string;
}

export interface PluginHostServices {
  toast: {
    show: (toast: HostToast) => void;
  };
  commands: {
    list: () => RegisteredCommand[];
    resolve: (name: string) => RegisteredCommand | null;
    /**
     * Resolve a full slash-command input (e.g. `"/foo bar baz"`). Tries
     * exact static lookup on the first whitespace-delimited token first,
     * then walks the registered command-resolver chain. Returns the matched
     * command with its parsed args portion, or `null` if nothing matched.
     */
    resolveInput: (input: string) => { command: RegisteredCommand; args: string } | null;
    /**
     * Enumerate dynamic commands contributed by resolver `enumerate()` hooks
     * (markdown `.claude/commands` files, custom subagents, …). Names already
     * owned by a static registered command are dropped. Used to populate the
     * `/` menu and command palette so dynamic commands are discoverable, not
     * just dispatchable.
     */
    listDynamic: () => RegisteredCommand[];
  };
  mentions: {
    match: (query: string, maxResults?: number) => Promise<string[]>;
    resolvePath: (relativePath: string) => string;
    expand: (text: string, cwd: string) => Promise<{ enhancedMessage: string; mentionedFiles: string[] }>;
  };
  /**
   * PTC code runtime. Present on the engine host; lets tools/extensions run a
   * model-written program against native tool bindings (see tool-presentation).
   * Lazy: the worker runtime starts on first `run`.
   */
  codeRuntime?: import("../code-runtime").CodeRuntimeFacade;
  tools: {
    list: () => RegisteredTool[];
    listEnabled: () => RegisteredTool[];
    /** Flat ToolSet for passing to `streamText`/`generateText`. */
    toolSet: () => ToolSet;
    setEnabled: (toolName: string, enabled: boolean) => void;
    isEnabled: (toolName: string) => boolean;
    /**
     * Run `fn`, returning its `ToolResult` on success. If `fn` throws, returns
     * a failure `ToolResult` shaped `{success:false, output:"Failed to <label>: <msg>"}`.
     * Collapses the try/catch-to-ToolResult shape duplicated across schedule /
     * payments / xai / telegram tools.
     *
     * Use inside a tool's `execute`:
     *
     * ```ts
     * execute: (input) =>
     *   services.tools.safeExecute({
     *     label: "create schedule",
     *     fn: async () => {
     *       const result = await services.schedule.create(input);
     *       return { success: true, output: formatScheduleResult(result) };
     *     },
     *   });
     * ```
     */
    safeExecute: <T extends ToolResult>(opts: { label: string; fn: () => Promise<T> }) => Promise<T | ToolResult>;
  };
  models: {
    list: () => RegisteredModel[];
    get: (id: string) => RegisteredModel | undefined;
    listProviders: () => RegisteredModelProvider[];
    getProvider: (id: string) => RegisteredModelProvider | undefined;
    /**
     * Adapter id of the currently active model (e.g. "anthropic.agent-sdk"),
     * or `null` when no host has bound it yet. Lets commands/tools gate on the
     * live model adapter (see `RegisteredCommand.visible`). Wired via
     * `setActiveModelAdapterIdProvider` from app.tsx.
     */
    getActiveAdapterId: () => string | null;
  };
  settings: {
    get: <T = unknown>(key: string, fallback?: T) => T | undefined;
    set: <T = unknown>(key: string, value: T) => void;
    list: () => RegisteredSetting[];
    subscribe: (key: string, listener: (value: unknown, previous: unknown) => void) => () => void;
  };
  extensions: {
    list: () => PluginListEntry[];
    enable: (id: string) => Promise<void>;
    disable: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
  };
  /**
   * Inject a prompt into the active chat / agent loop, or write a message
   * directly into the transcript. Used by command extensions (e.g. workflow
   * prompts, listings) to drive the chat surface. Sinks are no-ops until the
   * UI binds them.
   *
   * - `dispatch(prompt)` sends a user-style prompt to the agent (it goes
   *   through the model and produces a real response).
   * - `appendAssistant(content)` writes an assistant-style message straight
   *   into the message list without invoking the model — used for read-only
   *   listings like `/skills`.
   */
  chat: {
    dispatch: (prompt: string, options?: ChatDispatchOptions) => Promise<void>;
    appendAssistant: (content: string) => void;
  };
  /**
   * Workspace-level facts that extensions need at command-invocation time.
   * `cwd()` reflects the agent's current working directory (which may have
   * drifted from `process.cwd()` after `cd` calls inside the bash tool).
   */
  workspace: {
    cwd: () => string;
  };
  /**
   * Active-session facts that extensions need at execute time. `id()` returns
   * the agent's current session id, or `null` when no host has bound it yet
   * (e.g. headless boot before the first turn). Lazy-getter shape mirrors
   * `workspace.cwd()`. Wired via `setSessionIdProvider` from the loader.
   */
  session: {
    id: () => string | null;
    /**
     * Force the active model session to reconnect on the next turn. Disposes
     * the kernel-cached provider session for the running conversation; the
     * owning adapter reconnects lazily on the next turn with fresh state —
     * for adapters that build their system prompt from Agent Skills
     * (e.g. the isolated Claude SDK adapter), this re-scans `~/.agents/skills`
     * and project `.agents/skills` so newly installed/removed skills take
     * effect without restarting the whole app. Adapters with an internal
     * transcript (Claude Agent SDK, Codex) synthesize the same resume-history
     * preface `/sessions` resume already relies on, so conversational
     * continuity is preserved (tool-call fidelity is not). `reconnected: false`
     * means there was nothing bound/cached — the next turn just connects
     * fresh anyway, so it's a safe no-op to call speculatively.
     */
    reconnect: () => Promise<{ reconnected: boolean; message: string }>;
  };
  /**
   * Context window usage. `getStats()` returns the token usage of the active
   * session against the active model's context window, or `null` when no
   * host has bound it yet (headless boot, model still resolving). The shape
   * mirrors `Agent.getContextStats()`. Wired via `setContextStatsProvider`
   * from the loader; `app.tsx` rebinds it whenever the resolved model or
   * in-flight stream content changes.
   *
   * Used by status-indicator extensions (`builtin.context-bar`) to render a
   * live "47k / 200k (24%)" meter on the prompt footer.
   *
   * `getBreakdown()` returns a richer per-component estimate (system / summary
   * / history / in-flight). Same nullability and rebinding semantics.
   * `compact()` requests an immediate manual compaction (replaces history with
   * a structured checkpoint summary + recent tail). Returns whether work was
   * done. Only available when a full agent session is active.
   */
  context: {
    getStats: () => ContextStats | null;
    getBreakdown: () => ContextBreakdown | null;
    compact: () => Promise<{ compacted: boolean; message: string }>;
  };
  /**
   * Named, spec-driven agent loops (single-agent or fleet).
   *
   * Implements the "agent looping" pattern: the agent (or an orchestrator + specialists)
   * repeatedly runs discovery → planning → execution → verification → iteration
   * until the explicit goal + verificationCriteria are satisfied, or the iteration
   * budget ("length") is exhausted.
   *
   * Designed for *closed* loops by default (human owns the spec + gates first).
   * Open/exploratory loops are possible by widening the spec, but burn more tokens.
   *
   * The command `/loop <name> [N]` creates or resumes a named loop with the given
   * max iterations and immediately injects a rich control block so the agent knows
   * it is inside a governed loop. The command drives continuation: each settled
   * turn advances the loop and dispatches the next iteration until the loop
   * completes, stalls, or the user interrupts (UserInterrupt event).
   *
   * State is durable: the kernel manager persists to loops.json in the
   * config dir and rehydrates at bootstrap (running loops come back as
   * stopped with history intact). Per-iteration cost tracking is future work.
   */
  loops: {
    /** List known loop names (specs only, not full running state). */
    list: () => LoopSpec[];
    /** Get full runtime state for a named loop, or null. */
    get: (name: string) => LoopState | null;
    /**
     * Create or resume a named loop. If N given, overrides maxIterations for
     * this run. Resuming a stopped loop keeps its iteration counter and
     * history; only a completed loop restarts from scratch.
     */
    start: (
      name: string,
      maxIterations?: number,
      goal?: string,
    ) => { started: boolean; message: string; state: LoopState };
    /** Stop the named loop (or the current active one). */
    stop: (name?: string) => { stopped: boolean; message: string };
    /**
     * Advance a RUNNING loop one iteration. Marks the loop complete when the
     * iteration budget is reached. No-ops (advanced: false) for unknown or
     * non-running loops.
     */
    advance: (name: string) => Promise<{ advanced: boolean; message: string; state?: LoopState }>;
    /**
     * Record the outcome of the current iteration into the loop's history.
     * A "complete" status also marks the whole loop complete.
     */
    record: (
      name: string,
      entry: { status: LoopIterationRecord["status"]; summary?: string; verificationNotes?: string },
    ) => { ok: boolean; message: string; state?: LoopState };
    /** Replace or create a full spec for a loop (the "human designs the standard" step). */
    setSpec: (spec: LoopSpec) => { ok: boolean; message: string };
    /** Return the currently "active" loop if one is running, else null. */
    getActive: () => LoopState | null;
    /**
     * Accumulate token usage for the current iteration of the running loop.
     * Called from agent.ts `recordUsage` on every turn; no-op when no loop
     * is running. Tokens are folded into `LoopIterationRecord.tokensUsed`
     * when `record()` is called.
     */
    noteUsage: (totalTokens: number) => void;
  };
  /**
   * Telegram bridge sink. Bound per-turn by `src/telegram/bridge.ts` while a
   * Telegram-driven agent run is in flight; cleared in the bridge's `finally`
   * so the sink is unbound between turns. The kernel-owned `telegram_send_file`
   * tool (`builtin.tools.telegram`) calls `services.telegram.sendFile(path)`
   * at execute time. When the sink is unbound, the tool returns a friendly
   * "telegram bridge not active" error matching the lsp-disabled pattern.
   */
  telegram: {
    sendFile: (filePath: string, abortSignal?: AbortSignal) => Promise<ToolResult>;
  };
  /**
   * Subagents / delegations sink. Bound by `src/agent/agent.ts` at Agent
   * construction via `setSubagentsSink({...})` so the kernel-owned subagent
   * tools (`task`, `delegate`, `delegation_read`, `delegation_list` from
   * `builtin.tools.subagents`) can call back into the Agent's private
   * `runTask` / `runDelegation` / `readDelegation` / `listDelegations`
   * methods at execute time. When the sink is unbound (e.g. headless boot
   * before an Agent is constructed, or after `shutdownPlugins()`), each
   * call returns a friendly "subagents bridge not active" error matching the
   * lsp-disabled pattern.
   */
  subagents: {
    runTask: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
    runDelegation: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
    readDelegation: (id: string) => Promise<ToolResult>;
    listDelegations: () => Promise<ToolResult>;
  };
  /**
   * Schedule manager bridge. Bound by `src/agent/agent.ts` at Agent
   * construction via `setScheduleSink({...})` so the kernel-owned schedule
   * tools (`schedule_create`, `schedule_list`, `schedule_remove`,
   * `schedule_read_log`, `schedule_daemon_status`, `schedule_daemon_start`,
   * `schedule_daemon_stop` from `builtin.tools.schedule`) can call back into
   * the Agent's `ScheduleManager` instance at execute time. Each method
   * proxies straight through to the bound sink and throws when the sink is
   * unbound (e.g. headless boot before an Agent is constructed, or after
   * `shutdownPlugins()`); the kernel-owned tools' existing try/catch
   * wraps the throw into a friendly failure ToolResult.
   *
   * Method signatures mirror the public surface of the `ScheduleManager`
   * class so the Agent can pass `this.schedules` directly.
   */
  schedule: {
    create: (options: ScheduleCreateOptions) => Promise<ScheduleCreateResult>;
    list: () => Promise<StoredSchedule[]>;
    remove: (id: string) => Promise<StoredSchedule | null>;
    readLog: (id: string, tail?: number) => Promise<string>;
    getDaemonStatus: () => Promise<ScheduleDaemonStatus>;
    startDaemon: () => Promise<ScheduleDaemonStartResult>;
    stopDaemon: () => Promise<ScheduleDaemonStopResult>;
  };
  /**
   * MCP tool bundle provider. Set by `builtin.mcp` on activate; cleared on
   * disable or shutdown. When absent, returns empty bundle so no MCP tools,
   * resources, prompts, or servers are loaded anywhere in the agent or UI.
   */
  mcp: {
    /**
     * True iff the `builtin.mcp` extension is currently active and has bound
     * the tool-bundle provider. Use this in providers/adapters that pass
     * MCP config through to upstream agents (e.g. Claude Code / Claude
     * Agent SDK) — when `false`, those adapters should inject empty MCP
     * config so the upstream agent doesn't pick up MCP servers from user
     * or project settings files.
     */
    isEnabled: () => boolean;
    getToolBundle: () => Promise<McpToolBundle>;
  };
  /**
   * Bash / shell sink. Owns the kernel's `BashTool` instance and the lifecycle
   * of the four bash tools (`bash`, `process_logs`, `process_stop`,
   * `process_list`). Bound once at activation time by the
   * `builtin.tools.bash` extension (see
   * `src/core/plugins/builtin/bash-tools.ts`); the Agent reads through
   * `services.bash.*` instead of holding its own `BashTool` instance.
   *
   * **Builtin-only surface.** Third-party extensions can read it today, but
   * a permission model gating shell access is planned for Phase 8+. New
   * builtins should consume it freely; non-builtin extensions should not
   * yet rely on this field.
   *
   * Methods:
   *   - `cwd()` returns the agent's current working directory (drifts after
   *     `cd` inside the bash tool). The same value also appears at
   *     `services.workspace.cwd()`.
   *   - `execute / startBackground / getProcessLogs / stopProcess /
   *     listProcesses` map 1:1 to `BashTool` so the kernel-owned tool defs
   *     can call straight through.
   *   - `spawnChild(initialCwd, options?)` constructs a fresh `BashTool` for
   *     subagent / verify runs (the Agent uses this at `agent.ts:1267`).
   *   - `cleanup` tears down background processes; called from the Agent's
   *     shutdown path.
   *   - `getSandboxMode / setSandboxMode / getSandboxSettings /
   *     setSandboxSettings` proxy the bash tool's sandbox config so the
   *     Agent can override defaults at construction time and update them on
   *     `/sandbox` mode changes.
   *
   * When the sink is unbound (e.g. headless boot before the bash extension
   * has activated, or after `shutdownPlugins()`) every accessor throws
   * `"Bash sink is not active. The builtin bash extension must be active."`
   * — callers either run inside an active extension (where the sink is
   * always bound) or wrap in try/catch.
   */
  bash: {
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
  };
  /**
   * Hooks bridge — fires PreToolUse / PostToolUse / PostToolUseFailure /
   * generic event hooks on behalf of kernel-owned tools and the Agent. Bound
   * by `src/agent/agent.ts` at Agent construction via `setHooksSink({...})`,
   * which closes over `executePreToolHooks` / `executePostToolHooks` /
   * `executePostToolFailureHooks` / `executeEventHooks` from `../hooks/index`.
   *
   * The cwd is intentionally NOT a parameter on these methods. Each bound sink
   * resolves `services.bash.cwd()` (or `services.workspace.cwd()`) lazily so
   * callers don't have to thread the agent's drift-tracked cwd through every
   * call site — this is a small API-shape improvement on top of the migration
   * out of `bash-tools.ts` (Phase 2 step 7c). The closure runs at call time so
   * `cd` drift inside the bash tool is still observed by the hook payload,
   * matching pre-7c behavior.
   *
   * **Builtin-only surface.** Third-party extensions can read it today, but a
   * permission model gating arbitrary hook firing is planned for Phase 8+.
   * New builtins should consume it freely; non-builtin extensions should not
   * yet rely on this field. Same posture as `services.bash`.
   *
   * Unbound semantics: when no Agent has constructed and bound the sink (e.g.
   * headless boot before the first turn, or after `shutdownPlugins()`),
   * every method resolves to a no-op `AggregatedHookResult` with
   * `blocked: false`. This matches the swallow-error semantics of
   * `executeEventHooks` itself — hooks are optional, the agent must run
   * without them.
   */
  hooks: {
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
    /**
     * Higher-order wrapper that converts a bare execute function into one with
     * the full PreToolUse / PostToolUse / PostToolUseFailure ceremony wired in:
     *
     *   1. `runPre(toolName, input)` first — if `blocked`, return
     *      `{success:false, output:"[Hook blocked] <reason>"}` early.
     *   2. Await `fn(input, ctx)` for the inner ToolResult.
     *   3. Fire `runPost` on `success:true`, `runFailure` on `success:false`
     *      (both fire-and-forget — hooks must never gate the return).
     *
     * Use to opt every write-side tool into the same hook flow `bash` has,
     * without re-implementing 20 lines of ceremony per tool:
     *
     * ```ts
     * api.registerTool({
     *   name: "write_file",
     *   tool: tool({
     *     inputSchema,
     *     execute: services.hooks.wrapExecute("write_file", async (input, ctx) => {
     *       // ...the original write_file body...
     *     }),
     *   }),
     * });
     * ```
     *
     * The wrapper resolves `services.session.id()` lazily on each call so
     * sessionId drift across turns is observed correctly.
     */
    wrapExecute: <I>(
      toolName: string,
      fn: (input: I, ctx: { abortSignal?: AbortSignal }) => Promise<ToolResult>,
    ) => (input: I, ctx?: { abortSignal?: AbortSignal }) => Promise<ToolResult>;
  };
  /**
   * In-process agent event bus. Subscribe to the same event stream the
   * shell-hook system in src/hooks consumes — PreToolUse, PostToolUse,
   * PostToolUseFailure, UserPromptSubmit, Stop, StopFailure,
   * SessionStart / SessionEnd, etc.
   *
   * Use cases: reactive UI surfaces (ambient pet animation switching on
   * agent state), in-process telemetry, builtin extensions that need to
   * observe the agent without spawning a subprocess.
   *
   * Contract:
   *   - `subscribe(event, handler)` returns a disposer. Always call the
   *     disposer on extension deactivation to avoid leaks across pet
   *     switches / extension reloads / hot module replacement.
   *   - Handlers run synchronously in registration order at emit time.
   *     Do NOT block on the calling thread; schedule work via
   *     `setTimeout(..., 0)` / `Promise.resolve().then(...)` if needed.
   *   - Handler exceptions are caught and discarded so a broken
   *     subscriber can't crash the agent or other subscribers.
   *   - Events fire for EVERY occurrence, regardless of whether any
   *     shell hook matched. Subscribing to `Stop` works even with no
   *     `Stop` shell hook configured.
   *
   * **Builtin-only surface.** Same posture as `services.hooks` — a
   * permission model gating arbitrary third-party subscription is
   * planned for a later phase.
   */
  events: {
    subscribe: <E extends HookEvent>(
      event: E,
      handler: (input: Extract<HookInput, { hook_event_name: E }>) => void,
    ) => () => void;
  };
  /**
   * Icon-pack sink. Set the active glyph resolver (or `null` to disable
   * icons) and read a glyph by semantic name. Singleton, last-bind-wins —
   * icon packs are a theme decision; the host can't usefully stack them.
   *
   * Replaces the loader-internal `setIconResolver` reach-around that
   * `builtin.icons.nerd-fonts` used to import directly. The resolver and
   * its subscribers still live in `./icons.ts`; this is just the public
   * façade.
   *
   * `setResolver` triggers a re-render of every component using `useIcon`,
   * which is why flipping a setting that swaps the resolver (e.g. the
   * nerd-icons on/off toggle) must call `setResolver` rather than mutate
   * a closed-over catalog in place.
   */
  icons: {
    setResolver: (resolver: ((name: string) => string | null) | null) => void;
    resolve: (name: string) => string;
  };
  /**
   * Host-owned UI side effects. Extensions fire an action; the host (app.tsx)
   * binds a sink that runs the matching `openXxxModal()` helper or simple
   * effect (`/clear`, `/quit`, `/ui <mode>`). Sink is no-op until the UI
   * binds it. See `host-actions.ts` for the canonical caller.
   */
  ui: {
    action: (payload: HostAction) => void;
    /**
     * Current terminal dimensions, or a sane fallback when stdout is not a
     * TTY (headless / piped runs). Centralises the `process.stdout.columns`
     * read that listing commands (`/skills`) used to do directly, so width-
     * aware formatting has one source of truth and a guaranteed fallback.
     */
    terminalSize: () => { columns: number; rows: number };
    /**
     * Registered screen contributions (data view of the screen registry).
     * Lets one extension resolve another's screen id without a sibling import
     * — e.g. opening the shared doc-viewer by looking up its id here.
     */
    screens: {
      list: () => Array<{ id: string; label?: string; pluginId: string }>;
    };
  };
  /**
   * Prompt-input read/write + key interception. Bound by `app.tsx` once the
   * textarea ref is mounted. Used by extensions that need to:
   *   - Insert text at the cursor (voice transcripts, snippet expansion)
   *   - Read the current value/cursor (mention pickers, completions)
   *   - Intercept keys before the textarea sees them (push-to-talk hold,
   *     custom keymaps, vim-mode plugins).
   *
   * **Intercept contract.** Each call to `intercept(handler)` registers a
   * handler that runs BEFORE the textarea receives a key. Return `true` to
   * swallow the key entirely; return `false` to let it propagate normally.
   * Handlers are invoked in registration order; the first to return `true`
   * wins and short-circuits the chain. Returns a disposer.
   *
   * When the sink is unbound (e.g. headless boot before the UI mounts), all
   * methods no-op: `getValue()`/`getCursor()` return `""`/`0`,
   * `setValueWithCursor`/`insertText`/`clear` silently do nothing,
   * `isFocused()` returns `false`, `intercept()` returns a no-op disposer.
   */
  input: {
    getValue: () => string;
    getCursor: () => number;
    setValueWithCursor: (value: string, cursor: number) => void;
    insertText: (text: string) => void;
    clear: () => void;
    isFocused: () => boolean;
    intercept: (handler: InputInterceptor) => () => void;
    /**
     * React hook: receive keyboard input from within a screen/overlay
     * component. Wraps the renderer's keyboard hook so screen extensions don't
     * import `@opentui/react` directly. The raw host input pipeline runs input
     * interceptors before a key reaches this hook. Call unconditionally during
     * render.
     */
    useKeyboard: (handler: (key: InputKey) => void) => void;
  };
}

export interface HostMentionProvider {
  match: (query: string, maxResults?: number) => Promise<string[]>;
  resolvePath: (relativePath: string) => string;
  expand: (text: string, cwd: string) => Promise<{ enhancedMessage: string; mentionedFiles: string[] }>;
}

// ── Extension Module Shape ────────────────────────────────────────────────────

/**
 * Optional kernel-sink bindings an extension can provide on activation. Each
 * field corresponds to a host-internal singleton that extensions used to bind
 * by reach-around imports from `../loader` / `../icons`. `bindKernelSink`
 * unifies them under one explicit API and auto-clears each sink on dispose.
 *
 * - `bash`: full `BashTool` surface bound by `builtin.tools.bash`. Mirrors
 *   `services.bash`.
 * - `mcp`: MCP tool-bundle provider bound by `builtin.mcp`.
 * - `icons`: glyph resolver bound by `builtin.icons.nerd-fonts`.
 *
 * **Builtin-only surface.** Same posture as `services.hooks` / `services.bash` —
 * a permission model gating third-party sink binding is planned for Phase 8+.
 */
export interface KernelSinkBindings {
  bash?: PluginHostServices["bash"];
  mcp?: () => Promise<McpToolBundle>;
  icons?: (name: string) => string | null;
}

// The V1 `PluginHostApi` was removed here. It described the object handed to
// `activate(api)`; every built-in is a Cordis plugin now and reaches the host
// through `@codesurf/plugin-api`, so nothing implemented or consumed it.

export interface PluginModule {
  manifest: HostManifest;
  /** Called once on enable. Takes nothing: the V1 host API it used to
   *  receive is gone, and a plugin reaches the host through its Cordis context. */
  activate: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}
