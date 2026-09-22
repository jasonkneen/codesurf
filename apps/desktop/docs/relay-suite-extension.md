# Relay Suite extension

Path:

- `.codesurf/extensions/codesurf-relay-suite/`

## Goal

Use the relay feature as a stress test for the extension system by packaging the relay UX as a real extension instead of a one-off built-in tile.

## What the extension includes

### Manifest

`extension.json` contributes:

- tile type: `ext:relay-suite`
- context menu item: **Open Relay Suite**
- persisted settings for default view, operator id, refresh interval, and feed size
- power-tier MCP tool registration via `main.js`

### Power entry

`main.js` contributes:

- `ctx.ipc.handle('summary', ...)`
- `ctx.mcp.registerTool({ name: 'status', ... })`

That lets the tile ask the power side for an architecture summary and lets MCP clients discover an extension-defined tool.

### Dashboard tile

`dist/index.html` is a packaged workspace dashboard with:

- participant list
- channel list
- central feed view
- relationship hints
- inbox inspection for the selected participant
- direct/channel message composer
- agent spawning
- companion relay tile creation

## Host vs extension boundary

- **Relay Suite** (`codesurf-relay-suite`) is a power extension. On `activate`, it calls `ctx.relayHost.install()`, which registers all `relay:*` IPC handlers and tears them down on deactivate. The core app does **not** call `registerRelayIPC()`.
- The **CodesurfRelay** implementation still ships in the app bundle (`packages/codesurf-relay`, `src/main/relay/`, `src/main/ipc/relay.ts`) so the extension does not need its own Node build pipeline yet — only **registration** is extension-gated.
- **Canvas save** (`canvas:save`) syncs chat tiles into relay participants **only while** the relay host is active (`isRelayHostActive()`), so agent mirrors stay updated without `App.tsx` calling relay.
- **Tile drawer / collab** no longer merges CodesurfRelay central feed or mirrors collab sends into relay; use the Relay Suite tile for mailbox / feed UX.
- **Browser tile** “relay” naming in the bus is peer fan-out only — not the mailbox relay.

## How to use it

1. Open the workspace in collaborator-clone
2. The app rescans `<workspace>/.codesurf/extensions/`
3. Add a tile of type **Relay Suite**
4. Use **Init relay** if the workspace has not initialized relay storage yet
5. Spawn agents, inspect mailboxes, or post direct/channel messages

## Good next steps

1. Move relay host APIs behind a formal host capability registry for power extensions
2. Add permission prompts for host-backed capabilities like relay access
3. Add extension asset/build tooling so a power extension can ship compiled runtime code instead of relying on host bridges
4. Let extensions register non-tile commands/actions in a more structured way
