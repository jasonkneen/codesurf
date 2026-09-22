import type { DockZone } from '../components/panelLayoutTree'

export type DockRect = {
  left: number
  top: number
  width: number
  height: number
}

export const DEFAULT_DOCK_EDGE_RATIO = 0.25
export const DEFAULT_DOCK_MIN_EDGE_PX = 24
export const DEFAULT_DOCK_MAX_EDGE_RATIO = 0.4

/**
 * Map a pointer in viewport coordinates onto a panel rect.
 * Edges stay hittable when the canvas is zoomed out: at least `minEdgePx`
 * (clamped so a center zone still exists).
 */
export function dockZoneFromRect(
  rect: DockRect,
  x: number,
  y: number,
  options?: { edgeRatio?: number, minEdgePx?: number, maxEdgeRatio?: number },
): DockZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const edgeRatio = options?.edgeRatio ?? DEFAULT_DOCK_EDGE_RATIO
  const minEdgePx = options?.minEdgePx ?? DEFAULT_DOCK_MIN_EDGE_PX
  const maxEdgeRatio = options?.maxEdgeRatio ?? DEFAULT_DOCK_MAX_EDGE_RATIO
  const maxEdgeX = rect.width * maxEdgeRatio
  const maxEdgeY = rect.height * maxEdgeRatio
  const edgeX = Math.min(maxEdgeX, Math.max(rect.width * edgeRatio, Math.min(minEdgePx, maxEdgeX)))
  const edgeY = Math.min(maxEdgeY, Math.max(rect.height * edgeRatio, Math.min(minEdgePx, maxEdgeY)))
  const rx = x - rect.left
  const ry = y - rect.top
  if (rx < edgeX) return 'left'
  if (rx > rect.width - edgeX) return 'right'
  if (ry < edgeY) return 'top'
  if (ry > rect.height - edgeY) return 'bottom'
  return 'center'
}

/** Prefer the smallest (innermost) rect that contains the point. */
export function pickInnermostRect<T>(
  items: readonly { id: T, rect: DockRect }[],
  x: number,
  y: number,
): T | null {
  let best: { id: T, area: number } | null = null
  for (const item of items) {
    const { rect } = item
    if (rect.width <= 0 || rect.height <= 0) continue
    if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) {
      continue
    }
    const area = rect.width * rect.height
    if (!best || area < best.area) best = { id: item.id, area }
  }
  return best?.id ?? null
}

export function panelRectsFromRoot(root: ParentNode | null): { id: string, rect: DockRect }[] {
  if (!root || typeof (root as Element).querySelectorAll !== 'function') return []
  return Array.from(root.querySelectorAll<HTMLElement>('[data-codesurf-panel-id]'))
    .flatMap(el => {
      const id = el.dataset.codesurfPanelId
      if (!id) return []
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return []
      return [{ id, rect: { left: r.left, top: r.top, width: r.width, height: r.height } }]
    })
}

export function panelAtPoint(
  root: ParentNode | null,
  x: number,
  y: number,
): string | null {
  return pickInnermostRect(panelRectsFromRoot(root), x, y)
}

export function zoneAtPoint(
  root: ParentNode | null,
  x: number,
  y: number,
  panelId: string,
  options?: { minEdgePx?: number },
): DockZone {
  const match = panelRectsFromRoot(root).find(item => item.id === panelId)
  if (!match) return 'center'
  return dockZoneFromRect(match.rect, x, y, { minEdgePx: options?.minEdgePx })
}

export type TabDropKind = 'dock' | 'eject' | 'ignore'

/** Tab drop that misses every panel in this layout leaves the layout. */
export function resolveTabDrop(
  targetPanelId: string | null,
  canEject: boolean,
): TabDropKind {
  if (targetPanelId) return 'dock'
  return canEject ? 'eject' : 'ignore'
}
