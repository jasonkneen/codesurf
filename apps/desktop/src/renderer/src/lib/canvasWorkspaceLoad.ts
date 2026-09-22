import type { CanvasState } from '../../../shared/types'
import type { PanelNode } from '../components/panelLayoutTree.ts'
import {
  createLeaf,
  findLeafById,
  sanitizePanelLayout,
} from '../components/panelLayoutTree.ts'

export type CanvasWorkspaceLoadAppliers = {
  setTiles: (tiles: CanvasState['tiles']) => void
  setGroups: (groups: CanvasState['groups']) => void
  restoreViewport: (viewport: CanvasState['viewport']) => void
  setNextZIndex: (nextZIndex: number) => void
  setPanelLayout: (layout: PanelNode | null) => void
  setActivePanelId: (panelId: string | null) => void
  setExpandedTileId: (tileId: string | null) => void
  setExpandedCanvasGroupId: (groupId: string | null) => void
  setExpandLayoutGroupId?: (groupId: string | null) => void
  savedLayoutRef: { current: PanelNode | null }
  expandedCanvasGroupIdRef: { current: string | null }
  expandLayoutGroupIdRef?: { current: string | null }
  expandedCanvasPriorViewportRef: { current: CanvasState['viewport'] | null }
  // Always invoked with `saved.lockedConnections ?? []`, so the param is never
  // undefined — keep it non-nullable so a `Dispatch<SetStateAction<...>>` from
  // the caller is assignable (Dispatch can't accept `undefined`).
  setLockedConnections?: (connections: NonNullable<CanvasState['lockedConnections']>) => void
}

export function applySavedCanvasState(
  saved: CanvasState,
  appliers: CanvasWorkspaceLoadAppliers,
): void {
  const savedTiles = saved.tiles ?? []
  const sanitizedPanel = sanitizePanelLayout(
    (saved.panelLayout as PanelNode | null) ?? null,
    savedTiles.map(tile => tile.id),
  )
  const nextActivePanelId = saved.activePanelId
    && sanitizedPanel.layout
    && findLeafById(sanitizedPanel.layout, saved.activePanelId)
    ? saved.activePanelId
    : sanitizedPanel.fallbackActivePanelId

  appliers.setTiles(savedTiles)
  appliers.setGroups(saved.groups ?? [])
  appliers.setLockedConnections?.(saved.lockedConnections ?? [])
  appliers.restoreViewport(saved.viewport)
  appliers.setNextZIndex(saved.nextZIndex ?? 1)
  appliers.savedLayoutRef.current = sanitizedPanel.layout
  appliers.setPanelLayout(saved.tabViewActive ? (sanitizedPanel.layout ?? createLeaf([])) : null)
  appliers.setActivePanelId(saved.tabViewActive ? nextActivePanelId : null)
  appliers.setExpandedTileId(saved.expandedTileId ?? null)
  appliers.setExpandedCanvasGroupId(saved.expandedCanvasGroupId ?? null)
  appliers.expandedCanvasGroupIdRef.current = saved.expandedCanvasGroupId ?? null
  const expandId = saved.expandLayoutGroupId ?? null
  const expandExists = Boolean(expandId && (saved.groups ?? []).some(group => group.id === expandId))
  const nextExpandId = expandExists ? expandId : null
  appliers.setExpandLayoutGroupId?.(nextExpandId)
  if (appliers.expandLayoutGroupIdRef) appliers.expandLayoutGroupIdRef.current = nextExpandId
  appliers.expandedCanvasPriorViewportRef.current = saved.expandedCanvasPriorViewport ?? null
}

export function applyEmptyCanvasWorkspaceState(
  appliers: Pick<
    CanvasWorkspaceLoadAppliers,
    | 'setTiles'
    | 'setGroups'
    | 'setPanelLayout'
    | 'setActivePanelId'
    | 'setExpandedTileId'
    | 'setExpandedCanvasGroupId'
    | 'setExpandLayoutGroupId'
    | 'setLockedConnections'
    | 'savedLayoutRef'
    | 'expandedCanvasGroupIdRef'
    | 'expandLayoutGroupIdRef'
    | 'expandedCanvasPriorViewportRef'
  >,
  resetViewportState: () => void,
): void {
  appliers.setTiles([])
  appliers.setGroups([])
  appliers.setLockedConnections?.([])
  resetViewportState()
  appliers.savedLayoutRef.current = null
  appliers.setPanelLayout(null)
  appliers.setActivePanelId(null)
  appliers.setExpandedTileId(null)
  appliers.setExpandedCanvasGroupId(null)
  appliers.expandedCanvasGroupIdRef.current = null
  appliers.setExpandLayoutGroupId?.(null)
  if (appliers.expandLayoutGroupIdRef) appliers.expandLayoutGroupIdRef.current = null
  appliers.expandedCanvasPriorViewportRef.current = null
}
