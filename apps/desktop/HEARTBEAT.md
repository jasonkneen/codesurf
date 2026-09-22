# Heartbeat

This file is read every 30 minutes by the autonomous development loop.
Add tasks, ideas, or observations. Check off what's done. The agent adds its own.

Instructions for the agent: pick ONE unchecked item, work on it or note findings,
check it off or update it, then add anything new you noticed. If all items are done
or this file is empty, add one observation from the codebase. Then stop.

---

## Active — Extensions to Build (priority order)

- [x] BUILD: `agent-kanban` extension — DONE 2026-04-03. Full 4-column board, drag-drop, Start dispatches to peers, actions API, detail panel, modal, status badges
- [x] BUILD: `local-models` extension — DONE 2026-04-03. 20 curated GGUF models in size groups, probes Ollama/llama.cpp/LM Studio, manual add, setModel action
- [x] BUILD: `token-counter` extension — DONE 2026-04-03. Live stats, cost table across 5 models, context window bar, countText action
- [x] BUILD: `model-hub` extension — DONE 2026-04-03. HF API search + 15 task filters + sort (downloads/likes/trending/updated). Cards show task badge, dl/likes stats, relative date. "Use" sets ctx:model-hub:selected + invokes setModel on connected peers. "View on HF" opens model page.
- [x] BUILD: `rag-docs` extension — DONE 2026-04-03. File upload (click/drag-drop), configurable chunking (size + overlap sliders), chunk preview with overlap highlighting, keyword search fallback + ext.invoke semantic search, result highlighting, ctx:rag:selected-chunk context producer, state persisted via tile.setState.
- [x] BUILD: `api-proxy` extension — DONE 2026-04-03. Port config, enable toggle, API key field + generator, host allowlist with add/remove, live status polling via ext.invoke('getStatus'), active connection list, stat badges, Copy URL button. ctx:api-proxy:config context producer. configure/getUrl actions.
- [x] CORE: Local API server — DONE 2026-04-03. `src/main/ipc/localProxy.ts` — HTTP server on configurable port (default 1337), Anthropic `/v1/messages` → OpenAI/Ollama format transform, auto-probes Ollama:11434 / LM Studio:1234 / llama.cpp:8080, streaming SSE transform, IPC: localProxy:start/stop/getStatus/probeBackends. Wired into main/index.ts + preload bridge. api-proxy extension upgraded to power tier with main.js that caches live stats via event bus.
- [x] CORE: Claude Code endpoint remapping — DONE 2026-04-03. Added `localProxyEnabled: boolean` + `localProxyPort: number` to AppSettings (shared/types.ts). In terminal:create isClaude branch, calls readSettingsSync() and sets ANTHROPIC_BASE_URL=http://localhost:{port}/v1 when enabled. Zero-risk: off by default, no new IPC, purely additive.

## Maintenance

- [x] Verify the Chrome cookie sync works end-to-end — DONE 2026-04-03. Timing is correct (cookies injected before DOM attachment). Found decryption bug: `cookies.ts:13` uses `Buffer.alloc(16, 0)` (null bytes) as AES IV but Chromium macOS uses 16 space chars (`0x20`). This silently breaks all v10 cookie decryption — fix: `Buffer.alloc(16, 0x20)`.
- [x] FIX: Chrome cookie AES IV bug — DONE 2026-04-03. `cookies.ts:13` `Buffer.alloc(16, 0)` → `Buffer.alloc(16, 0x20)`. Chrome sync should now actually inject cookies.
- [x] The extension harness `server.mjs` needs a `package.json` — DONE 2026-04-03. Added `examples/extensions/_harness/package.json` with `npm start` / `npm run dev` scripts
- [x] Review `src/main/ipc/` for any handlers that are registered but never called from preload — DONE 2026-04-03. Found 5 orphaned handlers: `bus:unsubscribe`, `ext:install-vsix`, `fs:basename`, `fs:delete`, `fs:rename`. Also found `window.api.extensions.installVsix` at App.tsx:3097 — runtime TypeError (bridge is `window.electron` not `window.api`). Safe to remove all 5 handlers + fix App.tsx call site.
- [x] Check whether `examples/extensions/artifact-builder/` has an up-to-date `extension.json` — DONE 2026-04-03. Structure is correct. Minor: default model is `anthropic/claude-sonnet-4`, current latest is `claude-sonnet-4-6` — low priority, user-overridable

## Ideas / Future
- [x] Security hook false positives — INVESTIGATED 2026-04-03. Root cause identified (see MEMORY.md). Fix: add `examples/extensions/` auto-approve to `~/.claude/fieldtheory-read-permission-hook.py`. Not done — modifying global user hook needs explicit approval.
- [ ] FIX: Add `examples/extensions/*` to auto-approve in `~/.claude/fieldtheory-read-permission-hook.py` (lines 23–46, same pattern as fieldtheory-mac and .cursor/commands auto-approves). Safe, targeted, one-line fix.
- [x] Add a `validate-extension` command that checks extension.json against the schema and tests that tile HTML loads in the harness — DONE 2026-04-22. Added `scripts/validate-extension.mjs` + `npm run validate-extension`; it validates manifest structure, referenced files, and harness-served tile entry URLs.
- [x] MCP agent-native gap — DONE 2026-04-03. `src/main/mcp-server.ts`: (1) `canvas_create_tile` type widened from hardcoded enum to open string with description listing core types + `ext:<id>` syntax. (2) Added `list_extensions` tool returning id/name/description/enabled/tileTypes/actions/context for every installed extension. Agents can now discover and create extension tiles.
- [ ] Consider a `CHANGELOG.md` — the codebase moves fast and there's no record of what changed when
- [x] agent-kanban v2 — DONE 2026-04-03. Full Cline kanban port: dependency blocking, git worktrees per task, agent session state machine, 5-agent catalog (claude/codex/gemini/cline/opencode), live output streaming, detail panel, input field. 585-line main.js + full board tile HTML.
- [x] Local proxy server complete. End-to-end chain: Claude Code → ANTHROPIC_BASE_URL → localProxy HTTP → format transform → Ollama/LM Studio/llama.cpp → transform back → Claude Code.
- [ ] Kanban sidebar agent: dedicated chat agent that can only manage kanban tasks (no code changes), uses actions API

## Done

- [x] FIX: Daemon Claude jobs failed with `Native CLI binary for darwin-arm64 not found` — DONE 2026-08-20. `packages/codesurf-daemon/bin/chat-jobs.mjs` was the only `query()` call site that never set `pathToClaudeCodeExecutable`, so any pruned/mid-install `@anthropic-ai/claude-agent-sdk-<platform>` optional package killed every chat job with no fallback. Added `resolveClaudeExecutable(homeDir)` (bundled native binary -> `~/.codesurf/agent-paths.json` -> PATH) and wired it into the Claude options, matching `src/main/chat/providers/claude.ts:454`.

- [x] FIX: Chat memory guard is now much more aggressive, and repeated WebContents destroyed listeners no longer stack up — DONE 2026-04-12. `src/renderer/src/components/ChatTile.tsx` now compacts older finished chat messages by dropping rich interleaved layout data, trimming tool/thinking payloads, lowering render/live caps, and flattening old blocks back to simpler text for memory safety. `src/main/ipc/bus.ts`, `src/main/ipc/terminal.ts`, and `src/main/ipc/fs.ts` now attach only one destroyed cleanup listener per renderer `WebContents`, fixing the earlier `MaxListenersExceededWarning` pattern.

- [x] FIX: Discovery edges no longer stack directly on top of each other, and locked edges suppress same-pair proximity edges — DONE 2026-04-11. `src/renderer/src/App.tsx` now assigns lane offsets to identical ambient routes and gives locked connections precedence so only the locked route remains for that pair.

- [x] FIX: Dragging images, videos, PDFs, and docs onto the canvas now creates sensible blocks — DONE 2026-04-11. `src/renderer/src/App.tsx` now classifies local media/docs into `image`, `browser`, or `file` instead of dropping unknown files into terminals, and the missing `file` render path is now wired up.

- [x] FIX: Chat runtime cache now disposes cleanly on close and debounces persistence — DONE 2026-04-11. `src/renderer/src/components/ChatTile.tsx` no longer writes full tile state on every streaming token, and closing a chat block now disposes its in-memory runtime snapshot instead of letting unmount persistence recreate deleted state.

- [x] FIX: Tabbed view no longer drops live chat state on remount — DONE 2026-04-11. `ChatTile` now restores from an in-memory per-tile runtime snapshot before disk and flushes its latest snapshot on unmount, including streaming state; `PanelLayout` also stops keeping every inactive lightweight tab mounted.

- [x] FIX: Chat `@` autocomplete now prefers connected file tiles — DONE 2026-04-11. `src/renderer/src/components/ChatTile.tsx` now lists connected file-backed peers before generic mention stubs, and choosing one auto-attaches that file so the outgoing message includes its path block.

- [x] FIX: Previous sessions hidden behind alias workspace ids — DONE 2026-04-11. `src/main/ipc/canvas.ts` now reads/writes/migrates tile and canvas state across all workspace ids that share the same `workspace.path`, so `createWithPath(...)` aliases can see older sessions instead of acting like fresh workspaces.
- [x] FIX: Sticky-note link pills and font controls — DONE 2026-04-11. Connection/link pills now render under tiles instead of above them, and sticky notes now have a titlebar font picker with persisted note-friendly fonts.
- [x] FIX: GitHub release workflow hardened — DONE 2026-04-11. `.github/workflows/release-on-tag.yml` still auto-runs on `v*.*.*` tag pushes, and now also supports manual rerun against an existing tag with explicit ref checkout and release-specific concurrency.
- [x] FIX: Session sidebar now aggregates external agent histories — DONE 2026-04-11. The sessions list now merges local CodeSurf chat tiles with `.codesurf/sessions`, Claude transcripts, Codex sessions, Cursor chats, OpenClaw session indexes, and OpenCode conversation files, with source-specific icons.
- [x] FIX: macOS traffic lights now track sidebar collapse — DONE 2026-04-11. `src/main/index.ts` now repositions native traffic lights via IPC when the renderer toggles the sidebar, so collapsed and expanded layouts can use different x offsets.
- [x] FIX: OpenCode model list now loads in the background — DONE 2026-04-11. `chat:opencodeModels` returns cached/fallback models immediately and refreshes asynchronously, broadcasting `chat:opencodeModelsUpdated` so ChatTile updates without blocking the UI.
- [x] FIX: OpenClaw chat provider CLI invocation was broken — DONE 2026-04-10. `src/main/ipc/chat.ts` and `src/main/relay/provider-executor.ts` now call the real `openclaw agent --json --message ...` interface with `--agent`/`--session-id` instead of nonexistent flags like `--output-format`, `--approval-mode`, `--model`, and `-p`. Note: OpenClaw routes by configured agent, not a per-turn model flag.
- [x] FIX: Hermes chat provider CLI invocation was broken — DONE 2026-04-10. `src/main/ipc/chat.ts` and `src/main/relay/provider-executor.ts` now call `hermes chat --query ... --quiet --source tool` instead of the invalid top-level `hermes -q ... --compact` form; also captures `session_id:` output correctly.
- [x] FIX: Legacy home-directory migration crashed on symlinked extensions — DONE 2026-04-10. `src/main/migration.ts` now preserves symlinks during `~/.contex -> ~/.codesurf` merge instead of calling `copyFile()` on entries like `extensions/agent-kanban`, which caused startup `ENOTSUP` failures.

<!-- Completed items move here with date -->
