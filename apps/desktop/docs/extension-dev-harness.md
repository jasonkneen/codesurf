# Extension Dev Harness

Isolated development environment for building CodeSurf extensions without touching the main app.

## Problem it solves

Extension tile HTML communicates with the host app via a postMessage RPC bridge. Normally this
requires running the full Electron app. The harness is a standalone browser page that implements
the same bridge protocol, so you can build and test extensions with just:

```bash
cd examples/extensions/_harness && node server.mjs
```

Agents building extensions work strictly inside `examples/extensions/<name>/` — the `src/` tree
and all root configs are off-limits by convention (`examples/extensions/CLAUDE.md`) and by
explicit agent prompting.

## Running the harness

```bash
cd examples/extensions/_harness
node server.mjs          # default port 4040
node server.mjs 5000     # custom port
```

Open `http://localhost:4040` in any browser.

Quick validation from the repo root:

```bash
npm run validate-extension -- --all
npm run validate-extension -- examples/extensions/pomodoro
```

This checks `extension.json` structure, verifies referenced files exist, and confirms each tile
entry is served by the harness.

## Harness UI

**Toolbar**
- Extension dropdown — auto-discovers all `extension.json` files under `examples/extensions/`
- Mode dropdown — choose whether to load a contributed tile or a contributed chat surface
- Entry dropdown — populated from either `contributes.tiles` or `contributes.chatSurfaces`
- W/H inputs — preview size
- Load — renders the selected entry in an iframe at `/<ext-dir>/<entry>`
- Refresh — reloads the iframe without changing settings

**RPC Log tab** (default)  
Every `window.contex.*` call from the tile appears here in real time, with method name and
params. Color-coded: blue = RPC call, green = event, red = error.

**Context tab**  
Shows the current in-memory context store. Set a key/value and click "Set Context" to push it
into the store (the tile can read it via `window.contex.context.get(key)`).  
"Simulate Peer Change" fires a `context.peerChanged` event to the tile as if a connected peer
changed that key — useful for testing multi-tile context flows without a second tile.

**Bus tab**  
Send a bus event directly to the tile. Fill in the channel name and JSON payload, click "Send
to Tile". The "Subscribed Channels" list shows every channel the tile has called
`window.contex.bus.subscribe()` on.

**Actions tab**  
Lists every action the tile has registered via `window.contex.actions.register()`. Click "Run"
to populate the name field and invoke it. You can also manually fill in name + params JSON and
click "Invoke Action".

**Surface tab**  
Only relevant for chat surfaces. Shows the last payload emitted through
`window.contex.surface.setPayload(...)` and provides buttons to simulate the host-side
`surface.requestFlush` and `surface.clear` events.

## What the harness simulates

| Bridge API | Status | Notes |
|---|---|---|
| `context.get/set/getAll/delete` | Full | In-memory store, persists during session |
| `context.onPeerContextChanged` | Full | Triggered via "Simulate Peer Change" button |
| `bus.publish` | Logged | Calls appear in RPC log; no actual subscribers |
| `bus.subscribe` | Full | Channel shown in sidebar; events sent via Bus panel |
| `actions.register` | Full | Appears in Actions panel |
| `actions.invoke` | Logged | Logged; no real peer to invoke |
| `settings.get/set` | Full | Persisted in `localStorage` per ext ID |
| `tile.getMeta/getSize` | Full | Uses harness tile ID and W/H input values |
| `surface.setPayload` | Full | Captured in the Surface tab |
| `surface.requestFlush` | Full | Triggered from the Surface tab |
| `surface.clear` | Full | Triggered from the Surface tab |
| `tile.getState/setState` | Logged | Logged; no persistence |
| `canvas.listTiles` | Stub | Returns `[]` |
| `canvas.createTile` | Logged | Returns fake ID |
| `theme.getColors` | Full | Returns harness theme colours |
| `ext.invoke` | Logged | Logged; no main.js execution |
| `relay.*` | Stub | All relay methods return empty/false |
| `contex-bridge-ready` handshake | Full | Fires on iframe load, triggers resize event |
| `tile.resize` event | Full | Fired on load and when W/H inputs change |
| `contex-action-invoke` | Full | Triggered via Actions panel |

**Not simulated**: `main.js` (Node.js host process). The harness cannot run Node.js extension
code. Test `main.js` behavior by running the full app, or by testing the exported module
functions directly in a separate Node.js test script.

## Harness file layout

```
examples/extensions/_harness/
  server.mjs     # Static file server + /api/extensions discovery endpoint
  index.html     # Harness UI — single-file, no build step
```

The server serves `examples/extensions/` as its root. Extension entries are loaded at:
`http://localhost:4040/<ext-dir>/<entry-path>`

This works for both:
- tile entries from `contributes.tiles`
- chat-surface entries from `contributes.chatSurfaces`

## Isolated agent workflow

The `/build-extensions` skill (`.claude/commands/build-extensions.md`) orchestrates building
multiple extensions in parallel. Each extension gets one agent, constrained to its own folder.

```
/build-extensions "Weather widget" "GitHub PR list" "Pomodoro v2 with sounds"
```

This spawns three agents simultaneously, each building one extension independently. The
`examples/extensions/CLAUDE.md` file enforces the file boundary for agents working in that
directory — they are explicitly told not to touch anything outside their extension folder.

## Writing a new extension manually

1. Create `examples/extensions/<id>/extension.json` (see schema below)
2. Create one tile or chat surface entry HTML
3. Run the harness and load your extension in the desired mode
4. Iterate based on the RPC Log and Surface payload tab

### extension.json schema

```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "...",
  "main": "main.js",
  "contributes": {
    "tiles": [
      {
        "type": "my-ext-main",
        "label": "Main View",
        "entry": "tiles/main/index.html",
        "defaultSize": { "w": 400, "h": 300 },
        "minSize": { "w": 200, "h": 150 }
      }
    ],
    "chatSurfaces": [
      {
        "id": "my-ext-surface",
        "label": "Composer Surface",
        "entry": "surface/index.html",
        "emits": "text",
        "defaultHeight": 260,
        "minHeight": 160
      }
    ],
    "contextMenu": [
      { "label": "New My Ext", "action": "createTile", "tileType": "ext:my-ext-main" }
    ],
    "settings": [
      { "key": "apiKey", "label": "API Key", "type": "string", "default": "" }
    ],
    "context": {
      "produces": ["ctx:my-ext"],
      "consumes": ["ctx:task"]
    },
    "actions": [
      { "name": "doThing", "description": "Does a thing. Params: { id: string }" }
    ]
  },
  "permissions": ["network"]
}
```

### Minimal tile template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body { margin: 0; background: transparent; color: var(--ct-text, #111);
           font-family: system-ui; display: flex; align-items: center;
           justify-content: center; height: 100vh; }
  </style>
</head>
<body>
  <div id="app">Loading...</div>
  <script>
    var tileId = null

    function init() {
      // Get tile metadata
      rpc('tile.getMeta').then(function(meta) {
        tileId = meta.tileId
        document.getElementById('app').textContent = 'Hello from ' + meta.extId
      })
    }

    // Bridge handshake
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'codesurf-bridge-ready') init()
    })
    if (window.contex) init()

    // Minimal postMessage RPC helper
    var pending = {}
    var seq = 0
    function rpc(method, params) {
      return new Promise(function(resolve, reject) {
        var id = ++seq
        pending[id] = { resolve: resolve, reject: reject }
        window.parent.postMessage({ type: 'codesurf-rpc', id: id, tileId: tileId || 'unknown', method: method, params: params || null }, '*')
      })
    }
    window.addEventListener('message', function(e) {
      if (!e.data || e.data.type !== 'codesurf-rpc-response') return
      var cb = pending[e.data.id]
      if (!cb) return
      delete pending[e.data.id]
      if (e.data.error) cb.reject(new Error(e.data.error))
      else cb.resolve(e.data.result)
    })
  </script>
</body>
</html>
```

> In practice, the real app injects a richer `window.contex` bridge object with named methods
> (`window.contex.context.get(...)` etc.). The raw postMessage RPC above is the underlying
> transport both the real app and the harness implement.

## See also

- `examples/extensions/CLAUDE.md` — agent constraints + full bridge API reference
- `docs/extensions.md` — extension system architecture
- `.claude/commands/build-extensions.md` — the `/build-extensions` skill
- `src/renderer/src/components/ExtensionTile.tsx` — the real bridge implementation
