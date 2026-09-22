# Codex Thread Feature Roadmap Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Keep bursts small, verified, and commit only after Jason authorizes git actions.

**Goal:** Turn the X/Codex suggestion thread into a phased CodeSurf roadmap that upgrades browser QA, testing loops, design/frontend work, orchestration, context, git, voice, and remote workflows without recreating or losing existing work.

**Architecture:** Build upward from CodeSurf’s existing seams: Electron app + renderer canvas, ChatTile/chat surfaces, extension registry/bridge, bundled extension system, MCP/event bus, daemon session/store, BrowserTile, mini chat windows, voice hooks, source-control and code-index prototypes, and the Electrobun compatibility shell. Each phase should promote/refine existing primitives before introducing new primitives.

**Tech Stack:** Electron 41, React 19, TypeScript/tsgo, electron-vite, bundled extensions, MCP HTTP server, node/electron IPC, existing daemon package, Bun/npm scripts, optional Electrobun compatibility paths.

---

## Active scope and baseline

Active repo: `/Users/jkneen/clawd/collaborator-clone`

Live identity checked:
- `package.json` name: `codesurf`
- `productName`: `CodeSurf`
- Description: `Infinite canvas workspace for AI agents`
- Current branch: `main`
- Current visible local changes before this plan:
  - Modified: `.codesurf/DREAMING.md`
  - Modified: `.mcp.json`
  - Modified: `electron.vite.config.ts`
  - Untracked: `index.js`

Do not overwrite or “clean up” those files unless the relevant phase explicitly owns them and Jason approves. Do not switch branches, reset, or commit without permission.

---

## Non-recreation rules

These are hard constraints for the whole roadmap:

1. Do not replace `ChatTile.tsx` wholesale.
   - It already owns provider streaming, chat surfaces, voice status, attachments, context usage, git branch controls, mini chat affordance, tool blocks, plan pane, and rich message rendering.
   - Continue extracting/polishing leaf pieces only when needed.

2. Do not create a second chat-surface architecture.
   - Reuse:
     - `src/main/extensions/registry.ts`
     - `src/main/extensions/bridge.ts`
     - `src/main/ipc/extensions.ts`
     - `src/renderer/src/components/chatSurfaceHostRpc.ts`
     - `src/renderer/src/components/ChatTile.tsx`
     - `src/renderer/src/components/chat/ChatComposer*.tsx`

3. Do not rebuild mini chat windows.
   - Reuse the existing main-process path:
     - `src/main/index.ts` `window:openMiniChat`
     - `src/preload/index.ts` `window.openMiniChat`
     - `src/renderer/src/App.tsx` mini-chat route branch
     - `src/renderer/src/components/Sidebar.tsx` sidebar mini affordance

4. Do not replace the existing BrowserTile with an unrelated browser product.
   - Build browser QA on top of:
     - `src/renderer/src/components/BrowserTile.tsx`
     - `src/main/ipc/browserTile.ts`
     - preload `browserTile` API
     - existing webview/electrobun/fallback compatibility logic

5. Do not rebuild extension loading.
   - Promote working examples when appropriate:
     - `examples/extensions/source-control` → git workbench candidate
     - `examples/extensions/code-index` → context map/index candidate
     - `examples/extensions/artifact-builder` → reference only; current bundled `builder` is the product path
   - Keep `bundled-extensions/` as the first-class shipped surface.

6. Do not rebuild the agent/kanban MCP contract.
   - Reuse:
     - `src/main/mcp-server.ts`
     - `src/main/event-bus.ts`
     - built-in Kanban tile
     - `examples/extensions/agent-kanban`
     - `bundled-extensions/*` extension MCP/action support

7. Do not block Electron progress on Electrobun parity.
   - Keep Electrobun changes compatibility-focused and separately validated through:
     - `src/electrobun/browser/electron-facade.ts`
     - `electrobun/bun/index.ts`
     - `npm run smoke:electrobun`
     - `npm run acceptance:electrobun`

---

## Existing asset map to leverage

| Capability from thread | Existing CodeSurf asset | How to leverage |
| --- | --- | --- |
| Mini chat / focused management | `window:openMiniChat`, `App.tsx` mini branch, sidebar action | Extend status/control inside current mini path; do not add popups |
| Chat-native tools | bundled `builder`, `sketch`, `context-deck`, `rewind-lite`, chat-surface host RPC | Add new tools as chat surfaces or promote examples; no parallel UI path |
| Browser use | `BrowserTile.tsx`, `browserTile` IPC, webview registry/parking root | Add evidence capture, tabs, full-size modes, link routing, QA controls |
| App testing | Terminal tile, extension main processes, MCP, event bus | Add QA workbench extension and/or MCP tools that run tests and collect artifacts |
| Design/frontend | `builder` chat surface, `sketch`, theme tokens, screenshot/image tooling | Add visual-diff loop and Figma/screenshot import around current builder/sketch |
| Agent orchestration | Kanban, MCP tools, `agent-kanban`, event bus | Add executor/validator templates, task lifecycle, and visible health dashboard |
| Context/repo understanding | `examples/extensions/code-index`, discovery graph worker, FileExplorer/CodeTile | Promote/refine code-index into a Context Map / Repo Graph surface |
| Git graph/review | `examples/extensions/source-control`, `DiffView`, chat git hooks | Promote/refine source-control instead of recreating git panel |
| Voice | `useChatDictation`, VAD assets, TTS utilities/settings | Add voice command/control layer over existing chat/agent actions |
| Remote/mobile handoff | daemon/session APIs, sidebar sessions, mini windows | Start desktop-visible session handoff and notifications before mobile-native work |

---

# Phase 0 — Audit, checkpoint, and architecture map

**Objective:** Freeze the current mental model and avoid recreating existing work.

**Files likely touched:**
- Create: `docs/plans/codex-next-level-roadmap.md` or keep this `.hermes/plans/...` as the handoff source
- Optional create after approval: `docs/architecture/codex-next-level-existing-assets.md`

**Steps:**
1. Inspect current dirty files and ask Jason before touching them.
   - `git status --short`
   - `git diff -- .codesurf/DREAMING.md .mcp.json electron.vite.config.ts`
   - `git status --short index.js`
2. Run a read-only inventory of the active seams:
   - Browser: `BrowserTile.tsx`, `browserTile.ts`, preload/env APIs
   - Chat: `ChatTile.tsx`, `ChatComposer*.tsx`, `chatSurfaceHostRpc.ts`
   - Extensions: registry, bridge, IPC, bundled extensions, examples
   - MCP/agent: `mcp-server.ts`, event bus, kanban, daemon client/manager
   - Git/context prototypes: `examples/extensions/source-control`, `examples/extensions/code-index`
3. Create a concise architecture map before coding.
4. Baseline verification before Phase 1:
   - `npm run typecheck:go`
   - `npm test`
   - `npm run build`
5. If the tree is already failing before feature work, document failures as baseline and do not mix baseline fixes with feature code unless Jason approves.

**Acceptance criteria:**
- We know which current files are user/agent work in progress.
- We have a phase-by-phase implementation map tied to existing files.
- Baseline checks are either green or documented as pre-existing failures.

---

# Phase 1 — Browser evidence substrate

**Objective:** Add browser observability primitives first so later QA/testing/design work has real evidence to consume.

**Do not build a new browser. Extend current BrowserTile.**

**Files likely touched:**
- Modify: `src/renderer/src/components/BrowserTile.tsx`
- Modify: `src/main/ipc/browserTile.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/shared/types.ts`
- Add tests: `test/browser-evidence.test.ts` or `test/main/browser-tile-evidence.test.mjs`

**Feature slices:**

### 1.1 Browser evidence model
Add shared types for:
- page URL/title/loading state
- console messages
- load failures
- network request failures if available from webContents/webview events
- screenshot metadata/path when captured
- timestamped evidence batches

Prefer a generic shape like:
- `BrowserEvidenceEvent`
- `BrowserEvidenceSnapshot`
- `BrowserTileDiagnostics`

### 1.2 Main-process BrowserView event capture
`src/main/ipc/browserTile.ts` already captures navigation/load. Extend it with evidence events:
- `console-message`
- `did-fail-load`
- `render-process-gone` if available
- optional `webRequest.onErrorOccurred` scoped to the tile session partition

Store only a bounded ring buffer per tile/window. Do not persist indefinitely in Phase 1.

### 1.3 Renderer webview event capture
`BrowserTile.tsx` already handles Electron webview, Electrobun webview, and iframe fallback. Add matching renderer-side capture for webview paths:
- `console-message`
- `did-fail-load`
- `did-frame-finish-load`
- URL/title/current loading state

Keep fallback iframe limitations explicit.

### 1.4 Evidence API surface
Expose read-only IPC/preload methods:
- `browserTile.getEvidence(tileId)`
- `browserTile.clearEvidence(tileId)` only if user-triggered from UI
- `browserTile.captureScreenshot(tileId)` if supported by Electron webContents/webview

### 1.5 Minimal UI affordance
Add a compact diagnostics button/strip in `BrowserTile`:
- badge count for console/errors
- click opens a small evidence drawer inside the tile
- no heavy QA workbench yet

**Verification:**
- Unit test evidence ring buffer if factored into a pure helper.
- Typecheck.
- Manual smoke: open browser tile, navigate to a failing URL, verify evidence drawer shows load failure.

**Commit boundary:** `feat(browser): capture tile evidence diagnostics`

---

# Phase 2 — Browser QA Workbench

**Objective:** Turn browser evidence into a first-class app-testing surface while keeping the existing browser tile as the engine.

**Files likely touched:**
- Modify: `src/renderer/src/components/BrowserTile.tsx`
- Modify: `src/main/ipc/browserTile.ts`
- Modify: `src/renderer/src/utils/links.ts`
- Create: `bundled-extensions/qa-workbench/extension.json`
- Create: `bundled-extensions/qa-workbench/main.js`
- Create: `bundled-extensions/qa-workbench/tiles/workbench/index.html`
- Modify: `package.json` only if extra resource packaging requires it; prefer existing `bundled-extensions` copy rule
- Add tests: extension validator test or `test/main/qa-workbench-extension.test.mjs`

**Feature slices:**

### 2.1 Link open routing
Add user/app behavior for links from chat/tool output:
- open in existing browser tile
- open in new browser tile
- open in external default browser
- open in mini/full browser window later if needed

Use existing `dispatchOpenLink` in `src/renderer/src/utils/links.ts` rather than adding ad-hoc handlers.

### 2.2 Full-size browser affordance
Add “promote browser” behavior:
- browser tile can request focus/zoom/pan or open a larger duplicate view
- avoid a new BrowserWindow until current canvas/tile affordance is exhausted

### 2.3 Multi-tab browser state
Add lightweight tab model inside BrowserTile:
- `tabs: BrowserTabState[]`
- active tab id
- URL/title/loading/evidence per tab

Do this after evidence is stable. Do not mix with Phase 1.

### 2.4 QA Workbench bundled extension
Create a bundled extension that can:
- list active browser tiles via existing canvas/MCP/extension context where possible
- show browser evidence batches
- trigger refresh/screenshot/evidence clear
- produce a markdown QA report payload

If extension APIs are insufficient, add narrow host RPCs rather than making the extension read renderer internals.

### 2.5 MCP tools for QA evidence
Extend `src/main/mcp-server.ts` with read-only tools after the app APIs exist:
- `browser_list_tiles`
- `browser_get_evidence`
- `browser_capture_screenshot`

These should operate through existing BrowserTile state, not a second browser implementation.

**Verification:**
- `npm run validate-extension -- bundled-extensions/qa-workbench`
- `npm run typecheck:go`
- `npm test`
- Manual: browser tile → QA workbench tile → evidence report generated from real page errors.

**Commit boundary:** `feat(qa): add browser evidence workbench`

---

# Phase 3 — Agent Testing Loop

**Objective:** Add the “code actually works” loop: run tests, collect failures/evidence, route to agent, re-run until green.

**Files likely touched:**
- Create: `bundled-extensions/test-runner/extension.json` or extend `qa-workbench`
- Create: `bundled-extensions/test-runner/main.js`
- Create: `bundled-extensions/test-runner/tiles/runner/index.html`
- Modify: `src/main/mcp-server.ts` for test-runner MCP tools if needed
- Modify: `src/main/event-bus.ts` only if existing history/ring buffer is insufficient
- Modify: `src/renderer/src/components/chat/ToolBlockView.tsx` to show test-runner artifacts if needed
- Add tests under `test/main/` and `test/daemon/`

**Feature slices:**

### 3.1 Command/test profile discovery
Detect likely test commands from `package.json`:
- `test`
- `typecheck:go`
- `build`
- extension validation commands

Expose as a read-only list in the workbench.

### 3.2 Safe test runner backend
Extension main process spawns commands with:
- explicit workspace path
- bounded stdout/stderr capture
- timeout
- cancel support
- status events over bus

Do not use shell string interpolation for arbitrary user input. Prefer `spawn(command, args, { cwd })`.

### 3.3 Test artifact model
Persist run summaries under workspace-local `.codesurf/` or app state, not scattered temp files:
- command
- status
- duration
- exit code
- stdout/stderr excerpts
- full log path if needed
- linked browser evidence snapshot ids

### 3.4 Chat/tool presentation
When an agent runs tests, show:
- running spinner/status
- failed command
- top error excerpts
- “open full log” action
- “rerun” action

Reuse `ToolBlockView.tsx` and existing tool action patterns, do not create another message renderer.

### 3.5 MCP tool contract
Add tools only after backend is stable:
- `test_list_profiles`
- `test_run_profile`
- `test_get_run`
- `test_cancel_run`

### 3.6 Fix-until-green workflow
Add a workflow template, not magic:
- run selected profiles
- summarize failures
- agent patches
- rerun
- final report includes real command outputs

**Verification:**
- Unit tests for command parsing and bounded logs.
- Integration test for extension main command run with a harmless command.
- Manual: run `npm test` from test runner and see real exit/output.

**Commit boundary:** `feat(testing): add agent-visible test runner loop`

---

# Phase 4 — Frontend/design mode and visual verification

**Objective:** Address the strongest thread signal: frontend/design/creativity quality, using existing builder/sketch/chat surface infrastructure.

**Files likely touched:**
- Modify: `bundled-extensions/builder/extension.json`
- Modify: `bundled-extensions/builder/surface/index.html`
- Modify: `bundled-extensions/sketch/surface/index.html` only for handoff support if needed
- Modify: `src/renderer/src/components/chat/ChatComposer.tsx` and `ChatTile.tsx` only for host affordances
- Modify: `src/renderer/src/index.css` for shared tokens/classes
- Add: visual verifier helper under `src/main/storage/` or extension main if needed
- Add tests: extension validator, visual payload tests

**Feature slices:**

### 4.1 Builder “Design Mode” without rewrite
Start with bundled `builder` because it already ships as a chat surface.
Add modes:
- component
- page
- responsive page
- refine existing screenshot

Keep current payload/send path through `surface.setPayload`.

### 4.2 Screenshot/Figma/image import
Reuse chat attachment flow:
- image attachment in chat
- builder reads image context/attachment
- generates implementation or critique

Do not build a Figma API integration first. Start with pasted/exported screenshots.

### 4.3 Visual diff loop
Add a thin verifier:
- expected screenshot
- current browser screenshot
- dimensions/breakpoint
- diff metadata and thumbnail if feasible

This can live in QA Workbench/Test Runner first, then builder consumes the report.

### 4.4 Responsive breakpoint harness
For browser tile/test runner:
- desktop
- tablet
- mobile
- custom dimensions

Use BrowserTile’s existing desktop/mobile UA logic as the starting point, but separate viewport size from UA mode.

### 4.5 Design tokens extraction
Leverage existing theme/token files:
- `src/renderer/src/index.css`
- `src/renderer/src/theme.ts`
- `src/renderer/src/theme-tokens.ts`
- `src/renderer/src/themeResolution.ts`

Add a small “style DNA” payload that builder/design mode can consume rather than hardcoding new UI styles.

**Verification:**
- Validate builder extension.
- Manual: screenshot input → builder generates component/page → browser renders → verifier captures screenshot.
- Build/typecheck/test.

**Commit boundary:** `feat(design): add screenshot-driven frontend mode`

---

# Phase 5 — Executor + Validator agent orchestration

**Objective:** Make multi-agent SDLC orchestration a first-class CodeSurf pattern while reusing Kanban/MCP/event bus.

**Files likely touched:**
- Modify: `examples/extensions/agent-kanban` or promote/refine bundled copy if already bundled via `package.json` extraResources
- Modify: `src/main/mcp-server.ts`
- Modify: `src/main/event-bus.ts` only if lifecycle events need stronger typing/history
- Modify: `src/renderer/src/components/KanbanTile.tsx`
- Modify: `src/renderer/src/components/chat/PlanPane.tsx`
- Add tests under `test/daemon/` and `test/main/`

**Feature slices:**

### 5.1 Orchestration templates
Add templates for:
- Builder agent
- Validator agent
- QA/test agent
- Reviewer agent

Represent these as kanban lanes/cards and/or agent-kanban extension templates, not hidden background magic.

### 5.2 Agent run lifecycle model
Define event types:
- queued
- started
- heartbeat
- waiting for user
- failed
- cancelled
- complete
- validator rejected
- validator approved

Use existing event bus and MCP `card_update`, `card_complete`, `card_error` patterns.

### 5.3 Validator contract
Validator reads:
- diff summary
- test output
- browser evidence
- screenshots
- plan requirements

Validator emits:
- approve
- reject with concrete fix cards
- needs human decision

### 5.4 UI manifestation
Kanban card should show:
- current agent role
- last heartbeat
- linked browser/test evidence
- validator status

Chat should show a compact orchestration strip rather than dumping all logs into messages.

### 5.5 Safe cancellation/retry
Add cancel/retry controls using existing daemon/job cancellation paths where available. Do not invent a second process manager.

**Verification:**
- Tests for event shape and card state transitions.
- Manual: create plan → executor card → validator card → visible status updates.

**Commit boundary:** `feat(orchestration): add executor validator workflow`

---

# Phase 6 — Context Map / Repo Graph

**Objective:** Reduce context bleed and scope drift by making repo context visible and queryable.

**Files likely touched:**
- Promote or copy from: `examples/extensions/code-index`
- Create/modify: `bundled-extensions/code-index/*`
- Modify: `src/renderer/src/workers/discovery-graph.worker.ts`
- Modify: `src/renderer/src/workers/discovery-graph-impl.ts`
- Modify: `src/shared/connectionGraph.ts`
- Modify: `src/main/mcp-server.ts` to expose index queries if extension MCP is insufficient
- Add tests: reuse `examples/extensions/code-index/evals/unit/*.test.mjs` and add registry tests

**Feature slices:**

### 6.1 Promote code-index carefully
Run existing unit tests in `examples/extensions/code-index` first. Then copy/promote into `bundled-extensions/code-index` only if it is intended to ship by default.

### 6.2 Repo graph tile
Surface:
- hot files
- related files
- symbol search
- co-touch graph
- current agent context pins

### 6.3 Context pins
Allow user/agent to pin:
- files
- folders
- symbols
- notes
- screenshots/test artifacts

Pins should be visible in chat context usage and reusable by test/orchestration phases.

### 6.4 MCP index tools
Expose stable read-only tools:
- `context_find_symbol`
- `context_hot_files`
- `context_related_files`
- `context_get_pins`
- `context_set_pin` only if UI/user-approved

Prefer extension MCP tools if they already load cleanly.

### 6.5 Plan/goal integration
`PlanPane.tsx` can show context pins and gaps for each plan phase/card.

**Verification:**
- Existing code-index unit tests.
- Extension validator.
- Typecheck/test/build.
- Manual: index current repo, open context map, query related files.

**Commit boundary:** `feat(context): promote repo context map`

---

# Phase 7 — Git graph and review workbench

**Objective:** Deliver the thread’s git graph / branch compare / review asks by promoting existing source-control work instead of recreating it.

**Files likely touched:**
- Promote/refine: `examples/extensions/source-control` → `bundled-extensions/source-control`
- Modify: `src/renderer/src/components/chat/DiffView.tsx`
- Modify: `src/renderer/src/hooks/useChatGitState.ts`
- Modify: `src/renderer/src/components/chat/checkpointToolActions.ts`
- Add tests under `test/main/` or extension validator tests

**Feature slices:**

### 7.1 Validate existing source-control extension
Run:
- `npm run validate-extension -- examples/extensions/source-control`

Fix only extension-local issues first.

### 7.2 Promote to bundled
Copy to `bundled-extensions/source-control` once validated. Keep example as reference.

### 7.3 Branch compare
Add backend action:
- compare current branch with selected branch/base
- return file list + diff summary

Use `execFile('git', args)` with safe args, not shell strings.

### 7.4 Virtualized diff integration
Reuse `DiffView.tsx` for visual diff wherever possible.
If extension iframe cannot reuse React components, keep the extension UI simple and open detailed diff in native/chat route.

### 7.5 Agent review handoff
From git workbench:
- select changed files/commit range
- send to validator agent
- attach test/browser evidence

**Verification:**
- Extension validator.
- Tests for git command parsing if factored.
- Manual in a repo with branches: show graph, status, diff, compare branch.

**Commit boundary:** `feat(git): promote source control graph workbench`

---

# Phase 8 — Voice command layer for agent management

**Objective:** Add realtime voice management without replacing existing dictation/TTS.

**Files likely touched:**
- Modify: `src/renderer/src/hooks/useChatDictation.ts`
- Modify: `src/renderer/src/hooks/useAutoSpeak.ts`
- Modify: `src/renderer/src/utils/ttsPlayer.ts`
- Modify: `src/renderer/src/components/settings/VoiceSettingsEditor.tsx`
- Modify: `src/renderer/src/components/ChatTile.tsx` / extracted composer voice slot
- Add tests for command parsing if pure helper

**Feature slices:**

### 8.1 Voice command grammar
Start with local command routing from recognized text:
- “run tests”
- “open browser”
- “pause agent”
- “resume agent”
- “what is running”
- “summarize failures”

Keep normal dictation separate from command mode.

### 8.2 Push-to-talk manager
Add a compact voice manager control in chat/mini chat:
- dictation mode
- command mode
- TTS status
- stop speaking

### 8.3 Voice status answers
Reuse TTS to speak concise status summaries from:
- test runner status
- browser evidence counts
- agent lifecycle events

### 8.4 Safety confirmations
Voice can request actions, but destructive actions still require visible confirmation.

**Verification:**
- Unit tests for command parser.
- Manual: speak “run tests” and verify it queues the existing test runner command, not a fake response.

**Commit boundary:** `feat(voice): add agent management voice commands`

---

# Phase 9 — Remote/session handoff and notifications

**Objective:** Improve remote-only and cross-device workflows using existing session/daemon/sidebar state first.

**Files likely touched:**
- Modify: `src/main/daemon/client.ts`
- Modify: `src/main/daemon/manager.ts`
- Modify: `src/renderer/src/services/sessions.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/components/sidebar/session-ordering.ts`
- Modify: `src/renderer/src/components/sidebar/session-open.ts`
- Modify: `src/renderer/src/components/sidebar/session-actions.ts`
- Modify: `src/main/ipc/system.ts` or new notification IPC if required
- Add tests: sidebar/session tests already exist under `test/sidebar/`

**Feature slices:**

### 9.1 Thread handoff visibility
Ensure sessions started elsewhere appear in desktop sidebar with enough metadata to open or resume.

### 9.2 Last-active project sorting
Use existing `session-ordering.ts` and sidebar tests. Add project sorting by last active thread where needed.

### 9.3 Timed reminders
Add reminder records tied to session/thread:
- due at
- message
- target workspace/tile/session

Surface in sidebar and notifications.

### 9.4 Desktop notifications
Add safe opt-in native notifications for:
- agent needs input
- tests complete
- validator rejected/approved
- reminder due

### 9.5 Remote browser preview bridge
Only after Browser QA is stable, expose remote browser evidence/screenshot streams from daemon-managed sessions.

**Verification:**
- Existing sidebar tests plus new reminder/order tests.
- Manual: create simulated session/reminder, see sidebar/notification.

**Commit boundary:** `feat(sessions): add handoff reminders and notifications`

---

# Phase 10 — Electrobun compatibility follow-through

**Objective:** Keep the new roadmap compatible with the existing Electrobun shell without turning it into a migration rewrite.

**Files likely touched:**
- Modify: `src/electrobun/browser/electron-facade.ts`
- Modify: `electrobun/bun/index.ts`
- Modify: `src/shared/electrobun-rpc.ts`
- Modify/add tests: `test/electrobun-*.test.mjs`

**Feature slices:**

### 10.1 Mirror new IPC APIs
For every new Electron IPC surface added above, add an Electrobun facade entry only if needed by the renderer:
- browser evidence APIs
- test runner APIs if not extension-only
- notification no-op/fallback if unsupported

### 10.2 Browser parity notes
Electrobun webview currently has compatibility adapters in `BrowserTile.tsx`. Keep limitations explicit:
- per-view UA may not exist
- screenshot/evidence support may differ
- fallback iframe is limited

### 10.3 Smoke after each compatibility burst
Run:
- `npm run smoke:electrobun`
- `npm run acceptance:electrobun` for broader changes

**Commit boundary:** `chore(electrobun): mirror new runtime APIs`

---

## Suggested implementation order by shipped value

1. Phase 0 — audit/checkpoint/architecture map
2. Phase 1 — browser evidence substrate
3. Phase 2 — browser QA workbench
4. Phase 3 — agent testing loop
5. Phase 4 — design/frontend visual mode
6. Phase 5 — executor/validator orchestration
7. Phase 7 — git workbench promotion
8. Phase 6 — context map/repo graph
9. Phase 8 — voice manager
10. Phase 9 — handoff/notifications
11. Phase 10 — Electrobun parity after each relevant burst

Rationale: browser evidence and test-loop artifacts unlock every later phase. Design mode, validator agents, git review, and context maps all need real evidence to be useful.

---

## Validation ladder

Use the smallest relevant ladder per burst, then the full ladder before commit/release.

### Extension-only burst
```bash
npm run validate-extension -- bundled-extensions/<id>
npm test -- test/daemon/validate-extension.test.mjs
```

### Renderer/TypeScript burst
```bash
npm run typecheck:go
npm test
```

### Browser/main IPC burst
```bash
npm run typecheck:go
npm test
npm run build
```

### Electrobun-affecting burst
```bash
npm run typecheck:go
npm test
npm run smoke:electrobun
```

### Release confidence ladder
```bash
npm run typecheck:go
npm test
npm run build
npm run smoke:electrobun
```

Do not claim a feature is working solely from unit tests if the user-visible path has not been exercised.

---

## Risk register

1. `ChatTile.tsx` is large and already heavily featureful.
   - Mitigation: behavior-preserving extraction/polish only; no broad rewrite.

2. BrowserTile has Electron webview, Electrobun webview, and iframe fallback paths.
   - Mitigation: feature-detect capabilities and show unsupported states explicitly.

3. Extension examples may be prototypes with shell-command risks.
   - Mitigation: validate, harden, and promote in small bursts; avoid shell-string user input.

4. Test runner can become an unsafe arbitrary command launcher.
   - Mitigation: discovered profiles + explicit user-created profiles; bounded logs; no hidden destructive commands.

5. Multi-agent orchestration can hide too much state.
   - Mitigation: every agent run manifests as kanban/card/event/tool block status.

6. Context map/index can become stale or expensive.
   - Mitigation: incremental index, status health, manual refresh/backfill first.

7. Visual diff can become flaky.
   - Mitigation: start with deterministic screenshot capture + metadata before pixel-perfect diff gates.

8. Local dirty files may be unrelated active work.
   - Mitigation: Phase 0 checkpoint and ask before touching.

---

## Open questions for Jason

These do not block Phase 0/1, but they matter before later phases:

1. Should QA Workbench and Test Runner be separate bundled extensions, or one `qa-workbench` with test/browser tabs?
2. Should `source-control` be promoted as a bundled extension immediately after validation, or should Git graph be native inside the sidebar/chat first?
3. Should context map ship from `code-index` as a bundled extension, or remain example-only until it proves value?
4. Where should persistent test/browser artifacts live: workspace `.codesurf/` or CodeSurf app data under `~/.contex`?
5. For voice commands, should command mode require push-to-talk only, or allow wake/continuous mode later?

Recommended defaults:
- One `qa-workbench` extension with Browser + Tests tabs first.
- Promote `source-control` and `code-index` from examples only after validation/hardening.
- Store workspace-specific artifacts under workspace `.codesurf/` so they travel with the repo and are inspectable.
- Push-to-talk voice command mode only for the first implementation.

---

## First controlled burst proposal

If Jason says “do it”, start with Phase 0 + Phase 1.1/1.2 only:

1. Create architecture sidecar from this plan.
2. Add pure browser evidence types and ring buffer helper.
3. Extend main-process BrowserTile evidence capture for console/load failures.
4. Add tests for evidence buffer/helper.
5. Run `npm run typecheck:go` and `npm test`.
6. Stop and report with exact files changed and verification output.

Do not start QA Workbench UI until the evidence substrate is green.
