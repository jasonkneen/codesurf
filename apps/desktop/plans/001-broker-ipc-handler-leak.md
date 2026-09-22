# Plan 001: Remove stale ipcMain handlers when broker extension deactivates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, reply with the required report format.
>
> **Drift check (run first)**: `git diff --stat 9d8a613..HEAD -- src/main/extensions/broker/host.ts`
> If this file changed since the plan was written, compare "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9d8a613`, 2026-06-12

## Why this matters

When an extension is disabled (or crashes and the broker cleans up), `deactivate()` calls `ctx?.dispose()` but never calls `ipcMain.removeHandler()` for the IPC channels the extension registered. On the next activation cycle, `ipcMain.handle()` throws `"Attempted to register a second handler for 'ext:…'"` because the stale handler from the first run is still registered. Extensions that use `ctx.ipc.handle()` cannot be safely disabled and re-enabled within the same Electron session.

Additionally, the stale handler closure still captures the dead `peer` reference. If a renderer sends a message to that channel before re-activation replaces the handler, the handler will attempt to call `peer.call(...)` on a closed peer and throw.

## Current state

**File: `src/main/extensions/broker/host.ts`**

The `handleChildCall` dispatcher at ~line 284 handles the `ipc.handle` capability:

```typescript
// host.ts ~line 284-296
case 'ipc': {
  if (method !== 'handle') throw new Error(`Unknown ipc method: ${method}`)
  const [fullChannel] = args as [string]
  // Register directly with ipcMain — ExtensionContext.ipc.handle namespaces
  // with ext:{id}:, but the child already sends the full channel.
  ipcMain.handle(fullChannel, async (_event, ...ipcArgs) => {
    const result = await peer.call<{ returnValue: JsonValue }>('broker.invokeIpc', {
      channel: fullChannel,
      args: ipcArgs as JsonValue[],
    }, 30_000)
    return result.returnValue
  })
  return { ok: true }
}
```

The `deactivate()` method at ~line 153 does NOT remove these handlers:

```typescript
// host.ts ~line 153-181
async deactivate(): Promise<void> {
  if (!this.active) return
  this.deliberateExit = true
  this.active = false

  const peer = this.peer
  const child = this.child
  const ctx = this.ctx

  // Clear references before async work so re-entry is safe
  this.peer = null
  this.child = null
  this.ctx = null

  if (peer) {
    try {
      await peer.call('broker.deactivate', { extensionId: this.manifest.id, reason: 'deactivate' }, 5_000)
    } catch {
      // Ignore — kill the child anyway
    }
    peer.close('deactivated')
  }

  if (child) {
    child.kill()
  }

  ctx?.dispose()
}
```

The `cleanup()` method at ~line 372 also does NOT remove them:

```typescript
// host.ts ~line 372-373
private cleanup(): void {
  this.peer?.close('cleanup')
  // ...rest of cleanup
}
```

**Conventions to follow:**
- TypeScript, 2-space indent, no semicolons, trailing commas
- Class fields declared with explicit types
- Private fields prefixed with no special sigil — `private ipcChannels: string[]`

## Commands you will need

| Purpose    | Command                                      | Expected on success       |
|------------|----------------------------------------------|---------------------------|
| Typecheck  | `npm run typecheck`                          | exit 0 (or same errors as baseline — see note) |
| Tests      | `node --test test/broker-*.test.ts test/broker-*.test.mjs` | all pass |

**Typecheck baseline note**: `npm run typecheck` currently reports ~9 pre-existing errors in `App.tsx`, `AppCanvasConnections.tsx`, `useAppWorkspaceOrchestration.ts`, and `useTitleTooltips.ts`. These are pre-existing and NOT caused by this plan. The plan passes typecheck if it introduces no NEW errors beyond the baseline. After running typecheck, verify that any errors shown exist in files outside the in-scope list.

## Scope

**In scope** (the only files you should modify):
- `src/main/extensions/broker/host.ts`
- `test/broker-host-integration.test.mjs` (add test case)

**Out of scope** (do NOT touch):
- `src/main/extensions/context.ts` — has its own ipc handler tracking; do not merge
- `src/main/extensions/broker/child-entry.ts`
- Any other file

## Git workflow

- Branch: work in whatever worktree branch you were given
- Commit message style (match repo): `fix(broker): remove ipcMain handlers on extension deactivate`
- Do NOT push or open a PR

## Steps

### Step 1: Add `ipcChannels` tracking field to `ExtensionBrokerHost`

Locate the class declaration in `src/main/extensions/broker/host.ts`. It has a block of `private` field declarations near the top (look for `private active`, `private child`, `private peer`, `private ctx`, etc.).

Add one new private field:

```typescript
private ipcChannels: string[] = []
```

Place it with the other private fields, after `private ctx`.

**Verify**: `grep -n "ipcChannels" src/main/extensions/broker/host.ts` → shows the new field declaration.

### Step 2: Track registered IPC channels

In the `case 'ipc':` block (around line 284-296), after the `ipcMain.handle(fullChannel, ...)` call and before `return { ok: true }`, add:

```typescript
this.ipcChannels.push(fullChannel)
```

So the case block becomes:
```typescript
case 'ipc': {
  if (method !== 'handle') throw new Error(`Unknown ipc method: ${method}`)
  const [fullChannel] = args as [string]
  ipcMain.handle(fullChannel, async (_event, ...ipcArgs) => {
    const result = await peer.call<{ returnValue: JsonValue }>('broker.invokeIpc', {
      channel: fullChannel,
      args: ipcArgs as JsonValue[],
    }, 30_000)
    return result.returnValue
  })
  this.ipcChannels.push(fullChannel)
  return { ok: true }
}
```

**Verify**: `grep -n "ipcChannels.push" src/main/extensions/broker/host.ts` → shows the push line.

### Step 3: Remove handlers in `deactivate()` and `cleanup()`

In `deactivate()`, before or after `ctx?.dispose()`, add the cleanup:

```typescript
for (const ch of this.ipcChannels) {
  ipcMain.removeHandler(ch)
}
this.ipcChannels = []
```

In `cleanup()`, add the same block (the crash path). Locate `cleanup()` (around line 372) and add it there too, before or after `this.peer?.close('cleanup')`.

**Verify**:
- `grep -n "removeHandler" src/main/extensions/broker/host.ts` → shows two occurrences (one in deactivate, one in cleanup)
- `grep -n "ipcChannels = \[\]" src/main/extensions/broker/host.ts` → shows two resets

### Step 4: Run typecheck

```bash
npm run typecheck 2>&1
```

Confirm that any errors shown are in files outside the in-scope list (`App.tsx`, `AppCanvasConnections.tsx`, `useAppWorkspaceOrchestration.ts`, `useTitleTooltips.ts`). If a NEW error appears in `broker/host.ts`, fix it before continuing.

**Verify**: No new errors in `src/main/extensions/broker/host.ts`.

### Step 5: Run existing broker tests

```bash
node --test test/broker-host-integration.test.mjs test/broker-policy.test.ts test/broker-ctx-proxy.test.ts
```

All must pass. If a test fails, stop and report.

**Verify**: All tests pass, exit 0.

### Step 6: Add a regression test

In `test/broker-host-integration.test.mjs`, add a test case that:
1. Activates a fixture extension that calls `ctx.ipc.handle('ping', ...)`
2. Deactivates the extension
3. Re-activates the same extension
4. Verifies that the re-activation succeeds (no "second handler" error)

Look at the existing test structure in `test/broker-host-integration.test.mjs` — it uses `activateFixture()` helpers. Follow the same pattern for lifecycle setup/teardown.

If the test fixture doesn't expose `ctx.ipc.handle`, use the `relay-suite-fixture` or create a minimal inline fixture in `test/fixtures/broker/` with an `extension.json` and `main.js` that calls `ctx.ipc.handle('test-channel', ...)`. Model after `test/fixtures/broker/relay-suite-fixture/` for fixture structure.

**Verify**: `node --test test/broker-host-integration.test.mjs` → all tests pass including the new deactivate/re-activate test.

## Test plan

- New test: deactivate + re-activate cycle with an IPC handler registered — must not throw "second handler"
- New test: after deactivate, calling the old channel should fail gracefully (optional, lower priority than the re-activate test)
- Pattern: follow `test/broker-host-integration.test.mjs` structure exactly

## Done criteria

- [ ] `grep -n "ipcChannels" src/main/extensions/broker/host.ts` → 3+ matches (field, push, reset×2)
- [ ] `grep -n "removeHandler" src/main/extensions/broker/host.ts` → 2 matches (deactivate + cleanup)
- [ ] `npm run typecheck` introduces no new errors in in-scope files
- [ ] `node --test test/broker-host-integration.test.mjs` passes including new test
- [ ] `git diff --name-only` shows only `src/main/extensions/broker/host.ts` and `test/broker-host-integration.test.mjs`
- [ ] `plans/README.md` status row updated (skip this — reviewer maintains the index)

## STOP conditions

- The code at the cited locations doesn't match the excerpts (codebase drifted).
- A step's verification fails twice after a reasonable fix attempt.
- The fix requires touching a file outside the in-scope list.
- `ipcMain.removeHandler` doesn't exist on the `ipcMain` import (unlikely — it's standard Electron API since v1, but verify with `grep "removeHandler" node_modules/electron/electron.d.ts` if uncertain).

## Maintenance notes

- If the broker ever supports `ipc.off` (unregister a single handler from inside the extension), the tracking must be extended: store `Map<channel, handler>` instead of `string[]`, and call `ipcMain.removeHandler` per-channel.
- The `ctx.ipc.handle()` path in `src/main/extensions/context.ts` has its own tracking — do not consolidate them in this plan; keep them separate to avoid scope creep.
- A reviewer should verify the test actually attempts re-activation (not just deactivation) and that the "second handler" error would have been thrown by the old code.
