# Plan 011: Unify the sensitive-directory denylist across fs IPC and the file protocol; untrack `.mcp.json`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 77e3c7d..HEAD -- src/main/ipc/fs.ts src/main/file-protocol-auth.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2 (security hardening)
- **Effort**: S
- **Risk**: LOW-MED (tightens what fs IPC can read — one deliberate carve-out to preserve)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `77e3c7d`, 2026-07-01

## Why this matters

Two boundaries guard the same home directory and disagree. The media
file-protocol denylist (`file-protocol-auth.ts`) was deliberately expanded to
~17 sensitive entries (`.netrc`, `.npmrc`, `.git-credentials`, `.docker`,
`.kube`, `.password-store`, …). The far more powerful full read/write/delete
fs IPC surface (`fs.ts`) still uses a 4-entry list (`.ssh`, `.gnupg`, `.aws`,
`.config`). When workspace scoping is off (default `restrictFsToWorkspaceRoots:
false`, and users can explicitly opt out), a compromised renderer can read or
overwrite `~/.git-credentials`, `~/.npmrc`, `~/.kube/config`, etc. through fs
IPC even though the weaker protocol already blocks them. One shared constant
removes the gap and keeps future additions in sync.

Bonus cleanup in the same sweep: the repo-root `.mcp.json` is listed in
`.gitignore` (line 20) but is still **tracked**, so it keeps getting committed
with a live-looking `Authorization: Bearer <uuid>` header (the token is
regenerated per app launch, so committed values are dead — hygiene issue, not a
live leak; no rotation needed).

## Current state

- `src/main/ipc/fs.ts:57`:

```ts
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.config']
```

  Used in `validateFsPath` (fs.ts:126-132) to reject `~/<dir>/**`. Directly
  above the loop, two carve-outs run FIRST and must keep working:
  - `CODESURF_HOME` paths always allowed (fs.ts:120)
  - `allowReadOnlyOpenCodeConfig` allows `~/.config/opencode/{skills,prompts,agents}`
    (fs.ts:95-102, 122-124) — note this lives UNDER `.config`, which is on both
    denylists; the carve-out must stay evaluated before the denylist.

- `src/main/file-protocol-auth.ts:23-41`:

```ts
export const SENSITIVE_HOME_DIRS = new Set([
  '.ssh', '.gnupg', '.aws', '.config', '.kube', '.docker', '.netrc', '.npmrc',
  '.pypirc', '.git-credentials', '.gem', '.cargo', '.password-store',
  '.mozilla', '.thunderbird', '.local', '.cache',
])
```

  Already exported. Note some entries are FILES (`.netrc`, `.npmrc`, `.pypirc`,
  `.git-credentials`), not directories — check how `file-protocol-auth.ts`
  matches them (exact-name match as a path segment) and replicate that
  semantics in `validateFsPath`, whose current loop only handles the
  `~/<dir>/...` prefix case (`resolved.startsWith(sensitive + path.sep) || resolved === sensitive`
  — the `===` case actually covers plain files already; confirm).

- `.gitignore:20` contains `.mcp.json`; `git ls-files .mcp.json` → tracked.

**Caution**: `.local` and `.cache` on the shared list are BROAD (`~/.local`
holds user-installed software; `~/.cache` is huge). They're appropriate for the
media protocol; for fs IPC they could break legitimate workflows (e.g. opening
a file in `~/.local/share`). Decision for this plan: adopt the full shared list
for fs **writes/deletes**, but if that proves too blunt for reads, see the STOP
condition — do not silently pick your own subset.

Repo conventions: 2-space indent, no semicolons. Shared security constants
belong in `src/main/security/` (see existing modules there).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (if needed) | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | no NEW errors in touched files |
| fs scope tests | `node --test test/fs-workspace-scope.test.ts` (confirm filename: `ls test | grep fs-`) | all pass |
| Untrack | `git rm --cached .mcp.json` | exit 0; file stays on disk |

## Scope

**In scope**:
- `src/main/security/sensitivePaths.ts` (create — the shared constant)
- `src/main/ipc/fs.ts` (consume it)
- `src/main/file-protocol-auth.ts` (re-export/consume from the shared module)
- Existing fs-scope test file (extend)
- `.mcp.json` (untrack only — `git rm --cached`; do not edit or delete the file)

**Out of scope** (do NOT touch):
- `restrictFsToWorkspaceRoots` default or the opt-out flow in
  `src/shared/settings-runtime.ts` — scoping policy is a separate decision.
- The OpenCode read-only carve-out — preserve exactly.
- Daemon/relay fs surfaces.

## Git workflow

- Branch: `security/shared-sensitive-denylist`
- Two commits: (1) denylist unification, (2) `.mcp.json` untrack.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the shared constant

New file `src/main/security/sensitivePaths.ts`: move the `SENSITIVE_HOME_DIRS`
set (content exactly as in `file-protocol-auth.ts` today) there, exported. In
`file-protocol-auth.ts`, import and re-export it (keep the existing name so
current importers don't break: `grep -rn "SENSITIVE_HOME_DIRS" src/ test/`).

**Verify**: `npm run typecheck` → no new errors; grep shows all previous
importers still resolve.

### Step 2: Consume it in `validateFsPath`

In `fs.ts`, delete the local `SENSITIVE_DIRS` and iterate the shared set. Keep
the existing match expression (`startsWith(sensitive + path.sep) || resolved === sensitive`)
— it covers both directory-prefix and exact-file cases. Preserve carve-out
order: CODESURF_HOME check, then OpenCode carve-out, THEN the denylist.

**Verify**: `grep -n "SENSITIVE_DIRS" src/main/ipc/fs.ts` → no matches;
`node --test test/fs-workspace-scope.test.ts` → passes (extend it per Test plan).

### Step 3: Untrack `.mcp.json`

`git rm --cached .mcp.json` (already gitignored at `.gitignore:20`, so it will
not re-add). Commit. The token inside self-rotates on next app launch — no
rotation action needed.

**Verify**: `git ls-files .mcp.json` → empty output; the file still exists on disk (`ls .mcp.json`).

## Test plan

Extend the existing fs scope/validation test (find it: `ls test | grep -iE 'fs-|workspace-scope'`;
model new cases after its existing style):

- `~/.git-credentials` → rejected by `validateFsPath`
- `~/.npmrc` → rejected
- `~/.kube/config` → rejected
- `~/.config/opencode/skills/x.md` with `allowReadOnlyOpenCodeConfig` → still allowed
- `~/.config/other/x` → rejected (as before)
- A workspace-root path → still allowed

## Done criteria

- [ ] One shared sensitive-path constant; both boundaries consume it
- [ ] All Test-plan cases pass: `node --test <fs test file>`
- [ ] `npm run typecheck` shows no new errors in touched files
- [ ] `git ls-files .mcp.json` → empty; file present on disk
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- Adopting the full list breaks an existing test or an in-repo caller reads
  from `~/.local`/`~/.cache` legitimately (grep first:
  `grep -rn "\.local\|\.cache" src/main/ipc src/main/session-sources | grep -v node_modules`).
  Report the caller; the maintainer decides whether those two entries apply to
  fs IPC or get a documented exclusion.
- `SENSITIVE_HOME_DIRS` semantics in `file-protocol-auth.ts` turn out to be
  matched differently than described (e.g. segment-anywhere matching) — align
  deliberately, don't guess.

## Maintenance notes

- Future sensitive entries go in `sensitivePaths.ts` only — both boundaries
  inherit. A comment there should say which two consumers exist.
- Reviewer: confirm the OpenCode carve-out still precedes the denylist and that
  the `.local`/`.cache` decision (include vs exclude for fs IPC) was made
  explicitly, not by accident.
