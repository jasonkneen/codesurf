# Collaborator Clone — Build Log

**Started:** 2026-03-16 20:34:21 GMT
**Plan:** ~/clawd/collab-build-plan.md

---

## Phase 1: Electron Shell + Minimal Canvas (✓)

**Completed:** 2026-03-16 20:38 GMT

### What Works
- ✅ Electron 40 + React 19 + Tailwind CSS 4 (next)
- ✅ electron-vite dev server running (http://localhost:5174)
- ✅ Main process, preload, renderer all building
- ✅ Basic app shell with titlebar + sidebar + canvas layout
- ✅ Grid background rendering (minor + major dots)
- ✅ One demo tile positioned in world-space
- ✅ IPC bridge stubs in preload (workspace, fs, canvas, terminal, updater)

### Dependency Challenges
- Tailwind CSS v4 (@next) required `@tailwindcss/postcss` instead of direct plugin
- `@vitejs/plugin-react@^6` demands Vite 8; downgraded to v4.3.1 for Vite 7 compat
- Used `--legacy-peer-deps` throughout to work around Electron + Vite version matrix

### Next Steps (Phase 2)
- Canvas pan/zoom with mouse drag + wheel
- Snap-to-grid on tile drop
- Multi-tile state management
- Rubber-band selection
- Z-index management (click-to-front)


## Phase 2: Real IPC + Components (✓)

**Completed:** 2026-03-16 21:20 GMT

### What's Built
- ✅ Real main process IPC: workspace, fs, canvas, terminal (node-pty)
- ✅ Workspace config at ~/clawd-collab/
- ✅ File tree sidebar with lazy expand, colored file dots, resizable panel
- ✅ Workspace switcher dropdown
- ✅ TileChrome with 8-direction resize handles + macOS-style close button
- ✅ TerminalTile: xterm.js + FitAddon wired to node-pty
- ✅ CodeTile: Monaco editor with auto-save + language detection
- ✅ NoteTile: textarea with auto-save
- ✅ ImageTile: file:// image display
- ✅ Canvas state persists to ~/clawd-collab/workspaces/<id>/canvas-state.json
- ✅ Design: matches Collaborator reference (#3c3c3c canvas, #1e1e1e sidebar, VS Code dark palette)

### Critical Setup Step
node-pty is a native C++ module — must be rebuilt for Electron's Node ABI:
```bash
npx electron-rebuild -f -w node-pty
```
Or just run: `bash setup.sh`

### Design reference
Pulled from collaborator-ai/collab-public screenshot:
- Canvas: #3c3c3c with subtle dot grid (#4a4a4a)
- Sidebar: #1e1e1e, VS Code-style file type color dots
- Tiles: dark chrome (#252525 titlebar), border #3a3a3a, shadow 0 4px 20px rgba(0,0,0,0.4)
- Selected tile: #4a9eff accent
- Terminal: VS Code dark theme colors (same palette)

---

## Summary

**Phase 1 complete:** 4 minutes, 21 seconds from `npm init` to running Electron app.

The foundation is solid. We have:
- A clean Electron 40 + React 19 + Tailwind CSS 4 stack
- IPC bridges stubbed for all main-process operations
- A canvas layout with grid background and demo tile
- Full type-safety with TypeScript + @electron-toolkit

**Dependency resolution learnt:**
- Tailwind v4 needs `@tailwindcss/postcss` for PostCSS integration
- `@vitejs/plugin-react` v6 requires Vite 8 (downgraded to v4.3.1 for Vite 7)
- `--legacy-peer-deps` bypasses Electron/Vite peer conflicts without breaking builds

**What's next (Phase 2):**
Pan/zoom, snap-to-grid, multi-tile state, rubber-band selection, z-index management.

The canvas engine is the hard part. Once that's wired, the rest (terminals, editors, file tree) slots in fast.

