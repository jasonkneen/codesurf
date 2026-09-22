# Performance

This section covers performance findings for the contex Electron app, concentrated in two hot zones: the canvas render path (`src/renderer/src/App.tsx`, `TileChrome.tsx`, `Minimap.tsx`) and the session/thread-indexing subsystem (`src/main/db/thread-indexer.ts`, `src/main/session-sources.ts`, `src/main/ipc/canvas.ts`). The headline issue is that panning the canvas — which should be a near-free GPU transform — instead triggers O(tiles) React reconciliation per frame because no memo boundary exists between the viewport state and per-tile JSX. The second cluster is the thread indexer deliberately busting its own session cache and running a fully-uncached 7-provider disk + SQLite fan-out on the Electron main process. The remaining findings are cheaper complements: dead rAF batching machinery, per-frame listener churn, an IPC broadcast storm, an unvirtualized session list, per-token markdown re-parsing, an unbounded DB query, and a minimap that redraws the whole canvas every pan frame.

## Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| perf-01 | Canvas pan re-renders all tiles + unmemoized `TileChrome` despite transform-only viewport | High | L | `src/renderer/src/App.tsx`, `src/renderer/src/components/TileChrome.tsx` |
| perf-04 | Thread indexer busts session cache and runs a full uncached 7-provider disk scan on the main process | High | M | `src/main/db/thread-indexer.ts`, `src/main/session-sources.ts`, `src/main/ipc/canvas.ts` |
| perf-02 | rAF viewport throttle (`scheduleViewportUpdate`) is dead code; pan/zoom call `setViewport` directly | Medium | S | `src/renderer/src/App.tsx` |
| perf-05 | Wildcard `'*'` `sessionsChanged` broadcast forces Sidebar to re-fetch every loaded workspace | Medium | M | `src/main/db/thread-indexer.ts`, `src/renderer/src/components/Sidebar.tsx`, `src/main/ipc/canvas.ts` |
| perf-06 | Sidebar session list is progressively paginated, not virtualized — mounted rows grow unbounded | Medium | M | `src/renderer/src/components/Sidebar.tsx` |
| perf-07 | Streaming chat re-parses the entire growing message through Streamdown ~20x/sec | Medium | M | `src/renderer/src/components/ChatTile.tsx`, `src/renderer/src/components/shared/streamdown-utils.tsx`, `src/renderer/src/components/chat/largeContent.ts` |
| perf-03 | Wheel listener re-registered on every viewport change (non-passive add/remove churn) | Low | S | `src/renderer/src/App.tsx` |
| perf-08 | `listThreadsFromDb(null)` does `SELECT *` with no `LIMIT` — unbounded IPC payload | Low | S | `src/main/db/thread-indexer.ts`, `src/main/ipc/canvas.ts` |
| perf-09 | Minimap redraws the whole canvas (`Math.min/max` spread over all tiles) every pan frame when shown | Low | S | `src/renderer/src/components/Minimap.tsx`, `src/renderer/src/App.tsx` |

---

### perf-01 — Canvas pan re-renders all tiles + unmemoized `TileChrome` despite transform-only viewport

**Severity:** High · **Effort:** L (Large)
**Category:** canvas-hot-path / react-rerender
**Files:** `src/renderer/src/App.tsx`, `src/renderer/src/components/TileChrome.tsx`

**Problem.** Panning changes only `viewport.tx`/`viewport.ty`, which are applied as a single CSS `transform: translate(tx, ty) scale(zoom)` on ONE world container (`src/renderer/src/App.tsx:6100`). No per-tile value depends on `tx`/`ty`. Yet each mousemove calls `setViewport` (`src/renderer/src/App.tsx:2740`), which re-renders the entire ~7,300-LOC `App` component and re-executes the unmemoized `tiles.filter(...).map(tile => ...)` loop (`App.tsx:6604`+). Each iteration recomputes `handlePoint`/`getNearestTileSide`/`getConnectionHandlePoint`, four side-sensor style objects, and renders `<LazyTileChrome>` (`TileChrome` is NOT memoized) plus calls `renderTileBody(tile)` inline (`App.tsx:6652`). Pan, which should be a near-free GPU transform, instead does O(tiles) React reconciliation per frame. Blast radius scales with tile count and is worst with heavy tiles mounted.

**Evidence.**
- `src/renderer/src/App.tsx:6100` — `transform: translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.zoom})`: a pure container transform, no per-tile `tx`/`ty` use.
- `src/renderer/src/App.tsx:2740` — `setViewport(prev => ({ ...prev, tx: dragState.initTx + dx, ty: dragState.initTy + dy }))`.
- `src/renderer/src/App.tsx:2987` — wheel handler also calls `setViewport` directly.
- `src/renderer/src/components/TileChrome.tsx:1010` — `export function TileChrome({` — no `React.memo` wrapper.
- `src/renderer/src/App.tsx:6652` — `renderTileBody(tile, {...})` called inline inside the map.
- `src/renderer/src/App.tsx:6621` — `handleSize = 22 / Math.max(0.25, viewport.zoom)` — depends on `zoom` only, never `tx`/`ty`, so panning has zero legitimate per-tile work to do.

**Recommendation.** Extract a memoized `<CanvasTile>` component (`React.memo`) compared on `[tile, viewport.zoom, isSelected, isActiveDrag, connection state]` — explicitly NOT `tx`/`ty` — so panning skips per-tile reconciliation entirely. Wrap `TileChrome` in `React.memo`. Move the inline sensor/handle computations into that memoized child. This is the highest-leverage canvas fix; it makes pan O(1) in React work.

**Verifier critique.** Every cited location verified exactly as described. `App.tsx:6100` is a single world-container `transform: translate(tx,ty) scale(zoom)`; pan handler at `2740` does `setViewport(prev => ({...prev, tx, ty}))`; wheel at `2987`; tiles loop at `6604` with inline `renderTileBody(tile, ...)` at `6652`; `handleSize = 22/Math.max(0.25, viewport.zoom)` at `6621` (zoom-only). `viewport` is `useState` in `App` (`App.tsx:1040`) and `App` is the component (`1033`), so every pan mousemove re-renders the whole component and re-executes the inline `tiles.filter().filter().map()` loop. `TileChrome` is a plain `export function TileChrome` (`TileChrome.tsx:1010`) with no `React.memo` and no default export; `LazyTileChrome` (`App.tsx:78`) lazy-loads `m.TileChrome` directly, so no memo boundary exists. `renderTileBody` is a plain inline function in the `App` body (`App.tsx:4045`), redefined every render.

LINCHPIN (what makes the fix provably correct, not just plausible): during a pure pan, ONLY `tx`/`ty` change. `isActiveDrag` is false (`dragState.type === 'pan'`, not tile/resize/group); `canvasPointerWorld` is untouched by the pan handler (`2725`-`2740` only sets viewport); `viewport.zoom`, `selectedTileId`/`selectedTileIds`, `hoveredConnectionHandle` are all constant; `negotiatedDiscoveryState` is memoized (`4288`). `tx`/`ty` are never passed to per-tile JSX. So a memoized child compared on `[tile, zoom, isSelected, isActiveDrag, connection state]` (explicitly NOT `tx`/`ty`) would skip all per-tile work during pan.

SCOPE CRITIQUE the recommendation glosses (a real implementation constraint, not a blocker): you CANNOT pass `renderTileBody(tile)` as `children` to a memoized `CanvasTile` — a fresh element every render defeats memo. The body `switch` must move INSIDE the memoized child, threading `renderTileBody`'s closure deps as props: `workspace`, `settings`, `appFonts`, `negotiatedDiscoveryState`, plus `closeTile`/`bringToFront`/`handleTileMouseDown`/`handleResizeMouseDown`/`handleTileContextMenu`/`enterExpandedMode`, etc. Inline `onClose={() => closeTile(tile.id)}` closures are NOT a blocker — they move inside the child and stop mattering, since memo compares props passed TO `CanvasTile`. The handlers it consumes are already `useCallback`-stable (`screenToWorld` `1980`, `handleConnectionMouseDown` `2669`, `showConnectionHandleForSide` `2686`, `scheduleConnectionHandleHide` `2694`) and the geometry helpers are module-level pure (`798`/`805`/`823`). This threading is why effort is correctly rated L.

ONE OVERSTATEMENT to flag (does not lower severity): "tile bodies (Monaco/terminal/browser) also reconcile every pan frame" overstates the mechanism. The React reconciliation pass does run O(tiles), but Monaco/xterm/webview manage DOM imperatively, so they will NOT re-layout — the per-frame cost is element-diffing/JS, not heavy-tile DOM re-render. Severity stays honestly HIGH because the avoidable cost is real (O(tiles x ~7 elements) of JS reconciliation per frame on the core pan interaction), not because heavy leaves re-render. No mitigation exists anywhere; confirmed, high.

---

### perf-04 — Thread indexer busts session cache and runs a full uncached 7-provider disk scan on the main process

**Severity:** High · **Effort:** M (Medium)
**Category:** synchronous / heavy fs in main process
**Files:** `src/main/db/thread-indexer.ts`, `src/main/session-sources.ts`, `src/main/ipc/canvas.ts`

**Problem.** `listExternalSessionEntries` has a sound 60s stale-while-revalidate (SWR) cache (`src/main/session-sources.ts:1684-1703`), but the thread indexer deliberately defeats it: `runScan` calls `invalidateExternalSessionCache()` immediately before `listExternalSessionEntries(null, { force: true })`. With the cache deleted, the `force && cached` fast-path can't hit, so it falls through to a full uncached `refreshExternalSessionEntries` — `Promise.allSettled` across CodeSurf/Claude/Codex/Hermes/Cursor/OpenClaw/OpenCode scanners. Claude and Codex each readdir/stat then `Promise.all` over up to 500 files, doing head (24KB) + tail (96KB) reads per file (or full read under 256KB); Hermes opens a SQLite DB with correlated subqueries; Cursor opens up to 60 SQLite DBs. All of this runs in the Electron main process (not a worker), and `indexAllSources` is triggered from four `canvas.ts` IPC paths plus startup. The 10s `SCAN_MIN_INTERVAL` throttle helps, but each scan that does run is a heavy, fully-uncached fan-out.

**Evidence.**
- `src/main/db/thread-indexer.ts:180` — `invalidateExternalSessionCache()` then `181` — `await listExternalSessionEntries(null, { force: true }).catch(() => [])`.
- `src/main/session-sources.ts:1693` — `if (options?.force && cached)` — only short-circuits when a cache entry still exists, which the prior invalidate guarantees it does not.
- `src/main/session-sources.ts:1161-1164` / `1335-1338` — `.slice(0, 500)` then `Promise.all` of per-file reads.
- `src/main/session-sources.ts:1719` — `Promise.allSettled([...7 scanners])`.
- Call sites in `src/main/ipc/canvas.ts:805, 812, 837, 898`.

**Recommendation (refined).** Move the 7-provider fan-out into a `worker_thread` / `utilityProcess` — that is the ONLY substantive fix. Do NOT lead with "drop `invalidateExternalSessionCache()` and lean on SWR": that change is nearly a no-op for the stated problem and introduces a correctness regression.

- (a) SWR's fast-path returns STALE cached entries synchronously while firing `refreshExternalSessionEntries` in the background — but that background refresh still runs the full uncached fan-out on the main process (no worker exists), so the synchronous `better-sqlite3` calls (Hermes 3 correlated subqueries x up to 500 rows at `session-sources.ts:1445-1470`; up to 60 Cursor DB opens at `1540-1545`) still stall the main thread; you've only detached them from the `await`.
- (b) The indexer's explicit purpose is to "see fresh files" (comment at `thread-indexer.ts:179`); feeding it stale SWR entries means it indexes stale data every run.

So the real win is the worker move (where synchronous SQLite no longer blocks the main process), plus optionally lowering the listing-pass caps below 500 for Claude/Codex. Note: the file reads themselves are async `fs.promises`/streams (24KB head + 96KB tail per file, exact-scan under 256KB), so the "blocking" cost on the main thread is the JSON parsing and the synchronous SQLite work, not the I/O — the finding's "synchronous fs / blocks main thread" framing is overstated for the file reads but accurate for the SQLite scans.

**Verifier critique.** Evidence is accurate and precisely described. Verified: `thread-indexer.ts:180-181` `invalidateExternalSessionCache()` (no-arg → `externalSessionCache.clear()` at `session-sources.ts:2189`) immediately before `listExternalSessionEntries(null,{force:true})`, which guarantees the `force && cached` SWR fast-path at `1693` cannot hit and falls through to `refreshExternalSessionEntries` → `Promise.allSettled` over 7 scanners (`1719-1727`). Confirmed: `EXTERNAL_SESSION_CACHE_MS=60_000` (finding's prose correctly says 60s; the "15s" only appears in a stale source comment at line `179`, not a finding error); Claude/Codex `.slice(0,500)` + per-file head(24KB)/tail(96KB) reads (`1164`/`1338`, `662-663`/`1303-1304`); Cursor `.slice(0,60)` SQLite opens (`1533`); Hermes correlated subqueries (`1445-1470`). Confirmed no `worker_thread`/`utilityProcess` anywhere in `src/main` — runs on the main process; `SCAN_MIN_INTERVAL_MS=10_000`; `ensureInitialIndex` at startup (`index.ts:44`). All four `canvas.ts` call sites confirmed (`805, 812, 837, 898`).

Severity kept at high: the trigger chain — `canvas:listSessions(forceRefresh=true)` reaches `indexAllSources()` at line `805`, and `forceRefresh=true` fires on every window focus (`Sidebar.tsx:1243`, stale-gated) and after every session mutation (delete/rename/archive/title-gen), not just explicit clicks. The 10s throttle caps it, but a focus refresh >10s after the last scan eats a full uncached fan-out with synchronous SQLite stalls — a recurring, user-perceptible main-process cost. Marked practical=false because the finding's primary recommendation (drop the invalidate / use SWR) does not fix the performance problem and adds a staleness regression; only the secondary recommendation (worker move) is sound.

---

### perf-02 — rAF viewport throttle (`scheduleViewportUpdate`) is dead code; pan/zoom call `setViewport` directly

**Severity:** Medium · **Effort:** S (Small)
**Category:** canvas-hot-path / no-batching
**Files:** `src/renderer/src/App.tsx`

**Problem.** A `requestAnimationFrame` coalescing helper, `scheduleViewportUpdate`, is defined (`src/renderer/src/App.tsx:1366`) together with `pendingViewportRef`/`viewportAnimationFrameRef` plumbing, clearly intended to batch viewport updates to one per frame. But grep shows it is never called anywhere in the file — it is dead code. The pan move handler (`2740`) and the wheel handler (`2987`) both call `setViewport` directly. Chromium coalesces input events to ~frame rate so the practical damage is limited, but the unused machinery is misleading (suggests batching exists when it doesn't) and leaves the per-frame full re-render of perf-01 unmitigated.

**Evidence.** grep `scheduleViewportUpdate` across `App.tsx` returns exactly one hit — the definition at line `1366`. No call sites. Pan (`2740`) and wheel (`2987`) bypass it entirely. Cleanup of `viewportAnimationFrameRef` lives at `1375-1379`.

**Recommendation.** Either route pan/zoom `setViewport` through `scheduleViewportUpdate` (cheap, removes any sub-frame double-renders and makes intent real) or delete the dead helper + refs to avoid confusion. The bigger win is perf-01; this is the cheap complement.

---

### perf-05 — Wildcard `'*'` `sessionsChanged` broadcast forces Sidebar to re-fetch every loaded workspace

**Severity:** Medium · **Effort:** M (Medium)
**Category:** ipc chattiness / react-rerender
**Files:** `src/main/db/thread-indexer.ts`, `src/renderer/src/components/Sidebar.tsx`, `src/main/ipc/canvas.ts`

**Problem.** Whenever a thread-index scan produces ANY insert/update/tombstone, it broadcasts `canvas:sessionsChanged` with `workspaceId:'*'`. The Sidebar's handler treats `'*'` as "refresh everything": it iterates `loadedSessionWorkspaceIdSet` and calls `loadWorkspaceSessions(entry, false)` for each, every one an `await window.electron.canvas.listSessions(workspaceId)` IPC round-trip that returns a fresh array and runs `setSessions(prev => [...filtered, ...annotated])`. With many loaded workspaces this is an IPC storm + a full Sidebar re-render per scan. A single new message in one session can trigger a re-fetch + re-render for all workspaces.

**Evidence.**
- `src/main/db/thread-indexer.ts:381` — `if (inserts > 0 || tombstoned > 0 || updates > 0) { broadcastToRenderer('canvas:sessionsChanged', { workspaceId: '*' }) }`.
- `src/renderer/src/components/Sidebar.tsx:1217` — `if (!workspaceId || workspaceId === '*') { for (const loadedId of loadedSessionWorkspaceIdSet) { ... void loadWorkspaceSessions(entry, false) } }`.
- `src/renderer/src/components/Sidebar.tsx:1163` — `await window.electron.canvas.listSessions(workspaceEntry.id, forceRefresh)`.

**Recommendation.** Make the indexer emit the affected workspace path(s) instead of `'*'` (it already computes per-row `project_path`), so only impacted workspaces refetch. Alternatively, debounce/coalesce the wildcard handler in the Sidebar and diff incoming rows against current state before calling `setSessions` to avoid array-identity churn.

---

### perf-06 — Sidebar session list is progressively paginated, not virtualized — mounted rows grow unbounded

**Severity:** Medium · **Effort:** M (Medium)
**Category:** unvirtualized long list (judgment)
**Files:** `src/renderer/src/components/Sidebar.tsx`

**Problem.** The session list uses `slice(0, visibleSessionCount)` / `slice(0, projectSessionVisibleCount)` ("show more" pagination) rather than windowed virtualization. There is no react-window/react-virtual/IntersectionObserver — grep confirms none. Every row that has been revealed stays mounted, and any `setSessions` (including the wildcard refetch of perf-05) re-renders all currently-mounted rows. For users with 50+ sessions (1000+ possible) who have paged in, this is a large reconciliation on every session change, and each row pulls `useTheme()` (Sidebar uses it 54x).

**Evidence.**
- `src/renderer/src/components/Sidebar.tsx:1425` — `return normalVisibleSessions.slice(0, visibleSessionCount)`.
- `src/renderer/src/components/Sidebar.tsx:2271` — `group.sessions.slice(0, projectSessionVisibleCount)`.
- grep for react-window/react-virtual/virtualize/overscan/IntersectionObserver in `Sidebar.tsx` returns no matches.
- `renderSessionRow` is mapped at `2089`/`2440`/`2518`.

**Recommendation.** Virtualize the session list (react-window / `@tanstack/react-virtual`) so only visible rows mount, and/or memoize the row component so unchanged rows skip re-render when `setSessions` replaces the array. Pair with perf-05 so a single change doesn't re-render the whole list.

---

### perf-07 — Streaming chat re-parses the entire growing message through Streamdown ~20x/sec

**Severity:** Medium · **Effort:** M (Medium)
**Category:** streaming / markdown parse overhead per token (judgment)
**Files:** `src/renderer/src/components/ChatTile.tsx`, `src/renderer/src/components/shared/streamdown-utils.tsx`, `src/renderer/src/components/chat/largeContent.ts`

**Problem.** Text chunks are batched and flushed every 50ms (good), but each flush appends to the last content block and the streaming message re-renders `<ChatMarkdown text={...} isStreaming>` with the FULL accumulated message text. Streamdown re-parses the whole growing markdown string ~20 times/sec for the duration of the response, so cost grows with message length (O(n) parse per flush → O(n²) total over a long answer). Additionally, every `ChatMarkdown` render runs `usePatchCodeBlocks`, which `querySelectorAll`s all code-blocks/tables/pre/code/spans and rewrites their `cssText` imperatively — a full DOM walk per flush while streaming. `ChatMessageContent` is memoized (`ChatTile.tsx:1565`) but its `text` prop changes every flush, so memo doesn't help the streaming message. (Marked judgment because Streamdown's internal incremental-parse behavior isn't visible from this repo.)

**Evidence.**
- `src/renderer/src/components/chat/largeContent.ts:7` — `CHAT_STREAM_FLUSH_INTERVAL_MS = 50`.
- `src/renderer/src/components/ChatTile.tsx:2306` — `setTimeout(..., CHAT_STREAM_FLUSH_INTERVAL_MS)` → `flushPendingStreamText` appends and `setMessagesSafe`.
- `src/renderer/src/components/shared/streamdown-utils.tsx:662` — `{text}` passed whole to `<Streamdown>`.
- `src/renderer/src/components/shared/streamdown-utils.tsx:402` — `usePatchCodeBlocks` runs on deps including `tokens`/`theme` and re-queries the subtree each render.
- `src/renderer/src/components/ChatTile.tsx:1583` — memo child still receives changing `text`.

**Recommendation.** For the in-flight streaming bubble, render only the trailing un-rendered tail as plain text (or throttle full re-parse to e.g. 150-200ms / on sentence boundaries) and switch to full Streamdown parse once `isStreaming` flips false. Gate `usePatchCodeBlocks` to run only when code-block/table nodes actually exist (fast `el.querySelector('[data-streamdown="code-block"]')` check) to skip the DOM walk on prose-only messages.

---

### perf-03 — Wheel listener re-registered on every viewport change (non-passive add/remove churn)

**Severity:** Low · **Effort:** S (Small)
**Category:** canvas-hot-path / react-rerender
**Files:** `src/renderer/src/App.tsx`

**Problem.** The wheel-zoom effect depends on `[viewport]`, so on every viewport change (i.e. continuously during pan and pinch-zoom) it tears down and re-adds a non-passive `wheel` event listener (`removeEventListener` + `addEventListener`). The handler closes over `viewport` to read `tx`/`ty`/`zoom`, which is why it's in the dep array — but reading from a `viewportRef` instead would let the listener register once.

**Evidence.**
- `src/renderer/src/App.tsx:2989` — `el.addEventListener('wheel', onWheel, { passive: false })`.
- `src/renderer/src/App.tsx:2990` — cleanup removes it.
- `src/renderer/src/App.tsx:2991` — dep array `[viewport]`.
- `viewportRef` already exists (`App.tsx:1354`/`1362`) and is kept in sync, so the closure dependency is avoidable.

**Recommendation.** Read viewport from `viewportRef.current` inside `onWheel` and change the effect deps to `[]` (register once). Removes per-frame listener churn on a non-passive handler.

---

### perf-08 — `listThreadsFromDb(null)` does `SELECT *` with no `LIMIT` — unbounded IPC payload

**Severity:** Low · **Effort:** S (Small)
**Category:** db query / large payload
**Files:** `src/main/db/thread-indexer.ts`, `src/main/ipc/canvas.ts`

**Problem.** `listThreadsFromDb(null)` runs `SELECT * FROM thread_index WHERE deleted_at IS NULL ORDER BY source_updated_ms DESC` with no `LIMIT` and maps every row (including title/preview text) into `AggregatedSessionEntry` objects returned over IPC. As the thread index accumulates (it tombstones but never deletes rows, and external sessions can number in the thousands), the global listing serializes the entire live table across the process boundary on each call.

**Evidence.**
- `src/main/db/thread-indexer.ts:113-117` — query has no `LIMIT`.
- `src/main/db/thread-indexer.ts:118` — `rows.map(rowToEntry)` builds full objects incl. `preview` and `title`.
- Consumed via `src/main/ipc/canvas.ts:582` — `listThreadsFromDb(normalizedPath)`. The workspace-scoped branch (`122-131`) is also unbounded but naturally narrower.

**Recommendation.** Add a `LIMIT` (e.g. 500, matching the per-provider listing caps) + offset to `listThreadsFromDb`, or stream/paginate the global session list. The supporting index `idx_ti_updated` already orders this cheaply, so a `LIMIT` is a pure win.

---

### perf-09 — Minimap redraws the whole canvas (`Math.min/max` spread over all tiles) every pan frame when shown

**Severity:** Low · **Effort:** S (Small)
**Category:** canvas-hot-path / react-rerender
**Files:** `src/renderer/src/components/Minimap.tsx`, `src/renderer/src/App.tsx`

**Problem.** When the minimap is enabled, its draw effect lists `viewport` in deps (`src/renderer/src/components/Minimap.tsx:100`), so it re-runs on every pan/zoom frame: it recomputes bounds via four `Math.min/Math.max(...tiles.map(...))` spreads (allocating 4 arrays over all tiles), reads `getComputedStyle(document.documentElement)` (forces style resolution), and redraws every tile rect to the 2D canvas. This is bounded work but happens at frame rate during pan and compounds perf-01. For very large tile counts the spread-args pattern also risks call-stack limits.

**Evidence.**
- `src/renderer/src/components/Minimap.tsx:100` — `}, [tiles, viewport, canvasSize, getBounds, theme.text.primary])`.
- `src/renderer/src/components/Minimap.tsx:42-45` — `Math.min(...tiles.map(t => t.x))` etc.
- `src/renderer/src/components/Minimap.tsx:93` — `getComputedStyle(document.documentElement)` inside the draw.
- `src/renderer/src/App.tsx:7192` — `{showMinimap && (` gating.

**Recommendation.** Only redraw the viewport rectangle (not all tile rects + bounds) on viewport-only changes; recompute bounds + tile rects only when `tiles` changes. Cache the resolved `--cs-th-text-primary` outside the per-frame path. Replace spread `Math.min/max` with a single reduce loop.

---

## Quick wins

- **perf-03 (S):** Read `viewportRef.current` inside `onWheel` and set effect deps to `[]` — stops per-frame non-passive listener churn.
- **perf-08 (S):** Add `LIMIT 500` to `listThreadsFromDb(null)` — pure win, the `idx_ti_updated` index already orders it.
- **perf-02 (S):** Either wire pan/zoom through the existing `scheduleViewportUpdate` rAF batcher or delete the dead helper + refs.
- **perf-09 (S):** Cache the resolved theme color outside the draw, redraw only the viewport rect on viewport-only changes, and replace spread `Math.min/max` with a reduce.
- **perf-01 (L, highest leverage):** The single biggest win — a memoized `<CanvasTile>` (compared on everything except `tx`/`ty`) + `React.memo(TileChrome)` makes pan O(1) in React work. Larger effort, but it is the headline fix.
