# Skills vs code for CodeSurf

This document answers a practical question:

What should become **product code** in CodeSurf, and what should instead become **skills/content packages**?

## Rule of thumb

Use **code** when the capability changes runtime behavior, persistence, permissions, provider orchestration, or core UI.

Use **skills** when the capability is reusable instructional knowledge, task framing, workflow guidance, templates, or packaging for user-facing task behavior.

## What should be product code

## 1. Session persistence

Why code:
- affects storage model
- affects chat resumption
- affects indexing/search
- must be trusted and fast

CodeSurf targets:
- `src/main/session-store/` (new)
- `src/main/ipc/chat.ts`
- `src/main/db/thread-indexer.ts`

## 2. Checkpoint / rewind

Why code:
- deeply integrated with file operations and workspace state
- must coordinate with chat history and risky actions

CodeSurf targets:
- `src/main/checkpoints/` (new)
- `src/main/ipc/chat.ts`
- relevant file/canvas mutation IPC

## 3. AGENTS / memory loading

Why code:
- changes how provider context is assembled
- needs privacy boundaries and path rules

CodeSurf targets:
- `src/main/context/` (new)
- `src/main/ipc/chat.ts`
- `src/preload/index.ts`

## 4. MCP connection management

Why code:
- transport/runtime feature
- not documentation
- changes actual tool availability

CodeSurf targets:
- `src/main/mcp-client/` (new)
- `src/main/mcp-server.ts`
- renderer settings/sidebar integrations

## 5. Permission model

Why code:
- runtime enforcement
- security boundary
- UI state + persistence

CodeSurf targets:
- `src/main/permissions.ts`
- `src/main/ipc/chat.ts`
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`

## 6. Provider-context sanitization

Why code:
- security/privacy critical
- must run before every outbound provider request

CodeSurf targets:
- `src/main/privacy/` (new)
- `src/main/ipc/chat.ts`
- relay/provider execution paths

## 7. File reference expansion

Why code:
- parses user input
- reads real files
- affects prompt payloads and token counts

CodeSurf targets:
- `src/main/context/file-references.ts` (new)
- `src/main/ipc/chat.ts`

## 8. Skill install / discovery infrastructure

Why code:
- it is platform/runtime plumbing
- not the skill content itself

CodeSurf targets:
- `src/main/ipc/skills.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/SkillInstallModal.tsx`

## What should be packaged as skills

## 1. Reverse-engineering workflows

Good skill candidates:
- reverse-engineer bundled Node CLI
- extract tsup/esbuild single-file bundle into source-like tree
- decompile namespace IIFEs into exported modules

Why skills:
- procedural and reusable
- not part of CodeSurf runtime itself
- ideal for internal team reuse and user-facing automation packs

## 2. Code review / refactor workflows

Good skill candidates:
- incremental refactor in small bursts
- pre-commit verification sequence
- checkpoint-safe file editing flow
- multi-pass code audit workflow

Why skills:
- mostly behavior/policy rather than runtime substrate

## 3. Project onboarding packs

Good skill candidates:
- how to work in a CodeSurf workspace
- how to use MCP servers in a project
- how to keep AGENTS.md / workspace memory updated
- how to package/install/export a CodeSurf skill

Why skills:
- these are instructions and workflow content

## 4. Agent role packs

Good skill candidates:
- architect
- code reviewer
- migration helper
- bundle reverse-engineer
- UI polish reviewer
- product spec summarizer

Why skills:
- these are promptable behaviors layered on top of CodeSurf runtime

## What could be either, depending on ambition

## 1. Conversation compaction

As code:
- local save/trigger logic
- compaction lifecycle integration

As skill/content:
- prompt shape for good summaries

Recommendation for CodeSurf:
- lifecycle in code
- summarization instructions in a skill/template

## 2. Title generation

As code:
- when/how titles are triggered and stored

As skill/content:
- title prompt policy

Recommendation:
- code for storage and trigger
- template/skill for generation style

## 3. Tool descriptions

As code:
- permission prompt rendering and state

As skill/content:
- heuristics for human-readable summaries

Recommendation:
- start with deterministic local code rules
- only later consider model-generated phrasing

## Suggested CodeSurf skill categories

Given the current app shape, I would organize skills like this:

### 1. Product skills
Location:
- `~/.codesurf/skills/`
- `<workspace>/.codesurf/skills/`

Examples:
- `reverse-engineering/`
- `code-review/`
- `refactoring/`
- `planning/`
- `workspace-operations/`

### 2. Workspace-local skills
For repo/team conventions:
- project build/run/test steps
- coding conventions
- local ops recipes
- specific deployment playbooks

### 3. Internal CodeSurf starter packs
These ship with CodeSurf or live in a bundled examples area:
- Reverse engineer bundled JS app
- Review a PR with incremental checkpoints
- Summarize a work thread into a clean handoff
- Build a new MCP-backed workflow tile

## Where skill support should live in CodeSurf

### Main process
- `src/main/ipc/skills.ts`
  - inspect/install/list/remove/export
- maybe later:
  - `src/main/skills/loader.ts`
  - `src/main/skills/indexer.ts`

### Preload
- `src/preload/index.ts`
  - expose skill APIs to renderer safely

### Renderer
- `src/renderer/src/components/SkillInstallModal.tsx`
- eventually:
  - skill browser
  - skill attach-to-chat
  - workspace skill manager

### Chat/provider layer
- `src/main/ipc/chat.ts`
  - resolve applicable skill summaries
  - inject only approved summaries into provider context

## Recommended split for CodeSurf

### Must be code in the next implementation wave
- session store
- checkpoints
- memory loader
- privacy/context sanitizer
- MCP manager improvements
- permission scope model
- file reference expansion

### Good early skill/content work
- reverse-engineering skill packs
- code review packs
- project handoff templates
- refactor-in-bursts workflow

### Avoid turning into skills too early
Do not try to solve these with skills first:
- session persistence
- rewind/checkpointing
- permissions
- MCP plumbing
- privacy boundaries

Those are platform features, not prompt content.

## Final decision rule

If a feature must be true even when the model hallucinates, disconnects, or changes providers:

- it must be **code**

If a feature is primarily reusable instruction or workflow framing:

- it can be a **skill**
