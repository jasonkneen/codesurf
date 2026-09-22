# Daemon Process & Agent Loop

The `codesurf-daemon` is a long-lived background process (`packages/codesurf-daemon/bin/codesurfd.mjs`) shared by every host — the Electron desktop app and the TUI both drive agent turns through it over HTTP. It owns the chat-job lifecycle (`packages/codesurf-daemon/bin/chat-jobs.mjs`): each `chat:send` becomes a *job* that either runs an Anthropic Claude SDK `query()` in-process or `spawn`s a `codex`/`opencode`/`hermes` CLI child, streaming results back over SSE and persisting a per-job timeline plus checkpoints. This section catalogs gaps in that loop. The dominant theme is **lifecycle hygiene under stress**: there is no admission control on job fan-out, shutdown orphans live work, crashes are never reconciled, and persisted artifacts grow without bound. None of these bite in a single happy-path turn, but they compound badly under bursts, restarts, and long-running installs.

## Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| [daemon-01](#daemon-01--no-concurrency-limit-or-backpressure-on-job-execution) | No concurrency limit or backpressure on job execution — unbounded fan-out of agent processes | High | M | `chat-jobs.mjs` |
| [daemon-02](#daemon-02--daemon-shutdown-cancels-no-in-flight-jobs-and-orphans-spawned-cli-child-processes) | Daemon shutdown cancels no in-flight jobs and orphans spawned CLI child processes | High | M | `codesurfd.mjs`, `chat-jobs.mjs` |
| [daemon-04](#daemon-04--crashedkilled-jobs-are-never-reconciled-to-lost-resume-wedges-an-sse-stream-open-forever) | Crashed/killed jobs are never reconciled to 'lost'; resume wedges an SSE stream open forever | High | M | `chat-jobs.mjs`, `codesurfd.mjs`, `chat.ts` |
| [daemon-03](#daemon-03--background-daemon-jobs-are-uncancellable-from-the-ui) | Background daemon jobs are uncancellable from the UI | Medium | M | `chat.ts` |
| [daemon-05](#daemon-05--unbounded-growth-of-job-metadata-timeline-jsonl-files-and-checkpoints) | Unbounded growth of job metadata, timeline `.jsonl` files, and checkpoints | Medium | M | `codesurfd.mjs`, `chat-jobs.mjs`, `checkpoints.mjs` |
| [daemon-06](#daemon-06--checkpoints-store-full-file-contents-as-base64-in-json-with-no-size-cap) | Checkpoints store full file contents as base64-in-JSON with no size cap | Medium | S | `checkpoints.mjs` |
| [daemon-07](#daemon-07--appendevent-does-two-full-file-writes-per-streamed-delta) | `appendEvent` does two full-file writes per streamed delta (hot-path disk churn) | Medium | S | `chat-jobs.mjs` |
| [daemon-08](#daemon-08--sse-fan-out-has-no-heartbeat-no-per-subscriber-error-isolation-and-ignores-write-backpressure) | SSE fan-out has no heartbeat, no per-subscriber error isolation, and ignores write backpressure | Low | S | `chat-jobs.mjs` |
| [daemon-09](#daemon-09--cancel-path-double-emits-terminal-events-renderer-sse-parser-also-double-emits-done) | Cancel path double-emits terminal events; renderer SSE parser also double-emits 'done' | Low | S | `chat-jobs.mjs`, `agent-stream.ts` |
| [daemon-10](#daemon-10--duplicate-external-session-indexing-implementations-with-unbounded-listing-caches) | Duplicate external-session indexing implementations with unbounded listing caches | Low | M | `session-sources.ts`, `session-index.mjs` |

---

### daemon-01 — No concurrency limit or backpressure on job execution

**Severity: High · Effort: M · `judgment`**

**Files:** `packages/codesurf-daemon/bin/chat-jobs.mjs`

**Problem.** A burst of agent turns can spawn unbounded concurrent SDK queries and child processes, exhausting CPU/memory/file-descriptors and API rate limits on the single daemon process that all hosts (desktop + TUI) share. There is no graceful degradation — the daemon just keeps accepting and launching.

**Evidence.** `startJob` (`chat-jobs.mjs:1611-1643`) has zero admission control: it writes metadata, sets `liveJobs.set(id, live)`, and calls `void runJob(live, request, workspaceDir)` synchronously. There is no max-in-flight count, no queue, and no per-workspace or global semaphore anywhere in the manager. `runJob` (`1538-1609`) dispatches to `runClaudeJob` (Claude SDK `query()` at `chat-jobs.mjs:920`) / `runCodexJob` (`spawn('codex', …)` at `1180`) / `runOpenCodeJob` (`spawn('opencode', …)` at `1452`) / `runHermesJob` (`spawn('hermes', …)` at `1382`), so each job launches an SDK query or spawns a CLI child. The HTTP entry point `/chat/job/start` (`codesurfd.mjs:3236`) calls `chatJobs.startJob(request)` directly with no upstream throttle. N concurrent `chat:send` requests (e.g. a kanban board auto-running many agent cards, or rapid resend) launch N concurrent queries / child processes. Each Claude query also loads memory context, expands file refs, and holds an SSE pipeline.

**Recommendation.** Add a bounded job scheduler in `createChatJobManager` (`chat-jobs.mjs:722`): a configurable max-concurrent-jobs semaphore (default ~4) with a FIFO queue. Jobs over the limit enter status `'queued'` (already a recognized status — see below) and start when a slot frees in `runJob`'s `finally` block (`1606-1608`, which already does `liveJobs.delete`). Surface queue depth in the dashboard summary. Optionally use a separate, smaller cap for background `runMode` so foreground chats aren't starved.

**Verifier note.** Evidence verified against the real code at every cited location — there is no max-in-flight count, queue, or semaphore, and a package-wide grep for `p-limit`/`semaphore`/`rate-limit`/`throttle`/`concurrency`/`maxInFlight` returns nothing. The recommendation reuses existing plumbing: `'queued'` is already recognized by `isActiveJobStatus` (`codesurfd.mjs:683`), is wired into dashboard CSS (`1242`) and the `isStreaming` computation (`2545`, `2690`). The change is localized to `createChatJobManager` and is additive (a scheduler), not a refactor — low-risk to land. Severity kept at high: the trigger is non-adversarial and plausible, the daemon is a single shared process, and fan-out exhausts CPU/memory/FDs and API rate limits with no degradation path.

---

### daemon-02 — Daemon shutdown cancels no in-flight jobs and orphans spawned CLI child processes

**Severity: High · Effort: M · `factual`**
**Cluster C3 (primary dimension: daemon).** Pairs with `rel-04` in the reliability section.

**Files:** `packages/codesurf-daemon/bin/codesurfd.mjs`, `packages/codesurf-daemon/bin/chat-jobs.mjs`

**Problem.** On `restartDaemon`/`stopDaemon` or any uncaught error, in-flight Claude SDK queries and spawned `codex`/`opencode`/`hermes` turns are not cancelled. CLI children get reparented to init and keep running (writing files, burning API tokens) with no daemon to capture their output. Their job metadata stays `'running'` forever, and Edit/Write side effects can land with no checkpoint follow-through.

**Evidence.** `shutdown()` (`codesurfd.mjs:3839-3846`) only calls `removeOwnedPidFile()` then `await server.close()` — it never iterates `liveJobs` to invoke `job.cancel()`. The four handlers (SIGTERM `3848`, SIGINT `3851`, `uncaughtException` `3859`, `unhandledRejection` `3863`) all do `shutdown().finally(() => process.exit(0|1))`. The CLI providers spawn children with no `detached` flag and no kill on shutdown — `runCodexJob` (`chat-jobs.mjs:1180`), `runHermesJob` (`1382`), `runOpenCodeJob` (`1452`) — each tracked only in `job.proc`/`job.cancel` (`job.cancel = () => proc.kill('SIGTERM')`). `chatJobs`' public API (`1699-1708`) exposes **no** `shutdown`/`disposeAll` method. The supervising manager (`manager.ts:336-354`) sends a single-PID SIGTERM first (`342`), waits `DAEMON_STOP_TIMEOUT_MS=5000` (`56`), then group-SIGKILLs (`345`) — so on the graceful path the daemon exits on its own SIGTERM handler before the group kill fires, leaving children orphaned.

**Recommendation.** Add `chatJobs.shutdown()` that iterates `liveJobs`, calls each `job.cancel()`, and force-kills `job.proc` after a short grace, then `await` it inside `codesurfd` `shutdown()` *before* `server.close()`. A single `liveJobs` loop covers all four providers — including the Claude SDK case, which cancels via `abortController.abort()` (`chat-jobs.mjs:928-929`) rather than a child proc. As defense-in-depth, have the manager SIGTERM the process group first rather than the lone PID (the daemon is already spawned `detached: true` at `manager.ts:243`, making it a group leader).

**Verifier note.** Every claim verified. One sharpening: orphaning is timing-dependent and the manager's group-SIGKILL is *not* a reliable safety net. `streamJob` (`chat-jobs.mjs:1661-1697`) holds SSE connections open, and `server.close()` waits for in-flight connections — but for background/async jobs with *no* attached stream (the exact designed use case), `close()` returns fast, the daemon exits inside 5s, and the group-SIGKILL never fires. The group kill only reliably fires when an SSE client happens to be attached, i.e. precisely when it's least needed. One overstatement to note: `proc.kill('SIGTERM')` reaches only the direct CLI child, not grandchildren `codex`/`opencode` may spawn — so the daemon-side fix reduces but does not fully eliminate orphans; pair it with the manager's group-SIGTERM-first. Severity is high: `restartDaemon` on app upgrade is routine, async background jobs are a designed feature, and `codex` runs in full-access mode (`chat-jobs.mjs:1170`, `--dangerously-bypass-approvals-and-sandbox`) — unsupervised file writes after the daemon dies are a real correctness hazard, not just wasted tokens.

---

### daemon-04 — Crashed/killed jobs are never reconciled to 'lost'; resume wedges an SSE stream open forever

**Severity: High · Effort: M · `factual`**

**Files:** `packages/codesurf-daemon/bin/chat-jobs.mjs`, `packages/codesurf-daemon/bin/codesurfd.mjs`, `src/main/ipc/chat.ts`

**Problem.** After a daemon crash/restart, resuming any interrupted job hangs the chat tile on a perpetually-open SSE connection that never completes — the UI shows a stuck "streaming" spinner indefinitely. The job is silently dead but presents as alive.

**Evidence.** When the daemon is killed mid-job, the job's metadata JSON stays `status: 'running'` (`appendEvent` only flips status on a `'done'` event — see note below). On restart `liveJobs` is empty (it is `new Map()` at `chat-jobs.mjs:728`, populated only by `startJob`). `readDaemonJobRecords` (`codesurfd.mjs:686-699`) *computes* a `'lost'` status for active-status jobs absent from `liveJobs` but never writes it back. `getJobState` (`chat-jobs.mjs:1657-1659`) returns the raw stale `'running'`. `resumeChatDaemonJob` (`chat.ts:1452`) only short-circuits when `state.status !== 'running' && sinceSequence >= lastSequence`; for a dead-but-`'running'` job it calls `attachDaemonJobStream`. In `streamJob` (`chat-jobs.mjs:1681-1694`), `metadata.status === 'running'` is true, so the response is added to subscribers and held open — but no events will ever fire (the producer is dead). There is no SSE heartbeat (see daemon-08), and the client consumer loop (`chat.ts:1366`, `while(true){ reader.read() }`) blocks with no idle timeout. `start()` (`codesurfd.mjs:3789-3826`) does no job reconciliation (only `cleanupOldDeletedFiles`).

**Recommendation.** **Do not** rely on changing `getJobState` alone (the original recommendation #1) — it is insufficient. Lead with one of:

- **(A) Startup reconciliation** — in `start()` (`codesurfd.mjs:3789-3826`) add a one-time pass over the jobs dir that rewrites any `isActiveJobStatus()` metadata not in `chatJobs.listLiveJobIds()` to status `'lost'` (+ `completedAt`). This is the most complete single fix: `streamJob`'s direct `readJobMetadata` (`chat-jobs.mjs:1662`) then returns `'lost'`, skips subscriber registration, and `res.end()`s; `getJobState` returns the corrected status too.
- **(B) `streamJob` guard** — replace the `metadata.status === 'running'` gate (`1681`) with a check that the job is actually live (`liveJobs.has(jobId)`), emitting a terminal error+done and returning `false` when active-but-not-live.

Either A or B independently closes the hang.

**Verifier note.** All five cited facts verified. The original recommendation #1 (compute `'lost'` inside `getJobState`) is **ineffective alone**: `streamJob` reads metadata via `readJobMetadata` *directly* (`1662`), not via `getJobState`, so the subscriber still registers and hangs; and in the realistic crash case the client is *behind* (`sinceSequence < lastSequence`), so even with `status='lost'` the resume short-circuit's second clause is false and `attachDaemonJobStream` is still called. Minor accuracy note that *strengthens* the finding: `appendEvent` (`761-766`) only flips status on `'done'` (to `completed`/`failed`); an `'error'` event merely records `metadata.error` and leaves status unchanged — so an error event alone never moves a job out of `'running'`. There *is* an existing `'lost'` computation at the dashboard endpoint `/dashboard/api/job` (`codesurfd.mjs:2851-2856`), but it does not cover the resume/stream path, so the bug stands.

---

### daemon-03 — Background daemon jobs are uncancellable from the UI

**Severity: Medium · Effort: M · `factual` (refined)**

**Files:** `src/main/ipc/chat.ts`

**Problem.** Once a background daemon job detaches and the launching tile is closed (or the job is reopened from the status bar), the user has no way to stop it. It runs to completion in the daemon (consuming tokens, making edits) regardless of `chat:stop`. The only cancel path requires an already-attached stream keyed by `cardId`.

**Evidence.** For `runMode === 'background'`, `sendChatToDaemon` (`chat.ts:1428-1433`) skips `attachDaemonJobStream`, so no entry is added to `activeDaemonStreams`. `cancelChatDaemonJob` (`1468-1481`) early-returns when `activeDaemonStreams.get(cardId)` is `undefined`, so `/chat/job/cancel` is never called. `cancelChatDaemonJob` is the **sole** caller of `/chat/job/cancel` (`1473`), and preload exposes only `chat.stop(cardId)` (`preload/index.ts:230`) — there is no jobId-addressed cancel IPC. `MainStatusBar` lists recent jobs (rows carry both `id` and `cardId`, `MainStatusBar.tsx:47/52`) but has no cancel hook.

**Recommendation.** Add a jobId-addressed cancel IPC (e.g. `jobs:cancel(jobId)`) that resolves the daemon host and calls `/chat/job/cancel` directly, independent of `activeDaemonStreams`, and wire it to the `MainStatusBar` recent-jobs rows (the data is already in hand). Drop the alternative of having `cancelChatDaemonJob` fall back to the most-recent live job — it is redundant given the existing `chat:resumeJob` reattach path.

**Verifier note.** Severity refined from high to medium. A reconnect path *does* exist for the common case: `chat:resumeJob` → `resumeChatDaemonJob` (`chat.ts:1438`) → `attachDaemonJobStream` (`1460`) re-populates `activeDaemonStreams`, and `ChatTile` auto-fires `resumeJob` whenever a persisted `jobId` is present (`ChatTile.tsx:3371-3395`), which a background launch persists (`ChatTile.tsx:4616-4627`). So for the tile that launched the job, on remount a subsequent `chat:stop` *does* cancel it — the blanket "no way to stop it" is wrong there. The genuine residual gap: `openDaemonTask` in `App.tsx` (`3506-3540`) opens a recent job by `sessionId` via a synthetic `AggregatedSessionEntry` carrying **no** `jobId`, so opening a recent job from the status bar (or after the launching tile was closed/deleted) never triggers reattach and cannot be cancelled. The recommendation targets exactly this case.

---

### daemon-05 — Unbounded growth of job metadata, timeline `.jsonl` files, and checkpoints

**Severity: Medium · Effort: M · `factual`**

**Files:** `packages/codesurf-daemon/bin/codesurfd.mjs`, `packages/codesurf-daemon/bin/chat-jobs.mjs`, `packages/codesurf-daemon/bin/checkpoints.mjs`

**Problem.** Over time `~/.codesurf/jobs`, timelines, and per-workspace checkpoints accumulate without bound (disk bloat), and the dashboard poll cost grows O(total jobs ever run) because the directory is fully read and parsed on every poll. `MainStatusBar` polls the dashboard regularly, amplifying the cost.

**Evidence.** The only periodic cleanup (24h interval, `codesurfd.mjs:3812`) is `cleanupOldDeletedFiles` (`1839-1880`), which only removes entries under `deleted/` markers — **not** live job metadata, timeline jsonl, or checkpoint records. Every job leaves a `{id}.json` (`chat-jobs.mjs:733-739`) and a `{id}.jsonl` that grows one line per streamed event (per text/thinking/tool-input delta, `749-751`, `775`). Checkpoints, written under workspace `.contex/checkpoints` (`checkpoints.mjs`), are never expired. `readDaemonJobRecords` (`codesurfd.mjs:686-723`) `readFileSync`+`JSON.parse`s **every** `.json` in `jobs/` on every `/dashboard/api/jobs` poll, applying the `limit` only after reading all of them.

**Recommendation.** Add a TTL/retention sweep for `jobs/*.json` + `timelines/*.jsonl` + checkpoint records (e.g. keep last N or last 30 days of terminal jobs) inside the existing 24h timer. For `readDaemonJobRecords`, cap the scan: sort dir entries by mtime and read only the newest `limit` instead of parsing the whole directory each poll.

---

### daemon-06 — Checkpoints store full file contents as base64-in-JSON with no size cap

**Severity: Medium · Effort: S · `factual`**

**Files:** `packages/codesurf-daemon/bin/checkpoints.mjs`

**Problem.** Editing a large file (a generated bundle, lockfile, or data file) during an agent turn snapshots the entire file as base64 into a JSON record on every edit, causing large synchronous reads/writes and disk bloat. Combined with daemon-05's lack of pruning, repeated edits to big files multiply storage.

**Evidence.** `captureFileSnapshot` (`checkpoints.mjs:243-271`) does `readFileSync(targetPath)` then `buffer.toString('base64')`, stored inside the checkpoint JSON record — there is no size guard before reading or storing. A checkpoint is created before every Claude Edit/Write tool call (`createDaemonCheckpoint` in `chat-jobs.mjs`, gated by `isClaudeCheckpointTool` in `canUseTool`); Codex/OpenCode also snapshot edited files. Base64 inflates content ~33%, and the whole record is held in memory and serialized synchronously via `atomicWriteJson` (`createCheckpoint`, `298+`).

**Recommendation.** Add a max-snapshot-bytes guard in `captureFileSnapshot`; for files over the cap, store a "too large to checkpoint" marker (`existed:true, content:null` with an oversize flag) so restore can warn instead of silently corrupting, or store a content-addressed blob outside the JSON. Skip binary/oversize files from the checkpointable set up front.

---

### daemon-07 — `appendEvent` does two full-file writes per streamed delta

**Severity: Medium · Effort: S · `factual`**

**Files:** `packages/codesurf-daemon/bin/chat-jobs.mjs`

**Problem.** High-frequency disk I/O during streaming: every text token group rewrites the full metadata file. On slow disks or with many concurrent jobs this adds latency to the stream and unnecessary write amplification.

**Evidence.** `appendEvent` (`chat-jobs.mjs:753-801`) does `await fs.appendFile(jobTimelinePath, …)` then `await writeJobMetadata(metadata)`, which does a full `fs.writeFile(jobMetaPath, JSON.stringify(job, null, 2))`. `appendEvent` is called for every streamed event including `content_block_delta` text/thinking/tool-input chunks (`runClaudeJob:1082-1086` calls it per delta). For a token-streaming turn this is 2 filesystem operations per delta — one of which is a whole-object re-serialization — just to bump `lastSequence`/`updatedAt`.

**Recommendation.** Decouple cadence: append to the timeline jsonl on every event (cheap, append-only), but debounce/throttle the full metadata write (flush `lastSequence`/`updatedAt` at most every ~250ms or on terminal events), and always write metadata immediately on session/done/error. `lastSequence` is already recoverable from the timeline if needed.

---

### daemon-08 — SSE fan-out has no heartbeat, no per-subscriber error isolation, and ignores write backpressure

**Severity: Low · Effort: S · `factual`**

**Files:** `packages/codesurf-daemon/bin/chat-jobs.mjs`

**Problem.** A slow or half-dead SSE client can balloon daemon memory; a throwing socket can starve sibling subscribers of an event; and clients can't tell a silently-stalled stream from a live one (which compounds the daemon-04 resume wedge).

**Evidence.** `writeSseEvent` (`chat-jobs.mjs:718-720`) does a bare `res.write(...)` ignoring its boolean return, so a slow consumer buffers events unboundedly in daemon memory. The `appendEvent` fan-out loop (`784-786`), `for (const res of listeners) writeSseEvent(res, payload)`, has no per-subscriber try/catch, so a synchronous throw from one socket would skip the remaining subscribers for that event. `streamJob` registers subscribers (`1681-1693`) with no keepalive timer — there is no `:`-comment heartbeat on an interval, so a half-open/dead stream is undetectable by the client.

**Recommendation.** Wrap each `writeSseEvent` in try/catch (drop the subscriber on failure), honor `res.write()`'s `false` return (pause appends or drop the slow subscriber), and add a periodic SSE heartbeat comment (`res.write(': ping\n\n')`) per active job so clients can detect dead streams.

---

### daemon-09 — Cancel path double-emits terminal events; renderer SSE parser also double-emits 'done'

**Severity: Low · Effort: S · `factual`**

**Files:** `packages/codesurf-daemon/bin/chat-jobs.mjs`, `src/main/agent-stream.ts`

**Problem.** Duplicate terminal events produce a noisy/ambiguous timeline and can confuse resume logic (two 'done' sequences) and the renderer's stream state machine. Low impact today because subscribers are cleared after the first 'done', but it's a correctness smell that complicates the recovery code.

**Evidence.** `cancelJob` (`chat-jobs.mjs:1645-1655`) calls `live.cancel()` (aborts the Claude query), then appends `{type:'error','Job cancelled'}` and `{type:'done'}`. The abort makes `runClaudeJob`'s `for-await` throw, hitting its catch (`1141-1147`) which appends *another* error+done. The first 'done' already cleared subscribers (`appendEvent:791-797`), so the second writes a confusing duplicate terminal pair to the timeline and re-runs status logic. Separately, `parseClaudeStream` in `agent-stream.ts` fires 'done' on `message_stop`/`[DONE]` (`40-41`, `57-58`) **and** again on the stream `'end'` event (`67`).

**Recommendation.** Guard `appendEvent` so terminal events ('done'/'error') are idempotent per job (track an `emittedTerminal` flag in `liveJobs`; ignore subsequent terminal appends). In `cancelJob`, rely on the runner's own catch to emit terminal events rather than emitting them directly, or set the flag before aborting. In `parseClaudeStream`, suppress the `'end'` 'done' once `message_stop` has fired.

---

### daemon-10 — Duplicate external-session indexing implementations with unbounded listing caches

**Severity: Low · Effort: M · `judgment`**
**Cluster C5 (primary dimension: separation).** See also: the **separation** section owns the deep write-up of the app/daemon code-duplication root cause (`soc-03` + `daemon-10`).

**Files:** `src/main/session-sources.ts`, `packages/codesurf-daemon/bin/session-index.mjs`

**Problem.** Two parallel implementations of the same scanning/sampling logic risk divergence (a fix to one silently missed in the other), and both retain a full session list per distinct workspace path with no eviction. Low severity because workspace count is small in practice, but the duplication is a maintenance hazard on a hot disk-I/O path.

**Evidence.** `session-index.mjs` is a near-clone of `session-sources.ts` (same constants, same `readJsonSafe`/`readTailSafe`/large-file sampling, same per-provider scan list). Both keep a listing cache as a plain `Map` keyed by `workspacePath ?? '__no_workspace__'` that is never evicted — `session-sources.ts` `externalSessionCache` (`86`) + `listExternalSessionEntries` (`1684-1703`); `session-index.mjs` `externalSessionCache` (`17`, same pattern, 30s TTL). The per-file *state* caches ARE bounded (touch/evict at 64 and 8), but the listing-level caches are not. Both implement freshness via timestamp (60s main / 30s daemon) with stale-while-revalidate, but no size cap.

**Recommendation.** Consolidate the scanning/sampling logic into one shared module imported by both the daemon (`session-index.mjs`) and the main process — or have the main process always go through the daemon's index (it largely does for the sidebar). Bound the listing cache with a small LRU like the state caches already use. The cross-cutting extraction story is owned by the separation section (cluster C5).

---

## Quick wins

- **daemon-06 (S):** Add a max-snapshot-bytes guard in `captureFileSnapshot` (`checkpoints.mjs:243-271`) and store an oversize marker instead of base64 for large files.
- **daemon-07 (S):** Debounce the full `writeJobMetadata` call in `appendEvent` (`chat-jobs.mjs:753-801`) to ~250ms while keeping the cheap timeline append on every event.
- **daemon-08 (S):** Wrap `writeSseEvent` in try/catch, honor the `res.write()` backpressure return, and add a periodic `: ping` heartbeat per active job — this also gives clients a way to detect the daemon-04 dead-stream wedge.
- **daemon-09 (S):** Make terminal `'done'`/`'error'` events idempotent per job (an `emittedTerminal` flag in `liveJobs`) and suppress the duplicate `'end'`-triggered `'done'` in `parseClaudeStream`.
- **daemon-04 path B (M, but localized):** A single `streamJob` liveness guard (`liveJobs.has(jobId)` instead of `metadata.status === 'running'`) closes the post-crash resume hang on its own.
