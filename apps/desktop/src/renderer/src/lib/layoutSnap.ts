// ─── layoutSnap: pure helpers for "snap an arrangement → layout" (Point 10) ──
//
// These functions are deliberately PURE — no React, no window, no side effects —
// so they're trivially correct and unit-testable. They translate a set of
// free-floating tile rectangles on the canvas into the structured panel/layout
// trees the app already knows how to render:
//
//   • PanelNode          (instance tree — carries tile IDs)         → live fullscreen / layout-group
//   • LayoutTemplateNode (preset tree — carries tile TYPES)         → reusable saved layout preset
//
// Nothing here mutates input arrays. Import paths are validated against sibling
// files in this directory (builtinViews.ts / commandRegistry.ts).

import type { PanelNode } from '../components/panelLayoutTree'
import type { LayoutTemplateNode, TileState } from '../../../shared/types'

// A minimal positional rectangle. Structurally satisfied by TileState.
export interface TileRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

// Pixel slop for treating two coordinates as "the same edge", mirroring the
// Math.round() edge-matching used by handleLaunchTemplate's touchH/touchV
// adjacency test in App.tsx (≈ line 3119-3120).
const EDGE_EPS = 2

let snapPanelCounter = 0
const snapPanelId = (): string => `panel-snap-${Date.now()}-${snapPanelCounter++}`

/**
 * True when the panel tree has a spatial split (columns/rows), not only tabs.
 * Tab-only trees are still layout groups when they represent a fullscreen
 * arrangement; this helper is for callers that need the split/tab distinction.
 */
export function panelTreeHasSplit(node: PanelNode): boolean {
  if (node.type === 'leaf') return false
  return true
}

// ─── Guillotine slicing: rects → spatial PanelNode ───────────────────────────
//
// Recursively find a single clean cut line (vertical or horizontal) that
// partitions every rect cleanly to one side, with ≥1 rect on each side. If a
// vertical cut works, the children sit side-by-side → direction 'horizontal'
// (matches splitLeaf: left/right ⇒ 'horizontal'). If a horizontal cut works,
// children stack → direction 'vertical'. If no clean cut exists (pinwheel /
// overlap / single rect), we cannot express it as nested splits and return the
// group as a flat tabs leaf for that sub-region — the caller decides whether to
// fall back entirely to flat tabs.

function rectsCenterX(r: TileRect): number {
  return r.x + r.width / 2
}
function rectsCenterY(r: TileRect): number {
  return r.y + r.height / 2
}

/** Try to split `rects` with a vertical line at world-x `cut`. Generic so it
 *  preserves the concrete rect type (TileRect or TileState) for callers. */
function partitionVertical<T extends TileRect>(rects: T[], cut: number): { left: T[]; right: T[] } | null {
  const left: T[] = []
  const right: T[] = []
  for (const r of rects) {
    const rEnd = r.x + r.width
    if (rEnd <= cut + EDGE_EPS) left.push(r)
    else if (r.x >= cut - EDGE_EPS) right.push(r)
    else return null // straddles the cut line — not a clean partition
  }
  if (left.length === 0 || right.length === 0) return null
  return { left, right }
}

/** Try to split `rects` with a horizontal line at world-y `cut`. */
function partitionHorizontal<T extends TileRect>(rects: T[], cut: number): { top: T[]; bottom: T[] } | null {
  const top: T[] = []
  const bottom: T[] = []
  for (const r of rects) {
    const rEnd = r.y + r.height
    if (rEnd <= cut + EDGE_EPS) top.push(r)
    else if (r.y >= cut - EDGE_EPS) bottom.push(r)
    else return null
  }
  if (top.length === 0 || bottom.length === 0) return null
  return { top, bottom }
}

/** Candidate cut positions = the right/bottom edges of each rect. */
function verticalCuts(rects: TileRect[]): number[] {
  return Array.from(new Set(rects.map(r => Math.round(r.x + r.width)))).sort((a, b) => a - b)
}
function horizontalCuts(rects: TileRect[]): number[] {
  return Array.from(new Set(rects.map(r => Math.round(r.y + r.height)))).sort((a, b) => a - b)
}

function span(rects: TileRect[], axis: 'x' | 'y'): number {
  if (axis === 'x') {
    const min = Math.min(...rects.map(r => r.x))
    const max = Math.max(...rects.map(r => r.x + r.width))
    return Math.max(1, max - min)
  }
  const min = Math.min(...rects.map(r => r.y))
  const max = Math.max(...rects.map(r => r.y + r.height))
  return Math.max(1, max - min)
}

function leafFromRects(rects: TileRect[]): PanelNode {
  // Order tabs left-to-right, top-to-bottom for a stable, predictable strip.
  const ordered = [...rects].sort((a, b) => rectsCenterY(a) - rectsCenterY(b) || rectsCenterX(a) - rectsCenterX(b))
  const tabs = ordered.map(r => r.id)
  return { type: 'leaf', id: snapPanelId(), tabs, activeTab: tabs[0] ?? '' }
}

function buildPanel(rects: TileRect[]): PanelNode {
  if (rects.length <= 1) return leafFromRects(rects)

  // Prefer a vertical cut (columns) first, then horizontal (rows).
  for (const cut of verticalCuts(rects)) {
    const part = partitionVertical(rects, cut)
    if (part) {
      const leftNode = buildPanel(part.left)
      const rightNode = buildPanel(part.right)
      const total = span(rects, 'x')
      const leftSize = (span(part.left, 'x') / total) * 100
      return {
        type: 'split',
        id: snapPanelId(),
        direction: 'horizontal',
        children: [leftNode, rightNode],
        sizes: [leftSize, 100 - leftSize],
      }
    }
  }
  for (const cut of horizontalCuts(rects)) {
    const part = partitionHorizontal(rects, cut)
    if (part) {
      const topNode = buildPanel(part.top)
      const bottomNode = buildPanel(part.bottom)
      const total = span(rects, 'y')
      const topSize = (span(part.top, 'y') / total) * 100
      return {
        type: 'split',
        id: snapPanelId(),
        direction: 'vertical',
        children: [topNode, bottomNode],
        sizes: [topSize, 100 - topSize],
      }
    }
  }

  // No clean guillotine cut (pinwheel / overlapping) → collapse to flat tabs.
  return leafFromRects(rects)
}

/**
 * Convert an array of tile rects into a spatial PanelNode (the instance tree).
 *
 * Returns a `split`-bearing tree when the rects form a sliceable grid/columns/
 * rows arrangement, a single `leaf` (flat tabs) when they don't (or there's
 * <2 rects). Callers wanting "only promote real arrangements" should check
 * `panelTreeHasSplit(result)`.
 *
 * Returns `null` only for an empty input.
 */
export function tilesToPanelNode(rects: TileRect[]): PanelNode | null {
  if (rects.length === 0) return null
  return buildPanel(rects)
}

// ─── Group members → reusable LayoutTemplateNode (preset, carries TYPES) ──────
//
// Distinct from tilesToPanelNode: a LayoutTemplateNode is a reusable preset that
// stores tile TYPES (slots[].tileType) rather than tile instance IDs, so it can
// seed a brand-new arrangement later via handleLaunchTemplate.

function buildTemplate(tiles: TileState[]): LayoutTemplateNode {
  const leaf = (ts: TileState[]): LayoutTemplateNode => {
    const ordered = [...ts].sort((a, b) => rectsCenterY(a) - rectsCenterY(b) || rectsCenterX(a) - rectsCenterX(b))
    return { type: 'leaf', slots: ordered.map(t => ({ tileType: t.type, label: t.label })) }
  }
  if (tiles.length <= 1) return leaf(tiles)

  for (const cut of verticalCuts(tiles)) {
    const part = partitionVertical(tiles, cut)
    if (part) {
      const total = span(tiles, 'x')
      const leftSize = (span(part.left, 'x') / total) * 100
      return {
        type: 'split',
        direction: 'horizontal',
        children: [buildTemplate(part.left), buildTemplate(part.right)],
        sizes: [leftSize, 100 - leftSize],
      }
    }
  }
  for (const cut of horizontalCuts(tiles)) {
    const part = partitionHorizontal(tiles, cut)
    if (part) {
      const total = span(tiles, 'y')
      const topSize = (span(part.top, 'y') / total) * 100
      return {
        type: 'split',
        direction: 'vertical',
        children: [buildTemplate(part.top), buildTemplate(part.bottom)],
        sizes: [topSize, 100 - topSize],
      }
    }
  }
  return leaf(tiles)
}

/**
 * Convert a group's member tiles into a reusable LayoutTemplateNode preset.
 * Needs full TileState[] (to read `.type` for slots). Returns `null` for empty.
 */
export function groupTilesToLayoutTemplate(tiles: TileState[]): LayoutTemplateNode | null {
  if (tiles.length === 0) return null
  return buildTemplate(tiles)
}
