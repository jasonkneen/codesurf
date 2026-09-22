# OWL — Split-Host Browser Runtime

> CodeSurf's out-of-process browser runtime. A dedicated Electron host process owns the
> browser engine; the main app drives it as a client over a line-delimited JSON-RPC
> channel. Modelled on OpenAI's **OWL ("OpenAI's Web Layer")** — the architecture behind
> the Atlas browser — adapted to Electron.
>
> Status: **engine complete and tested; no UI consumer yet.** The host, supervisor, IPC,
> and preload bridge all work (`test/hosts/owl-host-integration.test.mjs`, 16/16). Nothing in
> the renderer calls it — wiring OWL into a canvas tile is the open follow-up (§7).

---

## 0. What OWL is (and what it copies from Atlas)

OpenAI's Atlas browser runs Chromium **as an independent process outside the main app**
and drives it as a client — the app is the "OWL client", Chromium is the "OWL host".
CodeSurf's OWL mirrors that **architecture**, not the implementation:

| Concern | OpenAI OWL (Atlas) | CodeSurf OWL (this repo) |
|---|---|---|
| Engine | Raw Chromium | Electron (Chromium-wrapped) |
| Out-of-process host | ✅ Chromium as a service | ✅ child Electron process (`--codesurf-owl-host`) |
| Client/host split | ✅ Atlas ↔ Chromium | ✅ supervisor ↔ host process |
| IPC transport | Mojo + Swift bindings | **line-delimited JSON-RPC over stdio** |
| Display | GPU compositing / zero-copy surface | **`capturePage()` → PNG → base64** |
| Input | NSEvent → Blink `WebInputEvent` (Swift) | generic event → Electron `sendInputEvent` |
| Platform | macOS-native | cross-platform (Electron) |

The shared idea — **a crash-isolated browser engine in its own process, driven by a thin
client over a well-defined contract** — is faithfully reproduced. The mechanics (transport,
display, engine) are deliberately simpler. See §6 for what closing the gap to Atlas takes.

---

## 1. Topology

```
 main process (client)                 child process (host)
 ─────────────────────                 ────────────────────
 renderer  ──IPC──►  StdioOwlHost  ──spawn(--codesurf-owl-host)──►  ElectronOwlHost
 window.electron.owl  Supervisor    ◄──── JSON-RPC over stdio ────►   (offscreen
                      (singleton)                                      BrowserWindows)
```

- **Client** lives in the main process: the IPC handlers (`owl:*`) call a singleton
  `StdioOwlHostSupervisor`, which owns the child process and the JSON-RPC peer.
- **Host** is the *same packaged binary* relaunched with `CODESURF_OWL_HOST=1` /
  `--codesurf-owl-host`. It runs `ElectronOwlHost`, which owns the actual offscreen
  `BrowserWindow`s, one per OWL webview.
- One host process supervises **all** webviews across all tiles/agents — it is a singleton.

All code lives in `src/main/owl/runtime.ts`. The packaged-runtime marker is
`resources/owl-electron-app.json` (`runtimeName: owl`, `hostKind: electron`).

---

## 2. The JSON-RPC contract

Transport: each message is one JSON object terminated by `\n` on the child's stdin/stdout
(`JsonRpcPeer`). Requests carry an incrementing numeric `id`; the host replies with
`result` or `error`. Client calls default to a 15 s timeout.

| Method | Params | Returns |
|---|---|---|
| `health` | — | `{ ok, runtime: 'electron', pid }` |
| `session.create` | `appName` (req), `buildFlavor?` | `OwlSessionRecord` |
| `profile.create` | `sessionId` (req), `name?`, `persistent?`, `storageKey?`, `isolateForAgent?` | `OwlProfileRecord` |
| `webview.create` | `profileId` (req), `initialUrl?`, `width?`, `height?`, `deviceScaleFactor?`, `visible?` | `OwlWebViewRecord` |
| `webview.navigate` | `webViewId`, `url` | `OwlWebViewRecord` |
| `webview.setGeometry` | `webViewId`, `width`, `height`, `deviceScaleFactor?` | `OwlWebViewRecord` |
| `webview.dispatchInput` | `webViewId`, `route?` (`content`\|`browser`), `event` | `{ accepted, returnedToClient }` |
| `webview.capture` | `webViewId`, `includePopups?` | `{ webViewId, mimeType: 'image/png', dataBase64, width, height }` |
| `webview.destroy` | `webViewId` | `{ ok: true }` |
| `plugin.list` | — | `{ plugins: [] }` (stub) |

Unknown methods reject with `Unknown OWL method: <name>`. Validation errors reject with a
descriptive message (e.g. `appName must be a non-empty string`, `Unknown session: …`).

### Data model

- **Session** (`OwlSessionRecord`) — a top-level grouping (`appName`, `buildFlavor`).
- **Profile** (`OwlProfileRecord`) — a storage identity backed by an Electron `session`
  partition:
  - `persistent: true` **and not** `isolateForAgent` → `persist:owl:<storageKey>`
    (cookies/storage survive across runs).
  - otherwise → `owl:memory:<storageKey>` (ephemeral; `isolateForAgent` forces this even
    if `persistent` was requested — agent sandboxes never persist).
- **WebView** (`OwlWebViewRecord`) — one offscreen `BrowserWindow` bound to a profile's
  partition.

### Input translation

`webview.dispatchInput` with `route: 'browser'` is a deliberate no-op
(`{ accepted: false, returnedToClient: true }`) — it signals the *renderer* should handle
that event. Otherwise the generic `OwlInputEvent` is mapped to an Electron input event:

- `mouseDown` / `mouseUp` / `mouseMove` → `{ type, x, y, button }`
- `keyDown` / `keyUp` → `{ type, keyCode: key, modifiers }`
- `text` → `{ type: 'char', keyCode: text }`

---

## 3. Webview security posture

Every OWL `BrowserWindow` is created with (see `createWebView`):

- `offscreen: true` — never visible unless `CODESURF_OWL_HOST_SHOW_WINDOWS=1` **and** the
  webview was created with `visible: true` (debug aid only).
- `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`,
  `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`.
- `setWindowOpenHandler(() => ({ action: 'deny' }))` — popups are denied.
- Per-profile `partition` isolation.

Capture and input cross only the local stdio channel — no network surface is added.

---

## 4. Lifecycle

1. **Lazy start.** The supervisor spawns the host on the *first* `owl:*` IPC call
   (`getOwlSupervisor().call(...)`), not at app boot. No OWL log lines at startup means it
   was simply never asked to do anything.
2. **Child spawn.** `process.execPath` is relaunched with
   `process.defaultApp ? [app.getAppPath(), '--codesurf-owl-host'] : ['--codesurf-owl-host']`
   and `CODESURF_OWL_HOST=1`. In dev (`defaultApp` true) it re-runs the app entry with the
   flag; packaged (`defaultApp` false) it runs the packaged binary with the flag. Both hit
   `isOwlHostProcess()` → `runOwlHostProcess()`.
3. **Handshake.** The supervisor issues `health` (5 s) before resolving `start()`.
4. **Teardown.** `stopOwlSupervisor()` ends the child's stdin and sends `SIGTERM`; the host
   handles `SIGTERM`/stdin-`end` → `app.quit()`, destroying all webviews. The supervisor is
   stopped on app quit (`src/main/index.ts`).

If the child dies, the JSON-RPC peer rejects all pending calls with the exit code, signal,
and the tail of the child's stderr (`getStderrTail()`).

---

## 5. Wiring (where each piece lives)

| Layer | Symbol / channel | File |
|---|---|---|
| Host process detection | `isOwlHostProcess()` | `src/main/owl/runtime.ts` |
| Host entry | `runOwlHostProcess()` | `src/main/owl/runtime.ts` |
| Host impl | `ElectronOwlHost` | `src/main/owl/runtime.ts` |
| Supervisor (client) | `StdioOwlHostSupervisor`, `getOwlSupervisor()`, `stopOwlSupervisor()` | `src/main/owl/runtime.ts` |
| JSON-RPC | `JsonRpcPeer` | `src/main/owl/runtime.ts` |
| Process branch | `if (isOwlHost) runOwlHostProcess() else <app>` | `src/main/index.ts` |
| IPC handlers | `owl:health`, `owl:session:create`, `owl:profile:create`, `owl:webview:*`, `owl:stop` | `src/main/index.ts` (`registerOwlIPC`) |
| Preload bridge | `window.electron.owl.{health,createSession,createProfile,createWebView,navigate,setGeometry,dispatchInput,capture,destroy,stop}` | `src/preload/index.ts` |
| Renderer types | `Window['electron']['owl']` | `src/renderer/src/env.d.ts` |

The IPC layer fills defaults: `owl:session:create` defaults `appName` to `APP_NAME` and
`buildFlavor` to `app.isPackaged ? 'prod' : 'dev'`.

---

## 6. Testing

`test/hosts/owl-host-integration.test.mjs` spawns the **real** built host
(`electron .` with `CODESURF_OWL_HOST=1`), drives the full method surface over stdio
JSON-RPC, and asserts on every response — including verifying `webview.capture` returns a
real PNG (magic-byte check), profile-partition routing, and the post-destroy error path.

```bash
npm run build:main          # the test runs against dist-electron/main/index.js
node --test test/hosts/owl-host-integration.test.mjs
```

The test acts *as* the supervisor (it spawns the child and speaks JSON-RPC directly), so it
covers the host contract. The supervisor's own spawn/handshake path is exercised end-to-end
only through the running app (lazy-start on the first `owl:*` IPC). To smoke that in dev,
trigger a call from the renderer devtools console:

```js
await window.electron.owl.health()
```

---

## 7. Status and the path to Atlas parity

**Today:** the engine is complete and tested. `window.electron.owl.*` is exposed but **no
renderer code calls it** — OWL is engine-only scaffolding. The natural first consumer is an
interactive "OWL browser tile" (live framebuffer + forwarded input); that design is parked,
not built.

**Closing the gap to Atlas** (and keeping the cross-platform Electron build — yes, you can:
the JSON-RPC contract is the platform seam):

- **Phase 0 — make the Electron host fast (cross-platform, no native code).** Replace
  poll-based `capturePage()` PNG streaming with Electron's GPU offscreen rendering using
  shared textures (`webPreferences.offscreen: { useSharedTexture: true }`, the `'paint'`
  event), and move pixel data off the stdio JSON-RPC line onto a dedicated binary channel.
  This is the closest Electron gets to Atlas's surface-sharing.
- **Phase 1 — formalize the seam.** Promote `OwlHost` to an interface and select the
  backend by `process.platform` + a flag, so a second backend is purely additive.
- **Phase 2 — *(optional, macOS-only)* a native host.** A native helper hosting Chromium
  with IOSurface sharing into the renderer. High effort; only worth it if real-time browser
  fidelity becomes the core product. The Electron host stays the default everywhere else.

---

## 8. Glossary

- **OWL** — "OpenAI's Web Layer." Here: CodeSurf's split-host browser runtime that borrows
  the architecture.
- **Host** — the child Electron process running `ElectronOwlHost`; owns the browser engine.
- **Client / supervisor** — `StdioOwlHostSupervisor` in the main process; spawns and drives
  the host.
- **Profile** — an Electron `session` partition; persistent or ephemeral (agent-isolated).
- **WebView** — one offscreen `BrowserWindow` bound to a profile.
