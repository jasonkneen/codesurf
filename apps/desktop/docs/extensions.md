# Extensions in collaborator-clone

> **Building extensions?** See [extension-dev-harness.md](extension-dev-harness.md) for the
> isolated dev environment and the `/build-extensions` skill for AI-assisted batch building.

This repo now supports two extension locations:

- global: `~/.codesurf/extensions/<ext>/`
- workspace-local: `<workspace>/.codesurf/extensions/<ext>/`

The active workspace path is rescanned by the renderer hook, so dropping a folder
into `<workspace>/.codesurf/extensions/` is enough for local development.

## What an extension can contribute

Via `extension.json`:

- tiles
- chat surfaces (mounted above the chat composer)
- context menu items
- settings defaults
- declarative MCP tools
- optional `main.js` power-tier activation

## New pieces added in this pass

### 1. Workspace extension loading

`ExtensionRegistry.rescan(workspacePath)` now clears/reloads:

- global extensions
- active workspace extensions
- power-tier cleanup hooks
- programmatic MCP registrations

The renderer calls `window.electron.extensions.refresh(workspacePath)` from `src/renderer/src/hooks/useExtensions.ts`.

### 2. Extension-specific RPC

Renderer/preload now exposes:

- `window.electron.extensions.invoke(extId, method, ...args)`

Inside an extension iframe, the bridge exposes:

- `window.contex.ext.invoke(method, ...args)`

That maps to namespaced power-extension handlers registered with:

- `ctx.ipc.handle('methodName', handler)`
- actual IPC channel: `ext:<extId>:<methodName>`

### 3. Persisted extension settings

Extension settings are stored at:

- `~/.codesurf/extension-settings/<extId>.json`

Behavior:

- manifest defaults are merged on read
- only declared setting keys are persisted
- extension tiles access them via `window.contex.settings.get()` / `.set()`

### 4. Extension MCP tools are now wired into the server

The MCP server now merges host tools with extension-contributed tools from `ExtensionRegistry`.

Today, the fully usable path is:

- programmatic `ctx.mcp.registerTool(...)`

Manifest-declared tools can be listed, but they still need an execution story/handler to be truly useful. For real behavior, power-tier registration is the current path.

### 5. Canvas tile creation from extensions

The iframe bridge now supports:

- `window.contex.canvas.createTile(type, opts)`

This is wired through `ExtensionTile` into the renderer's native `addTile(...)` flow, so extensions can open companion tiles.

## Relay bridge surface currently exposed to extensions

For the relay suite exercise, `ExtensionTile` also forwards curated host APIs into the iframe bridge:

- `contex.relay.init()`
- `contex.relay.listParticipants()`
- `contex.relay.listChannels()`
- `contex.relay.listCentralFeed(limit)`
- `contex.relay.listMessages(participantId, mailbox, limit)`
- `contex.relay.readMessage(participantId, mailbox, filename)`
- `contex.relay.sendDirectMessage(from, draft)`
- `contex.relay.sendChannelMessage(from, draft)`
- `contex.relay.setWorkContext(participantId, work)`
- `contex.relay.analyzeRelationships()`
- `contex.relay.spawnAgent(request)`
- `contex.relay.stopAgent(participantId)`
- `contex.relay.waitForReady(ids, timeoutMs)`
- `contex.relay.waitForAny(ids, timeoutMs)`
- `contex.relay.onEvent(cb)`

This is intentionally a curated bridge, not a generic host IPC escape hatch.

## Current architectural limit

The relay dashboard is a **hybrid extension**:

- packaged as a workspace extension
- contributes its own tile, manifest, settings, IPC, and MCP hooks
- uses host-backed relay runtime APIs via the bridge

What is still missing for a fully externalized relay backend:

1. an extension build pipeline that can package JS/TS runtime code cleanly
2. a host capability API for power extensions to request richer internal services without bespoke bridge additions
3. a clearer permission model for host service access

## Example: Relay Suite

See:

- `.codesurf/extensions/codesurf-relay-suite/extension.json`
- `.codesurf/extensions/codesurf-relay-suite/main.js`
- `.codesurf/extensions/codesurf-relay-suite/dist/index.html`

That extension demonstrates:

- workspace-local packaging
- power-tier activation
- extension IPC via `ext.invoke('summary')`
- extension MCP tool registration
- persisted settings
- relay dashboard UI
- companion tile spawning

## Development tooling

### Dev harness

`examples/extensions/_harness/` is a standalone browser-based test environment that mocks the
full extension bridge. No Electron required.

```bash
cd examples/extensions/_harness && node server.mjs
# → http://localhost:4040
```

See [extension-dev-harness.md](extension-dev-harness.md) for full details: RPC log, context
simulation, bus event injection, action invocation, and what is vs. isn't simulated.

### /build-extensions skill

`.claude/commands/build-extensions.md` is a Claude Code skill for building multiple extensions
in parallel with isolated agents.

```
/build-extensions "Weather widget" "GitHub PR list" "Pomodoro v2"
```

Each agent is strictly constrained to its own `examples/extensions/<name>/` folder — the main
app source is never in scope. The `examples/extensions/CLAUDE.md` file enforces this boundary
and provides the full bridge API reference for agent use.
