import type { CanvasDragState } from '../hooks/useCanvasEngine'

export type CanvasAlignmentGuide = {
  x?: number
  y?: number
}

export type AppCanvasWorldOverlaysProps = {
  dragState: CanvasDragState
  guides: CanvasAlignmentGuide[]
}

export function AppCanvasWorldOverlays(props: AppCanvasWorldOverlaysProps): JSX.Element {
  const { dragState, guides } = props

  return (
    <>
      {dragState.type === 'select' && (() => {
        const x = Math.min(dragState.startWx, dragState.curWx)
        const y = Math.min(dragState.startWy, dragState.curWy)
        const w = Math.abs(dragState.curWx - dragState.startWx)
        const h = Math.abs(dragState.curWy - dragState.startWy)
        return (
          <div style={{
            position: 'absolute', left: x, top: y, width: w, height: h,
            border: '1px solid rgba(74,158,255,0.6)',
            background: 'rgba(74,158,255,0.06)',
            borderRadius: 3,
            pointerEvents: 'none',
            zIndex: 99998,
            boxSizing: 'border-box',
          }}
          />
        )
      })()}
      {guides.map((guide, index) =>
        guide.x !== undefined ? (
          <div
            key={`gx-${index}`}
            style={{
              position: 'absolute',
              left: guide.x,
              top: -9999,
              width: 1,
              height: 99999,
              background: 'rgba(74,158,255,0.7)',
              pointerEvents: 'none',
              zIndex: 99999,
            }}
          />
        ) : (
          <div
            key={`gy-${index}`}
            style={{
              position: 'absolute',
              top: guide.y,
              left: -9999,
              height: 1,
              width: 99999,
              background: 'rgba(74,158,255,0.7)',
              pointerEvents: 'none',
              zIndex: 99999,
            }}
          />
        ),
      )}
    </>
  )
}