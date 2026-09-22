# HEARTBEAT

Scheduled check-ins and pending agent maintenance items.

## Conventions

- Read at session start.
- Tick off completed items.
- Add new check-ins as they're identified.
- Update `Last check-in` timestamp on every pass.
- Keep entries ≤150 words; long retrospectives go to `docs/superpowers/sessions/YYYY-MM-DD-topic.md`.

## State

**Last check-in:** 2026-09-22
**Status:** DREAMING pass only (idle-time consolidation; no new work this session). Since 2026-09-17: web P2–P4 landed (composer DOM adapter, curated live front, node GET /files + HostFiles boundary, fs/child_process/crypto stubs), then a 14-commit turn-engine harness-review sweep (2026-09-22) — 12 independent `fix(agent)` commits to transcript/approval lifecycle, followed by two same-day "fix the fixes" commits (`9d09360` repairing 3 interactions between the 12, `1ee6dd0` closing 3 further concerns including a mis-diagnosed "pre-existing/env" `codesurf-desktop-provider` suite that was actually a broken health-check stub — full suite now 98s/0 failures, was 192s). `2364397` fixed codesurf-web daemon connection's missing `workspaceId`. Full lesson detail in MEMORY.md "Turn-engine harness review sweep" entry.
**Status (prior):** phase3/hub pushed through `5fcd16e`. P4: node GET /files + HostFiles boundary + web `<img>` inline-image (bun:ffi bypassed via vite alias).
**Status (prior):** Phase 2/3/4 relay-mesh + TUI work on push (phase3/hub). New this session:
runtime-mode indicator (`--connect`, `· serverless`/`· wire` badge, boot banner);
abandoned-state reaping (session idle/max TTL + onEvict, finished-job + trace reaping,
`codesurf node` 30s auto-reaper disposing evicted Agents) — the fix class the buddy-
system audit flagged (32 abandoned MCP sessions → 503); tool-chip shortener
(BUDDY.* → BUDDY, COMMAND → RUN) now **config-driven** (UserSettings.chipAliases /
chipOrgHeads) with createChipShortener pure builder. Relay suite 37/37, UI 274 pass,
typecheck/build clean, all pushed (23f00da–4422236). Next: wire TUI as a real front
to a codesurf node (session_message live streaming over WS) so `--connect` routes
turns remotely (mode 2); Phase 4 fleet versioning + pooled-inference ceilings;
persist node state across restart. PTC testable via CODESURF_TOOL_PRESENTATION=code|both.
**Status:** CodeSurf review campaign implementation complete (Spark was unavailable; implementation ran in Claude Code). All findings from the eight 2026-09-05 review reports are now repaired or explicitly recorded as partial with their remaining work, each carrying the review's stated regression test: agent A1–A14, tools/LSP T1–T14, daemon D1–D5, UI1–UI3, storage/hooks SH1–SH2, networking NET-1–NET-6, all eleven provider/transport findings, indexing I1–I5, verification V1–V3, S1, plus the plan's P1 disposal-ordering and P2 npm-cache rows. Typecheck/build/lint pass; 1,730 Vitest across 213 files, 30 Bun, 11 daemon-package tests; `git diff --check` clean; built CLI renders. Uncommitted (184 changed files). Cordis Phase 1 is unblocked: `@deepseek-ai/cordis@4.0.2` installs and an executed tooling spike settles the build/resolution/semantics questions (`docs/recommendations/2026-09-05-codesurf-cordis-spike-evidence.md`). Remaining: the 48 plugin conversions, package boundaries, god-file extraction, performance measurement.

### 2026-09-09 — mode-2 live streaming landed (d743584)
SessionStreamServer/Client over an op:"session" WS channel; relay hub bails on session frames; engine-node mounts it; `codesurf --connect ws://<node> --prompt "..."` routes headless turns to a node and streams chunks back — LIVE-proven on 127.0.0.1:3949 (sess-1 → MODE2-LIVE-OK). Relay suite 39/39. NOW DONE: useTurnEngine(agent, remoteFront) drives turns over the wire via createRemoteSessionTurn; --connect boots the TUI attached (fallback to local if unreachable). Relay 40/40, UI 274/274, typecheck 0, build clean, pushed.
## Done (Claude yolo / don't-ask actually skip prompts — 2026-08-20)

- [x] **Always-approve / yolo works mid-session.** `canUseTool` auto-allows under `bypassPermissions` and `dontAsk` instead of re-opening PermissionPrompt. Sessions always start with `allowDangerouslySkipPermissions` so `/permissions yolo` can `setPermissionMode` live. `/permissions yolo` and `always-approve` are aliases. 119 vitest + 8 bun tests green.

## Done (review implementation - 2026-07-09)

- [x] **Turn cancellation is neutral and resource-safe.** Direct, batch, and provider-owned turns now discard uncommitted input, record `cancelled` traces without failure learning/hooks, and close child Bash resources. Provider aborts win the final stream-to-transcript boundary.
- [x] **Extension contracts are enforceable.** Registrations require declared capabilities, names/aliases are collision-safe, provider teardown is awaited before re-enable, and manifest permissions describe actual process use without claiming an in-process sandbox.
- [x] **TUI hot paths are bounded.** Live assistant cleanup keeps an append-only prefix plus small tail, Markdown/reasoning streams incrementally, typeahead is event-driven, and background delegation polling is adaptive.

## Done (`/ask` demo command removed - 2026-06-21)

- [x] **Removed the `/ask` slash-command demo path.** The QuestionnaireTabs demo command is gone from host actions and app routing. Structured-question UI remains available only through model/provider-driven questionnaire events.

## Done (model picker effort controls - 2026-06-21)

- [x] **Effort controls surface for adapter-backed providers.** `/models` rows now carry effort options from registered `<adapterId>.effort` select settings, so Codex/Claude-style provider rows can show and update the effort value in place. Grok keeps its existing per-model user setting path.

## Done (logical extension/provider/model grouping - 2026-06-21)

- [x] **Extensions can be grouped as logical packages.** Existing manifest `group` metadata remains authoritative, and ungrouped built-in extensions now infer stable groups such as Core Extensions, Workflows & Agents, Interface, and Tools & Commands.
- [x] **Providers/models now render hierarchically.** The model picker builds adapter-aware provider groups, then model-family groups, then concrete model rows; duplicate model IDs still preserve the selected adapter.

## Done (voice PTT space-tap flash - 2026-06-21)

- [x] **Space taps no longer flash voice warmup.** `createPttHandler` keeps the first two bare-key warmup presses invisible to status callbacks while allowing them through to the textarea. Visible warmup starts only once rapid repeats are being swallowed as a likely hold.

## Done (Hermes streaming + follow-up chips - 2026-06-21)

- [x] **Hermes tool/text streaming stabilized.** Shared OpenAI SSE deltas are split at readable boundaries when providers send clumps; Hermes tool progress accepts camelCase/snake_case ids and running/started/completed/finished variants; UI yields between immediate tool-call/tool-result events so transient live tool chips can render.
- [x] **Follow-up chips made answer-specific.** The system prompt asks for a hidden `codesurf-followups` JSON marker, live assistant rendering parses and strips it, persisted transcript rebuilds strip it while preserving suggestions, and local heuristics no longer show generic fallback chips for plain paragraphs.

## Done (message file links - 2026-06-21)

- [x] **Message file links open the file navigator.** `Markdown` now detects normalized local `file://` links, message/tool renderers pass an `onOpenFileLink` handler, and `app.tsx` opens `screen.files` at the requested path and line. `/files` shares the exported navigator builder.

## Done (auto-mode extension + slash-menu UX — 2026-05-17)

- [x] **`builtin.auto-mode` extension shipped** at `src/core/extensions/builtin/auto-mode.ts`. Tool `auto_status`, 4 slash commands (`/auto`, `/auto-continue`, `/auto-stop`, `/auto-status`), status indicator, 18 tests.
- [x] **Slash-menu UX** — `/` only opens when composer is empty; Tab prefills; hint shows keybindings.
- [x] Session doc at `docs/superpowers/sessions/2026-05-17-auto-mode-and-slash-menu-ux.md`.

## Done (steering wired end-to-end — 2026-06-07)

- [x] **`/steer` shipped.** `enabledByDefault: true`; selections persist via `services.settings.set` (`steer.<id>` keys) and re-seed on open. New `src/core/persistence/steering.ts` owns the dimension catalog + prompt projection; `loadCustomInstructions` injects the steering block into the system prompt. Tests in `steering.test.ts` + `instructions.test.ts`. Only deferral left: richer behavioural wiring (e.g. `risk=Low` gating tool-approval policy).

## Done (extension grouping + Pi + self-learning sweep — 2026-06-21)

- [x] **Grouped extension SDK/UI shipped.** `ExtensionManifest.group` and `ExtensionListEntry.group` allow meta/grouped extension packages. Builtin model providers now sit under `codesurf.providers`; the extensions modal renders collapsible group rows, right/left expansion, search auto-expansion, and group bulk enable/disable for non-protected members.
- [x] **Pi provider added defensively.** `builtin.provider-pi` is disabled by default, uses secret settings/env (`PI_API_KEY` / `INFLECTION_API_KEY`), dynamically discovers OpenAI-compatible `/models`, supports a user-configured model id, and does not bake in unverified Pi model identifiers.
- [x] **Self-learning loop extended.** Dev mode appends redacted/truncated conversation logs under CodeSurf home; normal mode periodically refreshes mined skill overlays and prompt-learning notes from successful/failed traces, then injects those notes into `buildSystemPrompt`.
- [x] **Repo hygiene pass.** Full `bun run lint` now passes. Broader Vitest passed with `.worktrees/**` excluded (`136 files / 1038 tests`); `bun run test:bun` passed (`22 tests`). External daemon TS5097 remains the only typecheck/build blocker.

## Done (model picker adapter identity — 2026-06-21)

- [x] **Duplicate model ids now preserve adapter selection.** `defaultModelAdapterId` / `modelAdapterId` persist the chosen adapter, `Agent` carries it into runtime resolution, and the `/models` modal compares current rows by `(model id, adapter id)` so API-key and Agent-SDK rows no longer both show selected.

## Done (footer width/layout repair — 2026-06-21)

- [x] **Claude-code footer no longer lets hints crush status chips.** The bottom chrome now has an overflow-clipped left lane and bounded right status lane; processing hints use compact key labels and permission mode drops redundant `perm` text when an icon is present.

## Done (historical — April 2026)

All Phase 1–4 persona/bootstrap work, Phase 2 kernel-owned tool migrations (grep, lsp, file, payments, telegram, subagents, schedule), UI polish, biome cleanup, upstream triage, and MCP wiring are documented in:

`docs/superpowers/sessions/2026-04-29-phase-1-through-phase-2.md`

## Pending

- [ ] **Watch item (DREAMING 2026-09-22):** if a third review-driven fix sweep (≥5 commits to shared mutable state) produces a same-day "fix the fixes" follow-up, promote "interaction-check pass after batched fixes" from watch-item to a formal rule/skill. Two occurrences observed within the 2026-09-22 sweep itself; none yet across separate DREAMING passes.
- [ ] **Watch item (DREAMING 2026-09-22):** if a third stale "pre-existing/env" test verdict gets re-cited and later proven wrong, add a MEMORY convention requiring re-verification of verdicts older than N sessions before citing them. Two prior citations (2026-09-10 ×2) of the `codesurf-desktop-provider` suite as pre-existing/env were wrong; root cause (self-identifying health stub) found 2026-09-22.
- [x] **Commit progress-communication work** on `phase3/hub` — `ed25d3b` feat(tui): live status, per-round persistence, and turn summaries. Not pushed.
- [ ] **CodeSurf full review / Cordis migration.** Correctness repairs from the 2026-09-05 review landed (see `docs/recommendations/2026-09-05-codesurf-cordis-plan.md` → Current execution status). Remaining: the other report findings, all 48 native Cordis conversions (`@deepseek-ai/cordis@4.0.2` is on npm), package boundaries, performance measurement, live TUI validation, and a commit of the working tree.
- [ ] **REVIEW_23 critical #3 — shared turn setup.** Extract common turn prep/finalization across direct, batch, and provider-owned paths.
- [x] **External daemon package TS5097 build blocker.** Resolved 2026-06-23: vendored `@codesurf/daemon` into in-repo `packages/codesurf-daemon` as a bun workspace (`workspace:*`) and removed the `.ts` import extension in its `client.ts`. Plain `bun run typecheck` no longer hits TS5097; the remaining errors are unrelated pre-existing missing optional deps (`viem`, `@x402/*`, `@ai-sdk/provider`).
- [x] **REVIEW_23 critical #4 — extension activation lifecycle.** Fixed 2026-05-23.
- [x] **REVIEW_23 critical #5 — workspace-scoped session CRUD.** Fixed 2026-05-23.
- [ ] **REVIEW_23 state backlog — split large owners by responsibility.** `useAgentTurnController` / `useKernelSinks` / `useModalRegistry` for `app.tsx`; `TurnRunner` / `TranscriptWriter` / `HookRunner` for `agent.ts`.
- [ ] Verify SOUL/IDENTITY/TOOLS actually influence output style on next fresh session (qualitative check)
- [ ] Promote the persona pattern into a reusable skill (`persona-bootstrap`) once applied to a third agent.
- [ ] **Phase 2 #4+ — host-service surface design pass.** Provider-coupled tools (`search_web`, `search_x`, `generate_image`, `generate_video`) blocked on xai-provider extension migration.
- [ ] Cluster C migration (`/btw`, `/term`, `/term-modal`, `/ui`) — needs lifecycle-primitive design pass.
- [ ] Future: split `handleKey` (`src/ui/app.tsx`) into per-modal handlers and remove its `useExhaustiveDependencies` suppression.

- [ ] **Extensions Audit Cleanup (post 2026-05-26 audit)** — 85-90% of findings already addressed (hooks on all write tools, security one-liners, SDK foundation, major dedups, permissions). Only confirmed-open + unverified-tail items tracked here. Source-verify before touching. Grouped by unblocks-first.

  **Group 1 (cheap SDK surface additions — start here 2026-06-07)** (low risk, several unblock later groups):
  - [x] `RegisteredSetting.type: "secret"` in api.ts + host enforcement (empty default).
  - [x] `"mentions"` added to `ExtensionCapability` enum (manifest.ts) + declare on `knowledge-extensions`.
  - [ ] `RegisteredCommand.visible?: (services) => boolean` predicate (replaces app.tsx adapter filter + subagent shadow list).
  - [ ] `services.ui.terminalSize()` + migrate `skills-listing.ts:56` (process.stdout.columns).
  - [ ] `services.ui.screens.list()` + migrate `pets-explainer.tsx:14` cross-import of DOC_VIEWER_SCREEN_ID.
  - [x] `services.input.useKeyboard` host hook now shares the raw interceptor chain without double-dispatch.
  - [ ] `api.onProcessExit` (or keep guarded raw in pets/renderer if acceptable).
  - [ ] `registerListingCommand` / `registerDocCommand` shorthands (then collapse workflows + doc commands).

  **Group 2 (AbortSignal real plumbing)**:
  - [ ] Thread abort through `tools/file.ts`, `tools/grep.ts` (ripgrep), lsp runtime (signal is in ctx today but not forwarded to underlying ops).

  **Group 3 (dedup merges — biggest LOC wins, behavior-preserving, higher risk; do after Group 1 SDK)**:
  - [ ] Extract shared `<ScreenOverlay>` + `useHostTheme()`; convert editor/files/steer/doc-viewer (they already use the theme hook but duplicate chrome).
  - [ ] Merge `context-bar/` + `resource-counter/` → `builtin.footer-chrome`.
  - [ ] Collapse `computer-tools.ts` 12 registrations (local helper exists; finish the plural `registerTools` or equivalent).
  - [ ] Merge `claude-skills-provider` into `claude-agent-provider` as "skills-isolated" mode (~440 LOC; highest risk — live session logic; last).

  **Group 4 (hygiene / tail)**:
  - [ ] `knowledge-extensions.ts`: register `api.onDispose` to clear leaking module-level Maps.
  - [ ] Move large inline strings (`workflow-prompts.ts`, `pets-explainer.tsx`) to `assets/*.md` (or similar) and load at runtime.
  - [ ] Verify + action remaining tail from audit (OpenAI-SSE consumer already extracted; confirm others).


### 2026-09-10 — models forward-port + de-grok + PTC verification (complete)
- Model bumps landed: grok flagship 4.6 (4.3 retired alias), Claude fable-5-1 (sonnet-5/opus-5 current), Codex gpt-6-astra (§ b371388–4098675).
- Full de-grok (codesurf identity, not grok-cli): dropped ALL GROK_* env vars (CODESURF_* only), renamed claude-grok-skills→claude-skills provider (adapter id + persisted keys), reframed README/docs/branding, de-grokked UI strings. Legacy `grok-cli-` cardId prefix + src/grok provider kept deliberately (serve Grok 4.6). Commits b371388–88faf6a, c9486f7.
- PTC benchmarks: scripts/bench/ptc-vs-native.mjs + real rounds counter; live grok-4.3→4.6 numbers in docs/user/ptc.md.
- PTC (deepseek-harness) audit: 298 core + 7 e2e green on deepseek-v4-flash via local spark gw; qwen3.8-flash-next refused to emit tools (0 tool/call) → fails real-model PTC contract; not a harness bug ⸺ documented.
- Verdicts recorded: codesurf-desktop-provider 7 sendTurn failures are PRE-EXISTING/env (need live daemon; proven at baseline b371388~1); agent.ts is now Biome-clean (no --no-verify needed).
- Harness repo: dangling demo:code-mode script alias removed + committed locally; push blocked by pre-existing tsconfig.host.json:279 → packages/examples/jsonrpc-demo has no src/tsconfig (TS6053).

## Stubs / Placeholders / Incomplete surfaces (to address or explicitly own as "demo only")

When "stubs" (or "placeholder / incomplete") is mentioned, these are the current non-test, non-UI-prop, prod-path items with explicit "placeholder / not implemented / not wired" language or gated scaffolding that never became real.

- **Terminal graphics image preview (image-viewer.tsx:7,53,88)** — `renderPreview` prop is the explicit seam for Kitty/Sixel/iTerm2. Default path always renders the fallback ASCII + the literal string "(terminal graphics preview not wired; see renderPreview prop)". System `open` fallback works. This is honest future-platform work, not a bug.
- **Telegram `nativeDrafts` (settings.ts:85)** — Field exists in interface + load/save paths. Comment: `/** Reserved: Bot API `sendMessageDraft` for private DMs (not implemented yet). */`. No actual usage of the Bot API draft endpoint anywhere.
- **Several `enabledByDefault: false` builtins** (nerd-icons, lightclaw-provider, lazar-provider, hermes-gateway, codex-provider, codesurf-desktop-provider, claude-grok-skills-provider). Most are intentional opt-in/experimental (heavy daemons, alt providers). (Lightclaw audit note on hardcoded defaults retired — now empty strings per verification.)

(The dozens of `placeholder="..."` JSX props, test `vi.stub*` / `makeStubApi`, and historical "metadata-only stub during migration" comments are *not* on this list.)

## Notes for next agent picking this up

- **2026-09-17 progress communication** committed `ed25d3b`. Do not re-run the 11-task plan. Compact tool pills do not show duration (list/expand/status-line do). Unknown `-s` ids create a new session, which then becomes `latest`.
- `buildSystemPrompt` in `src/agent/agent.ts:336` runs **every user prompt**, so persona files are re-loaded each turn.
- `additionalContexts` from hook results is consumed in `processMessage` (`src/agent/agent.ts`). SessionStart + UserPromptSubmit hooks both contribute.
- Hook config is intentionally user-only (`src/hooks/config.ts:1-14`). Don't try to ship `.grok/settings.json` hooks.
- Workflow prompts (`/review`, `/verify`, `/commit-push`, `/commit-pr`, `/dream`) are owned by `builtin.commands.workflows`.
- `/skills` is owned by `builtin.commands.skills`.
- Custom subagent slash commands (`/<agent-name> <prompt>`) are owned by `builtin.commands.subagents` via dynamic resolver.

## Recurring

- After every ~8 turns or significant work → append to MEMORY.md
- After every session → reflect (what worked / failed / missing) and update HEARTBEAT

## Next heartbeat

After Phase 5 P2 (web composer) or after REVIEW_23 #3 (shared turn setup).

- Last check-in 2026-09-08: Phase 2 (relay/steward/host) + Phase 3 (hub + presence + WS + runnable engine node) landed on branches phase2/relay-steward & phase3/hub; pushed. Next: `codesurf node` CLI bound to the real Agent, then distributed-compute jobs. Full relay suite 23/23, typecheck 0.