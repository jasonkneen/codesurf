# CodeSurf

https://github.com/user-attachments/assets/f847a2b1-3212-423f-91bb-a96923710f39


Infinite canvas workspace for AI agents and developers.

CodeSurf is an Electron desktop app where terminals, chats, code editors, browsers, notes, boards, and extensions live together on a spatial canvas. It also supports tabbed/layout views, local agent tooling, and project-scoped workspace state.

## Features

- Infinite 2D canvas for blocks
- Terminal, chat, code, browser, files, note, and board blocks
- Tabbed/layout view for structured workspaces
- Local MCP server for agent-native workflows
- Extension system for custom blocks and tools
- File-based persistence under your home directory

## Tech stack

- Electron
- React
- TypeScript
- Vite / electron-vite
- Tailwind CSS
- xterm / node-pty
- Monaco Editor

## Development

Install dependencies with **npm** (authoritative lockfile: `package-lock.json`).
Do not use `bun install` for this package — a dual lockfile previously caused
Electron ABI drift for native modules (`node-pty`, `better-sqlite3`, `sharp`).
Electron is pinned to `41.3.0` in `package.json` / `package-lock.json`.

```bash
npm install
# Reproducible clean install (CI/release): npm ci
```

Keep optional dependencies enabled: TypeScript, Rollup, and Lightning CSS use
platform-specific optional packages that are required by the build and test
toolchain.

Run in development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run the authoritative unit gate:

```bash
npm run test:unit
```

The unit gate builds the Electron main process first. Pure tests retain normal
runner concurrency; Electron broker/OWL host fixtures run in a separate,
single-process lane because the app hosts share OS-level Electron resources.

Platform packaging:

```bash
npm run dist:mac
npm run dist:windows   # NSIS installer + portable .exe
npm run dist:linux     # AppImage + .deb
npm run dist:npm       # npm/npx package tarball
```

## npm distribution

CodeSurf can also be shipped as a thin npm package. The npm package contains the app build output and launcher scripts, but it does not bundle the Electron runtime itself.

On first launch, the `codesurf` launcher downloads Electron into `~/.codesurf/electron` and reuses that cached runtime after that.

Build the publishable npm package directory and tarball:

```bash
npm run dist:npm
```

That command writes:

- `release/npm/package/` — the publishable package contents
- `release/npm/*.tgz` — the tarball produced by `npm pack`

You can test the packaged launcher locally with:

```bash
npm install -g ./release/npm/codesurf-0.1.0.tgz
codesurf
```

Install from npm once published:

```bash
npm install -g codesurf
codesurf
```

## Project structure

```text
src/
  main/      Electron main process
  preload/   Electron preload bridge
  renderer/  React app
  shared/    Shared types and utilities
resources/   App icons and build resources
```

## Workspace storage

CodeSurf stores app data under `~/.codesurf`.

Default app-created workspaces go under:

```text
~/.codesurf/workspaces/
```

Project-backed workspaces can point at any folder you open.

## License

SEE LICENSE FILE
