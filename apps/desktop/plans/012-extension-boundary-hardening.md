# Plan 012: Make extension identity, discovery, and asset paths fail closed

> **Executor instructions**: Read this plan fully before editing. Work in the
> isolated worktree assigned by the reviewer. Preserve unrelated changes and do
> not merge or push. Run every verification command below. If a STOP condition
> occurs, stop and report it rather than broadening the design.
>
> **Drift check**: `git diff --stat bc2d0a94..HEAD -- src/main/extensions/registry.ts src/main/extensions/light-scan.ts src/main/extensions/protocol.ts src/main/ipc/extensions.ts`

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: security, correctness
- **Planned at**: commit `bc2d0a94`, 2026-07-30
- **Implemented at**: branch `advisor/epic-012-extension`, final commit
  `7a6cec5d0441a4bf36bfaeea6e74e5cca9e6e2c7`
- **Review result**: done in the isolated branch. Independent review first
  found source-shape tests instead of registered-handler behavior, a
  canonical-path reopen race, archive package/effective-id mismatch, and
  adapter output written before adapted-manifest validation. A final
  spot-check found lightweight/full collision precedence drift, explicit
  `null` failing to clear the prior workspace, and an unbounded `readFile`
  after a size precheck. The final branch aligns discovery precedence and IPC
  output, distinguishes `null` from `undefined`, retains authenticated
  no-follow handles, uses positional `maxBytes + 1` text reads, validates
  effective identities transactionally, and validates adapters before writes.
  Five focused suites pass 27/27, both typechecks and the main-process build
  pass, and diff/commit checks pass. Full product E2E and cross-platform
  archive behavior remain integration scope.

## Why this matters

Workspace extensions are untrusted input. Three related gaps currently let
that input cross host boundaries incorrectly:

1. A manifest only needs truthy `id`, `name`, and `version` fields
   (`registry.ts:279-303,327-359`). An id such as `../mcp-server` can flow into
   `extensionSettingsPath()` (`ipc/extensions.ts:196-218,430`) and escape
   `~/.codesurf/extension-settings`.
2. Extension asset containment is lexical (`extensions/protocol.ts:71-84,
   137-150,171-192`). A symlink inside an extension can point outside its root
   and still be served by `codesurf-ext://`.
3. `ext:list-sidebar` performs a lightweight workspace scan
   (`ipc/extensions.ts:277-306`), but `scanLightweight()` does not record that
   workspace (`registry.ts:196-218`). A subsequent `ext:list-tiles` full scan
   can therefore omit the extension that the sidebar just offered.

The fix should establish one extension-id contract, one canonical resource
boundary, and one authoritative active-workspace transition.

## Scope

In scope:

- `src/main/extensions/identity.ts` (new shared validator)
- `src/main/extensions/registry.ts`
- `src/main/extensions/light-scan.ts`
- `src/main/extensions/protocol.ts`
- `src/main/ipc/extensions.ts`
- Focused tests under `test/`

Out of scope:

- Changing safe/power tier policy
- Claiming that brokered Node plugins are sandboxed
- Reworking extension packaging or the public SDK
- Renderer styling or tile chrome

## Required design

### 1. Establish a single extension-id contract

Add a pure validator used by full scans, lightweight scans, adapters, install,
settings reads/writes, and protocol routing.

- Accept only lowercase ASCII ids composed of letters, digits, `.`, `_`, and
  `-`, starting with a letter or digit.
- Limit ids to 128 characters.
- Reject empty segments, `.`/`..`, slashes, backslashes, percent escapes,
  control characters, and leading/trailing punctuation.
- Preserve every tracked bundled/example id. Confirm with:
  `rg -n '"id"\\s*:' bundled-extensions examples/extensions test/fixtures`.
- Invalid lightweight manifests are skipped; invalid full/install manifests
  produce an actionable error containing the extension directory, not secrets.

Do not duplicate the regex in multiple modules.

### 2. Constrain settings paths independently

`extensionSettingsPath(extId)` must validate the id and assert that the resolved
candidate is a child of the resolved settings root. Settings reads and writes
must also require the extension to exist in the registry. Create the settings
directory with its existing private permissions before writing.

The containment assertion stays even after id validation as defense in depth.

### 3. Resolve asset paths canonically

Before serving any extension-owned file:

- Resolve the extension root with `realpath`.
- Resolve the requested file with `realpath`.
- Compare with `path.relative` against the canonical root.
- Serve the canonical candidate, not the lexical alias.
- Return 403 for a resolved path outside the root and 404 for a missing file.

Apply the same helper to the normal extension host and
`__runext_resource__`. Keep each extension on its existing origin and preserve
bridge injection. Also make the codicon route use the same canonical rule, or
document in the test why its trusted package root is handled separately.

### 4. Make lightweight discovery establish workspace identity

When `scanLightweight(explicitWorkspacePath)` succeeds, record the normalized
workspace path as the registry's active workspace before returning results.
Do not clear a valid active workspace when the argument is omitted. Serialize
this transition with the registry's existing rescan queue, or provide an
equivalent last-request-wins guard so overlapping workspace switches cannot
restore an older path.

After a fresh-start `ext:list-sidebar(workspaceA)`, `ext:list-tiles` and
`ext:tile-entry` must resolve workspace A's extension. After switching to
workspace B, A's contribution must disappear and B's must resolve.

## Test plan

Add behavioral tests that use temporary directories:

- A manifest id `../mcp-server` is rejected by full and lightweight loading.
- Settings read/write with traversal, separator, percent-encoded, uppercase,
  or overlong ids cannot create a file outside `extension-settings`.
- All tracked bundled extension ids pass the shared validator.
- An asset symlink to an external fixture receives 403; a normal nested asset
  receives 200; a missing asset receives 404.
- The `__runext_resource__` route cannot follow an external symlink.
- Fresh lightweight discovery followed by executable tile lookup preserves the
  workspace; switching workspaces replaces it deterministically.

Prefer exported pure helpers for path/identity tests. If Electron protocol
registration cannot be instantiated in Node tests, extract a small resolver
that returns `{ ok, path, status }` and test that resolver directly.

## Verification

```bash
node --test test/extension-manifest-security.test.ts
node --test test/extension-light-scan.test.ts
node --test test/extension-loading-hardening.test.ts
npm run typecheck
npm run typecheck:tsc
git diff --check
```

Run any new focused test file explicitly. Confirm no tracked extension id is
silently dropped.

## Done criteria

- [x] One extension-id validator is authoritative at every host boundary
- [x] Settings paths cannot escape their root
- [x] Extension assets cannot escape through symlinks
- [x] Lightweight discovery and executable lookup agree on active workspace
- [x] Regression tests cover traversal, symlink, and workspace-switch cases
- [x] Both typecheck implementations pass
- [x] Executor commit is reviewable and contains no unrelated changes

## STOP conditions

Stop and report if:

- A tracked extension id violates the proposed grammar; list it and do not
  silently rename it.
- The only viable workspace fix requires a renderer API breaking change.
- Canonical asset resolution breaks a deliberate extension-root symlink. Report
  the exact path; a root symlink may be canonicalized, but a child escape may
  not be allowed.
- Tests require weakening the path check or safe-tier policy.
