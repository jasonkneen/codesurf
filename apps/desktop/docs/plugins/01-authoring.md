# Authoring a CodeSurf Plugin (v2)

> Quickstart for the v2 plugin surface. The full architecture is in
> `00-architecture.md`. v1 `extension.json` plugins keep working unchanged — v2 is a
> strict superset (add `manifestVersion: 2` to opt in).

## The smallest plugin

Create `~/.codesurf/extensions/my-plugin/extension.json` (or
`<workspace>/.codesurf/extensions/my-plugin/extension.json`):

```jsonc
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "manifestVersion": 2,
  "tier": "safe",                 // safe = sandboxed iframe; power = trusted Node main.js
  "contributes": {
    "commands": [
      { "id": "my.hi", "title": "My: Say hi", "slash": "hi", "run": { "method": "hi" } }
    ],
    "footer": [
      { "id": "my.status", "label": "My", "position": "right" }
    ],
    "tiles": [
      { "type": "my-plugin", "label": "My Plugin", "icon": "box", "entry": "surface/index.html" }
    ]
  }
}
```

Drop the folder in, and it loads on next rescan. Your command shows in the Command
Palette (`⌘⇧P`) under "My"; the footer chip appears in the status bar and opens your
tile when clicked.

## Where a plugin can appear (surfaces)

| Contribution | Appears as |
|---|---|
| `commands[]` | Command Palette rows (`⌘⇧P`) + optional `/slash` in the composer |
| `footer[]` | status-bar chips (click → opens your tile) |
| `tiles[]` | canvas tiles (your view) |
| `chatSurfaces[]` | a panel mounted above the chat composer |
| `settingsSections[]` | a section in Settings → Plugins, rendered with the standard control kit |
| `layoutPresets[]` | "Layout: …" rows in the palette that build a saved arrangement |
| `contextMenu[]` | canvas/tile right-click items |
| `mcpTools[]` (power) | agent-callable tools |
| `agentExtensions[]` | shape the in-process agent (when that runtime lands) |

## Consistent UI for free

A `safe` (iframe) plugin's HTML automatically gets the host theme: the bridge injects
the `--ct-*` design tokens + a base stylesheet, so plain `<button>`/`<input>` already
look native. The host-rendered control kit is currently internal to the CodeSurf
renderer and is not a published `@codesurf/ui` package. External plugins should use
the injected tokens and standard HTML controls.

## settingsSections — declarative, themed controls

```jsonc
"settingsSections": [{
  "id": "my", "title": "My Plugin",
  "items": [
    { "kind": "toggle", "key": "loud", "label": "Loud mode", "default": false },
    { "kind": "select", "key": "tone", "label": "Tone", "default": "friendly",
      "options": [{ "value": "friendly", "label": "Friendly" }, { "value": "formal", "label": "Formal" }] },
    { "kind": "button", "label": "Run now", "command": "my.hi" }
  ]
}]
```

Values persist to `~/.codesurf/extension-settings/<id>.json` and are readable from the
iframe (`window.codesurf.settings.get(key)`) and power tier (`ctx.settings.get(key)`).

## Durable state (the Plugin Store)

Settings are for declared, user-editable keys. For arbitrary runtime state that must
survive reloads, use the store:

```js
// inside an iframe surface
const cx = window.codesurf            // (window.contex is a permanent alias)
await cx.store.set({ recents: ['a', 'b'] })
const { recents } = await cx.store.get()
cx.store.subscribe(state => render(state))   // live across views/windows
```

Power plugins use `ctx.store.get/set/replace/update/subscribe`. Backed by
`~/.codesurf/plugin-state/<id>.json` + the event bus.

## Layout presets

```jsonc
"layoutPresets": [{
  "id": "my.review", "title": "My Review",
  "layout": {
    "type": "split", "direction": "horizontal", "sizes": [30, 70],
    "children": [
      { "type": "leaf", "slots": [{ "tileType": "files", "label": "Files" }] },
      { "type": "leaf", "slots": [{ "tileType": "chat", "label": "Chat" }] }
    ]
  }
}]
```

Appears as "Layout: My Review" in `⌘⇧P`; selecting it builds the arrangement. `tileType`
accepts any built-in (`chat`, `terminal`, `code`, `files`, `note`, `browser`, …) or
`ext:<your-type>`.

## Typed authoring inside this repository

```ts
import { definePlugin } from '@codesurf/plugin'
export default definePlugin({
  id: 'my-plugin', name: 'My Plugin', version: '1.0.0', manifestVersion: 2,
  contributes: { commands: [{ id: 'my.hi', title: 'My: Say hi', slash: 'hi' }] },
})
```

The repository maps `@codesurf/plugin` to `packages/codesurf-plugin` during local
builds; it also exports `CodesurfBridge` to type `window.codesurf`. This package is
not currently documented as a public registry dependency. External plugins should
use `extension.json` and the runtime bridge until a published package is announced.

## Power tier (`tier: "power"` + `main.js`)

POWER plugins are native-code-equivalent dependencies. Non-bundled POWER
plugins run in an Electron utility-process child by default, which isolates a
crash from the main process but is **not a security sandbox**. Plugin code
retains ambient Node.js access, including filesystem, process spawning,
networking, environment variables, and arbitrary package imports.

Manifest capability requests and the grants recorded at enable time govern
access to brokered **CodeSurf APIs** such as canvas, relay, and host filesystem
methods. They do not confine Node built-ins such as `node:fs` or
`node:child_process`. Review POWER code as carefully as a native application
before enabling it. Bundled POWER plugins currently use the legacy in-main
path, and `CODESURF_POWER_BROKER=0` is an explicit compatibility escape hatch
that also selects that legacy path.

```js
module.exports = {
  activate(ctx) {
    ctx.mcp.registerTool({ name: 'do_thing', description: '…', inputSchema: {...}, handler: async (a) => '…' })
    ctx.ipc.handle('hi', async () => 'hello')        // callable from your iframe via window.codesurf.ext.invoke('hi')
    const off = ctx.store.subscribe(s => {})
    return () => off()                                // cleanup on deactivate
  }
}
```

## Dev loop

- **Plugin Studio** (`⌘⇧P` → "New: …" then the Plugin Studio tile, or context-menu
  "New Plugin Studio") scaffolds a manifest and opens a dev workspace.
- **Dev Sandbox** (`⌘⇧P` → "Open Dev Sandbox") opens an isolated, dashed-border
  instance to test a plugin without touching your real workspace.
```
