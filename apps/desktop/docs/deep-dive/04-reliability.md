# Reliability & Error Handling

This dimension covers process lifecycle, cancellation, and atomic-persistence correctness across the Electron main process, the relay turn executor, and the `codesurf-daemon` package. The recurring theme is **child processes and timers that outlive the thing that spawned them**: a hard quit, a turn timeout, or a daemon SIGTERM each leave orphaned CLI/SDK subprocesses running and billing. A secondary theme is **non-atomic persistence under same-process concurrency**: a shared `atomicWriteJson` helper whose temp-path scheme collides on millisecond-coincident writes. Two findings here (`rel-04`, `rel-05`) are anchored in clusters owned by other dimensions and are kept brief with a pointer to the owning section.

## Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| rel-03 | Relay Claude turn timeout never aborts the SDK query | high | S | `src/main/relay/provider-executor.ts` |
| rel-02 | No child-process or PTY cleanup on app quit | medium | S | `src/main/index.ts`, `src/main/ipc/chat.ts`, `src/main/ipc/terminal.ts` |
| rel-04 | Daemon SIGTERM shutdown does not kill in-flight chat jobs | medium | S | `packages/codesurf-daemon/bin/codesurfd.mjs`, `packages/codesurf-daemon/bin/chat-jobs.mjs` |
| rel-05 | `atomicWriteJson` temp path collides under concurrent same-process writers | medium | S | `packages/codesurf-daemon/bin/codesurfd.mjs`, `packages/codesurf-daemon/bin/chat-jobs.mjs`, `src/main/permissions.ts` |

---

### rel-03 — Relay Claude turn timeout never aborts the SDK query, so the subprocess keeps running and billing

**Severity:** high · **Effort:** S · **Category:** missing-cancellation

**Problem.** `runClaudeTurn` races a timeout against query iteration with `Promise.race`. When the timeout wins, the `query` async iterator is never cancelled — `options` carries no `abortController` — so the Claude Agent SDK subprocess keeps running to natural turn completion in the background, consuming cost, with its result silently discarded. The `setTimeout` handle is never stored and never cleared, so the timer leaks too.

**Evidence.**
- `src/main/relay/provider-executor.ts:90-141` — `options` is built with **no** `abortController`.
- `src/main/relay/provider-executor.ts:156-158` — `timeoutPromise` is a bare `setTimeout(() => reject(...), timeoutMs)` with no stored handle and no `clearTimeout`.
- `src/main/relay/provider-executor.ts:160-180` — the `for await (const msg of q)` loop over the SDK iterator is never broken or `.return()`ed when the race is lost.
- `src/main/relay/provider-executor.ts:182` — `return Promise.race([queryPromise, timeoutPromise])`.
- The SDK supports the fix: `@anthropic-ai/claude-agent-sdk/sdk.d.ts:1123` declares `abortController?: AbortController` in `Options`.
- Contrast with the daemon path, which does it correctly: `packages/codesurf-daemon/bin/chat-jobs.mjs:928` `const abortController = new AbortController()`, `:929` `job.cancel = () => abortController.abort()`, and `:950` passes `abortController` into the `query` options.
- Sibling turn functions in the **same file** all handle cleanup: `runCodexTurn` (214-236), `runOpenCodeTurn` (270-295), `runOpenClawTurn` (375-401), `runHermesTurn` (452-486) each store their timer, `clearTimeout` on close/error, and `proc.kill('SIGTERM')` on timeout. Only the Claude path leaks both the subprocess and the timer.

**Recommendation.** Create an `AbortController`, pass it in `options`, call `.abort()` in the timeout branch, and `clearTimeout` once the race settles. The relay path has no `job.cancel` plumbing (unlike the daemon reference), so the controller only needs to serve the timeout — even simpler than the cited pattern.

**Verifier critique.** Accurate at every cited location. `runClaudeTurn` (provider-executor.ts 87-183) builds `options` (90-141) with NO abortController, then runs `Promise.race([queryPromise, timeoutPromise])` at line 182. `timeoutPromise` (156-158) is a bare `setTimeout(() => reject(...))` — no stored handle, no clearTimeout. When the timeout wins the race, the `for await (const msg of q)` loop (160-180) over the SDK async iterator is never broken, never `.return()`ed, and there is no abort signal passed, so the Claude Agent SDK subprocess keeps running to natural turn completion in the background, billing, with its result discarded. SDK support and the chat-jobs.mjs contrast (928/929/950) are confirmed exact. The fix is self-contained and low-risk (S effort). Severity is justified at high (silent billing + leaked subprocess + leaked timer on every relay-Claude timeout), but note the leak is **bounded** — the SDK runs to completion of a single turn, not an infinite loop, and the default `timeoutMs` is 300s, so the window is "one extra turn finishes in background after a 5-min timeout." Real cost, not unbounded runaway. Held at high.

---

### rel-02 — No child-process or PTY cleanup on app quit, leaving zombie agent/codex/tmux processes

**Severity:** medium · **Effort:** S · **Category:** process-lifecycle

**Problem.** The `before-quit` handler stops collab/relay/extensions and closes the DB, but never kills the chat-side subprocess map (live Codex/OpenClaw/Hermes/OpenCode children) nor the terminal PTY map. PTY cleanup fires only on WebContents `destroyed` or an explicit `terminal:destroy`/`terminal:detach` IPC, so a hard quit leaves orphaned CLI agent subprocesses (and the `OpenCodeServer`) running.

**Evidence.**
- `src/main/index.ts:1123-1129` — `before-quit` runs `flushActivityStore`, `stopAllCollabWatchers`, `extensionRegistry?.deactivateAll`, `stopAllRelayServices`, `closeDb` — and nothing else. (Verified verbatim in source.)
- `src/main/ipc/chat.ts:443` — `const activeProcesses = new Map<string, ChildProcess>()` is **module-local**; it has no exported kill-all. Entries are added at 2673/3395/3536 and deleted only per-card on stream completion or on `chat:stop`.
- These children are spawned with `stdio: ['ignore','pipe','pipe']` and are **not** `detached`; they are killed only per-card on `chat:stop` (3853) or on stream completion — never on quit.
- The renderer `beforeunload` handler (ChatTile 3345) only persists state; it does **not** call `chat:stop`.
- `src/main/ipc/terminal.ts:234` — `const terminals = new Map<string, TerminalSession>()` is cleaned only via `terminal:destroy`/`terminal:detach` IPC or WebContents `'destroyed'`, never iterated on quit.
- Missed by the original finding: the `OpenCodeServer` (chat.ts ~1648) has a SIGTERM→SIGKILL `.kill` (~1690) that is **also** not wired to `before-quit`.

**Recommendation (refined).** In `before-quit`, kill the **chat-side subprocesses** — the real leak. Export a `killAllChatProcesses()` from `chat.ts` that iterates `activeProcesses` with `SIGTERM` and a short `SIGKILL` fallback, and also stops the `OpenCodeServer` via its existing `.kill`. Note a bare `proc.kill('SIGTERM')` may not reap grandchildren these CLIs spawn — for robust cleanup spawn with `detached: true` and kill the process group (or use a tree-kill). For terminals, **only the direct-PTY fallback** (terminal.ts ~463, used when tmux is unavailable) needs `pty.kill` on quit. A blanket "iterate terminals calling `pty.kill`" is **wrong** — see critique.

**Verifier critique.** Evidence is real and the cited locations are accurate; the central gap is genuine and not addressed elsewhere. Refined (not confirmed) for two reasons:

1. **The recommendation misreads the terminal architecture, so the `pty.kill` half is impractical as written.** Default terminals are tmux-backed via `new-session -d` (detached); node-pty only *attaches* to the detached tmux session. Iterating `terminals` and calling `pty.kill()` would kill the attach client, not the work — a near no-op for the default path. tmux sessions surviving quit is **intentional by design** (terminal.ts detach comment ~576-577: "leaves tmux session alive ... so sessions survive restarts"), so listing surviving tmux sessions as a leak is incorrect. Only the direct-PTY fallback (~463) genuinely risks an orphan, and even there the child typically gets SIGHUP when the PTY master closes on parent death. The real, concentrated orphan risk is the pipe-stdio CLI agent subprocesses in `activeProcesses`, not the PTYs. A blanket PTY-kill would regress the deliberate session-survival behavior.

2. **Severity is medium, not high.** These `activeProcesses` spawns are bounded foreground per-turn agent runs; genuinely long-lived background work goes through the daemon path (`detachedDaemonAvailable` / `cancelChatDaemonJob`), not this map. Blast radius is "leftover CLI agent processes after the user quits with a turn in flight," not unbounded accumulation.

---

### rel-04 — Daemon SIGTERM shutdown does not kill in-flight chat-job subprocesses

**Severity:** medium · **Effort:** S · **Category:** process-lifecycle

Brief: `shutdown()` in `packages/codesurf-daemon/bin/codesurfd.mjs:3839-3866` only calls `removeOwnedPidFile()` and `server.close()` — it never cancels live chat jobs tracked in `liveJobs` (`packages/codesurf-daemon/bin/chat-jobs.mjs:728`). `cancelJob` (1645) and `listLiveJobIds` (1705-1707) exist but are unused by shutdown, so on SIGTERM/SIGINT/uncaughtException the spawned codex/hermes/opencode subprocesses and the Claude SDK subprocess keep running detached (reparented to init). The fix is small: iterate live jobs and call each `cancel`, exposing `cancelAllJobs` from the signal handlers. Verified: shutdown at 3842-3845 touches only the pid file and server.

**See also: the `daemon` section owns this** (cluster C3 — "Daemon shutdown/SIGTERM never cancels in-flight jobs, orphaning CLI/SDK child processes", shared with `daemon-02`). The deep write-up of root cause and remediation lives in the daemon section.

---

### rel-05 — `atomicWriteJson` temp-file path collides under concurrent same-process writers

**Severity:** medium · **Effort:** S · **Category:** atomic-write

Brief: `atomicWriteJson` derives its temp path from `filePath` + `process.pid` + `Date.now()` with no randomness. Within one process the pid is constant and `Date.now()` is millisecond-resolution, so two writes to the same target in the same millisecond produce the **same** temp path, overwrite each other, and rename non-atomically. The weak helper is duplicated verbatim across `packages/codesurf-daemon/bin/codesurfd.mjs:62`, `packages/codesurf-daemon/bin/chat-jobs.mjs:46`, and `src/main/permissions.ts:27`. Compounding it, `permissions.ts` `readPersistedStore`/`writePersistedStore` (66-76) is an unlocked read-filter-write — a lost-update race. Fix: make the temp suffix unique per call (random token or counter) and serialize same-file writers through a per-path async mutex. Verified: all three temp-path constructions use only pid + `Date.now()`.

**See also: the `duplication` section owns this** (cluster C4 — "Duplicated weak `atomicWriteJson` collides on same-millisecond same-process writes", shared with `dup-03`). The deep write-up of the duplication root cause (the daemon `.mjs` copies omit the `randomUUID` temp suffix used by the hardened `src/main/storage/jsonArtifacts.ts` version) lives in the duplication section.

---

## Quick wins

- **rel-03 (S, high):** Add an `AbortController` to `runClaudeTurn` `options`, `.abort()` on timeout, `clearTimeout` on settle — stops a silently billing leaked SDK subprocess on every relay-Claude timeout. Highest value-to-effort fix in this dimension.
- **rel-02 (S, medium):** Export `killAllChatProcesses()` from `src/main/ipc/chat.ts` and call it from `before-quit` (plus stop `OpenCodeServer`); leave tmux-backed terminals alone, kill only the direct-PTY fallback.
- **rel-04 (S, medium):** Wire `listLiveJobIds`/`cancelJob` into the daemon `shutdown()` so SIGTERM reaps in-flight chat jobs (coordinate with the daemon section).
- **rel-05 (S, medium):** Add a random/counter token to the `atomicWriteJson` temp suffix and a per-path write mutex; dedupe the helper (coordinate with the duplication section).
