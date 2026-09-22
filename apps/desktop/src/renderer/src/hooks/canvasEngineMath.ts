/**
 * Pure canvas engine math / constants — no React hooks.
 * Extracted from useCanvasEngine for file size and unit-test isolation.
 */
import type { GroupState, TileState } from '../../../shared/types'

// ─── Canvas constants ───────────────────────────────────────────────────────

/** Screen-space snap padding for manual connection targets (divided by zoom at runtime). */
export const SNAP_THRESHOLD = 34

export const MIN_CANVAS_ZOOM = 0.25
export const MAX_CANVAS_ZOOM = 2
export const ZOOM_WHEEL_FACTOR_IN = 1.08
export const ZOOM_WHEEL_FACTOR_OUT = 0.92
export const CANVAS_SAVE_DEBOUNCE_MS = 500
export const HISTORY_MAX_ENTRIES = 50
export const FIT_VIEWPORT_PAD_PX = 48
export const FIT_VIEWPORT_MAX_ZOOM = 1.5
export const ARRANGE_FIT_PAD_PX = 60
export const ARRANGE_FIT_ZOOM_SCALE = 0.9

/** True when double-click should spawn a tile on empty canvas (BUG-13). */
export function shouldSpawnTileOnCanvasDoubleClick(target: { closest: (selector: string) => Element | null }): boolean {
  if (target.closest('[data-tile-chrome]')) return false
  if (target.closest('[data-canvas-group-frame]')) return false
  return true
}

export type CanvasViewport = { tx: number; ty: number; zoom: number }

export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { tx: 0, ty: 0, zoom: 1 }

export type PersistCanvasStateFn = (
  tileList: TileState[],
  vp: CanvasViewport,
  nz: number,
  grps?: GroupState[],
) => void

export type SaveCanvasFn = (
  tileList: TileState[],
  vp: CanvasViewport,
  nz: number,
  grps?: GroupState[],
  /** Pre-drag snapshot — pass when tilesRef already holds final positions (H-11 fix). */
  beforeTiles?: TileState[],
) => void

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function clampCanvasZoom(zoom: number): number {
  return Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, zoom))
}

export function connectionSnapPadding(zoom: number): number {
  return SNAP_THRESHOLD / Math.max(MIN_CANVAS_ZOOM, zoom)
}

export function zoomAtPoint(
  viewport: CanvasViewport,
  mx: number,
  my: number,
  newZoom: number,
): CanvasViewport {
  const clamped = clampCanvasZoom(newZoom)
  const wx = (mx - viewport.tx) / viewport.zoom
  const wy = (my - viewport.ty) / viewport.zoom
  return {
    tx: mx - wx * clamped,
    ty: my - wy * clamped,
    zoom: clamped,
  }
}

export function computeFitViewport(
  bounds: { x: number; y: number; w: number; h: number },
  screen: { w: number; h: number },
): CanvasViewport {
  const availW = Math.max(1, screen.w - FIT_VIEWPORT_PAD_PX * 2)
  const availH = Math.max(1, screen.h - FIT_VIEWPORT_PAD_PX * 2)
  const zoom = Math.min(FIT_VIEWPORT_MAX_ZOOM, availW / bounds.w, availH / bounds.h)
  const tx = (screen.w - bounds.w * zoom) / 2 - bounds.x * zoom
  const ty = (screen.h - bounds.h * zoom) / 2 - bounds.y * zoom
  return { tx, ty, zoom }
}

export function computeArrangeFitViewport(
  tiles: TileState[],
  screen: { w: number; h: number },
  sidebarOffset: number,
  getArrangeWidth: (tile: TileState) => number,
): CanvasViewport | null {
  if (tiles.length === 0) return null
  const availableWidth = screen.w - sidebarOffset
  const minX = Math.min(...tiles.map(t => t.x))
  const minY = Math.min(...tiles.map(t => t.y))
  const maxX = Math.max(...tiles.map(t => t.x + getArrangeWidth(t)))
  const maxY = Math.max(...tiles.map(t => t.y + t.height))
  const fitZoom = Math.min(
    availableWidth / (maxX - minX + ARRANGE_FIT_PAD_PX * 2),
    screen.h / (maxY - minY + ARRANGE_FIT_PAD_PX * 2),
    MAX_CANVAS_ZOOM,
  )
  const newZoom = fitZoom * ARRANGE_FIT_ZOOM_SCALE
  const centerX = sidebarOffset + availableWidth / 2
  const tx = centerX - ((minX + maxX) / 2) * newZoom
  const ty = screen.h / 2 - ((minY + maxY) / 2) * newZoom
  return { tx, ty, zoom: newZoom }
}

export function computePanToTileViewport(
  tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'>,
  screen: { w: number; h: number },
  currentZoom: number,
): Pick<CanvasViewport, 'tx' | 'ty'> {
  return {
    tx: screen.w / 2 - (tile.x + tile.width / 2) * currentZoom,
    ty: screen.h / 2 - (tile.y + tile.height / 2) * currentZoom,
  }
}

export function screenToWorldPoint(
  sx: number,
  sy: number,
  rect: DOMRect,
  viewport: CanvasViewport,
): { x: number; y: number } {
  return {
    x: (sx - rect.left - viewport.tx) / viewport.zoom,
    y: (sy - rect.top - viewport.ty) / viewport.zoom,
  }
}

export function worldToScreenPoint(
  point: { x: number; y: number },
  viewport: CanvasViewport,
): { x: number; y: number } {
  return {
    x: point.x * viewport.zoom + viewport.tx,
    y: point.y * viewport.zoom + viewport.ty,
  }
}

export function worldToScreenRect(
  tile: TileState,
  viewport: CanvasViewport,
): { left: number; top: number; width: number; height: number } {
  return {
    left: tile.x * viewport.zoom + viewport.tx,
    top: tile.y * viewport.zoom + viewport.ty,
    width: tile.width * viewport.zoom,
    height: tile.height * viewport.zoom,
  }
}
