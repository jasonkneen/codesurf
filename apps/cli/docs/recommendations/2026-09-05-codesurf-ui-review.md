# CodeSurf UI targeted review — 2026-09-05

Reviewer: Hans / Astra. Product files were read only. This report expands the review; it does not certify the entire UI directory. Product implementation remains reserved for the requested Spark phase.

## Coverage

Complete production-file reads in this slice:

- `src/ui/stream-store.ts` — 95 lines.
- `src/ui/hooks/use-queue-actions.ts` — 64 lines.
- `src/ui/hooks/use-modal-guard-state.ts` — 168 lines.
- `src/ui/hooks/use-flushed-keyboard.ts` — 33 lines.
- `src/ui/hooks/use-composer-actions.ts` — 248 lines.
- `src/ui/hooks/usePromptHistory.ts` — 139 lines.
- `src/ui/hooks/use-plan-actions.ts` — 94 lines.
- `src/ui/hooks/use-composer-keys.ts` — 419 lines.
- `src/ui/hooks/use-ui-mode-restore.ts` — 54 lines.
- `src/ui/context/queue-context.tsx` — 53 lines.
- `src/ui/context/approval-context.tsx` — 105 lines.
- `src/ui/context/toast-context.tsx` — 84 lines.

These are 1,556 newly read production lines. `src/ui/transcript-identity.ts` (66 lines) was fully read in the earlier turn-lifecycle review, not newly credited here.

Partial reads only:

- `src/ui/components/message-list.tsx:730–977` — viewport polling tail, grouping, height estimates, prefix ranges, auto-follow and scrollbox setup. Earlier selected key/memo locations were searched. Not a complete component review.
- `src/ui/app.tsx` — searched wiring of composer/plan callbacks and capture guards; not a complete read.
- `src/ui/routes/modal-layer.tsx` — searched plan callback declarations and forwarding at 137–138 and 267–268; not a complete read.
- `src/ui/routes/modal-keys/use-complex-modal-keys.ts:167–210` — plan keyboard selection invocation.
- `src/ui/plan.tsx:324–345` — answer formatting; not the rendering component.
- `src/ui/app-helpers.tsx:58–76` — paste/file token format.

Earlier complete reads of `use-turn-engine.ts`, `use-turn-stream.ts`, and `use-session-lifecycle.ts` established the three prior turn defects already carried in the main plan: post-abort deferred preparation launch, ordinal transcript corruption after cancellation, and stale-run writes to a replacement accumulator. They are cross-referenced, not counted as new findings here.

**Implementation status (2026-09-05, resumed in Claude Code):** those three turn defects are repaired. Every abort path (Ctrl+X in `use-session-lifecycle.ts`, the input router, and queue send-now in `use-queue-actions.ts`) now calls `invalidateActiveRun` (`src/ui/hooks/turn-ownership.ts`), which bumps the active run id so the aborted run is stale; `processMessage` resolves deferred preparation through `resolveTurnInput` and never starts the agent once stale; the stale tail no longer clears the shared accumulator. Optimistic rows carry the producing `runId` (`ChatEntry.runId`), cancelled run ids are tracked in `cancelledRunIdsRef`, and the post-turn rebuild pairs rows through `reconcileRebuiltTranscript` (`src/ui/transcript-reconcile.ts`), which excludes cancelled rows before ordinal pairing. Regressions: `src/ui/hooks/turn-ownership.test.ts`, `src/ui/transcript-reconcile.test.ts`, `src/ui/app.layout.test.ts` (source-shape check updated).

## UI1 — P1: Deferred queue preparation can strand or reorder submitted messages

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/ui/hooks/queue-submissions.ts` and `use-composer-actions.ts`. A submission made while a turn is running reserves its id and queue position synchronously, in Enter order, and carries its still-pending mention expansion on the entry; whoever drains the slot forwards that preparation to `processMessage`, where `resolveTurnInput` awaits it under run ownership. A turn that finishes first therefore dispatches the queued message, two overlapping expansions keep Enter order, and a reset drops the slot instead of inserting into the replacement session. Regression: `src/ui/hooks/use-composer-actions.test.ts` (`UI1 — queued submissions reserve their slot before mention expansion`) and `src/ui/hooks/queue-submissions.test.ts`.

**Source evidence:** `src/ui/hooks/use-composer-actions.ts:198–208` checks `isProcessingRef.current` before awaiting mention expansion, then unconditionally appends to the queue after the await. It neither reserves the queue position synchronously nor rechecks processing/session ownership. The current turn drains an empty queue and clears processing in `use-turn-stream.ts:109–135`. Manual queue dispatch refuses an idle queue in `use-queue-actions.ts:21–23`.

**Scenario:** Submit B while A is running; defer B's mention expansion. A finishes while the queue is still empty. Resolve B's expansion: B appears queued, but nothing is processing and both normal finish-driven dispatch and manual send-now are unavailable. Submitting C runs C first and only afterward can drain B. Two overlapping expansions can similarly order messages by completion rather than Enter order. A session reset during the await can also be followed by insertion into the newly cleared shared queue.

**Action:** Reserve submission identity/order immediately, bind preparation to session/lifetime ownership, and dispatch ready input when processing transitions to idle. Do not fix only with another boolean check if that still reverses two submissions.

**Regression tests:** Deferred expansion with A completing before B resolves; require B to start automatically. Submit B then C with reversed preparation completion; require original ordering. Reset session/abort while preparing; require explicit cancellation or original-session ownership rather than insertion into a replacement session. Evidence is source-only; no real UI execution was performed.

## UI2 — P2: Single-question plan selection submits the previous answer state

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/ui/hooks/use-plan-actions.ts`: the selection computes the next answers once and passes them to `submitPlanAnswers(answersOverride)` instead of relying on a scheduled `setPqs` becoming visible. Regression: `src/ui/hooks/use-plan-actions.test.ts` (identity `useCallback` + mocked context snapshot). UI1 and UI3 remain open.

**Source evidence:** `src/ui/hooks/use-plan-actions.ts:82–85` calls `setPqs` with the selected option, then immediately invokes `submitPlanAnswers`. That callback closes over the current render's `pqs.answers` (`25–33`), so it does not see the scheduled update. `src/ui/routes/modal-keys/use-complex-modal-keys.ts:199,205` invokes this path for number keys and Enter. Actual formatting returns `(not answered)` for a missing value (`src/ui/plan.tsx:324–330`).

**Executed isolated reproduction:** Transpiled the actual hook with TypeScript and evaluated it in a VM. Mocked `useCallback` as identity, supplied a context snapshot with one unanswered select question, supplied setters that queue/capture updates without changing that render snapshot, and recorded the answers passed to a formatting stub. Selecting Yes submitted `{}`. This models React closure semantics but is not an OpenTUI render or keyboard integration test. No real renderer was started.

**Scenario:** A model offers a single-choice plan question. Selecting Yes immediately dismisses the plan and sends an answer containing `(not answered)` rather than Yes.

**Action/test:** Compute `nextAnswers` once and pass it explicitly to submission instead of depending on a state update becoming visible within the same callback. Test the actual single-question hook/keyboard flow with both Enter and numeric shortcuts; assert selected option text is submitted exactly once. Also cover changing a previous selection so the old value cannot leak.

## UI3 — P2: Recalled pasted/file prompts lose the underlying input

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/ui/hooks/use-composer-actions.ts` and `usePromptHistory.ts`. History records the replayable prompt — pasted content inlined and file chips as canonical `@/abs/path` mentions — rather than the raw composer text whose `[Pasted #n]` and `[File: name]` placeholders refer to blocks cleared on submit, so recalling with Up and submitting again sends the same content and the same full file path. Regression: `src/ui/hooks/use-composer-actions.test.ts` (`UI3 — history recall replays pasted content and file mentions`).

**Source evidence:** `src/ui/hooks/use-composer-actions.ts:159–174` records raw composer text before expanding paste/file tokens, then clears their backing arrays. `src/ui/hooks/usePromptHistory.ts` stores and restores strings only. Paste tokens such as `[Pasted #1 3+ lines]` and file tokens `[File: name]` contain neither the original pasted content nor the full file path (`src/ui/app-helpers.tsx:65–75`). On recall, `usePromptHistory.ts:93–107` restores only the saved string; no block objects are restored.

**Scenario:** Paste a multiline code sample, submit it, then press Up and submit again. History restores its placeholder, but the block was discarded during the first submission. The second request therefore contains the literal placeholder instead of the code. File-chip prompts similarly lose their full attachment path. This is source-verified; no live attachment or terminal test was run.

**Action/test:** Store a replayable prompt representation: either expanded paste text and canonical file mentions, or structured history with associated payload metadata. Preserve display presentation separately if needed. Round-trip multiline paste and dropped-file submissions through history recall and assert the second prepared request contains the same content/reference. Do not rely on token IDs surviving after their backing block collection is cleared.

## Rendering and ownership observations without additional validated findings

- Streaming content/reasoning notify separate leaf listener sets and avoid unchanged-value notifications; the subscription effect also resamples before listening. No missed-update defect was established in that store.
- The sampled virtualizer uses estimated heights to index real scroll coordinates. A real renderer fixture with long fenced blocks, expanded entries, resize and manual scroll is needed to evaluate anchor jumps; this pass does not claim a reproduced scrolling defect.
- Queue send-now does not reset the coordinator unlike explicit abort. A wedged provider may therefore delay promotion, but this overlaps the previously reviewed cancellation ownership problem and needs a focused integration test before a separate finding.
- The composer commits/clears input before provider readiness rejection. Draft recovery deserves UX review; this report prioritizes the reproducible content and ordering defects above.

## Explicit gaps

Most of `src/ui` remains unreviewed, including the complete message renderer, AI output components, provider/model/modal action implementations, extension screen lifecycle, raw terminal interception, complete Telegram bridge, layout components, virtualizer runtime behavior and all platform-specific keyboard ordering. Context provider effects were inspected only in the named full reads. No full UI build, visual proof, screenshot capture or terminal smoke test was performed. The one executed check is an isolated hook closure reproduction, not a claim of integration validation.
