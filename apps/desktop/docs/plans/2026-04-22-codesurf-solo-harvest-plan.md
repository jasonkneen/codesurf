# CodeSurf Solo Harvest Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Pull the highest-value Solo patterns into CodeSurf core at `~/clawd/collaborator-clone` without turning CodeSurf into a Solo clone, and push workflow-specific UI into bundled extensions.

**Architecture:** Keep runtime primitives, registry types, trust/review, summary/state persistence, and host surfaces in CodeSurf core. Build extension-facing workflow surfaces on top of those primitives using the existing manifest/registry/bridge/chat-surface system. Treat Solo as a source of product sequencing and abstractions, not UI to copy.

**Tech Stack:** Electron 40, React 19, TypeScript 5.9, node-pty, better-sqlite3, MCP, existing CodeSurf extension manifests and chat-surface host.

---

## Active repo verification

Active repo is `~/clawd/collaborator-clone`.

Live repo identity:
- `package.json` name: `codesurf`
- `package.json` productName: `CodeSurf`
- `README.md` title: `CodeSurf`
- Git remotes include `origin https://github.com/jasonkneen/codesurf.git`

This plan is scoped only to CodeSurf core plus bundled/extensions in this repo.

---

## What already exists and should be reused

### Core seams already present
- Manifest schema and extension contribution types:
  - `src/shared/types.ts`
- Extension registry / loader / bridge:
  - `src/main/extensions/registry.ts`
  - `src/main/extensions/loader.ts`
  - `src/main/extensions/context.ts`
  - `src/main/extensions/bridge.ts`
  - `src/main/ipc/extensions.ts`
  - `src/preload/index.ts`
- Chat-surface host and multi-surface tab strip:
  - `src/renderer/src/components/ChatTile.tsx`
  - `src/renderer/src/components/chatSurfaceHostRpc.ts`
- PTY runtime:
  - `src/main/ipc/terminal.ts`
- Non-PTY chat/agent runtimes:
  - `src/main/ipc/chat.ts`
  - `src/main/ipc/execution.ts`
  - `src/main/execution/targets.ts`
- Permissions / tool review:
  - `src/main/permissions.ts`
  - `src/main/ipc/permissions.ts`
- Workspace/project persistence:
  - `src/main/ipc/workspace.ts`
  - `src/main/storage/*`
- Existing core manifestation surfaces:
  - `src/renderer/src/components/chat/PlanChip.tsx`
  - `src/renderer/src/components/chat/PlanPane.tsx`
  - `src/renderer/src/state/tileTodosStore.ts`
  - `src/renderer/src/components/PanelLayout.tsx`
- MCP server and extension MCP aggregation:
  - `src/main/mcp-server.ts`

### Existing extensions that prove the direction
- Chat-native composer surfaces:
  - `bundled-extensions/sketch/extension.json`
  - `bundled-extensions/builder/extension.json`
  - `bundled-extensions/context-deck/extension.json`
  - `bundled-extensions/rewind-lite/extension.json`
- Power extension with daemon/runtime feel:
  - `bundled-extensions/local-models/extension.json`
- Real-time workflow extension:
  - `bundled-extensions/livekit-rooms/extension.json`

### Important current gaps vs Solo
- No unified runtime/process supervisor object model across PTY, chat runtimes, daemon jobs, and extension-side runtimes.
- `ctx:chat:providers` is still somewhat ad hoc in renderer instead of being a first-class registry-backed contribution.
- Tool trust/review is much stronger for chat tool calls than for PTY shell commands or extension-triggered process/network actions.
- Core summaries exist, but there is no dedicated persistent runtime summary model like Solo’s process summaries.
- Crash/orphan tracking is partial rather than universal.

---

## What goes in CodeSurf core

These should be core because they are host/runtime/platform capabilities, not domain-specific features.

### 1. Runtime lane model
Create a single shared model for visible runtime units across CodeSurf.

**Why:** Solo’s main lesson is “one shell, multiple runtime types.” CodeSurf already has PTY and non-PTY runtimes, but they are fragmented.

**Core shape to add:**
- `RuntimeLane`
- `RuntimeLaneKind = 'pty' | 'agent-cli' | 'embedded-agent' | 'daemon-job' | 'extension-service'`
- `RuntimeLaneStatus`
- `RuntimeLaneSummary`
- `RuntimeLaneTrustState`
- `RuntimeLanePort`

**Primary files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/runtimeLanes.ts`
- Modify: `src/main/ipc/terminal.ts`
- Modify: `src/main/ipc/chat.ts`
- Modify: `src/main/ipc/system.ts`
- Modify: `src/main/ipc/execution.ts`

### 2. Registry-backed provider/tool contribution model
Promote provider/tool surfaces into a first-class manifest contribution instead of relying on peer-context injection.

**Why:** CodeSurf should not keep discovering chat providers through `ctx:chat:providers` alone.

**Core shape to add:**
- `contributes.chatProviders[]`
- optional `contributes.runtimeLanes[]`
- registry APIs to list providers and lane launchers

**Primary files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/extensions/registry.ts`
- Modify: `src/main/ipc/extensions.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx`

### 3. Persistent control-surface host contract
Keep the host surface in core, not the individual workflows.

**Why:** Chat surfaces already exist, but they are turn-oriented. CodeSurf needs a more durable core host concept for composer companions, runtime inspectors, and setup surfaces.

**Core work:**
- distinguish transient send-once chat surfaces from persistent sidecar/control surfaces
- add a small host state layer for drafts / selected surface state / persisted open surfaces

**Primary files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Modify: `src/renderer/src/components/chatSurfaceHostRpc.ts`
- Modify: `src/renderer/src/state/*` (new dedicated store)

### 4. Runtime summary model and manifestation primitives
Unify plan/todo/tool/result chips into a common “runtime manifestation” path.

**Why:** Solo’s one-line summaries are navigation, not decoration.

**Core work:**
- summary schema for runtime lanes
- durable summary persistence
- common collapsed/expanded chip rendering
- reusable attachment to tile chrome and chat

**Primary files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc/chat.ts`
- Modify: `src/main/ipc/terminal.ts`
- Modify: `src/main/activity-store.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Modify: `src/renderer/src/components/chat/PlanChip.tsx`
- Modify: `src/renderer/src/components/chat/PlanPane.tsx`
- Modify: `src/renderer/src/components/PanelLayout.tsx`
- Create: `src/renderer/src/components/chat/RuntimeSummaryChip.tsx`

### 5. Generalized trust/review model
Extend trust beyond chat tool calls into PTY command launches and extension-triggered process/network actions.

**Why:** Solo’s 0.5.8 lesson is that command trust cannot be bolted on later without pain.

**Core work:**
- trust key should include command + cwd + env
- explicit review state for PTY-backed launches
- optional review requirement for extension actions with `process` or `network` permissions

**Primary files:**
- Modify: `src/main/permissions.ts`
- Modify: `src/main/ipc/permissions.ts`
- Modify: `src/main/ipc/terminal.ts`
- Modify: `src/main/extensions/context.ts`
- Modify: `src/main/extensions/loader.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Create: `src/renderer/src/components/chat/CommandReviewCard.tsx`

### 6. Crash/orphan/process-lifecycle tracking
Add a universal lifecycle tracker for runtime lanes.

**Why:** CodeSurf already has daemon health and some recovery, but not a unified lane lifecycle ledger.

**Primary files:**
- Create: `src/main/runtime-lanes/store.ts`
- Create: `src/main/runtime-lanes/supervisor.ts`
- Modify: `src/main/ipc/terminal.ts`
- Modify: `src/main/ipc/chat.ts`
- Modify: `src/main/daemon/manager.ts`
- Modify: `src/main/ipc/system.ts`

---

## What belongs in extensions

These should stay as bundled extensions because they are workflow/domain-specific UI or integrations built on top of core primitives.

### A. Process Deck / Process Inspector extension
A chat surface + tile that lets users inspect runtime lanes, attach summaries, and deep-link to lane detail.

**Build as extension because:** it is a UI workflow over core runtime-lane data, not a host primitive.

**Likely path:**
- Create: `bundled-extensions/process-deck/extension.json`
- Create: `bundled-extensions/process-deck/main.js`
- Create: `bundled-extensions/process-deck/tiles/main/index.html`
- Create: `bundled-extensions/process-deck/surface/index.html`

### B. Provider Setup / Agent Lanes extension
A setup surface for discovering provider CLIs, showing icons/models, launching lane types, and publishing provider context.

**Build as extension because:** provider UX changes faster than core contracts.

**Likely path:**
- Extend or fork from: `src/renderer/src/components/AgentSetup.tsx`
- Or create: `bundled-extensions/agent-lanes/*`

### C. Rewind / Digest surfaces
Upgrade `rewind-lite` to consume the new runtime summary model instead of assembling its own partial world view.

**Primary files:**
- Modify: `bundled-extensions/rewind-lite/main.js`
- Modify: `bundled-extensions/rewind-lite/surface/index.html`
- Modify: `bundled-extensions/rewind-lite/tiles/main/index.html`

### D. Onboarding / Detection surfaces
Project/process detection should be core data production, but the first-run UX should be extension-delivered.

**Primary files:**
- Create: `bundled-extensions/workspace-onboarding/*`
- Or extend: `bundled-extensions/context-deck/*`

### E. Domain-specific companions already in progress
These should keep using chat surfaces, not be promoted to core:
- Sketch
- Builder
- Context Deck
- Local Models
- LiveKit Rooms

---

## Things we should NOT pull from Solo

- A separate Solo-like app shell inside CodeSurf
- A literal process-manager clone UI
- Solo’s exact labels, sidebar behavior, or layout chrome
- Pricing/licensing patterns
- Server announcement/news inbox behavior
- Any architecture that makes extensions own PTY spawning directly

---

## Recommended phased implementation order

### Phase 1: Core runtime and provider contracts

**Objective:** Give CodeSurf a first-class model for runtime lanes and registry-backed providers before building new UI.

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/runtimeLanes.ts`
- Modify: `src/main/extensions/registry.ts`
- Modify: `src/main/ipc/extensions.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx`

**Tasks:**
1. Add `RuntimeLane*` shared types.
2. Add `chatProviders` manifest contribution type.
3. Extend registry to collect/list provider contributions.
4. Add preload and IPC accessors for provider registry and runtime lanes.
5. Replace `ctx:chat:providers` fallback path in `ChatTile` with registry-backed loading, leaving peer-context as compatibility fallback.

**Verification:**
- Run: `npm run build`
- Expected: build passes
- Manual: existing chat surfaces still load; provider selection still works

### Phase 2: Core summaries + manifestation

**Objective:** Make runtime lanes inspectable and navigable through persistent summaries.

**Files:**
- Modify: `src/main/ipc/terminal.ts`
- Modify: `src/main/ipc/chat.ts`
- Modify: `src/main/activity-store.ts`
- Modify: `src/renderer/src/components/ChatTile.tsx`
- Modify: `src/renderer/src/components/chat/PlanChip.tsx`
- Modify: `src/renderer/src/components/PanelLayout.tsx`
- Create: `src/renderer/src/components/chat/RuntimeSummaryChip.tsx`

**Tasks:**
1. Emit summary updates for PTY lanes.
2. Persist summary text and last-activity metadata.
3. Add one reusable summary chip renderer.
4. Mount summaries in chat and panel chrome.

**Verification:**
- Run: `npm run build`
- Run: `npm run test:daemon`
- Manual: summary updates appear without breaking existing tool chips

### Phase 3: Trust and lifecycle hardening

**Objective:** Bring Solo’s strongest hardening lesson into CodeSurf before more runtime UX is built.

**Files:**
- Modify: `src/main/permissions.ts`
- Modify: `src/main/ipc/permissions.ts`
- Modify: `src/main/ipc/terminal.ts`
- Modify: `src/main/extensions/context.ts`
- Modify: `src/main/daemon/manager.ts`
- Create: `src/main/runtime-lanes/store.ts`
- Create: `src/main/runtime-lanes/supervisor.ts`
- Create: `src/renderer/src/components/chat/CommandReviewCard.tsx`

**Tasks:**
1. Add per-command trust keys for PTY launches.
2. Gate untrusted PTY launches behind review.
3. Track lane lifecycle and abnormal termination.
4. Expose lifecycle state through IPC.

**Verification:**
- Run: `npm run build`
- Manual: launching an untrusted command shows review; trusted relaunches are smooth

### Phase 4: Extension extraction wave

**Objective:** Turn the new core primitives into useful CodeSurf workflows without bloating core.

**Files:**
- Modify: `bundled-extensions/rewind-lite/*`
- Create: `bundled-extensions/process-deck/*`
- Create or extend: `bundled-extensions/agent-lanes/*`
- Create: `bundled-extensions/workspace-onboarding/*`
- Validate: `scripts/validate-extension.mjs`

**Tasks:**
1. Upgrade Rewind Lite to consume runtime summaries.
2. Build Process Deck tile + chat surface.
3. Build Agent Lanes setup/launcher surface.
4. Add onboarding/detection extension surface.

**Verification:**
- Run: `node scripts/validate-extension.mjs bundled-extensions/process-deck`
- Run: `node scripts/validate-extension.mjs bundled-extensions/agent-lanes`
- Run: `npm run build`
- Manual: new surfaces appear in chat `+` menu and/or context menu as intended

---

## Immediate “pull now” shortlist

If we only do the highest-yield extraction now, do these first:
1. Runtime lane shared model in core
2. Registry-backed chat provider contribution in core
3. Persistent runtime summaries in core
4. PTY command trust review in core
5. Process Deck extension on top of those primitives

That gives us the actual value from Solo without cloning Solo.

---

## Suggested commit grouping

1. `feat(core): add runtime lane model and provider contributions`
2. `feat(core): add runtime summary persistence and chips`
3. `feat(core): add PTY command trust review and lane lifecycle tracking`
4. `feat(ext): add process deck extension`
5. `feat(ext): upgrade rewind-lite and add agent lane surfaces`

---

## Final recommendation

Do not start with a new giant process-manager UI.

Start by making CodeSurf’s existing host smarter:
- one shared runtime lane model
- one provider registry
- one summary model
- one trust model

Then let extensions present those capabilities in different ways.
