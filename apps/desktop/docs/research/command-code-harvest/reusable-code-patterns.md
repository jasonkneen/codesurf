# Reusable code patterns from Command Code for CodeSurf

This document focuses on the parts of the extracted Command Code client that are genuinely useful to us in CodeSurf.

It is deliberately biased toward:

- strong local architecture
- reusable UX patterns
- privacy-preserving redesign

## 1. Session persistence as a first-class subsystem

## Why it matters

Command Code treats sessions as durable, local, per-project artifacts instead of transient UI state.
That is the correct shape for CodeSurf too.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/by-path/src/sessions/index.ts`

Key ideas worth keeping:

- slugified project path -> local project folder
- JSONL for appendable session history
- message IDs and parent IDs
- git branch captured with session state
- simple migration path for format changes

## How to use this in CodeSurf

### CodeSurf location

Main-process persistence layer, not renderer state.

Recommended landing zone:

- new folder: `src/main/session-store/`

Likely files:

- `src/main/session-store/index.ts`
- `src/main/session-store/jsonl-store.ts`
- `src/main/session-store/session-types.ts`
- `src/main/session-store/migrations.ts`

### Integration points

- `src/main/ipc/chat.ts`
  - chat turns should append to local thread/session storage
- `src/main/db/thread-indexer.ts`
  - should index these stored sessions for fast lookup/search
- `src/preload/index.ts`
  - expose read/list/resume IPC for renderer
- renderer chat UI
  - resume existing conversation history per tile/workspace/thread

### Design note

Use CodeSurf-native paths, not `.commandcode`:

- `~/.codesurf/projects/<slug>/threads/<threadId>.jsonl`

## 2. Checkpoint / rewind before risky operations

## Why it matters

This is one of the best user-trust features in Command Code.
For CodeSurf, it is even more important because the app already acts like a collaborative workspace rather than a single terminal.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/by-path/src/lib/checkpoints/`

Key ideas:

- snapshot before edits
- rewind to earlier point in a session
- keep file-history adjacent to conversation history

## How to use this in CodeSurf

### CodeSurf location

Recommended landing zone:

- new folder: `src/main/checkpoints/`

Likely files:

- `src/main/checkpoints/checkpoint-manager.ts`
- `src/main/checkpoints/file-history.ts`
- `src/main/checkpoints/session-snapshots.ts`

### Integration points

- `src/main/ipc/chat.ts`
  - create snapshots before write/edit/apply actions
- terminal/code/browser tool execution paths
  - snapshot files or workspace entities before mutation
- renderer
  - expose a visible rewind/revert affordance in chat + workspace event history

### Good CodeSurf version

Because CodeSurf is spatial and multi-tile, checkpoints should also include:

- chat state
- tile state references
- affected files
- workspace scope

## 3. Layered AGENTS-style instruction loading

## Why it matters

This is one of the most transferable architectural ideas.
It gives the model consistent local context without hardcoding behavior per app.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/by-chunk/0139__src-utils-memory.ts.mjs`

What it does:

- loads enterprise/user/project AGENTS-style files
- supports nested project memory
- supports `@imports`
- merges into one context blob for later use

## How to use this in CodeSurf

### CodeSurf location

Recommended landing zone:

- new folder: `src/main/context/`

Likely files:

- `src/main/context/memory-loader.ts`
- `src/main/context/import-resolver.ts`
- `src/main/context/context-sanitizer.ts`

### Integration points

- `src/main/ipc/chat.ts`
  - include workspace/project instruction context before provider calls
- `src/main/index.ts`
  - initialize defaults / migration helpers
- renderer settings
  - explicit toggle for including workspace memory in outbound requests

### Important redesign

Do not silently ship all AGENTS content upstream.
CodeSurf should classify context into buckets:

- local-only
- local + selective remote
- full remote

## 4. MCP connection manager

## Why it matters

Command Code’s MCP layer is one of the cleanest and most reusable systems in the extracted code.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/by-path/src/mcp/client/connection-manager.ts`

Key ideas:

- merged config loading
- stdio + HTTP transports
- reconnect logic
- dynamic tool discovery
- prefixed tool names per server

## How to use this in CodeSurf

### CodeSurf location

CodeSurf already has:

- `src/main/mcp-server.ts`

Add a sibling client manager, not just a server.

Recommended landing zone:

- `src/main/mcp-client/`

Likely files:

- `src/main/mcp-client/connection-manager.ts`
- `src/main/mcp-client/stdio-transport.ts`
- `src/main/mcp-client/http-transport.ts`
- `src/main/mcp-client/config.ts`

### Integration points

- `src/main/ipc/chat.ts`
  - resolve usable tools for active provider run
- renderer sidebar / settings
  - show connected MCP servers and discovered tools
- extension model
  - surface MCP servers as a first-class workspace capability

## 5. Tool permission model and UX

## Why it matters

Command Code’s permission model is strong, and CodeSurf already has the beginnings of this.

## Useful Command Code pattern

Evidence:

- tool gating concepts from Command Code
- CodeSurf already has:
  - `src/main/permissions.ts`
  - `src/renderer/src/components/ai-elements/ToolPermission.tsx`

## How to use this in CodeSurf

### CodeSurf location

This is already partially native to CodeSurf.
We should harden and productize it rather than re-invent it.

### Integration points

- `src/main/ipc/chat.ts`
  - enforce provider/tool/workspace permission checks centrally
- `src/main/permissions.ts`
  - persist grants with richer scopes
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
  - keep inline prompt card UX
- settings UI
  - inspect/reset grants

### Recommendation

Add explicit permission scopes:

- once
- session
- workspace
- today
- forever

And separately classify risk:

- read-only
- local mutation
- external network / exfiltration

## 6. Skill packaging and install flow

## Why it matters

CodeSurf already appears to be heading this direction.
Command Code’s skill-loading model plus CodeSurf’s `.skill` package flow are highly compatible.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/by-chunk/0142__src-tools-skills-loader.ts.mjs`
- `source-like/command-code/by-chunk/0143__src-tools-skills-xml-generator.ts.mjs`

CodeSurf existing anchors:

- `src/main/ipc/skills.ts`
- `src/renderer/src/components/SkillInstallModal.tsx`

## How to use this in CodeSurf

### CodeSurf location

Keep CodeSurf’s install/distribution UX.
Adopt Command Code’s global/project merge model.

Recommended persistent dirs:

- global: `~/.codesurf/skills`
- project: `<workspace>/.codesurf/skills`

### Integration points

- `src/main/ipc/skills.ts`
  - add list/load/merge/export helpers
- `src/main/ipc/chat.ts`
  - include selected skill summaries in provider context
- renderer
  - skill browser / skill assignment per workspace, tile, or thread

## 7. File-reference expansion (`@file`)

## Why it matters

This is fantastic UX when done safely.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/by-chunk/0188__src-utils-file-references.ts.mjs`

What it does:

- detects `@path`
- reads file content locally
- injects content into prompt payload

## How to use this in CodeSurf

### CodeSurf location

Recommended landing zone:

- `src/main/context/file-references.ts`

### Integration points

- `src/main/ipc/chat.ts`
  - preprocess user input before provider execution
- code/browser/file tiles
  - add insert-reference UI so users don’t need to hand-type paths

### Important redesign

CodeSurf should never silently upload file content.
The flow should be explicit:

- inline preview of referenced files
- visible token/size estimate
- privacy mode warning if remote provider selected

## 8. Share sanitization / outbound scrubbing

## Why it matters

This is worth copying conceptually, even though their main generation path still overshares.

## Useful Command Code pattern

Evidence:

- `source-like/command-code/domains/shared.ts:825-907`

Useful ideas:

- sanitize messages before explicit sharing
- path rewriting / path abstraction
- object/content sanitization helpers

## How to use this in CodeSurf

### CodeSurf location

Recommended landing zone:

- `src/main/privacy/`

Likely files:

- `src/main/privacy/path-sanitizer.ts`
- `src/main/privacy/message-sanitizer.ts`
- `src/main/privacy/provider-context-policy.ts`

### Integration points

- all provider calls in `src/main/ipc/chat.ts`
- all share/export flows
- daemon / relay integrations

## 9. What not to copy as-is

Do not copy these directly:

1. Default-on telemetry with external traces
2. Generic privacy text for a code-heavy agent product
3. Silent inclusion of:
   - AGENTS memory
   - git status
   - recent commits
   - file contents
   - tool outputs

## CodeSurf design rule from this research

Whenever remote provider execution is involved, CodeSurf should differentiate between:

- **workspace context available locally**
- **workspace context approved for remote transmission**

That one separation will let us borrow the best parts of Command Code without inheriting the privacy ambiguity.
