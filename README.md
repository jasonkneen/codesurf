# CodeSurf

Infinite canvas workspace for AI agents and developers, plus the terminal agent and the local daemon they share.

## Layout

| Path | What it is |
|---|---|
| [`apps/desktop`](apps/desktop) | The CodeSurf desktop app (Electron / Electrobun): canvas, terminals, chats, editors, extensions. npm, standalone install. |
| [`apps/cli`](apps/cli) | The `codesurf` terminal agent (Bun + OpenTUI). |
| [`packages/codesurf-daemon`](packages/codesurf-daemon) | `@codesurf/daemon` — the one local daemon (`codesurfd`) both apps start and share via `~/.codesurf/daemon/pid.json`. |
| [`packages/plugin-api`](packages/plugin-api), [`packages/runtime`](packages/runtime) | The plugin API and runtime the CLI's plugins are built on. |

## Servers and the daemon

Two different background processes, two commands:

- `codesurf server start|stop|status|restart|list` — **servers**: detached CLI engine nodes that own agent sessions over WebSocket. The TUI attaches to the `default` one (port 3948), starting it when none is running. `codesurf server start --name <n>` adds more user servers, and `--project [dir]` starts a project server that serves only that folder. Inside the TUI, `/server` switches servers. Turn auto-start off with `"server": { "autoStart": false }` in `~/.codesurf/user-settings.json`, or pass `codesurf --serverless` for one launch.
- `codesurf daemon start|stop|status|restart` — **codesurfd**, the HTTP backend shared with the desktop app.

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

## CI and releases

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and push to `main`: CLI typecheck, lint, tests and build, the shared-package tests, and the daemon package on its own.
- [`.github/workflows/release-on-tag.yml`](.github/workflows/release-on-tag.yml) builds the desktop app when a `v*.*.*` tag is pushed.
- The workflows under `apps/cli/.github/` came over from the CLI's old standalone repo. GitHub only reads the root `.github/`, so they do not run here.

## Before you push

This repo is public. Scan what you are about to publish:

```bash
gitleaks git --log-opts="HEAD --not --remotes" .
```

[`.gitleaks.toml`](.gitleaks.toml) holds the one allowlisted test fixture. Agent session transcripts and personal launcher scripts stay out of git; the root `.gitignore` lists the ones that have leaked keys before.

## Licenses

Each app keeps its own license: `apps/desktop` is AGPL-3.0 ([LICENSE](apps/desktop/LICENSE)), `apps/cli` is MIT ([LICENSE](apps/cli/LICENSE)).
