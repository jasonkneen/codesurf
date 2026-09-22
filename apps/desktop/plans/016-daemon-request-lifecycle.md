# Plan 016: Make daemon requests and version replacement safe

> **Executor instructions**: Read this plan fully before editing. Work in the
> assigned isolated worktree. Preserve the daemon's loopback/authentication
> model and current public client methods. Do not merge or push.
>
> **Drift check**: `git diff --stat bc2d0a94..HEAD -- packages/codesurf-daemon/src/client.ts packages/codesurf-daemon/src/manager.ts packages/codesurf-daemon/bin/codesurfd.mjs packages/codesurf-daemon/bin/chat-jobs.mjs test/daemon`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: correctness, reliability, security hardening
- **Planned at**: commit `bc2d0a94`, 2026-07-30
- **Implemented at**: branch `advisor/epic-016-daemon`, final commit
  `39e6b2ac12500f938f39a05f3f61e3e4d638e46d`
- **Review result**: done in the isolated branch. Independent review first
  found unauthenticated PID signalling, a force restart lost behind an
  in-flight normal startup, and missing HTTP 408 outcome-unknown guidance. A
  final spot-check then found that shutdown removed `pid.json`/the lock too
  early for safe SIGKILL escalation. The final branch authenticates daemon
  identity before signals, queues forced replacement, preserves mutation
  ambiguity, retains authenticated identity throughout shutdown, and marks a
  shutting-down daemon non-reusable. Manager/client and HTTP fixtures pass
  45/45, both typechecks pass, and diff checks pass. The package aggregate still
  encounters the baseline duplicate import tracked by Plan 015.

## Why this matters

Three daemon boundary failures compound:

1. `createDaemonClient.request()` retries every method after transport/auth
   failures (`client.ts:62-100`). Retrying `/chat/job/start` can create two
   independent UUID jobs because `chat-jobs.mjs:2717-2756` has no idempotency
   key.
2. `ensureDaemonRunning()` recognizes app-version drift but only stops the
   existing daemon when `forceRestart` is true (`manager.ts:356-404`). It then
   spawns a child whose startup path reuses any healthy daemon regardless of
   version (`codesurfd.mjs:2796-2800,3848-3853`), so upgrades can fail or keep
   stale code alive.
3. `parseRequestBody()` buffers unlimited bytes before JSON parsing
   (`codesurfd.mjs:2802-2818`).

## Scope

In scope:

- `packages/codesurf-daemon/src/client.ts`
- `packages/codesurf-daemon/src/manager.ts`
- `packages/codesurf-daemon/bin/codesurfd.mjs`
- Focused daemon tests
- `chat-jobs.mjs` only if an idempotency-key map is chosen

Out of scope:

- Refactoring the full `codesurfd.mjs` or `chat-jobs.mjs`
- Changing the bearer-token/loopback security model
- Provider execution policy
- SSE backpressure or relay subprocess management

## Required design

### 1. Retry by operation semantics

Add an explicit retry policy to the private request options:

- GET/read-only requests may retry once under the existing status/transport
  conditions.
- Mutation requests default to no automatic retry.
- Idempotent mutations such as cancel may opt in only with a test proving
  duplicate delivery is harmless.
- `/chat/job/start` must never be delivered twice under one client call.

If preserving start retry is important, implement a client-generated
idempotency key, persist a bounded key-to-job mapping in the daemon, and return
the original job for a duplicate key. Do not use an in-memory-only key map that
loses protection across the exact restart scenario that triggers a retry.
The smaller acceptable implementation is no retry plus an actionable
"outcome unknown" error on timeout.

### 2. Replace mismatched versions deliberately

Treat a healthy daemon whose non-null `appVersion` differs from the current app
as a restart requirement even when `forceRestart` is false:

- Stop it using the existing TERM/KILL bounded flow.
- Clear cache/PID state only after confirmed exit.
- Re-check under the startup lock before spawning.
- The child startup reuse check must require matching app versions when
  `CODESURF_APP_VERSION` is set.
- A legacy daemon with null version may retain the current compatibility
  behavior, but cover that choice in a test.

Concurrent `ensureDaemonRunning()` calls must continue sharing one startup
promise.

### 3. Bound request bodies

Add one exported/central maximum body size of 1 MiB:

- Track cumulative bytes while chunks arrive.
- Stop buffering immediately once the limit is exceeded.
- Return HTTP 413 with a stable JSON error.
- Avoid sending a second 500 from the outer handler.
- Remove listeners or drain/destroy the request safely so no retained chunks or
  unhandled rejection remain.
- Empty and valid JSON behavior stays unchanged; invalid JSON remains a 4xx
  client error rather than a generic 500 if practical.

## Test plan

- A GET retries once after a simulated transient failure.
- `startChatJob` issues exactly one fetch when the first attempt times out or
  returns 503.
- Cancel/permission methods follow their declared retry policy.
- A healthy same-version daemon is reused.
- A healthy mismatched daemon is stopped before one replacement is spawned.
- Two concurrent ensure calls during drift spawn only one replacement.
- Child reuse rejects mismatched app version and accepts same version.
- A request at exactly 1 MiB parses; one byte over receives 413 and does not
  enter route handling.
- Chunked over-limit input is rejected before the full stream is accumulated.
- Empty body and malformed JSON retain deterministic responses.

Use fake fetch/process hooks for unit coverage and the existing daemon fixture
for one HTTP-level body-limit assertion.

## Verification

```bash
node --test test/daemon/daemon-client-chat-jobs.test.mjs
node --test test/daemon/codesurfd.test.mjs
npm --prefix packages/codesurf-daemon test
npm run typecheck
npm run typecheck:tsc
git diff --check
```

## Done criteria

- [x] Non-idempotent mutations cannot be replayed implicitly
- [x] Version drift stops the old daemon before spawn
- [x] Child reuse honors app version
- [x] Request bodies are capped with stable 413 behavior
- [x] Concurrency and legacy-version behavior are tested
- [x] Daemon and root typechecks pass

## STOP conditions

Stop and report if:

- Preserving public behavior requires a durable idempotency store larger than
  this plan's bounded mapping.
- A mismatched daemon cannot be stopped with the existing bounded lifecycle.
- Tests would rely on killing an unrelated host daemon; fixtures must use an
  isolated `CODESURF_HOME`.
- The body limit breaks an existing documented route payload over 1 MiB. Report
  the route and measured legitimate size before changing the limit.
