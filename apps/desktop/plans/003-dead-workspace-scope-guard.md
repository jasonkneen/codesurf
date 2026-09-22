# Plan 003: Fix unreachable workspace-scope guard in isPowerActivationPermitted

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, reply with the required report format.
>
> **Drift check (run first)**:
> `git diff --stat 9d8a613..HEAD -- src/main/extensions/loader.ts`
> If this file changed, compare "Current state" excerpts before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but should be fixed before Plan 006 which adds tests for this function)
- **Category**: bug
- **Planned at**: commit `9d8a613`, 2026-06-12

## Why this matters

`isPowerActivationPermitted` in `loader.ts` is the defense-in-depth gate that prevents unapproved power extensions from executing. It has two guard branches:

1. Line 49: Generic check — blocks any extension where `!manifest._enabled`
2. Line 59: Workspace-specific check — intended to emit a targeted error message for workspace-scoped extensions where `!manifest._enabled`

The workspace-specific check (branch 2) is **dead code**: it can only be reached when `manifest._enabled` is truthy (since branch 1 already returned false for `!manifest._enabled`). The condition `scope === 'workspace' && !manifest._enabled` therefore evaluates to `false` always, so the intended error message and `return false` never execute.

This means workspace-local power extensions that are blocked get a generic error message instead of the security-context message. The fix is small but worth making because: (a) this is a security-relevant function that will gain tests (Plan 006); (b) dead code in a security function is actively confusing; (c) the intended behavior (workspace-scoped message) should be preserved and made reachable.

## Current state

**File: `src/main/extensions/loader.ts`** (~lines 44-68):

```typescript
export function isPowerActivationPermitted(
  manifest: ExtensionManifest,
  scope: ExtensionScope,
): boolean {
  // An extension that did not pass resolveExtensionEnabled must never execute.
  if (!manifest._enabled) {                          // line 49
    console.error(
      `[Security] Blocked activation of power extension "${manifest.name}" (${manifest.id}): ` +
      `_enabled is false — this extension must be explicitly enabled by the user before it can run.`,
    )
    return false
  }

  // Workspace extensions are attacker-controllable (any cloned repo can ship
  // .contex/extensions/).  Enforce that they passed the untrustedScope gate.
  if (scope === 'workspace' && !manifest._enabled) {  // line 59 — DEAD: !manifest._enabled already false here
    console.error(
      `[Security] Blocked activation of workspace power extension "${manifest.name}" (${manifest.id}): ` +
      `workspace-local power extensions require explicit user opt-in.`,
    )
    return false
  }

  return true
}
```

The problem: `!manifest._enabled` at line 59 can never be true because line 49 already returned false for that case. The workspace-scope check is semantically dead.

**Conventions:** TypeScript, 2-space indent, no semicolons, trailing commas.

## Commands you will need

| Purpose    | Command                                      | Expected on success       |
|------------|----------------------------------------------|---------------------------|
| Typecheck  | `npm run typecheck`                          | No new errors in in-scope files |
| Tests      | `node --test test/extension-activation-policy.test.ts test/extension-light-scan.test.ts` | all pass |

## Scope

**In scope**:
- `src/main/extensions/loader.ts`

**Out of scope** (do NOT touch):
- `src/main/extensions/registry.ts`
- `src/main/extensions/broker/host.ts`
- Any test file (the test addition is Plan 006's responsibility)

## Git workflow

- Commit: `fix(loader): fix unreachable workspace-scope guard in isPowerActivationPermitted`
- Do NOT push or open a PR

## Steps

### Step 1: Restructure the guard logic

The correct behavior should be:
- If `!manifest._enabled`, emit the appropriate error message based on scope, then return false
- If `manifest._enabled` is true, return true

Rewrite the function to:

```typescript
export function isPowerActivationPermitted(
  manifest: ExtensionManifest,
  scope: ExtensionScope,
): boolean {
  if (!manifest._enabled) {
    if (scope === 'workspace') {
      console.error(
        `[Security] Blocked activation of workspace power extension "${manifest.name}" (${manifest.id}): ` +
        `workspace-local power extensions require explicit user opt-in.`,
      )
    } else {
      console.error(
        `[Security] Blocked activation of power extension "${manifest.name}" (${manifest.id}): ` +
        `_enabled is false — this extension must be explicitly enabled by the user before it can run.`,
      )
    }
    return false
  }

  return true
}
```

This preserves both error messages and makes both reachable. The workspace-scope check now fires when `!manifest._enabled && scope === 'workspace'`.

**Verify**: `grep -n "scope === 'workspace'" src/main/extensions/loader.ts` → shows the check inside the `if (!manifest._enabled)` block.

### Step 2: Run typecheck

```bash
npm run typecheck 2>&1
```

Confirm no new errors in `loader.ts`.

**Verify**: No new errors in the in-scope file.

### Step 3: Run existing tests

```bash
node --test test/extension-activation-policy.test.ts test/extension-light-scan.test.ts
```

All must pass.

**Verify**: exit 0.

## Test plan

No new tests in this plan — test coverage for `isPowerActivationPermitted` is added in Plan 006. The structural fix here is verified by running existing tests.

## Done criteria

- [ ] `grep -n "scope === 'workspace'" src/main/extensions/loader.ts` → appears inside `if (!manifest._enabled)` block
- [ ] The second standalone `if (scope === 'workspace' && !manifest._enabled)` block no longer exists
- [ ] `npm run typecheck` introduces no new errors in `loader.ts`
- [ ] `node --test test/extension-activation-policy.test.ts` passes
- [ ] `git diff --name-only` shows only `src/main/extensions/loader.ts`

## STOP conditions

- The code at the cited location doesn't match the excerpt (codebase drifted).
- A step's verification fails twice.
- Fixing the logic requires touching any file other than `loader.ts`.
- You discover that the behavior change breaks an existing test (this would mean a test was asserting the wrong behavior — stop and report which test and what it asserts).

## Maintenance notes

- Plan 006 adds unit tests for this exact function — after Plan 006 lands, any future edit to `isPowerActivationPermitted` has a test net.
- The function is a defense-in-depth secondary check; the primary gate is `resolveExtensionEnabled` in `activation-policy.ts`. If workspace scope handling changes in the primary gate, revisit the error messages here.
