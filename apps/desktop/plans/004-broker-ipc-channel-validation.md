# Plan 004: Validate IPC channel names received from extension child process

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, reply with the required report format.
>
> **Drift check (run first)**:
> `git diff --stat 9d8a613..HEAD -- src/main/extensions/broker/host.ts src/main/extensions/broker/child-entry.ts`
> If either file changed, compare "Current state" excerpts before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9d8a613`, 2026-06-12

## Why this matters

When an extension calls `ctx.ipc.handle(channel, handler)`, the child process (running extension code) sends a JSON-RPC message to the host with a `fullChannel` string. The host at `broker/host.ts:289` registers `ipcMain.handle(fullChannel, ...)` directly with Electron's IPC system without validating that `fullChannel` starts with `ext:${extensionId}:`.

The child-entry correctly constructs `fullChannel = \`ext:${extensionId}:${channel}\`` at `child-entry.ts:260`. However, the host never verifies this — it accepts whatever string the child sends. A malicious extension (or any extension with a bug) could send `fullChannel = 'ext:some-other-extension:private'` and register a handler on another extension's IPC namespace. This breaks the isolation guarantee of the broker.

The fix is a one-line assertion in the host dispatcher before the `ipcMain.handle` call.

## Current state

**File: `src/main/extensions/broker/child-entry.ts`** (~lines 258-263):

```typescript
// child-entry.ts ~line 258-263 — child side (correct construction)
ipc: {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    const fullChannel = `ext:${extensionId}:${channel}`   // correctly namespaced
    ipcHandlers.set(fullChannel, handler)
    call('ipc', 'handle', [fullChannel])                  // sends fullChannel to main
  },
},
```

**File: `src/main/extensions/broker/host.ts`** (~lines 284-297):

```typescript
// host.ts ~line 284-297 — host side (missing validation)
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

The `extId` is available in scope at this point (it's defined at the top of `handleChildCall`: `const extId = this.manifest.id`).

**Conventions:** TypeScript, 2-space indent, no semicolons, trailing commas. Throw `Object.assign(new Error(...), { code })` for capability-denied errors — look at line ~208 for the pattern.

## Commands you will need

| Purpose    | Command                                      | Expected on success       |
|------------|----------------------------------------------|---------------------------|
| Typecheck  | `npm run typecheck`                          | No new errors in in-scope files |
| Tests      | `node --test test/broker-*.test.ts test/broker-*.test.mjs` | all pass |

## Scope

**In scope**:
- `src/main/extensions/broker/host.ts`
- `test/broker-host-integration.test.mjs` (add test case)

**Out of scope**:
- `src/main/extensions/broker/child-entry.ts` — child side is correct, do not change it
- Any other file

## Git workflow

- Commit: `fix(security): validate IPC channel namespace in broker ipc.handle`
- Do NOT push or open a PR

## Steps

### Step 1: Add the channel namespace validation

In `host.ts`, in the `case 'ipc':` block, add a validation check after extracting `fullChannel` and before calling `ipcMain.handle`:

```typescript
case 'ipc': {
  if (method !== 'handle') throw new Error(`Unknown ipc method: ${method}`)
  const [fullChannel] = args as [string]

  // Validate that the channel is within this extension's namespace.
  // The child constructs `ext:${extensionId}:${channel}` — enforce it on the host side.
  const expectedPrefix = `ext:${extId}:`
  if (!fullChannel.startsWith(expectedPrefix)) {
    throw Object.assign(
      new Error(
        `Extension "${extId}" attempted to register IPC handler on unauthorized channel "${fullChannel}". ` +
        `Channels must start with "${expectedPrefix}".`,
      ),
      { code: BROKER_ERROR_CODES['capability-denied'] },
    )
  }

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

`BROKER_ERROR_CODES` is already imported/used in this file (see the `relayHost` case above). `extId` is defined as `const extId = this.manifest.id` in `handleChildCall`.

**Verify**: `grep -n "expectedPrefix\|unauthorized channel" src/main/extensions/broker/host.ts` → shows the validation block.

### Step 2: Run typecheck

```bash
npm run typecheck 2>&1
```

Confirm no new errors in `broker/host.ts`.

### Step 3: Run existing broker tests

```bash
node --test test/broker-host-integration.test.mjs test/broker-policy.test.ts test/broker-ctx-proxy.test.ts
```

All must pass.

**Verify**: exit 0.

### Step 4: Add a test for the channel namespace enforcement

In `test/broker-host-integration.test.mjs`, add a test that:
1. Loads a fixture extension that attempts to register an IPC handler on a channel NOT in its namespace (e.g., sends `'ext:other-extension:steal'` as the fullChannel)
2. Asserts that the capability call is rejected (the extension receives an error from `ctx.ipc.handle`)

Since the child-entry.ts correctly constructs the channel, you'll need a way to test the HOST-side validation. The simplest approach: create a test fixture whose `main.js` uses the raw `call()` RPC mechanism (or direct postMessage) to send a malformed `broker.capability` call with an out-of-namespace channel. Look at how `test/broker-ctx-proxy.test.ts` mocks the host dispatch if there's a direct way to call `handleChildCall`.

If direct injection of a malformed broker call is too complex for S effort: add a code-level test by directly instantiating `ExtensionBrokerHost` with a mock child and calling `handleChildCall('broker.capability', { capability: 'ipc', method: 'handle', args: ['ext:other-ext:steal'] })`. Assert it throws an error containing "unauthorized channel".

Check if `ExtensionBrokerHost` is exported from `broker/host.ts` for direct instantiation in tests.

**Verify**: New test passes.

## Test plan

- Test: attempt to register `ext:other-ext:channel` from extension `my-ext` → throws with "unauthorized channel"
- Test: register `ext:my-ext:valid-channel` → succeeds (regression guard)
- Pattern: follow `test/broker-ctx-proxy.test.ts` for direct host dispatch testing

## Done criteria

- [ ] `grep -n "unauthorized channel\|expectedPrefix" src/main/extensions/broker/host.ts` → matches in `case 'ipc':`
- [ ] `npm run typecheck` introduces no new errors in `host.ts`
- [ ] `node --test test/broker-*.test.ts test/broker-*.test.mjs` passes including new test
- [ ] `git diff --name-only` shows only `src/main/extensions/broker/host.ts` and `test/broker-host-integration.test.mjs`

## STOP conditions

- Code at cited locations doesn't match excerpts (drifted).
- `BROKER_ERROR_CODES` doesn't include a `'capability-denied'` key — check the import and use the correct key name.
- A step's verification fails twice.
- The fix requires touching `child-entry.ts` (it should not; the child side is already correct).

## Maintenance notes

- If the IPC handle API is extended (e.g., `ipc.off` to unregister), the same namespace validation must be applied.
- If the channel naming convention ever changes (e.g., `plugin:` prefix instead of `ext:`), update the `expectedPrefix` construction here and in `child-entry.ts` together.
- After Plan 001 lands (which adds `ipcChannels` tracking), verify that the channels added to `this.ipcChannels` are only ever valid namespaced channels — they are, because this guard fires before the `ipcChannels.push`.
