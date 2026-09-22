import React, { Suspense } from 'react'
import type { GroupState, TileState } from '../../../shared/types'
import type { PanelNode } from './panelLayoutTree'

const LazyArrangeToolbar = React.lazy(() => import('./ArrangeToolbar').then(m => ({ default: m.ArrangeToolbar })))

type ArrangeMode = 'grid' | 'column' | 'row'

export type AppCanvasArrangeToolbarProps = {
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode | null
  viewportZoom: number
  canvasArrangeMode: ArrangeMode | null
  onArrangeTiles: (updated: TileState[]) => void
  onSetCanvasArrangeMode: (mode: ArrangeMode | null) => void
  onExitExpandedMode: () => void
  onEnterTabbedView: () => void
  onZoomToggle: () => void
}

export function AppCanvasArrangeToolbar(props: AppCanvasArrangeToolbarProps): JSX.Element {
  const {
    tiles,
    groups,
    panelLayout,
    viewportZoom,
    canvasArrangeMode,
    onArrangeTiles,
    onSetCanvasArrangeMode,
    onExitExpandedMode,
    onEnterTabbedView,
    onZoomToggle,
  } = props

  return (
    <Suspense fallback={null}>
      <LazyArrangeToolbar
        tiles={tiles}
        groups={groups}
        onArrange={(updated, mode) => {
          if (panelLayout) onExitExpandedMode()
          onSetCanvasArrangeMode(mode)
          onArrangeTiles(updated)
        }}
        zoom={viewportZoom}
        isTabbedView={Boolean(panelLayout)}
        activeCanvasMode={canvasArrangeMode}
        onToggleTabs={() => {
          if (panelLayout) onExitExpandedMode()
          else onEnterTabbedView()
        }}
        onZoomToggle={onZoomToggle}
      />
    </Suspense>
  )
}