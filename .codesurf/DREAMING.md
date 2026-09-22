Now I have sufficient grounding. Here is the full replacement contents for `.codesurf/DREAMING.md`:

---

# CodeSurf — Generated Workspace Memory

Generated: 2026-09-22 · Source: AGENTS.md, git log (last 20 commits), codebase snapshot, prior DREAMING.md

---

## Overview

CodeSurf is an Electron desktop app (v0.1.0) with web and Native WebView build targets. It provides an infinite 2D canvas workspace where tiles — terminal, code editor, browser, kanban, chat — coexist. AI agents connect via a local HTTP MCP server and collaborate with humans on shared canvas state. All persistence is file-based; no cloud sync exists.

---

## Durable Architecture Facts

**Versions (package.json as of 2026-09-22):**
- Electron 41.10.5, React 19.2.4, TypeScript 5.9.3
- electron-vite 7.3.6, Vite 7.3.1, Tailwind CSS 4.0.0
- @anthropic-ai/claude-agent-sdk 0.2.141
- @opencode-ai/sdk ^1.2.27

**Src layout:**
- `src/main/index.ts` — window management, IPC registration, app init
- `src/main/event-bus.ts` — wildcard pub/sub + ring-buffer (500 events/channel, no persistence)
- `src/main/mcp-server.ts` — local HTTP MCP 2.0 server, random port, 34 tools
- `src/main/permissions.ts` — permission defaults (hardened in security sprint)
- `src/main/ipc/` — 50+ per-feature IPC handler files (see list below)
- `src/main/chat/` — agent-mode resolver/tools, attachment routing, bounded output, chat lifecycle coordinator/fence/process/session, context composer, daemon job registry, daemon stream boundary, gateway tools, local-proxy backend/request/resource-limits/turn-fence, output sanitizers, peer authority policy
- `src/main/execution/` — bounded subprocess, canvas/relay projection, provider executor/cancellation, registration, service
- `src/main/daemon/client.ts`, `daemon/manager.ts` — thin wrappers delegating to external `@codesurf/daemon`
- `src/main/db/` — job-indexer, thread-indexer, migrations, paths
- `src/main/owl/` — browser automation + agent profiles (JSON-RPC peer, session/profile records, keyboard/mouse input injection)
- `src/main/relay/` — workspace relay service
- `src/main/storage/` — JSON artifacts, queued messages log, session archives, tile-state save coordinator, workspace artifacts/effect queue/save arbiter
- `src/main/security/` — durable security state, extension media consent, media access plan, permission boundary (core/types/boundary)
- `src/main/activity-*.ts` (7 files) — cap, document format, IPC handlers, persistence, store-core, store, validation
- `src/main/agent-room/` — agent room subsystem
- `src/main/privacy/`, `src/main/usage/`, `src/main/chrome-sync/` — supporting subsystems
- `src/main/session-sources.ts` + `src/main/session-sources/`
- `src/preload/index.ts` — context bridge exposures
- `src/renderer/src/App.tsx` — React SPA; canvas orchestration; delegates interaction composition to `hooks/useAppCanvasInteraction.ts`
- `src/renderer/src/components/` — lazy-loaded tile components
- `src/renderer/src/hooks/` — `useAppCanvas*`, `useChatTile*`, `useCanvas*` families are primary
- `src/shared/types.ts` — shared TypeScript types including `TileType` union

**IPC handlers (notable):** `activity.ts`, `agents.ts`, `bus.ts`, `canvas.ts`, `chat.ts`, `collab.ts`, `dreaming.ts`, `execution.ts`, `extensions.ts`, `fs.ts`, `git.ts`, `jobs.ts`, `localProxy.ts`, `mcp-config.ts`, `owl.ts`, `permissions.ts`, `relay.ts`, `skills.ts`, `terminal.ts`, `workspace.ts`, `window.ts`, `updater.ts`, `webview-paint.ts`, `tts.ts`, `transcribe.ts`, `stream.ts`, and more

**Canvas engine:**
- App.tsx orchestrates; focused hooks own pan/zoom, drag, resize, snapping, groups, undo/redo, context menus, connection locks via `hooks/useAppCanvasInteraction.ts`
- World coords = screen coords adjusted for zoom + pan offset; group movement recurses through nested groups
- Undo: full-state snapshots, max 50; **never push to undo stack in hot paths**
- Drag target is no longer committed to undo stack on every mousemove (fixed M35)

**Persistence paths (authoritative):**
- `~/.codesurf/workspaces/{storageId}/.codesurf/canvas-state.json`
- `~/.codesurf/workspaces/{storageId}/.codesurf/tile-state-{tileId}.json`
- `~/.codesurf/workspaces/{storageId}/.codesurf/kanban-{tileId}.json`
- `<project>/.codesurf/{tileId}/` — project-backed collaboration protocol state
- `~/.codesurf/mcp-server.json` — MCP config (port random; always read from file, never hardcode)

**IPC naming convention:** `{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

---

## Structural Change: Daemon Extracted to Engine Repo (commit 909592d)

- Entire vendored `packages/codesurf-daemon/` removed; now consumed as `@codesurf/daemon` from external engine repo
- `src/main/daemon/client.ts` and `src/main/daemon/manager.ts` remain as thin wrappers
- `dreaming.ts` IPC delegates `dreaming:status`, `dreaming:listRuns`, `dreaming:run`, `dreaming:cancel` to `daemonClient` via `ensureDaemonRunning()`
- `scripts/check-daemon-canonical.mjs` and `test/helpers/daemon-path.mjs` added for external-package consumption
- **`docs/multi-target.md` is stale** — still describes the daemon as in-repo
- All future daemon work targets the engine repo, not this repo

---

## Multi-Target Build System

| Target | Command | Notes |
|---|---|---|
| Electron (default) | `npm run dev` | Full product, hot reload |
| Web + codesurfd | `npm run web:dev` | Browser UI + web-host + codesurfd |
| Web preview (PWA) | `npm run web:preview` | Serve production build, installable |
| Web PWA dev | `npm run web:pwa` | web:dev + service worker |
| Native shell dev | `npm run desktop:dev` | WebView shell + web stack |
| Electron build | `npm run build` | main + preload + renderer |
| Renderer only | `npm run build:web` | dist/ for browser/Native/PWA |
| Native shell build | `npm run desktop:build` | Package Native shell |
| Native rebuild | `npm run rebuild` | node-pty rebuild for Electron |

- Electron and web/Native share the renderer; both talk to `codesurfd` via `scripts/web-host.mjs`
- Reference: `docs/multi-target.md` (stale re: daemon)

---

## Chat Providers

| Provider | Integration |
|---|---|
| Claude | @anthropic-ai/claude-agent-sdk — session resumption, adaptive thinking |
| Codex | codex CLI subprocess |
| OpenCode | @opencode-ai/sdk HTTP server |

All providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

---

## Owl Subsystem

`src/main/owl/` provides browser automation and agent profile management:
- `OwlSessionRecord` / `OwlProfileRecord` — persistent per-session browser profiles
- `JsonRpcPeer` — structured IPC between Owl runtime and renderer
- Keyboard/mouse input injection via Electron `KeyboardInputEvent`/`MouseInputEvent`
- IPC surface in `src/main/ipc/owl.ts`: `owl:health`, `owl:session:create`, `owl:profile:create`, and more
- Use `getOwlSupervisor().call(method, params)` internally; never call Owl runtime directly from outside `ipc/owl.ts`

---

## Activity Subsystem

`src/main/activity-*.ts` (7 files) tracks in-app activity:
- `activity-store-core.ts` / `activity-store.ts` — store layer
- `activity-persistence.ts` — durable storage
- `activity-cap.ts` — limits/caps enforcement
- `activity-ipc-handlers.ts` — IPC surface
- `activity-validation.ts` — input validation
- `activity-document-format.ts` — serialization format

---

## Security / Stability Sprint (M1–M41, landed ~2026-09-17)

All fixes committed before daemon extraction; the sprint is complete:
- Terminal IPC hardening (M15–M18)
- Canvas payload validation (M27–M29)
- Permission defaults hardened (`src/main/permissions.ts`)
- Popup fan-out fixed (M34, M37, M38)
- Daemon context cache (M1, M8)
- MCP tool scoping (M5–M7, M13, M19, M20)
- Relay storage validation + cross-tile dispatch authority (M2–M4, M22)
- Terminal grants scoped to one tile (M21, M23)
- Peer-message provenance + renderer races fixed (M24, M31, M33)
- New test: `test/permission-grant-resource-scope.test.ts`
- Job starts made idempotent; terminal queue terminalized on shutdown (D1, D3)
- Drag target no longer pushed to undo stack on every mousemove (M35)

---

## Chat Chip Chrome Rules (Regression-Prone — Do Not Break)

| Component | Chrome |
|---|---|
| `ThinkingBlockView` (transcript thinking block) | Full chip — background + border + shadow |
| `WorkingChipView` (live WORKING indicator) | Full chip — background + border + shadow |
| `ToolBlockView` (individual tool chip) | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border, still bordered |

- `ThinkingBlockView` and `WorkingChipView` are independent — changing one must never touch the other; caused three regressions in one session
- Canvas overlap → check App.tsx canvas z-index (`bringToFront`, `nextZIndex`) first; do not add `position: relative` + `zIndex` to transcript rows
- `textTransform: uppercase` breaks units (`${n}s` → `NS`); remove from spans containing number+unit or render as separate elements
- Chip expansion: use `React.startTransition`; `collateClusterChips` is lazy; cost is synchronous mount on expand

---

## Agent/Peer Collaboration Protocol

Agents running in canvas tiles use the `mcp__codesurf__*` tool namespace. Mandatory on every session start:

1. `room_status(tile_id=$CARD_ID)`
2. `peer_set_state(tile_id=$CARD_ID, tile_type="terminal", status="idle", task="Ready")`
3. `room_consume(tile_id=$CARD_ID)` — if unconsumed > 0
4. Read `~/.codesurf/workspaces/$CODESURF_WORKSPACE_ID/agent-rooms/inboxes/$CARD_ID/ROOM.md`

File conflict rule: never edit a file another room member lists in their `files` without `room_post`/`peer_send_message` coordination first.

---

## Known Hazards

- `cluso-widget` optional local dep (`file:../agentation-real`) — may not exist in all environments
- `node-pty` requires native rebuild after any dependency changes (`npm run rebuild`)
- MCP port is random — always read `~/.codesurf/mcp-server.json`, never hardcode
- App.tsx remains a large orchestration surface even after hook extraction — be surgical; changes ripple widely
- `docs/multi-target.md` is stale after daemon extraction
- AGENTS.md electron version entry shows `^41.3.0`; actual installed version is `41.10.5`

---

## Open Threads

- `docs/multi-target.md` needs updating to reflect external `@codesurf/daemon` consumption (stale since 909592d)
- AGENTS.md Electron version entry is behind package.json — minor housekeeping
- Owl subsystem IPC surface and capabilities not yet documented in AGENTS.md
- Activity subsystem IPC surface not yet documented in AGENTS.md
