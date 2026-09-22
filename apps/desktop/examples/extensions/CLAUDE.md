# Extension Development Workspace

You are building a CodeSurf extension. This directory is your ENTIRE working scope.

## CRITICAL FILE BOUNDARY

You MUST NOT read, write, edit, or reference files outside of:
```
examples/extensions/<your-extension-name>/
```

The main app (`src/`, `package.json`, `electron.vite.config.ts`, `*.config.*`, etc.) is
**completely off-limits**. Touching it will break the app for everyone.

The harness (`_harness/`) and other extensions are read-only references.

---

## Extension Structure

```
<extension-id>/
  extension.json       # manifest (required)
  main.js              # optional Node.js host process (for bus/MCP integration)
  tiles/
    <tile-name>/
      index.html       # tile UI (required per tile)
```

### extension.json

```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "What it does",
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

---

## Tile Bridge API (window.contex)

Each tile HTML page gets a `window.contex` bridge injected via postMessage RPC.
The bridge is available after the `contex-bridge-ready` message arrives:

```javascript
window.addEventListener('message', function(e) {
  if (e.data?.type === 'codesurf-bridge-ready') init()
})
if (window.contex) init()  // already ready (rare)
```

### Context — shared key-value state between linked tiles

```javascript
// Get a value (returns Promise)
const val = await window.contex.context.get('ctx:my-ext:selected')

// Set a value
await window.contex.context.set('ctx:my-ext:selected', { id: '123' })

// Get all values (optionally filtered by key prefix)
const all = await window.contex.context.getAll('ctx:my-ext')

// Delete a value
await window.contex.context.delete('ctx:my-ext:selected')

// Listen for changes from connected peer tiles
window.contex.context.onPeerContextChanged(({ key, value, peerId }) => {
  if (key === 'ctx:my-ext:selected') handleSelection(value)
})
```

### Bus — real-time pub/sub across the workspace

```javascript
// Publish an event
await window.contex.bus.publish('my-ext-channel', 'data', { foo: 'bar' })

// Subscribe to a channel (events arrive via contex-event messages)
await window.contex.bus.subscribe('my-ext-channel')

window.addEventListener('message', e => {
  if (e.data?.type === 'codesurf-event' && e.data?.event === 'bus.event.my-ext-channel') {
    handleBusEvent(e.data.data)
  }
})
```

### Actions — callable commands between tiles

```javascript
// Register an action this tile handles
await window.contex.actions.register('showItem', 'Show item by ID')

// Listen for incoming action invocations
window.addEventListener('message', e => {
  if (e.data?.type === 'codesurf-action-invoke') {
    if (e.data.action === 'showItem') handleShowItem(e.data.params)
    // Send result back
    window.parent.postMessage({ type: 'codesurf-action-result', tileId: TILE_ID, requestId: e.data.requestId, result: 'ok' }, '*')
  }
})

// Invoke an action on a peer tile
await window.contex.actions.invoke(peerId, 'showItem', { id: '123' })
```

### Settings

```javascript
const apiKey = await window.contex.settings.get('apiKey')
await window.contex.settings.set({ apiKey: 'new-value' })
```

### Tile metadata

```javascript
const meta = await window.contex.tile.getMeta()
// → { tileId, extId, extType, width, height, workspaceId, workspacePath, connectedPeers }

const size = await window.contex.tile.getSize()
// → { width, height }

// Listen for resize
window.addEventListener('message', e => {
  if (e.data?.type === 'codesurf-event' && e.data?.event === 'tile.resize') {
    const { width, height } = e.data.data
  }
})
```

### Canvas

```javascript
const tiles = await window.contex.canvas.listTiles()
const newTileId = await window.contex.canvas.createTile('ext:my-ext-main', { x: 100, y: 200 })
```

### Theme

```javascript
const colors = await window.contex.theme.getColors()
// → { background, panel, border, text, muted, accent }
```

### Extension invocation (ext.invoke)

```javascript
// Call a method exported from this extension's main.js
const result = await window.contex.ext.invoke('myMethod', arg1, arg2)
```

---

## main.js (Node.js host)

Optional. Runs in the Electron main process. Gets a `ctx` object:

```javascript
module.exports = {
  activate(ctx) {
    ctx.log('Extension started')

    // Publish to event bus
    ctx.bus.publish('my-ext-channel', 'data', { type: 'update', data: {} })

    // Register MCP tool (available to AI agents)
    ctx.mcp.registerTool({
      name: 'my_tool',
      description: 'Description for AI agents',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      handler: async ({ query }) => JSON.stringify({ result: 'data' }),
    })

    // Return cleanup function
    return () => ctx.log('Extension stopped')
  }
}
```

---

## Testing with the Harness

The harness simulates the entire host environment in a browser — no Electron needed.

```bash
cd examples/extensions/_harness
node server.mjs
# Open http://localhost:4040
```

In the harness:
1. Select your extension from the dropdown
2. Select a tile type
3. The tile renders in the preview pane
4. Use the panels to:
   - **RPC Log** — see every bridge call the tile makes
   - **Context** — set/view context values, simulate peer changes
   - **Bus** — send bus events to the tile
   - **Actions** — trigger registered actions, view action registrations

---

## Looking at existing extensions

Read-only reference examples:
- `pomodoro/` — timer with bus publish, MCP tool
- `system-monitor/` — Node.js stats, bus streaming
- `hq-email/` — multi-tile extension with context sharing
- `timer/` — minimal single-tile example
