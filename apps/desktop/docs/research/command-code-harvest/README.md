# Command Code feature harvest for CodeSurf

CodeSurf project root:

- `/Users/jkneen/clawd/collaborator-clone`

Important naming note:

- the product name is **CodeSurf**
- `collaborator-clone` is only the folder name

This mini-doc set captures what we can safely learn from the extracted Command Code client, what should become product code inside CodeSurf, what can be shipped as reusable skills/workflows, and how to stage adoption.

## Documents in this folder

1. `reusable-code-patterns.md`
   - concrete client-side patterns worth adopting in CodeSurf
   - where they fit in CodeSurf's architecture
   - what to avoid copying directly

2. `skills-vs-code.md`
   - classification of what should be product code vs. packaged as skills/content
   - guidance for where skills should live in CodeSurf

3. `codesurf-adoption-plan.md`
   - phased implementation plan for CodeSurf
   - where, when, and how to land the useful parts

## Quick take

The most useful things to take from Command Code are **not** its hosted model backend.

The real value is in the client shell:

- local session persistence
- checkpoint / rewind
- layered AGENTS-style memory loading
- MCP connection management
- tool gating / permission modes
- skill discovery and packaging
- local file reference expansion
- careful separation of orchestration from UI

The main thing we should **not** copy is the oversharing behavior in remote calls.

For CodeSurf, the right approach is:

- adopt the strong local architecture patterns
- redesign remote context transfer with stricter privacy boundaries
- make context sharing explicit and configurable

## Priority order for CodeSurf

### Highest-value product code

1. Session store + thread persistence
2. Checkpoints / rewind for risky actions
3. Layered memory loading (`AGENTS.md`-style)
4. MCP connection manager + surfaced tool inventory
5. Tool permission UX
6. Skill packaging / install flow

### High-value, but needs privacy redesign

1. File reference expansion (`@file`)
2. Context assembly for provider calls
3. Prompt-side skill injection
4. Context compaction / summarization helpers

### Do not emulate directly

1. default-on telemetry with opaque outbound traces
2. generic privacy copy that does not explicitly enumerate code-context transfer
3. silently shipping memory / repo metadata / tool outputs upstream

## Best source trees to read while doing this work

Use these in the command-code extraction workspace:

### For product behavior
- `source-like/command-code/by-path/`
- `source-like/command-code/domains/`

### For least-bundle-looking modules
- `decompiled/command-code/by-path/`
- `decompiled/command-code/domains/`

### For exact recovery / provenance
- `rebuildable/command-code/src/chunks/`
- `recovered/meta/modules.json`

## Best starting files

- auth/provider state
  - `decompiled/command-code/by-path/src/auth/index.ts`
  - `decompiled/command-code/by-path/src/auth/codex.ts`
  - `decompiled/command-code/by-path/src/auth/anthropic.ts`
- session store
  - `source-like/command-code/by-path/src/sessions/index.ts`
- MCP management
  - `source-like/command-code/by-path/src/mcp/client/connection-manager.ts`
- tool model / gating
  - `source-like/command-code/by-path/shared/constants/tools.ts`
  - `source-like/command-code/by-path/src/tools/get-tools-for-mode.ts`
- context assembly
  - `source-like/command-code/by-path/src/chat/context-engine.ts`
- skills
  - `source-like/command-code/by-chunk/0142__src-tools-skills-loader.ts.mjs`
  - `source-like/command-code/by-chunk/0143__src-tools-skills-xml-generator.ts.mjs`

## CodeSurf-specific reminder

CodeSurf already has useful anchor points for this work:

- `src/main/ipc/chat.ts`
- `src/main/ipc/skills.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/SkillInstallModal.tsx`
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
- `src/main/db/thread-indexer.ts`

The adoption plan in this folder is written around those files.
