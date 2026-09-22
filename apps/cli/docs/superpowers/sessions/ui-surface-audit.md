# codesurf-cli TUI: progress, thinking and status surface audit

Repo root: `/Users/jkneen/Documents/GitHub/grok-cli`. All paths below are relative to that root.

Scope: every way the terminal UI communicates progress, state, "thinking" and task status to the user during and between agent turns.

---

## 1. Layouts

Two registered session layouts. A layout is a pure render contribution: given a `LayoutContext` and a shared `center` node, it renders title bar, queue banner, todo panel, composer wrapper and footer. Layouts own no hooks, no state and no keyboard handling (`src/ui/layouts/types.ts:1-25`).

| | opencode | claude-code |
|---|---|---|
| Registered default | **yes**, `src/ui/layouts/registry.ts:11` | no |
| Live status line | **none** | `ClaudeCodeStatusLine` |
| Elapsed timer | none | yes, ticking |
| Cancel affordance in status | none | click target at right edge |
| Context readout | composer footer | title bar |
| Todo panel | pinned only | pinned + floating toggle |
| Prefix-cache stats | no | yes |
| Footer left | cwd, sandbox, plugin chips | contextual shortcut hints |
| Live tool chips | yes | suppressed |

### Files

- **`src/ui/layouts/registry.ts:9-11`** — registers `opencode` then `claudeCode`, then `setDefaultLayoutId("opencode")`.
  Source: module load. Visibility: always. **Gap: the layout with all the progress instrumentation is not the default.**

- **`src/ui/layouts/types.ts:76-170`** — the `LayoutContext` interface. Notable progress-related fields: `isProcessing`, `contextStats`, `cacheStatsLine`, `statusSlot`, `queuedMessages`, `todoPlan`, `showTodoPanel`, `runningAgentRows`, `agentsFooterFocused`, `composerShortcutHints`.
  Source: built once in `src/ui/routes/session-route.tsx:573-611`. Visibility: always.

- **`src/ui/layouts/opencode.tsx:106-166`** — `SessionHeader` → `center` → `statusSlot` → `QueueBanner` → composer → `RunningAgentsFooter` → bottom chrome. Bottom chrome shows cwd (line 131-134), an orange `sandbox` marker when `sandboxMode === "shuru"` (135-139), plugin chips (143, 157), `wire <url>` or `serverless` (158-162), and `PromptModeLabel` (163).
  Visibility: always (default layout). **Gap: nothing in this tree reports elapsed time or the current action.**

- **`src/ui/layouts/claude-code.tsx:67-175`** — `ClaudeCodeTitleBar` → `center` → `statusSlot` → `ClaudeCodePendingMessages` → optional floating todo panel (82-96) → bordered composer with `bottomTitle` (98-134) → `RunningAgentsFooter` → footer with `ComposerShortcutHints` (147).
  Visibility: only when `/ui claude-code` has been selected.

- **`src/ui/routes/session-route.tsx:526-571`** — builds `statusSlot`. Contains `SubagentActivity` (unconditional, line 529), the `ClaudeCodeStatusLine` block **gated on `uiMode === "claude-code"`** (line 530), and `PlanQuestionsPanel` (line 569).
  **Gap: the single most informative progress surface in the app is behind a non-default mode check on one line.**

---

## 2. Status line, title bar, session header, context meter, extension chips

### ClaudeCodeStatusLine — `src/ui/components/claude-code-status-line.tsx`

- **`:9`** — phases are `"waiting" | "tool" | "thinking" | "stopped"`.
- **`:26-51`** `buildClaudeCodeStatusModel`. Precedence: `justStopped` → `stopped`; not processing → `null`; first active tool call → `tool`; non-empty `streamContent` → `thinking`; otherwise → `waiting`.
  **Gap: `"thinking"` here means assistant *text* is streaming. It has nothing to do with reasoning tokens.**
- **`:53-85`** `formatToolStatusParts` maps tool name to a verb and detail: `Read`/`Write`/`Edit` show a home-shortened path, `Bash` shows the command truncated to 72 chars, `Grep`/`Glob` show the pattern, `Task`/`Delegate` show raw args. Unknown tools get a PascalCased verb.
- **`:87-96`** `formatStatusElapsed` and `formatClaudeCodeStatusLabel` produce `Thinking... 12s`, `Waiting... 3s`, `Stopped 41s`. Tool phase uses one decimal below 60s.
- **`:113-123`** elapsed ticks via `setInterval` at **100ms for tools, 1000ms otherwise**.
- **`:126-137`** tool row renders `:: Run ` + accent verb + backticked accent detail.
- **`:139-151`** non-tool row renders spinner + label; `stopped` swaps the spinner for `· `.
- **`:157-162`** right-hand cluster: elapsed (tool phase only, since `showElapsedInline` inverts) plus a close glyph wired to `onMouseDown={onCancel}`.
- Cancel handler at `src/ui/routes/session-route.tsx:553-563` calls `abortActiveRun()` while processing, otherwise dismisses the `Stopped` state.
- `justStopped` is raised in `src/ui/hooks/use-session-lifecycle.ts:94-96` and auto-clears after **8000ms**; cleared on next turn at `src/ui/hooks/use-turn-engine.ts:152`.

### ClaudeCodeTitleBar — `src/ui/components/claude-code-title-bar.tsx:52-77`

Renders brand glyph + `codesurf` + branch or worktree label + shortened cwd, then `cacheStatsLine` in dim text, then `ClaudeCodeContextCount` right-aligned.
Source: `getGitWorkspaceInfo(cwd)` re-read on cwd change (`:42-46`); `cacheStatsLine` from `Agent.getLastCacheStatsLine()`.
Visibility: always in claude-code mode.

### ClaudeCodeContextCount — `src/ui/components/claude-code-context-count.tsx:16-25, 42-56`

Footer variant renders `| 73K / 200K |`, and appends `| +3 |` when the queue is non-empty. Title variant drops the pipes.
**Gap: shows used-of-window only. No cost, no per-turn delta, no rate of consumption.**

### SessionHeader — `src/ui/components/session-header.tsx:22-42`

Renders the mode label in the mode colour, plus `: <sessionTitle>` and a right-aligned `sessionId`.
**Dead fields: `src/ui/layouts/opencode.tsx:108` passes `sessionTitle={null} sessionId={null}` unconditionally. Both branches are unreachable.**

### ContextMeter — `src/ui/components/context-meter.tsx:18-26`

Renders `<pct>% <tokens>` remaining. Only consumer is the non-flat composer footer, `src/ui/components/prompt-box.tsx:187`. So opencode shows *remaining*, claude-code shows *used*. Two different framings of the same number in two layouts.

### PluginStatusIndicators — `src/ui/components/extension-status-indicators.tsx:10-40`

Filters the live extension registry by placement (`input-footer`, `mode-line`, `mode-line-left`) and renders each extension's own node. Returns `null` when the filtered set is empty.
Source: `useStatusIndicators()` from `src/core/plugins/registry`.

### What is never shown, in either layout

Cost. Per-turn token usage. Wall-clock turn duration. Model name while in claude-code mode. Provider identity. Turn number. Queue depth in opencode's title area.

---

## 3. Streaming assistant text

- **`src/ui/stream-store.ts:31-72`** — module-level `content` and `reasoning` strings with **separate listener sets**, so a content delta does not wake the reasoning leaf. The header comment (`:1-28`) records why: these used to live in `useState` at the top of `App`, and every token reconciled ~311 hooks, starving keyboard input.
- **`src/ui/stream-store.ts:76-95`** — `useStreamContent` / `useStreamReasoning` deliberately use `useState` + `useEffect` rather than `useSyncExternalStore`, because OpenTUI ships a custom reconciler and a silent no-op would freeze the stream.
- **`src/ui/components/message-list.tsx:578-586`** `StreamingResponseLive`. **Returns `null` when content is empty**, so the slot is not reserved before the first token.
- **`src/ui/components/message-list.tsx:1039-1044`** — rendered *inside* the scrollbox so the preview occupies the same slot the committed message will land in. The comment records that rendering it above the composer caused a visible "jump up" at end-of-stream.
- **`src/ui/ai-elements/streaming-response.tsx:16-35`** — thin wrapper over `Markdown` with `streaming` passed through; memoised on content, streaming flag and theme.
- **`src/ui/hooks/use-turn-engine.ts:197-208`** — commits **one React render per delta**, then yields with `setImmediate`. The comment documents two reverted attempts at throttling: a `setTimeout` window made cached responses appear all at once, and a per-frame coalescer collapsed bursts into a single delayed flush.
- **`src/ui/hooks/use-turn-stream.ts:201-207`** `applyLocalAssistantDelta` appends to the accumulator and pushes a sanitised preview.

### Gaps

- **No placeholder before the first token in opencode.** Between submit and first delta the transcript is unchanged; the only motion is `PromptLoadingBoxes` in the footer.
- **Time-to-first-token is never measured or displayed.** `startTimeRef` is set at `src/ui/hooks/use-turn-stream.ts:144` but is only consumed by the claude-code status line's aggregate elapsed.

---

## 4. Reasoning and thinking display

### Live, default path — ThinkingBlock

`src/ui/ai-output/thinking-block.tsx:67-102`.

- While streaming: `◌ Thinking` in accent bold, **expanded** by default (`:61-62`, `defaultCollapsed = !isThinking`).
- When finished: `✓ ` + `Reasoned` + `  N lines`, **auto-collapsed**.
- Right-aligned `▸ expand` / `▾ collapse` affordance, header row is a click target (`:69`).
- Body renders the trace as markdown with `streaming={isThinking}` (`:98`).
- `getThinkingBlockMeta` (`:25-47`) deliberately skips the line count during an active stream, since it is hidden anyway.
- **No elapsed time, no spinner.** The file header at `:3-5` records that the Raycast shimmer was replaced with a static accent header and "can be wired in later".

### Live, flagged path — ChainOfThought

`src/ui/ai-output/chain-of-thought.tsx:40-133`, gated by `render.reasoning.liveChainOfThought` (default **false**).

- `THINKING ◌` inverse chip plus `N/M steps`, or `waiting` when there are no thoughts yet (`:38`).
- Done thoughts get `✓`, the active one gets `◌` in bold accent, pending get `○`.
- Per-thought `[+]`/`[-]` detail expansion (`:88-100`).
- Header is a click target to collapse the whole panel (`:46`).
- Steps are synthesised by splitting the live trace on blank lines at `src/ui/components/message-list.tsx:618-630`; the last paragraph is `active` while processing, the rest `done`. When there are no blank-line boundaries yet it falls back to a single active step.
- `src/ui/components/message-list.tsx:601-607` keeps a stable empty header during active turns specifically so live tool rows cannot mount first and then jump when the first reasoning token lands.

### Committed reasoning on past messages

`src/ui/components/message-list.tsx:227-247`.

- Two or more paragraphs → `ChainOfThought` with `isThinking={false} collapsed`.
- Otherwise → `<Reasoning isStreaming={false} defaultOpen={false}>` + `ReasoningTrigger` + `ReasoningContent`.
- **`src/ui/ai-elements/reasoning.tsx:101-105`** can render `Thought for 3s`, but `src/ui/components/message-list.tsx:242` passes **no `duration` prop and `isStreaming={false}`**, so `defaultGetThinkingMessage(false, undefined)` always yields **`Thought for a moment`**. The duration-tracking machinery at `:67-80` and the 1000ms auto-close at `:82-90` are live only for callers that stream through the component, which none do.
- `ReasoningContent` (`:146-161`) deliberately renders plain dimmed text rather than markdown, for visual consistency with tool chips.

### Feature-flag gating

`src/ui/feature-flags.ts:41-53`:

- `render.thinkingBlock`, default **true** — "Render the streaming reasoning (thinking) block pinned above the prompt. Turn off if you see flicker."
- `render.reasoning.liveChainOfThought`, default **false** — structured widget instead of ThinkingBlock.

### Which providers feed reasoning

Only two emit sites in the whole repo:

- `src/agent/turns/session-turn.ts:381` — `yield { type: "reasoning", content: event.delta }`.
- `src/agent/turns/stream-turn.ts:137` — `"[Encrypted reasoning hidden]"` placeholder for redacted traces.
- `src/agent/turns/stream-turn.ts:141` — `part.text`.

Consumed at `src/ui/hooks/use-turn-engine.ts:209-213`, which accumulates into `reasoningAccRef` and pushes to the store.

**Gap: providers outside these two paths surface no thinking at all, and the UI cannot distinguish "this model has no reasoning" from "reasoning is not wired for this provider".**

### Related but unused

`src/ui/ai-output/steps.tsx` has status icons, done/failed counts, per-step `durationMs`, and a real `ProgressBar` (`:50-67`). It is imported only by `src/ui/ai-output/file-navigator.tsx` and the parity fixture. It never renders agent progress.

---

## 5. Tool calls

### Status glyphs

`src/ui/ai-output/tool-calls.tsx:50-55` — `pending: "○"`, `running: "◌"`, `done: "✓"`, `error: "✗"`.
**The running glyph is static.** `src/ui/ai-output/tool-call-block-list.tsx:11` declares braille `SPINNER_FRAMES`, but the compact chip path does not use them.

### What a running tool looks like

- **claude-code mode:** nothing in the transcript. `src/ui/components/message-list.tsx:1141` returns `null` when `compactLiveStatus`, and line 1050 additionally requires `toolCallsPanel`. With both defaults, the single status line `:: Run Bash \`<cmd>\`` is the only signal.
- **opencode mode:** `ToolChipGroup` at `src/ui/components/message-list.tsx:1147-1153`, or `ToolCallBlockList` when `render.toolCalls.panel` is on (`:1145`).
- Live records are built at `src/ui/components/message-list.tsx:950-968`: status hardcoded to `"running"`, args JSON-parsed with a silent catch, `timestamp: new Date()`.

### What a finished tool looks like

- `ChipsItem` groups consecutive chip-eligible tool results. Eligibility rules at `src/ui/components/message-list.tsx:1162-1180` exclude plans, task/delegate results, delegation lists, LSP, media, writes/edits, background processes and web search, all of which get bespoke views.
- Records built at `src/ui/components/message-list.tsx:1191-1200`: status is `"error"` when `toolResult.success === false`, else `"done"`.

### Collation

`src/ui/ai-output/tool-calls-collation.ts:34-58` documents a two-tier collapse.

- Tier 1: ≥ `CHIP_GROUP_THRESHOLD` (3) `done` chips of one tool merge into `3xBASH ✓`.
- Tier 2: ≥ `CHIP_MEGA_THRESHOLD` (3) tier-1 groups roll up per category into `[Tools ×N]`, `[Files ×N]`, `[Web ×N]`.
- **Status escapes: `running`, `error` and `pending` never collapse.**
- Categories at `:68-80`, user-overridable via `settings.chipCategories` (`:84-96`).

### Expansion and truncation

- `ToolChip` (`src/ui/ai-output/tool-calls.tsx:215-273`) is clickable only when args, output or error exist (`:228-229`). Chevron `▶`/`▼`, Nerd Font glyph preferred.
- Expanded detail renders below the chip row at `:491-532` with `input`, `output` and `error` sections, output as markdown.
- `:433-440` filters detail panels to individual chips that are *currently visible*, so a detail does not orphan below a collapsed group.
- `GroupChip` and `CategoryChip` (`:288-386`) explode on click into their parts; drilling to a single call is mega → group → individual.
- `ToolCallRow` (`:85-158`) is the non-chip row form, used for the block-list style.

### Block-list mode

`src/ui/ai-output/tool-call-block-list.tsx`, behind `render.toolCalls.panel` (default false).

- `◆` bullet rows with tool, path/detail, `[hooks: n]` and `[skill: …]` tags.
- `BLOCK_LIST_VISIBLE_MAX = 8` (`:15`) before the top collapses into "N more".
- `formatOutputHint` (`:35-47`) yields `(no output)` / `(no matches)`.
- `parseGrepMatchSummary` (`:50-71`) yields `(4 matches in 3 files)`.
- `parseReadRangeFromOutput` (`:74-79`) yields `lines 701-750 of 7351`.
- `expandBlockListRecords` (`:93-118`) inserts synthetic `Thought for Xs` rows whenever consecutive tool timestamps differ by ≥ 1000ms. **This is the only place a thinking duration is ever displayed, and it is inferred from gaps rather than measured.**

### Parallel tool calls

All active calls live in one `activeToolCalls` array. Chips render side by side in a wrapping row (`src/ui/ai-output/tool-calls.tsx:444`). The claude-code status line shows **only `activeToolCalls[0]`** (`src/ui/components/claude-code-status-line.tsx:42`).
`activeToolStartRef` is a **single timestamp for the whole batch**, set at `src/ui/hooks/use-turn-stream.ts:214` and zeroed at `:244`. There is no per-call timing.

**Correctness gap, not just display.** `tool_result` chunks arrive one per tool (`src/ui/hooks/use-turn-engine.ts:331-336`), and `appendLiveToolResult` unconditionally does `setActiveToolCalls([])` and `activeToolStartRef.current = 0` at `src/ui/hooks/use-turn-stream.ts:243-244`. When three tools run concurrently, the **first** result to land blanks the chips and the elapsed timer for all three, so the two still-running tools become invisible for the rest of their lifetime. The same clearing also resets the claude-code status line to `Waiting...` while work is genuinely in flight.

### Gaps

- **No streaming tool output.** Results appear only on completion via `appendLiveToolResult` (`src/ui/hooks/use-turn-stream.ts:223-248`). A long `bash` is a static `◌` for its whole lifetime.
- **`durationMs` is rendered but never populated.** Display sites: `src/ui/ai-output/tool-calls.tsx:116-120`, `:499-501`, `src/ui/ai-output/tool-call-block-list.tsx:283`. Construction sites `src/ui/components/message-list.tsx:959-966` and `:1191-1200` never set it. Outside `makeExample*` fixtures and the synthetic Thought rows the field is always `undefined`, so finished chips never show a duration.
- **No elapsed on a running tool chip.** Only the claude-code status line has a timer, and only for the head call.
- `src/ui/ai-output/activity-status.tsx:23-33` implements a real braille spinner hook plus elapsed, hint and `esc to interrupt`. It is showcase-only.

---

## 6. Subagents, delegations, workflows

### Inline subagent scratch line

`src/ui/components/message-views.tsx:144-153` `SubagentActivity` — one dim row, `→ ` plus `status.detail` truncated to 100 chars.
Source: `agent.onSubagentStatus` subscription at `src/ui/hooks/use-running-agent-rows.ts:80-87`.
Rendered unconditionally in `statusSlot` (`src/ui/routes/session-route.tsx:529`), so it is the one subagent signal both layouts share.

### Live task / delegate cards in the transcript

`src/ui/components/message-list.tsx:1088-1133`, gated on `showLiveTools && !compactLiveStatus`.

- ≥ 2 concurrent → `ParallelAgents` dashboard with `progressLabel: "${n} running"` (`:1107`).
- Exactly 1 → `SubagentTaskLine` or `DelegationTaskLine` with `pending`.
- **Entirely suppressed in claude-code mode by `:1089`.**

### AgentRoster

`src/ui/routes/session-route.tsx:349-357`, rendered in `pinnedTopSlot` with title `"session subagents"`.
`src/ui/ai-output/agent-roster.tsx:33-76` shows `- <name> (<role>)` plus optional description, colour-coded by kind.
Populated at `src/ui/hooks/use-turn-engine.ts:236-247` from every `task`/`delegate` tool call, keyed by tool-call id; description truncated to 100 chars.
Cleared only on plan dismiss/submit (`src/ui/hooks/use-plan-actions.ts:20, 39`) or session change (`src/ui/hooks/use-session-lifecycle.ts:133`).
**Gap: entries carry no status and no elapsed. Once a subagent finishes, its roster row looks identical to a running one, and the roster persists for the rest of the session.**

### Footer chip

`src/ui/running-agents.tsx:77-98` `RunningAgentsFooter` — `● 1 running subagent` / `● N running subagents`. Count only.
When focused it appends `enter view · ↑/esc back to composer`.
Rendered by both layouts (`opencode.tsx:113`, `claude-code.tsx:135`).

### Popup and detail modal

- `RunningAgentsPopup` (`src/ui/running-agents.tsx:181-240+`) overlays a centred panel and delegates row rendering to `ParallelAgents` via `runningAgentRowsToParallelAgents` (`:147-166`). The comment at `:101-107` records that this was deliberate, so the showcase example and the live view share one component.
- `formatElapsed` (`:36-46`) yields `42s`, `3m34s`, `1h05m`.
- **Elapsed is delegation-only.** `src/ui/hooks/use-running-agent-rows.ts:148-155` builds the inline row **without `startedAt`**, so the inline subagent never shows elapsed.
- `runningAgentRowsToParallelAgents` never sets `tools`, so the widget's `| N tools` column (`src/ui/ai-output/parallel-agents.tsx:99-103`) is always blank in the live view. It only appears in `makeExampleParallelAgents`.
- `detailLines` is populated only for the inline agent (`:161-163`), because delegations write nothing until completion.

### Polling cadence

`src/ui/hooks/use-running-agent-rows.ts:11-12` — `ACTIVE_DELEGATION_POLL_MS = 1500`, `IDLE_DELEGATION_POLL_MS = 10000`. Interval chosen at `:23-35` based on processing state, running delegations and modal openness.
The detail modal polls the saved output file every **500ms** (`:220-237`).
`pollDelegationState` (`:42-53`) uses `Promise.allSettled` so a run-list failure cannot suppress a completion notification.

### Completion and failure reporting

- Background notifications are appended as **plain assistant messages** at `src/ui/hooks/use-running-agent-rows.ts:115-125`. No toast, no icon, no distinct styling.
- Modal status for a finished delegation is inferred by regex over the output text: `/\*\*Status:\*\*\s*error/i` at `:246`.
- `TaskResultView` (`src/ui/components/message-views.tsx:155-171`) renders the finished task line plus a 90-char-truncated summary.

### Explicit stub

`src/ui/running-agents.tsx:9-14` and `:267` — "LIVE-STREAM SEAM: there is no per-subagent token stream yet… exposes a typed `liveTranscript` prop wired to nothing."

---

## 7. Spinners, loaders, shimmer

| Component | File:line | Frames / cadence | Where used |
|---|---|---|---|
| `LoadingSpinner` | `src/ui/components/loading-spinner.tsx:3-13` | 10 braille frames, 80ms | `ClaudeCodeStatusLine` only |
| `PromptLoadingBoxes` | `src/ui/components/prompt-bar.tsx:44-63` | 3 blocks with alpha falloff, 120ms | opencode footer, replaces mode label while processing |
| btw spinner | `src/ui/components/btw-overlay.tsx:14-21` | 4 quadrant frames, 120ms | `/btw` overlay, label `Answering…` |
| `useBrailleFrame` | `src/ui/ai-output/activity-status.tsx:25-33` | 10 braille frames, 80ms | **showcase only** |
| `Loader` | `src/ui/ai-elements/loader.tsx:9-23` | 4 circle frames, 150ms | **no importers** |
| `Shimmer` | `src/ui/ai-elements/shimmer.tsx:9-22` | cycling dots, 300ms | **no importers** |

### Observations

- `PromptModeLabel` (`src/ui/components/prompt-bar.tsx:71-100`) swaps the mode label for `PromptLoadingBoxes` while processing. **In the default layout this is the only motion on screen during a turn.**
- All progress labels are static strings: `Thinking...`, `Waiting...`, `Stopped`, `Answering…`, `Working`. There are no dynamic verbs derived from the current action, except the tool verb in the claude-code status line.
- No token-rate counter anywhere. No elapsed counter outside the claude-code status line, the subagent popup and the block-list Thought rows.
- `src/ui/ai-output/steps.tsx:1-5` and `src/ui/ai-output/chain-of-thought.tsx:1-4` both record that animated variants were dropped during the termcast port "to keep the port lean".

---

## 8. Toasts, queue banner, pending messages, interrupt bar, copy flash, btw

### Toasts — `src/ui/context/toast-context.tsx`

- `pushToast` (`:34-43`), default timeout **4000ms**, auto-removed by `setTimeout`.
- `ToastStack` (`src/ui/components/toast-stack.tsx:4-53`) renders absolute at `right: 2, top: 1, zIndex: 600`, width capped at 60. Style-coded icon and accent: `✗` red for failure, `✓` green for success, `•` accent otherwise.
- Mounted at `src/ui/app.tsx:481`.
- **The only producer in the entire repo is `src/core/plugins/loader.ts:446` (`sinks.toast`).** Core turn machinery, errors, retries and subagent completions never raise a toast.

### Copy flash — `src/ui/components/copy-flash-banner.tsx:3-31`

Absolute banner, `✓ Copied to clipboard`, `zIndex: 500`.
Triggered by `copyTuiSelectionToHost` (`src/ui/context/toast-context.tsx:49-59`) on mouse-up over a selection; `copyFlashId` self-clears after **2000ms** (`:65-69`). Mounted at `src/ui/app.tsx:480`.

### Queue surfaces

- `QueueBanner` (`src/ui/components/queue-banner.tsx:19-77`), **opencode only**. Shows each queued message with `▸`/`→`, then a hint row that varies by focus and count: focused, unfocused-single, unfocused-multi.
- `ClaudeCodePendingMessages` (`src/ui/components/claude-code-pending-messages.tsx:57-70`), **claude-code only**. Dimmer strip: `• #1 <text>`. No hint row.
- `buildQueuedPreviewText` (`:28-44`) rewrites paste and image tokens for display.
- Queue depth also surfaces in the claude-code context count as `+N`.

### InterruptBar — `src/ui/ai-output/interrupt-bar.tsx:67-124`

Renders label, `(elapsed • hint)`, a `hintRight` slot, and chip-style action pills. `makeExampleInterruptBar` (`:126-139`) shows `Stop (esc)`, `Retry (r)`, `Continue (c)`.
**No importers outside the showcase.** The header comment at `:7-11` records the 2026-05-16 redesign.
The `hintRight` slot was built for a "↓ new messages" indicator. That indicator is now orphaned: `src/ui/components/message-list.tsx:859-880` still computes `hasNewMessages`, but `onHasNewMessagesChange` is never passed by `session-route`, so line 876 early-returns. The comment at `:1075-1077` still points at an `app.tsx` `hintRight` that no longer exists.

### BtwOverlay — `src/ui/components/btw-overlay.tsx:23-65`

Three states: `loading` (spinner + `Answering…`), `done` (markdown answer), `error` (red text). Shows `esc dismiss` once settled.
Reaches the UI through `trailingSlot` at `src/ui/routes/session-route.tsx:519-521`, so it scrolls with the transcript.

### FpsOverlay — `src/ui/components/fps-overlay.tsx:47`

Live FPS, paints/sec, frame time and the renderer's live-request count. Mounted at `src/ui/routes/modal-layer.tsx:656`, gated by `render.fpsOverlay` (default off).

---

## 9. Plan and todo display

### PlanUpdate — `src/ui/ai-output/plan-update.tsx:37-66`

Title (default `"Updated Plan"`), optional summary, then rows with `PLAN_ICON`: `pending: "□"`, `in_progress: "◌"`, `completed: "✓"`. In-progress rows are bold; pending rows are muted.
**No counts, no `N/M`, no percentage, no progress bar.**

### Data source

`src/ui/hooks/use-turn-engine.ts:248-291`.

- Mirrors the Claude Agent SDK `TodoWrite` tool's `input.todos` **at tool-call time**, with no round-trip through the tool result.
- Status normalisation at `:274-280` accepts `completed|done`, `in_progress|active|running`, else pending.
- `:281-286` prefers the SDK's present-tense `activeForm` for the in-progress row, so the panel reads like a live status rather than a static checklist.
- **`:289-290` sets the plan to `null` when every item is complete.** The finished checklist is never shown.
- **`TodoWrite` is the only producer.** Providers with their own todo mechanisms surface nothing.

### Render sites

- Pinned top slot, both layouts: `src/ui/routes/session-route.tsx:346-359`.
- Floating right-justified panel in claude-code: `src/ui/layouts/claude-code.tsx:82-96`, toggled by the composer icon at `src/ui/components/prompt-box.tsx:128-132`, visible only when `hasTodos`.

### PlanView and PlanQuestionsPanel — `src/ui/plan.tsx`

- `PlanView` (`:13`) renders a plan tool result in the transcript.
- `PlanQuestionsPanel` (`:98`) renders interactive plan questions above the composer, driven by `showPlanPanel` and `planQuestions`.
- `src/ui/hooks/use-plan-actions.ts:17-54` — `dismissPlan` and `submitPlanAnswers` both clear plan, todos, roster and questionnaire together. `submitPlanAnswers` takes an `answersOverride` because the closure cannot see a `setPqs` scheduled in the same tick (`:25-31`).

### Questionnaire

`QuestionnaireTabs` in `trailingSlot` (`src/ui/routes/session-route.tsx:401-432`). Answering every tab auto-submits an `Answered:\n- …` follow-up message. Fed by `ask_user_structured` (`src/ui/hooks/use-turn-engine.ts:296-310`) or the SDK's native questionnaire chunk (`:317-330`).

---

## 10. Errors, retry, fallback, compaction, rate limits

This is the thinnest area in the UI.

- **`src/ui/hooks/use-turn-engine.ts:392-398`** — an `error` chunk sets `turnHadError`, then does `contentAccRef.current += "\n" + chunk.content` and `setStreamContent(...)`. **The error becomes assistant prose.** No icon, no colour, no separate surface.
- **`src/ui/hooks/use-turn-engine.ts:415-424`** — thrown errors take the same path; the stack goes to `console.error`, invisible in the TUI.
- **`src/ui/hooks/use-turn-engine.ts:436-437`** — the sole exception. Auth errors set an API-key error string and open a modal.
- **`src/ui/hooks/use-turn-engine.ts:459-464`** — dispatch failures are swallowed to `console.error`; `TurnAbandonedError` is ignored by design.
- **Rate limits:** `src/agent/turns/helpers.ts:430-434` maps `429` to "Rate limit exceeded. Please wait a moment and try again.", `503`/`529` to overload text. These arrive through the same plain-text path.
- **Provider stalls:** `src/core/plugins/native/claude-agent-provider.ts:1021` produces "Provider stream stalled — no activity for Ns…". Again plain text.
- **Retry:** no UI. Nothing in `src/ui` offers a retry action. `src/grok/batch.ts:360-362` retries rate limits silently at the transport layer with no UI signal.
- **Compaction: no UI at all.** `src/agent/compaction.ts` exposes only message-level helpers (`createCompactionSummaryMessage:273`, `isCompactionSummaryMessage:280`, `getCompactionSummaryText:286`). Nothing notifies the transcript, the status line or the context meter that history was rewritten.
- **Fallback / adaptive routing:** `learning.adaptiveModelRouting` (`src/ui/feature-flags.ts:80-86`) claims "When it overrides your selected model, it says so inline", but the flag defaults off and the inline notice is not a dedicated UI surface.

---

## 11. Turn-end summary

**There is none.**

- No files-changed list, no tools-run count, no token usage, no turn duration is displayed at any point after a turn completes.
- The only per-turn instrument is `cacheStatsLine`: read at `src/ui/routes/session-route.tsx:139` via `useMemo` keyed on `isProcessing` so it refreshes on turn boundaries, and rendered **only** in the claude-code title bar (`src/ui/components/claude-code-title-bar.tsx:68-72`). Its doc comment at `:37-40` explains the reading: large `read` with small `written` is healthy.
- **`sessionRecap` is dead UI state.** Declared at `src/ui/context/conversation-state-context.tsx:46-47`, initialised at `:102`, written at `src/ui/hooks/use-turn-stream.ts:305`, `src/ui/hooks/use-session-lifecycle.ts:130` and `src/ui/hooks/modal-actions/use-sandbox-wallet-actions.ts:84`. **No component reads it.**
- The only turn-end UI is follow-up suggestions: `src/ui/routes/session-route.tsx:386-398` via `deriveFollowupSuggestions`, rendered in `idleSuggestionsSlot` and hidden while processing (`src/ui/components/message-list.tsx:1069`).
- `finalizeActiveTurn` (`src/ui/hooks/use-turn-stream.ts:269-331`) commits the final assistant entry, rebuilds the transcript from the DB, and calls `clearLiveTurnUi`. It knows `wasInterrupted` and `hadError` but surfaces neither.

---

## 12. Feature flags

`src/ui/feature-flags.ts:32-94`. Resolution order is settings store → env var → default (`:124-137`); flags mirror to `process.env` on set (`:140-146`).

| Flag | Default | What it gates |
|---|---|---|
| `sessions.scope.global` | off | sessions list scope |
| `render.thinkingBlock` | **on** | pinned live reasoning block |
| `render.reasoning.liveChainOfThought` | off | ChainOfThought instead of ThinkingBlock |
| `render.liveTools` | **on** | live tool chips and subagent/delegate cards |
| `render.toolCalls.panel` | off | `◆` block rows; also the only way to see live tools in claude-code |
| `render.toolChips.dim` | **on** | subdued chip colours |
| `render.virtualMessages` | **on** | transcript virtualization |
| `learning.adaptiveModelRouting` | off | learned per-turn model routing |
| `render.fpsOverlay` | off | FPS / paints / frame-time overlay |

All are threaded through `getFeatureFlag` props on `MessageList` at `src/ui/routes/session-route.tsx:338-344`.

**Note:** `render.toolCalls.panel` does double duty. In opencode it only changes chip styling, but in claude-code it is the *on/off switch* for seeing live tool rows at all (`src/ui/components/message-list.tsx:1050`). That coupling is not described in the flag's own text.

---

## 13. TODO / FIXME / stubbed components

- `src/ui/running-agents.tsx:12` — "exposes a typed `liveTranscript` prop wired to nothing".
- `src/ui/running-agents.tsx:267` — "FUTURE LIVE-STREAM SEAM — wired to nothing today."
- `src/ui/ai-output/thinking-block.tsx:4` — "grok's existing ShimmerText / LoadingSpinner can be wired in later if we decide the static look is too plain."
- `src/ui/ai-output/image-viewer.tsx:88` — "(terminal graphics preview not wired; see renderPreview prop)".
- `src/ui/components/message-views.tsx:296` — "auto-open logic can be added back later if needed".
- `src/ui/components/message-list.tsx:1075-1077` — comment points at an `app.tsx` `hintRight` indicator that no longer exists.
- Undocumented dead paths found by inspection: `durationMs` never populated; `SessionHeader` `sessionTitle`/`sessionId` always `null`; `onHasNewMessagesChange` never wired; `sessionRecap` never read; `ParallelAgents.tools` never set in the live projection.

---

## Top 10 gaps, ranked by user impact

1. **The default layout has no progress surface at all.**
   `registry.ts:11` makes `opencode` default, and `session-route.tsx:530` gates the entire status line on `claude-code`. Default users get no elapsed time, no current-action readout and no clickable cancel. The only motion is three animated blocks in the footer.

2. **No tool timing and no partial tool output.**
   A three-minute `bash` is visually identical to a three-millisecond one. Output appears only on completion (`use-turn-stream.ts:223-248`). This is the single largest "is it stuck?" driver.

2b. **Concurrent tools disappear when the first one finishes.**
   `appendLiveToolResult` clears the whole `activeToolCalls` array and the batch timestamp on every single result (`use-turn-stream.ts:243-244`), while results arrive one per tool (`use-turn-engine.ts:331-336`). With three tools in flight, the first completion blanks all three chips and drops the status line back to `Waiting...`. This is a correctness gap, not a styling one, and it makes parallel work look like a stall.

3. **`durationMs` is rendered in three places but never populated.**
   `tool-calls.tsx:116-120, 499-501` and `tool-call-block-list.tsx:283` all display it; `message-list.tsx:959-966, 1191-1200` never set it. A finished-tool duration is one field-assignment away and currently impossible to see.

4. **Errors are indistinguishable from assistant prose.**
   `use-turn-engine.ts:397` concatenates rate limits, stalls, provider crashes and unexpected exceptions into the streaming text buffer. The user cannot tell a model's answer from a transport failure.

5. **No turn-end recap of any kind.**
   `sessionRecap` is computed and stored in three places and read by nobody. There is no files-changed, tools-run, tokens or duration summary.

6. **Subagents are opaque while running.**
   The footer shows a bare count. The inline agent has no elapsed (`use-running-agent-rows.ts:148-155` omits `startedAt`), delegations produce no output until completion, and the tool-count column is always blank.

7. **"Thinking..." does not mean thinking.**
   `claude-code-status-line.tsx:47` sets that phase when assistant *text* is streaming. Real reasoning has no elapsed readout anywhere, and committed reasoning always reads `Thought for a moment` because `message-list.tsx:242` passes no duration.

8. **The completed checklist is never shown.**
   `use-turn-engine.ts:290` nulls the plan once every item is `completed`. The comment block at `:248-252` frames this as deliberate, so it is a UX gap rather than a defect: there is no terminal "all done" state for a todo list, only its sudden absence.

9. **Compaction is completely invisible.**
   Context can be silently rewritten mid-session with no transcript entry, no status-line signal and no mark on the context meter. The user sees only an unexplained drop in the token count.

10. **The best-built progress widgets are unreachable.**
    `ActivityStatus` has an animated spinner, elapsed and an `esc to interrupt` hint. `InterruptBar` has stop/retry/continue pills and a `hintRight` slot. `Steps` has counts, per-step durations and a progress bar. `TaskInspector` has running/blocked/error states and control pills. None of these render during a live turn.

---

## Unused and dead components

### No importers outside `showcase.tsx` and the web parity fixture

- `src/ui/ai-output/interrupt-bar.tsx` — `InterruptBar`
- `src/ui/ai-output/activity-status.tsx` — `ActivityStatus`
- `src/ui/ai-elements/shimmer.tsx` — `Shimmer`
- `src/ui/ai-elements/loader.tsx` — `Loader`
- `src/ui/ai-output/image-viewer.tsx` — `ImageViewer`

### Used, but never for agent progress

- `src/ui/ai-output/steps.tsx` and the `ToolCalls` list export from `tool-calls.tsx` — both consumed only by `src/ui/ai-output/file-navigator.tsx`.
- `src/ui/ai-output/task-inspector.tsx` — rendered only for a **finished** `task` result at `src/ui/components/message-list.tsx:280-291`, always with `status: "done"` and no `controls`. Its `running` / `blocked` / `error` states, its `elapsed` pill and its control pills never execute.

### Dead fields and props on live components

- `ToolCallRecord.durationMs` — display-only, never assigned for real calls.
- `SessionHeader` `sessionTitle` / `sessionId` — `opencode.tsx:108` hardcodes both to `null`.
- `MessageList.onHasNewMessagesChange` — never passed; `message-list.tsx:876` always early-returns.
- `ConversationState.sessionRecap` — written in three places, read nowhere.
- `ParallelAgentStep.tools` — never set by `runningAgentRowsToParallelAgents`.
- `RunningAgentModalProps.liveTranscript` — documented as wired to nothing.
