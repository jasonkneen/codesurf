# Electrobun Replacement Plan for CodeSurf

> For Hermes: if executing this plan, use small controlled bursts and commit after each burst only after Jason gives permission. Do not big-bang remove Electron.

Goal: replace CodeSurf's Electron shell with Electrobun while keeping the renderer UX and the `window.electron` app API stable during migration.

Active repo: `/Users/jkneen/clawd/collaborator-clone`
Verified identity: `package.json` name `codesurf`, productName `CodeSurf`, remote `https://github.com/jasonkneen/codesurf.git`.

Research snapshot:
- Electrobun latest stable from npm: `1.16.0`; beta: `1.17.3-beta.11`.
- Electrobun uses Bun for the main process and bundling, system native webview by default, optional CEF, and its own typed RPC between Bun and webviews.
- Official platform support in README: macOS 14+, Windows 11+, Ubuntu 22.04+.
- Current CodeSurf Electron footprint found live:
  - 221 `ipcMain.handle/on` registrations.
  - 344 renderer `window.electron` uses.
  - 28 main-process files import `ipcMain`.
  - 16 main-process files use `BrowserWindow` / `webContents` style broadcasting.
  - High-risk Electron APIs: `BrowserWindow`, `webContents.send`, `ipcMain`, `dialog`, `shell`, `session`, `protocol`, `net`, `nativeTheme`, `desktopCapturer`, `systemPreferences`, `Menu`, `electron-updater`, `webFrame`, `webUtils`, Electron `<webview>`.

Immediate compatibility findings:
- `node-pty` works under Bun in this repo: `bun -e import('node-pty')` succeeded.
- `sharp` works under Bun in this repo: `bun -e import('sharp')` succeeded.
- `better-sqlite3` does not work under Bun in this repo. Bun throws `ERR_DLOPEN_FAILED: 'better-sqlite3' is not yet supported in Bun`. The DB layer must move to `bun:sqlite`, a separate Node daemon/helper, or an alternate supported SQLite package before the Electron main process can be fully removed.

Conclusion:
Yes, Electrobun is implementable as the replacement shell, but not as a drop-in swap. CodeSurf should migrate through a dual-runtime adapter. The first target should be a parallel Electrobun shell that boots the current renderer and implements a small subset of `window.electron` via Electrobun RPC. Only after parity is proven should Electron packaging be removed.

Recommended architecture:

1. Keep renderer API stable during migration
   - Keep renderer call sites using `window.electron.*` initially.
   - Electron runtime continues using `src/preload/index.ts` and `ipcMain`.
   - Electrobun runtime injects a browser-side facade that exposes the same `window.electron` object, backed by typed Electrobun RPC.
   - This avoids touching 344 renderer call sites in the first burst.

2. Extract main handlers behind a runtime-neutral router
   - Introduce a small handler router contract, e.g.:

```ts
export type DesktopInvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>

export interface DesktopRouter {
  handle(channel: string, handler: DesktopInvokeHandler): void
  send(channel: string, payload?: unknown): void
  broadcast(channel: string, payload?: unknown): void
}
```

   - Convert each IPC module from direct `ipcMain.handle(...)` registration to `registerXHandlers(router)`.
   - Electron adapter maps `router.handle` to `ipcMain.handle` and `router.broadcast` to `BrowserWindow.getAllWindows().forEach(win => win.webContents.send(...))`.
   - Electrobun adapter maps `router.handle` to RPC request handlers and `router.broadcast` to RPC messages.

3. Electrobun shell lives beside Electron until parity
   - Add `electrobun.config.ts`.
   - Add `src/electrobun/bun/index.ts` for the Bun main process.
   - Add `src/electrobun/browser/index.ts` for the browser facade that creates `window.electron`.
   - Reuse the existing renderer build output first; do not rewrite React/Vite/Tailwind in burst 1.

4. Do the DB migration before full Bun-main cutover
   - Current `src/main/db/index.ts` uses `better-sqlite3` directly.
   - Option A: rewrite the DB abstraction to a tiny adapter supporting `better-sqlite3` on Node/Electron and `bun:sqlite` on Electrobun.
   - Option B: run all DB/indexer work in the existing daemon as a Node process and access it over local RPC.
   - Recommended: adapter first if query surface remains small; helper daemon if thread/job indexing grows heavier.

5. Browser tile requires a separate parity pass
   Current `BrowserTile.tsx` depends on Electron `<webview>` features that Electrobun's typed webview surface does not fully match:
   - Current use: `getURL()`, sync `canGoBack()/canGoForward()`, `isLoading()`, `stop()`, `setUserAgent()`, `insertCSS()`, promise-returning `executeJavaScript()`, `console-message`, `did-start-loading`, `did-stop-loading`, `did-fail-load`, `new-window`.
   - Electrobun webview type currently exposes: `loadURL`, `loadHTML`, `canGoBack()/canGoForward()` as promises, `goBack`, `goForward`, `reload`, `executeJavascript` void, limited navigation events, `new-window-open`, `host-message`, devtools, find-in-page, navigation rules.
   - Therefore BrowserTile either needs a `BrowserTileHost` adapter with graceful degraded behavior, or upstream Electrobun additions for missing APIs.
   - Use Electrobun CEF (`defaultRenderer: 'cef'`, `bundleCEF: true`) for browser-tile parity first. Native WKWebView/WebView2 can be revisited later for app-shell size wins.

6. Protocol handlers need replacement
   - Current Electron `protocol.handle` powers local asset/content schemes (`contex-file`, `contex-ext`).
   - Electrobun alternatives: copy assets into `views://`, serve local content through a locked-down `Bun.serve` loopback server, or use Electrobun navigation rules plus custom URLs.
   - Recommended first pass: loopback `Bun.serve` with signed/random runtime port for dynamic/local files; `views://` for static renderer assets.

7. Permissions and desktop capture need explicit spike
   - Current Electron uses `session.setPermissionRequestHandler`, `desktopCapturer.getSources`, and `systemPreferences.askForMediaAccess`.
   - Electrobun does not appear to expose direct equivalents in its public TypeScript APIs today.
   - If browser tile/screen capture/mic are required in Electrobun, expect either CEF flags/native patches or a feature request/upstream contribution.

Burst plan:

Burst 0: non-mutating spike already completed
- Verified repo identity.
- Researched Electrobun package/docs/API types.
- Verified Bun compatibility for `node-pty`, `sharp`, and `better-sqlite3`.
- Wrote this plan.

Burst 1: scaffold a parallel Electrobun runtime, no Electron removal
Files likely to add/modify:
- Add: `electrobun.config.ts`
- Add: `src/electrobun/bun/index.ts`
- Add: `src/electrobun/browser/index.ts`
- Add: `src/shared/desktop-rpc.ts`
- Modify: `package.json` scripts/dependencies only
Acceptance:
- `bun run build:renderer` still works.
- `bunx electrobun dev` opens a CodeSurf window with the current React renderer.
- Renderer can call minimal `window.electron.platform`, `window.electron.homedir`, `window.electron.shell.openExternal`, `window.electron.workspace.list` through Electrobun RPC.
- Existing Electron `npm run dev` remains untouched.

Burst 2: handler router extraction for low-risk domains
Files likely to modify:
- `src/main/ipc/workspace.ts`
- `src/main/ipc/fs.ts`
- `src/main/ipc/canvas.ts`
- `src/main/ipc/settings/ui/system` related modules
- Add Electron runtime adapter file, e.g. `src/main/runtime/electron-router.ts`
Acceptance:
- Existing Electron tests pass.
- Electrobun shell can load workspace list and canvas state.
- No renderer API call-site churn except typing.

Burst 3: event/broadcast parity
Files likely to modify:
- `src/main/utils/broadcast.ts`
- `src/main/event-bus.ts`
- `src/main/ipc/bus.ts`
- Electrobun RPC facade
Acceptance:
- `bus.publish`, `bus.subscribe`, `bus.onEvent`, workspace/window broadcasts work in both runtimes.
- Chat/session/sidebar event updates flow without Electron `webContents.send` assumptions.

Burst 4: DB/runtime compatibility
Files likely to modify:
- `src/main/db/index.ts`
- `src/main/db/migrations.ts`
- `src/main/db/thread-indexer.ts`
- `src/main/db/job-indexer.ts`
Acceptance:
- Same migrations apply under Electron Node and Electrobun Bun, or DB work is moved behind a daemon RPC boundary.
- Thread/job index tests pass.
- `bun -e` smoke can open the DB without `better-sqlite3`.

Burst 5: terminal/chat/daemon parity
Files likely to modify:
- `src/main/ipc/terminal.ts`
- `src/main/ipc/chat.ts`
- `src/main/daemon/manager.ts`
- `src/main/agent-stream.ts`
- `src/main/relay/service.ts`
Acceptance:
- `node-pty` terminal tile launches under Electrobun.
- Claude/Codex/OpenCode/Hermes chat streams update renderer via RPC messages.
- Daemon lifecycle paths work without `app.getAppPath()` assumptions.

Burst 6: BrowserTile Electrobun adapter
Files likely to modify:
- `src/renderer/src/components/BrowserTile.tsx`
- Add: `src/renderer/src/components/browser/BrowserTileHost.ts`
- Add Electrobun-specific webview declarations/types.
Acceptance:
- Navigation, back/forward/reload, new-window external handling, injected bus bridge, Cluso injection, dark background behavior work.
- If APIs are missing, file upstream Electrobun issue or patch local Electrobun fork before removing Electron.

Burst 7: packaging/updater replacement
Files likely to modify:
- `package.json`
- `electrobun.config.ts`
- release scripts/resources/icons
Acceptance:
- macOS app bundle builds.
- No reliance on `electron-builder`, `electron-updater`, `electron-rebuild`.
- Update story chosen: Electrobun updater or defer updater for first canary.

Verification commands:
- `npm run test`
- `npm run build`
- `bun -e "import('node-pty').then(() => console.log('node-pty ok'))"`
- `bun -e "import('sharp').then(() => console.log('sharp ok'))"`
- After DB adapter: Bun DB smoke for `getDbStatus()` equivalent.
- After Electrobun scaffold: `bunx electrobun dev`
- After packaging: `bunx electrobun build --targets=current` or project script equivalent.

Risk summary:
- Low risk: renderer Vite/React/Tailwind reuse; most app business logic is plain TS/Node and can move behind a router.
- Medium risk: IPC/router extraction due to large surface area; manageable if done one namespace at a time.
- High risk: `better-sqlite3` under Bun, browser tile parity, Electron protocol/session/permission APIs, updater replacement.
- Highest-risk user-visible area: BrowserTile, especially Cluso injection and remote web navigation state.

Recommended next step:
Implement Burst 1 only: scaffold the parallel Electrobun shell and a tiny RPC/facade, with Electron still untouched. If that boots, proceed namespace-by-namespace with small commits.
