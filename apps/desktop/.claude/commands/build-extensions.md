---
name: build-extensions
description: Build CodeSurf extensions in isolation. Each gets its own agent working only in examples/extensions/<name>/
---

# Build Extensions

You are the orchestrator. Spawn one isolated Implementation Specialist agent per extension in parallel.
Do NOT build extensions yourself.

## Parse the request

Extract individual extension specs from the user args.
Each needs: id (kebab-case), name (human-readable), description (what it does).
If no args provided, ask the user what extensions to build.

## Spawn agents

For EACH extension, use the Agent tool:
- subagent_type: "Implementation Specialist"
- run_in_background: true
- name: "ext-builder-<id>"
- Use the agent prompt below with EXT_ID, EXT_NAME, EXT_DESCRIPTION substituted

## Agent prompt template

You are building the CodeSurf extension **EXT_NAME** (id: EXT_ID).

STRICT BOUNDARY: Only write files under examples/extensions/EXT_ID/
The main app (src/, root configs) is completely off-limits. Other extensions are read-only.

Goal: EXT_DESCRIPTION

Required files:
1. examples/extensions/EXT_ID/extension.json
2. examples/extensions/EXT_ID/tiles/<name>/index.html (at least one tile)
3. examples/extensions/EXT_ID/main.js (optional, for Node.js background work)

extension.json format:
{
  "id": "EXT_ID",
  "name": "EXT_NAME",
  "version": "1.0.0",
  "description": "...",
  "contributes": {
    "tiles": [{ "type": "EXT_ID-main", "label": "Main", "entry": "tiles/main/index.html", "defaultSize": {"w":400,"h":300}, "minSize": {"w":200,"h":150} }],
    "contextMenu": [{ "label": "New EXT_NAME", "action": "createTile", "tileType": "ext:EXT_ID-main" }]
  }
}

Bridge API (all window.contex methods are async Promises):
- Setup: window.addEventListener('message', e => { if (e.data?.type === 'contex-bridge-ready') init() }); if (window.contex) init()
- window.contex.context.get/set/getAll/delete(key, value?)
- window.contex.context.onPeerContextChanged(({ key, value, peerId }) => {})
- window.contex.bus.publish(channel, type, payload) / .subscribe(channel)
  Bus events arrive as postMessage: { type:'contex-event', event:'bus.event.<channel>', data }
- window.contex.actions.register(name, desc) / .invoke(peerId, action, params)
  Action calls arrive as: { type:'contex-action-invoke', action, params, requestId }
  Reply with: window.parent.postMessage({ type:'contex-action-result', tileId, requestId, result }, '*')
- window.contex.settings.get(key?) / .set(updates)
- window.contex.tile.getMeta() -> { tileId, extId, extType, width, height, workspaceId, connectedPeers }
- window.contex.canvas.listTiles() / .createTile(type, opts)
- window.contex.theme.getColors() -> { background, panel, border, text, muted, accent }
- window.contex.ext.invoke(method, ...args)

main.js (if needed for background work):
  module.exports = { activate(ctx) { ctx.bus.publish(...); ctx.mcp.registerTool({...}); return () => {} } }

Reference examples (read-only):
- examples/extensions/timer/ -- minimal
- examples/extensions/pomodoro/ -- bus + MCP tool
- examples/extensions/system-monitor/ -- Node.js main.js
- examples/extensions/hq-email/ -- multi-tile + context

Test with harness:
  cd examples/extensions/_harness && node server.mjs
  Open http://localhost:4040, select your extension, click Load

Done when:
- extension.json is valid JSON
- Tile renders in harness without console errors
- Core functionality works
- Zero files written outside examples/extensions/EXT_ID/

## After all agents complete

Report for each: name, files created, what was built.
Tell user: cd examples/extensions/_harness && node server.mjs to test at http://localhost:4040
