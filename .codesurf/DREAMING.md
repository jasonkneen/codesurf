# CodeSurf Workspace — Generated Dream Memory

## Overview

CodeSurf is an infinite canvas workspace for AI agents and developers. The monorepo contains a terminal agent CLI, an Electron desktop app, and shared daemon/plugin packages. Sessions are automatically grounded in this workspace; the `.claude/CLAUDE.md` agent-room protocol is the authoritative runtime instruction set.

## Monorepo Layout

| Path | Role | Package manager | License |
|---|---|---|---|
| `apps/cli` | `codesurf` terminal agent (Bun + OpenTUI) | Bun workspace | MIT |
| `apps/desktop` | Desktop canvas app (Electron / Electrobun) | npm — standalone, excluded from Bun workspace | AGPL-3.0 |
| `packages/codesurf-daemon` | `@codesurf/daemon` — `codesurfd`, the HTTP backend shared by CLI and desktop | npm | — |
| `packages/plugin-api` | Plugin API the CLI plugins build against | Bun workspace | — |
| `packages/runtime` | Plugin runtime the CLI plugins build against | Bun workspace | — |

## Build & Test

```bash
# Root
bun install
bun run typecheck          # delegates to apps/cli
bun run test               # apps/cli test:all + packages vitest

# Desktop (npm, standalone)
cd apps/desktop && npm ci && npm run check && npm test

# Daemon
npm --prefix packages/codesurf-daemon ci && npm --prefix packages/codesurf-daemon test
```

`apps/desktop` is intentionally excluded from the Bun workspace list and must be built/tested via its own npm scripts.

## Runtime Architecture — Two Background Processes

- **`codesurf server`** — detached CLI engine nodes that own agent sessions over WebSocket. TUI auto-attaches to the `default` node (port 3948), starting it on first launch. `--name <n>` adds named nodes; `--project [dir]` scopes to a directory. Disable auto-start: `"server": { "autoStart": false }` in `~/.codesurf/user-settings.json` or pass `--serverless`.
- **`codesurf daemon`** — `codesurfd`, the HTTP backend shared with the desktop app. PID tracked at `~/.codesurf/daemon/pid.json`.

Both are independently managed; server ≠ daemon.

## Active Workflows & Known Stable Behaviors

- Turn IDs on the relay are deduplicated so late frames from a previous turn cannot close the following one (fixed: `7b01bc2e`).
- Session persistence: server-mode turns stay in the open session and persist on exit; the TUI no longer prompts for a local API key when attached to a running server.
- API key is read fresh every turn; a keyless turn reports where the key should go.
- Server switching inside the TUI works via `/server`.

## Model Registry (as of recent commit `91c9103d`)

Live model lists now include: **Fable 5.1**, **Opus 5.5**, **GPT-6**, **GPT-5.6**.

## Open Threads

- **Agensis relay integration** — a plan exists at `plans/` for relay integration and a shared runtime package; not yet landed.
- **`.codesurf/tile-1790945136371/`** — leftover canvas tile from a prior agent session. Contains a large `objective.md` (42 KB) and `skills.json` (10.7 KB). These are stale and not currently consumed by any active workflow; safe to archive once confirmed no longer needed.
- All standard `.codesurf/` subdirectories (`agents`, `extensions`, `plugins`, `sessions`, `skills`, `tools`) are currently empty — no active agent-room objects, installed skills, or plugin registrations in the workspace store.

## Notes for Future Sessions

- The `.claude/CLAUDE.md` agent-room protocol (room_status → peer_set_state → room_consume on session start) is the authoritative runtime instruction set for this workspace; this file supplements it with structural facts only.
- `apps/desktop` license (AGPL-3.0) differs from `apps/cli` (MIT) — relevant if publishing or distributing built artifacts.
- Prior DREAMING.md content (GotEmail reverse-engineering session) was off-topic and has been replaced by this file.
