# Command Code Harvest — Next Bursts Plan

> For Hermes: execute in small controlled bursts, test-first, and do not create new React component families for memory/checkpoint UI. Reuse existing ChatTile, ToolBlockView, Sidebar row/context-menu, and CustomisationTile surfaces.

Goal: finish the actually visible memory/checkpoint UX first, then move into the next high-value Command Code harvests: skill indexing, file-reference expansion, and context buckets.

Architecture: keep persistence/privacy/resume logic daemon-authoritative in `bin/*.mjs`, keep Electron main as a thin client/controller, and surface state only through existing renderer affordances. Memory and checkpoint UI should feel like normal chat/tool/status behavior, not like bolt-on mini apps.

Tech stack: Electron main/preload/renderer, React, TypeScript, ESM daemon modules, node --test, electron-vite.

---

## Already landed — do not redo

These are already in product code and/or docs. Treat them as baseline, not TODOs:

- daemon checkpoints / rewind primitives
- daemon AGENTS memory loader with `@import` and privacy buckets
- `Workspace Instructions` chat chip at turn start
- `Checkpoint saved` chat chip before risky local runtime edits
- runtime session checkpoint metadata in daemon session state
- latest-checkpoint restore via existing session context menu
- docs:
  - `docs/daemon-memory-and-checkpoints.md`
  - `docs/chat-ui-manifest.md`

Before touching any of this, inspect current files and confirm whether the target behavior already exists in the active branch/worktree.

---

## Burst 1 — Make checkpoint state obviously visible in existing thread rows

Objective: make it impossible to miss that a runtime thread has checkpoint state, using only the existing Sidebar row affordances.

Files:
- Modify: `src/shared/session-types.ts`
- Modify: `bin/codesurfd.mjs`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Test: `test/daemon/checkpoints.test.mjs`

### Step 1: Write failing daemon test for session-list checkpoint count

Add/keep a test in `test/daemon/checkpoints.test.mjs` that:
- creates a runtime session
- creates a checkpoint
- calls `/session/local/list`
- asserts the runtime entry exposes `checkpointCount: 1`

Run:
- `node --test test/daemon/checkpoints.test.mjs`

Expected:
- FAIL if `checkpointCount` is missing from runtime session list payload

### Step 2: Make runtime session list expose checkpoint count

In `bin/codesurfd.mjs`:
- ensure runtime session summary includes `checkpointCount`
- ensure `listLocalWorkspaceSessions()` forwards that onto runtime entries

In `src/shared/session-types.ts`:
- add optional `checkpointCount?: number` to `AggregatedSessionEntry`

### Step 3: Surface checkpoint count in the existing Sidebar row

In `src/renderer/src/components/Sidebar.tsx`:
- keep current row structure
- add a small count pill in `extra={...}` only when `checkpointCount > 0`
- keep existing tooltip text updated with checkpoint count
- do not add a new component file

### Step 4: Verify

Run:
- `node --test test/daemon/checkpoints.test.mjs`
- `npm run build`

Manual verification:
- open runtime session list
- confirm checkpointed runtime sessions show a visible count pill in the existing row

### Step 5: Commit

Suggested commit message:
- `feat: expose checkpoint count in thread rows`

---

## Burst 2 — Add a visible restore affordance directly in the existing thread row

Objective: users should not have to discover restore only via context menu.

Files:
- Modify: `src/main/ipc/canvas.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Test: `test/daemon/checkpoints.test.mjs`

### Step 1: Write failing test for restore flow survival

In `test/daemon/checkpoints.test.mjs`:
- assert restore still updates runtime session state
- assert restore leaves checkpoint metadata intact after subsequent runtime upsert

Run:
- `node --test test/daemon/checkpoints.test.mjs`

Expected:
- PASS baseline if backend already works
- if adding more assertions, fail first until new behavior is covered

### Step 2: Ensure restore APIs are exposed to renderer

In:
- `src/main/ipc/canvas.ts`
- `src/preload/index.ts`
- `src/renderer/src/env.d.ts`

Wire/confirm:
- `canvas:listCheckpoints(workspaceId, sessionEntryId)`
- `canvas:restoreCheckpoint(workspaceId, checkpointId, sessionEntryId?)`

### Step 3: Add restore button to existing Sidebar row actions

In `src/renderer/src/components/Sidebar.tsx`:
- inside existing row `extra={...}` block
- add a small restore icon button only when `checkpointCount > 0`
- clicking it should:
  - confirm with the user
  - list checkpoints
  - restore the latest one
  - refresh sessions
  - reopen/focus the session in chat

Do not:
- add a new modal component
- add a new checkpoint list component
- create a new row type

### Step 4: Keep context menu restore entry in sync

In `Sidebar.tsx`:
- reuse the same restore helper from both the visible row button and context menu action
- avoid duplicated restore logic

### Step 5: Verify

Run:
- `node --test test/daemon/checkpoints.test.mjs`
- `npm run build`

Manual verification:
- checkpointed runtime session row shows restore button
- clicking restore reopens/restores the chat

### Step 6: Commit

Suggested commit message:
- `feat: add restore controls to runtime thread rows`

---

## Burst 3 — Emit a visible `Checkpoint restored` chip in chat

Objective: restoring should produce visible feedback in the chat stream using the same existing chip flow as other tool/status operations.

Files:
- Modify: `bin/checkpoints.mjs`
- Modify: `src/renderer/src/components/ChatTile.tsx` only if needed for existing tool-block rendering compatibility
- Test: `test/daemon/checkpoints.test.mjs`

### Step 1: Write failing test for restored-notice message

In `test/daemon/checkpoints.test.mjs`:
- restore a checkpoint
- fetch runtime session state
- assert there is an assistant message/tool block named `Checkpoint restored`

Run:
- `node --test test/daemon/checkpoints.test.mjs`

Expected:
- FAIL until restore appends the notice message

### Step 2: Append restore notice in daemon-owned session state

In `bin/checkpoints.mjs`:
- after successful restore, append a synthetic assistant message to the runtime session snapshot
- shape it to match existing chat/tool block expectations:
  - `role: 'assistant'`
  - empty `content`
  - `toolBlocks: [{ name: 'Checkpoint restored', summary: ... }]`
  - `contentBlocks: [{ type: 'tool', toolId }]`

### Step 3: Ensure existing ChatTile renders it without new UI code

In `ChatTile.tsx`:
- prefer using the current `tool_start` / `tool_summary` / restored session replay path
- only touch renderer if the restored message shape needs a tiny compatibility fix
- do not add a new component file

### Step 4: Verify

Run:
- `node --test test/daemon/checkpoints.test.mjs`
- `npm run build`

Manual verification:
- restore a checkpoint from Sidebar row/button/context menu
- reopened chat shows a visible `Checkpoint restored` tool chip

### Step 5: Commit

Suggested commit message:
- `feat: show checkpoint restored in chat stream`

---

## Burst 4 — Harden the memory chip so it is always obvious and not noisy

Objective: make `Workspace Instructions` reliably visible but still compact.

Files:
- Modify: `src/main/ipc/chat.ts`
- Modify: `bin/chat-jobs.mjs`
- Modify: `src/renderer/src/components/ChatTile.tsx` only if needed for summary presentation
- Test: `test/daemon/memory-loader.test.mjs`

### Step 1: Add/keep summary generation rules

Memory summary should include:
- number of visible sections
- included buckets
- first 2-3 source paths
- compact `+N more` suffix

### Step 2: Ensure both runtime and daemon paths emit it

Runtime:
- `src/main/ipc/chat.ts`
- emit `Workspace Instructions` before local runtime execution

Daemon-backed:
- `bin/chat-jobs.mjs`
- emit `Workspace Instructions` as timeline events before provider execution

### Step 3: Verify it does not create duplicate/no-op spam

Rules:
- only emit when there is a non-empty prompt
- do not emit empty or redundant chips
- do not create a special renderer-only memory component

### Step 4: Verify

Run:
- `node --test test/daemon/memory-loader.test.mjs`
- `npm run build`

Manual verification:
- local runtime chat shows chip
- daemon-backed chat shows chip
- empty/no-memory workspace does not show chip

### Step 5: Commit

Suggested commit message:
- `feat: tighten workspace instruction chip behavior`

---

## Burst 5 — Daemon-owned skill resolution/indexing

Objective: bring over the next major Command Code harvest after memory/checkpoints.

Files:
- Create: `bin/skills-index.mjs`
- Modify: `bin/codesurfd.mjs`
- Modify: `src/main/daemon/client.ts`
- Modify: `src/main/ipc/chat.ts`
- Review existing: `src/main/ipc/skills.ts`
- Test: `test/daemon/skills-index.test.mjs`
- Docs: `docs/daemon-skills.md`

### Step 1: Write failing daemon tests

Cover:
- global skill root: `~/.codesurf/skills`
- workspace skill root: `<workspace>/.codesurf/skills`
- compat dirs if needed
- list/get/install routes
- summary generation for prompt inclusion

Run:
- `node --test test/daemon/skills-index.test.mjs`

Expected:
- FAIL for missing routes/module

### Step 2: Implement daemon skill index

Routes:
- `/skills/list`
- `/skills/get`
- `/skills/install`

Behavior:
- merge global + workspace scopes
- expose metadata first, content on demand
- keep renderer/browser/install flow simple

### Step 3: Wire prompt-side skill injection

In `src/main/ipc/chat.ts`:
- load selected skill summaries into provider prompt assembly
- keep outbound inclusion inspectable

### Step 4: UI manifestation

Use existing surfaces only:
- existing skill install/browser surfaces
- existing chat/tool/status surfaces for “included skills” summary if needed
- do not create a separate skill-chat UI family

### Step 5: Verify + commit

Run:
- `node --test test/daemon/skills-index.test.mjs`
- `npm run build`

Suggested commit message:
- `feat: add daemon skill indexing`

---

## Burst 6 — File-reference expansion (`@file`, `@path`)

Objective: bring over the next highly visible Command Code behavior after skills.

Files:
- Create: `bin/file-references.mjs`
- Modify: `bin/codesurfd.mjs`
- Modify: `src/main/daemon/client.ts`
- Modify: `src/main/ipc/chat.ts`
- Test: `test/daemon/file-references.test.mjs`
- Docs: `docs/file-reference-expansion.md`

### Step 1: Write failing tests

Cover:
- `@path`
- relative resolution from workspace
- path sanitization
- cloud filtering / preview behavior

### Step 2: Implement daemon expander

Route:
- `/context/expand-references`

### Step 3: UI manifestation

Use existing surfaces only:
- existing attachment/reference chips in chat composer and chat stream
- existing tool/status chips for “expanded references” summary

### Step 4: Verify + commit

Suggested commit message:
- `feat: add daemon file reference expansion`

---

## Burst 7 — Explicit context buckets and inspectable outbound context

Objective: make memory/skills/files/privacy inspectable before remote send.

Files:
- Create: `bin/context-buckets.mjs`
- Modify: `src/main/ipc/chat.ts`
- Modify: `bin/chat-jobs.mjs`
- Modify: docs under `docs/`
- Test: `test/daemon/context-buckets.test.mjs`

### Step 1: Define buckets

Start with:
- `local-only`
- `remote-safe`
- later if needed: `user-approved-remote`

### Step 2: Assemble inspectable context bundle

Include:
- messages
- memory
- skills
- referenced files
- repo metadata

### Step 3: Surface through existing UI

Use:
- existing chat tool/status chips
- existing settings/customisation flows
- existing thread/session/history affordances

### Step 4: Verify + commit

Suggested commit message:
- `feat: add inspectable context buckets`

---

## Burst 8 — Agent CLI contract matrix for Hermes, OpenClaw, and OpenCode

Objective: stop provider integrations from regressing whenever an external CLI changes flags, output shape, or session semantics. CodeSurf should have one tested adapter contract per agent, not ad hoc spawn arrays scattered through chat/relay paths.

Files:
- Create: `src/main/agents/agent-cli-contracts.ts` or equivalent pure helper module
- Modify: `src/main/agent-paths.ts`
- Modify: `src/main/relay/provider-executor.ts`
- Modify: `src/main/ipc/chat.ts` only where the interactive provider path needs the same contract
- Modify: `src/renderer/src/components/AgentSetup.tsx` if readiness/status needs surfacing
- Test: `test/agent-cli-contracts.test.ts`

### Step 1: Write failing adapter-contract tests

Use fake binaries in a temp directory that record argv and emit deterministic stdout. Cover at least:

Hermes:
- uses `hermes chat --query <prompt> --quiet --source tool`
- maps model with `--model <model>`
- maps mode to explicit `--toolsets ...`
- does not pass dangerous/yolo flags unless the user explicitly selected bypass behavior
- can parse and retain `session_id: ...` while stripping that line from the visible assistant output

OpenClaw:
- uses the real CLI shape: `openclaw agent --json --agent <id> --message <prompt>`
- supports `--session-id <id>` when resuming a known session
- supports `--thinking <level>` and `--timeout <seconds>` when present
- never reintroduces imaginary flags such as `--output-format stream-json`, `--yes`, `--approval-mode`, `--model`, or `-p`
- parses text from `payloads[]`, `result.payloads[]`, `summary`, or raw stdout fallback

OpenCode:
- uses current `opencode run` flags: `--format json`, `--model`, `--agent`, `--session`, `--dir`, `--attach` where appropriate
- does **not** pass stale `--approval-mode` flags
- uses `--dangerously-skip-permissions` only for explicit bypass/accept-all modes
- parses JSON event streams instead of extracting the first `{...}` blob with a regex

Run:
- `node --test test/agent-cli-contracts.test.ts`

Expected:
- FAIL until the spawn-argument builders are extracted and the stale OpenCode/OpenClaw/Hermes assumptions are corrected.

### Step 2: Extract pure adapter builders

Create small pure functions for each provider:
- `buildHermesChatArgs(request)`
- `parseHermesOutput(stdout)`
- `buildOpenClawAgentArgs(request)`
- `parseOpenClawOutput(stdout)`
- `buildOpenCodeRunArgs(request)`
- `parseOpenCodeRunOutput(stdout)`

Keep process spawning in `provider-executor.ts`; keep argv/output semantics in the tested helper.

### Step 3: Reuse contracts in relay and chat paths

In `src/main/relay/provider-executor.ts`:
- replace inline argv construction with the tested helpers
- keep timeout handling and sanitized error messages
- persist per-participant session ids where the CLI exposes them

In `src/main/ipc/chat.ts`:
- use the same OpenCode/Hermes/OpenClaw contract helpers wherever an interactive provider path exists
- avoid duplicating flag maps between main chat and relay execution

### Step 4: Surface readiness without blocking chat UI

In `src/main/agent-paths.ts` and `AgentSetup.tsx`:
- show detected path, version, and last-smoke-test status for Hermes/OpenClaw/OpenCode
- never run model/provider refresh on hot chat render paths
- never log secrets, config contents, auth tokens, or provider keys

### Step 5: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- `npm test`
- `npm run build`

Suggested commit message:
- `test: lock agent cli integration contracts`

---

## Burst 9 — Hermes integration hardening

Objective: make Hermes a first-class CodeSurf agent lane while keeping CodeSurf, not Hermes defaults, in charge of privacy boundaries for context sent from CodeSurf.

Files:
- Modify: `src/main/relay/provider-executor.ts`
- Modify: `src/main/ipc/chat.ts` if Hermes is selectable in chat provider UI
- Modify: `src/main/agent-paths.ts`
- Modify: `src/main/session-sources.ts` if Hermes sessions should appear in CodeSurf history
- Test: `test/agent-cli-contracts.test.ts`
- Test: add/extend a session-source test if Hermes history import is implemented

### Step 1: Treat CodeSurf-managed context as the default

When CodeSurf assembles the prompt/context bundle itself:
- pass `--ignore-rules` by default so Hermes does not independently inject AGENTS/SOUL/memory outside CodeSurf's inspected context bucket policy
- do **not** pass `--ignore-user-config` by default because provider credentials/model config live there
- use `--source tool` or `--source codesurf-relay` so delegated CodeSurf turns do not pollute the user's normal Hermes session list unless explicitly requested

### Step 2: Persist Hermes resume metadata

- capture `session_id: ...` from Hermes quiet output
- store it per CodeSurf participant/card/runtime lane
- pass `--resume <sessionId>` on the next turn for that lane
- make the visible assistant response exclude the session id line

### Step 3: Make toolset/mode mapping inspectable

- map CodeSurf modes to explicit Hermes toolsets in one place
- default plan/query modes to no filesystem/terminal tools
- require explicit bypass selection before passing `--yolo`
- expose the effective toolset summary in the runtime/tool chip, not in hidden logs

### Step 4: Smoke-test readiness

Add a non-secret smoke test path:
- `hermes --version`
- optionally `hermes chat --query "Respond with exactly: CODESURF_HERMES_SMOKE_OK" --quiet --source tool --ignore-rules --toolsets ""`

The smoke result should be cached and shown in Agent Setup, not run every chat mount.

### Step 5: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- `npm run build`

Suggested commit message:
- `feat: harden hermes agent integration`

---

## Burst 10 — OpenClaw integration hardening

Objective: keep OpenClaw integration aligned with the real installed CLI and make session/agent routing explicit.

Files:
- Modify: `src/main/relay/provider-executor.ts`
- Modify: `src/main/agent-paths.ts`
- Modify: `src/main/session-sources.ts`
- Test: `test/agent-cli-contracts.test.ts`
- Test: add/extend a session-source test if OpenClaw import behavior changes

### Step 1: Lock the real CLI contract

The real command shape is:
- `openclaw agent --json --agent <id> --message <text>`
- `openclaw agent --json --session-id <id> --message <text>` for explicit resume
- `openclaw agents list --json` for configured agents

Do not add flags that the CLI does not expose. In particular, preserve tests that fail if `--output-format`, `--yes`, `--approval-mode`, `--model`, or `-p` appear in OpenClaw argv.

### Step 2: Improve agent/model selection

- `spawnRequest.model` should match an agent id or configured agent model exactly
- if no exact match exists, return a clear error with available agent ids/models
- prefer stable agents over transient gateway/lead ids
- expose the selected `agentId` in runtime lane metadata

### Step 3: Resume and parse sessions

- capture returned OpenClaw session id when present
- prefer `--session-id` on follow-up turns when the lane has a known session
- keep `src/main/session-sources.ts` import behavior aligned with `~/.openclaw/agents`
- preserve nested group metadata for OpenClaw subagents/cron-style sessions

### Step 4: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- targeted session-source test, if added
- `npm run build`

Suggested commit message:
- `feat: harden openclaw agent routing`

---

## Burst 11 — OpenCode integration hardening

Objective: split OpenCode into two stable paths: a warm long-lived SDK/server path for interactive chat/model discovery, and a tested CLI one-shot path for relay/agent lanes.

Files:
- Modify: `src/main/ipc/chat.ts`
- Modify: `src/main/relay/provider-executor.ts`
- Modify: `src/main/agent-paths.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx` only if model/status events need small UI wiring
- Test: `test/agent-cli-contracts.test.ts`
- Test: add a focused OpenCode server manager test if practical

### Step 1: Remove stale CLI assumptions

Current `opencode run --help` exposes:
- `--format json`
- `--model`
- `--agent`
- `--session`
- `--continue`
- `--dir`
- `--attach`
- `--variant`
- `--thinking`
- `--dangerously-skip-permissions`

It does not expose `--approval-mode`. Update tests and implementation so stale approval-mode mappings cannot come back.

### Step 2: Parse OpenCode JSON events robustly

- parse JSONL/event output line-by-line when `--format json` is used
- collect assistant text/result events intentionally
- capture session id when available
- preserve stderr as diagnostics without exposing secrets
- avoid regex extraction of the first `{...}` blob

### Step 3: Keep model discovery non-blocking

In `src/main/ipc/chat.ts`:
- keep `OpenCodeServerManager` warmup off the critical chat render path
- cache fallback models immediately
- broadcast `chat:opencodeModelsUpdated` only after a successful background refresh
- show stale/error source in Agent Setup instead of beachballing ChatTile

### Step 4: Unify server/client lifecycle

- keep one `opencode serve` manager per app process
- detect dead server process and clear cached client URL before retry
- expose health/readiness metadata to Agent Setup
- use `--attach` for CLI one-shots if a running server should be reused; otherwise keep pure `opencode run` isolated

### Step 5: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- targeted OpenCode chat/model tests if added
- `npm test`
- `npm run build`

Suggested commit message:
- `feat: harden opencode integration`

---

## Burst 12 — Generalized agent adapter registry for more providers

Objective: make adding agents like Cursor, Kilo Code, Cline, Amp, Gemini CLI, and future CLIs a data-driven adapter addition instead of another hardcoded union in `agent-paths.ts` and `provider-executor.ts`.

Discovery snapshot from this machine on 2026-04-24:
- `cursor-agent` found: `2026.04.16-2d20146`
- `cursor` found: `3.0.16`
- `cline` found: `2.11.0`
- `amp` found: `0.0.1774936733-g4206cc`
- `gemini` found: `0.34.0`
- `kilo` / `kilocode` not found locally, but Kilo docs describe `npm install -g @kilocode/cli` and `kilo run [message..]`

Files:
- Create: `src/main/agents/agent-adapter-registry.ts`
- Create: `src/main/agents/agent-adapter-types.ts`
- Create: `src/main/agents/adapters/*.ts`
- Modify: `src/main/agent-paths.ts`
- Modify: `src/main/relay/provider-executor.ts`
- Modify: `src/main/ipc/chat.ts`
- Modify: `src/preload/index.ts` only if provider ids/types are currently hardcoded
- Modify: `src/renderer/src/env.d.ts` only if provider ids/types are currently hardcoded
- Modify: `src/renderer/src/components/AgentSetup.tsx`
- Test: `test/agent-adapter-registry.test.ts`
- Test: `test/agent-cli-contracts.test.ts`

### Step 1: Write failing registry tests

Cover:
- registry contains built-ins: `claude`, `codex`, `opencode`, `openclaw`, `hermes`
- registry can add new adapters: `cursor-agent`, `cline`, `amp`, `gemini`, `kilo`
- each adapter declares capabilities:
  - `headlessRun`
  - `streamJson`
  - `resume`
  - `modelSelect`
  - `cwdSelect`
  - `approvalMode`
  - `mcp`
  - `acp`
  - `sessionImport`
- missing binaries appear as unavailable without throwing
- no provider id requires a TypeScript union edit outside the registry

Run:
- `node --test test/agent-adapter-registry.test.ts`

Expected:
- FAIL until adapters are registry-backed instead of hardcoded.

### Step 2: Move detection to adapter metadata

Each adapter should define:
- binary candidates, e.g. `['cursor-agent']`, `['gemini']`, `['kilo']`
- version args, e.g. `['--version']`
- safe help args, e.g. `['--help']`
- executable path fallback candidates
- non-secret smoke test, if safe

Do not store secrets or auth state in the registry. Store only binary path, version, last check timestamp, and capability/readiness summary.

### Step 3: Make Agent Setup registry-driven

In `AgentSetup.tsx`:
- render adapters from registry output
- group by status: Ready / Installed-needs-auth / Missing / Import-only
- show exact binary path and version
- show capability chips rather than bespoke provider copy
- keep expensive probes behind explicit refresh, not live render

### Step 4: Verify + commit

Run:
- `node --test test/agent-adapter-registry.test.ts test/agent-cli-contracts.test.ts`
- `npm run build`

Suggested commit message:
- `feat: add registry-backed agent adapters`

---

## Burst 13 — Cursor Agent and Gemini CLI adapters

Objective: add the first two new headless adapters with strong CLI contracts and stream parsing: Cursor Agent and Gemini CLI.

Files:
- Create/modify: `src/main/agents/adapters/cursor-agent.ts`
- Create/modify: `src/main/agents/adapters/gemini.ts`
- Modify: `src/main/agents/agent-cli-contracts.ts`
- Modify: `src/main/relay/provider-executor.ts`
- Test: `test/agent-cli-contracts.test.ts`

### Step 1: Cursor Agent contract tests

Use the real local help as the baseline:
- `cursor-agent --print --output-format stream-json <prompt>` for headless runs
- `--stream-partial-output` only when CodeSurf wants token deltas
- `--workspace <path>` for cwd/workspace selection
- `--model <model>` for model selection
- `--resume <chatId>` or `--continue` for session continuation
- `--mode plan` or `--mode ask` for read-only modes
- `--yolo` / `--force` only when the user explicitly chooses bypass behavior
- `--trust` only for headless mode after the workspace trust model is explicit in CodeSurf

Tests should fail if Cursor Agent is invoked through the GUI-only `cursor` command for headless execution.

### Step 2: Gemini CLI contract tests

Use the real local help as the baseline:
- `gemini --prompt <prompt>` for non-interactive/headless mode
- `--output-format stream-json` or `--output-format json` for parseable output
- `--model <model>` for model selection
- `--resume <id|latest>` for session continuation
- `--approval-mode plan|default|auto_edit|yolo` mapped from CodeSurf modes
- `--sandbox` when CodeSurf wants sandboxed execution
- `--include-directories <path>` only when context policy allows extra dirs
- `--yolo` only for explicit bypass behavior

Tests should ensure CodeSurf never uses raw-output flags by default.

### Step 3: Stream parsing and session capture

For both adapters:
- parse JSON/stream-json line-by-line
- collect assistant text deltas/results intentionally
- capture session/chat id when the CLI emits it
- emit normal CodeSurf tool/status chips for adapter metadata and exact prompt/context bundle
- redact any credential-looking stderr before surfacing diagnostics

### Step 4: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- `npm test`
- `npm run build`

Suggested commit message:
- `feat: add cursor and gemini agent adapters`

---

## Burst 14 — Cline and Amp adapters

Objective: add two more mature local coding-agent adapters while respecting their different execution models.

Files:
- Create/modify: `src/main/agents/adapters/cline.ts`
- Create/modify: `src/main/agents/adapters/amp.ts`
- Modify: `src/main/agents/agent-cli-contracts.ts`
- Modify: `src/main/relay/provider-executor.ts`
- Test: `test/agent-cli-contracts.test.ts`

### Step 1: Cline contract tests

Use the real local help as the baseline:
- `cline task <prompt>` or `cline <prompt>` for a new task
- `--json` for parseable messages
- `--cwd <path>` for workspace selection
- `--model <model>` for model selection
- `--plan` for read-only/planning mode
- `--act` for editing mode
- `--taskId <id>` or `--continue` for resume
- `--timeout <seconds>` for bounded execution
- `--yolo` / `--auto-approve-all` only for explicit bypass behavior
- `--acp` should be exposed as an alternate IDE/ACP lane, not mixed into headless run mode by accident

### Step 2: Amp contract tests

Use the real local help as the baseline:
- `amp -x <prompt>` / `amp --execute <prompt>` for one-shot execution
- `--stream-json` for Claude-Code-compatible stream JSON
- `--mode <deep|free|large|rush|smart>` mapped from CodeSurf mode/model intent
- `amp threads new` for empty thread creation when needed
- `amp threads continue <threadId>` or `--last` for continuation workflows
- `--no-ide` by default unless CodeSurf explicitly wants IDE context imported
- `--dangerously-allow-all` only for explicit bypass behavior
- `--mcp-config` only from inspected CodeSurf MCP config, never by copying hidden user config into logs

### Step 3: Normalize resume semantics

Cline and Amp identify sessions differently:
- Cline: task ids / recent task per cwd
- Amp: thread ids / thread URLs / last thread per mode

Store these in a normalized runtime-lane field:
- `externalSessionId`
- `externalSessionKind`
- `externalSessionUrl?`
- `resumeArgs[]`

### Step 4: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- `npm test`
- `npm run build`

Suggested commit message:
- `feat: add cline and amp agent adapters`

---

## Burst 15 — Kilo Code adapter and extension-backed/import-only agents

Objective: add Kilo Code support and define the fallback path for agents that are primarily IDE extensions or expose sessions but not a stable headless CLI.

Files:
- Create/modify: `src/main/agents/adapters/kilo.ts`
- Modify: `src/main/agents/agent-adapter-registry.ts`
- Modify: `src/main/session-sources.ts`
- Modify: `src/main/ipc/canvas.ts` if imported sessions need preview/load plumbing
- Modify: `src/renderer/src/components/Sidebar.tsx` only through existing session row affordances
- Test: `test/agent-cli-contracts.test.ts`
- Test: add/extend session-source tests

### Step 1: Kilo CLI discovery contract

Kilo is not currently installed on this machine, so the first implementation must be discovery-first and fake-binary-tested.

Docs baseline:
- install: `npm install -g @kilocode/cli`
- binary: `kilo`
- version: `kilo --version`
- headless: `kilo run [message..]`
- server: `kilo serve`
- sessions: `kilo session`
- export/import: `kilo export [sessionID]`, `kilo import <file>`
- ACP/MCP: `kilo acp`, `kilo mcp`

Tests should prove missing Kilo is reported as Missing, not treated as a broken CodeSurf install.

### Step 2: Add Kilo adapter when binary is present

When `kilo` is installed:
- prefer `kilo run <prompt>` for one-shot execution if it supports the needed output flags
- use `kilo export` / `kilo session` for session import if run output is not stable enough yet
- expose `kilo acp` as a possible ACP lane, not as default chat execution
- expose `kilo serve` as a possible long-lived server lane only after lifecycle tests exist

### Step 3: Import-only and extension-backed agent category

Some agents may be useful before they are spawnable:
- Cursor IDE chat/session history
- Cline task history
- Kilo session exports
- VS Code extension-backed agents without a safe headless CLI

Represent these as `sessionImport` or `readOnlyHistory` adapters, not fake chat providers. They should appear in session/history surfaces and context-deck-style review, but not in the model picker until there is a tested run contract.

### Step 4: Verify + commit

Run:
- `node --test test/agent-cli-contracts.test.ts`
- targeted session-source tests
- `npm test`
- `npm run build`

Suggested commit message:
- `feat: add kilo and import-only agent adapters`

---

## Burst 16 — Multi-agent picker and lane UX polish

Objective: make many agents feel coherent in CodeSurf instead of turning the model picker into a noisy list of random CLIs.

Files:
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Modify: `src/renderer/src/components/AgentSetup.tsx`
- Modify: `src/shared/types.ts`
- Modify: `src/main/agents/agent-adapter-types.ts`
- Test: add focused unit tests for provider grouping helpers if present

### Step 1: Group by execution shape

Provider UI should group adapters by capability, not brand only:
- Native SDK / daemon-backed
- Headless CLI
- ACP-capable
- MCP/server-capable
- Import-only history
- Missing / setup needed

### Step 2: Keep advanced controls collapsed

For each adapter show a compact default row:
- name
- detected version/path
- readiness status
- current model/mode

Hide advanced controls behind disclosure:
- exact argv preview
- output parser mode
- resume id/thread id
- sandbox/approval details
- context policy envelope

### Step 3: Existing-surface manifestation only

When an agent starts/runs/resumes:
- use normal tool/status chips for adapter selected, effective context, and session id capture
- use normal runtime/session rows for imported histories
- do not create a separate mega "Agents" mini-app inside chat

### Step 4: Verify + commit

Run:
- `npm test`
- `npm run build`

Suggested commit message:
- `feat: polish multi-agent lane picker`

---

## Manual acceptance checklist

A burst is not done until these are true:

- [ ] I can start a workspace-backed chat and see `Workspace Instructions`
- [ ] I can trigger a risky local file edit and see `Checkpoint saved`
- [ ] I can see checkpoint count in the runtime session row itself
- [ ] I can restore from the runtime session row or context menu
- [ ] Reopened chat shows `Checkpoint restored`
- [ ] Nothing required a new React component family
- [ ] Daemon tests pass
- [ ] `npm run build` passes
- [ ] docs reflect the real implemented behavior, not the aspirational one
- [ ] Hermes relay turns use the tested `hermes chat --query ...` contract and do not bypass CodeSurf context policy
- [ ] OpenClaw relay turns use only real `openclaw agent` flags and make selected agent/session routing visible
- [ ] OpenCode relay/chat paths use current `opencode run`/SDK-server contracts without stale approval-mode flags
- [ ] Cursor Agent uses `cursor-agent --print` for headless execution, not the GUI-only `cursor` command
- [ ] Gemini CLI uses headless `--prompt` plus parseable output and does not enable raw output by default
- [ ] Cline and Amp adapters normalize external task/thread ids into runtime-lane resume metadata
- [ ] Kilo can be missing without breaking CodeSurf, and becomes available when a tested `kilo` binary is installed
- [ ] Missing/import-only agents appear as setup/history surfaces, not fake runnable providers

---

## Recommended execution order

1. Burst 1 — checkpoint count in row
2. Burst 2 — restore button in row
3. Burst 3 — `Checkpoint restored` chip
4. Burst 4 — memory chip robustness
5. Burst 5 — daemon skill indexing
6. Burst 6 — file-reference expansion
7. Burst 7 — context buckets
8. Burst 8 — agent CLI contract matrix for Hermes/OpenClaw/OpenCode
9. Burst 9 — Hermes integration hardening
10. Burst 10 — OpenClaw integration hardening
11. Burst 11 — OpenCode integration hardening
12. Burst 12 — generalized agent adapter registry
13. Burst 13 — Cursor Agent and Gemini CLI adapters
14. Burst 14 — Cline and Amp adapters
15. Burst 15 — Kilo Code and import-only adapters
16. Burst 16 — multi-agent picker and lane UX polish

This order maximizes actual visible product value first, continues the deeper Command Code harvests, locks the first external-agent integrations behind tested contracts, then expands the adapter registry to Cursor/Kilo/Cline/Amp/Gemini without hardcoding every future agent into core files.
