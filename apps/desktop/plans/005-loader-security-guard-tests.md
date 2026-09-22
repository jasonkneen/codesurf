# Plan 005: Add unit tests for isPowerActivationPermitted security guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, reply with the required report format.
>
> **Drift check (run first)**:
> `git diff --stat 9d8a613..HEAD -- src/main/extensions/loader.ts`
> If this file changed (Plan 003 may have modified it), read the current code
> before writing tests — test the current behavior, not the original.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 003 (fix the dead guard — tests should cover the corrected behavior)
- **Category**: tests
- **Planned at**: commit `9d8a613`, 2026-06-12

## Why this matters

`isPowerActivationPermitted` in `loader.ts` is the last-ditch security gate that prevents power extensions from running without explicit user approval. It has zero test coverage. For a function that lives in the critical path of "should this arbitrary code execute in the main process", that's a gap worth closing.

This plan adds a focused unit test file for the function, covering all branches including the workspace-scope path fixed in Plan 003.

## Current state (after Plan 003 lands)

The function in `src/main/extensions/loader.ts` should look like this after Plan 003:

```typescript
export function isPowerActivationPermitted(
  manifest: ExtensionManifest,
  scope: ExtensionScope,
): boolean {
  if (!manifest._enabled) {
    if (scope === 'workspace') {
      console.error(`[Security] Blocked activation of workspace power extension ...`)
    } else {
      console.error(`[Security] Blocked activation of power extension ... _enabled is false ...`)
    }
    return false
  }
  return true
}
```

If Plan 003 has NOT landed yet, the function still has the dead workspace-scope check. In that case, test the INTENDED behavior (i.e., write the tests for the fixed behavior), so they serve as a regression guard when Plan 003 lands. Mark which test is expected to fail until Plan 003 runs.

**STOP condition**: If Plan 003 has NOT landed and you're writing tests for the unfixed code, write tests for the CURRENT (buggy) behavior and add a `// TODO: will pass after Plan 003` comment. Do not modify `loader.ts` yourself — that's Plan 003's job.

## Commands you will need

| Purpose    | Command                                      | Expected on success       |
|------------|----------------------------------------------|---------------------------|
| Typecheck  | `npm run typecheck`                          | No new errors in in-scope files |
| Tests      | `node --test test/power-activation-guard.test.ts` | all pass |

**Existing test to use as structural pattern**: `test/extension-activation-policy.test.ts` — this tests the adjacent `resolveExtensionEnabled` function and shows the import style, describe/it blocks, and assertion patterns for extension lifecycle tests.

## Scope

**In scope**:
- `test/power-activation-guard.test.ts` (create new file)

**Out of scope** (do NOT touch):
- `src/main/extensions/loader.ts` — test only, do not modify source
- Any other source or test file

## Git workflow

- Commit: `test(loader): add unit tests for isPowerActivationPermitted`
- Do NOT push or open a PR

## Steps

### Step 1: Examine the existing pattern test

Read `test/extension-activation-policy.test.ts` to understand:
- How `ExtensionManifest` objects are constructed for tests (minimal mocks)
- How the `node --test` framework's `describe`/`it`/`assert` are imported and used
- The import path for the module under test

**Verify**: You can see the test file and understand the pattern.

### Step 2: Create `test/power-activation-guard.test.ts`

Create a new test file covering all branches of `isPowerActivationPermitted`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPowerActivationPermitted } from '../src/main/extensions/loader'
import type { ExtensionManifest } from '../src/shared/types'

// Minimal manifest factory — only fields used by isPowerActivationPermitted
function makeManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: 'test-ext',
    name: 'Test Extension',
    version: '1.0.0',
    tier: 'power',
    _enabled: true,
    _path: '/tmp/test-ext',
    main: 'main.js',
    ...overrides,
  } as ExtensionManifest
}

describe('isPowerActivationPermitted', () => {
  it('returns true for an enabled extension in global scope', () => {
    const manifest = makeManifest({ _enabled: true })
    assert.strictEqual(isPowerActivationPermitted(manifest, 'global'), true)
  })

  it('returns true for an enabled extension in bundled scope', () => {
    const manifest = makeManifest({ _enabled: true })
    assert.strictEqual(isPowerActivationPermitted(manifest, 'bundled'), true)
  })

  it('returns true for an enabled extension in workspace scope', () => {
    const manifest = makeManifest({ _enabled: true })
    assert.strictEqual(isPowerActivationPermitted(manifest, 'workspace'), true)
  })

  it('returns false for a disabled extension in global scope', () => {
    const manifest = makeManifest({ _enabled: false })
    assert.strictEqual(isPowerActivationPermitted(manifest, 'global'), false)
  })

  it('returns false for a disabled extension in workspace scope', () => {
    const manifest = makeManifest({ _enabled: false })
    assert.strictEqual(isPowerActivationPermitted(manifest, 'workspace'), false)
  })

  it('logs the workspace-specific error message for disabled workspace extensions', () => {
    const manifest = makeManifest({ _enabled: false })
    const logged: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => logged.push(args.join(' '))
    try {
      isPowerActivationPermitted(manifest, 'workspace')
    } finally {
      console.error = origError
    }
    assert.ok(
      logged.some(msg => msg.includes('workspace-local power extensions')),
      `Expected workspace error message, got: ${logged.join(', ')}`,
    )
  })

  it('logs the generic error message for disabled non-workspace extensions', () => {
    const manifest = makeManifest({ _enabled: false })
    const logged: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => logged.push(args.join(' '))
    try {
      isPowerActivationPermitted(manifest, 'global')
    } finally {
      console.error = origError
    }
    assert.ok(
      logged.some(msg => msg.includes('_enabled is false')),
      `Expected generic error message, got: ${logged.join(', ')}`,
    )
  })
})
```

**Note on the last two tests**: If Plan 003 has NOT landed, the workspace-scope test (`logs the workspace-specific error message`) will FAIL because the dead check means the generic message fires instead of the workspace-specific one. In that case, mark the test with a `// TODO Plan-003` comment and expect it to fail until that plan runs. Do NOT skip the test — it should serve as a CI reminder.

**Verify**: File created at `test/power-activation-guard.test.ts`.

### Step 3: Run the new test

```bash
node --test test/power-activation-guard.test.ts
```

If Plan 003 has landed: all tests pass.
If Plan 003 has NOT landed: 5/7 pass; the 2 message-content tests fail as expected.

**Verify**: Test file runs without crashes (even if some assertions fail — report which ones and why).

### Step 4: Run typecheck

```bash
npm run typecheck 2>&1
```

Confirm no new errors in test file.

**Verify**: exit 0 or only pre-existing errors in unrelated files.

## Test plan

Tests written in Step 2 cover:
- enabled → global: returns true
- enabled → bundled: returns true  
- enabled → workspace: returns true
- disabled → global: returns false, generic message
- disabled → workspace: returns false, workspace-specific message

## Done criteria

- [ ] `test/power-activation-guard.test.ts` exists
- [ ] `node --test test/power-activation-guard.test.ts` runs (all pass if Plan 003 is done)
- [ ] `npm run typecheck` introduces no new errors
- [ ] `git diff --name-only` shows only `test/power-activation-guard.test.ts`

## STOP conditions

- `isPowerActivationPermitted` is not exported from `loader.ts` — if it's not exported, update the plan to test it indirectly (or export it), but do NOT modify `loader.ts` without checking Plan 003 first.
- Import path for `ExtensionManifest` is wrong — grep `src/shared/types.ts` for the type name if needed.
- The `makeManifest` factory needs more required fields (TypeScript will error) — add only the minimum required to satisfy the type; do not add logic.

## Maintenance notes

- If `isPowerActivationPermitted` gains new parameters or checks (e.g., capabilities validation), add corresponding test cases here.
- The `console.error` spy pattern (save/restore) is safe for synchronous functions; do not use it for async functions without awaiting cleanup.
