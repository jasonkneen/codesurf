# Engine-side progress signal audit — codesurf-cli

Repo: `/Users/jkneen/Documents/GitHub/grok-cli` (branch `phase3/hub`).
Scope: what progress / state / thinking information the ENGINE produces during a turn, and which of it never reaches the terminal UI.

---

## 1. Turn event and stream types the engine emits

There are three distinct layers, and they do not carry the same information.

### Layer A: `StreamChunk` — the only thing the UI ever sees

Defined at `src/types/index.ts:305-320`. Nine variants:

| type | payload fields | emitted at |
|---|---|---|
| `content` | `content` | `src/agent/turns/stream-turn.ts:129`, `src/agent/turns/session-turn.ts:164`, `src/agent/turns/batch-turn.ts:159` |
| `reasoning` | `content` | `stream-turn.ts:141`, `session-turn.ts:381` |
| `tool_calls` | `toolCalls[]` | `stream-turn.ts:153`, `session-turn.ts:403`, `batch-turn.ts:197` |
| `tool_result` | `toolCall`, `toolResult` | `stream-turn.ts:170`, `session-turn.ts:506`, `batch-turn.ts:212` |
| `tool_approval_request` | `toolCall`, `approvalId`, `editPrecheck`, `paymentPrecheck` | `stream-turn.ts:260`, `session-turn.ts:451` |
| `questionnaire` | `questionnaire` | `session-turn.ts:468` |
| `error` | `content`, `isAuthError` | `stream-turn.ts:343`, `session-turn.ts:557`, `batch-turn.ts:251` |
| `warning` | `content` | `stream-turn.ts:354` and `:366`, `session-turn.ts:611`, `batch-turn.ts:189` |
| `done` | none | many sites |

There is **no chunk type** for status, usage, timing, step lifecycle, subagent lifecycle, compaction, retry/backoff, provider fallback, or tool progress.

Other `content` chunks that are really status messages in disguise:
- MCP unavailable notice: `stream-turn.ts:81`, `batch-turn.ts:91`
- Adaptive-routing note (`↪ routed to X for Y queries…`): `src/agent/mixins/turn-engine.ts:422`
- `\n\n[Cancelled]`: `stream-turn.ts:297/322/382`, `session-turn.ts:231/537/549`, `batch-turn.ts:257`, `turn-engine.ts:493`

### Layer B: `ProviderStreamEvent` — what adapters emit

Defined at `src/core/plugins/api.ts:460-484`. Richer than `StreamChunk`. Adds:
- `{ type: "status"; status: "connecting" | "ready" | "streaming" | "complete" | "error"; message?: string }` — `api.ts:461`
- `{ type: "usage"; usage: ProviderUsageSnapshot }` — `api.ts:466`, where `ProviderUsageSnapshot` = `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` at `api.ts:440-445`
- plus `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `error`, `done` (with `stopReason`), `tool-approval-request`, `questionnaire-request`

### Layer C: `ProcessMessageObserver` — step/tool lifecycle with timestamps

Defined at `src/agent/turns/types.ts:54-60`:
- `onStepStart{ stepNumber, timestamp }`
- `onStepFinish{ stepNumber, timestamp, finishReason, usage, rounds }` — `rounds` documented at `types.ts:32-38` as the tool-call round-trip count PTC exists to cut
- `onToolStart{ toolCall, timestamp }`
- `onToolFinish{ toolCall, toolResult, timestamp }`
- `onError{ message, timestamp }`

`ProcessMessageUsage` at `types.ts:16-21` includes `costUsdTicks`.

### Layer D: Hook events — external commands only

`src/hooks/types.ts:1-19` defines eighteen events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `UserInterrupt`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PreCompact`, `PostCompact`, `Notification`, `InstructionsLoaded`, `CwdChanged`. These fire user-configured shell commands. No internal UI component subscribes to any of them.

---

## 2. Per-event UI consumer, and what happens when there is none

The entire UI bridge is one switch statement: `src/ui/hooks/use-turn-engine.ts:196-413`.

| chunk | consumer (file:line) | notes |
|---|---|---|
| `content` | `use-turn-engine.ts:197-208` | appends to `stream-store`, yields via `setImmediate` per delta so React commits separately |
| `reasoning` | `use-turn-engine.ts:209-213` | accumulates into `reasoningAccRef`, pushed to `setStreamReasoning` |
| `tool_calls` | `use-turn-engine.ts:214-316` | also mines args for `task`/`delegate` roster (`:221-247`), `TodoWrite` plan (`:253-291`), `ask_user_structured` questionnaire (`:296-310`) |
| `tool_result` | `use-turn-engine.ts:331-336` → `appendLiveToolResult` (`use-turn-stream.ts:223-248`) | |
| `tool_approval_request` | `use-turn-engine.ts:337-391` | routes to edit / payment / generic approval panel |
| `questionnaire` | `use-turn-engine.ts:317-330` | |
| `error` | `use-turn-engine.ts:392-401` | appended inline to assistant text; auth errors additionally raise the API-key modal at `:436-440` |
| `warning` | `use-turn-engine.ts:402-410` | appended inline |
| `done` | `use-turn-engine.ts:411-412` | no-op |

Live stream buffers are leaf-isolated in `src/ui/stream-store.ts` (content and reasoning have separate listener sets, `stream-store.ts:34-35`), so token deltas do not re-render the top-level App.

### Dropped entirely

- **`ProviderStreamEvent.status`** — discarded in the default branch at `src/agent/turns/session-turn.ts:317-318`, comment reads `// status — ignored for v1.` Seven adapters emit it.
- **`ProviderStreamEvent.usage` cache fields** — captured into `finalUsage` at `session-turn.ts:510`, then narrowed to input/output/total at `session-turn.ts:582-590`. Cache read/write are dropped there.
- **`ProcessMessageObserver`** — no UI consumer at all. The only subscriber is `composeTraceObserver` (`src/agent/mixins/turn-engine.ts:228-264`), which feeds the trace DB. Confirmed: no file under `src/ui` references `ProcessMessageObserver`. The UI recomputes tool duration itself from `activeToolStartRef` (`use-turn-stream.ts:214` set, `:244` cleared) rather than using the engine's timestamps.
- **Hook events** — reach only external shell commands (`src/hooks/executor.ts`). `PreCompact`/`PostCompact`/`SubagentStart`/`SubagentStop` have no internal subscriber.

### The three turn paths diverge

- **ai-sdk path** (`stream-turn.ts`): cache tokens survive, because `onFinish` passes raw `totalUsage` (`stream-turn.ts:115-117`) and `usageFromRecord` aliases `cachedInputTokens` (`src/core/plugins/builtin/provider-usage.ts:18`).
- **provider-session path** (`session-turn.ts`): `status` dropped at `:317-318`; cache tokens dropped at `:582-590`.
- **batch path** (`batch-turn.ts`): the only place provider-reported `costUsdTicks` exists (`src/agent/turns/helpers.ts:200`, accumulated `:208`).

---

## 3. Reasoning / thinking, per provider

### Incremental deltas (true streaming)

| adapter | emit site | raw field parsed |
|---|---|---|
| Claude Agent SDK | `src/core/plugins/native/claude-agent-provider.ts:1201` | `thinking_delta` / `delta.thinking` (`:1195,1199`); lump fallback from complete `thinking` block at `:1158` |
| Codex | `src/core/plugins/native/codex-provider.ts:358` | `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` |
| Omnigent | `src/core/plugins/native/omnigent-provider.ts:361` | `response.reasoning_text.delta`, `response.reasoning_summary_text.delta` |
| OpenCode | `src/core/plugins/native/opencode-provider.ts:122` | typed SDK `part.type === "reasoning"` |
| CodeSurf desktop | `codesurf-desktop-provider.ts:1031` (zero-length "thinking indicator") and `:1036` | daemon `thinking_start` / `thinking` |
| OpenAI-compatible (local-llm, lightclaw, hermes streaming) | `src/core/plugins/builtin/openai-sse-consumer.ts:135-137` | `delta.reasoning`, `delta.reasoning_content` |
| amp, grok CLI | `src/core/plugins/builtin/transports/anthropic-stream-json.ts:178` | Anthropic `thinking_delta`; lump fallback `:195` |

amp needs `--stream-json-thinking`, **off by default** (`src/core/plugins/native/amp-provider.ts:252-254`) because some agent modes reject it with `InvalidModelOutputError` (`:117-121`). grok CLI needs `--include-partial-messages` (`grok-provider.ts:309`).

### Lump at end only
- Hermes non-streaming JSON path: `src/core/plugins/native/hermes-gateway-provider.ts:142` (`message.reasoning`) and `:144` (`message.reasoning_content`).

### Unavailable
- **Lazar** emits no reasoning at all; its stream-json vocabulary has no thinking equivalent (`src/core/plugins/native/lazar-provider.ts:397-399`).
- **Fractal** fakes it: forwards `fractal:`-prefixed CLI stderr progress lines as `reasoning-delta` (`src/core/plugins/native/fractal-provider.ts:223`), documented as a deliberate UI-progress hack at `:13-14`. No real model reasoning.
- **xai-provider.ts / anthropic-provider.ts** have no `sendTurn`; they only expose an ai-sdk `LanguageModel` (`xai-provider.ts:74-99`, `anthropic-provider.ts:81-99`). Reasoning for those flows through `stream-turn.ts`.

### ai-sdk direct path
`stream-turn.ts:132-142` reads `reasoning-delta` parts off `result.fullStream`. Encrypted reasoning is detected over a rolling 256-char window and replaced once with `[Encrypted reasoning hidden]` (`stream-turn.ts:134-140`; same guard at `session-turn.ts:254-259`). Detector: `src/agent/reasoning.ts:23-26`. `src/agent/reasoning.ts` is **only** about stripping encrypted reasoning; it does no parsing or formatting.

### Reasoning effort — configurable, nearly invisible

- Type: `ReasoningEffort = "low" | "medium" | "high" | "xhigh"` — `src/types/index.ts:322`
- Model catalog flags `defaultReasoningEffort` / `supportsReasoningEffort` — `src/types/index.ts:337-338`
- Persisted per model: `reasoningEffortByModel` — `src/utils/settings.ts:182`; resolved at `src/grok/models.ts:122-127`
- Sent to xAI via `providerOptions.xai.reasoningEffort` — `src/grok/client.ts:52-64`, spread into `streamText` at `stream-turn.ts:96`
- Sent to xAI batch/subagent as `reasoning_effort` — `src/agent/turns/helpers.ts:36-44`, `batch-turn.ts:130`, `src/agent/mixins/subagent.ts:149`
- Codex uses a **separate** plugin setting, not `reasoningEffortByModel` — `codex-provider.ts:1019-1027`, sent as `effort` at `:709`
- Claude Agent SDK uses its own `ThinkingConfig` — `claude-agent-provider.ts:161-238`
- **Displayed in exactly one place**: the model picker modal, `src/ui/model-picker-modal.tsx:339` (`[${reasoningEffort}]`), adjusted with arrow keys at `:185` → `src/ui/hooks/modal-actions/use-model-actions.ts:56-101`. Absent from footer, title bar, and status line (verified: zero matches for `reasoningEffort` in footer-chrome files).

---

## 4. Tool execution

### No streaming
Bash spawns at `src/tools/bash.ts:160-165`, collects stdout/stderr into arrays at `:202-215`, and builds the single `ToolResult` only on `close` at `:225-230`. There is no partial-output callback parameter and no consumer for one. `src/core/plugins/native/bash-tools.ts:151` receives one final object. Grep is the same: accumulates ripgrep JSON and resolves only in `close` (`src/tools/grep.ts:336-352`).

Background processes pipe to a log file (`bash.ts:302-344`) that is **pull-only** — the model must call `process_logs` (`bash.ts:363-402`). Cap of eight concurrent background processes (`bash.ts:26`).

`src/agent/tool-presentation.ts` (`buildRunCodeTool` `:174-192`) calls the same native `execute` closures and returns only the resolved value, so the PTC "code" presentation inherits final-result-only behaviour.

### Timeouts and heartbeats
- Foreground default 30s, caller-configurable: `src/tools/bash.ts:94`
- On expiry: SIGTERM then SIGKILL after 1000ms, message `Command timed out after Nms` — `bash.ts:232-237`
- **No heartbeat.** A single `setTimeout`, no interval.
- `computer.ts` passes no timeout to `execFile` (`src/tools/computer.ts:620-627`); only abort-signal cancellation with 2000ms/1000ms graces (`:579-580`, `:660-677`).
- The only stall detection in the whole system is the Claude Agent SDK watchdog: `STALL_TIMEOUT_MS = 120_000` (`claude-agent-provider.ts:52`, overridable via `CODESURF_PROVIDER_STALL_MS`), firing `Provider stream stalled — no activity for Ns…` at `:1021`. All-or-nothing; no intermediate warning. Paused while a tool approval is pending (`:1015-1018`).

### No structured progress
No tool emits counts, percentages, or phases. There is no `tool_progress` chunk type. The only tool-lifecycle cases in the UI switch are `tool_calls` (`use-turn-engine.ts:214`) and `tool_result` (`:331`).

### Truncation sites

| limit | value | site | replacement message |
|---|---|---|---|
| bash foreground buffer | 10 MiB | `bash.ts:24` | `${streamName} maxBuffer length exceeded`, process killed (`:204-209`) |
| bash background tail | 8 KiB / 50 lines | `bash.ts:25`, `:363`, `:384` | none |
| grep matches | 100 | `grep.ts:7` | `Found 100 matches (limit reached; more exist, total not counted)` (`:182-184`) + trailing notice (`:198-201`) |
| grep line length | 2000 chars | `grep.ts:8` | `…` suffix (`:194`) |
| grep record | 64 KiB | `grep.ts:9` | `(Skipped N oversized result record…)` (`:146-149`) |
| grep stderr | 8 KiB | `grep.ts:10` | none |
| file read | 2000 lines / 512 KiB | `file.ts:49-50` | `[path: lines A-B; output limit reached, file continues …continue with start_line=N]` (`:248-249`) |
| file line length | 2000 chars | `file.ts:51` | `…` suffix (`:179`) |
| schedule log tail | 64 KiB | `schedule.ts:12` | drops partial first line (`:270-272`) |
| computer execFile | 10 MiB | `computer.ts:626` | Node default error |

**No global cap.** Each tool enforces its own; there is no shared truncation utility.

### `ToolResult` fields and UI usage
Defined `src/types/index.ts:179-192`:

| field | rendered? |
|---|---|
| `success`, `output`, `error` | yes |
| `diff` | yes — `src/ui/components/diff-lsp-views.tsx`, height at `message-list.tsx:806` |
| `plan` | yes — `message-list.tsx:266` |
| `task` | yes — `message-list.tsx:276-277`, `message-views.tsx:156` |
| `delegation` | yes — `message-list.tsx:297`, `message-views.tsx:174` |
| `backgroundProcess` | yes — `message-list.tsx:381-382` |
| `media` | yes — `message-list.tsx:331-333` |
| `lspDiagnostics` | yes — `message-list.tsx:358-376` |
| `computer` | **NO** — set at `src/tools/computer.ts:166`, zero references under `src/ui` |
| `verifyRecipe` | **NO** — set at `src/verify/orchestrator.ts:131`, zero references under `src/ui` |

---

## 5. Subagents, delegations, workflows

### Inline subagents (`task` tool) — live push, thin payload
`runTask` passes an `onActivity` callback that calls `emitSubagentStatus` (`src/agent/mixins/subagent.ts:672-682`), cleared in `finally` at `:689`. Payload is `SubagentStatus { agent, description, detail }` (`src/types/index.ts:77-81`), where `detail` is a short formatted tool label from `formatSubagentActivity` (`src/agent/agent-helpers.ts:33`). Called per tool call at `subagent.ts:205`, `:487`, `:501`, `:521`, `:577`.

Broadcast: `src/agent/mixins/notifications.ts:46-57` (`emitSubagentStatus`, keyed by `runKey` so the first of N concurrent subagents to finish does not blank the indicator).
Subscribed: `src/ui/hooks/use-running-agent-rows.ts:82-86` and `src/ui/hooks/use-telegram-bridge.ts:110-112`.
Rendered: `src/ui/components/message-views.tsx:144` (`SubagentActivity`).

Hooks fire at `subagent.ts:658` (`SubagentStart`) and `:695` (`SubagentStop`, in `finally` so abort/throw still fires it).

**Not forwarded:** subagent model id, elapsed time, token usage (recorded under source `"task"` at `subagent.ts:183` and `:219`, excluded from `lastTurnUsage` and from the parent trace), step count, or intermediate text.

### Background delegations — poll-only, static payload
`DelegationRun { id, agent, description, summary, status, title?, startedAt? }` — `src/types/index.ts:65-75`. `DelegationStatus = "running" | "complete" | "error"` (`:63`).

While running, `summary` is the literal constant `"Running in the background."` (`src/agent/delegations.ts:243`, again at `:720`). Status only transitions at completion (`:351`) or failure (`:383`).

The UI polls every 1.5s while active, 10s idle (`src/ui/hooks/use-running-agent-rows.ts:11-12`, `getDelegationPollInterval` `:23-35`, `pollDelegationState` `:42-53`). It is polling static data. No elapsed time, tokens, phase, or last message.

Completion notifications: `consumeBackgroundNotifications` (`src/agent/mixins/notifications.ts:59-`) pushes a `Notification` hook and a pending message list. `TaskCreated`/`TaskCompleted` hooks fire at `src/agent/session-delegations.ts:44-51` and after.

### Workflows — two unrelated things
1. **`/workflow <task>`** (`src/core/plugins/native/workflow-orchestrator.ts:188-214`) is a `PromptCommandSpec` injecting a static ~100-line spec (`WORKFLOW_SPEC` `:58-162`). No runtime state; "phases" are whatever prose the model writes.
2. **Executable `.js` scripts** (`~/.claude/workflows/*.js`). Runner: `src/utils/workflow-script-runner.ts:129-156`, injecting `args`, `phase`, `agent`, `log` (`:154`). Wired at `src/core/plugins/native/js-workflows.ts:120-129`.
   - `agent(prompt, opts)` (`workflow-script-runner.ts:133-145`) → `ctx.subagents.runTask` (`js-workflows.ts:95-118`). Returns only final text. Nothing intermediate.
   - `phase(title)` (`:147-149`) → `ctx.chat.appendAssistant("▶ Phase: " + title)` (`js-workflows.ts:127`). A transcript line, not structured state.
   - `log(message)` (`:150-152`) → `ctx.chat.appendAssistant("  " + message)` (`js-workflows.ts:128`). Transcript only, not stdout or a file.
   - Discovery reads `meta.phases` (`WorkflowScriptPhase { title, detail, model }`, `src/utils/workflows.ts:238-242`, `discoverWorkflowScripts` `:370-384`) for menu display only.
   - **No per-agent progress** (which agent, elapsed, model) reaches the UI while running.

### `/loop` — the one real live indicator
`LoopPhaseSpec { name, instructions, verification }` (`api.ts:97-104`), `LoopState { spec, currentIteration, status, history, lastMessage, pendingTokens }` (`api.ts:137-145`), `LoopIterationRecord { iteration, startedAt, status, summary, verificationNotes, tokensUsed }` (`api.ts:127-135`).

Rendered: `LoopStatusIndicator` shows `⟳ {name} {iteration}/{maxIterations}` — `src/core/plugins/native/loop-command.ts:92-100`, registered as an `input-footer` status indicator at `:234-237`, updated via `notifyIndicator` at `:230`. Token accounting feeds in at `src/agent/mixins/telemetry.ts:98-105` (`loops.noteUsage`).

**Held but not rendered:** phase name, per-phase timing, `lastMessage`, `pendingTokens`, `verificationNotes`.

---

## 6. Usage, cost, timing

### Where computed
`Agent.recordUsage` — `src/agent/mixins/telemetry.ts:77-108`. **Its parameter type accepts only `{ totalTokens, inputTokens, outputTokens }`** (`:78-80`). It writes `recordUsageEvent` (`src/storage/usage.ts:23`), feeds the active trace (`:92`), sets `lastTurnUsage` via `usageFromRecord` (`:93-99`), and notes loop usage (`:98-105`).

Normalizer `usageFromRecord` — `src/core/plugins/builtin/provider-usage.ts:8-32`. Aliases at `:18` include `cachedInputTokens` and `cache_read_input_tokens`; `:19-24` include `cache_creation_input_tokens`.

### Cache tokens: a live bug on the provider-session path
- **ai-sdk path**: survives. `onFinish: ({ totalUsage }) => ctx.recordUsage(totalUsage, …)` at `stream-turn.ts:115-117` passes the raw object, and `usageFromRecord` picks up `cachedInputTokens`.
- **provider-session path**: lost. Providers emit full snapshots (`claude-agent-provider.ts:1245`, `opencode-provider.ts:291` with all four fields, `anthropic-stream-json.ts:63-73` for amp/grok). `session-turn.ts:510` captures them into `finalUsage`. `session-turn.ts:582-590` then builds a narrowed literal with only input/output/total.

Consequence: `getCacheStatsLine` returns a formatted line whenever `lastTurnUsage` is non-null (`src/agent/mixins/context.ts:49-56`), and `formatCacheStatsLine` coerces undefined to zero (`src/utils/skill-context.ts:107-108`). The title bar therefore **displays `cache: 0 read · 0 written · N in`** for Claude / Codex / amp / OpenCode / grok-CLI sessions whose adapters demonstrably do emit those fields. Zeros are shown as if measured, rather than the line being hidden.

### Cost
`estimateCostMicros` — `src/storage/usage.ts:97`: `inputTokens * info.inputPrice + outputTokens * info.outputPrice`, where `info = getModelInfo(model)` (`src/grok/models.ts:101-104`). `getModelInfo` only consults the local xAI `MODELS` table (`models.ts:3`), so it returns `undefined` and the cost silently becomes 0 for every non-xAI model. Cache tokens are not factored in either way. Written to `usage_events`; **never rendered anywhere in `src/ui`**.

Provider-reported cost (`costUsdTicks`) exists only on the batch path: `src/agent/turns/helpers.ts:200` (`asNumber(usage.cost_in_usd_ticks)`), accumulated `:208`.

### Timing
**Time to first token is not measured anywhere.** No matches for `firstToken` / `ttft` / `timeToFirst`.

What exists:
- Whole-turn elapsed clock: `src/ui/components/claude-code-status-line.tsx:113-120` (100ms tick during `tool` phase, 1000ms otherwise), formatted `:87-91`. Start point is `startTimeRef.current = Date.now()` in `beginLiveTurn` (`src/ui/hooks/use-turn-stream.ts:144`).
- Per-tool duration recomputed in the UI from `activeToolStartRef` (`use-turn-stream.ts:214` / `:244`), and separately in `src/ui/ai-output/tool-calls-collation.ts:21`.
- Engine-side timestamps on every observer callback are discarded (see §2).
- `totalLatencyMs` and per-step `durationMs` are computed in the trace collector (`src/agent/trace-collector.ts:120`, `:161`) and written to the DB only.

### What actually reaches the user
- Cache line in the title bar: `src/ui/components/claude-code-title-bar.tsx:68-72`, sourced from `agent.getLastCacheStatsLine()` at `src/ui/routes/session-route.tsx:139`, recomputed only when `isProcessing` toggles (once per completed turn, not live).
- Context tokens used vs window: `src/ui/components/claude-code-context-count.tsx:21` and `:38`; meter percentage at `src/ui/components/context-meter.tsx:23`. Source: `agent.getContextBreakdown(...)` at `src/ui/context/model-context.tsx:146`.
- Queued-message count: `claude-code-context-count.tsx:42-56` (`+{queuedCount}`).
- Session total tokens exist (`getSessionTotalTokens`, `src/storage/usage.ts:53-62`) but are consumed only by `src/agent/mixins/session-lifecycle.ts:150` for the sessions list.
- **No tokens/sec or rate indicator anywhere.**

---

## 7. Errors, retries, fallbacks, rate limits, compaction

### Retry / backoff
Exists **only** in the batch client: `src/grok/batch.ts:337-366`. On HTTP 429 with `retryRateLimit`, reads `Retry-After` (`getRetryAfterMs` `:392-407`), sleeps, retries up to `DEFAULT_RATE_LIMIT_RETRIES = 5` (`:8`), exponential backoff capped at 5s (`:364`). **Completely silent** — no user-visible signal.

The interactive path has **no retry at all**. Status codes map to friendly strings in `STATUS_MESSAGES` (`src/agent/turns/helpers.ts:422-435`; 429 → "Rate limit exceeded…", 503/529 → "…overloaded…"), formatted by `humanizeApiError` (`:435-446`), yielded once as an `error` chunk at `stream-turn.ts:271-283`, `:343`, `:392-397` and `session-turn.ts:557`. The only automatic recovery is compaction on context overflow (`isContextLimitError` → `stream-turn.ts:312`, `:387`, flagged by `attemptedOverflowRecovery`).

### Fallback
**No error-triggered model fallback exists.** `src/agent/routing/classify.ts` + `complexity.ts` + `src/agent/learning/learned-router.ts` implement *pre-request* adaptive routing, opt-in via `featureFlags.learning.adaptiveModelRouting` (`src/agent/constants.ts:56`). `Agent.resolveAdaptiveModel` (`src/agent/mixins/telemetry.ts:111-133`) returns `note: "↪ routed to X for Y queries (learned from N turns)"` (`:123-126`), consumed at `src/agent/mixins/turn-engine.ts:397-399` and `:421-422`, yielded as a plain `content` chunk. That one *is* announced.

### Error → UI
Two channels, and provider errors use the weaker one:
- Provider/stream errors are appended inline into the assistant message: `use-turn-engine.ts:392-399`. Stack traces go to stderr only (`use-turn-engine.ts:423-425`).
- Toasts (`HostToast`, `api.ts:233-238`; `PluginHostServices.toast.show` `api.ts:746-747`; routed `src/core/plugins/loader.ts:444-446`; sink bound `src/ui/hooks/use-kernel-bridge.ts:79`) are used only for peripheral things: voice/STT failures (`src/core/plugins/native/voice.ts:255,286,298,333`), model-picker confirmations (`use-model-actions.ts:133`), settings toggles (`host.ts:340`). **Never for provider errors.**

### Compaction — entirely invisible
`src/agent/compaction.ts` is pure computation. Zero `yield`, zero `StreamChunk`, zero `console.*`.

Orchestration is `compactForContext` at `src/agent/mixins/runtime.ts:57-100`:
- Fires `PreCompact` (`:74-80`) and `PostCompact` (`:91-97`), both with `.catch(() => {})` — errors swallowed.
- Splices the summary into `st(this).messages` (`:88-89`), persists via `appendCompaction` (`:87`), returns a boolean.
- **Yields no chunk, raises no toast, writes no system message.**

Call sites `stream-turn.ts:52-59` and `batch-turn.ts:54` simply `await` it. No internal subscriber for `PreCompact`/`PostCompact`.

The threshold is not surfaced visually either: `context-meter.tsx:18-27` and `claude-code-context-count.tsx:27-67` render the same muted theme colours at every ratio. No red/warning state exists.

---

## 8. Trace collector

`src/agent/trace-collector.ts`. One collector per `Agent.processMessage` turn, created **internally** so headless / programmatic / Telegram turns are captured too (`:3-5`).

Captures:
- Generate steps with `finishReason` — `:74-81`
- Tool calls with `toolName`, `input`, `output`, `success`, `durationMs`, and start-time `cwd` in metadata — `:84-132`
- Accumulated tokens from `"message"`-source usage — `:135-140`
- On `finish`: `outcome`, `startedAt`/`endedAt`, `totalTokens`, `totalLatencyMs`, `queryClass`, full step array — `:143-174`

Outcome is auto-derived: success on the `Stop` hook, failure on `StopFailure`, cancelled on user abort (`:6-8`).

Writes to:
1. The trace database via `recordTrace` (`:166`).
2. `~/.codesurf/dev-conversations/<YYYY-MM-DD>.jsonl` via `recordDevConversationLog` (`:167`), implemented at `src/agent/learning/self-learning.ts:121-141`, gated by `isDevConversationLoggingEnabled()` (`:114`), redacted.

**Not user-visible in the TUI.** The nearest surface is `/routing` (`src/core/plugins/native/routing-command.ts:109-110`), which shows learned model scores per query class, reading traces at `:75`. Host action `src/core/plugins/native/host-actions.ts:331` reads the last trace for feedback capture.

A second invisible log: the raw Claude Agent SDK message stream is **always** written to `~/.grok/claude-agent-sdk.log` (`claude-agent-provider.ts:44`, `logLine` `:57-69`), truncated on first write per process.

---

## 9. Loop guard, fabrication detector, verification

### Loop guard
`src/agent/loop-guard.ts`. Per-turn instance. Two detections:
- Identical `(tool, argsJson)` more than `maxIdenticalCalls` (default 3) — `:65-69`. Message: `Tool "X" was called with identical arguments N times (max 3). Stop repeating this call and try a different approach.`
- Period-2/3 ping-pong over the last `pingPongWindow*2` (default 6) calls — `:74-79`. Message: `Repetitive tool-call pattern detected (alternating identical calls). Stop and change approach.`

`wrapToolSetWithLoopGuard` (`:140-169`) substitutes `{ success: false, output: reason }` at `:163` — the real tool never runs. Applied at `src/agent/session-toolsets.ts:301`.

**User visibility:** model-facing first. It reaches the user only as a *failed tool result* inside the tool panel, not as a distinct warning like the fabrication detector produces.

### Fabrication detector
`src/agent/fabrication-detector.ts`. `detectClaimWithoutTool(text, toolCallCount)` (`:70`) fires only when the turn made **zero** tool calls and the text matches `FIRST_PERSON_RE` (`:45-48`), `BOLD_DECLARATION_RE` (`:50`), or `SENTENCE_START_RE` (`:52`).

Message from `formatFabricationWarning` (`:88-94`):
`⚠️ Grounding check: this turn claimed an action (…) but invoked zero tools. The claim is likely fabricated — verify against git status / file state before trusting it.`

Emitted as a `warning` chunk from all three turn machines: `stream-turn.ts:354`, `session-turn.ts:611`, `batch-turn.ts:189`. **Fully user-visible**, inlined into the assistant stream at `use-turn-engine.ts:402-408`.

A second `warning` use at `stream-turn.ts:366-371`: output-length truncation notice, `_(Output stopped at the token limit — the reply may be truncated. Send "continue" to resume.)_`, fired when `finishReason === "length"`.

### Verification
Two paths.
1. **Live**: `/verify` (`src/core/plugins/native/workflow-prompts.ts:48-53`) calls `buildVerifyPrompt(cwd)` (`src/verify/entrypoint.ts:434`), a canned user prompt instructing the model to run two `task` sub-agents in sequence (`:460-490`) and relay the report (`:493`). Output streams as ordinary chunks. Textual "Step 1 / Step 2", no numeric progress.
2. **Dead**: `Agent.runVerify` (`src/agent/mixins/runtime.ts:164`) drives `runVerifyOrchestration` with an `onProgress` callback emitting milestones — `"Loaded verify environment manifest…"` (`src/verify/orchestrator.ts:57`), `"Preparing verify checkpoint"` (`:84`), `"Creating checkpoint: …"` / `"Reusing checkpoint: …"` / `"Waiting for in-progress checkpoint: …"` (`src/verify/checkpoint.ts:411`, `:446`, `:452`), `"Running verify sub-agent"` (`:127`). **No caller outside tests.** A working progress channel with nothing attached.

`src/verify/evidence.ts`, `environment.ts`, `recipes.ts`, `retry.ts` are pure data/prompt builders with no UI touchpoints. `ToolResult.verifyRecipe` (set `orchestrator.ts:131`) is never read by the UI.

---

## 10. TODO / FIXME comments

**None.** A sweep of `src/agent`, `src/core`, `src/ui`, `src/verify`, `src/utils`, `src/tools` for `TODO|FIXME|HACK|XXX` found no task markers relating to progress, streaming, events, status, UI feedback, or telemetry. The only matches are a unicode-escape note (`src/core/plugins/native/nerd-icons.ts:18`) and test-fixture strings in `claude-agent-provider-permission.test.ts`.

---

## Ranked: signals that exist but are not surfaced to the user

1. **Provider connection status.** Seven adapters emit `connecting` / `streaming` (and some `error` / `complete`); all discarded at `src/agent/turns/session-turn.ts:317-318`. Highest value: it would turn the generic "waiting" spinner into real state during the 1.8s–3.0s spawn window before the first token, which is exactly the period users read as a hang.
2. **Cache read/write tokens on the provider-session path.** Emitted by Claude, OpenCode, amp, grok adapters; captured `session-turn.ts:510`; dropped `session-turn.ts:582-590`. Worse than a gap: the title bar actively displays zeros as if measured (`claude-code-title-bar.tsx:68`, `skill-context.ts:107-108`). Prefix-cache health is the single most actionable cost lever and it is currently misreported.
3. **Step lifecycle and tool-call `rounds`.** `onStepFinish` carries `rounds`, `finishReason`, per-step usage (`stream-turn.ts:104-114`, `session-turn.ts:593-604`). Trace-DB only. `rounds` is the metric PTC exists to reduce and the user cannot see it.
4. **Compaction start/end.** A history rewrite with no chunk, toast, or system message (`runtime.ts:57-100`). Users experience an unexplained pause followed by a model that forgot things.
5. **Per-tool engine timestamps.** `onToolStart`/`onToolFinish` carry precise timestamps; the UI discards them and re-derives duration from its own ref (`use-turn-stream.ts:214`/`:244`).
6. **Cost.** Computed per turn (`usage.ts:97`), stored in `usage_events`, rendered nowhere, and silently zero for every non-xAI model (`models.ts:101-104`).
7. **Subagent token usage.** Recorded under source `"task"` (`subagent.ts:183`, `:219`), excluded from both `lastTurnUsage` and the parent trace. A `task` fan-out is invisible in the context meter.
8. **Delegation liveness.** `startedAt` is on the type (`types/index.ts:74`) and populated (`delegations.ts:715-721`), but `summary` is a hardcoded string while running (`:243`, `:720`). A 40-minute background run looks identical to one started 3 seconds ago, polled every 1.5s (`use-running-agent-rows.ts:11`).
9. **Raw provider logs.** `~/.grok/claude-agent-sdk.log` (`claude-agent-provider.ts:44`) and `~/.codesurf/dev-conversations/*.jsonl` (`self-learning.ts:124-127`) hold the full picture with no in-app path to them.
10. **Trace step durations and `totalLatencyMs`.** Written every turn (`trace-collector.ts:120`, `:161`), surfaced nowhere except indirectly via `/routing` scores.
11. **Reasoning effort.** Visible only inside the model picker (`model-picker-modal.tsx:339`) despite materially changing latency and cost.
12. **Loop-guard trips.** Downgraded to a failed tool result (`loop-guard.ts:163`) instead of the `warning` channel the fabrication detector uses (`stream-turn.ts:354`).
13. **Loop phase, `lastMessage`, `pendingTokens`, `verificationNotes`.** Held in `LoopState` / `LoopIterationRecord` (`api.ts:127-145`); only `iteration/maxIterations` rendered (`loop-command.ts:92-100`).
14. **Dead verify progress channel.** Milestone strings defined and unreachable (`orchestrator.ts:57-127`, `checkpoint.ts:411-452`), caller-less at `runtime.ts:164`.
15. **Provider `done.stopReason`.** Carried on the event (`api.ts:467`), queued at `session-turn.ts:312`, never turned into anything the user sees.
16. **`ToolResult.computer` and `ToolResult.verifyRecipe`.** Populated by the engine (`computer.ts:166`, `orchestrator.ts:131`), zero UI references.

---

## Cheap to add given current plumbing

- **Time to first token.** `startTimeRef.current` already set at `src/ui/hooks/use-turn-stream.ts:144`; first `content` chunk arrives at `src/ui/hooks/use-turn-engine.ts:197`. One `Date.now()` diff plus one state field.
- **Status chunk, end to end.** Add `"status"` to the union at `src/types/index.ts:306-315`; replace the drop at `src/agent/turns/session-turn.ts:317-318` with a `queue.push`; add a case in the switch at `use-turn-engine.ts:196`; extend `ClaudeCodeStatusPhase` at `src/ui/components/claude-code-status-line.tsx:9`. Adapters already emit it, so this is pure plumbing.
- **Cache token fix.** Widen the `recordUsage` signature at `src/agent/mixins/telemetry.ts:77-80` and pass `finalUsage` through unchanged at `src/agent/turns/session-turn.ts:582`. `usageFromRecord` (`provider-usage.ts:8-32`) already handles every alias.
- **Compaction notice.** Both call sites are already inside a generator. Yield a `warning` chunk around `await ctx.compactForContext` at `src/agent/turns/stream-turn.ts:52-59` and `src/agent/turns/batch-turn.ts:54`.
- **Context-meter warning colour.** `ratioRemaining` already in hand at `src/ui/components/context-meter.tsx:23`. One conditional against the compaction threshold.
- **Rounds counter in the status line.** `toolRounds` already tracked at `session-turn.ts:357` and in `stream-turn.ts`; needs only the status chunk above to ride on.
- **Reasoning effort in the footer.** `getEffectiveReasoningEffort` (`src/grok/models.ts:122-127`) is already called per turn via `resolveModelRuntime` (`src/grok/client.ts:52`); the footer chrome just needs to read it.
- **Delegation elapsed time.** `startedAt` already populated (`delegations.ts:715-721`); the poll already runs every 1.5s (`use-running-agent-rows.ts:42`). Render a delta.
- **Loop-guard as a warning chunk.** `loop-guard.ts:163` already builds the reason string; emit it alongside the failed tool result the way `formatFabricationWarning` is emitted at `stream-turn.ts:354`.
- **Subagent model + elapsed in `SubagentStatus`.** The struct is three fields (`types/index.ts:77-81`) and the emit site already has `request` and a run key (`subagent.ts:672-682`). Additive.
- **Expose the SDK log path.** `LOG_FILE` is a module constant at `claude-agent-provider.ts:44`; a `/logs` listing command or a line in an error toast is trivial.

### Not cheap, stated plainly

- **Streaming bash stdout.** Listeners exist at `src/tools/bash.ts:202-215`, but there is no `tool_progress` chunk type and `execute` returns a single `ToolResult` consumed at `src/core/plugins/native/bash-tools.ts:151`. Needs a new chunk type, a callback threaded through the tool signature, and UI buffering. Medium, not cheap.
- **Interactive rate-limit retry.** Nothing exists on this path; `helpers.ts:422-446` is one-shot humanization. This is new behaviour, not new plumbing.
- **Generic tool heartbeat.** Only the Claude Agent SDK has a stall watchdog (`claude-agent-provider.ts:52`, `:1021`). A cross-provider heartbeat means a timer per in-flight tool and a new event type.
