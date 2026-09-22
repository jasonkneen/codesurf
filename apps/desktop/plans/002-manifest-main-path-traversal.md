# Plan 002: Guard against path traversal in extension manifest.main field

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, reply with the required report format.
>
> **Drift check (run first)**:
> `git diff --stat 9d8a613..HEAD -- src/main/extensions/broker/host.ts src/main/extensions/loader.ts`
> If either file changed since the plan was written, compare "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9d8a613`, 2026-06-12

## Why this matters

Two code paths compute an extension entry point by joining `manifest._path` with `manifest.main` from the extension's `extension.json` manifest file. Neither validates that the result stays within the extension's directory.

A malicious `extension.json` with `"main": "../../some-module.js"` would cause the loader to `require()` an arbitrary file outside the extension directory. In the broker path (`host.ts`) this means loading and executing arbitrary Node.js code in the `utilityProcess` child. In the legacy path (`loader.ts`) this means executing arbitrary code in the Electron main process.

The threat actor is a workspace-local extension (any git repo can ship `.contex/extensions/`) or a compromised catalog extension. Workspace-local power extensions require user opt-in, but that opt-in unlocks execution — path traversal means the user agreed to run "this extension" but gets a different file.

An existing analogous guard exists at `src/main/storage/workspaceArtifacts.ts` — use it as a pattern.

## Current state

**File: `src/main/extensions/broker/host.ts`** (~line 55):

```typescript
// host.ts ~line 53-56
const manifest = this.manifest
if (!manifest.main || !manifest._path) return false

const entryPath = join(manifest._path, manifest.main)
const extId = manifest.id
```

No bounds check. `path.join('/extensions/my-ext', '../../etc/passwd')` → `/etc/passwd`.

**File: `src/main/extensions/loader.ts`** (~line 75-78):

```typescript
// loader.ts ~line 75-78
if (!manifest.main || !manifest._path) return null

const entryPath = join(manifest._path, manifest.main)
const prefix = `[Ext:${manifest.name}]`
```

Same pattern, same vulnerability.

**Existing analogous guard (`src/main/storage/workspaceArtifacts.ts`):**

```typescript
// workspaceArtifacts.ts ~line 3-8 (pattern to follow)
function assertSafeWorkspaceArtifactId(artifactId: string): void {
  const resolved = resolve(artifactId)
  if (resolved !== artifactId || artifactId.includes('..') || path.isAbsolute(artifactId)) {
    throw new Error(`Unsafe artifact ID: ${artifactId}`)
  }
}
```

Use `resolve()` to canonicalize both paths, then assert the entry is inside the base directory.

**Imports already present in both files**: `join` from `path` is already imported. You need to add `resolve` from `path`.

**Conventions:** TypeScript, 2-space indent, no semicolons, trailing commas. Throw a descriptive `Error` — do not silently return null (the caller must know this was a security block, not a missing-file error).

## Commands you will need

| Purpose    | Command                                      | Expected on success       |
|------------|----------------------------------------------|---------------------------|
| Typecheck  | `npm run typecheck`                          | No new errors in in-scope files |
| Tests      | `node --test test/broker-*.test.ts test/broker-*.test.mjs test/extension-light-scan.test.ts` | all pass |

**Typecheck baseline note**: ~9 pre-existing errors in unrelated files. Plan passes if no NEW errors appear in the in-scope files.

## Scope

**In scope** (the only files you should modify):
- `src/main/extensions/broker/host.ts`
- `src/main/extensions/loader.ts`
- `test/broker-host-integration.test.mjs` (add test case for traversal attempt)
- `test/broker-policy.test.ts` OR a new `test/extension-manifest-security.test.ts` (add test for loader traversal)

**Out of scope** (do NOT touch):
- `src/main/extensions/registry.ts`
- `src/main/storage/workspaceArtifacts.ts` — read for pattern only; do not modify
- Any other file

## Git workflow

- Branch: work in whatever worktree branch you were given
- Commit: `fix(security): block path traversal in manifest.main resolution`
- Do NOT push or open a PR

## Steps

### Step 1: Add `resolve` to imports in both files

In `src/main/extensions/broker/host.ts`, find the `path` import line. It should already import `join`. Add `resolve` to it:

```typescript
import { join, resolve } from 'path'
```

Do the same in `src/main/extensions/loader.ts`.

**Verify**: `grep -n "^import.*resolve.*from 'path'" src/main/extensions/broker/host.ts src/main/extensions/loader.ts` → shows `resolve` in both.

### Step 2: Add the guard function to `loader.ts`

Add a module-level helper function near the top of `src/main/extensions/loader.ts` (after imports, before the first export):

```typescript
function assertSafeExtensionEntry(basePath: string, relativeMain: string): void {
  const resolvedBase = resolve(basePath)
  const resolvedEntry = resolve(basePath, relativeMain)
  if (!resolvedEntry.startsWith(resolvedBase + require('path').sep) && resolvedEntry !== resolvedBase) {
    throw new Error(
      `[Security] Extension manifest.main escapes extension directory: ` +
      `"${relativeMain}" resolves outside "${basePath}"`,
    )
  }
}
```

**Wait** — `require('path').sep` is awkward. Use the already-imported `path` module or import `sep` directly. Since `path` is already used, import `sep` from `'path'` alongside `join` and `resolve`.

Final helper (adjust imports to include `sep`):

```typescript
function assertSafeExtensionEntry(basePath: string, relativeMain: string): void {
  const resolvedBase = resolve(basePath)
  const resolvedEntry = resolve(basePath, relativeMain)
  if (resolvedEntry !== resolvedBase && !resolvedEntry.startsWith(resolvedBase + sep)) {
    throw new Error(
      `[Security] Extension manifest.main "${relativeMain}" escapes extension directory`,
    )
  }
}
```

Import `sep` from `'path'` in `loader.ts`.

**Verify**: `grep -n "assertSafeExtensionEntry" src/main/extensions/loader.ts` → shows the function.

### Step 3: Call the guard in `loader.ts` before `entryPath` is used

In `loadPowerExtension` at ~line 75-78, add the guard call immediately after the null check:

```typescript
if (!manifest.main || !manifest._path) return null

assertSafeExtensionEntry(manifest._path, manifest.main)

const entryPath = join(manifest._path, manifest.main)
```

**Verify**: `grep -n "assertSafeExtensionEntry(manifest._path" src/main/extensions/loader.ts` → shows the call.

### Step 4: Add the same guard in `host.ts`

In `activate()` at ~line 53-56, add the guard after the null check:

```typescript
if (!manifest.main || !manifest._path) return false

// Guard against path traversal in manifest.main
const resolvedBase = resolve(manifest._path)
const resolvedEntry = resolve(manifest._path, manifest.main)
if (resolvedEntry !== resolvedBase && !resolvedEntry.startsWith(resolvedBase + sep)) {
  console.error(
    `[Security] Blocked activation of extension "${manifest.id}": ` +
    `manifest.main "${manifest.main}" escapes extension directory`,
  )
  return false
}

const entryPath = join(manifest._path, manifest.main)
```

Note: in `host.ts` we return `false` (like the other early-return cases) rather than throwing, so the caller can handle it gracefully. Also import `sep` from `'path'` in `host.ts`.

Alternatively (simpler): extract the guard into a shared utility and call it in both files. But this is S-effort; inline is fine if you prefer it.

**Verify**: `grep -n "escapes extension directory" src/main/extensions/broker/host.ts` → shows the guard.

### Step 5: Run typecheck

```bash
npm run typecheck 2>&1
```

Confirm no new errors in `broker/host.ts` or `loader.ts`.

**Verify**: No new errors in the in-scope files.

### Step 6: Run tests

```bash
node --test test/broker-host-integration.test.mjs test/broker-policy.test.ts test/broker-ctx-proxy.test.ts test/extension-light-scan.test.ts
```

All must pass.

**Verify**: exit 0.

### Step 7: Add a regression test for the traversal

In `test/broker-host-integration.test.mjs` (or a new file `test/extension-manifest-security.test.ts`), add a test that:
1. Creates a minimal manifest object with `_path: '/tmp/test-ext'` and `main: '../../evil.js'`
2. Calls either the guard directly (if exported) or exercises the loading path with a traversal manifest
3. Asserts that activation fails / throws with a message mentioning "escapes extension directory"

If the guard in `loader.ts` is not exported (it's a module-private function), you can test it indirectly by creating a fixture extension with a bad manifest and verifying that `loadPowerExtension` returns null or throws. Model the fixture after `test/fixtures/broker/crashy-ext/` — create `test/fixtures/broker/traversal-ext/extension.json` with `"main": "../../main.js"` and a dummy `test/fixtures/broker/traversal-ext/main.js`. Then write a test that tries to activate it and asserts it fails.

**Verify**: New test runs and passes with `node --test test/broker-host-integration.test.mjs` (or the new file).

## Test plan

- New test: extension with `main: "../../main.js"` in manifest → activation blocked
- New test: extension with `main: "main.js"` (safe) → activation proceeds normally (regression guard)
- Pattern: follow `test/broker-host-integration.test.mjs` fixture pattern; model fixture after `test/fixtures/broker/crashy-ext/`

## Done criteria

- [ ] `grep -n "assertSafeExtensionEntry\|escapes extension directory" src/main/extensions/loader.ts src/main/extensions/broker/host.ts` → matches in both files
- [ ] `npm run typecheck` introduces no new errors in in-scope files
- [ ] `node --test test/broker-host-integration.test.mjs` passes including traversal test
- [ ] `git diff --name-only` shows only in-scope files
- [ ] `plans/README.md` status row: skip — reviewer maintains index

## STOP conditions

- The code at the cited locations doesn't match the excerpts (codebase drifted).
- A step's verification fails twice.
- The fix requires modifying `src/main/extensions/registry.ts` or any other out-of-scope file.
- You discover that `manifest._path` is set by untrusted extension code rather than by the loader (it would mean the check doesn't help) — stop and report; this would require a different approach.

## Maintenance notes

- If the manifest schema is ever formally validated (e.g., with zod), move this check there and remove the inline guard.
- The broker's `host.ts` guard logs and returns false; the loader's `loader.ts` guard throws. This asymmetry is intentional: broker handles it gracefully (logged, extension not activated); legacy loader lets the caller decide. If both callers should have the same behavior, unify in a follow-up.
- A future "extension sandboxing" feature should make this guard redundant by running extensions in a sandboxed process with restricted filesystem access. Until then, this is the last line of defense for workspace-local extensions.
