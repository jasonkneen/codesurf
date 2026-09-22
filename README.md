# CodeSurf

Infinite canvas workspace for AI agents and developers, plus the terminal agent and the local daemon they share.

## Layout

| Path | What it is |
|---|---|
| [`apps/desktop`](apps/desktop) | The CodeSurf desktop app (Electron / Electrobun): canvas, terminals, chats, editors, extensions. npm, standalone install. |
| [`apps/cli`](apps/cli) | The `codesurf` terminal agent (Bun + OpenTUI). |
| [`packages/codesurf-daemon`](packages/codesurf-daemon) | `@codesurf/daemon` — the one local daemon (`codesurfd`) both apps start and share via `~/.codesurf/daemon/pid.json`. |
| [`packages/plugin-api`](packages/plugin-api), [`packages/runtime`](packages/runtime) | The plugin API and runtime the CLI's plugins are built on. |

## Working in the repo

```bash
# CLI + shared packages (Bun workspace at the root)
bun install
cd apps/cli && bun run typecheck && bun run test:all
bun run test:packages            # plugin-api / runtime tests, from the root

# Desktop (npm, installed on its own; depends on packages/codesurf-daemon)
cd apps/desktop && npm ci && npm run check && npm test

# Daemon package
npm --prefix packages/codesurf-daemon ci && npm --prefix packages/codesurf-daemon test
```

## Licenses

Each app keeps its own license: `apps/desktop` is AGPL-3.0 ([LICENSE](apps/desktop/LICENSE)), `apps/cli` is MIT ([LICENSE](apps/cli/LICENSE)).
