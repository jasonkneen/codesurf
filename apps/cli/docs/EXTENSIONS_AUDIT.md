# CodeSurf CLI — Extension Audit

> **Status update (2026-06-22):** Most critical items below are now **FIXED**.
> See `docs/CODE_REVIEW_2026-06-22.md` for the current-state review and the
> follow-up refactor branch (`refactor/code-review-2026-06`). Resolved items:
> lightclaw hardcoded key ✅ · xai-tools cwd ✅ · helpers.ts dead code deleted ✅
> · file-tools hooks (wrapExecute) ✅ · voice disposer leak ✅ ·
> formatHistoryAsPreface dedup ✅ · computer-tools collapse ✅ ·
> footer-chrome merge ✅ · SDK wrapExecute/safeExecute/registerPromptCommand/
> registerToggleableIndicator/onDispose/onProcessExit ✅ · ProviderConnectionContext.services ✅
> · provider-session disposal on disable ✅ · secret setting type hardening ✅
> · AbortSignal plumbing (grep/telegram) ✅ · hermes-config extraction ✅ ·
> sinks.ts extraction ✅.
> **Still open:** AbortSignal through bash sink cleanup edge cases; deeper
> app.tsx / Agent god-class decomposition (needs interactive TUI test harness).

---

**Scope:** every builtin extension under `src/core/extensions/builtin/` against the SDK in `src/core/extensions/`.
**Date:** 2026-05-26
**Method:** four parallel subagent audits, one per extension group (providers, tools, commands, UI/indicator).

---

## Executive summary

The kernel itself (`api.ts`, `loader.ts`, `event-bus.ts`, `registry.ts`, `model-runtime.ts`) is well-shaped. The SDK is documented thoroughly, with a clean public barrel (`index.ts`) and an explicit "builtin-only" posture for sinks like `services.bash` / `services.hooks` / `services.events`.

The **extensions, however, only use a fraction of what the SDK exposes**:

- **Hooks are dead code outside `bash-tools.ts`.** Eleven other tool surfaces (file write, file edit, computer, schedule, subagents, telegram, payments, lsp, grep, xai search, xai image) skip `services.hooks.runPre/runPost/runFailure` entirely. The single biggest posture gap.
- **Events are used by exactly one extension (`pets`).** Auto-mode, voice, schedule-tools, knowledge — all candidates — don't subscribe.
- **Several extensions reach around the SDK** into loader internals (`setBashSink`, `setMcpToolBundleProvider`, `setIconResolver`) or directly into `src/ui/*` / `src/utils/settings`. The SDK has no formal "kernel sink binding" surface.
- **Significant duplication** across providers (3 sources of truth for Anthropic models, 3 SSE consumers, 2 verbatim copies of `formatHistoryAsPreface`), across tool extensions (12× identical computer-tool blocks, 7× identical try/catch shapes in schedule), and across UI screens (4× verbatim overlay chrome).
- **One real security smell** in `lightclaw-provider.ts:49,51` — a hardcoded 64-char hex string shipped as the default API key and a LAN-IP default base URL.

The path forward is a small set of SDK additions that unlock systematic cleanups: a hook-wrapping helper, a sink-binding API, several `registerXxxCommand` shortcuts, a shared theme/overlay surface, and a couple of new event types.

---

## 1. SDK compliance — per extension

Legend: **PASS** = idiomatic, **WARN** = works but bypasses the SDK or has real defects, **FAIL** = wrong / unsafe / dead.

### Providers (`builtin/`)
| Extension | Status | Headline issue |
|---|---|---|
| `xai-provider.ts` | PASS | Clean; effectively core (hard-referenced by `model-runtime.ts:101`). |
| `anthropic-provider.ts` | PASS | Anthropic model catalog duplicated 3× across providers. |
| `claude-agent-provider.ts` | PASS | Imports `getHostServices` from `../loader` (`:66`); session-cache leak on disable. |
| `claude-grok-skills-provider.ts` | WARN | Sibling-imports a private class from claude-agent-provider; ~440 LOC of duplication. |
| `codesurf-desktop-provider.ts` | PASS | 140-line hardcoded MODELS bootstrap; abort signal not threaded into initial POST. |
| `hermes-gateway-provider.ts` | WARN | 1444 LOC, 800 of which are config parsing; missing `files: "read"` permission. |
| `lazar-provider.ts` | PASS | `formatHistoryAsPreface` is a verbatim copy of claude-agent-provider's. |
| `lightclaw-provider.ts` | **FAIL** | **Hardcoded 64-char hex default API key** at `:51`; LAN IP `192.168.4.104:8888` as default base URL at `:49`; `checkCredential` returns `ok:true` by default for every user. |

### Tools (`builtin/`)
| Extension | Status | Headline issue |
|---|---|---|
| `file-tools.ts` | WARN | `read_file`/`write_file`/`edit_file` skip hooks entirely (`:62,93,123`). |
| `file-tools-approval.ts` | PASS | Pure helper; `try/catch` silently auto-approves on settings-read error (`:36-41`). |
| `grep-tool.ts` | PASS | No abort signal forwarded to ripgrep; runaway is uninterruptible. |
| `lsp-tool.ts` | PASS | `line`/`character` schema not discriminated by `operation`; no abort forwarding. |
| `computer-tools.ts` | PASS | 12 verbatim `execute` blocks; **declares no permissions** despite spawning processes. |
| `xai-tools.ts` | WARN | `getHostServices().bash.cwd()` at `:166,213` — throws in headless; should be `services.workspace.cwd()`. |
| `schedule-tools.ts` | PASS | Exemplary sink-bridge pattern; try/catch duplicated 7×. |
| `subagents-tools.ts` | PASS | Correct bridge; `task`/`delegate` should fire hooks (recursive agent invocation). |
| `telegram-tools.ts` | PASS | Path concatenation not `path.resolve`; no `permissions: { network, files }`. |
| `payments-tools.ts` | WARN | `paid_request` (crypto spend) lacks `modes: ["agent"]` gate at `:165`. |
| `plan-tools.ts` | PASS | Smuggles UI side-channel via `result.plan`; no typed contract. |
| `helpers.ts` | **FAIL (dead)** | `defineToolGroupExtension` has zero callers — Phase-2 orphan; delete. |

### Command / UI-command (`builtin/`)
| Extension | Status | Headline issue |
|---|---|---|
| `workflow-prompts.ts` | PASS | 5 commands, each a 7-line dispatch shim; large inline prompt strings. |
| `skills-listing.ts` | PASS | Reads `process.stdout.columns` directly; no terminal-size service. |
| `editor-command.tsx` | PASS | Direct imports of `TextEditor`, `getTheme`, `loadUserSettings`; `useKeyboard` bypasses interceptor chain. |
| `files-command.tsx` | PASS | Sync `readdirSync`/`readFileSync`; same UI/theme bypass. |
| `steer-command.tsx` | PASS | Persists scope/risk/verify selections via `services.settings`; projected into the system prompt by `loadCustomInstructions`. `enabledByDefault: true`. Richer behavioural wiring (e.g. risk→approval gating) still deferred. |
| `subagent-commands.ts` | PASS | Hard-coded `UI_RESERVED_SLASH_COMMANDS` shadow (`:24-65`) — will rot when commands change. |
| `mcp-prompt-commands.ts` | WARN | Filename misleading; mixes resolver+sink-binding+modal; reaches `setMcpToolBundleProvider` via `../loader`. |
| `pets-explainer.tsx` | PASS | 200+ lines of ASCII doc strings inline; `.tsx` with zero JSX. |
| `host-actions.ts` | PASS | Mode/adapter filtering lives in `app.tsx` (`:188-190`) — no `RegisteredCommand.visible?` predicate. |
| `doc-viewer.tsx` | PASS | Body truncates instead of scrolling (`:122`); `builtin.ui.*` namespace inconsistent with `builtin.commands.*`. |
| `knowledge-extensions.ts` | WARN | Manifest missing `"settings"` capability; `"mentions"` not in enum; module-level Maps leak on disable. |

### UI / indicator / special (`builtin/`)
| Extension | Status | Headline issue |
|---|---|---|
| `pets/` + `pets.tsx` | PASS | `tuiPet` persisted via `loadUserSettings` instead of `registerSetting`; process-exit hooks leak across reloads. |
| `context-bar/` | PASS | Same 3-boolean-toggle boilerplate as resource-counter. |
| `resource-counter/` | WARN | Uses React `useExtensions/useCommands/useTools` hooks instead of `services.*.list()`. |
| `nerd-icons.ts` | WARN | Imports kernel-internal `setIconResolver` from `../icons`; no `services.icons.register`. |
| `voice/` | WARN | **`registerStatusIndicator` disposer dropped at `:135`**; imports `GrokSttEngine` directly; no Stop subscription so recording survives an aborted turn. |
| `auto-mode.ts` | PASS | Doesn't subscribe to `Stop` for safety net; loop stalls silently if model omits `auto_status`. |

---

## 2. Hooks & events usage

### `services.hooks` (PreToolUse / PostToolUse / PostToolUseFailure)

Only **`bash-tools.ts:143-167`** uses the full `runPre → block check → runPost/runFailure` ceremony. Every other write-side or external-side-effect tool skips hooks:

| Tool | File:line | Risk |
|---|---|---|
| `write_file` | `file-tools.ts:93` | High — formatter-on-write / denylist hooks bypassed |
| `edit_file` | `file-tools.ts:123` | High — same |
| `read_file` | `file-tools.ts:62` | Medium — secrets-dir denylist bypassed |
| `computer_*` (12) | `computer-tools.ts:86-321` | High — GUI automation can do anything |
| `task` / `delegate` | `subagents-tools.ts:107,130` | High — recursive agent invocation bypasses rate-limit hooks |
| `paid_request` | `payments-tools.ts:181` | **High — crypto spend with no audit hook** |
| `schedule_create` | `schedule-tools.ts:73` | Medium — spawns headless runs |
| `telegram_send_file` | `telegram-tools.ts:59` | Medium — file egress |
| `search_web` / `search_x` | `xai-tools.ts:118,133` | Medium — egress audit |
| `generate_image` / `generate_video` | `xai-tools.ts:163,210` | Medium |
| `grep` / `lsp` | `grep-tool.ts:54`, `lsp-tool.ts:80` | Low |

**Root cause:** the hook ceremony is 20 lines per tool. Nobody hand-rolls it. The fix is an SDK helper — see §5.

### `services.events` (in-process event bus)

Subscribers found across all 30+ extensions:

| Extension | Subscribes to |
|---|---|
| `pets.tsx:194-211` | SessionStart, UserPromptSubmit, PostToolUseFailure, Stop, StopFailure |

**That's it.** Strong candidates that don't subscribe and should:
- `auto-mode.ts` → `Stop` for safety-net termination when model omits `auto_status`.
- `voice/index.ts` → `Stop` to cancel in-flight recording; `SessionEnd` to reset state.
- `knowledge-extensions.ts` → `SessionStart` to pre-warm index; `Stop` to compact semantic indices.
- `claude-agent-provider.ts` → `Stop` for symmetric `query.interrupt()`.
- `schedule-tools.ts` → not strictly needed (sinks handle it).

### `services.input.intercept`

Used correctly by `voice/ptt-handler.ts`. Used **incorrectly** (i.e. bypassed) by every screen extension — `editor-command.tsx:36`, `files-command.tsx:33`, `steer-command.tsx`, `doc-viewer.tsx` — all reach for `@opentui/react`'s `useKeyboard` directly.

---

## 3. Validity / merge / promote-to-core

### Merge candidates

1. **`context-bar/` + `resource-counter/` → `builtin.footer-chrome`.** Same shape, symmetric `mode-line` / `mode-line-left` placements, identical 3-boolean toggle pattern. ~150 LOC saved.
2. **`workflow-prompts.ts` + `skills-listing.ts` + knowledge's `/learn` + `/self-correct` → `builtin.commands.host-prompts`.** All are zero-state dispatch-or-append commands. ~7 commands collapse into one ~150-LOC extension.
3. **`editor-command.tsx` + `files-command.tsx` → `builtin.commands.file-views`.** Both file-oriented, both wrap one ai-output component, both share overlay chrome.
4. **`claude-grok-skills-provider.ts` → into `claude-agent-provider.ts` as a "skills-isolated" mode.** Eliminates ~440 lines of duplication: shared model catalog, settings registration, session class, sibling-import.
5. **Anthropic model catalog** centralized: `claude-agent-provider.ts:156-184` and `anthropic-provider.ts:38-78` share the same model IDs/aliases/context windows — single source feeding both adapters.

### Promote-to-core

1. **`xai-provider.ts`** — already `protected:true`; `model-runtime.ts:101` hard-references `xai.default`. Acknowledge it's effectively core.
2. **`nerd-icons.ts` CATALOG** — move the 70-entry glyph map into `src/core/extensions/icons-nerd-fonts.ts`. Keep a thin extension for the on/off toggle, or replace the monkey-patch with a real `api.registerIcons(map)` contribution surface.
3. **`/help` slash command** — currently in `host-actions.ts:150`; should always be reachable. Either keep `host-actions` protected (it is) or register `/help` directly in the loader.

### Defunct / questionable

1. **`lightclaw-provider.ts`** — likely defunct (LAN-IP default, hardcoded key). Either delete or rewrite with empty defaults.
2. **`steer-command.tsx`** — ✅ resolved. Selections now persist via `services.settings.set` (`steer.scope/risk/verify`) and are projected into the system prompt (`src/core/persistence/steering.ts`); enabled by default. Remaining follow-up: map prefs to concrete behaviour (e.g. risk→tool-approval policy) beyond prompt text.
3. **`helpers.ts`** — Phase-2 orphan, zero call sites. Delete.

---

## 4. Refactor wins (ranked by impact)

| # | Win | Files | Impact |
|---|---|---|---|
| 1 | Add `services.hooks.wrapExecute(toolName, fn)` and wrap every write-side tool | 11 tool extensions | **Biggest security posture improvement.** Lifts ~20 LOC per tool and actually wires PreToolUse hooks. |
| 2 | Fix `lightclaw-provider.ts:49,51` — drop hardcoded API key + LAN-IP defaults | 1 file | Security smell. |
| 3 | Fix `xai-tools.ts:166,213` to use `services.workspace.cwd()` | 1 file | Prevents exception in headless contexts. |
| 4 | Fix `voice/index.ts:135` disposer leak — capture `registerStatusIndicator` return | 1 file | One-line bug fix. |
| 5 | Delete `helpers.ts` | 1 file | Dead code. |
| 6 | Add `modes: ["agent"]` to `payments-tools.ts:165` `paid_request` | 1 line | Hardening. |
| 7 | Delete `UI_RESERVED_SLASH_COMMANDS` in `subagent-commands.ts:24-65`; use `services.commands.list()` at resolve time | 1 file | Eliminates rot-prone shadow list. |
| 8 | Extract `formatHistoryAsPreface` into a shared util | `lazar-provider.ts` + `claude-agent-provider.ts` | ~100 lines of byte-for-byte duplication. |
| 9 | Extract shared OpenAI-SSE consumer | 3 providers | ~200 lines across hermes/lightclaw/codesurf-desktop. |
| 10 | Merge `claude-grok-skills-provider` into `claude-agent-provider` as a mode | 2 files | ~440 lines. |
| 11 | Collapse `computer-tools.ts` via local `registerComputerTool` helper | 1 file | 323 → ~120 LOC. |
| 12 | Plumb `AbortSignal` through `tools/file.ts`, `tools/grep.ts`, `lsp/runtime.ts` | 3 modules | Makes `Stop` actually stop these tools. |
| 13 | Extract shared `<ScreenOverlay>` + `useHostTheme()` | 4 screen extensions | ~80 lines and consistent chrome. |
| 14 | Add `api.registerPromptCommand({name, prompt})` helper | ~9 call sites | Workflow-prompts (124 LOC → ~50). |
| 15 | Move large prompt/doc strings to `assets/*.md` | workflow-prompts.ts, pets-explainer.tsx | Treat content as content. |
| 16 | Add `api.onDispose` cleanup to `knowledge-extensions.ts` | 1 file | Maps leak on disable cycles. |
| 17 | Declare `permissions` on tool extensions | computer/telegram/payments | Lays groundwork for the Phase-8 permission model the SDK already gestures at. |

---

## 5. SDK additions / changes

These are the SDK gaps that block the refactor wins above. Listed in rough priority order.

### Critical (unblocks security posture work)

1. **`services.hooks.wrapExecute(toolName, fn)`** — `api.ts`. Today the 20-line PreToolUse/PostToolUse/runFailure ceremony from `bash-tools.ts:143-167` is reimplemented zero times because it's too much boilerplate. With this helper, every tool becomes one line of opt-in.
2. **`services.tools.safeExecute({label, fn})`** — collapses the try/catch-to-ToolResult shape duplicated 7× in `schedule-tools.ts`, 4× in `payments-tools.ts`, 2× in `xai-tools.ts`.
3. **`AbortSignal` on sink methods** — `TelegramSink.sendFile`, `services.bash.cleanup`, `executeGrep`, `readFile/writeFile/editFile`, `queryLsp`. Without it, `Stop` can't actually cancel work.
4. **`api.bindKernelSink({mcp, bash, subagents, ...})` (formal sink-binding surface)** — replaces `import { setBashSink } from "../loader"` in `bash-tools.ts:58`, `import { setMcpToolBundleProvider } from "../loader"` in `mcp-prompt-commands.ts:30`, and `import { setIconResolver } from "../icons"` in `nerd-icons.ts:18`. Today every builtin that needs to bind a sink reaches around the SDK.

### Compliance / correctness

5. **`ProviderConnectionContext.services: ExtensionHostServices`** — replaces the bare `settings` field at `api.ts:329`. Today `claude-agent-provider.ts:66` imports `getHostServices` from loader because `ctx` doesn't expose `services.mcp.isEnabled()`.
6. **Provider-disabled lifecycle** — `model-runtime.ts` session cache holds `ProviderSession` references whose `disconnect()` is never called when an extension is disabled. Either auto-dispose on `unregisterExtensionContributions`, or expose a `ProviderShutdown` event.
7. **`RegisteredCommand.visible?: (services) => boolean` (or `requires?: string[]`)** — replaces the "filtered in app.tsx when adapter ≠ anthropic.agent-sdk" pattern at `host-actions.ts:188-190` and kills `subagent-commands.ts`'s hard-coded reserved-name list.
8. **`RegisteredCommandResolver.resolve(input, services)`** — `api.ts:206`. Resolvers can't see the registry today, so they shadow-list commands.
9. **`"mentions"` capability** added to the `ExtensionCapability` enum at `manifest.ts:11`. `knowledge-extensions.ts:321-325` registers an undeclared contribution.
10. **`RegisteredSetting.type: "secret"`** — host enforces empty default; would catch `lightclaw-provider.ts:51`.

### Quality of life (collapses boilerplate)

11. **`api.registerPromptCommand({name, description, prompt | promptBuilder(ctx)})`** — eliminates the 7-line shim used 9+ times in workflow-prompts + knowledge.
12. **`api.registerListingCommand({name, render})`** — for `appendAssistant`-only listings (`/skills`, `/help`).
13. **`api.registerDocCommand({name, doc: DocViewerProps})`** — combines `registerCommand` + screen open.
14. **`api.registerTools([{...}])`** plural form — collapses `computer-tools.ts` and `schedule-tools.ts`.
15. **`api.registerToggleableIndicator({id, placement, command, settings, render})`** — eliminates the 3-boolean-toggle pattern in context-bar + resource-counter.
16. **`api.registerSettingGroup({keyPrefix, flags})`** — shorthand for the same.
17. **`services.ui.theme()` + `useHostTheme()`** — eliminates the direct `src/ui/themes/catalog` imports in editor/files/steer/doc-viewer.
18. **`services.ui.terminalSize()`** — `skills-listing.ts:38` reads `process.stdout.columns` directly.
19. **`services.ui.screens.list()`** — `pets-explainer.tsx:14` cross-imports `DOC_VIEWER_SCREEN_ID` from a sibling extension; should be data lookup.
20. **`services.input.useKeyboard(handler)`** — host-provided React hook that flows through the interceptor chain (today the four screens use `@opentui/react`'s `useKeyboard` directly, bypassing `services.input.intercept`).

### Architecture-level

21. **`services.icons.register(name, glyph)` + `services.icons.resolve(name)`** — first-class icon contribution. Replaces nerd-icons' kernel-internal monkey-patch.
22. **`createExtensionStore<T>(initial)`** — shared subscribable store used by voice/state.ts, auto-mode indicator pub-sub, pets renderer.
23. **`api.onProcessExit(cb)`** — aggregated exit handler used by `pets/renderer.ts:102-120` (which currently leaks `process.once` handlers across reloads).
24. **`api.registerCanvasOverlay({render: stdout => string})`** — formalises the "draw outside the React tree, restore cursor" pattern in `pets/protocol.ts`.
25. **`services.agent.queuePrompt({prompt, displayText})`** — agent-level prompt injection separate from the UI-oriented `services.chat.dispatch`. Used by auto-mode.
26. **`services.stt.transcribe(audioPath, language)`** — DI slot for STT engines so voice doesn't hard-import `GrokSttEngine`.

---

## 6. Recommended sequence

If executing in order, the highest-value sequence is:

1. **Security/correctness one-liners first** — lightclaw defaults, xai-tools cwd source, voice disposer leak, `paid_request` mode gate, delete helpers.ts.
2. **SDK additions #1, #2, #4** (hooks wrapper, safeExecute, bindKernelSink). These unlock everything else.
3. **Wire hooks into every write-side tool** using the new `wrapExecute`. Biggest posture improvement.
4. **Merge claude-grok-skills into claude-agent-provider** and centralize Anthropic model catalog.
5. **Extract `formatHistoryAsPreface` and the OpenAI-SSE consumer** to shared utils.
6. **Add `<ScreenOverlay>` + `useHostTheme()` SDK helpers**, then convert the four screen extensions.
7. **Add `registerPromptCommand` / `registerListingCommand` / `registerDocCommand`**, then collapse workflow-prompts and absorb pets-explainer / `/learn` / `/self-correct`.
8. **Merge context-bar + resource-counter into footer-chrome** once `registerToggleableIndicator` exists.
9. **Plumb AbortSignal through file/grep/lsp/telegram sinks**.
10. **Decide steer-command's fate** and either remove or wire to `services.settings.set`.
11. **Declare permissions on every tool manifest** as preparation for the Phase-8 permission model.

---

## Appendix — full extension count by group

- **Providers (8):** xai, anthropic, claude-agent, claude-grok-skills, codesurf-desktop, hermes-gateway, lazar, lightclaw
- **Tools (12):** bash, file (+approval), grep, lsp, computer, xai-tools, schedule, subagents, telegram, payments, plan (+ orphaned helpers.ts)
- **Commands (11):** workflow-prompts, skills-listing, editor, files, steer, subagent-commands, mcp-prompt-commands, pets-explainer, host-actions, doc-viewer, knowledge-extensions
- **UI/indicator (6):** pets, context-bar, resource-counter, nerd-icons, voice, auto-mode

**Total: 37 builtin extensions.**
