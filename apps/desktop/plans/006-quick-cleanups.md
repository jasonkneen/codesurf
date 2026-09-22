# Plan 006: Quick cleanups — tile-type normalization + test glob + LiveKit credentials

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, reply with the required report format.
>
> **Drift check (run first)**:
> `git diff --stat 9d8a613..HEAD -- src/main/extensions/registry.ts package.json bundled-extensions/livekit-rooms/extension.json`
> If any of these changed since the plan was written, compare "Current state"
> excerpts before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt / DX / security
- **Planned at**: commit `9d8a613`, 2026-06-12

## Why this matters

Three independent S-effort cleanups bundled together because each is a few lines:

1. **Tile-type normalization is copy-pasted 4 times in `registry.ts`** — lines 284, 308, 354, 418 all contain identical 5-line blocks. Any logic change must be applied 4 ways.

2. **The `npm test` glob `test/*.test.ts` silently skips TypeScript tests in subdirectories** — `package.json` line 21 uses `test/*.test.ts` which is root-only. If anyone adds a `test/main/feature.test.ts` or `test/daemon/something.test.ts` file, it silently doesn't run.

3. **LiveKit bundled extension has `"devkey"` and `"secret"` as default API credential values** — while the default server URL is localhost-only, shipping dev credentials as defaults is poor hygiene. If a user connects to a real LiveKit server, these defaults bypass any security intent.

## Current state

### Finding 1: tile-type normalization at registry.ts:284, 308, 354, 418

All four blocks look like this (identical except for the surrounding context):

```typescript
if (manifest.contributes?.tiles) {
  for (const tile of manifest.contributes.tiles) {
    if (!tile.type.startsWith('ext:')) {
      tile.type = `ext:${tile.type}`
    }
  }
}
```

Locations:
- ~line 282 in `readManifestLight` method's try block
- ~line 306 in `readManifestLight` method's catch block (adapter path)
- ~line 352 in `loadExtension` method
- ~line 416 in `loadFromManifest` method

### Finding 2: test glob in package.json

```json
// package.json ~line 21
"test": "node --test test/*.test.ts test/*.test.mjs test/main/*.test.mjs test/sidebar/*.test.mjs test/daemon/*.test.mjs && npm run test:relay",
```

The `test/*.test.ts` glob covers only root-level TypeScript test files. `.mjs` files in subdirs are listed explicitly. A future `test/main/feature.test.ts` would silently be skipped.

### Finding 3: LiveKit credentials

```json
// bundled-extensions/livekit-rooms/extension.json:25-27
{ "key": "serverUrl", "label": "Server URL", "type": "string", "default": "ws://localhost:7880" },
{ "key": "apiKey", "label": "API Key", "type": "string", "default": "devkey" },
{ "key": "apiSecret", "label": "API Secret", "type": "string", "default": "secret" },
```

**Conventions:** TypeScript, 2-space indent, no semicolons, trailing commas. Match registry.ts style exactly.

## Commands you will need

| Purpose    | Command                                      | Expected on success       |
|------------|----------------------------------------------|---------------------------|
| Typecheck  | `npm run typecheck`                          | No new errors in in-scope files |
| Tests      | `npm test`                                   | same result as before (all existing pass) |

## Scope

**In scope**:
- `src/main/extensions/registry.ts` (extract helper function)
- `package.json` (fix test glob)
- `bundled-extensions/livekit-rooms/extension.json` (clear default credentials)

**Out of scope**:
- Any other file
- `bundled-extensions/livekit-rooms/main.js` — the JS uses the settings values but should not need to change (empty defaults will just cause the extension to not work until configured, which is the desired UX)

## Git workflow

- Commit: `refactor(registry): extract normalizeTileTypes helper; fix test glob; clear LiveKit dev credentials`
- Do NOT push or open a PR

## Steps

### Step 1: Extract `normalizeTileTypes` in `registry.ts`

Add a module-level private helper function near the top of the `ExtensionRegistry` class (or as a file-level function before the class, whichever matches the file's existing style — check if there are other module-level helpers in registry.ts).

```typescript
function normalizeTileTypes(manifest: ExtensionManifest): void {
  if (manifest.contributes?.tiles) {
    for (const tile of manifest.contributes.tiles) {
      if (!tile.type.startsWith('ext:')) {
        tile.type = `ext:${tile.type}`
      }
    }
  }
}
```

Replace all 4 duplicated blocks with calls to `normalizeTileTypes(manifest)`:
- ~line 282: replace the if-block with `normalizeTileTypes(manifest)`
- ~line 306: same
- ~line 352: same
- ~line 416: same

The function signature uses `ExtensionManifest` which is already imported in registry.ts.

**Verify**:
- `grep -c "startsWith('ext:')" src/main/extensions/registry.ts` → outputs `1` (only in the helper)
- `grep -c "normalizeTileTypes" src/main/extensions/registry.ts` → outputs `5` (1 definition + 4 call sites)

### Step 2: Run typecheck after registry change

```bash
npm run typecheck 2>&1
```

Confirm no new errors in `registry.ts`.

**Verify**: No new errors in `src/main/extensions/registry.ts`.

### Step 3: Fix the test glob in `package.json`

Find the `"test"` script key in `package.json`. Change:
```
"test": "node --test test/*.test.ts test/*.test.mjs test/main/*.test.mjs test/sidebar/*.test.mjs test/daemon/*.test.mjs && npm run test:relay",
```
To:
```
"test": "node --test 'test/*.test.ts' 'test/**/*.test.mjs' && npm run test:relay",
```

Or, more conservatively (to avoid changing the explicit subdir coverage):
```
"test": "node --test test/*.test.ts test/main/*.test.ts test/sidebar/*.test.ts test/daemon/*.test.ts test/*.test.mjs test/main/*.test.mjs test/sidebar/*.test.mjs test/daemon/*.test.mjs && npm run test:relay",
```

**Choose whichever preserves existing test execution exactly.** First verify what `.ts` test files currently exist in subdirs:
```bash
find test -name "*.test.ts" -not -path "test/*.test.ts"
```
If there are none (currently), either approach is safe. Use the explicit subdir form to be conservative.

**Verify**: `grep "test:relay\|node --test" package.json` → shows the updated test command.

### Step 4: Clear LiveKit default credentials

In `bundled-extensions/livekit-rooms/extension.json`, update the apiKey and apiSecret defaults to empty strings:

```json
{ "key": "apiKey", "label": "API Key", "type": "string", "default": "" },
{ "key": "apiSecret", "label": "API Secret", "type": "string", "default": "" },
```

The `serverUrl` default (`ws://localhost:7880`) is fine to leave — it's clearly a localhost dev address.

**Verify**: `grep -n "devkey\|\"secret\"" bundled-extensions/livekit-rooms/extension.json` → no matches.

### Step 5: Run tests

```bash
npm test
```

All existing tests must still pass. If the glob change causes any test to newly run that was previously silently skipped and that test fails, stop and report.

**Verify**: exit 0.

## Test plan

No new tests — this is a refactoring plan. The existing test suite verifies correctness of `normalizeTileTypes` indirectly (any test that loads extensions and checks tile types would catch a regression).

## Done criteria

- [ ] `grep -c "startsWith('ext:')" src/main/extensions/registry.ts` → `1`
- [ ] `grep -c "normalizeTileTypes" src/main/extensions/registry.ts` → `5`
- [ ] `grep -n "devkey\|\"secret\"" bundled-extensions/livekit-rooms/extension.json` → no matches
- [ ] `npm run typecheck` introduces no new errors in in-scope files
- [ ] `npm test` passes with same number of tests as before (or more if the glob now picks up previously-skipped tests)
- [ ] `git diff --name-only` shows only the 3 in-scope files

## STOP conditions

- The code at the cited locations doesn't match the excerpts (drifted).
- `normalizeTileTypes` extraction causes a TypeScript error (e.g., `ExtensionManifest.contributes.tiles` type changed).
- The glob change causes previously-silent test files to run and fail — stop and report which files are newly discovered.
- Clearing LiveKit defaults causes any existing test to fail (indicates a test was relying on `"devkey"`/`"secret"` defaults).

## Maintenance notes

- If a 5th call site for tile normalization appears (new loading path), use `normalizeTileTypes()`.
- If a new bundled extension is added, check its default credential values before committing.
- The test glob fix is conservative — if new test subdirectories are added (e.g., `test/extensions/`), add them to the test command explicitly.
