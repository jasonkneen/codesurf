import type { ModelMessage } from "ai";
import { getHostServices, setHooksSink, setScheduleSink, setSubagentsSink } from "../core/plugins";
import { normalizeModelId } from "../grok/models";
import {
  executeEventHooks,
  executePostToolFailureHooks,
  executePostToolHooks,
  executePreToolHooks,
} from "../hooks/index";
import { loadTranscriptState, SessionStore } from "../storage/index";
import { ScheduleManager } from "../tools/schedule";
import type { AgentMode, SessionInfo, SubagentStatus, WorkspaceInfo } from "../types/index";
import { getCurrentModelSelection, loadRecapsEnabled, normalizeModelAdapterId } from "../utils/settings";
import { MAX_TOOL_ROUNDS } from "./constants";
import { DelegationManager } from "./delegations";
import { SessionPromptContext } from "./prompt-context";
import { SessionDelegations } from "./session-delegations";
import { SessionToolsets } from "./session-toolsets";
import type { ToolPresentation } from "./tool-presentation";
import type { TraceCollector } from "./trace-collector";
import type { AgentOptions } from "./types";

// Turn-machine types re-exported for backward compat (see ./types.ts).
export type {
  ProcessMessageError,
  ProcessMessageFinishReason,
  ProcessMessageObserver,
  ProcessMessageStepFinish,
  ProcessMessageStepStart,
  ProcessMessageToolFinish,
  ProcessMessageToolStart,
  ProcessMessageUsage,
} from "./types";

import { AccessorsMixin, AgentMixinBase } from "./mixins/accessors";
import { BatchMixin } from "./mixins/batch";
import { ContextMixin } from "./mixins/context";
import { NotificationsMixin } from "./mixins/notifications";
import { RuntimeMixin } from "./mixins/runtime";
import { SessionAdminMixin } from "./mixins/session-admin";
import { SessionLifecycleMixin } from "./mixins/session-lifecycle";
import { SubagentMixin } from "./mixins/subagent";
import { TelemetryMixin } from "./mixins/telemetry";
import { TurnControlMixin } from "./mixins/turn-control";
import { TurnEngineMixin } from "./mixins/turn-engine";
export class Agent extends SessionAdminMixin(
  TurnControlMixin(
    RuntimeMixin(
      BatchMixin(
        TurnEngineMixin(
          SubagentMixin(
            TelemetryMixin(ContextMixin(NotificationsMixin(SessionLifecycleMixin(AccessorsMixin(AgentMixinBase))))),
          ),
        ),
      ),
    ),
  ),
) {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private apiKey: string | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read by AccessorsMixin/BatchMixin via a narrowed cast.
  private baseURL: string | null = null;
  private delegations: DelegationManager;
  private schedules: ScheduleManager;
  private sessionStore: SessionStore | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by SessionLifecycleMixin via a narrowed cast.
  private workspace: WorkspaceInfo | null = null;
  private session: SessionInfo | null = null;
  private messages: ModelMessage[] = [];
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private messageSeqs: Array<number | null> = [];
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private abortController: AbortController | null = null;
  /** Abort controller for a /context-compact run that happens outside a turn,
   *  so Esc (Agent.abort) can cancel the summarizer LLM call too. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private manualCompactController: AbortController | null = null;
  /** Learning-loop trace for the in-flight turn. Created internally at the top
   *  of processMessage (so every turn is captured regardless of caller) and
   *  finalized in emitTurnStop/emitTurnStopFailure. Null between turns. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written/called by a mixin via a narrowed cast.
  private activeTrace: TraceCollector | null = null;
  private maxToolRounds: number;
  private mode: AgentMode = "agent";
  private modelId: string;
  private modelAdapterId: string | undefined;
  private maxTokens: number;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written/called by a mixin via a narrowed cast.
  private planContext: string | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private subagentStatusListeners = new Set<(status: SubagentStatus | null) => void>();
  private batchApi = false;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written/called by a mixin via a narrowed cast.
  private sessionStartHookFired = false;
  /** Owning-adapter session (Claude Agent SDK, Codex CLI) active during a
   *  sendTurn-style turn. Tracked so `respondToToolApproval` can forward the
   *  user's click into the SDK subprocess via the session's optional
   *  `respondToToolApproval` method. Null between turns. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private currentProviderSession: import("../core/plugins/api").ProviderSession | null = null;

  /** Approval the model is still waiting on, if the last turn ended parked on
   *  one. Held here because the id only ever exists on the stream chunk — the
   *  transcript records the call, not the approval that would resolve it. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private pendingApprovalId: string | null = null;
  /** The anchor of the turn in flight — its user message, or the approval
   *  response a continuation resumes from — so a failed turn can be
   *  persisted with its note. Null between turns. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by TurnEngineMixin via a narrowed cast.
  private turnUserMessage: ModelMessage | null = null;
  /** Snapshot of the in-flight turn's uncommitted output, for exit-time persistence. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by TurnEngineMixin via a narrowed cast.
  private partialTurnSnapshot: (() => ModelMessage[]) | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by AccessorsMixin/TelemetryMixin via a narrowed cast.
  private recapsEnabled = true;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by ContextMixin via a narrowed cast.
  private estimateSystemPromptCache: { key: string; system: string; builtAt: number } | null = null;

  /** Cache-safe progressive skill disclosure for this conversation. Only ever
   *  grows; reset on session switch / compaction where the cache is discarded
   *  anyway. Provider-agnostic — every adapter that goes through
   *  `buildSystemPrompt` (all direct-API providers) benefits. */
  /** Session-stable system-prompt inputs. See `prompt-context.ts`. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written/called by a mixin via a narrowed cast.
  private readonly promptContext = new SessionPromptContext();

  /** Learning notes snapshotted ONCE per session.
   *
   *  `TraceCollector.finish()` rewrites the notes file at the end of every
   *  turn. Reading it per-turn made the system prompt differ between turn 1
   *  and turn 2, which is a total prompt-cache miss — the measured cause of
   *  "first message 3s, second message 14s". Refreshed notes intentionally
   *  apply to the NEXT session rather than mutating this one mid-flight. */

  /** Session-stable skill overlays. See `resolveSkillOverlays`. */

  /** Session-stable AGENTS.md/CLAUDE.md text. Sits in the stable prefix, so a
   *  mid-session edit would re-prefill the whole tail. Refreshed content applies
   *  to the NEXT session, matching learning notes. */

  /** Session-stable custom sub-agent roster, for the same reason. */

  /** Per-turn ToolSet composition and the session's MCP bundle. See
   *  ./session-toolsets.ts — the Agent's only tie into it is `runTask`, which a
   *  sub-agent's nested `task` tool re-enters. */
  /** Delegation lifecycle and its reporting. See ./session-delegations.ts.
   *  Built in the constructor: `delegations` is assigned there, and a field
   *  initialiser would read it before it exists. */
  private readonly sessionDelegations: SessionDelegations;

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private readonly toolsets = new SessionToolsets({
    runTask: (request, abortSignal, context) => this.runTask(request, abortSignal, context),
  });

  /** Sub-agent runs currently in flight on this Agent, for the fan-out cap.
   *  Reserved synchronously at admission and released in `finally`. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by SubagentMixin via a narrowed cast.
  private inFlightSubagents = 0;

  /** Which concurrent sub-agent run currently owns the status indicator. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private activeSubagentRunKey: string | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by SubagentMixin via a narrowed cast.
  private subagentRunSeq = 0;

  /** True while a turn owns `this.messages`. Background notifications arriving
   *  from the UI poll timer during this window are queued, not spliced in. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private isProcessingTurn = false;

  /** Notifications that arrived mid-turn, drained at the next turn boundary.
   *  Each entry is bound to the session it arrived for; entries for a session
   *  that is no longer current are dropped at drain time, never spliced into
   *  another conversation's transcript. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private readonly pendingBackgroundNotifications: Array<{ sessionId: string | null; message: string }> = [];

  /** Raw cache counters from the most recent main-turn usage event. Feeds
   *  `getLastCacheStatsLine()` so the UI can surface prefix-cache health without
   *  the caller having to plumb usage through itself. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written by a mixin via a narrowed cast.
  private lastTurnUsage: { cacheReadTokens?: number; cacheWriteTokens?: number; inputTokens?: number } | null = null;

  /** Cache/context stats for the most recent turn, for the UI stats line. */

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read/written/called by a mixin via a narrowed cast.
  private readonly presentationOption: ToolPresentation | undefined;

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number,
    options: AgentOptions = {},
  ) {
    super();
    this.presentationOption = options.presentation;
    this.baseURL = baseURL || null;
    if (apiKey) {
      this.setApiKey(apiKey, baseURL);
    }
    // Sandbox config is owned by the kernel-owned `builtin.tools.bash`
    // extension's BashTool. We override its defaults here, before any other
    // ctor code reads `services.bash.*` (DelegationManager / ScheduleManager
    // factories below capture lazy `cwd()` callbacks; SessionStore reads
    // `cwd()` immediately). Throws `Bash sink is not active` when the
    // extension hasn't been bootstrapped — that's the activation-order
    // regression test (R1) we want to be loud.
    const bashServices = getHostServices().bash;
    bashServices.setSandboxMode(options.sandboxMode ?? "off");
    if (options.sandboxSettings) bashServices.setSandboxSettings(options.sandboxSettings);

    this.delegations = new DelegationManager(() => getHostServices().bash.cwd());
    this.sessionDelegations = new SessionDelegations(this.delegations, {
      modelId: () => this.modelId,
      maxToolRounds: () => this.maxToolRounds,
      maxTokens: () => this.maxTokens,
      batchApi: () => this.batchApi,
      sessionId: () => this.session?.id,
      fireHook: (input, abortSignal) => this.fireHook(input, abortSignal),
    });

    const initialMode: AgentMode = "agent";
    const initialSelection = model
      ? { model: normalizeModelId(model), adapterId: normalizeModelAdapterId(options.modelAdapterId) }
      : getCurrentModelSelection(initialMode);
    this.modelId = initialSelection.model;
    this.modelAdapterId = initialSelection.adapterId;
    // Live sandbox state, not the process-global default: a schedule created
    // from this session must inherit the sandbox the session is actually in.
    this.schedules = new ScheduleManager(
      () => getHostServices().bash.cwd(),
      () => this.modelId,
      () => ({
        mode: getHostServices().bash.getSandboxMode(),
        settings: getHostServices().bash.getSandboxSettings(),
      }),
    );
    this.maxToolRounds = maxToolRounds || MAX_TOOL_ROUNDS;
    const envMax = Number(process.env.CODESURF_MAX_TOKENS ?? process.env.GROK_MAX_TOKENS);
    this.maxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 16_384;
    this.batchApi = options.batchApi ?? false;
    this.recapsEnabled = loadRecapsEnabled();

    if (options.persistSession !== false) {
      this.sessionStore = new SessionStore(getHostServices().bash.cwd());
      this.workspace = this.sessionStore.getWorkspace();
      this.session = this.sessionStore.openSession(
        options.session,
        this.modelId,
        this.mode,
        getHostServices().bash.cwd(),
      );
      this.mode = this.session.mode;
      const transcript = loadTranscriptState(this.session.id);
      this.messages = transcript.messages;
      this.messageSeqs = transcript.seqs;
      this.sessionStore.setModel(this.session.id, this.modelId);
    }

    // Bind the subagents bridge so the kernel-owned `task` / `delegate` /
    // `delegation_read` / `delegation_list` tools (in
    // `src/core/plugins/builtin/subagents-tools.ts`) can call back into
    // these private methods at execute time. Phase 2 #5 of the kernel-
    // extensibility plan moved these out of `createTools()`. The kernel sink
    // is process-global; multiple Agent instances in the same process overwrite
    // each other (last-construct wins) — matches the existing process-global
    // behavior of `setKernelMode` and the per-turn `setTelegramSink`.
    setSubagentsSink({
      runTask: (request, abortSignal) => this.runTask(request, abortSignal),
      runDelegation: (request, abortSignal) => this.sessionDelegations.runDelegation(request, abortSignal),
      readDelegation: (id) => this.sessionDelegations.readDelegation(id),
      listDelegations: () => this.sessionDelegations.listDelegations(),
    });

    // Bind the schedule manager bridge so the kernel-owned schedule tools (in
    // `src/core/plugins/builtin/schedule-tools.ts`) can call back into
    // `this.schedules` at execute time. Phase 2 #6 of the kernel-extensibility
    // plan moved these out of `createTools()`. The `ScheduleManager` instance
    // structurally satisfies `ScheduleSink` so we pass it directly. Sink is
    // process-global; multiple Agents in the same process overwrite each
    // other (last-construct wins) — same shape as `setSubagentsSink` above.
    setScheduleSink(this.schedules);

    // Bind the hooks bridge so the kernel-owned bash tool (in
    // `src/core/plugins/builtin/bash-tools.ts`) and `this.fireHook` go
    // through `services.hooks.*` instead of importing the hooks module
    // directly. Phase 2 step 7c of the kernel-extensibility plan keeps the
    // hooks module pure (no kernel coupling) by having the Agent — not the
    // hooks module — own the bind.
    //
    // Each closure resolves `getHostServices().bash.cwd()` at call time so
    // the cwd reflects drift from `cd` commands inside the bash tool, exactly
    // matching pre-7c behavior (where bash-tools.ts called
    // `api.services.workspace.cwd()` once per invocation). Routing all four
    // calls through this one binding also keeps the hook payloads' cwd
    // consistent across PreToolUse / PostToolUse / PostToolUseFailure /
    // generic event hooks.
    setHooksSink({
      runPre: (toolName, toolInput, sessionId, abortSignal) =>
        executePreToolHooks(toolName, toolInput, getHostServices().bash.cwd(), sessionId, abortSignal),
      runPost: (toolName, toolInput, toolOutput, sessionId, abortSignal) =>
        executePostToolHooks(toolName, toolInput, toolOutput, getHostServices().bash.cwd(), sessionId, abortSignal),
      runFailure: (toolName, toolInput, error, sessionId, abortSignal) =>
        executePostToolFailureHooks(toolName, toolInput, error, getHostServices().bash.cwd(), sessionId, abortSignal),
      runEvent: (input, abortSignal) => executeEventHooks(input, getHostServices().bash.cwd(), abortSignal),
    });
  }
}
