# Chat UI Manifest For Memory And Checkpoints

## Rule

Do not add new dedicated renderer components for memory loading or checkpoint saving.

Use the UI primitives that already exist in the chat surface.

## Existing renderer surfaces

### 1. Chat tool/status chips

Primary file:

- `src/renderer/src/components/ChatTile.tsx`

Existing renderer primitives already handle streamed operational state:

- `tool_start`
- `tool_input`
- `tool_use`
- `tool_summary`
- `tool_progress`
- `fileChanges`
- permission request / resolution cards
- grouped/collapsed tool chips

Relevant components inside `ChatTile.tsx`:

- `ToolBlockView`
- `CollapsedToolGroup`
- `MixedToolGroup`
- `ThinkingBlockView`
- `ToolPermissionCard`

These are the correct surfaces for operational chat events like:

- checkpoint saved
- checkpoint restore
- workspace instructions loaded
- file-change summary after checkpointed edits

### 2. Workspace/customisation file editing

Primary file:

- `src/renderer/src/components/CustomisationTile.tsx`

This tile already discovers and exposes:

- `<workspace>/AGENTS.md`
- `<workspace>/CLAUDE.md`
- `<workspace>/.claude/CLAUDE.md`
- `~/.claude/CLAUDE.md`

as prompt/configuration sources.

That means AGENTS and CLAUDE memory already have a natural editing/discovery entry point in the UI. Do not build a parallel instruction editor surface.

### 3. Existing AI elements already in use

Current local AI element wrappers in the repo are:

- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
- `src/renderer/src/components/ai-elements/JSXPreview.tsx`

The important point is not to invent another renderer subsystem. Reuse the same chat/tool rendering pattern already used by these AI elements and by `ChatTile` tool blocks.

## How the new backend work should show up in UI

## Memory loading

### Current reality

What is already true today:

- AGENTS and CLAUDE memory are now loaded daemon-side
- the resulting prompt is injected into local runtime and daemon chat paths
- the start of a chat turn now emits a normal existing chat tool chip labeled `Workspace Instructions`
- AGENTS and CLAUDE files themselves are discoverable/editable via `CustomisationTile`

### Correct UI manifestation

Use the existing chat tool/status chip model.

Implemented manifestation:

- memory loading now appears as a normal tool/status chip in `ChatTile`
- it renders through existing `ToolBlockView`
- its collapsed summary text reports:
  - how many sections were loaded
  - explicit bucket counts for `local-only` and `remote-safe`
  - a short list of contributing files
- expanding the chip now reveals the outbound context bucket manifest first, then the exact injected instruction prompt, including the section headings and file paths that were read for that run

That gives the user an inspectable "what context was loaded" trace without creating any new component family.

### What not to do

Do not create:

- a separate "memory panel" inside chat
- a new React component just for instruction file sections
- a second AGENTS/CLAUDE browser/editor when `CustomisationTile` already exposes the files

## Checkpoints

### Current reality

What is already true today:

- checkpoints are daemon-owned
- local runtime Claude/Codex create checkpoints before risky edits
- checkpoint records can be listed/restored through daemon APIs
- runtime session state now carries checkpoint metadata
- checkpoint saves now appear as normal existing chat tool chips
- session rows expose checkpoint count in their existing tooltip text
- runtime session context menus can restore the latest checkpoint without adding a new component family

### Correct UI manifestation

Again, use the existing chat tool/status chips and existing session/file-change surfaces.

Implemented manifestation:

- checkpoint save appears as a normal operational chip in the message stream
- file changes after checkpointed edits continue using existing file-change chips/diff expanders
- session/history rows reuse their existing tooltip and context-menu surfaces for checkpoint count and latest-restore action
- conversation rows now use an archive affordance instead of destructive delete, and the existing thread filter menu can reveal archived conversations when needed

### Rewind / restore affordance

Rewind is surfaced through an existing UI surface:

- runtime session context menu entry: `Restore Latest Checkpoint`

The actual restore work remains daemon-side. The renderer only invokes the restore API, refreshes session state, and reopens the restored session in chat using existing flows.

## Concrete renderer mapping

### Memory

Backend source:

- `GET /memory/load`
- `bin/context-buckets.mjs`
- `src/main/ipc/chat.ts` runtime memory prompt loading
- `bin/chat-jobs.mjs` daemon memory prompt usage

Renderer mapping:

- stream a normal tool/status chip in `ChatTile`
- edit the underlying AGENTS or CLAUDE file through `CustomisationTile`

### Checkpoints

Backend source:

- `POST /checkpoint/create`
- `POST /checkpoint/list`
- `POST /checkpoint/restore`
- `runtime-session-*.json` checkpoint metadata

Renderer mapping:

- checkpoint save/restore as normal tool/status chips in `ChatTile`
- file diffs continue through `ToolBlockView`
- session/history counts later piggyback on existing session-row UI

## What app docs should say

For product/app documentation, describe the UI this way:

- CodeSurf loads layered AGENTS and CLAUDE instructions automatically for each workspace
- local/private instructions are kept local and are not sent to cloud execution paths
- before risky local edits, CodeSurf saves daemon-owned checkpoints
- checkpointed edits and file changes appear in the normal chat operation stream
- AGENTS and CLAUDE instructions are edited through the existing workspace customisation flow
- rewind/restore is an action on existing chat/history surfaces, not a separate mode or screen

## Short version for docs writers

Memory and checkpoints are not separate mini-apps inside CodeSurf. They are backend systems that surface through the existing chat tool chips, file-change chips, session rows, and workspace customisation file editing flow.
