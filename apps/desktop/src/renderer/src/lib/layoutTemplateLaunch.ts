import type { GroupState, LayoutTemplate, LayoutTemplateNode, LockedConnection, TileState } from '../../../shared/types.ts'
import { attachLayoutGroupToGenerated } from './layoutGroupMembership.ts'
import {
  findFirstLeafId,
  type PanelNode,
} from '../components/panelLayoutTree.ts'

export type GeneratedLayoutTemplate = {
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode
  activePanelId: string
  connections: LockedConnection[]
  nextZIndex: number
  expandLayoutGroupId: string
}

const DEFAULT_VIEWPORT_WIDTH = 1600
const DEFAULT_VIEWPORT_HEIGHT = 900

function generateTilesFromNode(
  node: LayoutTemplateNode,
  baseId: number,
  counters: { tile: number, panel: number, zIndex: number },
  x: number,
  y: number,
  w: number,
  h: number,
  out: TileState[],
): void {
  if (node.type === 'leaf') {
    for (const slot of node.slots) {
      out.push({
        id: `tile-template-${baseId}-${counters.tile++}`,
        type: slot.tileType,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(h),
        zIndex: counters.zIndex++,
        label: slot.label,
      })
    }
    return
  }

  const { direction, children, sizes } = node
  let offset = 0
  children.forEach((child, index) => {
    const pct = (sizes[index] ?? 50) / 100
    if (direction === 'horizontal') {
      generateTilesFromNode(child, baseId, counters, x + offset, y, w * pct, h, out)
      offset += w * pct
    } else {
      generateTilesFromNode(child, baseId, counters, x, y + offset, w, h * pct, out)
      offset += h * pct
    }
  })
}

function generatePanelFromNode(
  node: LayoutTemplateNode,
  baseId: number,
  counters: { panel: number },
  tileIndex: { v: number },
  generatedTiles: TileState[],
): PanelNode {
  if (node.type === 'leaf') {
    const tabs = node.slots
      .map(() => generatedTiles[tileIndex.v++]?.id)
      .filter((id): id is string => Boolean(id))
    return {
      type: 'leaf',
      id: `panel-template-${baseId}-${counters.panel++}`,
      tabs,
      activeTab: tabs[0] ?? '',
    }
  }

  return {
    type: 'split',
    id: `split-template-${baseId}-${counters.panel++}`,
    direction: node.direction,
    children: node.children.map(child => generatePanelFromNode(child, baseId, counters, tileIndex, generatedTiles)),
    sizes: node.sizes,
  }
}

function generateAdjacentConnections(tiles: TileState[]): LockedConnection[] {
  const connections: LockedConnection[] = []
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i]
      const b = tiles[j]
      const touchH = (Math.round(a.x + a.width) === b.x || Math.round(b.x + b.width) === a.x)
        && !(a.y + a.height <= b.y || b.y + b.height <= a.y)
      const touchV = (Math.round(a.y + a.height) === b.y || Math.round(b.y + b.height) === a.y)
        && !(a.x + a.width <= b.x || b.x + b.width <= a.x)
      if (touchH || touchV) {
        connections.push({ sourceTileId: a.id, targetTileId: b.id })
      }
    }
  }
  return connections
}

export function generateLayoutFromTemplate(
  template: LayoutTemplate,
  baseId = Date.now(),
): GeneratedLayoutTemplate | null {
  const counters = { tile: 0, panel: 0, zIndex: 1 }
  const generatedTiles: TileState[] = []
  generateTilesFromNode(
    template.tree,
    baseId,
    counters,
    0,
    0,
    DEFAULT_VIEWPORT_WIDTH,
    DEFAULT_VIEWPORT_HEIGHT,
    generatedTiles,
  )

  const generatedPanelLayout = generatePanelFromNode(
    template.tree,
    baseId,
    counters,
    { v: 0 },
    generatedTiles,
  )
  const generatedActivePanelId = findFirstLeafId(generatedPanelLayout)
  if (!generatedActivePanelId) return null

  const attached = attachLayoutGroupToGenerated({
    tiles: generatedTiles,
    panelLayout: generatedPanelLayout,
  })

  return {
    tiles: attached.tiles,
    groups: attached.groups,
    panelLayout: generatedPanelLayout,
    activePanelId: generatedActivePanelId,
    connections: generateAdjacentConnections(attached.tiles),
    nextZIndex: counters.zIndex,
    expandLayoutGroupId: attached.expandLayoutGroupId,
  }
}