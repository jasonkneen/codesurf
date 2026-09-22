# Local Models Backend Lifecycle Implementation Plan

> For Hermes: use subagent-driven-development if executing this later. Keep the burst surgical. Do not touch unrelated CodeSurf architecture.

Goal
- Turn `examples/extensions/local-models` from a static endpoint browser into a real backend-managed extension that can start, stop, and report on a local model daemon safely.

Architecture
- Keep the existing local-models tile UI as the user-facing shell.
- Add a `main.js` host process for the extension and expose lifecycle/status through `ext.invoke(...)`.
- Do not build a full Genspark-style subsystem. Only lift the parts that count in CodeSurf: daemon lifecycle, dynamic port selection, health checks, and clean shutdown.

Tech stack
- Existing CodeSurf extension host (`main.js` activate(ctx))
- Existing renderer bridge (`ext.invoke`, `settings.get`, `settings.set`, `workspace.getPath`)
- Node child_process + fs + net in extension host

Non-goals for this burst
- No browser shell work
- No Hugging Face downloader yet
- No chat-surface UI for local-models yet
- No model execution orchestration in ChatTile yet
- No provider/runtime changes outside this extension

---

## What exists today

Current local-models extension:
- `examples/extensions/local-models/extension.json`
- `examples/extensions/local-models/tiles/models/index.html`

Current behavior:
- The tile keeps local selected-model state in context keys:
  - `ctx:models:active-model`
  - `ctx:models:inference-models`
- It hydrates from peer context from model-hub
- It probes endpoints directly with `fetch(..., { mode: 'no-cors' })`
- It does not have a backend `main.js`
- It does not own daemon lifecycle

Important existing seams we should reuse:
- `ext.invoke(...)` is supported in extension tiles and chat surfaces
- `settings.get` / `settings.set` are supported
- `workspace.getPath()` is supported

---

## Desired outcome for this burst

After this burst, Local Models should:
1. Have a backend `main.js`
2. Persist settings for daemon config
3. Start a daemon on a free port
4. Stop the daemon cleanly
5. Report health and effective endpoint via `ext.invoke`
6. Let the tile read status from the extension host instead of blind browser fetch probes
7. Leave the rest of CodeSurf untouched

---

## Files likely to touch

Create:
- `examples/extensions/local-models/main.js`

Modify:
- `examples/extensions/local-models/extension.json`
- `examples/extensions/local-models/tiles/models/index.html`

Optional later, NOT in this burst:
- `examples/extensions/local-models/surface/index.html`

---

## API design for the extension host

Add these extension-host methods callable through `ext.invoke`:

- `getStatus()`
  - Returns:
    - `running: boolean`
    - `healthy: boolean`
    - `host: string`
    - `port: number | null`
    - `pid: number | null`
    - `selectedModel: object | null`
    - `lastError: string | null`

- `startDaemon(opts?)`
  - Starts the configured backend on a free port
  - Returns fresh status

- `stopDaemon()`
  - Stops backend
  - Returns fresh status

- `setSelectedModel(model)`
  - Mirrors current tile context behavior, but stores canonical host-side state too
  - Returns fresh status

- `getSelectedModel()`
  - Returns canonical host-side selected model

- `setConfig(partial)`
  - Updates settings-backed config
  - Example fields:
    - `command`
    - `args`
    - `basePort`
    - `healthPath`
    - `modelsDir`
  - Returns normalized config

- `getConfig()`
  - Returns normalized config

Recommended default config shape:
```js
{
  command: '',
  args: [],
  basePort: 11435,
  healthPath: '/health',
  modelsDir: '',
}
```

Important rule
- If `command` is empty, host returns status with `running:false`, `healthy:false`, and a helpful `lastError`, but does not crash.

---

## Burst plan

### Task 1: Add host entry to the manifest

Objective:
- Make Local Models a backend-capable extension.

Files:
- Modify: `examples/extensions/local-models/extension.json`

Change:
- Add:
```json
"main": "main.js"
```

Also add initial settings entries:
```json
"settings": [
  { "key": "command", "label": "Daemon Command", "type": "string", "default": "" },
  { "key": "args", "label": "Daemon Args (space separated)", "type": "string", "default": "" },
  { "key": "basePort", "label": "Base Port", "type": "number", "default": 11435 },
  { "key": "healthPath", "label": "Health Path", "type": "string", "default": "/health" },
  { "key": "modelsDir", "label": "Models Directory", "type": "string", "default": "" }
]
```

Verification:
- Run:
```bash
node scripts/validate-extension.mjs examples/extensions/local-models
```
Expected:
- pass

### Task 2: Add a minimal extension host with status-only behavior

Objective:
- Create a backend process that can answer `getStatus`, `getConfig`, and `setConfig` before any spawn logic exists.

Files:
- Create: `examples/extensions/local-models/main.js`

Minimal behavior:
- `activate(ctx)`
- read settings from `ctx.settings` if available through host APIs, or keep an in-memory fallback if the extension host surface only expects UI-side settings initially
- register IPC methods with `ctx.ipc.handle`
- return static status with no daemon

Verification:
- Validate extension
- Open extension tile in harness/app
- From tile, `ext.invoke('getStatus')` returns an object

### Task 3: Add free-port selection utility in `main.js`

Objective:
- Reuse the proven dynamic-port lesson from Genspark without dragging in app-specific code.

Files:
- Modify: `examples/extensions/local-models/main.js`

Implementation notes:
- Use Node `net.createServer()` probe loop
- Search from `basePort` upward for max 50 ports
- Return selected port before spawning

Verification:
- `startDaemon()` with a fake command still reports selected port in error/status path

### Task 4: Add daemon spawn + clean stop

Objective:
- Start and stop a child process safely.

Files:
- Modify: `examples/extensions/local-models/main.js`

Implementation:
- Use `spawn(command, args, { env })`
- Track `child`, `pid`, `host`, `port`, `lastError`
- On stop:
  - SIGTERM first
  - bounded wait
  - SIGKILL only if needed
- Do not log shutdown as failure if stop was intentional

Verification:
- Start daemon with a safe dummy command if needed for testing
- Stop daemon
- `getStatus()` reflects stopped state cleanly

### Task 5: Add health polling

Objective:
- Mark daemon healthy only after the configured endpoint responds.

Files:
- Modify: `examples/extensions/local-models/main.js`

Implementation:
- Build `host = http://127.0.0.1:${port}`
- Poll `${host}${healthPath}`
- timeout bounded
- update `healthy` and `lastError`

Important lesson from Genspark:
- status/health shape must use the real field names consistently
- do not expose `isHealthy` in one place and `healthy` in another

Verification:
- `getStatus()` changes from `running:true healthy:false` to `running:true healthy:true`

### Task 6: Switch the tile from blind fetch probes to host-driven status

Objective:
- Make the renderer ask the extension host for truth.

Files:
- Modify: `examples/extensions/local-models/tiles/models/index.html`

Current smell to remove:
- direct `fetch(..., { mode: 'no-cors' })`

Replace with:
- `rpc('ext.invoke', { method: 'getStatus', args: [] })`
- `rpc('ext.invoke', { method: 'startDaemon', args: [] })`
- `rpc('ext.invoke', { method: 'stopDaemon', args: [] })`
- `rpc('ext.invoke', { method: 'setSelectedModel', args: [model] })`

Renderer should still continue to publish the useful context keys it already manages.

Verification:
- Tile shows actual backend status, not browser-level opaque fetch success

### Task 7: Add one tiny config panel inside the tile

Objective:
- Let the user set command / args / basePort without leaving the extension.

Files:
- Modify: `examples/extensions/local-models/tiles/models/index.html`

Implementation:
- small collapsible config section
- save via `settings.set`
- read via `settings.get`
- no redesign of the whole tile

Verification:
- restart tile
- settings persist

### Task 8: Keep context interoperability with Model Hub

Objective:
- Preserve what already works.

Files:
- Modify: `examples/extensions/local-models/tiles/models/index.html`

Do not break:
- peer context ingestion from `ctx:model-hub:selected`
- publish:
  - `ctx:models:active-model`
  - `ctx:models:inference-models`
- optional `actions.setModel`

Verification:
- selecting a model in Model Hub still updates Local Models

---

## Suggested implementation boundaries

Do this now:
- backend lifecycle
- dynamic port
- status and health
- host-driven UI status
- preserve model-hub interoperability

Do NOT do now:
- HF downloads
- Ollama-compatible model management
- packaged helper binaries
- chat-surface version of local-models
- codebase-wide provider/runtime refactors

---

## Commands to verify during implementation

Validation:
```bash
cd ~/clawd/collaborator-clone
node scripts/validate-extension.mjs examples/extensions/local-models
```

Build safety:
```bash
cd ~/clawd/collaborator-clone
bun run build
```

If bundled later:
```bash
cd ~/clawd/collaborator-clone
bun run package
```

---

## Why this is the right next burst

It is worthy because:
- it ports the strongest practical lesson from Genspark that actually fits CodeSurf
- it upgrades an existing weak example into a real system
- it improves CodeSurf’s local AI story without destabilizing chat, canvas, or terminal systems
- it stays inside the extension architecture CodeSurf already wants to scale

It is safe because:
- it is isolated to one extension first
- it reuses existing `ext.invoke`, settings, and context seams
- it avoids large changes to ChatTile, App.tsx, provider core, or PTY systems

---

## Recommendation

Next worthy burst:
- implement Tasks 1 through 6 only
- stop there
- verify build + extension behavior
- then decide if the config UI (Task 7) and bundled promotion should happen in a separate burst
