# Canvas performance feature flags

All canvas render optimisations are **on by default** and individually
disable-able at runtime via env vars — no rebuild needed, restart the app after
changing one. Falsy values: `0`, `false`, `off`, `no` (case-insensitive);
anything else, including unset, means ON.

| Env var | Flag | What it does |
|---|---|---|
| `CODESURF_PERF_ALL=0` | master switch | Disables every optimisation below |
| `CODESURF_PERF_IMPERATIVE_PAN=0` | `imperativePan` | Pan / wheel-zoom / inertia write the world `transform` directly to the DOM each pointer event and commit React state only every ~150ms + at gesture end. Off: every pointer event is a React render. |
| `CODESURF_PERF_DRAG_RAF=0` | `dragRafCoalesce` | Resize, group-move, group-resize, connection and marquee drags coalesce to at most one state update per animation frame (tile drag already did this). Off: one update per raw mousemove. |
| `CODESURF_PERF_CULLING=0` | `viewportCulling` | Tile bodies fully outside the viewport (+600px margin) stop painting (`visibility: hidden`; DOM stays mounted, terminals/webviews keep state). |
| `CODESURF_PERF_ZOOM_LOD=0` | `zoomLod` | Below zoom 0.3, heavy tile bodies (terminal, code, browser, chat, kanban, files, customisation, `ext:*`) hide behind a lightweight title card. Notes/images/media keep their real bodies. |

Examples:

```bash
# run dev with everything on (default)
npm run dev

# bisect a suspected culling regression
CODESURF_PERF_CULLING=0 npm run dev

# old behaviour, everything off
CODESURF_PERF_ALL=0 npm run dev
```

Implementation map:

- Flag parsing: `src/renderer/src/perfFlags.ts` (`parsePerfFlags`, unit-tested in `test/perf-flags.test.ts`); env crosses the bridge via `window.electron.perf.getEnv()` (preload).
- Imperative gestures: `useCanvasEngine.ts` (`applyViewportGesture` / `endViewportGesture` / `worldElRef`), consumed by the pan branch and wheel handler; inertia included.
- Drag coalescing: `useCanvasDragSync.ts` (`scheduleDragUpdate` / `flushPendingDragUpdate`).
- Culling/LOD geometry: `src/renderer/src/lib/canvasCulling.ts` (unit-tested in `test/canvas-culling.test.ts`), applied in `AppCanvasTiles.tsx` → `CanvasTileItem.tsx`.

Notes for future work:

- Culling uses the **canvas surface client rect** (via `canvasRef`), not the
  full window — sidebar/panel chrome is excluded.
- Culling refreshes on viewport **commits** (throttled during gestures) — the
  600px margin exists so tiles entering the screen mid-gesture are already
  painting. If the margin ever feels wrong, tune `CULL_MARGIN_PX`, don't add
  per-frame recomputes.
- Offscreen browser/extension webviews throttle paint via
  `setManagedWebviewPaintActive` → `webContents.setFrameRate(1)` when culled;
  restore to 60 when visible (`src/renderer/src/lib/webviewPaint.ts`).
- Next tier (not built): snapshot LOD via `webContents.capturePage` for the
  sub-0.3 zoom card.
