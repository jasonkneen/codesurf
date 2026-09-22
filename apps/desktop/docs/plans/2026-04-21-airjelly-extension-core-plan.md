# AirJelly-Inspired Extension Core Plan

> For Hermes: keep implementation in small controlled bursts. Prefer one narrow core seam at a time, then verify with the example extensions in `examples/extensions/`.

Goal: make CodeSurf’s extension system strong enough to host AirJelly-style rewind, connector, execution, and composer-companion features without escaping into ad-hoc host hacks.

Architecture: keep AirJelly-inspired features inside the extension model where possible, then add narrow host capabilities only where the existing tile/chat-surface bridge is too weak. The examples built in this pass prove two current seams: a frontend-only chat surface (`examples/extensions/context-deck`) and a power-tile rewind digest (`examples/extensions/rewind-lite`).

Tech stack: Electron main/preload/renderer, extension registry, chat surfaces in `ChatTile`, power extensions via `main.js`, MCP server, examples catalog, extension harness.

---

## Current examples built now

1. `examples/extensions/context-deck/`
   - safe chat-surface example
   - turns structured goal / constraints / files / notes into a markdown attachment
   - proves the current composer-companion seam

2. `examples/extensions/rewind-lite/`
   - power-tier tile example
   - reads workspace path + workspace id
   - summarizes package metadata, git state, canvas shape, and recent commits
   - publishes `ctx:rewind:snapshot`
   - exposes a power-side MCP tool for digest generation

These examples are meant to be the acceptance fixtures for the core work below.

---

## Task 1: Bring chat surfaces to bridge parity for backend-powered extensions

Objective: let chat-surface extensions use the same practical backend seams as normal extension tiles for settings and power-extension IPC.

Files:
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Modify: `src/main/extensions/bridge.ts`
- Modify: `src/renderer/src/env.d.ts`
- Verify with: `examples/extensions/context-deck/` and a future backend-powered chat surface

Steps:
1. In `ChatTile.tsx`, add RPC handling for:
   - `settings.get`
   - `settings.set`
   - `ext.invoke`
   - `workspace.getPath`
2. Keep the implementation parallel to the working logic in `src/renderer/src/components/ExtensionTile.tsx`.
3. Extend chat-surface `tile.getMeta` to include `workspaceId` and `workspacePath`, matching tile metadata where possible.
4. Verify a chat surface can fetch settings, call its power extension backend, and discover workspace path without errors.

Verification:
- Open a chat surface and confirm `window.contex.ext.invoke(...)` works end-to-end.
- Confirm no regression to Sketch or Builder send flow.

Why this matters:
- AirJelly-style rewind summaries, connector composers, and execution-control surfaces want backend work from inside chat.
- Right now chat surfaces are good at `surface.setPayload` but weak at everything else.

---

## Task 2: Add surface-scoped persistence for chat surfaces

Objective: give chat surfaces a minimal state store so they can survive tab switches and light session churn without abusing outgoing payload state.

Files:
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Modify: `src/main/extensions/bridge.ts`
- Optional new helper: `src/renderer/src/components/chat-surface-state.ts`

Steps:
1. Add `surface.state.get(key)` and `surface.state.set(key, value)` to the injected bridge.
2. Store data per active chat-surface instance id inside `ChatTile`.
3. Clear it on explicit `surface.clear`, but not on simple tab switching.
4. Keep it renderer-local first; do not persist to disk yet.

Verification:
- A chat surface can switch tabs and recover draft state.
- `surface.clear` wipes the state and payload together.

Why this matters:
- AirJelly-like quick-command and execution surfaces are awkward if every tab switch resets the UI.

---

## Task 3: Add chat-surface support to the extension dev harness

Objective: make chat surfaces testable without running the full Electron app.

Files:
- Modify: `examples/extensions/_harness/index.html`
- Modify: `examples/extensions/_harness/server.mjs`
- Modify: `docs/extension-dev-harness.md`

Steps:
1. Extend extension discovery to include `contributes.chatSurfaces` in the UI.
2. Add a “Surface mode” picker so the harness can load either tile entries or chat-surface entries.
3. Simulate:
   - `surface.setPayload`
   - `surface.requestFlush`
   - `surface.clear`
4. Show the last emitted payload in the harness UI.

Verification:
- `context-deck` can be opened and flushed from the harness.
- The harness displays the emitted markdown payload.

Why this matters:
- Composer-native extensions are much harder to iterate on without a dedicated harness path.

---

## Task 4: Add a formal host capability registry for power extensions

Objective: replace one-off bespoke host bridges with explicit, permissioned capability grants.

Files:
- New: `src/main/extensions/host-capabilities.ts`
- Modify: `src/main/extensions/context.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc/extensions.ts`
- Modify: `docs/extensions.md`

Steps:
1. Define a host capability registry with named capabilities such as:
   - `workspace-artifacts:read`
   - `jobs:read`
   - `relay:host`
   - `notifications:show`
   - `activity:read`
2. Expose capability request/grant plumbing in `ExtensionContext` instead of special-casing by extension id.
3. Move Relay Suite from the hard-coded `manifest.id === 'codesurf-relay-suite'` branch to the capability registry.
4. Document the new capability model.

Verification:
- Relay Suite still works.
- A new power extension can request one capability without adding another bespoke branch in `ExtensionContext`.

Why this matters:
- AirJelly-like features eventually need host services, but they should not punch random holes in the app.

---

## Task 5: Add a background jobs seam for extensions

Objective: let extensions schedule small recurring or on-demand background work without owning their own daemon lifecycle hacks.

Files:
- Modify: `src/main/extensions/context.ts`
- Optional new helper: `src/main/extensions/jobs.ts`
- Modify: `src/main/ipc/jobs.ts` or adjacent extension-facing wrapper
- Verify with: a future connector or execution-center extension

Steps:
1. Expose a narrow API like:
   - `ctx.jobs.register(name, handler, options)`
   - `ctx.jobs.runNow(name)`
   - `ctx.jobs.getStatus(name)`
2. Keep jobs local to the extension id.
3. Make them opt-in and easy to tear down on extension disable.

Verification:
- A power extension can register a small polling/status task.
- Disable/unload cleans it up.

Why this matters:
- Connector monitoring, execution queues, and digest refreshes are much cleaner with host-managed jobs.

---

## Task 6: Add opt-in activity and timeline APIs

Objective: support a true “Rewind Lite -> Rewind” path without forcing extensions to scrape random app internals.

Files:
- New: `src/main/extensions/activity-api.ts`
- Modify: `src/main/extensions/context.ts`
- Modify: `docs/extensions.md`
- Future example target: `examples/extensions/rewind-lite/`

Steps:
1. Define a read-only activity API for extension use.
2. Start small with host-owned artifacts already available inside CodeSurf:
   - workspace canvas snapshots
   - tile session summaries
   - recent chat/session metadata
   - job history
3. Leave system-wide screenshots and app usage for a later, separately permissioned phase.

Verification:
- Rewind Lite can replace its direct filesystem heuristics with a cleaner host API.

Why this matters:
- This is the cleanest way to get AirJelly-like rewind value without turning every extension into a private reverse-engineering project.

---

## Task 7: Decide explicitly whether overlay windows belong in the extension model

Objective: avoid accidental architecture drift.

Files:
- New doc note or ADR under `docs/`

Decision to make:
- Either keep overlays as a host-only feature class
- Or define a very small extension-facing overlay API with strict constraints

Recommendation:
- Do not make arbitrary always-on-top Electron windows a general extension feature yet.
- If ambient avatar / glow / nudge surfaces matter later, design them as a host-owned subsystem with extension-triggered intents.

Why this matters:
- AirJelly’s floating-avatar/screen-glow model is powerful, but it is not a natural fit for the current CodeSurf extension architecture.

---

## Suggested implementation order

1. Task 1 — chat-surface bridge parity
2. Task 3 — harness support for chat surfaces
3. Task 4 — host capability registry
4. Task 5 — background jobs seam
5. Task 6 — activity/timeline APIs
6. Task 7 — explicit overlay decision

This order unlocks the biggest extension wins earliest while keeping the core changes surgical.

---

## Acceptance bar

The core work is “enough” when all of these are true:

- `context-deck` can be developed and flushed from the harness, not only the full app
- a chat surface can call `ext.invoke` and use extension settings
- Relay Suite no longer relies on a special-case branch in `ExtensionContext`
- `rewind-lite` can fetch workspace/timeline data through a formal host seam instead of raw filesystem guesses
- a future connector or execution extension can run background polling through a host-managed job API

---

## Notes for next session

- The examples created in this pass are the live fixtures for future core changes:
  - `examples/extensions/context-deck/`
  - `examples/extensions/rewind-lite/`
- Do not start with overlays.
- Start by making chat surfaces as capable and testable as tiles.
