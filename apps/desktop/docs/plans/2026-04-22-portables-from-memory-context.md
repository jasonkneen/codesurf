# Portable patterns to lift into CodeSurf from the recalled memory block

> Active repo is `~/clawd/collaborator-clone`. Verified live from `package.json` as `codesurf` / `CodeSurf`. This plan works only inside this repo; AirJelly, Genspark, Omnara, Zodex, and Superset are background references only.

Goal
- Separate the recalled memory block into: already ported, clearly portable next, and not-worth-porting.

Why this plan exists
- The memory block mixes durable product ideas with old reverse-engineering notes, one-off failures, and stale project summaries.
- CodeSurf already contains several of the good ideas. The right move is to promote/finish those, not rebuild them again.

---

## 0. What is already in CodeSurf now

These are already present in `~/clawd/collaborator-clone` and should NOT be re-planned as new ports:

1. Chat-surface pipeline
- `src/renderer/src/components/ChatTile.tsx`
- `src/main/ipc/extensions.ts`
- `src/renderer/src/components/chatSurfaceHostRpc.ts`
- Already supports:
  - multi-surface tabs (`openChatSurfaces`, `activeChatSurfaceId`)
  - peer context
  - peer actions
  - `surface.setPayload`
  - `ext.invoke`
  - `settings.get`
  - `workspace.getPath()`

2. Sketch + Builder as chat surfaces
- `bundled-extensions/sketch/extension.json`
- `bundled-extensions/builder/extension.json`
- These already cover the Zodex-inspired sketch/builder-in-chat flow.

3. AirJelly-inspired structured context + rewind patterns
- `examples/extensions/context-deck/extension.json`
- `examples/extensions/rewind-lite/extension.json`
- These already embody the best transportable AirJelly ideas:
  - structured context composer
  - compact workspace rewind digest

4. Hugging Face / local-model browsing primitives
- `examples/extensions/model-hub/extension.json`
- `examples/extensions/local-models/extension.json`
- HF browsing and local model browsing already exist as extension examples.

5. Trust / approvals system
- `src/main/permissions.ts`
- `src/main/ipc/permissions.ts`
- `src/renderer/src/components/SettingsPanel.tsx`
- CodeSurf already has scoped approval memory and reset controls.

6. Gemini-related runtime support
- `src/main/ipc/agents.ts`
- `src/renderer/src/components/KanbanCard.tsx`
- `src/renderer/src/components/CustomisationTile.tsx`
- Gemini is already present in agent detection / instructions / kanban model lists.

7. Commenting already exists in one domain
- `src/main/mcp-server.ts`
- `src/renderer/src/components/KanbanCard.tsx`
- There is already a task/comment/attachment model in the kanban path.

Conclusion:
- We should not “port” Sketch/Builder, chat surfaces, approvals, Gemini basics, or AirJelly rewind/context from scratch.
- We should promote, unify, or extend them.

---

## 1. Best things to port next

### A. Promote AirJelly-style context + rewind from examples to first-class bundled features

Why
- The examples already exist, so this is low-risk and high-value.
- These are the cleanest parts of the memory block to productize.

Files
- Promote/copy from:
  - `examples/extensions/context-deck/**`
  - `examples/extensions/rewind-lite/**`
- Into:
  - `bundled-extensions/context-deck/**`
  - `bundled-extensions/rewind-lite/**`
- Packaging / discovery:
  - `package.json` (`build.extraResources`)
  - `src/main/extensions/registry.ts` if manual registration is still needed anywhere

Expected outcome
- Structured markdown brief composer available by default
- Workspace rewind digest available by default

Verification
- Open chat tile
- Confirm both surfaces appear in the `+` menu
- Send one markdown payload from each

### B. Lift Genspark LocalModel lessons into the Local Models extension

Why
- The repo already has `model-hub` and `local-models`, but not the polished local-daemon lifecycle work learned from Genspark.
- The strongest portable lesson from Genspark is not its browser shell; it is local sidecar orchestration:
  - wrapper-provided env
  - dynamic port selection
  - health checks
  - heartbeat / keepalive discipline
  - clean shutdown semantics

Files
- Existing base:
  - `examples/extensions/local-models/extension.json`
  - `examples/extensions/local-models/tiles/models/index.html`
- New likely files:
  - `examples/extensions/local-models/main.js`
  - maybe `examples/extensions/local-models/surface/index.html`
- Extension RPC plumbing already exists through `ext.invoke` in:
  - `src/renderer/src/components/chatSurfaceHostRpc.ts`
  - `src/renderer/src/components/ExtensionTile.tsx`

Scope
- Add a host-side daemon manager behind the extension
- Manage local model backend lifecycle there
- Expose status/actions through `ext.invoke`
- Optional chat surface for “attach local model status / selected model to next turn”

Expected outcome
- CodeSurf gets a real local-model runtime story, not just browsing mockups

Verification
- Start extension tile
- Verify daemon starts on a free port
- Verify health endpoint reaches healthy
- Verify shutdown is clean

### C. Promote Gemini from “detected agent” to full provider parity

Why
- Memory block explicitly asks for variant agent shells such as Gemini, including icons / names / model parity.
- Repo already has partial Gemini support, but not first-class chat-provider parity.

Current evidence
- `src/main/ipc/agents.ts` has `gemini`
- `KanbanCard.tsx` has Gemini model options
- `CustomisationTile.tsx` knows Gemini instruction files
- `src/renderer/src/config/providers.ts` does NOT include Gemini as a built-in provider union

Files
- `src/renderer/src/config/providers.ts`
- `src/main/ipc/chat.ts`
- `src/shared/types.ts`
- Any provider picker UI using `BuiltinProvider`

Expected outcome
- Gemini becomes a top-level provider beside Claude/Codex/OpenCode/OpenClaw/Hermes
- consistent icon / label / model / mode handling

Verification
- Gemini appears in provider picker
- provider-specific mode/model config loads
- send path resolves without type hacks

### D. Reuse kanban comments as the base for a generic comment / review layer

Why
- The memory block repeatedly references lifting commenting systems.
- CodeSurf already has comments on kanban cards; that is the right primitive to generalize.

Current evidence
- `src/main/mcp-server.ts` task model has `comments` and `attachments`
- `src/renderer/src/components/KanbanCard.tsx` renders and edits comments

Files
- `src/main/mcp-server.ts`
- `src/renderer/src/components/KanbanCard.tsx`
- likely new shared abstraction files under:
  - `src/shared/`
  - `src/renderer/src/components/`

Plan direction
- Extract reusable comment thread model / renderer
- Reuse it in chat-linked review surfaces, builder critique, or code review cards

Expected outcome
- One commenting primitive instead of separate one-off note systems

Verification
- comments render identically across at least two surfaces
- comments persist in the same shape

### E. Add Solo-style summary surfaces, but only where CodeSurf is weak

Why
- The memory block contains strong Solo lessons around summaries and shell-state visibility.
- CodeSurf already has terminals, approvals, providers, and kanban. The gap is compact status summarization, not raw capability.

Good targets
- Per-terminal / per-agent one-line summary
- Per-workspace “what is happening?” strip
- Summary rows for active long-running tasks / local daemons

Files to inspect/likely touch
- `src/preload/index.ts` terminal APIs
- terminal-related IPC in `src/main/ipc/`
- `src/renderer/src/components/ChatTile.tsx`
- tile chrome / layout files:
  - `src/renderer/src/components/TileChrome.tsx`
  - `src/renderer/src/components/PanelLayout.tsx`

Expected outcome
- better navigation + status scanning without copying Solo UI wholesale

Verification
- a user can scan active work without opening every tile

---

## 2. Things NOT worth porting into CodeSurf

1. Full Genspark browser shell
Why not
- CodeSurf is not a browser fork product
- only the local runtime / daemon orchestration lessons matter

2. AirJelly AXSidecar / accessibility sidecar reconstruction
Why not
- too app-specific
- no evidence CodeSurf needs this architecture

3. Electron bundle extraction pitfalls as product work
Examples
- executable-bit repair on unpacked helpers
- source-map recovery workflows
- cert parser noise handling
Why not
- useful reverse-engineering skills, not CodeSurf features

4. Stale project-level memory summaries
Examples
- Omnara/Zodex/Superset narrative summaries
- old Anthropic tool-use bug notes
Why not
- not product functionality
- belongs in skills/session history, not CodeSurf roadmap

---

## 3. Recommended execution order

1. Promote `context-deck` and `rewind-lite` to bundled extensions
2. Add a real `main.js` backend to `local-models` using the Genspark lessons
3. Promote Gemini to first-class provider parity
4. Extract generic comment thread primitives from kanban
5. Add compact summary rows for terminals/agents/daemons

This order gives the highest leverage with the least architectural churn.

---

## 4. Concrete next burst (small controlled burst)

Burst 1
- Bundle `context-deck`
- Bundle `rewind-lite`
- Verify chat `+` menu and payload emission

Burst 2
- Add `examples/extensions/local-models/main.js`
- Implement local daemon lifecycle + health check + stop/start RPC
- Verify with extension harness first, then full app

Burst 3
- Add Gemini to built-in provider config / picker / send path
- Verify type-safe provider round-trip

---

## 5. Short answer

The best things to port from that memory block into CodeSurf are:
- promote the already-built AirJelly-style context and rewind surfaces
- bring Genspark’s local-daemon orchestration lessons into the local-models extension
- promote Gemini to full provider parity
- generalize kanban comments into a reusable review/comment system
- add Solo-style summary surfaces where CodeSurf lacks compact status visibility

Everything else in that memory block is mostly archive, reverse-engineering process, or app-specific noise.
