import React, { Suspense } from 'react'
import type { TileState } from '../../../shared/types'

const LazyMinimap = React.lazy(() => import('./Minimap').then(module => ({ default: module.Minimap })))

export type AppCanvasMinimapOverlayProps = {
  enabled: boolean
  tiles: TileState[]
  viewport: { tx: number, ty: number, zoom: number }
  canvasWidth: number
  canvasHeight: number
  onPan: (tx: number, ty: number) => void
}

export function AppCanvasMinimapOverlay(props: AppCanvasMinimapOverlayProps): JSX.Element | null {
  const {
    enabled,
    tiles,
    viewport,
    canvasWidth,
    canvasHeight,
    onPan,
  } = props

  if (!enabled) return null

  return (
    <Suspense fallback={null}>
      <LazyMinimap
        tiles={tiles}
        viewport={viewport}
        canvasSize={{ w: canvasWidth, h: canvasHeight }}
        onPan={onPan}
      />
    </Suspense>
  )
}