# CodeSurf Hardening & Decomposition — Multi-Agent Plan

## TL;DR

> **Goal**: Address P0 security/correctness gaps from the June 2026 codebase review, restore green CI, and begin surgical decomposition of god objects — executed by **8 parallel worker agents** across **4 waves** with an orchestrator gate between each wave.
>
> **Deliverables**:
> - MCP bearer auth enforced on all HTTP endpoints
> - SSRF protections on `stream:start`
> - Tile-state merge-on-write (no chat data loss)
> - Functional tile-create updater (no dropped tiles)
> - Green `npm test` + `npm run typecheck`
> - `useCanvasEngine` hook extracted (~1,500 LOC out of App.tsx)
> - `TileChrome` memoized for drag performance
>
> **Effort**: Large (XL) — ~3–5 orchestrator sessions
> **Parallel execution**: YES — 4 waves, up to 4 concurrent agents per wave
> **Critical path**: W1-A (MCP auth) → W2 integration gate → W4-A (canvas extract)

---

## Context

### Original request

Full codebase review (June 6, 2026) identified security gaps, correctness races, performance issues, and 7K-line god objects. User asked for a plan structured for **multiple agents** to execute in parallel.

### Interview summary

- **Scope**: P0 + P1 from review; defer full `ChatTile.tsx` / `chat.ts` splits to Phase 2
- **Approach**: Wave-based parallelism with strict file ownership; orchestrator owns merge + gates
- **Runtime**: Cursor Task subagents (or CodeSurf peer agents via MCP coordination)
- **Stack**: No new dependencies unless required (e.g. IP parsing can use Node `net`)

### Research findings

- `removeAllListeners` bug **fixed** — preload uses per-handler cleanup
- Undo/redo **fixed** — pre-change snapshots via refs
- MCP token generated but **not enforced** (`mcp-server.ts:1920-1921`)
- `saveWorkspaceTileState` does full replace — partial saves from `App.tsx:1234-1256` can wipe chat state
- `mountTile` uses `tilesRef.current` snapshot — race on rapid creates (`App.tsx:2228-2233`)
- Tests: **308/309 pass** — `examples/extensions/v2-hello` missing `main.js`
- Typecheck: ~20 errors (theme tokens, unused vars, footerExtensions types)
- `App.tsx`: 7,351 LOC; `ChatTile.tsx`: 6,381 LOC; `chat.ts`: 4,073 LOC

### Assumptions

- Target branch: `main` (or feature branch `feature/hardening-wave-1` created by orchestrator)
- Agents run in isolated git worktrees OR coordinate via CodeSurf `peer_set_state` + file ownership
- MCP auth breaking change is acceptable (local agents must read token from `~/.codesurf/mcp-server.json`)
- Workspace-root FS scoping remains **out of scope** (intentional dev-tool behavior)

---

## Work Objectives

### Core objective

Ship the highest-risk fixes from the codebase review and establish a decomposition foothold (`useCanvasEngine`) without a big-bang rewrite.

### Concrete deliverables

| ID | Deliverable |
|----|-------------|
| D1 | `Authorization: Bearer <token>` required on MCP `/mcp`, `/push`, `/inject`, SSE |
| D2 | `stream:start` blocks private/link-local/metadata IPs |
| D3 | `canvas:saveTileState` merge-on-write for partial payloads |
| D4 | `mountTile` / `replacePreviewTile` use functional `setTiles` |
| D5 | `npm test` → 309/309; `npm run typecheck` → 0 errors |
| D6 | `useCanvasEngine.ts` hook; `App.tsx` < 6,000 LOC |
| D7 | `React.memo(TileChrome)` with position/size comparator |

### Definition of Done

- [ ] All P0 scenarios S1–S4 pass (see Verification)
- [ ] `npm test && npm run typecheck` exit 0
- [ ] No agent edited files outside its ownership manifest
- [ ] Orchestrator merged all wave branches; `npm run build` succeeds
- [ ] `CODE_REVIEW.md` or plan evidence folder documents what shipped

### Must Have

- Tests for every P0 change (new `test/*.test.ts` files)
- Backward-compatible MCP: return `401` with clear JSON error when token missing
- Atomic tile-state writes preserved (`writeJsonArtifactAtomic`)

### Must NOT Have (guardrails)

- No full App.tsx rewrite in Wave 4 — extract one cohesive slice only
- No workspace-root FS lockdown (separate future initiative)
- No ChatTile / chat.ts decomposition in this plan
- No new state management library (Zustand, etc.) — hooks + refs only
- No drive-by refactors in owned files

---

## Verification Strategy

### Test decision

- **Infrastructure exists**: YES — `node --test test/*.test.ts`
- **Automated tests**: Tests-after (security fixes first, tests prove behavior)
- **Framework**: Node built-in test runner
- **Build gate**: `npm run build` after Wave 4

### Scenarios

| ID | Scenario | Pass condition | Test id |
|----|----------|---------------|---------|
| S1 | MCP rejects unauthenticated POST /inject | 401 without Bearer; 200 with valid token | `test/mcp-auth.test.ts` |
| S2 | MCP rejects unauthenticated tools/call | 401 on `/mcp` JSON-RPC without header | `test/mcp-auth.test.ts` |
| S3 | stream:start blocks 127.0.0.1 / 10.x / 169.254.x | IPC throws or returns `{ ok: false }` | `test/stream-ssrf.test.ts` |
| S4 | Partial tile save preserves existing messages | Save `{agentMode:true}` then read — messages intact | `test/tile-state-merge.test.ts` |
| S5 | Rapid mountTile does not drop tiles | 10 parallel creates → 10 tiles in state | `test/canvas-tile-create.test.ts` (renderer unit or main integration) |
| S6 | CI green | `npm test` 0 failures | existing suite |
| S7 | Typecheck clean | `npm run typecheck` exit 0 | tsc |
| S8 | Canvas extract compiles | `npm run build` exit 0 | build |

Evidence → `.plans/evidence/wave-{N}-{agent}-{scenario}.txt`

---

## Execution Strategy

### Roles

| Role | Responsibility |
|------|----------------|
| **Orchestrator** | Branch/worktree setup, spawn agents, merge PRs, run gates, resolve conflicts |
| **Worker** | Implement one task manifest; self-verify; report files touched |
| **Reviewer** | Post-wave diff review (code-reviewer subagent or `/check-work`) |

### Coordination protocol (CodeSurf / multi-agent)

On task start, each worker calls:
1. `peer_set_state` — status `working`, files array = ownership manifest
2. `peer_get_state` — abort if another peer owns overlapping files
3. `peer_send_message` to orchestrator tile on completion with: branch name, test output, blockers

### Wave diagram

```
Wave 0 (Orchestrator, sequential)
  └─ branch + worktrees + task queue

Wave 1 (4 agents PARALLEL) — P0 Security & Correctness
  ├─ W1-A: MCP Auth          [mcp-server.ts, index.ts]
  ├─ W1-B: Stream SSRF        [stream.ts]
  ├─ W1-C: Tile State Merge   [canvas.ts, workspaceArtifacts.ts]  ← no App.tsx
  └─ W1-D: FS Hardening       [fs.ts]

Wave 2 (3 agents PARALLEL) — CI & Correctness (after W1 gate)
  ├─ W2-A: App Tile Races     [App.tsx mountTile only]
  ├─ W2-B: Typecheck Sweep    [theme-tokens, footerExtensions, etc.]
  └─ W2-C: Extension CI Fix   [examples/extensions/v2-hello]

Wave 3 (2 agents PARALLEL) — Performance (after W2 gate)
  ├─ W3-A: TileChrome memo    [TileChrome.tsx]
  └─ W3-B: Snap throttle      [App.tsx drag handlers — owns drag slice only]

Wave 4 (1 agent, sequential) — Decomposition (after W3 gate)
  └─ W4-A: useCanvasEngine    [new hook + App.tsx import refactor]

Final: Reviewer + npm run build + merge to main
```

### Dependency matrix

| Task | Blocked by | Blocks |
|------|-----------|--------|
| W1-* | Wave 0 | Wave 2 gate |
| W2-A | W1-C (merge API stable) | W3-B, W4-A |
| W2-B | Wave 1 gate | — |
| W2-C | — | — |
| W3-B | W2-A | W4-A |
| W4-A | W3-* | Final gate |

### File ownership (conflict prevention)

| Agent | Owns exclusively |
|-------|------------------|
| W1-A | `src/main/mcp-server.ts`, `src/main/index.ts` (mcp:saveServers only), `test/mcp-auth.test.ts` |
| W1-B | `src/main/ipc/stream.ts`, `src/main/utils/urlSafety.ts` (new), `test/stream-ssrf.test.ts` |
| W1-C | `src/main/storage/workspaceArtifacts.ts`, `src/main/ipc/canvas.ts`, `test/tile-state-merge.test.ts` |
| W1-D | `src/main/ipc/fs.ts`, `test/fs-write-brief.test.ts` |
| W2-A | `src/renderer/src/App.tsx` (lines: mountTile, replacePreviewTile, proximity save calls only) |
| W2-B | `src/renderer/src/theme-tokens.ts`, `footerExtensions.ts`, `SidebarFooter.tsx`, `TileChrome.tsx` (TS errors only), `providerIcons.tsx`, `Toggle.tsx`, `canvas.ts` service, `connectionGraph.ts` |
| W2-C | `examples/extensions/v2-hello/**` |
| W3-A | `src/renderer/src/components/TileChrome.tsx` (memo only — coordinate with W2-B if TS fixes landed) |
| W3-B | `src/renderer/src/App.tsx` (drag/snap handlers only) |
| W4-A | `src/renderer/src/hooks/useCanvasEngine.ts` (new), `App.tsx` (extract imports) |

**Rule**: W2-B finishes before W3-A if both touch `TileChrome.tsx`; orchestrator sequences W2-B → W3-A.

---

## TODOs

### Wave 0 — Orchestrator setup

#### TASK-0: Bootstrap

- **Agent**: Orchestrator
- **Blocked by**: —
- **Files**: `.plans/codesurf-hardening-decomposition.md`, git branches
- **Action**:
  1. `git checkout -b feature/hardening-wave-1`
  2. Create worktrees or assign agent branches: `w1-a-mcp-auth`, `w1-b-stream-ssrf`, etc.
  3. Post task manifests to each agent (copy agent section below)
  4. Run baseline: `npm test 2>&1 | tee .plans/evidence/baseline-test.txt`
- **Verify**: baseline captured; branch exists

---

### Wave 1 — P0 parallel (4 agents)

#### TASK-W1-A: MCP bearer auth

- **Agent**: Security-MCP
- **Blocked by**: TASK-0
- **Files**: `src/main/mcp-server.ts`, `src/main/index.ts`, `test/mcp-auth.test.ts`
- **Action**:
  1. Add `requireMcpAuth(req, res): boolean` — check `Authorization: Bearer ${MCP_TOKEN}`
  2. Apply to: `POST /mcp`, `POST /push`, `POST /inject`, SSE subscribe routes
  3. Return 401 JSON `{ error: 'Unauthorized' }` on failure
  4. Keep loopback host check (defense in depth)
  5. Fix `mcp:saveServers` to write config with mode `0o600`
  6. Update `chat.ts` MCP client if header format differs (already sends Bearer)
- **Verify**: `node --test test/mcp-auth.test.ts`; S1, S2 pass

**Agent prompt**:
```
You own src/main/mcp-server.ts and test/mcp-auth.test.ts only.
Enforce Bearer token auth on all MCP HTTP endpoints. Token is MCP_TOKEN constant.
Do not disable auth. Add tests proving 401 without header and success with valid token.
Run: node --test test/mcp-auth.test.ts
```

---

#### TASK-W1-B: Stream SSRF protection

- **Agent**: Security-Stream
- **Blocked by**: TASK-0
- **Files**: `src/main/ipc/stream.ts`, `src/main/utils/urlSafety.ts`, `test/stream-ssrf.test.ts`
- **Action**:
  1. Create `assertSafeStreamUrl(url: string): void`
  2. Block: localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, link-local
  3. Allow only `http:` and `https:`
  4. Call before `httpRequest` in `stream:start`; reject with clear error
  5. Document that external agent URLs must use public hosts (or future allowlist setting)
- **Verify**: `node --test test/stream-ssrf.test.ts`; S3 pass

**Agent prompt**:
```
You own src/main/ipc/stream.ts and src/main/utils/urlSafety.ts (create).
Add SSRF protection to stream:start. Block private and link-local IPs.
Write test/stream-ssrf.test.ts with cases for 10.0.0.1, 169.254.169.254, public OK.
```

---

#### TASK-W1-C: Tile state merge-on-write

- **Agent**: Correctness-Persistence
- **Blocked by**: TASK-0
- **Files**: `src/main/storage/workspaceArtifacts.ts`, `src/main/ipc/canvas.ts`, `test/tile-state-merge.test.ts`
- **Action**:
  1. In `saveWorkspaceTileState`, if file exists: read → deep-merge objects (top-level keys; arrays replace not concat) → write
  2. Add `mergeTileState(existing: unknown, patch: unknown): unknown` helper
  3. Preserve atomic write via `writeJsonArtifactAtomic`
  4. Add test: seed full chat state, patch `{agentMode:true}`, assert messages preserved
- **Verify**: `node --test test/tile-state-merge.test.ts`; S4 pass

**Agent prompt**:
```
You own workspaceArtifacts.ts and canvas.ts save path only.
Implement merge-on-write for saveWorkspaceTileState so partial patches don't wipe chat history.
Test in test/tile-state-merge.test.ts.
```

---

#### TASK-W1-D: FS writeBrief hardening

- **Agent**: Security-FS
- **Blocked by**: TASK-0
- **Files**: `src/main/ipc/fs.ts`, `test/fs-write-brief.test.ts`
- **Action**:
  1. Validate `cardId` — alphanumeric + hyphen only; reject `..`, `/`, `\`
  2. Add test for traversal attempt
- **Verify**: `node --test test/fs-write-brief.test.ts`

---

### Wave 1 gate — Orchestrator

#### TASK-G1: Merge Wave 1

- **Agent**: Orchestrator
- **Action**: Merge w1-a..w1-d → `feature/hardening-wave-1`; resolve conflicts; `npm test`
- **Verify**: all W1 tests pass; no duplicate auth logic

---

### Wave 2 — CI & App correctness (3 agents)

#### TASK-W2-A: mountTile functional updater

- **Agent**: Canvas-Races
- **Blocked by**: TASK-G1, TASK-W1-C
- **Files**: `src/renderer/src/App.tsx` (mountTile, replacePreviewTile, proximity handler)
- **Action**:
  1. Replace `[...tilesRef.current, newTile]` with `setTiles(prev => [...prev, newTile])` + read updated list from callback or follow-up ref sync
  2. Same for `replacePreviewTile`
  3. Optionally switch proximity `saveTileState` to rely on server merge (W1-C) — add comment
  4. Use `tile-${Date.now()}-${nanoid(6)}` for IDs if nanoid already a dep
- **Verify**: manual or unit test S5; no regression in `npm test`

**Agent prompt**:
```
You own App.tsx functions mountTile, replacePreviewTile only.
Fix tile creation race using functional setTiles updaters.
Do not refactor unrelated App.tsx code.
```

---

#### TASK-W2-B: Typecheck sweep

- **Agent**: Types-Sweep
- **Blocked by**: TASK-G1
- **Files**: per ownership table — theme, footer, sidebar, services
- **Action**:
  1. Run `npm run typecheck`; fix all errors
  2. Add missing `overlay` to theme tokens OR update ChatComposer to use `sidebarOverlay`
  3. Fix `footerExtensions.ts` type predicate (`icon: string | null` → filter nulls)
  4. Remove unused imports/vars
- **Verify**: `npm run typecheck` exit 0

---

#### TASK-W2-C: Fix v2-hello extension

- **Agent**: Extensions-CI
- **Blocked by**: TASK-G1
- **Files**: `examples/extensions/v2-hello/`
- **Action**: Add missing `main.js` stub OR remove example from validation set — prefer minimal working extension
- **Verify**: `npm test` → 309/309

---

### Wave 2 gate — Orchestrator

#### TASK-G2: Merge Wave 2

- **Action**: Merge; `npm test && npm run typecheck`

---

### Wave 3 — Performance (2 agents, sequential on TileChrome)

#### TASK-W3-B: Snap guide throttle

- **Agent**: Perf-Drag
- **Blocked by**: TASK-G2, TASK-W2-A
- **Files**: `App.tsx` drag handlers only
- **Action**:
  1. Throttle snap guide recalc to `requestAnimationFrame` or every 2 frames
  2. During drag, avoid `setTiles` for guide lines — use ref + CSS overlay or single guide state
- **Verify**: `npm run perf:render` if baseline exists; manual drag smoke

---

#### TASK-W3-A: TileChrome memo

- **Agent**: Perf-Tiles
- **Blocked by**: TASK-W2-B (TileChrome TS clean)
- **Files**: `TileChrome.tsx`
- **Action**:
  1. `export default React.memo(TileChrome, (prev, next) => …)` — compare id, x, y, w, h, zIndex, selected, type
  2. Ensure callback props are stable or accept re-render on selection only
- **Verify**: drag 20+ tiles — CPU profile or subjective; build passes

---

### Wave 3 gate

#### TASK-G3: Merge Wave 3; `npm test && npm run typecheck`

---

### Wave 4 — Decomposition (1 agent)

#### TASK-W4-A: Extract useCanvasEngine

- **Agent**: Arch-Canvas
- **Blocked by**: TASK-G3
- **Files**: `src/renderer/src/hooks/useCanvasEngine.ts`, `App.tsx`
- **Extract**:
  - `viewport` / `setViewport` + refs
  - `screenToWorld` / `worldToScreen`
  - `saveCanvas` / `persistCanvasState` / undo refs
  - `historyBack` / `historyForward` / undo/redo handlers
  - Constants: `SNAP_THRESHOLD`, zoom limits
- **Leave in App**: tile CRUD, panel layout, sidebar, settings, render tree
- **Target**: App.tsx −1,200 LOC minimum; hook fully typed
- **Verify**: S8 — `npm run build`; canvas pan/zoom/undo manual smoke

**Agent prompt**:
```
Extract useCanvasEngine hook from App.tsx. Move viewport, coordinates, saveCanvas, undo/redo.
App.tsx imports and uses the hook. No behavior changes. Run npm run build.
```

---

### Final verification wave

#### TASK-FINAL: Review & ship

- **Agent**: Reviewer (code-reviewer subagent)
- **Blocked by**: TASK-W4-A
- **Action**:
  1. Review full diff vs `main`
  2. Confirm all scenarios S1–S8
  3. `npm test && npm run typecheck && npm run build`
  4. Update `CODE_REVIEW.md` with June 2026 → post-fix status table
- **Verify**: all green; PR ready

---

## Phase 2 backlog (separate plan — not in this run)

| Initiative | Agents | Est. |
|------------|--------|------|
| Split `chat.ts` by provider | 6 parallel | XL |
| Split `mcp-server.ts` tools | 3 parallel | Large |
| Extract `useChatTile` from ChatTile.tsx | 2 sequential | XL |
| Workspace-root FS option | 1 | Medium |
| Canvas integration tests (Playwright) | 1 | Large |
| Electrobun facade parity checklist | 2 | Large |

---

## Orchestrator launch commands

### Cursor / Grok (this environment)

```text
# Wave 1 — launch in ONE message, 4 parallel Task calls:

Task: W1-A MCP Auth — [paste W1-A agent prompt + file ownership]
Task: W1-B Stream SSRF — [paste W1-B agent prompt]
Task: W1-C Tile Merge — [paste W1-C agent prompt]
Task: W1-D FS Brief — [paste W1-D agent prompt]

# After all complete → TASK-G1 merge → Wave 2 (3 parallel) → etc.
```

### CodeSurf canvas

```text
# Create 4 terminal/chat tiles, one per W1 agent.
# Each agent: peer_set_state with files array before editing.
# Orchestrator tile runs gates only.
```

### execute-plan style (if using /execute-plan)

Map tasks to PR DAG:
- `pr-mcp-auth` (no deps)
- `pr-stream-ssrf` (no deps)
- `pr-tile-merge` (no deps)
- `pr-fs-brief` (no deps)
- `pr-tile-races` (deps: pr-tile-merge)
- `pr-typecheck` (deps: wave1 merge)
- `pr-v2-hello` (no deps)
- `pr-perf-memo` (deps: pr-typecheck)
- `pr-perf-drag` (deps: pr-tile-races)
- `pr-canvas-hook` (deps: pr-perf-memo, pr-perf-drag)

`--concurrency 4` for Wave 1 PRs.

---

## Success Criteria

1. **Security**: Unauthenticated MCP calls return 401; SSRF blocked
2. **Correctness**: Partial tile saves never wipe chat messages; rapid tile create safe
3. **Quality**: 309/309 tests; 0 typecheck errors
4. **Performance**: TileChrome memoized; snap throttled
5. **Maintainability**: `useCanvasEngine.ts` exists; App.tsx measurably smaller
6. **Process**: No file ownership violations; evidence in `.plans/evidence/`

---

## Risk register

| Risk | Mitigation |
|------|------------|
| App.tsx merge conflicts (W2-A + W3-B + W4-A) | Strict line ownership; sequential W3-B before W4-A |
| MCP auth breaks external agents | Document token path; update `.mcp.json` template |
| Merge-on-write masks intentional deletes | Arrays replace; document contract; `canvas:clearTileState` unchanged |
| useCanvasEngine extraction breaks drag | Gate on build + manual pan/zoom/undo before merge |
| TileChrome memo breaks selection UX | Custom comparator includes `selected` / `selectedTileIds` |