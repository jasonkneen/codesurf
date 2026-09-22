# CodeSurf

Electron desktop app — infinite canvas workspace for AI agents and developers.

## What It Is

A multi-workspace IDE-like environment where tiles (terminal, code editor, browser, kanban, chat) live on an infinite 2D canvas. AI agents connect via MCP and interact with canvas/kanban state. Humans and agents collaborate asynchronously.

## Architecture

```
src/
  main/          — Electron main process
    index.ts     — Window management, IPC registration, app init
    event-bus.ts — In-memory pub/sub with wildcard patterns + ring-buffer history
    mcp-server.ts — Local HTTP MCP 2.0 server (random port, 34 tools)
    ipc/         — IPC handler modules (one file per feature domain)
  preload/
    index.ts     — Context bridge exposures (workspace, fs, canvas, terminal, chat, bus, mcp...)
  renderer/
    src/
      App.tsx    — React SPA; contains the entire canvas engine (~1944 LOC)
      components/— Tile components (lazy-loaded)
      hooks/     — useDetectedAgents, useMCPServers
  shared/
    types.ts     — Shared TypeScript types (TileType union, etc.)
```

## Tech Stack

| | |
|---|---|
| Electron | ^41.3.0 |
| React | 19.2.4 |
| TypeScript | 5.9.3 |
| Vite / electron-vite | 7.3.1 / 5.0.0 |
| Tailwind CSS | 4.0.0 |
| xterm + node-pty | terminal emulation |
| Monaco editor | code tiles |
| @anthropic-ai/claude-agent-sdk | 0.2.79 |
| @opencode-ai/sdk | 1.2.27 |
| chokidar | filesystem watch |

## IPC Naming Convention

`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

## Key Patterns

**Canvas engine** — All 2D physics (pan/zoom, drag, resize, snapping, groups, undo/redo) lives in App.tsx. World coords = screen coords adjusted for zoom + pan offset. Group movement recurses through nested groups. Undo snapshots full state (max 50).

**Tiles are lazy-loaded** — `React.lazy` + `Suspense` wraps every tile component.

**Event bus** — Main-process pub/sub. Wildcard subscriptions (`tile:*`, `*`). Ring-buffer per channel (500 events). No persistence.

**MCP server** — Starts on a random port. Config written to `~/.codesurf/mcp-server.json`. Agents call HTTP endpoints; results propagate to canvas/kanban via event bus.

**Refs for cross-effect sync** — Heavy use of `useRef` to keep mutable state accessible inside event handlers without stale closure issues.

**Persistence** — File-based only, no cloud sync:
- `~/.codesurf/workspaces/{id}/canvas.json` — canvas state (auto-saved, 500ms debounce)
- `~/.codesurf/workspaces/{id}/tiles/{tileId}.json` — kanban tile state
- `~/.codesurf/mcp-server.json` — MCP server config

## Chat Providers

| Provider | Integration |
|---|---|
| Claude | @anthropic-ai/claude-agent-sdk (session resumption, adaptive thinking) |
| Codex | codex CLI subprocess |
| OpenCode | @opencode-ai/sdk HTTP server |

All providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

## Build Commands

```bash
npm run dev          # electron-vite dev (hot reload)
npm run build        # full build (main + preload + renderer)
npm run rebuild      # native rebuild (node-pty)
```

## Style Conventions

- Dark theme hardcoded (`#1e1e1e`, `#252525`, `#333`)
- Tailwind + inline `React.CSSProperties` (no CSS-in-JS library)
- Strict TypeScript; `any` avoided except in older chat.ts sections
- 2-space indent, trailing commas, no semicolons

## Watch Out For

- App.tsx is ~1944 LOC — be surgical; changes ripple widely
- node-pty requires native rebuild after dependency changes (`npm run rebuild`)
- MCP server port is random — always read from config file, never hardcode
- Canvas undo state holds full snapshots — don't accidentally push to undo stack in hot paths
- `cluso-widget` is an optional local file dependency (`file:../agentation-real`) — may not exist in all environments
