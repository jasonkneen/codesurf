# CodeSurf Daemon Memory And Checkpoint Architecture

## Purpose

This document describes the two chat safety/context systems now living behind the daemon boundary:

- layered AGENTS/CLAUDE-style memory loading
- daemon-owned checkpoints / rewind primitives

These systems are designed so local runtime chat, local daemon chat, and remote daemon chat can converge on the same model:

- context is loaded by daemon-owned logic
- sensitive instruction buckets are classified before remote execution
- checkpoint storage and restore live in daemon-owned workspace state

## Commits

- `c95b4ce` — daemon checkpoints / rewind primitives
- `29621a0` — daemon memory loader
- `0946c08` — architecture docs for memory/checkpoints and UI manifestation

## High-level split

### Daemon-owned

- `bin/checkpoints.mjs`
- `bin/memory-loader.mjs`
- `bin/codesurfd.mjs`

The daemon owns:

- checkpoint file storage
- checkpoint listing/restoration
- AGENTS file discovery
- `@import` resolution
- privacy bucket classification
- workspace-level memory loading API

### Main-process seam

- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`

The Electron main process currently acts as a client/controller:

- asks the daemon for memory context
- injects the returned prompt into local runtime provider calls
- asks the daemon to create/list/restore checkpoints
- triggers checkpoints before risky local runtime edits

## Memory model

## Supported AGENTS / CLAUDE locations

For a workspace with one or more mounted project folders, the loader currently resolves:

- user:
  - `~/.codesurf/AGENTS.md`
  - `~/.claude/CLAUDE.md`
- project root:
  - `<project>/AGENTS.md`
  - `<project>/CLAUDE.md`
- project local/private:
  - `<project>/.codesurf/AGENTS.md`
  - `<project>/.claude/CLAUDE.md`
- nested mounted projects inside the same workspace:
  - `<nested-project>/AGENTS.md`
  - `<nested-project>/CLAUDE.md`
  - `<nested-project>/.codesurf/AGENTS.md`
  - `<nested-project>/.claude/CLAUDE.md`

The loader sorts project roots shallowest-first so the prompt keeps the same layered precedence as the workspace model.

## Buckets

Every section is classified into one of two buckets today:

- `remote-safe`
  - normal project `AGENTS.md`
  - normal project `CLAUDE.md`
  - imports that remain outside `.codesurf/` and `.claude/`
- `local-only`
  - user/global `~/.codesurf/AGENTS.md`
  - user/global `~/.claude/CLAUDE.md`
  - project-local `.codesurf/AGENTS.md`
  - project-local `.claude/CLAUDE.md`
  - imports inside `.codesurf/` or `.claude/`

Execution target decides which buckets make it into the outbound prompt:

- local execution includes:
  - `local-only`
  - `remote-safe`
- cloud / remote-daemon execution includes:
  - `remote-safe`
  - excludes `local-only`

## Import resolution

`@import <path>` lines inside AGENTS and CLAUDE files are resolved relative to the importing file.

Important safety rules:

- symlink escape is rejected
- imported files must stay inside the importing project root
- `.codesurf/*` imports stay `local-only`
- import cycles/self-imports are deduped by canonical file path

The loader strips `@import ...` lines from the section body and emits imported files as separate ordered sections with `importedFrom` metadata.

## Memory loader output

`bin/memory-loader.mjs` returns:

- `executionTarget`
- `includedBuckets`
- `sections[]`
  - `scope`
  - `bucket`
  - `displayPath`
  - `path`
  - `importedFrom`
  - `content`
- `prompt`
- `contextBuckets`
  - `version`
  - `includedBuckets`
  - `buckets[]`
    - `bucket`
    - `included`
    - `sectionCount`
    - `sections[]`
      - `scope`
      - `displayPath`
      - `importedFrom`
  - `inspect`
    - `summary`
    - `input`

The prompt is the already-layered markdown block used for provider injection.

`contextBuckets` is the inspectable outbound bundle summary used by runtime and daemon-backed chat to render the existing `Workspace Instructions` tool/status chip consistently.

## Memory APIs

### GET `/memory/load?workspaceId=...&executionTarget=local|cloud`

Implemented in:

- `bin/codesurfd.mjs`

Used by:

- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`

Behavior:

- resolves the workspace
- materializes all mounted project paths
- loads layered AGENTS and CLAUDE context
- filters by bucket for the requested execution target
- returns the final prompt plus section metadata

## Chat memory injection

### Local runtime chat

`src/main/ipc/chat.ts` now calls daemon memory loading before provider execution.

That daemon-authored memory result includes the exact `prompt` plus an inspectable `contextBuckets` bundle.

Those values are then injected into:

- Claude system prompt assembly
- Codex prompt preamble
- the existing `Workspace Instructions` tool/status chip

So local runtime chat now uses the same daemon-owned AGENTS / CLAUDE loader and the same bucket vocabulary as daemon-backed chat.

### Daemon-backed chat

`src/main/ipc/chat.ts` now forwards both `memoryPrompt` and `contextBuckets` when routing to a daemon host.

`bin/codesurfd.mjs` also backfills both fields at `/chat/job/start` if the request only contains `workspaceId` and not a prebuilt bundle.

`bin/chat-jobs.mjs` prefers the forwarded bundle and falls back to loading memory itself.

That means:

- local runtime
- local daemon
- remote daemon

all have a consistent prompt path, with the initiating host able to preserve multi-project workspace layering.

## Checkpoint model

## Storage

Checkpoints are stored under workspace daemon state:

- `~/.codesurf/workspaces/<workspaceId>/.codesurf/checkpoints/<checkpointId>.json`

Runtime sessions remain at:

- `~/.codesurf/workspaces/<workspaceId>/.codesurf/runtime-session-<tileId>.json`

Checkpoint records capture:

- checkpoint id
- workspace id
- session entry id
- label / reason / metadata
- file snapshots
- runtime session snapshot
- restore timestamp

File snapshots store both:

- logical display path
- effective filesystem path used for safe restore
- content as base64 when the file existed
- deletion marker when the file did not yet exist

## Checkpoint APIs

### POST `/checkpoint/create`

Creates a daemon-owned checkpoint record for a session entry.

### POST `/checkpoint/list`

Lists checkpoints, optionally filtered by `sessionEntryId`.

### POST `/checkpoint/restore`

Restores the checkpoint's file snapshots and runtime session snapshot.

Safety/consistency behavior:

- path confinement to workspace roots
- symlink escape rejection
- best-effort rollback of restored files on failure
- best-effort rollback of runtime-session/checkpoint metadata writes on failure

## Runtime session metadata

Runtime session state now carries checkpoint metadata such as:

- checkpoint count
- latest checkpoint id/time
- last restored checkpoint id/time

`bin/codesurfd.mjs` merges daemon-owned checkpoint metadata forward on later runtime upserts so checkpoint state is not lost when the conversation continues.

## Local runtime checkpoint triggers

Checkpoint storage is daemon-owned, and the main-process runtime chat seam asks the daemon to create checkpoints before local provider mutations.

Implemented in `src/main/ipc/chat.ts`:

- Claude local runtime:
  - `Edit`
  - `MultiEdit`
  - `Write`
  - `NotebookEdit`
- Codex local runtime:
  - `file_change` batches

Behavior:

- create checkpoint before risky mutation
- deny the tool call if checkpoint creation fails
- continue normally if checkpoint creation succeeds

## Daemon-backed checkpoint triggers

The daemon now creates checkpoints for both foreground/runtime local edits and daemon-backed provider loops.

Implemented today:

- main-process local runtime (`src/main/ipc/chat.ts`):
  - Claude `Edit`, `MultiEdit`, `Write`, `NotebookEdit`
  - Codex `file_change` batches
- daemon-backed jobs (`bin/chat-jobs.mjs`):
  - Claude approved `Edit`, `MultiEdit`, `Write`, `NotebookEdit` tool calls
  - Codex `file_change` items when `item.started` is observed (best-effort at the provider event boundary; Codex does not expose a separate blocking pre-apply hook here)

Behavior:

- create checkpoint before risky mutation when workspace/session context is available
- emit a normal `Checkpoint saved` timeline/tool chip
- deny Claude file-edit tools if checkpoint creation fails or if a known mutating tool omits a checkpointable path
- abort daemon Codex jobs if checkpoint creation fails before a file-change batch or if the file-change event omits checkpointable paths
- continue normally when checkpoint creation succeeds or when there is no workspace/session context to attach checkpoint state to

Daemon-backed checkpoint creation uses the daemon-provisioned workspace path for display/snapshot safety, not the initiating machine's raw local path.

This gives local runtime chat and daemon-backed chat the same daemon-owned checkpoint primitive; remaining future work is richer restore/history UI, not a separate checkpoint architecture.

## Renderer/UI manifestation rules

Do not introduce new dedicated memory/checkpoint React surface areas.

These systems manifest through existing UI primitives:

- existing tool/status chips in `ChatTile`
- existing `ToolBlockView` / grouped tool chips
- existing file-change rendering
- existing workspace/customisation file editing flows
- existing session row tooltip/context-menu affordances in `Sidebar`

Implemented now:

- memory loading emits a normal `Workspace Instructions` tool chip at the start of local and daemon-backed chat turns
- expanding that chip now shows the explicit outbound bucket manifest (`local-only` vs `remote-safe`) followed by the exact layered instruction prompt that was injected for the run, so the user can inspect both the bucket breakdown and the final AGENTS / CLAUDE payload
- checkpoint creation emits a normal `Checkpoint saved` tool chip before risky local runtime edits
- runtime session rows expose checkpoint count through their existing tooltip text
- runtime session context menus expose `Restore Latest Checkpoint`

See `docs/chat-ui-manifest.md` for the renderer-specific mapping.

## Source file map

### Daemon/backend

- `bin/context-buckets.mjs`
- `bin/memory-loader.mjs`
- `bin/checkpoints.mjs`
- `bin/codesurfd.mjs`
- `bin/chat-jobs.mjs`

### Main process

- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`

### Renderer touchpoints

- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/CustomisationTile.tsx`
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
- `src/renderer/src/components/ai-elements/JSXPreview.tsx`

### Tests

- `test/daemon/checkpoints.test.mjs`
- `test/daemon/memory-loader.test.mjs`
- `test/daemon/runtime-session-store.test.mjs`
- `test/daemon/project-context-daemon.test.mjs`
- `test/daemon/provider-context-policy.test.mjs`

## Practical summary

Memory loading now works as a daemon-owned layered AGENTS / CLAUDE system with import resolution and privacy buckets, while checkpoints are stored/restored by the daemon and triggered from both risky local runtime edits and daemon-backed provider file-change loops.
