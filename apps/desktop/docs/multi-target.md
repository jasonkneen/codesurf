# CodeSurf multi-target architecture

CodeSurf runs on **three hosts** with **one React renderer** and **one shared daemon**.  
**Nothing is removed from Electron.** Web and Native are additive shells in the Agensis style.

## Surfaces

| Command | Shell | Backend | Capability |
| --- | --- | --- | --- |
| `npm run dev` | Electron | Electron main IPC + `codesurfd` | **Full** (terminals, extensions, node-pty, MCP…) |
| `npm run web:dev` | Browser (Vite `:5173`) | loopback `web-host` `:4177` + terminal gateway `:4178` | Core plus a scoped local terminal |
| `npm run web:preview` / `build:web` | Installed PWA (Chrome app / Safari Dock) | same local stack or a hosted sandbox ingress | Installable web app; terminal depends on its configured sandbox |
| `npm run desktop:dev` | Vercel Native WebView | Native-owned loopback sidecars | Core plus scoped terminal and native dialogs / openUrl |

Production:

| Command | Output |
| --- | --- |
| `npm run build` | Electron main + preload + renderer → `dist-electron/` |
| `npm run build:web` | Renderer only → `dist/` (browser + Native package assets) |
| `npm run desktop:build` | `build:web` + Native package → `desktop/zig-out/package/` |
| `npm run dist:mac` (etc.) | Electron installers (unchanged) |

## Layout

```
src/renderer/          shared UI (Electron + web + Native)
src/main/              Electron only (full product)
src/preload/           Electron only
packages/codesurf-daemon/   shared codesurfd
scripts/web-host.mjs   fixed-port host API for non-Electron
scripts/web-dev.mjs    browser dev loop
scripts/desktop-dev.mjs    Native shell dev loop
desktop/               Native SDK thin shell (app.zon + Zig)
vite.web.config.ts     standalone renderer for web/Native
electron.vite.config.ts    Electron (unchanged)
```

## Daemon module boundary

`packages/codesurf-daemon` is the single source authority for the shared daemon
and cross-host policy code. Electron, web, Native, and TUI adapters depend on its
compiled `@codesurf/daemon/*` exports; the package never imports root `src/`,
`test/`, or `scripts/` paths. Authored `bin/` modules are private implementation.
The only executable boundary is the `codesurfd` manifest bin; root
`bin/codesurfd.mjs` is a compatibility launcher with no daemon logic.

Package-owned unit and daemon integration tests live under
`packages/codesurf-daemon/test/`. Root tests cover host adapters and cross-surface
contracts only. The enforced maintenance gates are:

```bash
npm --prefix packages/codesurf-daemon test  # isolated package, dist, pack, runtime
npm run check:daemon-boundaries             # forbid host imports of package internals
npm run check:daemon-interface              # compare the recursive feature surface
```

Intentional interface changes require `npm run update:daemon-interface`. CI has
a daemon-only job that installs and tests the package before any root dependency
installation can mask an undeclared dependency.

## Data flow

```
┌──────────────┐     IPC      ┌─────────────┐
│  Electron UI │ ───────────► │ Electron    │──┐
└──────────────┘              │ main        │  │
                              └─────────────┘  │
┌──────────────┐   HTTP       ┌─────────────┐  │   ┌──────────┐
│ Browser UI   │ ───────────► │ web-host    │──┼──►│ codesurfd│
└──────────────┘              │ :4177       │  │   │ localhost│
┌──────────────┐   HTTP       └─────────────┘  │   └──────────┘
│ Native WebView│ ───────────►       ▲         │        │
└──────────────┘              Vite proxy /host │        ▼
                              and /d/*         │   ~/.codesurf/
                                      │
                                      │ session POST + WebSocket attach
                                      ▼
                          ┌─────────────────────┐
                          │ terminal gateway     │
                          │ :4178 / loopback     │
                          └─────────┬───────────┘
                                    │
                      local PTY (Native/dev) or Docker sandbox (hosted)
```

- Browser never sees the daemon bearer token. `web-host` injects `Authorization` on `/d/*`.
- `web-host` is **loopback-only**, has an exact-origin CORS policy, requires a per-launch host token for stateful routes, and limits filesystem access to registered project roots. It is not a public CORS proxy.
- The terminal gateway is a distinct capability boundary: a bearer creates a short-lived session, then an attach token is used once in the first WebSocket message. Neither credential is put in a URL.
- Canvas/settings for web live under the same `~/.codesurf/` trees Electron uses; settings writes are routed through daemon canonical settings APIs.
- Platform bridge (`src/renderer/src/platform`) installs `window.electron` only when preload did not.

## Capability matrix

| Feature | Electron | Web / Native |
| --- | --- | --- |
| Workspaces / projects | ✅ | ✅ (daemon) |
| Canvas load/save | ✅ | ✅ (web-host, same files) |
| Chat jobs / agents | ✅ | ✅ (daemon) |
| Sessions / checkpoints | ✅ | ✅ (daemon) |
| Settings | ✅ | ✅ (web-host) |
| Basic fs read/write | ✅ | ✅ (web-host, local only) |
| Terminals | ✅ | ✅ when a terminal gateway is configured; otherwise a visible unavailable state |
| Extensions / tiles | ✅ | ❌ stub |
| MCP HTTP tools | ✅ | partial (daemon paths) |
| Folder picker | native dialog | Native: `window.zero`; Web: OS dialog via `web-host` `/host/dialog/openFolder` (no `window.prompt`). Browser File System Access API is fallback for permission UX only. |

## PWA (Chrome desktop app + Safari)

Web builds include `vite-plugin-pwa`:

| Browser | Install path |
| --- | --- |
| Chrome / Edge (desktop) | Install icon in omnibox, or the in-app **Install CodeSurf** banner |
| Safari (macOS) | **File → Add to Dock** (or Share → Add to Dock) on the web origin |

```bash
npm run build:web
npm run web:preview       # starts loopback host + terminal broker + preview
# open http://127.0.0.1:4173 and install
```

Dev SW (optional): `CODESURF_PWA_DEV=1 npm run web:dev`

Service worker **never** caches `/host/*` or `/d/*` (always network to local daemon).

## Prerequisites (Native)

- Zig `0.16+`
- `native` CLI (`npm i -g @native-sdk/cli`)
- [zero-native](https://github.com/vercel-labs/zero-native) checkout  
  Default discovery: `NATIVE_SDK_PATH` or `~/Documents/GitHub/native`

## Env vars

| Var | Default | Role |
| --- | --- | --- |
| `CODESURF_HOME` | `~/.codesurf` | State root |
| `CODESURF_WEB_HOST_PORT` | `4177` | web-host bind port |
| `CODESURF_WEB_HOST_URL` / `VITE_CODESURF_HOST` | `http://127.0.0.1:4177` | Renderer → host |
| `CODESURF_WEB_HOST_TOKEN` | generated per launch | Required by local `/host/*` and `/d/*` routes; never put in a URL |
| `CODESURF_TERMINAL_ENDPOINT` | `http://127.0.0.1:4178` in dev/preview | Terminal gateway base URL |
| `CODESURF_TERMINAL_TOKEN` | generated per launch | Terminal gateway bearer; runtime-injected only |
| `CODESURF_TERMINAL_TENANTS_JSON` | required by gateway | Tenant roots/workspace mapping and bearer configuration |
| `CODESURF_DESKTOP_WORKSPACE_ROOT` | `~/.codesurf/workspaces` for packaged Native | Explicit root granted to the Native terminal sidecar; use it for arbitrary project folders |
| `NATIVE_SDK_PATH` | auto-discovered | Zig Native SDK |

Never provide either token through a `VITE_*` build variable. Development injects
them into the live HTML response; Native reads a 0600 runtime file through an
origin-restricted bridge. A hosted deployment should use an authenticated,
`Cache-Control: no-store` runtime configuration response for endpoint metadata
only and keep its long-lived tenant bearer in the proxy/backend.

## Hosted browser sandboxes

The hosted model is **one authenticated tenant per sandbox runtime**, not a
shared public proxy:

1. Serve the renderer and reverse-proxy `/host/*`, `/d/*`, and
   `/v1/terminal/*` from the same HTTPS origin.
2. Keep `web-host`, `codesurfd`, and the terminal gateway on loopback inside
   that tenant runtime. The ingress authenticates the user before proxying.
3. Configure a precise `CODESURF_TERMINAL_ALLOWED_ORIGINS` value, tenant roots,
   and session limits. The authenticated backend/reverse proxy forwards the
   browser's session request and injects the tenant bearer server-side; the
   browser receives only the single-use attach token.
4. Run local PTYs only inside an already-isolated tenant container/VM, or use
   the Docker adapter on a trusted worker. Do not mount a Docker socket into an
   Internet-facing gateway: it is effectively host-root access.

The terminal gateway Docker adapter disables network access, uses a read-only
container root, a small tmpfs, dropped capabilities, `no-new-privileges`, and
PID/CPU/memory limits; each terminal session gets its own container. See
[`packages/codesurf-terminal-gateway`](../packages/codesurf-terminal-gateway)
for the deployable gateway contract.

## What “nothing lost” means

1. **Electron remains the default full product.** All main/preload/IPC paths stay.
2. **Web and Native share one renderer build path** so UI work lands once.
3. **Daemon is the shared brain** for multi-host collaboration (TUI already used it).
4. **Gaps are explicit stubs**, not silent deletions — terminal/extension code still ships in Electron.

## Remaining platform limits

- Electron remains the only target with extension-host parity and arbitrary
  local filesystem/terminal capabilities.
- Native terminal access is intentionally root-scoped. macOS/Linux package a
  Node sidecar supervisor; Windows packaging fails explicitly until it has a
  signed `.exe` supervisor instead of producing a misleading terminal build.
- A multi-user hosted daemon needs identity/session ACL work beyond the
  single-tenant sandbox boundary described here.
