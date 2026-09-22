import React, { Suspense, type MutableRefObject } from 'react'
import type { GroupState, LayoutTemplate, TileState } from '../../../shared/types'
import { appendTileAndCommitSplit } from '../lib/layoutGroupMembership.ts'
import type { AppTheme } from '../theme'
import type { RenderTileBodyOptions } from '../hooks/useRenderTileBody'
import {
  closeOthersInLeaf,
  closeToRightInLeaf,
  splitLeaf,
  type PanelNode,
} from './panelLayoutTree'

const LazyPanelLayout = React.lazy(() => import('./PanelLayout').then(m => ({ default: m.PanelLayout })))

export type PanelCornerRadii = {
  topLeft: number
  topRight: number
  bottomRight: number
  bottomLeft: number
}

export type AppCanvasPanelRegionProps = {
  panelLayout: PanelNode | null
  mainPanelCornerRadii: PanelCornerRadii
  tiles: TileState[]
  theme: AppTheme
  activePanelId: string | null
  nextZIndex: number
  getPanelTileLabel: (tileId: string) => string
  getPanelTileIcon: (tileId: string) => string | undefined
  renderTileBody: (tile: TileState, options?: RenderTileBodyOptions) => React.ReactNode
  viewportCenter: () => { x: number, y: number }
  getInitialTileSize: (type: TileState['type']) => { w: number, h: number }
  snapValue: (value: number) => number
  onLayoutChange: React.Dispatch<React.SetStateAction<PanelNode | null>>
  onCloseTab: (tileId: string) => void
  onAddTile: (type: TileState['type'], filePath?: string, world?: { x: number, y: number }) => string
  onExitExpandedMode: () => void
  onActivePanelChange: (panelId: string | null) => void
  onLaunchTemplate: (template: LayoutTemplate) => void | Promise<void>
  setTiles: React.Dispatch<React.SetStateAction<TileState[]>>
  setGroups?: React.Dispatch<React.SetStateAction<GroupState[]>>
  setNextZIndex: React.Dispatch<React.SetStateAction<number>>
  expandLayoutGroupId?: string | null
  tilesRef?: MutableRefObject<TileState[]>
  groupsRef?: MutableRefObject<GroupState[]>
  onTabDropOutside?: (tileId: string, clientX: number, clientY: number) => void
}

export function AppCanvasPanelRegion(props: AppCanvasPanelRegionProps): JSX.Element | null {
  const {
    panelLayout,
    mainPanelCornerRadii,
    tiles,
    theme,
    activePanelId,
    nextZIndex,
    getPanelTileLabel,
    getPanelTileIcon,
    renderTileBody,
    viewportCenter,
    getInitialTileSize,
    snapValue,
    onLayoutChange,
    onCloseTab,
    onAddTile,
    onExitExpandedMode,
    onActivePanelChange,
    onLaunchTemplate,
    setTiles,
    setGroups,
    setNextZIndex,
    expandLayoutGroupId,
    tilesRef,
    groupsRef,
    onTabDropOutside,
  } = props

  if (!panelLayout) return null

  return (
    <div
      data-codesurf-fullscreen-panel=""
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
      }}
    >
      <Suspense fallback={null}>
        <LazyPanelLayout
          root={panelLayout}
          insetBottom={0}
          outerRadii={mainPanelCornerRadii}
          getTileLabel={getPanelTileLabel}
          renderTile={(tileId) => {
            const tile = tiles.find(entry => entry.id === tileId)
            if (!tile) return null
            return (
              <div style={{ width: '100%', height: '100%', background: theme.surface.panel }}>
                <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12, background: theme.surface.panel }}>Loading block…</div>}>
                  {renderTileBody(tile)}
                </Suspense>
              </div>
            )
          }}
          onLayoutChange={onLayoutChange}
          onCloseTab={onCloseTab}
          onAddTile={type => onAddTile(type as TileState['type'])}
          onExit={onExitExpandedMode}
          activePanelId={activePanelId}
          onActivePanelChange={onActivePanelChange}
          getTileType={tileId => tiles.find(tile => tile.id === tileId)?.type ?? 'note'}
          getTileIcon={getPanelTileIcon}
          onSplitNew={(panelId, tileType, zone) => {
            const center = viewportCenter()
            const { w, h } = getInitialTileSize(tileType as TileState['type'])
            const newTile: TileState = {
              id: `tile-${Date.now()}`,
              type: tileType as TileState['type'],
              x: snapValue(center.x - w / 2),
              y: snapValue(center.y - h / 2),
              width: w,
              height: h,
              zIndex: nextZIndex,
              ...(expandLayoutGroupId ? { groupId: expandLayoutGroupId } : {}),
            }
            const latestTiles = tilesRef?.current ?? tiles
            if (expandLayoutGroupId && groupsRef && setGroups && panelLayout) {
              const result = appendTileAndCommitSplit({
                tiles: latestTiles,
                groups: groupsRef.current,
                layout: panelLayout,
                groupId: expandLayoutGroupId,
                newTile,
                panelId,
                zone,
              })
              if (tilesRef) tilesRef.current = result.tiles
              groupsRef.current = result.groups
              setTiles(result.tiles)
              setGroups(result.groups)
              setNextZIndex(prev => prev + 1)
              onLayoutChange(result.layout)
              return
            }
            const nextTiles = [...latestTiles, newTile]
            if (tilesRef) tilesRef.current = nextTiles
            setTiles(nextTiles)
            setNextZIndex(prev => prev + 1)
            onLayoutChange(prev => prev ? splitLeaf(prev, panelId, newTile.id, zone) : prev)
          }}
          onCloseOthers={(panelId, tileId) => {
            onLayoutChange(prev => prev ? closeOthersInLeaf(prev, panelId, tileId) : prev)
          }}
          onCloseToRight={(panelId, tileId) => {
            onLayoutChange(prev => prev ? closeToRightInLeaf(prev, panelId, tileId) : prev)
          }}
          onLaunchTemplate={onLaunchTemplate}
          onTabDropOutside={onTabDropOutside}
        />
      </Suspense>
    </div>
  )
}