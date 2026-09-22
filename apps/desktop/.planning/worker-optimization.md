# Web Worker Optimization Plan

> Move CPU-bound, main-thread-blocking computations into Web Workers so canvas pan/drag/zoom and chat streaming stop competing for the same renderer thread.

---

## Current state — what runs on the renderer's main thread

| Concern | Where | Cost characteristic |
|---|---|---|
| Discovery graph (proximity-based tile linking) | `App.tsx:562–671` (3 functions) + `src/shared/connectionGraph.ts` (cascade core) | **O(n²)** outer loop × per-pair anchor-pair search. ~50 tiles ≈ 40k ops/recompute. Recomputes on every tile move, group change, settings change. Drag = many recomputes per second. |
| Streamdown markdown parsing | `streamdown-utils.tsx` (667 LOC) called from `ChatTile.tsx` | Re-parses on every streamed chunk. Hot during long responses. Tightly coupled to React (returns JSX). |
| Diff parsing | `chat/DiffView.tsx:37` `parseDiff` | O(n) line-by-line. Already gated by `maxLines: 300`. **Likely not a real hot path.** |
| Canvas state load | `persistCanvasStateRef` callers | Synchronous JSON parse of arbitrarily large saved layouts. Rare (workspace switch). |

**No custom workers exist today.** Only Monaco's built-in language workers (`monaco.ts`).

---

## Why workers (vs alternatives)

We already have **UI isolation** — iframes for extensions/chat surfaces, `<webview>` (separate process) for browsers, child processes for terminals. What we don't have is **computation isolation**: a single tile doing CPU-bound JS work today freezes every other tile's React commit phase.

Workers solve exactly that: a `requestIdleCallback` won't help if no idle ever arrives because the discovery graph is recomputing during a drag. A worker just doesn't share the main-thread budget.

What workers can't do: render React, touch DOM, run xterm/Monaco/streamdown UI. So we move *the data work*, not the panels.

---

## Architecture

```
┌─────────────────────── Renderer (main thread) ──────────────────────┐
│                                                                     │
│  React tree (App.tsx, all tiles) — UNCHANGED                        │
│           │                                                         │
│           │ useDiscoveryWorker(tiles, settings, ...)                │
│           ▼                                                         │
│  hooks/useWorker.ts ── postMessage ──► Worker                       │
│           ▲                              │                          │
│           │                              ▼                          │
│           └────── result ──── postMessage ────                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Message protocol (per worker):**
```ts
{ type: 'compute', requestId: string, payload: <input> }   // → worker
{ type: 'result',  requestId: string, payload: <output> }  // ← worker
{ type: 'error',   requestId: string, message: string }    // ← worker
```

**Cancellation strategy:** debounce + last-write-wins via `requestId`. The hook tracks the last requestId it issued; results with stale requestIds are dropped. No in-flight cancel — worker just keeps computing but its result is ignored. Cheap and correct.

**Bundling:** Vite + electron-vite supports `import Worker from './foo.worker?worker'` natively. No config changes needed unless we hit Electron's `file://` protocol limitations (worker URL must be reachable). Verify in Phase 0.

---

## Phase 0 — Infrastructure (1–2 hours)

Goal: a generic `useWorker` hook + the Vite worker scaffold, validated end-to-end with a trivial echo worker.

**Deliverables:**
1. `src/renderer/src/workers/echo.worker.ts` — a 10-line echo worker proving the toolchain works under Electron's renderer `file://` loader.
2. `src/renderer/src/hooks/useWorker.ts` — generic hook: `useWorker<TIn, TOut>(workerFactory, input, deps)`. Returns `{ result: TOut | null, isComputing: boolean }`. Implements last-write-wins via requestId + tracks pending state. Disposes worker on unmount.
3. `electron.vite.config.ts` — verify no special config needed. Add `worker: { format: 'es' }` only if bundler defaults break.
4. Smoke test: drop `<EchoTest>` into App.tsx, send "hello", assert "hello" round-trips.

**Risk:** Electron 40 + Vite 7 worker bundling under `file://` — needs verification. If broken, fallback is `Worker(URL.createObjectURL(blob))` pattern.

---

## Phase 1 — Discovery graph worker (HIGH impact, MEDIUM effort)

Goal: move `findDiscoveryConnections`, `cascadeDiscoveryConnections`, `addAssociatedDiscoveryConnections` off main thread.

**Why this first:** highest impact (every drag triggers it) + the cascade core is already in `src/shared/connectionGraph.ts` (a pure module).

### What needs to move
1. **`findDiscoveryConnections(tileList, hiddenTileIds, gridStep, maxDistance)`** — pure inputs, pure output. Direct port.
2. **`cascadeDiscoveryConnections(graph, tileList, gridStep)`** — currently builds capability/route resolvers as closures over local maps. Need to inline the closure bodies into the worker (or refactor `connectionGraph.ts` to take data instead of resolvers).
3. **`addAssociatedDiscoveryConnections(graph, tileList, associatedTileGroups, gridStep)`** — same closure-flattening problem.

### Refactor required in `src/shared/connectionGraph.ts`
The `cascadeConnectionGraph` and `addAssociatedConnectionGroups` exports take resolver callbacks today. Two ways to make them worker-friendly:

- **Option A (preferred):** add a parallel data-driven API. Existing callbacks stay for any non-worker callsite. New `cascadeConnectionGraphData(graph, tileList, capabilitiesMap, refsMap, gridStep)` does the same work but with serializable inputs. Worker uses the data API; old callers stay on the closure API.
- **Option B:** rip out the resolver pattern entirely. More invasive, breaks any other callers.

We pick A. ~30 minutes of refactor, zero risk to non-worker callers.

### Worker file: `src/renderer/src/workers/discovery-graph.worker.ts`
```ts
import {
  findDiscoveryConnections,           // copied/imported from App.tsx
  cascadeDiscoveryConnectionsData,
  addAssociatedDiscoveryConnectionsData,
} from './discovery-graph-impl'

self.onmessage = (e) => {
  const { requestId, payload } = e.data
  const { tiles, hiddenIds, gridStep, maxDistance, suppressed, lockedConnections, associatedGroups } = payload
  // Replicate the orchestration currently in App.tsx negotiatedDiscoveryState (line 4019)
  const graph = findDiscoveryConnections(tiles, new Set(hiddenIds), gridStep, maxDistance)
  // ... apply suppressed, locked, associated, cascade
  self.postMessage({ requestId, payload: { connectedTileIds: [...result.connectedTileIds], byTile: [...result.byTile.entries()], ambientRoutes: [...routes.values()] } })
}
```

### Hook: `src/renderer/src/hooks/useDiscoveryGraph.ts`
Wraps the generic `useWorker`. Memoizes inputs to avoid postMessage on every render. Returns the same shape `negotiatedDiscoveryState` returns today.

### Wire-up in App.tsx
Replace lines `4019–4047` (the `useMemo` for `negotiatedDiscoveryState`) with `const negotiatedDiscoveryState = useDiscoveryGraph(tiles, panelLayout, groups, settings, lockedConnections, suppressedConnections)`.

### Fallback
If worker init fails (e.g., bundling issue, browser extension blocking workers, Electron sandbox edge case), fall back to inline computation. The hook detects worker-unavailable and runs the same code synchronously. Functional parity preserved.

### Crossover threshold
Workers add ~0.5ms postMessage overhead per round-trip. For tiny graphs (n < 10 tiles), main-thread is faster. Worth skipping the worker below a threshold:
```ts
if (tiles.length < 10) return computeInline(...)
return computeViaWorker(...)
```

### Validation
- Drag a tile in a 50-tile canvas. Frame rate before/after.
- Toggle `autoConnectionsEnabled`. Verify no result regression.
- Add/remove locked connections. Verify they appear/disappear correctly.
- Performance probe: log `performance.now()` deltas around the dispatch in the hook.

---

## Phase 2 — Streamdown markdown (DEFERRED — research spike first)

Streamdown returns JSX, not data. Putting it in a worker requires either:
- Returning a serialized HAST tree from the worker, then converting HAST→JSX on main (defeats most of the savings), OR
- Splitting parsing (HAST production) from rendering (HAST→JSX), running parsing in worker. Streamdown may not expose the seam.

**Spike task:** read Streamdown's source, identify whether `parser → HAST` and `HAST → JSX` are separable. If yes, ~half-day port. If no, defer indefinitely; the iframe isolation already in place for chat surfaces probably makes this less urgent.

Don't tackle in Phase 1 — research it after Phase 1 ships.

---

## Phase 3 — Diff parse (LOW priority)

`parseDiff` is O(n), already gated by `maxLines: 300`, runs only when reviewing diffs. Profiling needed first. Likely **not worth a worker.** Listed only for completeness.

---

## Open questions for the user

These shape the implementation; flagging them here so we don't decide silently.

### Q1: Worker fallback policy
If the worker fails to initialize, the canvas should:
- **(A)** silently fall back to main-thread computation (current plan)
- **(B)** show a one-time toast warning the user that performance may degrade
- **(C)** disable auto-connections entirely until restarted

### Q2: Cancellation aggressiveness
During a fast drag, the user may emit ~60 input events/second. Three strategies:
- **(A)** `requestAnimationFrame`-throttled — at most 60 dispatches/sec
- **(B)** Trailing debounce — dispatch on idle (50ms after last move)
- **(C)** No throttle, last-write-wins on receive (current plan)

(A) is simplest, (B) is gentlest on CPU, (C) is most responsive but wasteful. Pick one.

### Q3: Crossover threshold
At what tile count should we switch from inline to worker? My guess is `n < 10 → inline`, but the right answer depends on hardware. Could be a setting or a measured probe.

---

## File checklist

**New files:**
- `src/renderer/src/workers/echo.worker.ts` (Phase 0 smoke test, can delete after)
- `src/renderer/src/workers/discovery-graph.worker.ts`
- `src/renderer/src/workers/discovery-graph-impl.ts` (pure logic shared between worker and main fallback)
- `src/renderer/src/hooks/useWorker.ts`
- `src/renderer/src/hooks/useDiscoveryGraph.ts`

**Modified files:**
- `src/shared/connectionGraph.ts` — add data-driven parallel API (Option A above)
- `src/renderer/src/App.tsx` — replace `negotiatedDiscoveryState` useMemo with hook call. Move the three `find*Discovery*` functions into `discovery-graph-impl.ts` and import them in App.tsx for the inline-fallback path.
- `electron.vite.config.ts` — *only if* worker bundling needs explicit format

---

## Success criteria

- Drag a tile in a 50-tile canvas: frame rate ≥ 55fps (was unmeasured, but main-thread-blocked recomputes degrade it)
- No functional regression: connections appear/disappear identically
- No crash on cold start when worker is initializing (pre-init dispatches buffer or fall through to inline)
- Clean teardown on workspace switch — no leaked workers
