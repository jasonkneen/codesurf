# CodeSurf Native desktop shell

The Native SDK shell is a thin desktop host around the same React build used by
the browser. Electron remains intact and remains the full IPC-compatible
desktop path.

| Surface | Shell | Backend | Terminal |
| --- | --- | --- | --- |
| `npm run dev` | Electron | Electron main + daemon | Electron/node-pty |
| `npm run web:dev` | Browser | selected local/hosted backend | browser restrictions apply |
| `npm run desktop:dev` | Native WebView | local Node sidecar | loopback terminal gateway |
| `npm run desktop:build` | packaged Native app | packaged Node sidecar | loopback terminal gateway |

## Layout

| Path | Role |
| --- | --- |
| `app.zon` | Native identity, window chrome, and manifest-safe frontend path |
| `frontend/` | Generated staging copy of root `dist/`; ignored by Git |
| `sidecar/supervisor.mjs` | Starts/stops loopback web-host and terminal gateway |
| `src/main.zig` | WebView source, dialogs, and restricted runtime-config bridge |
| `../scripts/desktop-sidecar.mjs` | Staging, package decoration, and sidecar assertions |
| `../dist/` | Root browser build input; never referenced directly by `app.zon` |

`app.zon` intentionally names `frontend`, not `../dist`: the Native SDK rejects
parent-escaping manifest paths. `desktop:build` stages `dist/` before running
`native validate app.zon`.

## Development

```bash
npm run desktop:dev
```

The command starts a single supervisor, waits for a private runtime config,
then starts Vite and the Native shell. It scopes the local terminal gateway to
this repository. To use a different local project deliberately:

```bash
CODESURF_DESKTOP_WORKSPACE_ROOT=/absolute/project/path npm run desktop:dev
```

Never set that value to `/` just to make a terminal work.

## Packaging

```bash
npm run desktop:build
```

The release path does all of the following:

1. Builds the web renderer and copies it into `desktop/frontend/`.
2. Runs `native validate app.zon` before packaging.
3. Copies a Node runtime, `web-host`, `codesurfd`, the terminal gateway, and
   their production dependency closure into the Native bundle.
4. Replaces the package entry with a relocatable compiled Zig launcher,
   preserving the real Native WebView executable as `codesurf-native`.
5. Checks the required sidecar files and ad-hoc signs/verifies the final macOS
   bundle.

The current Native SDK asset packager rejects an individual file at 16 MiB.
CodeSurf’s optional local voice-detection WASM variants are larger, so the
packager supplies Native a filtered staging tree and then copies those static
files into `Resources/frontend` before the final signature. They remain in the
same paths the WebView serves at runtime; no feature is removed from the
Native build.

The Node executable copied into the package defaults to the Node process that
ran `desktop:build`. A release pipeline can provide an audited, target-matched
runtime explicitly:

```bash
CODESURF_DESKTOP_NODE_RUNTIME=/absolute/path/to/node npm run desktop:build
```

On macOS that binary must be self-contained and match the build architecture
(an official or NVM Node build is appropriate). Homebrew Node binaries link to
cellar dylibs and are rejected by the packager rather than creating a bundle
that only works on the build host.

A packaged app never silently falls back to `node` on `PATH`. For local
development/recovery only, opt in explicitly with
`CODESURF_DESKTOP_ALLOW_SYSTEM_NODE=1` (and optionally
`CODESURF_DESKTOP_NODE_RUNTIME=/path/to/node`).

Native terminal packaging currently supports macOS and Linux. Windows builds
fail before packaging because they need a signed `.exe` supervisor; producing a
Native package with a non-working terminal would be misleading.

## Runtime contract

At launch, the packaged supervisor starts these child processes with its
packaged Node runtime:

```text
Compiled Native launcher
  └─ sidecar supervisor
       ├─ terminal gateway  (127.0.0.1, ephemeral port)
       ├─ web-host          (127.0.0.1, ephemeral port)
       └─ codesurf Native executable
```

The terminal gateway receives a per-launch random token and an explicit
single-tenant configuration. Its root is:

- `CODESURF_DESKTOP_WORKSPACE_ROOT` when supplied; otherwise
- `${CODESURF_HOME:-~/.codesurf}/workspaces`.

That default deliberately does not grant access to all of `$HOME` or `/`.
Arbitrary local projects need the explicit environment variable until the
product’s project-selection flow updates the sidecar scope.

The web-host atomically writes a mode-`0600` file at
`CODESURF_RUNTIME_CONFIG_PATH` with exactly this renderer-facing shape:

```json
{
  "hostBase": "http://127.0.0.1:…",
  "hostToken": "…",
  "terminal": {
    "endpoint": "http://127.0.0.1:…",
    "token": "…"
  }
}
```

The Native renderer reads that data only through:

```js
window.zero.invoke('codesurf.runtime.getConfig', {})
```

The bridge command is restricted to `zero://app` in a package and to the two
documented Vite origins during Native development, accepts no caller-supplied
file path, strips malformed/non-loopback values, and never logs tokens. The
browser transport must use the returned host token as its host-auth header; no
token belongs in the renderer build, a URL, or a generic CORS proxy.

## Native bridge

| Need | API |
| --- | --- |
| Runtime host/terminal config | `window.zero.invoke('codesurf.runtime.getConfig', {})` |
| Folder / file picker | `window.zero.invoke('native-sdk.dialog.openFile', { allowDirectories: true })` |
| Native shell detect | `Boolean(window.zero)` |
| External links | Native `open_system_browser` policy |

The Native bridge supplements the renderer platform bridge. Nothing in
Electron main/preload is removed or gated off.
