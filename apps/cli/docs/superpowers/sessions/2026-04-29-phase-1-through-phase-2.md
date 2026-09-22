# Session: Phase 1–4 + Phase 2 Steps 1–6 + Dreaming Passes

**Date:** 2026-04-29
**Scope:** Persona decomposition, kernel extensibility, tool migrations, UI polish
**Commits:** `5195c60` through `40d99e2` and Phase 2 steps

---

## Phase 1 + Phase 2 — Persona Bootstrap

- [x] Create SOUL / IDENTITY / TOOLS / HEARTBEAT / DREAMING / MEMORY files at project root
- [x] Update AGENTS.md with persona-layer reference + Memory/Heartbeat/Dreaming/Learning/Skill sections
- [x] Wire auto-load into `loadCustomInstructions` (instructions.ts)
- [x] Add unit tests for the new load order (6 new tests, all green)
- [x] Confirm `buildSystemPrompt` injects loaded instructions into system prompt
- [x] Smoke-test against real project files: all 7 segments load, ~16KB of context

## Phase 3a — Hook-based Loops

- [x] Install SessionStart / UserPromptSubmit / SessionEnd hooks in `~/.claude/user-settings.json`
- [x] Add turn-counter nudging MEMORY every ~8 substantive turns
- [x] End-to-end smoke test all three hooks via `execCommandHook`

## Phase 3b — Deeper Integration

- [x] Add `.agent-memory/.turn-counter` to `.gitignore`
- [x] Wire `agent.ts` to consume `additionalContexts` from hook results
- [x] Define DREAMING trigger (manual `/dream`, 24-turn nudge, SessionEnd reminder)
- [x] Build `/dream` slash-command
- [x] Test skill-creation pipeline end-to-end — `update-heartbeat` skill scaffolded
- [x] Decide where USER.md lives — global (`~/.grok/USER.md`)

## Phase 4a — Commands Capability (Workflow Prompts)

- [x] Add `services.chat.dispatch` and `services.workspace.cwd()` to `ExtensionHostServices`
- [x] Add `setChatSink` / `setCwdProvider` to loader
- [x] Create `builtin.commands.workflows` extension
- [x] Wire kernel sinks in `app.tsx`; replace 5 inline handlers with generic dispatch
- [x] Add 4 new tests in `loader.test.ts`

## Phase 4b — `/skills` Listing

- [x] Add `services.chat.appendAssistant` to `ExtensionHostServices`
- [x] Create `builtin.commands.skills` extension
- [x] Wire `kernelSetAssistantSink` in `app.tsx`
- [x] Add 3 new tests in `loader.test.ts`

## Phase 4c — Custom Subagent Commands

- [x] Add `RegisteredCommandResolver` interface + `registerCommandResolver` hook
- [x] Build resolver registry in `loader.ts`
- [x] Create `builtin.commands.subagents` extension
- [x] Refactor `dispatchExtensionCommand` in `app.tsx`
- [x] Add 7 new tests in `loader.test.ts` — 326/326 pass

## Phase 4d — Cluster B Host UI Actions

- [x] `services.ui.action(payload: HostAction)` host service
- [x] `builtin.commands.host-actions` registers 17 slash commands (33 names with aliases)
- [x] `handleCommand` cyclomatic count dropped from ~26 to ~5
- [x] `handleSlashMenuSelect` routes through `dispatchExtensionCommand`

## Phase 2 #1+#2 — Kernel-owned Tools (grep, lsp)

- [x] `grep` migrated to `builtin.tools.grep`
- [x] `lsp` migrated to `builtin.tools.lsp` — behaviour change: tool visible with friendly error when disabled

## Phase 2 #3 — Kernel-owned read_file + Mixed-mode Extension

- [x] `read_file` migrated to `builtin.tools.file`
- [x] Mixed-mode pattern proven: same extension mixes kernel-owned + metadata-only `registerTool` calls

## Phase 2 Step 2 — Wallet/Payments Self-contain

- [x] `services.session.id()` lazy getter shipped
- [x] `builtin.tools.payments` promoted to fully kernel-owned (4 tools)
- [x] 6 new tests in `payments-tools.test.ts`

## Phase 2 Step 3 — Telegram Self-contain

- [x] `services.telegram.sendFile` slot
- [x] `builtin.tools.telegram` kernel-owned extension (1 tool)
- [x] 6 new tests in `telegram-tools.test.ts`

## Phase 2 Step 5 — Subagents Callbacks

- [x] `services.subagents.{runTask,runDelegation,readDelegation,listDelegations}`
- [x] `builtin.tools.subagents` kernel-owned extension (4 tools)
- [x] Dynamic schema migration: zod enum → `z.string()`
- [x] 10 new tests in `subagents-tools.test.ts`

## Phase 2 Step 6 — Schedule Callbacks

- [x] `services.schedule.{create,list,remove,readLog,getDaemonStatus,startDaemon,stopDaemon}`
- [x] `builtin.tools.schedule` kernel-owned extension (7 tools)
- [x] 16 new tests in `schedule-tools.test.ts`

## UI Polish + Queue Send-now (2026-04-29)

- [x] Theme-aware mode color in `PromptModeLabel`
- [x] Chip darkening in `tool-calls.tsx`
- [x] Queue send-now bug fix + ↑ shortcut
- [x] Queue focus-mode (Tier 3) — out-of-order dispatch via cursor navigation
- [x] Tier 3 post-advisor refinements (Esc dual-fire, stale focusId, paste-while-focused)

## Biome Cleanup (2026-04-29)

- [x] `src/ui/**/*.tsx` a11y overrides in `biome.json`
- [x] Dead code removal in `app.tsx` (-264 lines)
- [x] Pre-commit hook re-engaged — 345/345 tests pass

## Upstream Fork Triage + MCP Wiring (2026-04-30)

- [x] `mcp: pre-flight stdio command existence check`
- [x] `mcp: discover resources and prompts per server` → made lazy
- [x] `mcp: add spec-compliant fixture server + integration test`
- [x] `mcp-modal: surface tools/resources/prompts counts per server`

## Dreaming Passes (2026-04-29)

Three DREAMING passes covering Phase 4d, kernel-extensibility audit, and Phase 2 #1-#3 retrospective. Key lessons:
- Subagent-driven plan execution at scale works with hard scope constraints
- Anchor by string, never by line number
- `useCallback` chains care about insertion order
- Pure-algorithm extraction (`*-collation.ts`) pattern
- Hook-nudge writes are commit noise → route to scratch file
- Kernel-owned tool migration is a stable recipe (3x rule hit)
- Mixed-mode extension is canonical for partial migrations
