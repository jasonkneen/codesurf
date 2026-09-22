# Plan 007: Persist `isStreaming: false` on Codex aborted/failed turns

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 77e3c7d..HEAD -- src/main/chat/providers/codex.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `77e3c7d`, 2026-07-01

## Why this matters

When a Codex turn fails (a `turn.failed`/`error` event from the CLI, or a
checkpoint-creation failure), the provider sets a local `aborted` flag and the
process-close handler returns early — *before* the code that flips the persisted
runtime session's `isStreaming` back to `false`. The live UI recovers (the
renderer's error handler stops its own spinner), but the **persisted** session
state keeps `isStreaming: true` forever. On app restart / session rehydration,
the renderer reads that persisted flag and reopens the tile as permanently
"streaming" with nothing running. The Claude provider sets `isStreaming = false`
on every terminal path; Codex is the asymmetric one.

## Current state

- `src/main/chat/providers/codex.ts` — Codex CLI provider. The bug is in the
  `proc.on('close', ...)` handler.
- `src/main/chat/runtime.ts` — `upsertRuntimeSessionState(req, runtimeSession)`
  persists the runtime session (called from all providers).
- `src/renderer/src/hooks/useAppSessionOrchestration.ts:239` — on rehydrate:
  `shouldOpenPermanent = persist || nextChatState.isStreaming === true` — this is
  the consumer that makes the stale flag user-visible.

The `aborted` flag is set at two places in `codex.ts`:

```ts
// codex.ts:387
let aborted = false

// codex.ts:393-399 — turn.failed / error event
if (evt.type === 'turn.failed' || evt.type === 'error') {
  const msg = evt.error?.message ?? evt.message ?? `Codex event: ${evt.type}`
  aborted = true
  sendStream(req.cardId, { type: 'error', error: String(msg) })
  return
}

// codex.ts:433-438 — checkpoint failure
if (!checkpoint.ok) {
  aborted = true
  proc.kill('SIGTERM')
  sendStream(req.cardId, { type: 'error', error: `Checkpoint creation failed before Codex file changes: ...` })
  return
}
```

The close handler (codex.ts:552-577) — note the early return in the `aborted`
branch skips the `isStreaming = false` + persist that the normal path runs:

```ts
proc.on('close', (code) => {
  if (!isCurrent()) return // superseded — new turn owns the slot
  if (aborted) {
    activeProcesses.delete(req.cardId)
    return                                    // ← BUG: never persists isStreaming=false
  }
  activeProcesses.delete(req.cardId)
  stdoutChain = stdoutChain.then(async () => {
    ...
    runtimeSession.isStreaming = false        // ← normal path does this
    void upsertRuntimeSessionState(req, runtimeSession)
    ...
```

There is also a `proc.on('error', ...)` handler near codex.ts:602-603 which DOES
set `isStreaming = false` and persist — use it as the in-file pattern to copy.

Repo conventions: 2-space indent, no semicolons, strict TS. Unit tests are
`node --test` files under `test/`, importing pure modules from `src/` with
explicit `.ts` extensions (see `test/chat-output-sanitizers.test.ts` for the
shape). Modules that import `electron` cannot be imported by unit tests directly.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (if node_modules missing) | `npm install` | exit 0 (runs electron-rebuild; slow) |
| Typecheck | `npm run typecheck` | no NEW errors mentioning `codex.ts` (baseline has pre-existing errors elsewhere — gauge per-file, not by exit code) |
| Targeted test | `node --test test/<file>.test.ts` | all pass |

## Scope

**In scope** (the only files you should modify):
- `src/main/chat/providers/codex.ts`
- `test/codex-abort-state.test.ts` (create — only if Step 3's extraction is done; see Test plan)

**Out of scope** (do NOT touch):
- `src/main/chat/providers/claude.ts`, `opencode.ts` — already correct.
- `src/main/chat/runtime.ts` — the persistence layer is fine.
- `src/renderer/**` — the renderer workaround at `useChatStreamHandler.ts:245` stays.

## Git workflow

- Branch from `main`: `fix/codex-abort-isstreaming`
- Single commit, imperative style matching repo history (e.g. "Persist isStreaming=false when Codex turn aborts")
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the aborted branch of the close handler

In `src/main/chat/providers/codex.ts`, inside `proc.on('close', ...)`, change the
aborted early-return so it also clears and persists the streaming flag:

```ts
if (aborted) {
  activeProcesses.delete(req.cardId)
  runtimeSession.isStreaming = false
  void upsertRuntimeSessionState(req, runtimeSession)
  return
}
```

Keep the `activeProcesses.delete` ordering as-is. Do not touch the non-aborted
path.

**Verify**: `grep -n "if (aborted) {" src/main/chat/providers/codex.ts` → the
close-handler occurrence is followed within 4 lines by `runtimeSession.isStreaming = false`.

### Step 2: Typecheck

**Verify**: `npm run typecheck` → zero errors mentioning `src/main/chat/providers/codex.ts`.

## Test plan

`codex.ts` imports Electron-adjacent modules, so a direct unit test is not
feasible without refactoring. Do the minimal honest thing:

- If a pure helper can be extracted trivially (e.g. a `finalizeAbortedTurn(session)`
  function that flips the flag), extract it and add
  `test/codex-abort-state.test.ts` asserting it sets `isStreaming` to `false`.
- If extraction would touch more than ~15 lines, skip the new test and note
  that in the README status row ("fixed without new test — manual verification").
- Manual verification (if you can run the app): start a Codex chat, force a
  failure (e.g. invalid model), quit and relaunch — the tile must NOT reopen in
  a streaming state.

## Done criteria

- [ ] The `if (aborted)` branch in the close handler persists `isStreaming = false`
- [ ] `npm run typecheck` shows no new errors in `codex.ts`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- The close handler no longer contains an `if (aborted)` early-return (code drifted).
- `upsertRuntimeSessionState` is no longer the persistence call used by the
  normal close path.
- Fixing this appears to require changes in `runtime.ts` or the renderer.

## Maintenance notes

- Any new terminal path added to the Codex provider (new event type, new kill
  path) must set `isStreaming = false` and persist — consider consolidating all
  terminal paths through one `finalizeTurn()` helper if a third asymmetry appears.
- Reviewer should check: the aborted branch persists exactly once (no double
  `upsertRuntimeSessionState` if close fires after an error event already persisted).
