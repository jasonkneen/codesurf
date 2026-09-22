# CodeSurf Codex Thread Roadmap Existing Asset Map

This sidecar captures the reuse-first baseline for executing `.hermes/plans/2026-06-03_081146-codex-thread-feature-roadmap.md`.

## Active repo

- Path: `/Users/jkneen/clawd/collaborator-clone`
- Package: `codesurf`
- Product: `CodeSurf`
- Branch at planning start: `main`

## Current local work to preserve

Before implementation, the checkout already contained local edits outside this roadmap:

- `.codesurf/DREAMING.md`
- `.mcp.json`
- `electron.vite.config.ts`
- `index.js` (untracked)

Do not overwrite, reset, stage, or commit these unless Jason explicitly asks.

## Reuse-first architecture seams

### Browser / QA foundation

Use the existing browser stack rather than replacing it:

- `src/renderer/src/components/BrowserTile.tsx`
- `src/main/ipc/browserTile.ts`
- `src/preload/index.ts` `browserTile` bridge
- `src/renderer/src/env.d.ts` browser bridge types
- Electron webview, Electrobun webview, and iframe fallback compatibility paths already in `BrowserTile.tsx`

First roadmap burst should add evidence capture to these paths before building a QA workbench.

### Chat and chat-native tools

Do not rebuild the chat host. Extend the existing chat-surface path:

- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`
- `src/renderer/src/components/chat/ChatComposerControls.tsx`
- `src/renderer/src/components/chat/ChatComposerMenus.tsx`
- `src/renderer/src/components/chatSurfaceHostRpc.ts`
- `src/main/extensions/bridge.ts`
- `src/main/extensions/registry.ts`
- `src/main/ipc/extensions.ts`

Bundled chat surfaces already provide product seams to build on:

- `bundled-extensions/builder`
- `bundled-extensions/sketch`
- `bundled-extensions/context-deck`
- `bundled-extensions/rewind-lite`

### Agent orchestration and canvas state

Do not duplicate the MCP/event-bus/Kanban stack. Build orchestration on:

- `src/main/mcp-server.ts`
- `src/main/event-bus.ts`
- `src/renderer/src/components/KanbanTile.tsx`
- `examples/extensions/agent-kanban`
- `src/renderer/src/components/chat/PlanPane.tsx`

### Existing extension prototypes to promote later

Promote and harden when their phase arrives instead of rewriting:

- `examples/extensions/source-control` for git graph/review workbench
- `examples/extensions/code-index` for repo context/index map
- `examples/extensions/artifact-builder` as reference only; use bundled `builder` for shipped chat-native UX

### Mini chat / focused management

Mini chat already exists and should be extended, not recreated:

- `src/main/index.ts` `window:openMiniChat`
- `src/preload/index.ts` `window.openMiniChat`
- `src/renderer/src/App.tsx` mini chat route branch
- `src/renderer/src/components/Sidebar.tsx` mini-window affordance

### Electrobun compatibility

Keep Electron as the primary implementation path. Mirror renderer-facing APIs after Electron path is stable:

- `src/electrobun/browser/electron-facade.ts`
- `electrobun/bun/index.ts`
- `src/shared/electrobun-rpc.ts`

## First controlled burst target

1. Add shared browser evidence types and ring-buffer helper.
2. Add tests that fail before the helper exists.
3. Capture console/load-failure evidence in `src/main/ipc/browserTile.ts`.
4. Keep UI/workbench changes out of this burst.
5. Verify with focused tests, `npm run typecheck:go`, and `npm test`.
