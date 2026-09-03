Now I have enough to produce the updated memory. Here is the full replacement content for `.codesurf/DREAMING.md`:

---

# CodeSurf — Generated Workspace Memory

_Last consolidated: 2026-08-27_

---

## Overview

CodeSurf (`/Users/jkneen/clawd/collaborator-clone`) is an Electron desktop application providing an infinite-canvas workspace where AI agents and humans collaborate on shared tiles. It also ships as a browser PWA and native WebView shell. Current HEAD is `main` at `ba23db3`. Recent activity: daemon hardening merged to main, multi-turn chat continuity fixes landed, and a large `fix/app-health` frontend branch was audited by Codex with confirmed defects that need resolution before merge.

---

## Durable Architecture Facts

**Process split**
- `src/main/` — Electron main process; IPC handlers, event bus, MCP server, agent rooms, relay, chat, extensions, daemon client
- `src/preload/index.ts` — Context bridge (workspace, fs, canvas, terminal, chat, bus, mcp)
- `src/renderer/src/` — React SPA; canvas orchestration in `App.tsx`, lazy-loaded tile components, focused interaction hooks
- `src/shared/types.ts` — Shared TypeScript types (TileType union, etc.)
- `src/electrobun/` — Electrobun integration layer

**Canvas engine**
- `App.tsx` is the canvas orchestration surface; bulk interaction logic extracted to `hooks/useAppCanvasInteraction.ts`
- Focused hooks own pan/zoom, drag, resize, snapping, groups, undo/redo, context menus, connection locks
- World-coord system: screen coords adjusted for zoom + pan offset; group movement recurses through nested groups
- Undo = full state snapshots, max 50 — never push in hot paths
- App.tsx remains a large orchestration surface; be surgical, changes ripple widely

**Event bus** (`src/main/event-bus.ts`)
- In-memory pub/sub, wildcard patterns (`tile:*`, `*`), ring-buffer 500 events per channel, no persistence

**MCP server** (`src/main/mcp-server.ts`)
- Local HTTP, random port at startup — config written to `~/.codesurf/mcp-server.json`; never hardcode port
- 34 tools exposed; results propagate via event bus to canvas/kanban

**Persistence paths**
- Canvas state: `~/.codesurf/workspaces/{storageId}/.codesurf/canvas-state.json`
- Tile state: `~/.codesurf/workspaces/{storageId}/.codesurf/tile-state-{tileId}.json`
- Kanban state: `~/.codesurf/workspaces/{storageId}/.codesurf/kanban-{tileId}.json`
- Collaboration protocol state: `<project>/.codesurf/{tileId}/`
- MCP config: `~/.codesurf/mcp-server.json`
- Agent room live inbox: `~/.codesurf/workspaces/$CODESURF_WORKSPACE_ID/agent-rooms/inboxes/$CARD_ID/ROOM.md`

---

## Key Source Subsystems

- **Agent room** — `src/main/agent-room/` (index, persistence, projection, store, types, validation)
- **Relay** — `src/main/relay/` (service, workspaceRelayService, registration, provider-executor, provider-cancellation, bounded-subprocess, canvasProjection, ipc-validation)
- **Owl** — `src/main/owl/runtime.ts`
- **Activity system** — `src/main/activity-*.ts` (cap, document-format, ipc-handlers, persistence, store-core, store, validation)
- **Dreaming subsystem** — `src/main/ipc/dreaming.ts`, `src/renderer/src/components/mainStatusBarDreaming.ts`, `src/renderer/src/components/chat/dreamToolActions.ts`
- **Agent adapters** — `src/main/agents/agent-adapter-registry.ts`, `agent-adapter-types.ts`, `agent-cli-contracts.ts`
- **Extensions** — `src/main/extensions/` (activation policy, openclaw/pi adapters)
- **MCP registry** — `src/main/mcp/registry.ts`
- **Usage tracking** — `src/main/usage/` (claude-reader, codex-reader, index)
- **Job system** — `src/shared/job-types.ts`, `src/main/ipc/jobs.ts`
- **Execution targets** — `src/main/execution/targets.ts`, `src/main/ipc/execution.ts`
- **Tile todos store** — `src/renderer/src/state/tileTodosStore.ts`
- **Discovery graph** — `src/renderer/src/hooks/useDiscoveryGraph.ts` + `src/renderer/src/workers/discovery-graph.worker.ts`
- **SQLite migrations** — `src/main/db/migrations/` (001–004: bootstrap → threads → thread_index → job_index)
- **Daemon client/manager** — `src/main/daemon/client.ts`, `src/main/daemon/manager.ts`
- **Peer state** — `src/main/peer-state.ts`
- **Chrome sync** — `src/main/chrome-sync/` (bookmarks, keychain, domain-allowlist)
- **Privacy / security** — `src/main/privacy/`, `src/main/security/`
- **Session sources** — `src/main/session-sources/`

---

## Monorepo Packages (`packages/`)

| Package | Purpose |
|---|---|
| `codesurf-daemon` | Self-contained daemon; shared policy authority; interface frozen; packaging hardened |
| `codesurf-relay` | Relay service extracted as standalone package |
| `codesurf-chat-bridge` | Chat bridge between providers and canvas |
| `codesurf-plugin` | Plugin system |
| `codesurf-terminal-gateway` | Terminal gateway |

---

## Recent Commit Chain (all landed on main)

- `ba23db3` — Align app and extension font tokens
- `e715f99` — Harden chat runtime and panel layout behavior
- `9a8831b` — Make daemon packaging self-contained
- `23f2527` — Allow bounded Electron shutdown on loaded hosts
- `496972a` — Refresh security-sensitive runtime pins
- `5efc817` — Hide daemon internals behind package exports
- `eb9bc59` — Make daemon package the shared policy authority
- `9ffa226` — Move daemon tests into shared package
- `90fad40` — Enforce daemon package boundaries
- `f21f545` / `de90bad` — Freeze daemon recursive interface; fix cross-platform verification
- `2209e0f` / `de3c22c` — Full security remediation merge; Electrobun parity

**Daemon chat continuity (landed, now in main via `fix/daemon-chat-continuity`)**
- Fix daemon multi-turn chat continuity (Codex resume + harness foreground fallback)
- Resolve agentMode server-side authoritatively (root fix for looser-mode bypass)
- Add ChatTile load-race wiring guard (3rd reopening vector)
- Close built-in seeding load-race: SEND resolves agents.json override, fail-closed
- Harden B3 wiring guard: pin agentMode forwarding in codex/hermes builders

---

## Active Branch: `fix/app-health` (UNMERGED — defects confirmed)

19 commits, 11,771 changed lines, 124 files. Base: `main` at `141e7aa`.

**Confirmed defects (Codex audit 2026-08-27):**
- **Blur listener leak** — Tailwind migration renamed an event cleanup listener; the old listener name is left in place, causing blur handlers to never detach
- **Missing production assets** — production CSS references font and texture files that Vite never emits to `dist/`; will 404 in production build
- **Resize code and email decoding** — both identified as being on lag-sensitive paths; edge conditions unverified at time of last audit

This branch exceeds reviewability for a single pass (11,771 lines). Recommendation from audit: split at subsystem seams before landing.

---

## Companion Repo: InfinittyKit / Titerm (Swift)

Active Codex review sessions on `fix/app-health` (Swift) at `/Users/jkneen/Documents/GitHub/titerm/`:

**High-priority defects confirmed (2026-08-27):**
- **TodoWrite pre-success mutation** — `PetAssistant.swift:5770`: visible plan is mutated on `.running` event before success is confirmed; a later `.failed` event only logs the error and does not restore the prior plan → failed Claude todo calls appear successfully mirrored. Tests exercise the parser helper directly, never the event lifecycle.
- **Codex default model mismatch** — `ModelDiscovery.swift:304`: catalog marks `gpt-5.6-luna` as default, but unconfigured runtime dispatch still falls back to `gpt-5.4`. Updated test validates only catalog metadata, so it passes while runtime behavior disagrees.
- **addTodo not persisted to thread** — `ShadcnAssistantHost.swift`: `addTodo` appends only to the presentation array; the host callback only replaces an item already present in `threads[index].todos` and returns for new UUIDs → item disappears on next panel refresh/thread switch and never reaches provider context.

**Repairs verified present (five confirmed in diff):** regression tests for failed `TodoWrite`, per-thread log normalization, direct scoped routing, and model defaults are present in the current branch diff.

---

## Chat Providers

| Provider | Integration |
|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` 0.2.141 — session resumption, adaptive thinking |
| Codex | codex CLI subprocess |
| OpenCode | `@opencode-ai/sdk` 1.2.27 HTTP server |

All stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

---

## Build Targets

| Command | Target |
|---|---|
| `npm run dev` | Electron full product (hot reload) — default |
| `npm run web:dev` | Browser UI + web-host + codesurfd |
| `npm run web:preview` | Serve production web build (PWA installable) |
| `npm run web:pwa` | web:dev + service worker for install testing |
| `npm run desktop:dev` | Native SDK WebView shell + web stack |
| `npm run build` | Full Electron build |
| `npm run build:web` | Renderer-only → dist/ |
| `npm run desktop:build` | Package native shell |
| `npm run rebuild` | Native rebuild (node-pty) — required after dep changes |

Multi-target reference: `docs/multi-target.md`. Electron is never removed; web/Native share the renderer and talk to `codesurfd` via `scripts/web-host.mjs`.

---

## Chat Chip Chrome Rules (DO NOT BREAK)

| Component | Chrome |
|---|---|
| `ThinkingBlockView` | Full chip — background + border + shadow |
| `WorkingChipView` | Full chip — background + border + shadow |
| `ToolBlockView` | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border, still bordered |

- `ThinkingBlockView` and `WorkingChipView` are independent; changing one must never touch the other
- Canvas overlap issues → check App.tsx z-index (`bringToFront`, `nextZIndex`) first; never add `position: relative + zIndex` to transcript rows to fix canvas stacking
- `textTransform: uppercase` breaks number+unit strings (`${n}s` → `NS`); use separate elements or remove transform from any span containing a number+unit
- Chip expansion: use `React.startTransition` on all expand toggles; collation system (`collateClusterChips`) is lazy — unexploded groups emit zero individual items

---

## Agent Room Protocol (active canvas agents)

The `.codesurf/` directory contains state for active tile agents. All follow the `codesurf.md` protocol:

**Mandatory session start:**
1. `mcp__codesurf__room_status(tile_id=$CARD_ID)`
2. `mcp__codesurf__peer_set_state(...)` status=idle, task="Ready"
3. `mcp__codesurf__room_consume(tile_id=$CARD_ID)` if unconsumed > 0

Also read `~/.codesurf/workspaces/$CODESURF_WORKSPACE_ID/agent-rooms/inboxes/$CARD_ID/ROOM.md` for live inbox.

**File conflict rule:** Never edit a file another room member lists in their `files` without `room_post` / `peer_send_message` coordination first.

---

## Open Threads

- `fix/app-health` (CodeSurf renderer) — blur listener leak and missing Vite assets are confirmed blockers; branch needs subsystem split before merge
- InfinittyKit `fix/app-health` (Titerm Swift) — TodoWrite pre-success mutation and addTodo persistence gap need fixes; model default centralization needed in `ModelDiscovery.swift`
- MCP server has no authentication — any local HTTP caller can invoke all 34 tools; no fix landed, acknowledged gap
- `cluso-widget` optional local dep (`file:../agentation-real`) — may not exist; treat as optional in all environments
