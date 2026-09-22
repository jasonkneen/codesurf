# CodeSurf Agent source review

Date: 2026-09-05. Reviewer: GPT-6 Astra (Leo). No product implementation or executable regression was performed; implementation remains reserved for the owner's requested Spark model. Findings below are source-confirmed execution paths unless explicitly labeled an investigation. Existing three UI turn-preparation/transcript/stale-accumulator races remain in the main migration plan and are not counted as new findings here.

## Exact coverage

Every non-`*.test.*` file under `src/agent` was fully read, including the 2,937-line owner. There are 24 such files, 7,590 lines in the inspected checkout; one is explicitly a test helper rather than production behavior.

| Fully read file | Lines | Scope |
|---|---:|---|
| `src/agent/agent.ts` | 2937 | Entire file: construction, prompts, state, lifecycle, sinks, tools, tasks, delegation, compaction, verification and turns |
| `src/agent/agent-helpers.ts` | 123 | JSON/activity/recap formatting and timeout signal composition |
| `src/agent/compaction.ts` | 557 | Estimation, cut boundaries, serialization and summarizer calls |
| `src/agent/delegations.ts` | 588 | Child start/termination, persistence, notifications, retention and path handling |
| `src/agent/fabrication-detector.ts` | 94 | Claim heuristic and warning rendering |
| `src/agent/loop-guard.ts` | 149 | Deduplication, cycle detection and ToolSet wrapping |
| `src/agent/mode-prompts.ts` | 127 | All static prompts |
| `src/agent/model-constraints.ts` | 17 | Tool capability prompt projection |
| `src/agent/reasoning.ts` | 64 | Reasoning filter and model-message sanitization |
| `src/agent/trace-collector.ts` | 157 | Step/usage aggregation, terminal trace writes and learning trigger |
| `src/agent/vision-input.ts` | 118 | Image discovery, local/remote resolution and message construction |
| `src/agent/turns/batch-turn.ts` | 273 | Entire batch main-turn state machine |
| `src/agent/turns/helpers.ts` | 421 | Entire conversion/error/usage helper module |
| `src/agent/turns/session-turn.ts` | 514 | Entire owning-provider event queue and terminalization |
| `src/agent/turns/stream-turn.ts` | 452 | Entire direct stream state machine |
| `src/agent/turns/types.ts` | 119 | Entire observer and TurnContext contracts |
| `src/agent/routing/classify.ts` | 20 | Complete query classification |
| `src/agent/routing/complexity.ts` | 155 | Complete heuristic scoring and token suggestions |
| `src/agent/learning/learned-router.ts` | 97 | Complete model ranking |
| `src/agent/learning/self-learning.ts` | 235 | Complete logs, notes, state and refresh policy |
| `src/agent/learning/skill-discovery.ts` | 84 | Complete sequence mining |
| `src/agent/learning/skill-optimizer.ts` | 157 | Complete attribution/example mining and storage loop |
| `src/agent/learning/skill-overlay.ts` | 67 | Complete overlay persistence/loading |
| `src/agent/mock-bash-sink.ts` | 65 | Explicitly test-only helper; read but not counted as production runtime |

Partial files in this bounded directory: none. Test files: selective corroboration only, not exhaustive review. Adjacent partial reads used to establish contracts: `src/core/extensions/native/file-tools.ts:35-158`, payments-tool `needsApproval` registration around `163-188`, and references to verification preparation and UI title invocation. The separately completed tools/LSP report covers the file helper behavior relied on below. No claim is made that provider SDK internals, storage internals, hooks or the whole UI were completely reviewed in this pass.

## Findings and regression requirements

### A1 — P1: Compaction updates the owner but sends the old transcript

**Implementation status (2026-09-05, resumed in Claude Code):** repaired. `TurnContext.messages` (captured array) is replaced by `getMessages()` (live read) in `src/agent/turns/types.ts`; `stream-turn.ts`, `batch-turn.ts` and `session-turn.ts` read it after the compaction point, immediately before building each request. Regression: `src/agent/turns/turn-context-messages.test.ts` forces compaction that replaces the array and asserts the streamText and batch requests carry the summary plus retained suffix, not the dropped prefix.

`agent.ts:1921-1923` constructs TurnContext with a captured `messages: this.messages`. `compactForContext:2594` later replaces the Agent array. Both `turns/stream-turn.ts:47-57,77` and `turns/batch-turn.ts:53-60,124` await compaction then read the captured `ctx.messages`, so the current API request still receives the original oversized history. The overflow retry uses that same context and can send it again even after another successful compaction. Storage/context-meter state may meanwhile reflect the smaller history.

Repair: a live `getMessages()`/getter or immutable per-run state transition returned by compaction; ensure the request reads the resulting state. Regression: force compaction and assert the actual streamText/batch request contains the checkpoint and retained suffix, not the dropped prefix. Repeat for overflow retry and verify persisted/in-memory/request transcripts agree.

### A2 — P1: Batch execution bypasses tool approvals and input validation

**Implementation status (2026-09-05, resumed in Claude Code):** repaired. `prepareBatchToolInvocation` (`src/agent/turns/helpers.ts`) parses, validates against the tool's `inputSchema` via `safeValidateTypes`, and evaluates `needsApproval` (boolean or function) before `execute`; `Agent.executeBatchToolCall` uses it and refuses approval-required calls with an explicit failed result (batch approval continuation is not implemented, so the call is rejected rather than silently executed). Regression: `src/agent/turns/batch-tool-invocation.test.ts`.

`agent.ts:1578-1629`, `executeBatchToolCall`, JSON-parses input and calls `tool.execute` directly. It never evaluates `needsApproval` or validates the declared input schema. Both main batch turns and batch subagents use it. File tools and paid requests declare approval requirements, so switching to batch mode can execute an operation that the direct SDK path would stop for approval. JSON parse success alone does not establish valid tool input.

Repair: a shared tool-execution boundary implementing schema validation, permission/approval decisions, cancellation and result normalization. If batch approval continuation is not implemented, reject approval-required calls clearly; do not silently execute. Regression: ask-always file edit and approval-required payment never invoke execute before approval; invalid schema input fails without effects; equivalent allowed calls work in stream/batch/task paths.

### A3 — P1: MCP connect completion can resurrect a disposed session bundle

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/agent.ts`. The MCP bundle carries a session generation: `closeMcpBundle` bumps it and awaits the in-flight connection, a connect that resolves under a stale generation closes its own bundle instead of publishing it, and the promise field is cleared only by the attempt that owns it. Regression: `src/agent/agent-mcp-bundle-lifecycle.test.ts` (`MCP bundle lifecycle across reset and cleanup (A3)`).

`agent.ts:866-879` caches a promise whose `then` unconditionally assigns `this.mcpBundle`. `closeMcpBundle:885-895` clears both fields but neither awaits nor invalidates an in-flight connection. Session reset or cleanup during connect can therefore return, after which the old promise publishes a live bundle into the new session or after teardown. A second connect can race with the old `finally`, which unconditionally nulls the promise field and can erase the new attempt's ownership.

Repair: session generation/token, identity-checked promise cleanup, and awaited disposal of late bundles. Shutdown closes admission before taking snapshots. Regression: deferred old connect across reset/cleanup, new connect before old completion, old rejection and multiple concurrent callers; no old bundle survives or overwrites the replacement.

### A4 — P1: Compaction's token estimate truncates the data it is supposed to measure

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/compaction.ts`. `estimateMessageTokensUncached` no longer reuses the lossy summary extractors: new `estimateToolResultTokens`/`estimateUserContentTokens` size the complete serialized tool output at ~4 chars per token and charge image and media parts a flat `IMAGE_PART_TOKEN_ESTIMATE`, while `serializeConversation` keeps its 2,000-character truncation for the summarizer only. A 1 MB tool result now estimates ~250,000 tokens instead of 510, so compaction fires on large-output turns and the `/context` meter reports higher usage for tool- and image-heavy sessions. Regression: `src/agent/compaction.test.ts` (`wire-size token estimates (A4)`).

`compaction.ts:185-191` produces tool-result summary text capped at 2,000 characters. `estimateMessageTokensUncached:244-245` reuses this summary extractor, so a very large tool output is estimated from the short summary rather than the full output sent to the model. A 1 MB tool result can contribute roughly hundreds of estimated tokens while its wire content is much larger. This can suppress compaction, mislead the context meter and defeat cut-point budgeting independently of A1.

Repair: separate wire-size/token estimation from lossy summary serialization. Use a conservative estimate over complete transmitted content, plus appropriate image/file costs or explicit uncertainty. Regression: increasing a tool result beyond 2,000 characters must keep increasing the estimate; request-sized fixtures cross the compaction threshold and retain an appropriate suffix.

### A5 — P2: Owning-provider Edit approvals lose their diff preview

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/turns/session-turn.ts`. A typed per-shape adapter maps the SDK's `file_path`/`old_string`/`new_string` input onto `computeEditPreview` without a suppressing cast, the original input is preserved for execution, and MultiEdit with more than one edit (or `replace_all`) explicitly reports an unsupported preview instead of silently previewing one edit. Regression: `src/agent/turns/session-turn.test.ts` (`adaptProviderEditApproval (A5)`, `owning-provider approval previews (A5)`).

`turns/session-turn.ts:327-328` adapts SDK input into `old_str`/`new_str`, but `computeEditPreview` accepts `old_string`/`new_string`. The type assertion conceals the mismatch. Edit requests therefore fall back to a generic approval instead of showing the intended change. MultiEdit is also classified as a single edit without adapting its edit array.

Repair: a typed adapter per provider tool shape, without a suppressing cast; preserve the original input for execution and derive a faithful preview. Regression: SDK Edit and native edit_file produce expected patch, Write remains correct, and MultiEdit either previews all edits or explicitly identifies the unsupported preview.

### A6 — P2: Loop-guard serialization drops nested argument fields

**Implementation status (2026-09-05, resumed in Claude Code):** repaired. `stableStringify` in `src/agent/loop-guard.ts` canonicalizes recursively (sorted keys at every depth, arrays and nulls preserved, circular input falls back to `String()`). Regression: `src/agent/loop-guard.test.ts` (`stableStringify`).

`loop-guard.ts`, `stableStringify`, calls `JSON.stringify(value, Object.keys(value).sort())`. An array replacer is a property whitelist at every object depth, not just top-level key ordering. Inputs such as `{config:{x:1}}` and `{config:{x:2}}` both become `{"config":{}}`; legitimate distinct structured tool calls can be blocked as repetition after three invocations.

Repair: recursive canonical serialization preserving every nested key/value and array order. Regression: reordered equivalent nested objects share a key, changed nested values have different keys, arrays/nulls are preserved and circular/unsupported inputs have explicit fallback behavior.

### A7 — P2: Learning refresh permanently stops when the trace window saturates

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/learning/self-learning.ts`. The refresh gate now persists a monotonic trace watermark (the newest trace id/timestamp seen) instead of comparing the length of a capped `listTraces` window, so refresh continues at its intended cadence once the window is full, and the watermark resets when the store is cleared. Regression: `src/agent/learning/self-learning.test.ts` (`maybeRefreshLearningArtifacts watermark (A7)`).

`learning/self-learning.ts:203-206` compares the length of `listTraces({limit:200})` with persisted `lastTraceCount`, requiring eight new entries. Once the list is full, its length cannot advance. Refresh stops even though new traces replace older entries; depending on the last refresh count it can stop just before the count reaches 200.

Repair: persist a monotonic trace watermark or cumulative count, independent of sample-window size; scope/reset the watermark for store changes. Regression: more than 220 traces, continuously changing recent results, deleted/reset store and unchanged history; refresh continues at the intended cadence without per-turn rescans.

### A8 — P2: Subagent depth and concurrency accounting mix siblings with ancestors

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/agent.ts`. The concurrency slot is reserved synchronously before any await and released in `finally`, and depth travels in an immutable per-execution context rather than a shared mutable counter, so simultaneous starts cannot exceed the advertised cap and sibling tasks no longer inflate each other's depth. Regression: `src/agent/agent-subagent-admission.test.ts` (`sub-agent admission (A8)`).

`agent.ts:2108-2123` checks shared `subagentDepth` and `inFlightSubagents`; both increment only at `2227-2228`, after awaited verification preparation/model resolution. Concurrent starts can all pass admission before reservation, exceeding the advertised cap. `subagentDepth` lives on the same root Agent for every nested/sibling request, so two active sibling tasks can make a third top-level task look too deeply nested even though its true depth is one.

Repair: reserve concurrency synchronously before awaits; carry immutable ancestry/depth in each execution context and release its own reservation in finally. Bind nested task tools to that context. Regression: simultaneous starts at/over cap, siblings versus nested chains, failed preparation and cancellation before runtime resolution; depth and slots remain accurate.

### A9 — P2: Verification ignores Agent.abort when an external signal is supplied

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/agent.ts`. Verification composes the caller's signal with its own controller (`AbortSignal.any`) instead of choosing one, tracks the owned controller separately, and clears it by identity, so `Agent.abort()` cancels verification even when an external signal was supplied and a stale run cannot uninstall a replacement's controller. Regression: `src/agent/agent-verify-abort.test.ts` (`runVerify abort composition (A9)`).

`agent.ts:2913-2915` creates `this.abortController`, but chooses `abortSignal ?? this.abortController.signal`. When the caller supplies a signal, `Agent.abort()` aborts the unused internal controller, leaving orchestration active. The finally identity check then fails, leaving the unused controller installed after completion.

Repair: compose external and owned signals, track the owned controller separately, and clear by controller identity. Regression: external signal present while Esc invokes Agent.abort, external cancellation alone, successful completion and stale run cleanup after replacement.

### A10 — P2: Title/recap results can be written to a different session

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/agent.ts`. Title and recap generation capture the session identity at request start and write only if that session is still current, discarding the result (and its usage) otherwise, so a slow title for session A can no longer overwrite session B's. Regression: `src/agent/agent-session-identity.test.ts` (`title/recap results stay with the requesting session (A10)`).

`agent.ts:1065-1071` and `1392-1415` generate data across awaits, then use the current mutable `this.session.id` to record usage and title/recap. Switching sessions while generation is pending can apply old-session content and costs to the new session. Title generation is launched asynchronously by the UI, so the caller does not keep session identity stable for this method.

Repair: capture session/store identity and generation at request start; either persist to that original still-valid session or discard stale work. Regression: delayed title/recap for A, switch to B, resolve A; B must keep its title/recap/usage untouched.

### A11 — P2: Provider event queues outlive an abandoned consumer

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/turns/session-turn.ts`. The turn owns an explicit effect scope: the abort listener is removed in an unconditional `finally`, a disposed flag makes late `emit` calls no-ops, and the event queue is drained by cursor with a bound instead of repeated `shift()`, so a consumer that returns early or a synchronous `sendTurn` throw still releases listener and queue ownership. Regression: `src/agent/turns/session-turn.test.ts` (`provider event queue scope (A11)`).

`turns/session-turn.ts` adds an AbortSignal listener and a provider emit callback closing over an array queue. Listener removal appears in normal terminal branches, but not an inner finally; the outer finally only clears the current session pointer. If the consumer calls `return()` at a yielded chunk, or sendTurn throws synchronously, cleanup branches are skipped. The provider may continue pushing events into an unconsumed queue; even normal cancellation does not prevent later emits. `queue.shift()` also repeatedly moves array contents under a bursty producer, and there is no bound/backpressure contract.

Repair: explicit turn effect scope with unconditional listener removal, disposed flag checked by emit, cancellation/awaited provider ownership, and a bounded queue or cursor-based draining. Regression: consumer return after first text/tool chunk, synchronous sendTurn throw, late events after cancellation and a large fast event burst; listener/queue/process ownership returns to baseline.

### A12 — P2: Delegate startup's final write can overwrite child completion

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/delegations.ts`. `start()` no longer writes a pre-spawn record and then rewrites it: the job path stays an empty reservation until after spawn and the parent publishes the record exactly once with the pid merged in, so a child that completes or fails first owns every later write. `loadDelegation` treats an empty job file as a pending launch handshake and polls it briefly. Regression: `src/agent/delegations.test.ts` (`launch handshake (A12)`).

`delegations.ts:130` writes a running job, spawns at `134`, then writes the original running record with PID at `170`. A sufficiently fast child (or async error handler at `162`) can write terminal status between those steps. The final parent write then restores `running`, losing completion/error metadata. Atomic rename protects readers from partial JSON, but does not prevent this lost update.

Repair: launch handshake and single-owner state transitions or compare-and-swap merge of PID into the latest record. Regression: mocked child completes/fails before delayed parent PID write; terminal status and output reference remain intact and exactly one completion notice is delivered.

### A13 — P2: Delegation termination retains completed PIDs and lacks a completion boundary

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/delegations.ts`. Ownership is a set of entries bound to each child's `exit`/`error` events, so an exited process leaves the set immediately and its pid is never signalled after reuse; `killStarted()` returns one shared in-flight promise that sends SIGTERM to each still-owned process group, waits, escalates to SIGKILL and joins concurrent callers, and `Agent.cleanup()` awaits it. Regression: `src/agent/delegations.test.ts` (`ownership and termination (A13)`).

`delegations.ts:67,80-88,169` stores numeric PIDs but never removes them on process exit. Later cleanup can signal a reused PID belonging to an unrelated process. TERM is fire-and-forget and the entire set is immediately cleared, losing the ability to escalate or join a stubborn owned child. This is the delegation-specific counterpart of the process-tree/PID ownership findings in the tools report.

Repair: retain ChildProcess/control-channel ownership, remove exited instances, verify identity, and await bounded tree termination. Regression: successful completed child removed from ownership, PID reuse fixture not signalled, stubborn child escalated and cleanup joins concurrent callers.

### A14 — P2: Skill attribution matches every skill when the read path is just SKILL.md

**Implementation status (2026-09-05, resumed in Claude Code):** partially repaired in `src/agent/learning/skill-optimizer.ts`, `skill-overlay.ts` and `src/agent/agent.ts`. Attribution compares whole normalized paths instead of suffix-matching, resolves a relative read against the trace session's recorded cwd, and ignores failed steps; overlays gained a `source` (absolute SKILL.md path), are stored per source hash, and `loadSkillOverlays(catalog)` selects only the overlay whose source matches that skill, so same-named skills in two projects stay isolated. Regression: `src/agent/learning/skill-optimizer.test.ts` (Bun-native: `bun test src/agent/learning/skill-optimizer.test.ts`). **Closed 2026-09-05.** The last gap — trace steps not recording the cwd each `read_file` resolved against — is repaired: `TraceCollector.onToolStart` now takes the session cwd read live at call start and stamps it into the step's `metadata` (no schema change; `metadata_json` already existed), `agent.ts` supplies it from `getCwd()`, and `attributeSkills` prefers a step's own recorded cwd over the trace-level one, falling back for steps written before this existed. A relative SKILL.md read is therefore attributed correctly even when the model `cd`s later in the same turn. Regression: `skill-optimizer.test.ts` ("prefers the cwd the step itself recorded", "falls back to the trace cwd") and `trace-collection.test.ts` (the persisted step carries the session cwd).

`learning/skill-optimizer.ts:35-36` matches either path as a raw suffix of the other. A recorded relative read `SKILL.md` matches every discovered skill's full path, so one successful trace can seed unrelated skill overlays. Current processing reads global traces, while overlay storage is keyed only by skill name; distinct workspace-local skills with the same name can overwrite/share examples.

Repair: preserve trace workspace and canonical skill identity; resolve relative reads against their actual execution cwd, then compare normalized paths with path boundaries. Scope overlays by stable skill identity/source, with explicit policy for intentional sharing. Regression: basename-only read in one skill directory attributes only that skill; same-name skills from two projects remain isolated, including preview/failed reads.

## Additional source findings and investigations

- `turns/stream-turn.ts:257-267` yields SDK error events without making terminal success impossible. After partial text and failed response finalization, salvage at `324-330` leads to `emitTurnStop`, so a visible failed stream can train as success. Add an explicit failed terminal state that can retain partial content. Reproduce with a mock stream emitting text then error and a rejected response; assert StopFailure and failure trace rather than Stop. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/turns/stream-turn.ts`: a stream that emitted text and then failed now reaches an explicit failed terminal state that retains the partial content, instead of being salvaged into `emitTurnStop` and trained as a success. Regression: `src/agent/turns/stream-turn-failure.test.ts`.
- `turns/batch-turn.ts:155-184` yields final content before committing and does not recheck signal before the no-tools success branch. Cancelling while the consumer holds that last content yield can still persist success; provider-session code explicitly guards this boundary. Add a suspended-generator regression for main batch success, last tool result and limit termination. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/turns/batch-turn.ts`: the signal is re-checked after the final content yield and before the no-tools success branch, so cancelling while the consumer holds that yield no longer persists a successful turn. Regression: `src/agent/turns/batch-turn-cancel.test.ts`.
- `agent.ts:1518-1554` queues notifications whenever `isProcessingTurn` is true, but `processMessage:2697` sets it before the supposed boundary drain. Newly received notifications are therefore unavailable to the current model turn; queued messages also survive session reset. Review intended immediate-versus-next-turn delivery and bind queue entries to session/workspace identity. This pass did not replay UI polling interleavings. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/agent/agent.ts`: the boundary drain now runs before `isProcessingTurn` is set, so a notification received during a turn reaches that turn's model input, and queue entries are bound to the session that received them and dropped on session reset. Regression: `src/agent/agent-session-identity.test.ts` (`background notification delivery`).
- `turns/helpers.ts:282-301` reconstructs a whole provider turn as one assistant message containing all text/tool calls followed by all tool results. Original text→tool→result→text order is lost on persistence/provider switching. Existing UI ordinal corruption is separate; add ordered event-to-transcript replay evidence before choosing a new representation.
- `agent.ts:2145-2150` awaits verification preparation with no cancellation channel. Adjacent inspection of `src/verify/entrypoint.ts:325-344` confirms its third parameter is a recipe override, not an AbortSignal, and preparation awaits checkpoint creation without a signal parameter. Thread cancellation through the actual preparation/checkpoint contract; do not simply replace that `undefined` argument with a signal. Runtime checkpoint interruption remains untested here.
- `learning/skill-optimizer.ts:131-153` synchronously scans up to 2,000 traces and their steps on refresh; `TraceCollector.finish` invokes it on the turn terminal path. Overlays store full unbounded query/result examples; `loadSkillOverlays` validates only the outer array. Profile realistic history and bound/sanitize serialized examples before prompt insertion. No latency improvement is claimed without measurement.
- `vision-input.ts:55-65` downloads the full remote image and then sends its original URL instead of downloaded bytes; this wastes download/memory when the provider independently fetches the URL. Local/remote image sizes/counts are unbounded and local reads synchronous. Choose URL pass-through or bounded byte acquisition according to provider support, preserving abort/errors; inspect attachment behavior with local-only/expiring URLs.
- `fabrication-detector.ts` treats any tool call as grounding and relies on action verbs. It does not establish that a claimed mutation happened, and historical explanations can trigger warnings. Treat it as a heuristic, never an evidence gate; structural tool outcomes and claim scope are the relevant follow-up design. Do not expand word lists as a substitute for state correctness.

## Existing boundaries worth preserving

Turn runners and pure helpers already exist; reuse them rather than re-extracting historical god-file work. Cancellation-neutral traces are excluded from learned routing/skill mining. MCP connection attempts already share a promise in the normal same-session case; repair its lifetime rather than removing sharing. Delegation records use atomic rename, exclusive IDs and notification claim files; preserve those properties while adding transition ownership. Model routing is opt-in and announces a changed model; model identifiers were not judged invalid by age or familiarity.

The remaining Agent owner combines prompt assembly, persistence, model/provider selection, tool approval continuation, MCP ownership, usage/trace learning, subagent admission, verification and global sink binding. Extract these as cohesive services with explicit run/session identity. Cordis effects can own each service's lifecycle, but cannot alone fix stale captured arrays, missing approval checks, lossy serialization or state-machine errors.

## Verification status

All findings here came from source reads. No regression fixture, provider call, shell exploit, subprocess kill, performance benchmark or live TUI check was run for this report. Run the stated deterministic tests with isolated storage/process fixtures under Spark, then the baseline build/lint/suites and relevant integration replays. The main migration plan, plugin inventory and separate tools/LSP report define the remaining cross-domain acceptance gates.
