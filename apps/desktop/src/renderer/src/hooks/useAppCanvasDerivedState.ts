/**
 * React wrapper around pure canvas visibility helpers.
 */

import { useEffect, useMemo, type MutableRefObject } from 'react'
import type { GroupState, TileState } from '../../../shared/types'
import type { PanelNode } from '../components/panelLayoutTree'
import { getAllTileIds } from '../components/panelLayoutTree'
import {
  computeExpandedCanvasMembership,
  computePanelTileIds,
  type ExpandedCanvasMembership,
} from '../lib/canvasVisibility'

export type { ExpandedCanvasMembership }
export { computeExpandedCanvasMembership, computePanelTileIds } from '../lib/canvasVisibility'

export function useAppCanvasDerivedState(options: {
  panelLayout: PanelNode | null
  groups: GroupState[]
  tiles: TileState[]
  expandedCanvasGroupId: string | null
  panelTileIdsRef: MutableRefObject<Set<string>>
}) {
  const { panelLayout, groups, tiles, expandedCanvasGroupId, panelTileIdsRef } = options

  const layoutTileIds = useMemo(
    () => (panelLayout ? getAllTileIds(panelLayout) : []),
    [panelLayout],
  )

  const panelTileIds = useMemo(
    () => computePanelTileIds(layoutTileIds, groups, tiles),
    [layoutTileIds, groups, tiles],
  )

  useEffect(() => {
    panelTileIdsRef.current = panelTileIds
  }, [panelTileIds, panelTileIdsRef])

  const tileByIdMap = useMemo(
    () => new Map(tiles.map(tile => [tile.id, tile])),
    [tiles],
  )

  const expandedCanvasMembership = useMemo(
    () => computeExpandedCanvasMembership(expandedCanvasGroupId, groups, tiles),
    [expandedCanvasGroupId, tiles, groups],
  )

  return {
    panelTileIds,
    tileByIdMap,
    expandedCanvasMembership,
  }
}
