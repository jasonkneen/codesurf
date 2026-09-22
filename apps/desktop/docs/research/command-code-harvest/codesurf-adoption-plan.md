# CodeSurf adoption plan from Command Code research

This plan assumes:

- product name: **CodeSurf**
- repo folder: `/Users/jkneen/clawd/collaborator-clone`

It is intentionally practical: where, when, and how to land the best ideas.

## Phase 1 — Stabilize the foundations we already have

## Goal

Make CodeSurf’s current chat / skills / permissions / persistence surface coherent before adding new concepts.

## Why first

The repo already has active work in:

- `src/main/ipc/chat.ts`
- `src/main/ipc/skills.ts`
- `src/main/permissions.ts`
- `src/renderer/src/components/SkillInstallModal.tsx`
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
- `src/main/db/thread-indexer.ts`

So the fastest wins come from consolidating those.

## Tasks

### 1.1 Normalize skill plumbing

Files:
- `src/main/ipc/skills.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/SkillInstallModal.tsx`

Do:
- make install/list/remove/inspect APIs consistent
- define CodeSurf-native skill roots:
  - global: `~/.codesurf/skills`
  - workspace: `<workspace>/.codesurf/skills`
- keep import/export/install package story simple

### 1.2 Normalize permission plumbing

Files:
- `src/main/permissions.ts`
- `src/main/ipc/chat.ts`
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`

Do:
- finalize permission scopes
- make the renderer card and main-process enforcement use the same decision model
- persist grants in a clearly inspectable format

### 1.3 Define privacy policy in code before docs

Files:
- new: `src/main/privacy/provider-context-policy.ts`
- `src/main/ipc/chat.ts`

Do:
- define what kinds of context may be sent remotely
- default to minimal context
- make each context source explicit and toggleable

## Phase 2 — Add real session persistence

## Goal

Move from mostly live in-memory chat state toward durable, resumable thread history.

## Why second

This unlocks the rest:
- checkpoints
- rewind
- compaction
- thread summaries
- better search/indexing

## Tasks

### 2.1 Add session store module

New folder:
- `src/main/session-store/`

Suggested files:
- `session-types.ts`
- `jsonl-store.ts`
- `session-manager.ts`
- `migrations.ts`

Store under:
- `~/.codesurf/projects/<slug>/threads/<threadId>.jsonl`

### 2.2 Integrate with chat IPC

Files:
- `src/main/ipc/chat.ts`
- `src/main/db/thread-indexer.ts`

Do:
- assign stable thread IDs
- append turns as JSONL
- expose resume/list/load operations
- index thread metadata for faster workspace/thread browsing

### 2.3 Surface in renderer

Renderer areas:
- chat tile / sidebar / thread browser

Do:
- allow per-card thread continuation
- make historical thread loading explicit

## Phase 3 — Add checkpoints / rewind

## Goal

Create a trust-building editing model before more autonomous behaviors are added.

## Tasks

### 3.1 Implement checkpoint manager

New folder:
- `src/main/checkpoints/`

Suggested files:
- `checkpoint-manager.ts`
- `file-history.ts`
- `session-snapshots.ts`

### 3.2 Attach to risky actions

Files:
- `src/main/ipc/chat.ts`
- canvas/file mutation IPC handlers

Do:
- snapshot before edits/writes
- record which files/workspace entities were touched
- associate snapshots with a thread and turn

### 3.3 Renderer affordance

Do:
- visible rewind/revert control per thread / operation
- clear history labels so user knows what gets rolled back

## Phase 4 — Add layered memory loading

## Goal

Give CodeSurf a strong workspace instruction model without hardcoding behavior per project.

## Tasks

### 4.1 Add context loader

New folder:
- `src/main/context/`

Suggested files:
- `memory-loader.ts`
- `import-resolver.ts`
- `context-buckets.ts`

### 4.2 Supported memory locations

Recommended CodeSurf equivalents:
- enterprise/admin-level instructions (optional later)
- user-level: `~/.codesurf/AGENTS.md`
- project-level: `<workspace>/AGENTS.md`
- project alt: `<workspace>/.codesurf/AGENTS.md`
- nested inherited workspace instructions

### 4.3 Privacy-first outbound policy

Before including memory in provider calls:
- classify as local-only / remote-allowed
- show what is included
- let the user override per workspace/provider

## Phase 5 — Add file references and richer local context assembly

## Goal

Make context selection powerful, but explicitly user-controlled.

## Tasks

### 5.1 File reference expander

New file:
- `src/main/context/file-references.ts`

Do:
- support `@path`
- resolve relative to workspace
- preview inclusion before remote send when necessary

### 5.2 Context bundle builder

New files:
- `src/main/context/build-provider-payload.ts`
- `src/main/privacy/message-sanitizer.ts`
- `src/main/privacy/path-sanitizer.ts`

Do:
- assemble:
  - messages
  - optional memory
  - optional skills
  - optional referenced files
  - optional repo metadata
- keep a dry-run / inspectable representation for UI

## Phase 6 — Improve MCP and tool surfacing

## Goal

Bring tools into the UI in a more inspectable and composable way.

## Tasks

### 6.1 Add MCP client manager

New folder:
- `src/main/mcp-client/`

Suggested files:
- `connection-manager.ts`
- `stdio-transport.ts`
- `http-transport.ts`
- `config.ts`

### 6.2 Integrate with existing server model

Files:
- `src/main/mcp-server.ts`
- `src/main/ipc/chat.ts`

Do:
- separate host/server role from client/consumer role
- surface discovered tools to chats and extensions

### 6.3 Renderer surfacing

Do:
- sidebar/settings panel for connected MCP servers
- show discovered tool inventory
- show tool scope and permission requirements

## Phase 7 — Skill system as a real product layer

## Goal

Turn CodeSurf skills into both:
- user-installable workflow packs
- internal system prompt/context building blocks

## Tasks

### 7.1 Skill storage model

Use:
- `~/.codesurf/skills`
- `<workspace>/.codesurf/skills`

### 7.2 Skill indexing

New folder:
- `src/main/skills/`

Suggested files:
- `loader.ts`
- `indexer.ts`
- `summaries.ts`

### 7.3 Chat integration

Files:
- `src/main/ipc/chat.ts`

Do:
- resolve active skills for thread/workspace/tile
- inject summaries, not massive raw content
- let user inspect included skills before send

## Phase 8 — Harden Hermes, OpenClaw, and OpenCode as first-class agent lanes

## Goal

Make external agent integrations durable, inspectable, and privacy-aligned instead of relying on brittle one-off CLI spawn calls.

## Why now

CodeSurf already detects these binaries and has relay/chat execution paths for them. The next improvement is to lock each integration behind tested adapter contracts so future CLI drift does not silently break runtime lanes.

## Tasks

### 8.1 Shared agent CLI contracts

Files:
- new: `src/main/agents/agent-cli-contracts.ts`
- `src/main/relay/provider-executor.ts`
- `src/main/ipc/chat.ts`
- `src/main/agent-paths.ts`
- test: `test/agent-cli-contracts.test.ts`

Do:
- extract pure argv builders and stdout parsers for Hermes, OpenClaw, and OpenCode
- test those builders with fake binaries before touching runtime behavior
- keep timeouts and spawn lifecycle in the executor layer, not the contract helpers
- surface selected agent/session/model metadata as runtime-lane metadata

### 8.2 Hermes integration improvements

Do:
- use `hermes chat --query <prompt> --quiet --source tool` as the tested baseline
- preserve CodeSurf's own privacy/context-bucket policy by passing `--ignore-rules` when CodeSurf already assembled the context
- avoid `--ignore-user-config` by default so provider credentials remain available
- capture `session_id: ...`, store it per runtime lane, and resume with `--resume <id>`
- only pass `--yolo` for explicit user-selected bypass behavior

### 8.3 OpenClaw integration improvements

Do:
- use the real CLI contract: `openclaw agent --json --agent <id> --message <prompt>` or `--session-id <id>` for resume
- discover configured agents through `openclaw agents list --json`
- match requested models against agent id/model exactly, with clear available-agent errors
- preserve session-source import for `~/.openclaw/agents` and nested subagent/cron metadata
- never reintroduce non-existent flags (`--output-format`, `--approval-mode`, `--model`, `-p`, etc.)

### 8.4 OpenCode integration improvements

Do:
- split OpenCode into two stable paths:
  - SDK/server manager for interactive chat and model discovery
  - `opencode run --format json ...` for relay/one-shot lanes
- remove stale `--approval-mode` usage; current `opencode run` uses `--dangerously-skip-permissions` for explicit bypass
- parse JSON events line-by-line instead of regexing the first object
- keep model discovery/warmup asynchronous and cached so ChatTile never beachballs
- expose OpenCode server health/readiness in Agent Setup

## Phase 9 — Expand to Cursor, Kilo Code, Cline, Amp, Gemini CLI, and future agents

## Goal

Make CodeSurf a multi-agent lane host where new coding agents can be added by registering a tested adapter, not by threading another provider through every UI and executor switch statement.

## Tasks

### 9.1 Generalized adapter registry

Files:
- new: `src/main/agents/agent-adapter-registry.ts`
- new: `src/main/agents/agent-adapter-types.ts`
- new: `src/main/agents/adapters/*.ts`
- `src/main/agent-paths.ts`
- `src/main/relay/provider-executor.ts`
- `src/renderer/src/components/AgentSetup.tsx`
- tests: `test/agent-adapter-registry.test.ts`, `test/agent-cli-contracts.test.ts`

Do:
- define capabilities (`headlessRun`, `streamJson`, `resume`, `modelSelect`, `cwdSelect`, `approvalMode`, `mcp`, `acp`, `sessionImport`)
- move binary candidates/version/help probes into adapter metadata
- render Agent Setup from registry output
- store readiness metadata only; never store or log secrets/auth tokens/API keys

### 9.2 Cursor Agent and Gemini CLI

Do:
- Cursor Agent: prefer `cursor-agent --print --output-format stream-json`, with `--workspace`, `--model`, `--resume`, `--mode plan|ask`, and bypass flags only on explicit user choice
- Gemini CLI: prefer headless `gemini --prompt`, parseable `--output-format json|stream-json`, `--model`, `--resume`, `--approval-mode`, and sandbox/policy flags only through CodeSurf's inspected policy
- parse stream events line-by-line and surface exact included context through normal tool chips

### 9.3 Cline and Amp

Do:
- Cline: support `cline task <prompt>` / `cline <prompt>`, `--json`, `--cwd`, `--model`, `--plan`, `--act`, `--taskId`, `--continue`
- Amp: support `amp -x` / `amp --execute`, `--stream-json`, `--mode`, `amp threads new`, `amp threads continue`
- normalize task/thread/session ids into runtime-lane resume metadata
- keep IDE context import (`--ide`) disabled unless the user explicitly asks for it

### 9.4 Kilo Code and import-only adapters

Do:
- Kilo: discovery-first because it may not be installed; docs baseline is `npm install -g @kilocode/cli`, `kilo run [message..]`, `kilo serve`, `kilo session`, `kilo export`, `kilo acp`, and `kilo mcp`
- missing Kilo should show as Missing/setup-needed, not an app error
- agents without stable headless execution should enter CodeSurf as `sessionImport` / `readOnlyHistory` adapters before becoming runnable chat providers

### 9.5 Multi-agent UI discipline

Do:
- group agents by capability shape: native SDK, headless CLI, ACP, MCP/server, import-only, missing/setup
- keep default UI compact and Apple-minimal
- hide exact argv, sandbox, approval, resume, and context-policy details under advanced disclosure
- use existing chat tool/status chips and session rows; do not create a separate mega Agents mini-app in chat

## What should become CodeSurf skills first

Good first-party skills:

1. Reverse-engineer bundled Node CLI
2. Build a handoff summary from a CodeSurf thread
3. Safe incremental refactor workflow
4. MCP onboarding for a repo
5. Workspace memory hygiene / AGENTS maintenance

## What should wait until later

### 1. Local compaction/summarization layer

Only do this after:
- session store exists
- checkpoints exist
- context buckets exist

### 2. Remote summary/title helpers

Only do this after:
- privacy policy is explicit in code + UI
- outbound payload inspector exists

### 3. Hosted learning / taste features

Only do this if we are willing to explain it clearly.
If we ever do preference learning in CodeSurf, it should be either:

- truly local, or
- explicitly documented as server-assisted

## Recommended sequence for real implementation

If doing this in small controlled bursts, I would go in this exact order:

1. finalize `skills.ts` + skill roots
2. finalize permission scopes and UI
3. add provider-context-policy
4. add JSONL session store
5. wire session store into `chat.ts`
6. add checkpoint manager
7. add AGENTS memory loader
8. add file reference expansion
9. add MCP client manager
10. add skill indexing and chat-side skill inclusion
11. add shared Hermes/OpenClaw/OpenCode adapter-contract tests
12. harden Hermes session/context/toolset integration
13. harden OpenClaw agent/session routing
14. harden OpenCode SDK/CLI lifecycle and JSON-event parsing
15. add a registry-backed adapter model for more agents
16. add Cursor Agent and Gemini CLI adapters
17. add Cline and Amp adapters
18. add Kilo Code and import-only/history adapters
19. polish the multi-agent picker/lane UX

## The main principle

Take from Command Code:
- its local shell architecture
- its tool/runtime organization
- its session/checkpoint ideas

Do not take from Command Code:
- ambiguous remote context transfer defaults
- generic privacy disclosure posture

For CodeSurf, the winning version is:

- stronger local architecture than Command Code
- stricter remote-sharing boundaries than Command Code
- better inspectability than Command Code
