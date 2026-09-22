# Codebase Review - 2026-05-23

Scope: reviewed the current `/Users/jkneen/Documents/GitHub/grok-cli` checkout with focus on the agent loop, state ownership, extension kernel, CRUD boundaries, and DRY/KISS violations. The worktree was already dirty, so this report does not assume the current source files are all committed.

## Executive summary

The architecture is moving in the right direction: tools, commands, screens, models, status indicators, and host actions now have a real extension kernel instead of being hardcoded entirely in `app.tsx` and `Agent`. The main remaining risk is not lack of capability. It is that the same concepts now exist in too many places: three turn loops in `Agent`, dozens of host/UI state slices in one React component, and persistence helpers with read-modify-write JSON semantics.

Highest-priority fixes:

1. Fix hook `additionalContexts` being dropped on the normal agent path.
2. Normalize provider-owned `sendTurn` transcripts so tool calls/results and stop hooks behave like direct `streamText`.
3. Make extension activation lifecycle either fully synchronous or truly awaited.
4. Scope session lookup/update CRUD by workspace, not only delete/list.
5. Split `src/ui/app.tsx` and `src/agent/agent.ts` by responsibility before adding more features.

## Critical findings

### 1. Hook `additionalContexts` are built but not sent to normal `streamText`

Evidence:

- `src/agent/agent.ts:2387-2402` collects `SessionStart` and `UserPromptSubmit` `additionalContexts`.
- `src/agent/agent.ts:2409-2412` builds `effectiveUserMessage` with a `<system-reminder>` prefix.
- `src/agent/agent.ts:2413-2415` then calls `buildVisionUserMessages(userMessage, ...)`, not `effectiveUserMessage`.
- `buildVisionUserMessages()` always returns at least one user message, so the fallback using `effectiveUserMessage` is effectively dead.
- `src/agent/agent.ts:2507-2511` sends `this.messages` into `streamText`, so the model receives the original prompt without hook context.

Impact:

Normal xAI/Anthropic `streamText` turns silently ignore hook-provided context. This breaks the documented memory/heartbeat hook contract and makes hook behavior inconsistent with the provider-owned `sendTurn` branch, which passes `effectiveUserMessage` separately as `prompt`.

Recommendation:

Change the builder call to:

```ts
const userModelMessages = await buildVisionUserMessages(effectiveUserMessage, this.getCwd(), signal);
```

Then add a regression test proving `additionalContexts` appear in the stored/sent user message for both plain text and multimodal prompts.

### 2. Provider-owned `sendTurn` path loses tool history and skips shared stop semantics

Evidence:

- `src/agent/agent.ts:1763-1770` describes `processMessageViaSession()` as equivalent UI translation for owning adapters.
- `src/agent/agent.ts:1950-1993` emits tool-call and tool-result chunks to the live UI.
- `src/agent/agent.ts:2027-2033` persists only a single text assistant message using `fullText`.
- The direct path persists `response.messages` via `appendCompletedTurn()` at `src/agent/agent.ts:2600+`, preserving tool messages from the AI SDK.
- The direct path fires `Stop` and `StopFailure` hooks after completion/failure; `processMessageViaSession()` does not.

Impact:

Claude Agent SDK / Codex-style adapters can show tool activity while streaming, then lose that tool history after reload. Hook, recap, fabrication-detection, and transcript behavior are not equivalent across providers.

Recommendation:

Introduce one normalized `TurnRecorder` / `TurnEventAccumulator` that all provider paths feed:

- text deltas
- reasoning deltas
- tool calls
- tool results
- usage
- final stop/error state

Then persist a normalized message sequence for all runtime shapes. Add parity tests: direct `streamText`, batch, and `sendTurn` should produce comparable transcript entries for text-only and tool-using turns.

### 3. Agent turn setup is duplicated across direct and batch paths

Evidence:

- Batch path builds tools at `src/agent/agent.ts:2104-2117`.
- Direct path builds tools at `src/agent/agent.ts:2494-2505`.
- Both paths repeat context compaction, MCP bundle attach/close, tool filtering, mode gating, and error surface logic with small drift.

Impact:

Every change to tool availability, MCP semantics, mode gating, or overflow recovery must be patched in multiple branches. This is already how the code got into the state where `sendTurn` does not share the same behavior.

Recommendation:

Extract:

- `prepareTurnContext({ runtime, system, signal, attemptedOverflowRecovery })`
- `buildActiveToolSet({ runtime, mode, signal })`
- `finalizeTurn({ userMessage, events, usage, error })`

Keep the provider-specific execution as thin adapters over those shared pieces.

### 4. Extension activation is marked active before activation is actually complete

Evidence:

- `src/core/extensions/loader.ts:1060-1062` sets `instance.active = true` before calling `module.activate(api)`.
- `src/core/extensions/loader.ts:1065-1071` wraps async activation with `void Promise.resolve(...).catch(...)`, so `bootstrapExtensions()` does not await activation failures.
- `src/core/extensions/loader.ts:1119-1135` re-enables an extension and clears disabled tool ghost entries by inspecting the current registry immediately after `activateInstance()`.

Impact:

For synchronous builtins this mostly works. For any async user extension, the registry can report active before contributions exist. If async activation fails after registering a sink, timer, or partial contribution, dispose callbacks are not guaranteed to run. Re-enable can also race with `disabledExtensionToolNames` cleanup if registration happens after the cleanup loop.

Recommendation:

Make activation state explicit:

- `inactive`
- `activating`
- `active`
- `failed`

Either require `activate()` to be synchronous for v1, or make `activateInstance()` async and await it from `bootstrapExtensions()` / `enableExtension()`. On activation failure, run registered dispose callbacks before unregistering contributions.

### 5. Session CRUD is not consistently workspace-scoped

Evidence:

- `src/storage/sessions.ts:77-88` lists sessions scoped by `workspace_id`.
- `src/storage/sessions.ts:91-94` deletes sessions scoped by `id` and `workspace_id`.
- `src/storage/sessions.ts:110-117` fetches a session by `id` only.
- `src/agent/agent.ts` uses `getRequiredSession(id)` for resume/open flows.

Impact:

The API model is inconsistent: list/delete are workspace-scoped, but read/update methods are global by id. Short random ids reduce collision probability, but the CRUD boundary is still wrong. A resume/open by id can cross workspace boundaries if an id is known or a collision happens.

Recommendation:

Scope all session reads and writes by workspace unless explicitly implementing a cross-workspace session browser:

- `getSessionById(id)` should include `workspace_id = ?`.
- `setTitle`, `setModel`, `setMode`, `setRecap`, and `touchSession` should also include workspace scope or move behind methods that operate on the owning `SessionStore`.
- Add a regression test with two workspaces and same/foreign session ids.

## State and complexity findings

### 6. `src/ui/app.tsx` is a state warehouse

Evidence:

- `src/ui/app.tsx` is 6194 lines.
- `src/ui/app.tsx:313-620` alone declares the majority of app state: theme, modals, queue, MCP, agents, schedules, sessions, provider auth, payments, terminals, Telegram, and live turn state.
- Host actions are now extension-dispatched, but the receiving switch still lives in one large component.

Impact:

The component is doing too much: screen orchestration, persistence writes, keyboard routing, turn streaming, modal state machines, provider auth, MCP CRUD, session CRUD, queue management, Telegram bridge, and rendering. This increases accidental coupling and makes keyboard/modal regressions likely.

Recommendation:

Do not do a cosmetic file split. Split by state ownership:

- `useAgentTurnController(agent)` for queue, active turn, stream chunks, approval continuation, interrupts.
- `useKernelSinks(agent, handlers)` for toast/chat/assistant/ui/cwd/session/context/input sinks.
- `useModalRegistry()` for modal open/close state and refs.
- `useMcpManagement()` for MCP editor/list/resource-drill CRUD.
- `useSessionManagement(agent)` for session list/open/delete/title state.

Keep `App` as composition and layout only.

### 7. `src/agent/agent.ts` has become both domain object and orchestration engine

Evidence:

- `src/agent/agent.ts` is 3405 lines.
- It owns prompt construction, provider routing, turn streaming, transcript writes, hooks, compaction, subagents, schedules, verification, recap/title generation, usage, session lifecycle, and runtime model constraints.

Impact:

The `Agent` class is the highest-risk file in the codebase. Most future work touching turns will naturally land there, and every feature has access to too much internal state.

Recommendation:

Extract service classes with narrow contracts:

- `PromptBuilder`
- `TurnRunner`
- `ProviderTurnAdapter`
- `TranscriptWriter`
- `HookRunner`
- `CompactionManager`
- `AgentSessionController`

The `Agent` class should remain a facade over these collaborators.

### 8. Process-global sinks are useful but under-governed

Evidence:

- `src/agent/agent.ts:635-653` comments explicitly state subagent/schedule sinks are process-global and last-construct wins.
- `src/core/extensions/loader.ts` owns process-global sinks for chat, assistant, UI action, cwd, session id, context stats, Telegram, subagents, schedule, bash, MCP, hooks, and input.

Impact:

This is practical for a single TUI instance, but unsafe for multiple agents in one process, Telegram side sessions, tests, and future daemon embedding. Last-construct-wins is a hidden ownership transfer.

Recommendation:

Introduce a `KernelRuntimeContext` keyed by session/agent instance. Keep singleton defaults for current TUI boot, but make tool execution resolve the active context from `conversationId` or session id where available. Start with subagents, schedule, hooks, and bash.

## Extensions review

### What is working

- The registry has clean contribution categories: commands, tools, settings, model providers, models, screens, and status indicators.
- Tool ownership migration is mostly complete; kernel-owned tools are now real `tool({...})` definitions.
- Mode-gated tools (`modes: ["agent"]`) are a good simplification over registration-time gating.
- Screens and host actions are a useful bridge away from hardcoded modal commands.

### Main extension issues

1. `ExtensionHostServices` is too large. It now exposes most host capabilities directly, which makes extensions powerful but keeps the kernel porous.
2. `HostAction` is still a closed union. It is better than hardcoded slash command branches, but host-owned modal behavior still requires core code changes.
3. `registerTool()` accepts both metadata-only and full tool entries. This was useful during migration, but now it keeps a legacy mode alive.
4. The loader persists enable/disable as multiple JSON read-modify-write operations (`src/core/persistence/extensions.ts:69-87`), which is simple but not atomic.

Recommendations:

- Freeze metadata-only tool registrations for new code. New tools should always be execution-owning.
- Add a `registerHostActionHandler` or prefer `registerScreen` for user-visible UI so host actions do not become a second command bus.
- Replace extension JSON persistence with a small repository object that writes atomically through a temp file and exposes batch updates.
- Add extension lifecycle tests for async activation failure, partial registration cleanup, and re-enable of async tool contributors.

## CRUD review

### Sessions

Session create/list/delete are clear, but read/update scope is inconsistent. Fix workspace scoping first because it is a correctness issue.

### Extension settings

The persistence file is easy to understand, but the CRUD operations are individual read-modify-write helpers. It should become one `ExtensionSettingsStore` with atomic writes and batch mutations:

- `setExtensionEnabled(id, enabled)`
- `setToolEnabled(toolName, enabled)`
- `setSetting(key, value)`
- `transaction(mutator)`

### User/project settings

`src/utils/settings.ts` is pragmatic but broad. It mixes schema, normalization, persistence paths, defaulting, and feature-specific helpers. Move feature-specific settings into small typed modules over a shared JSON store.

## DRY and KISS violations

### DRY violations

- Turn preparation is duplicated across direct and batch agent paths.
- Tool/result streaming and persistence are implemented separately for `streamText`, batch, and `sendTurn`.
- Modal open/reset patterns repeat across `app.tsx`.
- Settings read/write/merge patterns repeat across user settings, project settings, extension settings, MCP settings, payment settings, and edit approval.

### KISS violations

- `App` and `Agent` are both too large to reason about locally.
- Extension kernel state is mostly module-level mutable state.
- Auto mode relies on a model self-contract plus `services.chat.dispatch()` queue semantics. Clever, but fragile unless the queue/turn protocol is made explicit and tested at the app sink boundary.
- Multiple "bridge" concepts exist: host actions, screens, sinks, provider sessions, chat dispatch, assistant append. The names are understandable individually, but the total surface area is now high.

## Recommended roadmap

### Phase 1 - Correctness first

1. Fix `additionalContexts` propagation in `Agent.processMessage()`.
2. Add transcript parity tests for `sendTurn` tool calls/results.
3. Scope `SessionStore.getSessionById()` and updates by workspace.
4. Add async extension activation failure tests.

### Phase 2 - Turn engine extraction

1. Extract shared active-toolset preparation.
2. Extract shared turn event accumulator.
3. Make direct, batch, and `sendTurn` paths feed the same finalizer.
4. Keep provider-specific code in small adapters.

### Phase 3 - UI state split

1. Extract `useAgentTurnController`.
2. Extract `useKernelSinks`.
3. Extract MCP and session management hooks.
4. Move host action handling into a registry/table instead of one large switch.

### Phase 4 - Persistence hardening

1. Add atomic JSON writes for extension/user/project settings.
2. Add schema validation for persisted settings.
3. Batch related mutations so enable/disable cannot leave inconsistent `enabled` and `disabled` arrays.

## Suggested test additions

- Hook context propagation:
  - direct text prompt
  - prompt with image path
  - provider-owned `sendTurn`
- Provider parity:
  - `sendTurn` text-only transcript
  - `sendTurn` tool call/result transcript
  - Stop/StopFailure hook invocation on `sendTurn`
- Extension lifecycle:
  - async activation success
  - async activation failure after registering a contribution
  - async re-enable clears `disabledExtensionToolNames`
- Session CRUD:
  - cannot resume a session from another workspace through a scoped `SessionStore`
  - updates do not mutate foreign workspace sessions
- UI queue:
  - extension `services.chat.dispatch()` during active turn queues once and starts exactly one next turn after settlement
  - interrupt plus queued dispatch does not double-finalize

## Bottom line

The codebase has a good extension direction and enough tests to support a cleanup. The main architectural debt is concentrated, not diffuse: fix the turn loop semantics, then split `Agent` and `App` along the real state boundaries. Avoid broad rewrites. The safest path is to extract one shared behavior at a time and pin each extraction with parity tests before moving the next branch.
