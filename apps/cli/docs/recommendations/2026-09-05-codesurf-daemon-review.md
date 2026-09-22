# CodeSurf daemon targeted review — 2026-09-05

Reviewer: Hans / Astra. Scope: read-only product review; this report is the only file authored. Product fixes remain reserved for the user's requested Spark implementation phase.

## Evidence and coverage

This is a targeted review, not whole-package certification. Findings D1–D4 are supported by reachable source paths. D1 additionally has an executed, isolated mocked-client reproduction; no real daemon or model provider was started. No product tests or full build were run for this documentation-only pass.

| File | Inspected coverage |
| --- | --- |
| `packages/codesurf-daemon/bin/chat-jobs.mjs` | Lines 1020–1178: timeline queues, metadata persistence, subscriber delivery and terminal processing. Lines 1744–1782: Codex process launch/cancel wiring. Lines 2384–2799: preparation, provider dispatch, concurrency queue, cancellation, stream replay, retention and shutdown. Other provider bodies were searched for cancellation/resource hooks, not completely reviewed. |
| `packages/codesurf-daemon/src/client.ts` | Lines 60–206: generic requests, retry, SSE consumption, start/state/cancel wrappers. Remaining methods were searched, not reviewed. |
| `packages/codesurf-daemon/src/manager.ts` | Lines 262–355: startup lock, process signaling and stop escalation. Other sections searched only. |
| `packages/codesurf-daemon/src/sse.ts` | Entire 33-line parser. |
| `packages/codesurf-daemon/src/chat-session-store.ts` | Entire 138-line session persistence helper. |
| `packages/codesurf-daemon/bin/codesurfd.mjs` | Start/cancel/events route locations traced; final job-start dispatch at 3438–3457 and shutdown at 4134–4148 read. The 4,170-line HTTP server was not fully reviewed. |
| `packages/codesurf-daemon/bin/harness-runtime.mjs` | Lines 128–165 shell subprocess helpers; cancellation/finally locations searched. Not a full harness review. |
| `src/daemon/scheduler.ts` | Supplemental parent finding, independently checked at lines 13–105: start/stop and tick dispatch. Outside the vendored-package scope. |
| Existing tests | Searched `src` and `packages` test files for `chat-jobs`, `createDaemonClient`, `createChatJobManager`, `streamJobEvents`, and `chat-session-store`; no matches. Read opening portions of `src/daemon/session-repair.test.ts` and `src/daemon/scheduler.test.ts`; these concern separate repair/scheduling helpers and do not establish coverage for the paths below. |

## D1 — P1: Retrying job-start POST can execute the same prompt twice

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `packages/codesurf-daemon/src/client.ts` and `bin/chat-jobs.mjs`. Every job start carries a client-generated `startRequestId`, and the manager remembers it: a retry after an unknown outcome resolves to the job the first attempt created, a duplicate arriving while the first start is still pending coalesces onto it, and a failed start is forgotten so a genuine retry can proceed. Regression: `packages/codesurf-daemon/test/chat-jobs.test.mjs` (`D1: idempotent job start`) and `test/client.test.ts`, run with `node --test test/*.test.mjs` and `bun test test/client.test.ts`.

**Evidence:** `src/client.ts:63–108` retries the generic request after any first-attempt exception, including a failed response read or timeout after the server accepted a POST. `src/client.ts:195–196` uses that helper for `/chat/job/start`. `bin/codesurfd.mjs:3454–3455` starts a job before sending its response. `bin/chat-jobs.mjs:2571–2572` allocates a new random ID for every start and has no request deduplication at that entry point.

**Scenario:** The server starts A, but its response is lost or exceeds the default five-second client timeout. The client repeats the POST; the server starts B. Both can execute tools against the same workspace while the client only knows B's ID. A slow initial workspace provisioning operation can also outlive the client timeout.

**Executed check:** Imported the real TypeScript client with Bun and replaced `globalThis.fetch` with a local stub: attempt one throws `response lost after server accepted request`; attempt two returns `{id:"second-job"}`. Stubbed manager health as still running. `startChatJob` produced `{"attempts":2,"result":{"id":"second-job"}}`. This proves automatic duplicate request submission, not real duplicate model execution.

**Recommendation/test:** Introduce caller request IDs with server-side idempotent start semantics, or do not transparently retry mutations whose outcome is unknown. Simulate server acceptance followed by response failure; assert exactly one execution and that retry returns the existing job identity. Cover response JSON-read failure as well as fetch timeout.

## D2 — P1: Running jobs cannot be cancelled during asynchronous preparation

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `packages/codesurf-daemon/bin/chat-jobs.mjs`. Cancellation state is owned by the job before it is enqueued, so a cancel that arrives while persona and memory loading are still pending is recorded rather than refused, and the flag is re-checked after preparation and immediately before the provider launch. Regression: `packages/codesurf-daemon/test/chat-jobs.test.mjs` (`D2: cancellation during preparation`).

**Evidence:** `bin/chat-jobs.mjs:2606` creates live records with `cancel: null`. Queue pumping removes the job from the queue before calling `runJob` (`2557–2567`). `runJob` then awaits persona resolution and memory loading (`2399`, `2437`, `2449–2454`) before dispatching a provider. Providers install cancellation later, e.g. Codex at `1775–1777`. `cancelJob:2613–2632` succeeds only for a queued entry or a non-null cancel function and otherwise returns `Job not running`.

**Scenario:** Start a job with a slow memory/persona load and cancel while it is marked running but before provider entry. The cancellation API rejects the request despite the live job; preparation continues and launches the provider. A caller cannot rely on cancel to prevent tool execution in this window.

**Recommendation/test:** Allocate job-owned cancellation state before enqueueing, record cancellation regardless of provider readiness, and check it after preparation awaits and before launch. Gate memory loading with a deferred promise, cancel after queue removal, resolve preparation, and assert no provider launch plus one terminal cancellation state. This scenario is source-verified, not executed.

## D3 — P1: Shutdown can launch queued jobs after its cancellation snapshot

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `packages/codesurf-daemon/bin/chat-jobs.mjs`. Shutdown sets an irreversible closing flag first: new starts are rejected, the queue pump refuses to launch, and shutdown then cancels running jobs and joins their promises, so a cancelled job's unwind can no longer start a queued job that the shutdown sweep never saw. Regression: `packages/codesurf-daemon/test/chat-jobs.test.mjs` (`D3: shutdown ownership of the queue`).

**Evidence:** `bin/chat-jobs.mjs:2749–2756` snapshots `liveJobs` and invokes existing cancel callbacks. Queued jobs have neither callback nor process. Shutdown does not mark the manager closed, empty the queue, or block pump dispatch. A cancelled running job's `runJob` finally block (`2547–2552`) always decrements the active count and calls `pumpJobQueue`, which launches waiting jobs (`2557–2567`). The shutdown process list contains only processes existing in its original snapshot.

**Scenario:** With concurrency one, A is running and B is queued. Shutdown cancels A. A unwinds and its finally starts B, whose newly spawned detached process was absent from shutdown's process list. B can execute during shutdown and survive daemon termination. The HTTP server itself is closed only after awaiting `chatJobs.shutdown` (`bin/codesurfd.mjs:4143–4145`), leaving an additional admission window.

**Recommendation/test:** Set an irreversible closing flag first; reject starts, prevent queue pumping, terminalize queued jobs, then cancel and await existing runners/processes. Test concurrency one with deferred A and queued B; begin shutdown, release A, and assert B never starts. Also submit a new request during shutdown and require rejection. Source-verified; no child processes were launched for this review.

## D4 — P2: Atomic metadata writes can still regress terminal status

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `packages/codesurf-daemon/bin/chat-jobs.mjs`. Metadata commits are serialized per job like timeline appends, and each write snapshots the record only when its turn comes, so a debounced `running` snapshot can no longer rename over a later `completed` commit. Regression: `packages/codesurf-daemon/test/chat-jobs.test.mjs` (`D4: metadata commits cannot regress terminal status`).

**Evidence:** `bin/chat-jobs.mjs:1070–1083` serializes a snapshot into a unique temporary file and independently awaits write/rename. `scheduleMetadataFlush:1094–1103` starts writes without storing/awaiting their completion. Terminal handling (`1154–1160`) cancels a pending timer but cannot cancel an already in-flight metadata write. Unlike timeline writes (`1029–1039`), metadata writes have no per-job ordering queue. Queue promotion also fires an independent metadata write (`2563–2565`).

**Scenario:** A debounced write snapshots `status: running` and pauses during its filesystem operation. Completion writes and renames `status: completed`. The older write then finishes and renames over it. Persisted state is now running with an older sequence even though the timeline is terminal. State/dashboard queries become incorrect, retention skips the record, and reopening its stream can classify it as interrupted after the live entry disappears.

**Recommendation/test:** Serialize metadata writes per job or enforce monotonic revisions at the commit boundary. Use controllable filesystem promises: hold the earlier rename, complete the terminal write, then release the older operation; assert persisted terminal status/sequence cannot decrease. Atomic rename alone prevents torn JSON, not lost updates. Source-supported interleaving; not executed.

## D5 — P2: Scheduler stop can be followed by detached dispatch and timer creation

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/daemon/scheduler.ts`. The tick re-checks `shuttingDown` after the listing await and before every dispatch, `start()` refuses to install the interval when stop completed during the initial tick, and `stop()` joins the in-flight tick. Regression: `src/daemon/scheduler.test.ts` (`SchedulerDaemon shutdown ownership`) holds the second listing open across stop() and asserts zero launches and no surviving interval. D1–D4 (vendored daemon package) remain open.

Supplemental finding supplied by the parent reviewer and independently checked against current `src/daemon/scheduler.ts:13–105`. This is outside the vendored daemon package.

**Evidence:** `start:33–36` awaits the initial tick then unconditionally installs an interval. `stop:39–48` sets `shuttingDown`, clears only an already-existing interval, and removes the PID record without awaiting the active tick. `tick:71` checks shutdown only before awaiting `schedules.list:76`; after that await it can launch detached work at `84` without checking shutdown again.

**Scenario:** Begin start, hold the initial tick's schedule listing, call and await stop, then resolve the listing with due work. A detached job launches after stop returned, and start subsequently installs an interval that keeps the process alive despite the removed PID record. The signal handler exits the process, so the clearest reproducible path is direct use of the public `stop()` method.

**Executed reproduction:** The parent transpiled the actual `scheduler.ts` source to CommonJS and evaluated it in a VM with mocked schedule dependencies, process and timers. The first listing resolved; the second listing was deferred until after `stop()` completed, then resolved with a due schedule. Awaiting startup produced `spawnedAfterStop: 1` and `intervalsInstalledAfterStop: 1`. No real subprocess or timer was started; this demonstrates the lifecycle ordering in actual source under controlled dependencies, not an operating-system shutdown test.

**Recommendation/test:** Recheck lifetime ownership after awaits and before dispatch/timer installation; have stop coordinate with in-flight startup/ticks. Extend the existing mocked scheduler tests with a deferred second listing (the first listing is startup logging), stop while it is pending, resolve due schedules, and assert zero detached launches and zero active intervals.

## Additional follow-up candidates, not promoted to validated findings

- SSE retry retains the original `since` query (`src/client.ts:119–126`) even after delivering events. Inspect consumers' sequence deduplication before assigning severity for replayed text after a network failure.
- Stream replay reads disk before subscriber registration (`bin/chat-jobs.mjs:2639–2694`), while events fan out before asynchronous timeline persistence (`1139–1146`). A buffered in-memory catch-up strategy may be needed; create a controlled handoff test before declaring exact user impact.
- `shutdown` escalation checks `proc.killed` at `bin/chat-jobs.mjs:2779`; that flag reports a sent signal, not process death. Verify fallback signaling and actual child state with a process fixture before changing escalation behavior.
- Session-store atomic whole-file writes do not serialize multiple CLI processes. Validate concurrent distinct-identity updates before deciding on a locking/storage migration.

## Explicitly unreviewed

Authentication/authorization of all HTTP routes; path traversal and workspace trust boundaries; provider-specific parsing and permission correctness; SDK internals; checkpoint/worktree cleanup; full session-index reconstruction; provisioning git commands; daemon startup lock stale-owner correctness outside the inspected excerpt; bundled generated JavaScript and vendor dreaming; complete harness lifecycle; real network/SSE behavior; real process shutdown on each operating system. No claim of full security, process safety, or regression-test coverage is made.
