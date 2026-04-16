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

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Platform packaging:

```bash
npm run dist:mac
npm run dist:windows   # NSIS installer + portable .exe
npm run dist:linux     # AppImage + .deb
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
~/codesurf/workspaces/
```

Project-backed workspaces can point at any folder you open.

## License

SEE LICENSE FILE
