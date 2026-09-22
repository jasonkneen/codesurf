# Electrobun Burst 1 Implementation Handoff

Repo: `/Users/jkneen/clawd/collaborator-clone`
Branch at implementation time: `main` (`origin/main`, ahead locally)

## What landed

Implemented the first parallel Electrobun runtime shell without removing Electron.

New/changed runtime paths:

- `electrobun.config.ts`
  - Electrobun app config for CodeSurf.
  - Uses app id `com.huggiapps.codesurf.electrobun` so it stays separate from the Electron app.
  - Copies the existing Electron/Vite renderer bundle from `dist-electron/renderer` into `views/mainview`.
  - Disables signing/notarization for this dev spike.

- `electrobun/bun/index.ts`
  - Bun-side Electrobun runtime entrypoint.
  - Creates a CodeSurf window and loads the existing renderer.
  - Injects a preload bridge at `views://codesurf-electrobun/index.js`.
  - Implements startup-critical `window.electron` calls via Electrobun typed RPC.
  - Currently supports workspace list/active, settings get/set, canvas/tile persistence, basic fs operations, shell open, window list/new/focus/close/title, bus publish basics, zoom, homedir, and safe fallback values for unimplemented channels.
  - Missing optional directories in `fs:readDir` return `[]` instead of noisy ENOENT warnings.

- `electrobun/browser/index.ts`
  - Browser/preload-side Electrobun bridge.
  - Defines Electrobun RPC and installs `globalThis.electron` before the renderer runs.
  - Preserves the existing renderer-facing `window.electron.*` shape as much as possible for this burst.

- `src/electrobun/browser/electron-facade.ts`
  - Runtime-neutral facade factory used by the Electrobun preload and by tests.
  - Maps existing renderer API calls to current Electron IPC channel names.
  - Provides startup-safe defaults for unsupported channels.

- `src/shared/electrobun-rpc.ts`
  - Shared RPC request/message schema types that do not import Electrobun package types, so the normal repo `tsc` path does not typecheck Electrobun internals.

- `test/electrobun-facade.test.ts`
  - Covers startup-critical facade channel mapping.
  - Covers event callback dispatch.
  - Covers fallback/default behavior.

- `package.json` / `bun.lock`
  - Added `electrobun@^1.16.0` and `@types/bun`.
  - Added scripts:
    - `npm run dev:electrobun`
    - `npm run build:electrobun`
    - `npm run run:electrobun`

## Verification run

Passed:

- `node --test test/electrobun-facade.test.ts`
- `npm run build`
- `bun run build:electrobun`
- Smoke boot: `CODESURF_ELECTROBUN_FORCE_BUNDLED=1 bun run run:electrobun`
  - Booted Electrobun launcher.
  - Started local Electrobun server.
  - Logged `CodeSurf Electrobun spike runtime started`.
  - Loaded bundled renderer path `views://mainview/index.html`.
  - Process was manually SIGTERM'd after boot verification.

Known non-blocking verification note:

- `npx tsc --noEmit --pretty false` still fails, but the remaining failures are pre-existing project/package typecheck errors. The new Electrobun runtime files were moved under root `electrobun/` so the normal `src/**/*.ts` tsc include does not pull Electrobun's own package TypeScript internals into the existing typecheck.

## Current remaining gaps

This is not full Electron parity yet. Electron remains the production baseline.

Major gaps:

1. Terminal tile is not wired to `node-pty` in Electrobun yet.
2. Chat provider streaming is not wired to the existing main-process provider implementations yet.
3. BrowserTile still depends on Electron `<webview>` APIs and needs a dedicated parity strategy.
4. MCP server/event bus integration is only minimally represented through safe bus fallbacks.
5. DB layer remains Electron/Node `better-sqlite3`; full Electron removal still requires a `bun:sqlite` or helper-process boundary.
6. Platform APIs (`protocol`, `session`, `desktopCapturer`, permissions, updater/build tooling) are still Electron-side.

## Suggested next burst

Next safe burst: extract a runtime-neutral terminal/session handler and wire Electrobun `terminal:create/write/resize/kill/onData/onExit/onActive` through the same facade pattern. Keep Electron IPC unchanged and add facade tests first.

Do not remove Electron or migrate BrowserTile in the next burst; terminal + filesystem/workspace parity is the better incremental confidence step.
