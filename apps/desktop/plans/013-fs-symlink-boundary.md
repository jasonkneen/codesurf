# Plan 013: Close filesystem IPC symlink escapes

> **Executor instructions**: Read this plan fully before editing. Work only in
> the assigned isolated worktree. Preserve the OpenCode read-only carve-out and
> the sensitive-path denylist. Do not merge or push.
>
> **Drift check**: `git diff --stat bc2d0a94..HEAD -- src/main/ipc/fs.ts src/main/security/sensitivePaths.ts test/fs-workspace-scope.test.ts`

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: Plan 011 (already landed)
- **Category**: security
- **Planned at**: commit `bc2d0a94`, 2026-07-30
- **Implemented at**: branch `advisor/epic-013-fs-symlink`, final commit
  `51ff016a7717d478d79ce0ec766a11c0275508d2`
- **Review result**: done in the isolated branch. Independent review first
  found broken-root isolation, canonical response-identity regressions, and
  validator-only tests. The next spot-check reproduced an ancestor-directory
  swap before mutation, safe-link deletion failure, watcher leakage after root
  retargeting, and missing handler coverage. A final concurrency check found
  `watchStop` could overtake async `watchStart`. The branch now retains
  authorization identity through file-handle I/O, revalidates parent and
  target identity before content mutation, cleans only inode-matched failed
  creates, unlinks safe symlink entries without following them, reference
  counts watchers by canonical lifecycle, and serializes watch operations per
  renderer/key. The focused suite passes 46/46, both typechecks and the
  main-process build pass, and diff/commit checks pass. Node has no portable
  `openat`/`unlinkat`; the irreducible transient empty-create and remaining
  path-based unlink/rename/mkdir windows are documented rather than overstated.

## Why this matters

`validateFsPath()` checks lexical paths with `path.resolve`
(`src/main/ipc/fs.ts:68-95,119-145`). The handlers then call `readFile`,
`writeFile`, `stat`, `rm`, `rename`, and copy operations on that lexical path
(`:272-457`). A symlink inside an allowed workspace can therefore point to
`~/.ssh`, `/etc`, another workspace, or any other disallowed location and the
underlying filesystem call follows it.

The policy must apply to what the kernel will access, not just the string the
renderer supplied.

## Scope

In scope:

- `src/main/ipc/fs.ts`
- A focused helper under `src/main/security/` if that keeps operation policy
  explicit
- `test/fs-workspace-scope.test.ts` and a new integration-style filesystem test
  if useful

Out of scope:

- Changing `restrictFsToWorkspaceRoots` defaults
- Removing the read-only OpenCode skills/prompts/agents carve-out
- Daemon, terminal, relay, or browser download filesystem surfaces
- Broad permission-system redesign

## Required design

### 1. Separate lexical normalization from canonical authorization

Keep the existing fast pure checks, then add an async canonical check used by
every IPC operation.

- Canonicalize every configured allowed root and `CODESURF_HOME`.
- For an existing target, resolve `realpath(target)` and authorize that result.
- For a target that may not exist, walk to the nearest existing ancestor,
  resolve it with `realpath`, then append only the remaining basename segments.
- Reject an existing final component that is a symbolic link for operations
  that read or overwrite file contents.
- Apply the sensitive-home denylist to both the original resolved path and the
  canonical path.
- Never treat `ENOENT` as authorization success unless the canonical parent has
  already passed.

Give the helper an operation intent such as `read`, `create`, `write`,
`delete-link`, or `directory`. This avoids one ambiguous policy for operations
with different symlink behavior.

### 2. Use the canonical result

Handlers must perform their operation on the path returned by the canonical
validator. Do not validate one path and operate on a different lexical alias.

For two-path operations (`rename`, copy/move), validate source and destination
independently. Destination validation must canonicalize the existing parent.

For recursive directory operations, reject a symlinked directory target rather
than traversing it. Deleting a symlink itself may be allowed only when the link
entry is lexically inside an allowed root and the implementation demonstrably
unlinks the link rather than following it.

### 3. Reduce the race window

Where Node supports it, open existing files with `O_NOFOLLOW` and use the file
handle for read/write. Re-stat the opened handle against the validated target
before content access. If a portable no-follow flow is not viable for one
operation, leave a precise comment and test the preflight behavior; do not
claim the race is solved.

## Test plan

Use `mkdtemp`, real files, and real symlinks:

- Allowed workspace file read/write still succeeds.
- Workspace symlink to an external file is rejected for read, write, stat, and
  reveal/open operations.
- Workspace symlinked directory to an external directory is rejected for list,
  create, recursive delete, and copy destination.
- A symlink to `~/.ssh` or another sensitive path is rejected even with
  workspace scoping disabled.
- A non-existent file below a real allowed parent can be created.
- A non-existent file below a symlinked parent cannot be created.
- Rename/copy cannot cross the canonical boundary through either endpoint.
- The existing OpenCode read-only carve-out still permits reads and never
  permits writes.
- `CODESURF_HOME` remains usable for legitimate app state.

Test the exported operation-aware validator directly and retain the current
pure tests.

## Verification

```bash
node --test test/fs-workspace-scope.test.ts
npm run typecheck
npm run typecheck:tsc
npm run build:main
git diff --check
```

## Done criteria

- [x] Every fs IPC handler authorizes the canonical target it uses
- [x] Existing and parent-directory symlink escapes are covered
- [x] Sensitive-path and OpenCode policies retain their intended order
- [x] Two-path operations validate both sides
- [x] Focused tests pass on macOS
- [x] Both typechecks and the main-process build pass

## STOP conditions

Stop and report if:

- A legitimate in-repo workflow intentionally follows a child symlink outside
  its allowed root.
- Correctness requires changing workspace-scope defaults or exposing a new
  renderer permission.
- A proposed helper authorizes missing paths without proving their existing
  parent is inside a canonical allowed root.
- The implementation can only pass tests by swallowing `EACCES`/`EPERM` or
  weakening the sensitive-path denylist.
