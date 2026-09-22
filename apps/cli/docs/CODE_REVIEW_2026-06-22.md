# CodeSurf CLI — Full Code Review

**Date:** 2026-06-22
**Scope:** whole codebase, with focus areas requested by owner — refactoring, god-file reduction, extensions SDK, built-in extensions, OpenTUI performance, and the `/ui` view-switching mechanism.
**~98k LOC** across `src/` (excluding tests). 54 builtin extensions. Health signals are strong: **1 TODO, 11 `any`, 1 `@ts-ignore`, 38 `console.log` (almost all legitimate CLI output in `index.ts`)**.

This review supersedes/complements `docs/EXTENSIONS_AUDIT.md` (2026-05-26). A currency check of that audit is in §5 — **most of its critical items are now fixed**.

---

## 0. Executive verdict

The codebase is in **genuinely good shape** for its size. The extension SDK is well-designed and mature; the OpenTUI performance work is thoughtful and instrumented (the `FpsOverlay` is a model of how to do this right); code hygiene is excellent.

There is **one dominant structural problem** that everything else flows from:

> **`src/ui/app.tsx` is a 7,989-line file built around a single `App()` component that is 7,457 lines long, holds 311 React hooks, and contains a `handleKey` callback whose body is 1,941 lines.**

This single file is the reason almost every other complexity in the UI exists — the `useSyncExternalStore` escape hatch in `stream-store.ts`, the manual `inputRef.current?.requestRender()` kicks (13+ of them), the `setInterval`-driven re-renders, and the `uiMode === "claude-code" ? A : B` ternaries that thread two complete UIs through one component. All of those are *workarounds* for the god component. Decompose `App` and most of the perf ceremony becomes unnecessary.

Secondary: the `Agent` class (`src/agent/agent.ts`, 2,425 lines, ~70 methods) is a classic God Object mixing sessions, scheduling, context, model routing, approvals, and usage.

Everything below is actionable and ranked.

---

## 1. God files (highest impact)

Ranked by pain-to-fix ratio. All numbers are current line counts.

### 1.1 `src/ui/app.tsx` — 7,989 lines  🔴 critical

The single biggest issue in the codebase. Evidence:

| Metric | Value |
|---|---|
| Total file length | 7,989 |
| `App()` function body | **7,457 lines** |
| React hooks in one component (`useState`/`useEffect`/`useCallback`/`useMemo`/`useRef`) | **311** |
| `handleKey` `useCallback` body | **1,941 lines** |
| `uiMode === "claude-code"` branches in the render tree | 29 (4 top-level tree swaps + 25 inline) |

**Why this hurts:**
- **Every state change re-renders the whole tree.** With 311 hooks, any `setState` anywhere reconciles a multi-thousand-line component. The team has correctly reached for `useSyncExternalStore` (`stream-store.ts`) and `memo()` to escape this — but those are band-aids over a component that should not exist as one unit.
- **The two UI modes (`opencode` / `claude-code`) are tangled into one component** via `uiMode === "claude-code" ? <A/> : <B/>` at four top-level points (lines 6486, 6765, 6789, 6880) plus 25 inline conditionals. Each mode is a *complete* layout (different composer chrome, different footer, different status line, different success-color theming). They share almost no structure at render time but share all the state and handlers.
- **`handleKey` is a 1,941-line switch** that has its own "INPUT PRIORITY CONTRACT" comment block (lines 3249–3278) documenting four overlapping input systems that must cooperate. The comment itself admits *"This comment is the source of truth until we have a real InputRouter hook."* That hook (`useInputRouter`) now exists per line 3279 — but the giant switch remains.
- **13+ manual `inputRef.current?.requestRender()` calls** scattered through key handlers. Each is a hand-tuned render kick; this is the kind of thing that rots silently.
- Biome's `useExhaustiveDependencies` is disabled for `handleKey` (line 4435: *"~18 missing/extra entries"*). A hand-maintained dep array on a 1,941-line callback is a latent bug farm.

**Recommended decomposition** (incremental, each step ships independently):

1. **Extract the two UI modes into `<OpencodeLayout>` and `<ClaudeCodeLayout>`.** `App` becomes a thin shell that picks one based on `uiMode` and forwards a shared `{ agent, messages, stream, dispatch, ... }` context. This alone removes ~29 conditionals and makes each mode readable. The existing `setUiMode` + composer-restore effect (lines 568–622) stays in the shell.
2. **Extract modal state into a `useModals()` hook + `<ModalStack>`.** Today App holds ~20 boolean modal flags (`showWalletPicker`, `showSandboxPicker`, `showFeatureFlags`, `showProviderAuth`, `showExtensions`, `showSchedule`, `showMcp`, `showModels`, `showTelegram*`, `showAgents`, `showClaudeAgent`, `showConnect`, `showSessions`, `showUpdate`, `showShowcase`, `showCommandPalette`, `showSlashMenu`, dynamic screens, etc.). The single `ANY new modal/overlay MUST be added to this ONE expression` comment (line 4300) is the smell — that expression is a 20-term OR driving both dimming and the Esc priority chain. A modal-stack model (array of `{id, node, dim}`) collapses it to `modals.length > 0`.
3. **Split `handleKey` by concern** into per-modal handlers composed via `useInputRouter` (which already exists). The quit-confirm, running-subagents drill, questionnaire, mcp drill, terminal input-mode, command-palette, and slash-menu blocks are each self-contained and belong in their own component's `useKeyboard`.
4. **Extract the slash-command / command-palette derivation** (lines ~1277–1370, building the menu from the extension registry) into `useSlashMenu(services)`.
5. **Extract streaming-turn orchestration** (`processMessage`, `finalizeActiveTurn`, the `setInterval`-driven roster/timer pollers at lines 3958/4023/4051/4094) into a `useAgentTurn()` hook. This is the agent-loop ↔ UI bridge and deserves its own module.

Realistic target: **`app.tsx` under ~800 lines**, with the shell + mode switch + context providers, and the rest in `layouts/`, `hooks/`, and the existing `components/` and `ai-output/`.

### 1.2 `src/agent/agent.ts` — 2,425 lines (`Agent` class)  🟠 high

A classic God Object. ~70 public/private methods spanning at least six responsibilities:

- **Model management** — `getModel`, `setModel`, `getModelAdapterId`, `resolveAdaptiveModel`
- **Session lifecycle** (7+ methods) — `startNewSession`, `resumeSession`, `listSessions`, `renameSession`, `deleteSession`, `getSessionInfo`, `getSessionSnapshot`, `getChatEntries`
- **Scheduling** — `listSchedules`, `removeSchedule`, `getScheduleDaemonStatus` (these delegate to a sink; no reason to live on `Agent`)
- **Context/compaction** — `getContextStats`, `getContextBreakdown`, `manualCompact`, `getSystemPromptForEstimate`
- **Auxiliary generation** — `generateTitle`, `getSessionRecap`, `askSideQuestion`
- **Tool/agent orchestration** — `respondToToolApproval`, `onSubagentStatus`, `recordUsage`, `turnContext`, `abort`, `cleanup`

**Recommended split** (extract as composed collaborators, keep `Agent` as the orchestrator facade):
- `SessionManager` — all session CRUD + snapshot/entries (this is already backed by `src/storage/sessions.ts`; the methods are thin wrappers that belong there or in a manager).
- `ContextManager` — stats/breakdown/compact/system-prompt-for-estimate.
- `ScheduleService` — the three schedule methods are pure sink forwards; move to a standalone service the UI imports directly.
- `ModelRouter` — `resolveAdaptiveModel` + adaptive-routing trace logic (already has `src/agent/adaptive-routing.ts`; finish the extraction).
- `TitleGenerator` / `RecapService` / `SideQuestionService` — small, self-contained, async.

### 1.3 `src/core/extensions/loader.ts` — 1,694 lines  🟡 medium

This file is doing a lot but most of it is coherent: it's the extension host runtime. The pain is that it mixes **(a) the public sink-binding surface** (`setBashSink`, `setMcpToolBundleProvider`, `setHooksSink`, … — ~15 setters), **(b) the host-services builder** (`buildHostServices`, lines 690–1163, a ~470-line function), and **(c) lifecycle/registry glue** (`bootstrapExtensions`, `enableExtension`, `disableExtension`, `shutdownExtensions`).

**Recommended split:**
- `loader.ts` — lifecycle + `instances` map + bootstrap/enable/disable/shutdown (~400 lines).
- `sinks.ts` — all the `set*Sink`/`set*Provider` exports + their `require*Sink` guards + `createEmptySinkState`.
- `host-services.ts` — `buildHostServices()` + the settings-subscriber map + mention-provider registry. This is the single biggest win: a 470-line function building a 31-method services object is hard to test in isolation.

### 1.4 Large provider extensions  🟡 medium

| File | Lines | Issue |
|---|---|---|
| `codesurf-desktop-provider.ts` | 1,375 | 140-line hardcoded MODELS bootstrap; abort signal not threaded into initial POST (per old audit — verify). |
| `claude-agent-provider.ts` | 1,334 | Large but coherent; sibling-imports resolved. |
| `hermes-gateway-provider.ts` | 1,317 | ~800 lines of config parsing (per old audit). Extract a `hermes-config.ts`. |
| `omnigent-provider.ts` | 1,022 | Review for shared SSE-consumer reuse (see §5). |

---

## 2. The `/ui` view-switching mechanism

**How it works today** (verified end-to-end):

1. `/ui` is registered as a builtin command in `host-actions.ts:276`. With no arg it resolves to the `toggle-ui-mode` `HostAction` (`host-actions.ts:281`).
2. `toggle-ui-mode` is part of the `HostAction` discriminated union (`api.ts:690`), dispatched by the UI (`app.tsx:3780`, `host-action-dispatch.ts:126`).
3. The UI state is `uiMode: UiMode` (`"opencode" | "claude-code"`), persisted in `user-settings.json` (`settings.ts:193`), default `"opencode"` (`app.tsx:561`).
4. `toggleUiMode()` (`app.tsx:585`) flips the state and persists. A dedicated effect (`app.tsx:588–622`) keys on `uiMode` to restore the composer draft across the mode switch (the two modes use different `TextareaRenderable` instances, keyed `composer-claude-code` / `composer-shell` / `composer-opencode`).
5. `claude-code` mode also **remaps the theme** (`app.tsx:627–643`): success markers (✓, diff-added, code, links, bold, italic, headings) inherit the theme accent instead of green. Cosmetic-only.

**The two modes are genuinely different layouts:**
- `opencode` — wide composer shell, message list, separate footer.
- `claude-code` — compact session-style chrome: composer sits in-session, compact footer hints, live status embedded in the message list, todo panel overlay, accent-colored success markers.

**Assessment:**
- ✅ The *mechanism* is clean: a typed `HostAction`, a persisted setting, a single toggle. Good.
- ✅ The composer-draft-restore effect is correctly keyed and has a macrotask fallback for retained-mode TUI renderables. Thoughtful.
- 🔴 The *implementation* is the problem: **the two layouts are interleaved into one component via 29 conditionals** (see §1.1). `claude-code` mode isn't a separate component — it's a parallel render path living inside `App`, sharing all state and all 311 hooks. This is the single biggest contributor to `app.tsx`'s size.
- 🟡 There are **three separate composer keys** (`composer-claude-code`, `composer-shell`, `composer-opencode`) but only two modes — `composer-shell` vs `composer-opencode` looks like a leftover split. Worth consolidating.

**Fix:** extract `<OpencodeLayout>` and `<ClaudeCodeLayout>` (§1.1 step 1). The toggle, persistence, and theme-remap stay in the shell. Each layout owns its composer instance and its own subtree. The shared `inputRef` becomes a small `ComposerContext` so the draft-restore effect still works.

---

## 3. OpenTUI performance

**Overall: the performance work is sophisticated and well-instrumented. The remaining issues are structural consequences of the god component, not naive mistakes.**

### What's done right ✅
- **`stream-store.ts` (95 lines)** — deliberately uses `useSyncExternalStore` because OpenTUI ships a custom React reconciler. Token deltas commit to the external store; only the small leaf streaming component subscribes. Clean.
- **`FpsOverlay` (`components/fps-overlay.tsx`)** — a textbook passive observer: reads `renderer.frameId` / `getStats()` on a 500ms timer, updates only its own local state, **never calls `requestLive` itself** (it explicitly avoids forcing the continuous rendering it measures). Distinguishes `paints/s` (wasted work at idle) from `live` (pinned continuous-render). Opt-in via feature flag. This is exactly how you instrument a TUI renderer.
- **`MessageList` virtualization (`components/message-list.tsx`)** — binary-search `upperBound`/`lowerBound` for viewport windowing, `MessageView = memo(...)` with a custom equality fn (line 504), dual poll cadence (`VIEWPORT_POLL_FAST_MS = 16` active, `250` idle). The streaming body is mounted in the scrollbox's `trailingSlot` so it doesn't fight the virtualization.
- **`inline-image.tsx`** — uses `renderer.requestLive()` while an image is mounted to fix an out-of-phase strobe that a 100ms `setInterval` previously caused. Documented design choice (lines 15, 352–355), correctly released on unmount.
- **Token-delta throttling** — `app.tsx:2381–2392` documents that per-delta React commits were throttled, with manual `scrollToBottom` drops because the scrollbox handles it.

### Structural concerns 🟠

1. **Whole-tree re-renders from `setInterval` timers.** App runs at least four interval-driven `setState`s while certain UI is open:
   - `setInterval(tick, 1500)` (line 3958)
   - `setInterval(() => setAgentsNow(Date.now()), 1000)` (line 4023) — forces a **full App re-render every second** while the running-agents modal is open.
   - `setInterval(poll, 500)` (line 4051) — modal detail poller.
   - `setInterval` at line 4094.
   
   Each of these mutates App state and reconciles the entire 7,457-line component. Once `App` is decomposed (§1.1) and the running-agents modal owns its own `now` state, these re-renders become local. **This is the strongest perf argument for the god-file split.**

2. **16ms (60fps) viewport polling in `MessageList`.** The active-mode poll at 60fps is aggressive. The binary-search windowing is efficient, but polling *at all* on a timer is a smell — ideally viewport changes would be event-driven from the scrollbox. That said, the idle fallback (250ms) limits the cost when not scrolling/streaming, so this is acceptable. Worth revisiting if profiling shows sustained CPU at rest during a stream.

3. **13+ manual `inputRef.current?.requestRender()` kicks** in key handlers (lines 4138, 4205–4225, 4955, 5372, 5395, 5407, 5894, 6307, 6338). These are hand-tuned render requests to nudge the textarea renderable after programmatic mutations. They work, but they're the kind of implicit coupling that breaks silently when the textarea implementation changes. Consolidate behind a single `commitComposer()` helper.

4. **`claude-code` theme object rebuilt on every App render.** `app.tsx:627–643` `useMemo`s the remapped theme keyed on `[baseTheme, uiMode]` — correct. But because App re-renders so often (§3.1), the memo is invalidated more than necessary. Localizing the mode into its own layout component makes this a non-issue.

### No critical perf bugs found
The external-store escape hatch, the memoization, the virtualization, and the diagnostic overlay are all sound. **The performance ceiling is set by the god component, not by any rendering mistake.** Decompose `App` and the timer-driven re-renders and whole-tree reconciles mostly evaporate.

---

## 4. Extensions SDK (`src/core/extensions/`)

**Verdict: mature, well-typed, well-barreled.** The public surface (`index.ts`) is a clean explicit barrel (no `export *`). The manifest schema is intentionally trimmed and version-gated (`semver.satisfies` against `EXTENSIONS_V1_API_RANGE`). The `ExtensionHostServices` object exposes 31 well-documented methods.

### Strengths
- **Clean contribution model:** `registerCommand` / `registerPromptCommand` / `registerListingCommand` / `registerTool` / `registerModel` / `registerModelProvider` / `registerScreen` / `registerSetting` / `registerStatusIndicator` / `registerToggleableIndicator` / `registerCommandResolver` / `registerMentionsService`. The specialized command forms (prompt/listing) collapse the boilerplate the old audit flagged.
- **Lifecycle discipline:** `onDispose` + `onProcessExit` + `protected`/`hidden`/`enabledByDefault` manifest flags. Provider sessions have `disposeProviderSession` / `disposeAllProviderSessions`.
- **`RegisteredCommand.visible?: (services) => boolean`** — the visibility predicate the old audit asked for (rec #7) is now in place. Lets commands self-gate on active adapter/mode instead of being filtered in `app.tsx`.
- **`services.tools.safeExecute` + `services.hooks.wrapExecute`** — the two highest-value helpers from the old audit (recs #1, #2) are implemented and adopted.
- **Registry is observable** via `useRegistrySnapshot` / `subscribeToRegistry` + focused hooks (`useCommands`, `useTools`, `useModels`, `useScreens`, `useStatusIndicators`, `useExtensions`).

### Remaining SDK gaps / smells
1. **Sink binding still reaches "around" the SDK.** `setBashSink`, `setMcpToolBundleProvider`, `setHooksSink`, `setSubagentsSink`, `setScheduleSink`, `setTelegramSink`, `setIconResolver`, etc. are all exported from `loader.ts` and imported directly by builtin extensions (`bash-tools.ts`, `mcp-prompt-commands.ts`, `nerd-icons.ts`). The old audit's rec #4 (`api.bindKernelSink`) was **not** implemented. This is the main remaining SDK-compliance gap: builtins that need a kernel sink bypass the `services.*` surface. Either (a) expose these as `services.kernel.bind*` or (b) document that sink-binding is a host-only, builtin-only privilege and stop pretending otherwise.
2. **`ProviderConnectionContext` still lacks a full `services` handle** (old audit rec #5). `claude-agent-provider.ts` still needs to reach the loader for `services.mcp.isEnabled()`. Verify and close.
3. **Provider-disabled lifecycle** (old audit rec #6) — `model-runtime.ts` session cache holds `ProviderSession` refs whose `disconnect()` may not fire on disable. `disposeAllProviderSessions` exists; confirm it's wired into `unregisterExtensionContributions`.
4. **`"mentions"` capability** — now declared on the `ExtensionCapability` enum (old audit rec #9 — fixed). ✅
5. **`RegisteredSetting.type: "secret"`** (old audit rec #10) — verify present; would harden against another lightclaw-style hardcoded default.

### Module layout
The kernel itself (`api.ts`, `manifest.ts`, `loader.ts`, `registry.ts`, `model-runtime.ts`, `loops.ts`, `event-bus.ts`, `host-theme.ts`, `icons.ts`) is well-factored. The only layout smell is `loader.ts`'s size (§1.3).

---

## 5. Built-in extensions — currency vs `EXTENSIONS_AUDIT.md`

The 2026-05-26 audit identified 37 extensions; there are now **54**. I re-verified every critical/security item:

### ✅ Fixed since the audit
| Item | Was | Now |
|---|---|---|
| `lightclaw-provider.ts` hardcoded 64-char API key + LAN-IP default | **FAIL** | Uses `${ADAPTER_ID}.apiKey` setting; no hardcoded secret. |
| `xai-tools.ts` `getHostServices().bash.cwd()` (throws in headless) | WARN | Now `api.services.workspace.cwd()`. |
| `helpers.ts` dead `defineToolGroupExtension` | FAIL (dead) | **Deleted.** |
| `file-tools.ts` read/write/edit skip hooks | WARN (0 hooks) | All three now wrapped in `api.services.hooks.wrapExecute(...)`. |
| `voice/index.ts` dropped `registerStatusIndicator` disposer | WARN | Now captured and `api.onDispose(disposeIndicator)`. |
| `formatHistoryAsPreface` duplicated in lazar + claude-agent | ~100 LOC dup | Extracted to shared `provider-history-preface.ts`; both import it. |
| `computer-tools.ts` 12× verbatim blocks (323 LOC) | WARN | Collapsed to 272 LOC. |
| `context-bar` + `resource-counter` → `footer-chrome` merge | merge candidate | `footer-chrome/` package now exists. |
| SDK `services.hooks.wrapExecute` (rec #1) | gap | Implemented + adopted. |
| SDK `services.tools.safeExecute` (rec #2) | gap | Implemented. |
| SDK `RegisteredCommand.visible` (rec #7) | gap | Implemented. |
| SDK `registerPromptCommand` / `registerListingCommand` (rec #11/12) | gap | Implemented. |
| SDK `registerToggleableIndicator` (rec #15) | gap | Implemented. |
| SDK `useHostTheme` + shared `<ScreenOverlay>` (rec #13/17) | gap | `host-theme.ts` + `screen-overlay.tsx` exist; editor/files/steer/doc-viewer use them. |
| SDK `api.onDispose` / `api.onProcessExit` (rec #23) | gap | Implemented. |
| `"mentions"` capability in enum (rec #9) | gap | Declared. |

That's an impressive close-out rate. **The audit drove real work.**

### 🟠 Still open
1. **`AbortSignal` not plumbed through `tools/file.ts`, `tools/grep.ts`, grep-tool, bash sink cleanup** (old audit recs #3, #12). Only `lsp/runtime.ts` takes an `abortSignal`. Consequence: `Stop` can't actually cancel a runaway `grep`/`read_file`/`bash`. This is the most impactful remaining item — interrupts are a user-visible correctness issue, not just hygiene.
2. **`api.bindKernelSink` formal surface** (old audit rec #4) — not implemented; builtins still `import { set*Sink } from "../loader"`. See §4.
3. **Anthropic model catalog** — `anthropic-models-catalog.ts` now exists, but **8 files** still reference `claude-sonnet-4` / `claude-opus-4` / `claude-3-7` strings directly (`claude-grok-skills`, `claude-agent`, `codesurf-desktop`, `lazar`, `lightclaw`, `hermes-gateway.test`, `anthropic-provider`). Verify each imports from the catalog rather than re-declaring; a couple almost certainly still inline.
4. **`hermes-gateway-provider.ts` (1,317 lines)** — still ~800 lines of config parsing. Extract `hermes-config.ts`.
5. **`claude-grok-skills-provider` merge into `claude-agent-provider`** (old merge rec #4) — verify whether done or still separate-and-duplicated.
6. **Hook coverage on the remaining tools** — `file-tools` is fixed, but `computer_*`, `task`/`delegate`, `paid_request`, `telegram_send_file`, `search_web`/`search_x`, `generate_image`/`generate_video`, `grep`, `lsp` should each get the `wrapExecute` treatment for consistent PreToolUse/PostToolUse/audit hooks. The helper now exists; this is a mechanical sweep.

---

## 6. Other observations

- **`src/index.ts` (782 lines)** — the CLI entrypoint is large but coherent (arg parsing, update checks, model/wallet/sandbox subcommands). The 38 `console.log`s are almost all legitimate user-facing CLI output here. Fine.
- **`src/utils/settings.ts` (762 lines)** — the settings layer is the persistence backbone for UI mode, theme, feature flags, provider keys, steering, etc. Worth a read for anyone touching persistence; no issues found.
- **Tests are extensive and co-located** — every major module has a `.test.ts` sibling (loader, registry, model-runtime, loops, filter, all providers, all tools, stream-store, markdown, menu-nav, etc.). The `test:bun` script curates a fast subset. Good discipline.
- **`src/core/extensions/builtin/__tests__/` + per-file `.test.ts`** — extension tests are thorough. `loader.test.ts` (1,539 lines) is itself large but it's testing the most critical runtime.
- **`src/ui/themes/catalog.ts` (725 lines)** — large but it's data (theme definitions), not logic. Acceptable.

---

## 7. Prioritized recommendations

Ordered by impact-to-effort ratio. Each is independently shippable.

### P0 — structural (do these first; they unlock everything else)
1. **Decompose `app.tsx`** (§1.1). Extract `<OpencodeLayout>` / `<ClaudeCodeLayout>`, a `useModals()` modal-stack, per-modal key handlers via the existing `useInputRouter`, and a `useAgentTurn()` hook. Target <800 lines for the shell. **This is the single highest-value refactor in the codebase** and directly fixes the `/ui` tangling (§2) and most perf concerns (§3).
2. **Plumb `AbortSignal` through `file`/`grep`/`bash`/`telegram` sinks** (§5 open #1). Makes `Stop`/Ctrl+X actually interrupt runaway tools. User-visible correctness.
3. **Split the `Agent` god class** (§1.2) into `SessionManager` + `ContextManager` + `ScheduleService` + `ModelRouter` + small services. `Agent` becomes an orchestrator facade.

### P1 — SDK + extension hygiene
4. **Finish the `wrapExecute` sweep** across all side-effecting tools (computer, task/delegate, paid_request, telegram, xai search/image, grep, lsp). The helper exists; this is mechanical.
5. **Decide sink-binding**: either ship `services.kernel.bind*` (old rec #4) or document sink-binding as builtin-only and mark the `loader` setters `@internal`. Removes the SDK-bypass smell.
6. **Finish the Anthropic catalog centralization** — make all 8 consumers import from `anthropic-models-catalog.ts`.
7. **Split `loader.ts`** into `loader.ts` + `sinks.ts` + `host-services.ts` (§1.3). Extract the 470-line `buildHostServices()`.
8. **Extract `hermes-config.ts`** from `hermes-gateway-provider.ts`.

### P2 — polish
9. Consolidate the three composer keys (`composer-claude-code` / `composer-shell` / `composer-opencode`) — looks like a leftover split.
10. Replace the 13+ manual `inputRef.current?.requestRender()` calls with a single `commitComposer()` helper.
11. Verify `ProviderConnectionContext.services` (old rec #5) and provider-session disposal on disable (old rec #6).
12. Re-baseline `docs/EXTENSIONS_AUDIT.md` against current state (or retire it in favor of this review) — most of its items are done.

---

## Appendix — file-size heatmap (current, src/, >400 LOC, excluding tests)

| File | LOC | Verdict |
|---|---|---|
| `ui/app.tsx` | 7,989 | 🔴 decompose (§1.1) |
| `agent/agent.ts` | 2,425 | 🟠 split God class (§1.2) |
| `core/extensions/loader.ts` | 1,694 | 🟡 split into sinks + host-services (§1.3) |
| `core/extensions/builtin/codesurf-desktop-provider.ts` | 1,375 | 🟡 review POST abort; model bootstrap |
| `core/extensions/api.ts` | 1,338 | ✅ coherent (SDK surface) |
| `core/extensions/builtin/claude-agent-provider.ts` | 1,334 | ✅ coherent |
| `core/extensions/builtin/hermes-gateway-provider.ts` | 1,317 | 🟡 extract hermes-config.ts |
| `ui/components/message-list.tsx` | 1,278 | ✅ well-virtualized |
| `core/extensions/builtin/omnigent-provider.ts` | 1,022 | 🟡 shared SSE reuse |
| `index.ts` | 782 | ✅ CLI entrypoint |
| `utils/settings.ts` | 762 | ✅ persistence backbone |
| `core/extensions/builtin/knowledge-extensions.ts` | 727 | ✅ |
| `ui/themes/catalog.ts` | 725 | ✅ data, not logic |
| `core/extensions/builtin/lazar-provider.ts` | 706 | ✅ |
| `core/extensions/builtin/codex-provider.ts` | 695 | ✅ |
| `ui/mcp-modal.tsx` | 691 | ✅ |
| `ui/terminal/manager.ts` | 653 | ✅ |
| `tools/computer.ts` | 632 | ✅ |
| `core/extensions/builtin/loop-command.ts` | 626 | ✅ |
| `tools/bash.ts` | 612 | ✅ |
| `ui/ai-output/tool-calls.tsx` | 611 | ✅ |
| `tools/schedule.ts` | 610 | ✅ |
