# Plan 009: Make pet thumbnails work in real installs — declare `sharp`, fix suffixed-id lookup, move `statSync` inside try

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 77e3c7d..HEAD -- src/main/ipc/pets.ts package.json`
> NOTE: this plan was written against commit `77e3c7d` PLUS uncommitted working-tree
> changes to `src/main/ipc/pets.ts` (the `pets:spritesheetData`/`pets:thumbnailData`
> handlers and the `require('sharp')` switch). If those changes are neither in the
> working tree nor committed, STOP — the code this plan fixes may have been reverted.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (native dependency packaging)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `77e3c7d` + uncommitted pets diff, 2026-07-01

## Why this matters

Three defects in the fresh pets feature, all in `src/main/ipc/pets.ts`:

1. **`sharp` is not a declared dependency.** `ensureThumbnail` calls
   `require('sharp')` (pets.ts:337), but no `package.json` in the repo declares
   `sharp` (verified: `grep '"sharp"' package.json packages/*/package.json` →
   nothing). It resolves today only if something outside the manifest provides
   it. On a fresh `npm install` or a packaged build, the require throws, is
   caught, and **every thumbnail silently returns null** — the picker shows no
   previews for all users except the dev machine.
2. **Suffixed-id lookup is wrong and unsanitized.** `listPetManifests` produces
   duplicate-disambiguation ids as `` `${meta.id}__${entry.replace(/[^a-zA-Z0-9_-]/g, '-')}` ``
   (pets.ts:155). The lookup does `id.split('__')[1]` (pets.ts:188), which (a)
   returns the WRONG segment when the sanitized dir name itself contains `__`
   (allowed — the regex keeps `_`), and (b) passes the raw remainder to
   `join(dir, suffix)` — a renderer-supplied slug like `x__../../somewhere`
   escapes the pets directories, and a planted `pet.json` there would then let
   `pets:spritesheetData` read and return an arbitrary file path's bytes.
3. **Freshness `statSync` outside the try.** In `ensureThumbnail`,
   `statSync(manifest.spritesheetPath)` (pets.ts:324) runs before the `try` at
   :330 — if the spritesheet was deleted after a thumb was cached, the IPC
   handler rejects instead of returning `null` as its contract says.

## Current state

- `src/main/ipc/pets.ts` — all pets IPC. Scan dirs are `~/.codesurf/pets`,
  `~/.codex/pets`, `~/.hermes/pets` (see `petsDirs()` near the top).
- `package.json` — root manifest; `dependencies` has no `sharp`. Native modules
  are rebuilt via `postinstall` → `electron-rebuild -f -o better-sqlite3 -o node-pty`
  and unpacked from asar via `build.asarUnpack` (package.json ~line 152).

Excerpt — the require and freshness check (pets.ts:316-340, working tree):

```ts
async function ensureThumbnail(manifest: PetManifest): Promise<string | null> {
  const thumbPath = join(THUMBS_DIR, `${manifest.id}.png`)

  if (existsSync(thumbPath)) {
    // Check freshness — re-extract if source changed
    const thumbStat = statSync(thumbPath)
    const srcStat = statSync(manifest.spritesheetPath)   // ← outside try; throws on ENOENT
    if (thumbStat.mtimeMs > srcStat.mtimeMs) {
      return thumbPath
    }
  }

  try {
    if (!existsSync(THUMBS_DIR)) {
      mkdirSync(THUMBS_DIR, { recursive: true })
    }
    const sharp = require('sharp')                        // ← undeclared dependency
    ...
```

Excerpt — the suffixed-id lookup (pets.ts:185-196, working tree):

```ts
  if (id.includes('__')) {
    const suffix = id.split('__')[1]                      // ← wrong segment if dir has '__'
    if (suffix) {
      for (const dir of petsDirs()) {
        const candidate = join(dir, suffix)               // ← unsanitized join
        if (!existsSync(candidate)) continue
        const m = loadBundleMetadata(candidate, installedDirs)
        if (m) return { ...m, id }
      }
    }
  }
```

Repo conventions: 2-space indent, no semicolons. Path-segment hardening
elsewhere uses `assertSafePathSegment` from `src/main/security/pathSegments.ts`
(see its tests in `test/security-hardening.test.ts`) — reuse it here rather than
writing a new validator.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0 |
| Add sharp | `npm install sharp` | exit 0; `"sharp"` appears in dependencies |
| Typecheck | `npm run typecheck` | no NEW errors in `pets.ts` |
| Sanity require | `node -e "console.log(require('sharp').versions.sharp)"` (run from repo root after install) | prints a version |

## Scope

**In scope**:
- `package.json` (add `sharp` to `dependencies`; add `node_modules/sharp/**` +
  `node_modules/@img/**` to `build.asarUnpack`)
- `src/main/ipc/pets.ts`
- `test/pets-suffix-lookup.test.ts` (create, if the lookup helper is extracted — see Test plan)

**Out of scope** (do NOT touch):
- `src/renderer/src/components/PetPicker.tsx` / `PetOverlay.tsx` — the renderer
  side of the working diff is separate; don't refactor it here.
- `scripts/patch-node-pty-win.js`, electron-rebuild wiring — sharp ships
  prebuilt N-API binaries and does NOT need electron-rebuild; do not add it to
  the rebuild list.
- The `contex-file://` protocol.

## Git workflow

- The pets working-tree changes are UNCOMMITTED. Do not revert or discard them.
  Coordinate with the operator on whether to commit them first; otherwise build
  your changes on top of the working tree as-is on a branch `fix/pets-hardening`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Declare sharp

`npm install sharp` (adds to `dependencies`). Then add to `package.json` →
`build.asarUnpack` array: `"node_modules/sharp/**"` and `"node_modules/@img/**"`
(sharp's platform binaries live under `@img/*` packages).

**Verify**: `node -e "console.log(require('sharp').versions.sharp)"` → prints a
version. `grep -n '"sharp"' package.json` → one hit in dependencies.

### Step 2: Fix the suffixed-id lookup

In `loadPetManifest` in `src/main/ipc/pets.ts`, replace the split with a
first-separator slice and validate the segment before joining:

```ts
import { assertSafePathSegment } from '../security/pathSegments'
...
if (id.includes('__')) {
  const suffix = id.slice(id.indexOf('__') + 2)
  if (suffix) {
    try {
      assertSafePathSegment(suffix)
    } catch {
      return null
    }
    for (const dir of petsDirs()) {
      const candidate = join(dir, suffix)
      ...
```

Check `assertSafePathSegment`'s actual signature/behavior in
`src/main/security/pathSegments.ts` first and match it (it may throw or return;
adapt the guard accordingly). If it rejects the `-`/`_` characters the suffix
generator produces, STOP and report rather than loosening it — fall back to an
inline `/^[a-zA-Z0-9_-]+$/.test(suffix)` check and say so in the status row.

**Verify**: `grep -n "split('__')" src/main/ipc/pets.ts` → no matches.

### Step 3: Move the freshness stat inside the try

Restructure `ensureThumbnail` so the `existsSync/statSync` freshness block is
inside the existing `try` (or guard with
`if (!existsSync(manifest.spritesheetPath)) return null` first). The function
must never throw.

**Verify**: `npm run typecheck` → no new errors in `pets.ts`.

### Step 4: Confirm thumbnails actually render (if you can run the app)

`npm run dev`, open the pet picker. Expected: thumbnails render (or, with no
pets installed, no console `[pets] thumbnail failed` errors caused by
`Cannot find module 'sharp'`).

## Test plan

- Extract the suffix-parsing into a pure exported helper (e.g.
  `parseSuffixedPetId(id): { baseId: string, dirName: string } | null`) and add
  `test/pets-suffix-lookup.test.ts` (node --test, import with `.ts` extension,
  model after `test/chat-output-sanitizers.test.ts`). Cases: plain id (no `__`),
  `id__dir`, `id__dir__with__underscores` (must return the FULL remainder),
  traversal attempts (`id__../x`, `id__..`, `id__a/b`) → rejected.
- `pets.ts` imports `electron`, so test the extracted helper, not the module.

## Done criteria

- [ ] `sharp` in `dependencies`; `node -e "require('sharp')"` exits 0
- [ ] `build.asarUnpack` includes sharp + `@img` globs
- [ ] No `split('__')` remains; suffix validated before `join`
- [ ] `ensureThumbnail` cannot reject (stat inside try or existence-guarded)
- [ ] New suffix-parsing tests pass: `node --test test/pets-suffix-lookup.test.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- The working-tree pets diff is gone (committed differently or reverted).
- `npm install sharp` fails to build/download on this platform.
- Packaging: if `electron-builder` output is part of your verification and the
  packaged app can't load sharp, report the loader error — do NOT start adding
  sharp to electron-rebuild.
- `assertSafePathSegment` doesn't exist at `src/main/security/pathSegments.ts`.

## Maintenance notes

- sharp adds ~30 MB of platform binaries to the packaged app. If that's
  unacceptable, the documented alternative is deleting the sharp path entirely
  and having the picker crop the first cell from `pets:spritesheetData` with CSS
  `background-position` (the renderer already animates this way) — a follow-up,
  not this plan.
- Reviewer: check the asarUnpack globs against the actual `node_modules/@img/*`
  layout for the platforms you ship (mac arm64/x64, win, linux).
