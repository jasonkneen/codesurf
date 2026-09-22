# CodeSurf tools and LSP source review

Date: 2026-09-05. Reviewer: GPT-6 Astra (Leo). Scope is the production code in `src/tools` and `src/lsp`, with selected caller/test inspection. This is source review, not executed reproduction, implementation, or a complete repository review. Product implementation remains assigned to the owner's requested Spark model.

## Coverage

All 11 production files in these directories were read. Tests were selectively inspected for existing coverage and caller contracts; the test files were not exhaustively reviewed.

| File | Reviewed surfaces |
|---|---|
| `src/tools/bash.ts` | Foreground/background shell execution, cancellation, log ownership, process limits, cleanup, Shuru wrapping/host exception, ripgrep shortcut/parser |
| `src/tools/computer.ts` | All 12 desktop command adapters, screenshot paths, subprocess runner, cancellation, argument construction and environment allowlist |
| `src/tools/file.ts` | Chunked reads, limits/decoding, edits/writes, approval preview/diffs, LSP synchronization |
| `src/tools/grep.ts` | Argument construction, search roots, subprocess/error/cancellation ownership, JSON framing, caps, output ordering |
| `src/tools/schedule.ts` | CRUD/migration, paths, daemon PID lifecycle, detached launch/log descriptors, cron parser/matching, persistence |
| `src/lsp/builtins.ts` | Every built-in/custom definition, binary resolution, auto-install and root discovery |
| `src/lsp/client.ts` | Process/JSON-RPC startup, initialization, document versions/diagnostics, cancellation, shutdown |
| `src/lsp/manager.ts` | Client promise cache, queries/document synchronization, token bridge, eviction and close |
| `src/lsp/runtime.ts` | Global manager registry, workspace keying, settings snapshot and shutdown |
| `src/lsp/npm-cache.ts` | Cache binary selection, install locking and Arborist policy; known home-root test isolation issue referenced in baseline |
| `src/lsp/types.ts` | Query/operation/configuration/session DTO contracts |

Adjacent caller inspection: `src/core/extensions/native/file-tools.ts` exposes absolute paths explicitly and does not pass signals into file operations; `lsp-tool.ts` routes the AbortSignal into query; Agent invokes LSP shutdown. Existing tests cover basic file replacement, shell host classification and parser cases, computer argument/env construction, scheduling and LSP manager behavior. The scenarios below require dedicated regressions.

## Findings requiring repair

### T1 — P1: Browser-only host exception accepts additional shell programs

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/bash.ts`. `shouldRunOnHostInSandboxMode` now splits on every shell boundary the host shell honors (newline, `;`, single `&`, `|`, `<`, `>`, and their doubled forms) with a quote-aware, backslash-aware scanner (`splitHostShellSegments`), rejects process substitution (`<(`/`>(`) alongside command substitution, and refuses unbalanced quotes. Quoted operators (query strings in URLs) stay literal. Regressions: `src/tools/bash.test.ts` (`shouldRunOnHostInSandboxMode boundary parsing`). Argv-structured launch was not adopted; the shell-function wrapper is unchanged.

`src/tools/bash.ts:522`, `shouldRunOnHostInSandboxMode`, splits several shell operators but omits newline and single `&`. Its allowed-segment check matches only a prefix. With `hostBrowserCommandsOnHost` enabled, a command beginning `agent-browser --help` followed by a newline and an unrelated command is accepted; `prepareCommand` then executes the whole string on the host. A single background operator similarly hides a following command inside the accepted segment. This breaks the stated browser-specific exception to Shuru execution. No such command was executed during this review.

Repair: represent the allowed browser invocation structurally and launch argv directly; do not decide shell-program authority with prefix regexes. If shell composition remains supported, parse every operator and reject unsupported grammar. Regression: classifier or mocked execution tests for newline, single `&`, escaped newline, comments, quoted operators, redirects and ordinary browser argv; unrelated commands must never reach host exec.

### T2 — P1: Literal edit replacement text is interpreted as replacement syntax

Implementation status: repaired by the direct Spark collaboration worker. Execution and preview share literal substitution; empty search text is rejected. Parent validation passed 24 focused file/extension tests, typecheck, build and lint. See the baseline's Spark execution section. The following description records the reviewed pre-fix behavior.

`src/tools/file.ts:255` and `336` use `before.replace(oldString, newString)` for execution and approval preview. JavaScript treats `$&`, `$$`, dollar-backtick and dollar-apostrophe in replacement strings specially. Replacing `TOKEN` with literal `$&` writes `TOKEN` instead; code containing replacement syntax can therefore be silently corrupted while both preview and execution agree on the wrong result.

Repair both paths using a replacement callback returning the literal new text. Regression: each special sequence, mixed ordinary text and Unicode, with exact bytes and preview/result agreement. Reject an empty old string explicitly: `split("")` does not implement the documented unique-substring contract.

### T3 — P1: LSP shutdown can block application teardown indefinitely

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/lsp/client.ts`. `stop()` is now a shared idempotent promise: bounded `shutdown` request (`shutdownTimeoutMs`, default 3s), fire-and-forget `exit`, connection disposal, then SIGTERM and SIGKILL escalation each awaiting actual process exit (`exitGraceMs`, default 2s). Pending diagnostics waiters are released. Regression: `src/lsp/client.test.ts` drives a real child that answers `initialize` but ignores `shutdown` and SIGTERM; stop() completes in well under a second with the test's short grace values, and concurrent callers share one teardown.

`src/lsp/client.ts:240-259` awaits `connection.sendRequest("shutdown")` before disposing the connection or terminating the process, without a deadline. A live but stalled server can prevent `WorkspaceLspManager.close` and its caller from finishing forever. Startup has a timeout; normal shutdown does not.

Repair: shared idempotent stop promise with bounded graceful shutdown, then connection disposal and TERM/KILL escalation while awaiting actual process exit. Drain diagnostics waiters/timers. Regression: fake server ignores shutdown, ignores TERM, exits early, and concurrent stop callers all join the same bounded teardown.

### T4 — P1: LSP request failure loses ownership of a running server

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/lsp/manager.ts`. A `classifyFailure` helper separates cancellation and request-level protocol errors (client kept, outcome reported honestly) from transport death; eviction removes the cache entry only when it still references that record's own startup promise and then explicitly stops the instance, so a stale failure cannot evict a replacement and `query` no longer reports a failure as `No results found`. Regression: `src/lsp/manager.test.ts` (`createWorkspaceLspManager request failures`). Remaining: with a real client an in-flight request still hangs when the server dies mid-request, because the connection is not disposed on close.

`src/lsp/manager.ts:138`, `184`, `192` delete the cached client on document/request errors without stopping it. The operation may fail while the server remains healthy (including normal request cancellation or unsupported method). A later query starts another server; close can no longer reach the removed client. Query also converts request errors into `success: true` / “No results found,” concealing cancellation and protocol errors.

Repair: distinguish ordinary request/cancellation failures from transport death. Keep healthy clients, report failure/cancelled outcomes honestly, and explicitly stop genuinely evicted instances. Delete only if the cache still references that exact instance, so stale failures cannot evict replacements. Regression: cancelled query, unsupported method, transport failure/reconnect and stale A failure after B replacement; count starts/stops and final owned clients.

### T5 — P1: Shell process cleanup does not own descendant processes

`src/tools/bash.ts:118`, `155-168`, `206`, `311-325`, `365-380` launch shell commands then signal only the shell ChildProcess. Background commands explicitly use `detached: false`; no process-tree strategy exists. A shell that spawns a persistent child can exit on TERM while the descendant continues running. Foreground cancellation can additionally wait on inherited output pipes held by that descendant. Marking the shell exited does not establish that the command's work stopped.

Repair: platform-appropriate owned process groups/job objects or a tested process-tree manager; cancel/stop/cleanup must await the owned tree. Regression: child spawns grandchild with inherited pipes, then root exits; cancellation and cleanup leave neither process alive. Use controlled temporary fixtures, not arbitrary system processes.

### T6 — P2: Already-aborted desktop commands still execute

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/computer.ts`. Every desktop command checks `abortSignal.aborted` before any side effect, including screenshot directory creation and the runner spawn; the runner is injectable, wires the abort listener atomically, and joins a bounded SIGTERM/SIGKILL teardown before reporting cancellation. Regression: `src/tools/computer.test.ts` (`createAgentDesktopRunner`).

`src/tools/computer.ts:537-587` starts `execFile` and only registers an abort listener; it never checks `abortSignal.aborted`. DOM AbortSignals do not replay an already-fired event for new listeners. A desktop click/type operation reached after cancellation may still execute. Screenshot path creation happens even earlier (`145`, `445-449`). In-flight abort returns immediately after TERM, with neither forced shutdown nor awaited exit.

Repair: guard before side effects/spawn, wire abort atomically, and join bounded process teardown before reporting cancellation. Regression: already-aborted signal causes zero runner spawn and zero screenshot directory creation; stubborn fake runner is terminated before completion resolves.

### T7 — P2: Unmarked workspaces share a manager rooted at filesystem root

**Implementation status (2026-09-05, resumed in Claude Code):** partially repaired in `src/lsp/runtime.ts`. `resolveManagerKey` returns the original cwd when no `.codesurf`, `.grok` or `.git` ancestor exists instead of climbing to the filesystem root, and `.codesurf` is recognized as a workspace marker, so two unmarked projects get separate managers, settings snapshots and shutdown. Regression: `src/lsp/runtime.test.ts`. Remaining, and deliberately deferred: workspace identity is still not aligned with CodeSurf's workspace service, and manager lifetimes have no explicit owners or refcounts. The user-visible defect — two unmarked projects sharing one manager rooted at `/` — is fixed and tested. What is left is a design alignment: `resolveManagerKey` and `ctx.workspace` would need one definition of workspace identity between them, and that definition belongs to the package-boundary phase, which has not run. Doing it now would fix nothing observable and would have to be redone against whatever that phase decides.

`src/lsp/runtime.ts:63-73`, `resolveManagerKey`, climbs until `.git` or `.grok`; if no marker exists, it returns `/` (or drive root) rather than the original working directory. Separate non-repository projects therefore share the same manager/settings snapshot; custom/default root fallback can become `/`. Shutting down one can stop clients used by the other. `.codesurf` alone is not recognized either.

Repair: retain original cwd as fallback, define workspace identity consistently with CodeSurf's workspace service, and give manager lifetimes explicit owners/refcounts. Regression: two markerless temporary projects have isolated clients/settings/shutdown, plus nested repository roots and `.codesurf`-only workspaces.

### T8 — P2: Cancellation does not cover LSP startup/document synchronization, and listeners accumulate

**Implementation status (2026-09-05, resumed in Claude Code):** partially repaired in `src/lsp/manager.ts`. `query` returns a cancelled result before discovery when the signal is already aborted and re-checks it after the shared startup await and after document sync, so no request is sent for a cancelled query while the started server stays cached; the abort listener is a named function removed in `finally`, so repeated queries sharing one turn signal leave its listener count unchanged. Regression: `src/lsp/manager.test.ts` (`createWorkspaceLspManager cancellation`). **Closed 2026-09-05.** The last gap — an un-raced in-progress wait — is repaired with `raceAbort` in `src/lsp/manager.ts`: both the shared startup wait and the document-sync/diagnostics wait now end the moment the signal fires, instead of when the await happens to settle (seconds, for a cold server install). The underlying promise is deliberately not cancelled, so startup stays owned by the client cache and other live callers keep their server; a rejection handler is always attached so an abandoned wait cannot surface as an unhandled rejection. Regression: `src/lsp/manager.test.ts` ("stops waiting on a startup that never settles", "stops waiting on a diagnostics wait that never settles") — both leave the promise pending forever, which is what makes them discriminating; the two pre-existing cancellation tests resolved their deferred after aborting and passed even un-raced.

`src/lsp/manager.ts:147-168` waits for root discovery/install/client startup before constructing cancellation state, then performs an uncancellable `touchFile` and diagnostics wait. An already-aborted request can still auto-install/start a server. The anonymous abort listener at line 163 is never removed in `finally`; disposing the CancellationTokenSource does not remove that EventTarget listener. Many completed queries sharing one turn signal retain closures until abort.

Repair: check cancellation before discovery and after awaited boundaries; propagate it into startup and document/diagnostic synchronization where operations belong to the request, while retaining shared startup ownership for other live callers. Store/remove the listener explicitly. Regression: abort before query/during startup/during diagnostics, and repeated completed queries leave the original listener count unchanged.

### T9 — P2: Grep presents invalid search and truncated search as complete success

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/grep.ts`. Ripgrep's exit code 2 with its stderr is reported as a failure (or, with partial matches, as an explicit incomplete-search notice) instead of `No matches found`, `--no-messages` was dropped so that stderr survives, and collection returns an explicit capped flag so a capped run says the total is unknown rather than claiming exactly 100 matches. Regression: `src/tools/grep.test.ts` (`executeGrep with a fake ripgrep`).

`src/tools/grep.ts:232` accepts ripgrep exit code 2, so malformed regex or invalid search path can become `success: true, "No matches found."` instead of an error. Separately, collection stops at 100 matches (`206`) while truncation is computed as `rows.length > 100` (`131-132`), making the truncation notice unreachable on the capped path. “Found 100 matches” can omit arbitrarily many results without warning; modification-time sorting applies only to the first collected subset.

Repair: error/partial-result state must include stderr and non-success exit; return an explicit capped flag from collection, or collect one lookahead result, without claiming an exact total. Regression: invalid regex, nonexistent path, partial matches plus read error, exactly 100 and 101+ matches, and cap-induced termination distinguished from user cancellation.

### T10 — P2: File-read output limits do not bound work or accurately describe returned lines

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/file.ts` and wired at the call site in `src/core/extensions/native/file-tools.ts`. The reader keeps at most one display line of pending text (discarding the rest of an overlong line), stops scanning once the output-line, byte or end-line limit is reached, reports either `lines a-b of N` when the scan reached end of file or `lines a-b; total not counted` otherwise, and accepts an `AbortSignal` checked before opening and before every chunk — which the `read_file` tool now passes from its execution context. Regression: `src/tools/file.test.ts` (`readFile output limits`). Remaining: the very-large-single-line and UTF-8-split cases act as regression guards rather than red-then-green proofs; the bounded-accumulation property is evidenced by measurement.

`src/tools/file.ts:145-195` appends an arbitrarily long unbroken line to `pending` before applying the 2,000-character display cap. Large minified/text files can consume memory proportional to the whole line and repeated concatenation work. Hitting 2,000 output lines does not stop scanning unless byte/end-line limits also fire. Headers use scanned `totalLines`, not the last emitted row; a 3,000-line short-line file may claim lines 1–3000 while returning only 2,000. A requested early range stops scanning yet labels the scanned prefix as the total file line count. No read AbortSignal is available.

Repair: bounded line accumulation with truncation state, abortable reads and accurate returned-range/unknown-total metadata. Decide explicitly whether a full count is worth an extra scan; do not imply it was measured. Regression: very large single line, 3,000 short lines, early range within a larger file, UTF-8 split at chunk boundary and cancellation while scanning; assert output bounds and honest headers.

### T11 — P2: Background launch races exceed limits and lose temporary-directory ownership

`src/tools/bash.ts:49-53` initializes `tmpDir` after awaited `mkdtemp`, without an in-flight promise. Concurrent first launches can create multiple directories while only one is retained for final cleanup. The eight-process check at `188` runs before the await and inserts no reservation, so concurrent calls can all pass and exceed the cap. `cleanup` snapshots entries and does not close admission, allowing an in-flight launch to appear after the snapshot and be cleared without termination. Finally cleanup removes `tmpDir` without resetting it, so reusing the object attempts logging into a removed directory.

Repair: serialize or reserve launch admission, share temporary-directory initialization, and model open/closing/closed ownership. Either forbid use after close or reinitialize safely. Regression: concurrent launches across the cap, cleanup during delayed directory creation, repeated cleanup and documented post-cleanup behavior; no untracked children/directories remain.

### T12 — P2: Detached schedule spawn failures are unhandled

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/schedule.ts`. Detached launches await a spawn/error handshake before reporting success, so an invalid working directory or a failed daemon start rejects instead of emitting an unhandled `error` event, the parent's log descriptor ownership is preserved, and `lastRunAt` is written only after a launch actually succeeded. Regression: `src/tools/schedule.integrity.test.ts` (`T12: detached spawn handshake`).

`src/tools/schedule.ts:363-370` and `443-450` spawn and unref without attaching `error` listeners or awaiting the `spawn` event. An invalid/deleted working directory can asynchronously emit an unhandled error; the headless helper may already have returned a null PID and caller may have recorded lastRunAt. Synchronous try/finally only closes the parent's log descriptor and cannot catch the ChildProcess event.

Repair: await spawn/error handshake before returning success, preserve fd ownership, and write run metadata only after successful launch. Regression: directory disappears after validation, injected spawn failure, daemon startup failure and successful child launch; no unhandled rejection/event and no false successful run timestamp.

### T13 — P2: Schedule PID file can identify an unrelated reused process

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/schedule.ts`. The daemon pid file records a verifiable identity (pid plus start time) written under an exclusive lock, and status and stop verify that identity — probing the process's elapsed time — before classifying or signalling, so a stale pid file whose number has been reused is refused rather than terminated; a legacy numeric pid file is treated as unverifiable and never signalled. Regression: `src/tools/schedule.integrity.test.ts` (`T13: daemon identity`).

`src/tools/schedule.ts:333-347` treats `kill(pid, 0)` as proof the PID is this daemon; stop at `394-405` sends TERM/KILL to that PID. A stale PID file whose numeric PID has been reused is sufficient to target another process. The current-process check does not establish daemon identity.

Repair: authenticated local control endpoint or verifiable daemon identity/start-time token, with atomic single-owner startup. Regression: stale file points at a controlled non-daemon fixture; status/stop must refuse to classify/terminate it. Also exercise simultaneous starts and replacement daemon during stop polling.

### T14 — P2: Schedule writes race and can overwrite state changes

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/schedule.ts`. Per-record updates are serialized through a lock and committed with a temp-file rename, and creation is exclusive, so a deferred `lastRunAt` write cannot resurrect an `enabled: false` record, two same-name creations start exactly one schedule, and an interrupted write leaves the previous valid record in place. Regression: `src/tools/schedule.integrity.test.ts` (`T14: record persistence`).

`src/tools/schedule.ts:255-264` reads a full record then writes it with lastRunAt, while enable/disable and other writers independently do the same. A daemon tick holding an old `enabled: true` snapshot can overwrite a concurrent disable. `create` separately checks existence and writes, allowing concurrent same-name launches. `writeScheduleRecord:652-656` truncates/replaces directly, so readers can observe incomplete JSON and treat the record as absent.

Repair: per-record serialized/transactional updates and exclusive creation, with atomic replace for read consistency. Account for multiple processes, not just a module mutex. Regression: deferred timestamp update races with disable, same-name concurrent creation starts once, interrupted writes retain the previous valid record.

## Additional correctness and performance observations

- `src/lsp/client.ts:80` sends the server child's PID as initialize `processId`; this field describes the client parent. Servers relying on parent liveness monitoring cannot detect client exit correctly. Send the CodeSurf process PID and assert the initialize payload in a fake-server test. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/lsp/client.ts`: the initialize request now sends the CodeSurf process pid, so a server monitoring its client's liveness watches the right process. Regression: `src/lsp/client.test.ts`.
- `src/lsp/manager.ts:212` has no closing flag: close snapshots clients before awaiting; root resolution already in flight can subsequently insert a new client omitted from that snapshot. Add an epoch/admission check and dispose stale startups. Test delayed resolveRoot across close. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/lsp/manager.ts`: `close` sets a closing flag and epoch, so a root resolution already in flight cannot insert a client after the shutdown snapshot; the late startup is disposed instead. Regression: `src/lsp/manager.test.ts`.
- `src/tools/schedule.ts:239` reads and splits the entire run log to return a short tail. Use a bounded backwards reader as Bash logs already do; measure large-log memory. Cron parsing accepts trailing junk via `parseInt` (for example `1garbage`) and ignores a third dash component in ranges. Require whole-token grammar and test invalid inputs without launching any jobs. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/schedule.ts`: the run log tail is read backwards with a byte bound instead of loading the whole file, and cron fields require whole-token grammar so `1garbage` and three-part ranges are rejected. Regression: `src/tools/schedule.integrity.test.ts` (`observations: bounded log tail and cron grammar`).
- `src/tools/bash.ts:58` intercepts every string beginning `cd `, so common `cd directory && command` is treated as a literal directory name and never executes. It also changes cwd before checking cancellation. Recognize only a complete standalone cd invocation; defer compound shell programs to the shell and guard cancellation before/after filesystem awaits. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/bash.ts`: only a complete standalone `cd` invocation is intercepted (`parseStandaloneCd`), so `cd dir && cmd` is handed to the shell and runs, and cancellation is checked before and after the filesystem await. Regression: `src/tools/bash.test.ts` (`parseStandaloneCd`) and `src/tools/bash.lifecycle.test.ts`.
- `src/tools/grep.ts:197` decodes each Buffer independently and limits JSON record length only after buffering to newline. Split UTF-8 can be replaced, and a huge match line can allocate far beyond `MAX_RECORD_BYTES`. Use streaming decoding and bounded oversized-record discard with an explicit skipped-result indication. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/tools/grep.ts`: output is decoded with a streaming decoder so a multi-byte character split across chunks survives, and an oversized JSON record is discarded with a bounded buffer and an explicit skipped-record notice. Regression: `src/tools/grep.test.ts`.
- `src/lsp/builtins.ts` command overrides without explicit args still perform default resolver/possible installation first. Derive override argv defaults before optional discovery; a configured executable should not need an unrelated auto-install to finish. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/lsp/builtins.ts`: a configured command override derives its argv defaults before any optional discovery, so it no longer waits on an unrelated auto-install. Regression: `src/lsp/builtins.test.ts`.

## Containment and policy conclusions

File tools explicitly accept absolute paths, and the Bash description says dedicated file writes persist on the host even in Shuru mode. Therefore an absolute file path or `..` by itself is not established here as a permission bypass. Screenshot output paths likewise accept caller-selected destinations. A workspace confinement policy, if desired, belongs in a shared authorization service with realpath/symlink handling, not ad hoc prefixes added during migration.

Schedule IDs have separator-aware lexical containment, and generated IDs are restricted. Do not report a generic `startsWith` sibling-directory bug here: the actual check includes `path.sep`. It is not a complete defense against preexisting symlink paths, but no separate reachable symlink exploit was demonstrated in this pass. LSP package names used by built-ins are fixed; exported npm helper strings alone do not establish an untrusted path-traversal route. `ignoreScripts: true` is already set for auto-installs.

Computer commands use `execFile` argv plus an environment allowlist, both worth preserving. The actual host-shell boundary defect is T1. The known npm-cache home isolation issue is recorded in [the baseline](2026-09-05-codesurf-review-baseline.md) and the main migration plan, not duplicated here as a new finding.

## Recommended implementation order and acceptance

Repair T1/T2 with small deterministic regressions first. Establish shared process and LSP lifetime owners for T3–T8/T11, then fix grep/file boundedness and honest outcomes, then schedule process identity/transactional persistence. Carry these behaviors into native Cordis effects and services; a lifecycle wrapper cannot repair lost descendant ownership, unbounded shutdown or shared mutable state by itself.

Each repaired finding needs its stated scenario tested, typecheck/build/lint, and relevant focused suites. Broader suites follow each coherent migration wave. Process tests must use owned temporary fixtures; no test may signal unrelated processes or depend on real-home cache writes. Source evidence here is sufficient to prioritize work, but runtime reproduction and repaired-behavior evidence remain pending.
