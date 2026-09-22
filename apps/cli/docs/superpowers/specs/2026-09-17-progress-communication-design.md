# Progress and thinking communication — design

Date: 2026-09-17. Branch: `phase3/hub`. Status: approved via `/goal continue with all recommendations`.

## Problem

CodeSurf tells the user too little about what the agent is doing, for how long, and what it
did once it finished. Evidence came from three live captures (tmux, 1.5s frames) on the
owner's default path (claude-code layout, `anthropic.agent-sdk-claude-skills` adapter) plus
two code audits (`scratchpad/ui-surface-audit.md`, `scratchpad/engine-event-audit.md`).

Observed defects, in user-impact order:

1. The finished transcript rewrites history. Live rows show tool → text → tool in order; at
   turn end the view is rebuilt from the session store, which holds one merged assistant
   message per turn followed by all tool rows. Narration collapses into one paragraph and the
   segments join with no separator (`"Now running the test.Test runner is Vitest"`).
2. Status labels are inverted. Pre-first-token is "Waiting…", streaming text is "Thinking…".
   Only the first active tool is named. Elapsed restarts per tool batch.
3. Concurrent tools vanish when the first one finishes: every `tool_result` clears the whole
   active list and the shared start timestamp.
4. Finished tool chips never show a duration; `durationMs` is rendered but never populated.
5. Errors (rate limits, stalls, thrown exceptions) are appended to the assistant text buffer
   with no distinct styling.
6. No turn-end summary of any kind. `sessionRecap` is written and never read.
7. Reasoning shows no elapsed time; committed reasoning always reads "Thought for a moment".
8. The default `opencode` layout has no status line at all; the only motion is three
   animated blocks in the footer.
9. Subagents: the inline row has no elapsed, the roster never marks completion, live
   task/delegate cards are suppressed in claude-code mode.
10. Completed todo lists disappear instead of showing a done state.
11. Title bar: the cache/skills stats string clips the cwd. Footer renders "· ·" when an
    indicator slot is empty.
12. Composer placeholder says "esc to interrupt"; the real key is Ctrl+X.
13. A 400 from the provider prints only the generic status text. (The resumed session that
    produced this was pinned to the `codesurf:claude` adapter, which needs `CODESURF_API_KEY`;
    the fix here is message clarity, not that adapter.)
14. Compaction is invisible.

## Non-goals

- No deletion of dead components or props found by the audit (`InterruptBar`,
  `ActivityStatus`, `SessionHeader` title fields, `sessionRecap`). Removal is a separate ask.
- No streaming of partial tool stdout. That needs engine plumbing and is out of scope.
- No cost display. Pricing lookup per adapter is not uniformly available.
- No new layout. Both layouts share the existing status line.

## Design

### A. Live status line (both layouts)

Reuse `ClaudeCodeStatusLine`. Remove the `uiMode === "claude-code"` gate in the
`statusSlot` builder (`session-route.tsx`), so `opencode` gets the same line.

Phases, derived in `buildClaudeCodeStatusModel`:

| Phase | When | Label |
|---|---|---|
| `connecting` | processing, no reasoning, no text, no tool yet | `Waiting for model… 3s` |
| `thinking` | reasoning delta seen, no text since | `Thinking… 12s` |
| `writing` | text streaming (content non-empty) | `Writing… 4s` |
| `tool` | ≥1 active tool | `:: Run Bash \`cmd\`` plus `+2 more` when several |
| `stopped` | justStopped | `Stopped · 8s` |

Elapsed on the right is always time since turn start. In the tool phase the left side also
shows the head tool's own elapsed. Inputs gain `streamReasoning` (from the store) and a
`toolStartedAt` map; `activeToolStartRef` becomes `Map<toolCallId, number>`.

Composer placeholder becomes `Queue a follow-up… (ctrl+x to stop)`.

### B. Per-tool lifecycle

`appendLiveToolResult` removes only the completed id from `activeToolCalls`. Start times live
in `toolStartTimesRef: Map<string, number>` set in `showLiveToolCalls`. The tool-result entry
gets `durationMs` (new optional field on `ChatEntry`, UI-only), and `entryToChipRecord`
copies it into `ToolCallRecord.durationMs`, which the chips already render.

### C. Chronological persistence (owner's path)

`session-turn.ts` currently persists `[assistant(fullText + all tool calls), tool(all
results)]`. Change it to build one `[assistant, tool]` pair per tool round, mirroring what the
AI SDK path already stores via `response.messages`:

- keep `rounds: Array<{ text: string; toolCalls: ToolCall[]; toolParts: ExecutedBatchTool[] }>`
- text delta: append to the current round; if the current round already has results, open a
  new round first
- tool call: if the current round already has results, open a new round; push the call
- tool result: push into the current round
- completion: `rounds.flatMap((r) => buildProviderTurnMessages(r.text, r.toolCalls, r.toolParts))`

`buildChatEntries` then yields user → assistant(seg) → tool_result… → assistant(seg) in order
with no code change, live and on resume. Segment concatenation disappears because segments
are separate rows. `fullText` stays for the fabrication detector and `lastAssistantText`.

`reconcileRebuiltTranscript` pairs assistant rows by ordinal; the live side already flushes
text before each tool batch, so segment counts match. A regression test covers a two-round
turn.

### D. System rows: errors, stop, summary, compaction

Add `"system"` to `ChatEntry.type` with `systemKind?: "error" | "info" | "summary"`. UI-only
for now. Rendering in `MessageView`:

- `error`: `✗ ` red prefix, muted text, single line wrap.
- `info`: `· ` dim.
- `summary`: `✓ Done in 12.3s · 4 tools · 2 files changed · +1.2k tokens` dim, appended by
  `finalizeActiveTurn`. On interrupt: `■ Stopped after 8s · 2 tools`. On error the error row
  itself carries the elapsed.

Height estimation gets a `system` case (1–2 rows). `reconcileRebuiltTranscript` carries
`system` rows forward: they are excluded from ordinal pairing and re-inserted after the fresh
row that preceded them in `prev` (by index anchor). Test in `transcript-reconcile.test.ts`.

The `error` chunk in `use-turn-engine` no longer appends to the text buffer. It flushes the
pending assistant text (so ordering is kept) and pushes a `system/error` row. The thrown-error
path does the same. Auth errors keep their modal.

Compaction: if the engine signals it (see the engine audit), push a `system/info` row
`Context compacted · 120k → 40k`. If no signal exists, this item is deferred and noted.

Turn tokens: read `contextStatsRef` before and after the turn; show the delta when both are
known. `files changed` counts distinct paths from `write_file`/`edit_file` results in this run.

### E. Reasoning timing

`use-turn-engine` records `reasoningStartedAt` on the first reasoning delta and
`reasoningEndedAt` on the first content delta or turn end. The final assistant entry gets
`reasoningDurationMs`. `ThinkingBlock` header shows `◌ Thinking 4s` live (1s tick) and
`✓ Reasoned  12 lines · 8s` when done. Committed rows pass `duration` to `Reasoning` so the
trigger reads `Thought for 8s`.

### F. Subagents

- `use-running-agent-rows` sets `startedAt` on the inline row so the popup shows elapsed.
- Roster entries gain `status: "running" | "done" | "error"`; the `tool_result` for a
  `task`/`delegate` id flips it, and `AgentRoster` renders `✓`/`✗` next to done rows.
- Live task/delegate cards render in claude-code mode too (drop the `!compactLiveStatus`
  gate for the specials block only).

### G. Todo completion state

When every item completes, keep the plan visible with all `✓` and a `done` title until the
turn finishes; `finalizeActiveTurn` clears it.

### H. Chrome fixes

- Title bar: cwd box gets `flexShrink={0}`; stats box gets `flexShrink={1} minWidth={0}
  overflow="hidden"` so the stats truncate, not the path.
- Footer: build the right-hand items as a list and join with ` · ` so empty indicators do not
  leave a stray separator.
- `humanizeApiError`: when the status message is used, append the raw error message in
  parentheses if it adds information.

## Testing

Each slice extends the sibling test file: `claude-code-status-line.test.ts`,
`tool-calls.test.ts`, `transcript-reconcile.test.ts`, `session-turn.test.ts`,
`telegram-turn-ui.test.ts`, `use-running-agent-rows.test.ts`, `app.layout.test.ts`,
`claude-code-title-bar.test.ts`, `prompt-bar.test.ts`. Gates: `bun run typecheck`,
`bunx vitest run` on touched files, then the full suite, `bun run lint` on touched files, a
re-run of the tmux capture, and `bun run parity` because the DOM host renders the same
widgets.

## Deferred

Streaming tool stdout, cost, and per-provider reasoning parity are recorded in the engine
audit and not part of this change.

Notes from the 2026-09-17 implementation pass:

- The tmux capture gate was re-run on 2026-09-17 (script at
  `docs/superpowers/sessions/observe2.sh`; override `OUT=` if needed, default
  `/tmp/codesurf-observe-frames`). Confirmed live:
  status-line phase walk (Waiting → Thinking → `:: Run Bash` with per-tool clock → Writing,
  repeating per tool round), `✓ Done in 30.9s · 4 tools · +10.0k tokens`, and — via a
  resume-by-id boot — the persisted transcript rebuilt chronologically (4 interleaved
  assistant/tool rounds + final text, 21K context restored). One observation, pre-existing
  (`src/storage/` untouched by this change): `-s latest` boots to an empty session even when
  a later session has messages; resume by explicit id works.
- Deviations from the plan worth knowing: the status line is driven by a `streamPhase`
  slot rather than the plan's `providerStatus` string (same effect, simpler state); the
  trace `result` now concatenates every assistant segment of the latest turn in
  `lastAssistantText()` because Task 4's per-round persistence split what used to be a
  single assistant message (regression caught by `trace-collection.test.ts`).
- Pre-existing biome findings left alone (not introduced by this change):
  `turn-control.ts` unused import, `app.tsx`/`layouts/*` unused server-picker variables,
  `telemetry.ts`/`use-turn-stream.ts` import ordering.
