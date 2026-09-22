# Plan 001: Cache user/project settings reads so hot paths stop hitting the disk

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0f643..HEAD -- src/utils/settings.ts src/core/extensions/builtin/file-tools-approval.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ed0f643`, 2026-07-15

## Why this matters

`loadUserSettings()` / `loadProjectSettings()` re-read and re-parse their JSON
files from disk on **every call**, and they are called from per-tool-call,
per-turn, and per-render paths (~40 non-test call sites). Concretely: every
`edit_file`/`write_file` approval re-reads user settings 2–3× synchronously
(`shouldAutoApproveEdit` → `loadEditApprovalMode` → full read+parse, plus a
separate read+parse preflight in `canReadAndParseUserSettings`), and every
agent turn re-reads settings via `loadValidSubAgents`. This is synchronous
event-loop-blocking I/O in a TUI whose input handling shares that loop. This
repo has already fixed the same class of problem once (see
`src/utils/cli-check-cache.ts` — caching CLI-existence probes); this plan
applies the same medicine to settings JSON.

## Current state

- `src/utils/settings.ts` — all settings I/O lives here.
  - `readJson` (uncached), `settings.ts:295-302`:
    ```ts
    function readJson<T>(filePath: string): T | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
      } catch {
        return null;
      }
    }
    ```
  - `writeJson`, `settings.ts:304-307`:
    ```ts
    function writeJson(filePath: string, data: unknown): void {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    }
    ```
  - `loadUserSettings`, `settings.ts:309-312` — calls
    `migrateLegacyUserSettingsOnce()` then `readJson(USER_SETTINGS_PATH)`.
    `migrateLegacyUserSettingsOnce` (`settings.ts:263+`) does 2–3
    `fs.existsSync` calls on **every** invocation despite the "Once" name
    (it is only guarded by marker-file existence, not by a module flag).
  - `loadProjectSettings`, `settings.ts:396-399` — `readJson` of
    `path.join(process.cwd(), ".grok", "settings.json")`.
  - `getReasoningEffortForModel`, `settings.ts:742-749` — after a direct key
    miss, linearly re-normalizes every key in `reasoningEffortByModel` on each
    call.
- `src/core/extensions/builtin/file-tools-approval.ts` — per-edit approval
  path. `canReadAndParseUserSettings` (`file-tools-approval.ts:28-37`) does its
  own `fs.statSync` + `fs.readFileSync` + `JSON.parse` of the settings file as
  a fail-safe preflight; `shouldAutoApproveEdit` (`:61-63`) then calls
  `loadEditApprovalMode` which is another full `loadUserSettings()`.
- Writes to these files go **only** through `writeJson` (both
  `saveUserSettings` `settings.ts:314-394` and `saveProjectSettings`
  `settings.ts:401+` call it), so invalidating in `writeJson` covers all
  in-process writers.
- Convention exemplar: `src/utils/cli-check-cache.ts` and its test
  `src/utils/cli-check-cache.test.ts` — module-level Map cache with explicit
  reset function for tests. Match that style (Biome, 2-space indent).

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `bun install`                                  | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0, no errors   |
| Tests     | `bunx vitest run src/utils/settings-cache.test.ts` | all pass       |
| Broader tests | `bunx vitest run src/utils/`               | all pass            |
| Lint      | `bun run lint`                                 | exit 0              |

Note: running the FULL vitest suite is known to fail ~9 pre-existing extension
tests under `bunx vitest` (bun:sqlite incompatibility) — do not chase those;
run targeted files as above.

## Scope

**In scope** (the only files you should modify):
- `src/utils/settings.ts`
- `src/utils/settings-cache.test.ts` (create)
- `src/core/extensions/builtin/file-tools-approval.ts` (Step 4 only, optional)

**Out of scope** (do NOT touch, even though they look related):
- The ~40 call sites of `loadUserSettings`/`loadProjectSettings` — the whole
  point is they keep working unchanged.
- `src/utils/instructions.ts`, `src/utils/skills.ts` (system-prompt file walk —
  separate backlog item, PERF-21 in `plans/README.md`).
- Any settings schema/shape change.

## Git workflow

- Branch: `advisor/001-cache-settings-reads`
- Conventional-commit style, e.g. `perf(settings): cache settings JSON reads with mtime invalidation`
- Do NOT push or open a PR (pushes are blocked on this repo by history-based
  push protection; commit locally only).

## Steps

### Step 1: Add an mtime-keyed cache inside `readJson`/`writeJson`

In `src/utils/settings.ts`, add a module-level cache above `readJson`:

```ts
const jsonReadCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/** Test-only: drop all cached settings reads. */
export function __resetSettingsReadCacheForTests(): void {
  jsonReadCache.clear();
}
```

Rework `readJson` to stat first and serve the cached parse when
`mtimeMs`+`size` are unchanged; on any stat error, treat as missing and delete
the cache entry:

```ts
function readJson<T>(filePath: string): T | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
  const cached = jsonReadCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value as T;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    jsonReadCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
}
```

In `writeJson`, after the `fs.writeFileSync`, add `jsonReadCache.delete(filePath);`
(delete, not update — the next read re-stats and re-parses, keeping one code path).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Make `migrateLegacyUserSettingsOnce` actually run once per process

Add a module-level `let legacyMigrationChecked = false;` and at the top of
`migrateLegacyUserSettingsOnce` return early when set; set it to `true` on
every exit path that today returns after the existsSync checks (the function's
existing early-returns at `settings.ts:263-267` and the end of the function).
Do not change the marker-file logic itself.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Pre-normalize `reasoningEffortByModel` lookups

In `getReasoningEffortForModel` (`settings.ts:742-749`), replace the per-call
`Object.entries(...).find(...)` re-normalization with a module-level
`WeakMap<object, Record<string, ReasoningEffort>>` keyed by the
`savedEfforts` object, whose value is built once with normalized keys. (With
Step 1, the same settings object is returned across calls, so the WeakMap
hits.) Keep the existing direct-key fast path.

**Verify**: `bun run typecheck` → exit 0.

### Step 4 (optional, only if trivially clean): reuse the cached read in the approval preflight

In `src/core/extensions/builtin/file-tools-approval.ts`,
`canReadAndParseUserSettings` re-reads + re-parses the settings file on every
edit. Keep its fail-safe semantics but avoid double parsing: it may simply
remain as-is if you find its ENOENT contract hard to preserve — skipping this
step is acceptable. If you do change it, it must still return `true` on
ENOENT and `false` on unreadable/corrupt files (see its current code at
`file-tools-approval.ts:28-37` and the tests in
`src/core/extensions/builtin/file-tools-approval.test.ts` if present).

**Verify**: `bunx vitest run src/core/extensions/builtin/file-tools-approval.test.ts` (if the file exists) → all pass.

### Step 5: Write the cache tests

Create `src/utils/settings-cache.test.ts` modeled structurally on
`src/utils/cli-check-cache.test.ts`. Use a temp dir (`fs.mkdtempSync`) and
point reads at it — note `USER_SETTINGS_PATH` is module-private, so test
through `readJson` indirectly via `loadProjectSettings` with `process.cwd()`
chdir'd to the temp dir, or export a small test hook if needed. Cases:

1. Two consecutive loads parse once (spy on `fs.readFileSync` via
   `vi.spyOn`; expect 1 call for 2 loads).
2. `save*Settings` invalidates (load → save → load; readFileSync called again;
   new value visible).
3. External modification is picked up (load → `fs.writeFileSync` directly with
   different content and a bumped mtime via `fs.utimesSync` — set an mtime
   clearly in the future to avoid same-millisecond flakiness → load returns
   new content).
4. Missing file returns `{}` and does not poison the cache once the file
   appears.

**Verify**: `bunx vitest run src/utils/settings-cache.test.ts` → all pass.

## Test plan

Covered by Step 5. Also run `bunx vitest run src/utils/` to catch regressions
in neighboring settings consumers → all pass (modulo none of these files being
in the known bun:sqlite-failing set).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bunx vitest run src/utils/settings-cache.test.ts` exits 0 with ≥4 tests
- [ ] `bunx vitest run src/utils/` exits 0
- [ ] `grep -n "readFileSync" src/utils/settings.ts` shows readFileSync only
      inside the cached `readJson` (and the legacy-migration block)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" locations doesn't match the excerpts.
- You find a caller that **mutates** the object returned by
  `loadUserSettings()`/`loadProjectSettings()` and relies on a fresh copy per
  call (search: assignments like `settings.foo = ...` on a load result). The
  cache would alias that mutation across callers.
- You find a writer of `user-settings.json` or `.grok/settings.json` that does
  NOT go through `writeJson` (grep for the filenames) — the invalidation story
  would be incomplete.
- Test 3 (external modification) proves flaky after one honest fix attempt.

## Maintenance notes

- Any future direct write to the settings files must invalidate
  `jsonReadCache` (or go through `writeJson`).
- Reviewer should scrutinize: the returned settings object is now SHARED
  across callers — mutation of a load result was always a latent bug, and is
  now an aliasing bug. A follow-up could `Object.freeze` in dev builds.
- Deferred: the system-prompt persona/skills filesystem walk per turn
  (PERF-21 in `plans/README.md` backlog) compounds with this; it is a
  separate, larger cache.
