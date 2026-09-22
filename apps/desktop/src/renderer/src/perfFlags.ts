// Canvas performance feature flags.
//
// Every optimisation is ON by default and individually disable-able via env
// vars so regressions can be bisected at runtime without a rebuild:
//
//   CODESURF_PERF_ALL=0              — master kill switch (disables all)
//   CODESURF_PERF_IMPERATIVE_PAN=0   — pan/wheel-zoom write the world transform
//                                      directly to the DOM during the gesture and
//                                      commit React state on a throttle + at end
//   CODESURF_PERF_DRAG_RAF=0         — resize / group-move / group-resize /
//                                      connection drags coalesce to one state
//                                      update per animation frame
//   CODESURF_PERF_CULLING=0          — tile bodies fully outside the viewport
//                                      (plus margin) stop painting
//   CODESURF_PERF_ZOOM_LOD=0         — below CANVAS_LOD_ZOOM heavy tile bodies
//                                      are hidden behind a lightweight card
//
// Falsy values: 0, false, off, no (case-insensitive). Anything else (including
// unset) leaves the flag ON. Env is read once at renderer startup via the
// preload bridge; changing a var requires an app restart.

export interface PerfFlags {
  imperativePan: boolean
  dragRafCoalesce: boolean
  viewportCulling: boolean
  zoomLod: boolean
}

const FALSY = new Set(['0', 'false', 'off', 'no'])

function flagOn(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key]
  if (raw === undefined) return true
  return !FALSY.has(raw.trim().toLowerCase())
}

export function parsePerfFlags(env: Record<string, string | undefined>): PerfFlags {
  if (!flagOn(env, 'CODESURF_PERF_ALL')) {
    return { imperativePan: false, dragRafCoalesce: false, viewportCulling: false, zoomLod: false }
  }
  return {
    imperativePan: flagOn(env, 'CODESURF_PERF_IMPERATIVE_PAN'),
    dragRafCoalesce: flagOn(env, 'CODESURF_PERF_DRAG_RAF'),
    viewportCulling: flagOn(env, 'CODESURF_PERF_CULLING'),
    zoomLod: flagOn(env, 'CODESURF_PERF_ZOOM_LOD'),
  }
}

/** Zoom threshold below which heavy tile bodies swap to LOD cards. */
export const CANVAS_LOD_ZOOM = 0.3

function readPerfEnv(): Record<string, string | undefined> {
  try {
    return window.electron?.perf?.getEnv() ?? {}
  } catch {
    return {}
  }
}

export const perfFlags: PerfFlags = parsePerfFlags(readPerfEnv())

// One-line startup breadcrumb so "which flags are live?" never needs a debugger.
try {
  const off = Object.entries(perfFlags).filter(([, v]) => !v).map(([k]) => k)
  if (off.length > 0) console.info('[perf] canvas optimisations disabled:', off.join(', '))
} catch { /* non-browser context (tests) */ }
