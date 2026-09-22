export interface PanelLeaf {
  type: 'leaf'
  id: string
  tabs: string[]
  activeTab: string
  previewTabId?: string | null
}

export interface PanelSplit {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: PanelNode[]
  sizes: number[]
}

export type PanelNode = PanelLeaf | PanelSplit

export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

let panelCounter = 0
export const newPanelId = (): string => `panel-${Date.now()}-${panelCounter++}`

function normalizePreviewTabId(tabs: string[], previewTabId?: string | null): string | null {
  return previewTabId && tabs.includes(previewTabId) ? previewTabId : null
}

export function createLeaf(tileIds: string[], activeTab?: string, previewTabId?: string | null): PanelLeaf {
  return {
    type: 'leaf',
    id: newPanelId(),
    tabs: tileIds,
    activeTab: activeTab ?? tileIds[0] ?? '',
    previewTabId: normalizePreviewTabId(tileIds, previewTabId),
  }
}

export function findLeafByTileId(node: PanelNode, tileId: string): PanelLeaf | null {
  if (node.type === 'leaf') return node.tabs.includes(tileId) ? node : null
  for (const child of node.children) {
    const found = findLeafByTileId(child, tileId)
    if (found) return found
  }
  return null
}

export function findLeafById(node: PanelNode, panelId: string): PanelLeaf | null {
  if (node.type === 'leaf') return node.id === panelId ? node : null
  for (const child of node.children) {
    const found = findLeafById(child, panelId)
    if (found) return found
  }
  return null
}

export function getAllTileIds(node: PanelNode): string[] {
  if (node.type === 'leaf') return [...node.tabs]
  return node.children.flatMap(getAllTileIds)
}

export function removeTileFromTree(node: PanelNode, tileId: string): PanelNode | null {
  if (node.type === 'leaf') {
    const newTabs = node.tabs.filter(id => id !== tileId)
    if (newTabs.length === 0) return null
    return {
      ...node,
      tabs: newTabs,
      activeTab: node.activeTab === tileId ? newTabs[0] : node.activeTab,
      previewTabId: normalizePreviewTabId(newTabs, node.previewTabId),
    }
  }
  const newChildren: PanelNode[] = []
  const newSizes: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const result = removeTileFromTree(node.children[i], tileId)
    if (result) { newChildren.push(result); newSizes.push(node.sizes[i]) }
  }
  if (newChildren.length === 0) return null
  if (newChildren.length === 1) return newChildren[0]
  const total = newSizes.reduce((a, b) => a + b, 0)
  return { ...node, children: newChildren, sizes: newSizes.map(s => (s / total) * 100) }
}

export function addTabToLeaf(
  node: PanelNode,
  panelId: string,
  tileId: string,
  options?: { preview?: boolean },
): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== panelId) return node
    if (node.tabs.includes(tileId)) {
      return {
        ...node,
        activeTab: tileId,
        previewTabId: options?.preview === true
          ? tileId
          : options?.preview === false && node.previewTabId === tileId
            ? null
            : normalizePreviewTabId(node.tabs, node.previewTabId),
      }
    }
    const nextTabs = [...node.tabs, tileId]
    return {
      ...node,
      tabs: nextTabs,
      activeTab: tileId,
      previewTabId: options?.preview === true ? tileId : normalizePreviewTabId(nextTabs, node.previewTabId),
    }
  }
  return { ...node, children: node.children.map(c => addTabToLeaf(c, panelId, tileId, options)) }
}

export function setActiveTab(node: PanelNode, panelId: string, tileId: string): PanelNode {
  if (node.type === 'leaf') return node.id === panelId ? { ...node, activeTab: tileId } : node
  return { ...node, children: node.children.map(c => setActiveTab(c, panelId, tileId)) }
}

export function pinTabInLeaf(node: PanelNode, panelId: string, tileId: string): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== panelId || node.previewTabId !== tileId) return node
    return { ...node, previewTabId: null, activeTab: tileId }
  }
  return { ...node, children: node.children.map(c => pinTabInLeaf(c, panelId, tileId)) }
}

export function replaceTabInLeaf(
  node: PanelNode,
  panelId: string,
  currentTileId: string,
  nextTileId: string,
  options?: { preview?: boolean },
): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== panelId) return node
    const currentIndex = node.tabs.indexOf(currentTileId)
    if (currentIndex < 0) return node
    const replacedTabs = node.tabs.map(tabId => tabId === currentTileId ? nextTileId : tabId)
    const nextTabs = replacedTabs.filter((tabId, index) => replacedTabs.indexOf(tabId) === index)
    const nextPreviewTabId = node.previewTabId === currentTileId
      ? (options?.preview === false ? null : nextTileId)
      : normalizePreviewTabId(nextTabs, node.previewTabId)
    return {
      ...node,
      tabs: nextTabs,
      activeTab: node.activeTab === currentTileId ? nextTileId : node.activeTab,
      previewTabId: normalizePreviewTabId(nextTabs, nextPreviewTabId),
    }
  }
  return { ...node, children: node.children.map(c => replaceTabInLeaf(c, panelId, currentTileId, nextTileId, options)) }
}

export function closeOthersInLeaf(root: PanelNode, panelId: string, keepId: string): PanelNode {
  const update = (n: PanelNode): PanelNode => {
    if (n.type === 'leaf') {
      if (n.id !== panelId) return n
      return { ...n, tabs: [keepId], activeTab: keepId, previewTabId: n.previewTabId === keepId ? keepId : null }
    }
    return { ...n, children: n.children.map(update) }
  }
  return update(root)
}

export function closeToRightInLeaf(root: PanelNode, panelId: string, tileId: string): PanelNode {
  const update = (n: PanelNode): PanelNode => {
    if (n.type === 'leaf') {
      if (n.id !== panelId) return n
      const idx = n.tabs.indexOf(tileId)
      if (idx < 0) return n
      const newTabs = n.tabs.slice(0, idx + 1)
      return {
        ...n,
        tabs: newTabs,
        activeTab: newTabs.includes(n.activeTab) ? n.activeTab : tileId,
        previewTabId: normalizePreviewTabId(newTabs, n.previewTabId),
      }
    }
    return { ...n, children: n.children.map(update) }
  }
  return update(root)
}

export function findFirstLeafId(node: PanelNode): string | null {
  if (node.type === 'leaf') return node.id
  for (const child of node.children) {
    const found = findFirstLeafId(child)
    if (found) return found
  }
  return null
}

export function findLeafIdContainingTile(root: PanelNode, tileId: string): string | null {
  return findLeafByTileId(root, tileId)?.id ?? null
}

export function collectPanelLeaves(root: PanelNode): PanelLeaf[] {
  if (root.type === 'leaf') return [root]
  return root.children.flatMap(collectPanelLeaves)
}

export function replaceLeafInPanelTree(
  root: PanelNode,
  targetPanelId: string,
  replacement: PanelNode,
): PanelNode {
  if (root.type === 'leaf') {
    return root.id === targetPanelId ? replacement : root
  }
  return {
    ...root,
    children: root.children.map(child => replaceLeafInPanelTree(child, targetPanelId, replacement)),
  }
}

export function sanitizePanelLayout(
  root: PanelNode | null | undefined,
  tileIds: string[],
): { layout: PanelNode | null, fallbackActivePanelId: string | null } {
  if (!root) return { layout: null, fallbackActivePanelId: null }

  const validTileIds = new Set(tileIds)
  let next: PanelNode | null = root

  for (const tileId of getAllTileIds(root)) {
    if (!validTileIds.has(tileId)) {
      next = next ? (removeTileFromTree(next, tileId) ?? createLeaf([])) : createLeaf([])
    }
  }

  return {
    layout: next,
    fallbackActivePanelId: next ? findFirstLeafId(next) : null,
  }
}

export function splitLeaf(node: PanelNode, targetPanelId: string, tileId: string, zone: DockZone): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== targetPanelId) return node
    if (zone === 'center') return addTabToLeaf(node, targetPanelId, tileId)
    const existingTabs = node.tabs.filter(id => id !== tileId)
    // A solo tab cannot split against an empty remainder — that used to
    // duplicate the same tile into both sides of a new split.
    if (existingTabs.length === 0) return node
    const existingLeaf: PanelLeaf = {
      ...node,
      tabs: existingTabs,
      activeTab: existingTabs.includes(node.activeTab) ? node.activeTab : existingTabs[0],
      previewTabId: normalizePreviewTabId(existingTabs, node.previewTabId),
    }
    const newLeaf = createLeaf([tileId])
    const direction: 'horizontal' | 'vertical' = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
    const children: PanelNode[] = zone === 'left' || zone === 'top' ? [newLeaf, existingLeaf] : [existingLeaf, newLeaf]
    return { type: 'split', id: newPanelId(), direction, children, sizes: [50, 50] }
  }
  return { ...node, children: node.children.map(c => splitLeaf(c, targetPanelId, tileId, zone)) }
}

/**
 * Move `tileId` onto `targetPanelId` at `zone`. No-ops when the target is
 * missing (e.g. a panel id from a different layout instance) so a canvas
 * tab drag cannot drop the tile out of its tree.
 */
export function dockTileInTree(
  root: PanelNode,
  tileId: string,
  fromPanelId: string,
  targetPanelId: string,
  zone: DockZone,
): PanelNode {
  if (!findLeafById(root, targetPanelId)) return root
  if (fromPanelId === targetPanelId && zone === 'center') return root
  if (fromPanelId === targetPanelId) return splitLeaf(root, targetPanelId, tileId, zone)
  const stripped = removeTileFromTree(root, tileId)
  if (!stripped) return root
  if (!findLeafById(stripped, targetPanelId)) return root
  return splitLeaf(stripped, targetPanelId, tileId, zone)
}
