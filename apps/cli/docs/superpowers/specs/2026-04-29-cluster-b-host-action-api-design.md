# Cluster B — Host UI Action Primitive

**Status:** Approved · 2026-04-29
**Phase:** 4d (planned) — follows phases 4a/4b/4c which migrated workflow prompts, `/skills`, and custom subagents to builtin extensions.
**Goal:** Move the modal-opening and simple host-action slash commands out of `src/ui/app.tsx`'s inline `handleCommand` switch into a builtin extension that drives the host through a single new sink. Pure cleanup — no new capability for third-party extensions, no UI rendering moves.

## Context

Phases 4a–4c established the migration grammar: extensions REGISTER, host RENDERS, the kernel DISPATCHES. The chat sinks (`chat.dispatch`, `chat.appendAssistant`) proved the "sink" pattern — extension fires a host primitive, host owns the implementation.

`handleCommand` in `app.tsx` still owns ~26 inline `case` branches. Cluster A (workflow prompts, `/skills`, subagents) is closed. Cluster B targets the next obvious bucket: the 17 commands that either open a host-owned modal or trigger a simple host-side effect.

Out-of-scope clusters:
- **Cluster C** — `/btw`, `/term <cmd>`, `/term-modal` post-spawn integration. These own non-trivial host state and lifecycle (loading/done/error overlay, terminal session lifetimes, abort controllers). Separate design pass.
- **Cluster D** — moving the modal RENDERING into extensions. Different project entirely; explicitly rejected upstream.

## Goal

After Cluster B:
- `handleCommand` drops from ~26 cases to ~3 (`/btw`, `/term*`, `/term-modal` deferred items) plus the existing `tryDispatchExtensionInput(input)` fallback.
- 17 commands live in a new builtin extension and reach the host via one new sink.
- Public extension API gains exactly one entry: `services.ui.action(payload)`.
- No behavioural change for the user — every migrated command works identically before/after.

## Scope

### In scope (17 commands)

**Modal opens (no args):**
`/model`, `/sandbox`, `/wallet`, `/remote-control`, `/agents`, `/schedule`, `/extensions`, `/sessions`, `/theme`, `/showcase`, `/terms`, `/term-modal`

**Modal opens (with args):**
- `/mcp` (no args → picker), `/mcp add` (opens editor with empty draft) — carries `openEditor?: McpEditorDraft`, `editingId?: string | null`
- `/claude` (no args), `/thinking`, `/effort`, `/permission` — all open the Claude-agent modal with optional `focusGroup: ClaudeAgentGroup`

**Simple host actions (no modal):**
- `/clear` — wipe transcript
- `/quit` — process exit
- `/ui claude-code|opencode` — toggle `UiMode`

### Out of scope

- `/btw`, `/term <cmd>`, `/term-modal` post-spawn focus → Cluster C
- Modal rendering, focus management, key handling → stays in `app.tsx`
- Extension data-fetch APIs (no new `services.workspace.list*`) — host owns fetches, see below

## Design

### 1. One primitive: `services.ui.action`

Single host-services entry point, parallel to `chat.dispatch` / `chat.appendAssistant`:

```ts
services.ui.action(payload: HostAction): void
```

Sink semantics: fire-and-forget. No-op until the UI binds the sink (same as chat sinks).

**Rejected alternatives:**
- N typed methods (`services.ui.openModelPicker()`, `services.ui.openSandbox()`, …) — adds 17 methods to `ExtensionHostServices`; every new modal grows the public surface.
- String-keyed `openModal(id, args?)` — args degrade to `unknown`; loses type safety.

Discriminated union wins because each modal carries its own typed args without inflating the API.

### 2. The discriminated union

```ts
// New types exported from src/core/extensions/api.ts
export type HostAction =
  // Modal opens (no args)
  | { type: "model" }
  | { type: "sandbox" }
  | { type: "wallet" }
  | { type: "remote-control" }
  | { type: "agents" }
  | { type: "schedule" }
  | { type: "extensions" }
  | { type: "sessions" }
  | { type: "theme" }
  | { type: "showcase" }
  | { type: "terms" }
  | { type: "term-modal" }
  // Modal opens (with args)
  | { type: "mcp"; openEditor?: McpEditorDraft; editingId?: string | null }
  | { type: "claude-agent"; focusGroup?: ClaudeAgentGroup }
  // Simple host actions (no modal)
  | { type: "clear" }
  | { type: "quit" }
  | { type: "set-ui-mode"; mode: UiMode }
  | { type: "toggle-ui-mode" };
```

Supporting types (`ClaudeAgentGroup`, `UiMode`, `McpEditorDraft`) re-exported from `src/core/extensions/index.ts` for extension consumption. Source modules stay where they are; the barrel just adds re-exports.

`toggle-ui-mode` exists because `/ui` with no args needs to read the current mode and flip — extensions can't read host state, so the host owns the toggle.

### 3. Wiring

**`api.ts`:** add `HostAction` type + `ui: { action: (payload: HostAction) => void }` to `ExtensionHostServices`.

**`loader.ts`:** add a sink slot mirroring chat sinks:
```ts
let uiActionSink: ((action: HostAction) => void) | null = null;
export function setUiActionSink(sink: (action: HostAction) => void): void { uiActionSink = sink; }
```
`buildHostServices()` exposes `services.ui.action(action)` which calls `uiActionSink?.(action)` — no-op when unbound.

`__resetExtensionsForTests` clears the sink alongside the existing chat sinks.

**`app.tsx`:** at mount, calls `setUiActionSink(handleUiAction)`. `handleUiAction` is one switch statement over `action.type`, calling the existing `openMcpModal()`, `openAgentsModal()`, `setUiMode()`, etc. The existing host functions don't move — they just gain a new caller. Sink cleanup is process-lifetime: handled by `shutdownExtensions` and `__resetExtensionsForTests`, identical to the existing chat sinks (no per-mount unbind needed).

**Data fetching stays in the host sink.** `handleUiAction`'s `case "schedule":` calls the existing `openScheduleModal()` which already does `agent.listSchedules()` and seeds local state. The extension never touches data sources.

### 4. The builtin extension

New file: `src/core/extensions/builtin/host-actions.ts`. Registers 17 commands. Each handler is a single `services.ui.action({...})` call.

Handlers for `/claude`, `/thinking`, `/effort`, `/permission` all dispatch `{type: "claude-agent", focusGroup: "<group>"}` — same shape, different focus. Same for `/mcp` vs `/mcp add` (the latter parses `args` and sets `openEditor`).

Single-file co-location keeps the extension small (~80 lines). No per-modal file explosion; no new builtin dirs.

Registered alongside the existing builtins in `src/core/extensions/builtin/index.ts`.

### 5. `app.tsx` changes

- Add `setUiActionSink` import + bind at mount (parallel to existing chat-sink wiring).
- Add `handleUiAction(action: HostAction)` function — one switch statement.
- Remove the 17 `case` branches from `handleCommand` AND the matching branches from `handleSlashMenuSelect` — both go through `tryDispatchExtensionInput(input)`.
- Drop now-unused entries from the `dispatchExtensionCommand` deps array (`openMcpModal`, `openAgentsModal`, `openScheduleModal`, `openExtensionsModal`, `openSessionsModal`, `openThemeModal`, `openClaudeAgentModal`, `setUiMode`, `quitProcess`, `clearTranscript`).

The `openXxxModal` callbacks in `app.tsx` STAY — they're now called from `handleUiAction` instead of inline.

### 6. Verification

- Manual smoke: every one of the 17 commands typed at the prompt and selected from the slash menu — both must work identically.
- `bun run typecheck` clean.
- `bun run test` 326/326 (or higher with new tests) green.
- New unit tests added in `loader.test.ts`:
  - `setUiActionSink` wiring (set, replace, clear-on-reset)
  - `services.ui.action()` no-op when unbound
  - `services.ui.action()` calls bound sink with payload
  - At least one builtin extension test that asserts the new commands register with the expected `name` and that their handlers call `services.ui.action()` with the correct payload.
- `handleCommand` cyclomatic count drops by ~17 cases.

### 7. Risks

- **Argument-carrying modals** (`/mcp add`, `/claude thinking`) — the union variants must preserve the same args the inline branches currently pass. Spec freezes the variant shapes; implementation must match.
- **Biome debt amplification** — every dep removed from `dispatchExtensionCommand`'s deps array shifts what `useExhaustiveDependencies` sees. Likely surfaces more pre-existing biome errors. The C-after-B ordering exists exactly to absorb that — biome cleanup is the next phase.
- **Async modal seeding** (`/schedule`) — sink stays sync `(action) => void`. Async work happens inside `handleUiAction`'s case, exactly as `openScheduleModal` already does. No change required to sink shape.
- **Sink registration order** — `setUiActionSink` must be bound before any extension command can dispatch. Existing chat-sink bindings already run at mount; new sink slots in adjacent to them.

### 8. Out-of-scope follow-ups

- Cluster C design pass: `/btw`, `/term`, `/term-modal` lifecycle primitives.
- `app.tsx` biome debt cleanup (the immediate next phase after this lands).
- Eventual deprecation: `services.ui.action` is the long-term home for host-owned UI side effects; future read-only modals (e.g. credential prompts) plug in by adding a new union variant.

## Acceptance criteria

1. `services.ui.action(payload)` exists on `ExtensionHostServices`, is type-safe via discriminated union, and is a no-op when unbound.
2. `setUiActionSink` is exported from the loader and bound by `app.tsx` at mount.
3. `host-actions.ts` builtin registers all 17 commands; each handler is a single `services.ui.action(...)` call.
4. `handleCommand` and `handleSlashMenuSelect` in `app.tsx` no longer contain inline branches for any of the 17 commands.
5. All 17 commands work identically before/after — typed at the prompt AND selected from the slash menu.
6. `bun run typecheck` and `bun run test` both clean. Test count increases by the new sink + builtin tests.
7. Spec sections 1–7 implemented as written; deviations require updating the spec.
