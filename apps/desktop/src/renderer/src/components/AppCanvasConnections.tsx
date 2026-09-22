import React, { Suspense } from 'react'
import type { TileState } from '../../../shared/types'
import type { PanelNode } from './panelLayoutTree'
import type { CanvasDragState } from '../hooks/useCanvasEngine'
import type {
  AmbientDiscoveryRenderRoute,
  ManualConnectionRenderRoute,
} from '../hooks/useNegotiatedDiscovery'
import {
  findBestAnchorPair,
  getTileSpatialReference,
  type DiscoveryMatch,
  type DiscoveryPulse,
} from '../lib/discoveryRuntime'
import {
  getBezierConnectionPath,
  getOppositeAnchorSide,
  getRouteMidpoint,
  getRouteSegments,
  routeToSvgPath,
} from '../lib/connectionRoutes'

const LazyConnectionPill = React.lazy(() => import('./ConnectionPill').then(m => ({ default: m.ConnectionPill })))

const DEFAULT_GRID = 20

export type DiscoveryPreviewState = {
  sourceRef: ReturnType<typeof getTileSpatialReference>
  match: DiscoveryMatch | null
} | null

export type AppCanvasConnectionsProps = {
  layer: 'pills' | 'routes' | 'glow'
  panelLayout: PanelNode | null
  manualConnectionRenderRoutes: ManualConnectionRenderRoute[]
  ambientDiscoveryRenderRoutes: AmbientDiscoveryRenderRoute[]
  discoveryPreview: DiscoveryPreviewState
  discoveryFocusTileId: string | null
  lockedConnectionKeys: Set<string>
  discoveryPulses: DiscoveryPulse[]
  dragState: CanvasDragState
  viewportZoom: number
  gridSize: number | undefined
  gridSpacingSmall: number | undefined
  dsc: { line: string, dot: string, bg: string, text: string }
  tileByIdMap: Map<string, TileState>
  discoveryPillZIndex: number
  discoveryHighlightZIndex: number
  discoveryGlowZIndex: number
  canvasGlowEnabled: boolean
  discoveryGlowRef: React.RefObject<HTMLDivElement | null>
  worldToScreenPoint: (point: { x: number, y: number }) => { x: number, y: number }
  isConnectionLocked: (tileIdA: string, tileIdB: string) => boolean
  onToggleConnectionLock: (tileIdA: string, tileIdB: string) => void
  onDeleteConnection: (tileIdA: string, tileIdB: string) => void
}

export function shouldShowConnectionPills(props: Pick<
  AppCanvasConnectionsProps,
  'panelLayout' | 'manualConnectionRenderRoutes' | 'ambientDiscoveryRenderRoutes' | 'discoveryPreview'
>): boolean {
  if (props.panelLayout) return false
  return props.manualConnectionRenderRoutes.length > 0
    || props.ambientDiscoveryRenderRoutes.length > 0
    || Boolean(props.discoveryPreview?.match)
}

export function shouldShowConnectionRoutes(props: Pick<
  AppCanvasConnectionsProps,
  | 'panelLayout'
  | 'manualConnectionRenderRoutes'
  | 'ambientDiscoveryRenderRoutes'
  | 'discoveryPreview'
  | 'discoveryPulses'
  | 'dragState'
>): boolean {
  if (props.panelLayout) return false
  return props.manualConnectionRenderRoutes.length > 0
    || props.ambientDiscoveryRenderRoutes.length > 0
    || Boolean(props.discoveryPreview?.match)
    || props.discoveryPulses.length > 0
    || props.dragState.type === 'connection'
}

export function shouldShowConnectionGlow(props: Pick<
  AppCanvasConnectionsProps,
  'canvasGlowEnabled' | 'panelLayout' | 'ambientDiscoveryRenderRoutes' | 'discoveryPreview' | 'discoveryPulses'
>): boolean {
  if (!props.canvasGlowEnabled || props.panelLayout) return false
  return props.ambientDiscoveryRenderRoutes.length > 0
    || Boolean(props.discoveryPreview?.match)
    || props.discoveryPulses.length > 0
}

function resolveGridStep(gridSize: number | undefined, gridSpacingSmall: number | undefined): number {
  return Math.max(8, gridSize || gridSpacingSmall || DEFAULT_GRID)
}

export function AppCanvasConnections(props: AppCanvasConnectionsProps): JSX.Element | null {
  const {
    layer,
    manualConnectionRenderRoutes,
    ambientDiscoveryRenderRoutes,
    discoveryPreview,
    discoveryFocusTileId,
    lockedConnectionKeys,
    discoveryPulses,
    dragState,
    viewportZoom,
    gridSize,
    gridSpacingSmall,
    dsc,
    tileByIdMap,
    discoveryPillZIndex,
    discoveryHighlightZIndex,
    discoveryGlowZIndex,
    discoveryGlowRef,
    worldToScreenPoint,
    isConnectionLocked,
    onToggleConnectionLock,
    onDeleteConnection,
  } = props

  if (layer === 'pills') {
    if (!shouldShowConnectionPills(props)) return null
    return (
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: discoveryPillZIndex }}>
        {manualConnectionRenderRoutes.map(connection => (
          <Suspense key={`manual-pill-${connection.key}`} fallback={null}>
            <LazyConnectionPill
              x={connection.midpoint.x}
              y={connection.midpoint.y}
              zoom={viewportZoom}
              isLocked={true}
              onToggleLock={() => onToggleConnectionLock(connection.sourceTileId, connection.targetTileId)}
              onDelete={() => onDeleteConnection(connection.sourceTileId, connection.targetTileId)}
              dscLine={dsc.line}
            />
          </Suspense>
        ))}
        {ambientDiscoveryRenderRoutes.map(connection => {
          const mid = getRouteMidpoint(connection.displayRoute)
          const [tileIdA, tileIdB] = connection.key.split('::')
          return (
            <Suspense key={`pill-${connection.key}`} fallback={null}>
              <LazyConnectionPill
                x={mid.x}
                y={mid.y}
                zoom={viewportZoom}
                isLocked={isConnectionLocked(tileIdA, tileIdB)}
                onToggleLock={() => onToggleConnectionLock(tileIdA, tileIdB)}
                onDelete={() => onDeleteConnection(tileIdA, tileIdB)}
                dscLine={dsc.line}
              />
            </Suspense>
          )
        })}
        {discoveryPreview?.match && discoveryFocusTileId && (() => {
          const previewKey = [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
          if (lockedConnectionKeys.has(previewKey)) return null
          const mid = getRouteMidpoint(discoveryPreview.match.route)
          return (
            <Suspense fallback={null}>
              <LazyConnectionPill
                x={mid.x}
                y={mid.y}
                zoom={viewportZoom}
                isLocked={false}
                onToggleLock={() => onToggleConnectionLock(discoveryFocusTileId!, discoveryPreview!.match!.tile.id)}
                onDelete={() => onDeleteConnection(discoveryFocusTileId!, discoveryPreview!.match!.tile.id)}
                dscLine={dsc.line}
              />
            </Suspense>
          )
        })()}
      </div>
    )
  }

  if (layer === 'routes') {
    if (!shouldShowConnectionRoutes(props)) return null
    const gridStep = resolveGridStep(gridSize, gridSpacingSmall)
    return (
      <div style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: dragState.type === 'connection' ? 99996 : discoveryHighlightZIndex,
      }}
      >
        {ambientDiscoveryRenderRoutes.map(connection => (
          <React.Fragment key={connection.key}>
            {getRouteSegments(connection.displayRoute, 2).map((segment, index) => (
              <div
                key={`${connection.key}-segment-${index}`}
                style={{
                  position: 'absolute',
                  left: segment.left,
                  top: segment.top,
                  width: segment.width,
                  height: segment.height,
                  borderRadius: 999,
                  backgroundImage: segment.horizontal
                    ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.28) 0 10px, transparent 10px 22px)`
                    : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.28) 0 10px, transparent 10px 22px)`,
                  opacity: 0.92,
                  filter: `drop-shadow(0 0 4px rgba(${dsc.line}, 0.18))`,
                }}
              />
            ))}
          </React.Fragment>
        ))}
        {discoveryPreview?.match && discoveryFocusTileId && (() => {
          const previewKey = [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
          if (lockedConnectionKeys.has(previewKey)) return null
          const sourceTile = tileByIdMap.get(discoveryFocusTileId)
          const targetTile = tileByIdMap.get(discoveryPreview.match.tile.id)
          if (!sourceTile || !targetTile) return null
          const previewRoute = discoveryPreview.match.route
          return (
            <>
              {getRouteSegments(previewRoute).map((segment, index) => (
                <div
                  key={`preview-segment-${index}`}
                  style={{
                    position: 'absolute',
                    left: segment.left,
                    top: segment.top,
                    width: segment.width,
                    height: segment.height,
                    borderRadius: 999,
                    backgroundImage: segment.horizontal
                      ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.64) 0 12px, transparent 12px 20px)`
                      : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.64) 0 12px, transparent 12px 20px)`,
                    filter: `drop-shadow(0 0 6px rgba(${dsc.line}, 0.22))`,
                  }}
                />
              ))}
              {previewRoute.map((point, index) => (
                <div
                  key={`preview-${index}`}
                  style={{
                    position: 'absolute',
                    left: point.x,
                    top: point.y,
                    width: index === 0 || index === previewRoute.length - 1 ? 9 : 6,
                    height: index === 0 || index === previewRoute.length - 1 ? 9 : 6,
                    borderRadius: '50%',
                    transform: 'translate(-50%, -50%)',
                    background: index === 0 || index === previewRoute.length - 1 ? `rgba(${dsc.line}, 0.72)` : `rgba(${dsc.line}, 0.36)`,
                    boxShadow: `0 0 8px rgba(${dsc.line}, 0.24)`,
                  }}
                />
              ))}
            </>
          )
        })()}
        <svg
          width={200000}
          height={200000}
          viewBox="-100000 -100000 200000 200000"
          style={{ position: 'absolute', left: -100000, top: -100000, overflow: 'visible', pointerEvents: 'none' }}
        >
          {manualConnectionRenderRoutes.map(connection => (
            <g key={`manual-route-${connection.key}`}>
              <path
                d={connection.path}
                fill="none"
                stroke={`rgba(${dsc.line}, 0.20)`}
                strokeWidth={7 / Math.max(0.35, viewportZoom)}
                strokeLinecap="round"
              />
              <path
                d={connection.path}
                fill="none"
                stroke={`rgba(${dsc.line}, 0.78)`}
                strokeWidth={2.5 / Math.max(0.35, viewportZoom)}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={`${1 / Math.max(0.35, viewportZoom)} ${10 / Math.max(0.35, viewportZoom)}`}
                style={{ filter: `drop-shadow(0 0 7px rgba(${dsc.line}, 0.18))` }}
              />
              <circle cx={connection.source.x} cy={connection.source.y} r={4.2 / Math.max(0.35, viewportZoom)} fill={`rgba(${dsc.line}, 0.88)`} />
              <circle cx={connection.target.x} cy={connection.target.y} r={4.2 / Math.max(0.35, viewportZoom)} fill={`rgba(${dsc.line}, 0.88)`} />
            </g>
          ))}
          {dragState.type === 'connection' && (() => {
            const targetTile = dragState.targetTileId ? tileByIdMap.get(dragState.targetTileId) : null
            const targetAnchors = targetTile
              ? getTileSpatialReference(targetTile, gridStep).anchors
              : []
            const facingTargetAnchors = targetAnchors.filter(anchor => anchor.side === getOppositeAnchorSide(dragState.side))
            const targetPoint = targetTile
              ? findBestAnchorPair([dragState.anchor], facingTargetAnchors.length ? facingTargetAnchors : targetAnchors)?.target ?? dragState.current
              : dragState.current
            const dx = dragState.current.x - dragState.anchor.x
            const dy = dragState.current.y - dragState.anchor.y
            const sag = Math.sin((dx + dy) * 0.035) * 20
            const path = getBezierConnectionPath(dragState.anchor, targetPoint, sag)
            return (
              <g>
                <path
                  d={path}
                  fill="none"
                  stroke={`rgba(${dsc.line}, 0.18)`}
                  strokeWidth={10 / Math.max(0.35, viewportZoom)}
                  strokeLinecap="round"
                />
                <path
                  d={path}
                  fill="none"
                  stroke={`rgba(${dsc.line}, 0.86)`}
                  strokeWidth={3 / Math.max(0.35, viewportZoom)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${1 / Math.max(0.35, viewportZoom)} ${10 / Math.max(0.35, viewportZoom)}`}
                  style={{
                    filter: `drop-shadow(0 0 10px rgba(${dsc.line}, 0.20))`,
                    transition: 'd 0.08s linear',
                  }}
                />
                <circle cx={dragState.anchor.x} cy={dragState.anchor.y} r={4.5 / Math.max(0.35, viewportZoom)} fill={`rgba(${dsc.line}, 0.95)`} />
                <circle cx={targetPoint.x} cy={targetPoint.y} r={targetTile ? 6 / Math.max(0.35, viewportZoom) : 4 / Math.max(0.35, viewportZoom)} fill={`rgba(${dsc.line}, ${targetTile ? 0.95 : 0.58})`} />
              </g>
            )
          })()}
          {discoveryPulses.map(pulse => {
            const sourceTile = tileByIdMap.get(pulse.sourceTileId)
            const targetTile = tileByIdMap.get(pulse.targetTileId)
            if (!sourceTile || !targetTile) return null
            const route = pulse.route
            const d = routeToSvgPath(route)
            return (
              <g key={`route-${pulse.id}`}>
                <path
                  d={d}
                  fill="none"
                  stroke={`rgba(${dsc.line}, 0.18)`}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={d}
                  fill="none"
                  pathLength={100}
                  stroke={`rgba(${dsc.line}, 0.72)`}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    strokeDasharray: '16 84',
                    strokeDashoffset: 100,
                    filter: `drop-shadow(0 0 8px rgba(${dsc.line}, 0.24))`,
                    animation: `discovery-route-travel ${pulse.durationMs}ms linear forwards`,
                  }}
                />
                {route.map((point, index) => (
                  <circle
                    key={`${pulse.id}-pt-${index}`}
                    cx={point.x}
                    cy={point.y}
                    r={index === 0 || index === route.length - 1 ? 4.5 : 3}
                    fill={index === 0 || index === route.length - 1 ? `rgba(${dsc.line}, 0.72)` : `rgba(${dsc.line}, 0.36)`}
                  />
                ))}
              </g>
            )
          })}
        </svg>
      </div>
    )
  }

  if (!shouldShowConnectionGlow(props)) return null
  return (
    <div
      ref={discoveryGlowRef}
      className="absolute inset-0 pointer-events-none"
      style={{
        opacity: 0,
        transition: 'opacity 0.18s ease-out',
        zIndex: discoveryGlowZIndex,
      }}
    >
      {ambientDiscoveryRenderRoutes.map(connection => {
        const screenRoute = connection.displayRoute.map(worldToScreenPoint)
        return getRouteSegments(screenRoute, 2.5).map((segment, index) => (
          <div
            key={`${connection.key}-glow-${index}`}
            style={{
              position: 'absolute',
              left: segment.left,
              top: segment.top,
              width: segment.width,
              height: segment.height,
              borderRadius: 999,
              backgroundImage: segment.horizontal
                ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.72) 0 10px, transparent 10px 22px)`
                : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.72) 0 10px, transparent 10px 22px)`,
              filter: `drop-shadow(0 0 6px rgba(${dsc.line}, 0.26))`,
            }}
          />
        ))
      })}
      {discoveryPreview?.match && discoveryFocusTileId && (() => {
        const previewKey = [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
        if (lockedConnectionKeys.has(previewKey)) return null
        const screenRoute = discoveryPreview.match.route.map(worldToScreenPoint)
        return (
          <>
            {getRouteSegments(screenRoute, 3.2).map((segment, index) => (
              <div
                key={`preview-glow-${index}`}
                style={{
                  position: 'absolute',
                  left: segment.left,
                  top: segment.top,
                  width: segment.width,
                  height: segment.height,
                  borderRadius: 999,
                  backgroundImage: segment.horizontal
                    ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.82) 0 12px, transparent 12px 20px)`
                    : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.82) 0 12px, transparent 12px 20px)`,
                  filter: `drop-shadow(0 0 8px rgba(${dsc.line}, 0.30))`,
                }}
              />
            ))}
            {screenRoute.map((point, index) => (
              <div
                key={`preview-glow-dot-${index}`}
                style={{
                  position: 'absolute',
                  left: point.x,
                  top: point.y,
                  width: index === 0 || index === screenRoute.length - 1 ? 10 : 6,
                  height: index === 0 || index === screenRoute.length - 1 ? 10 : 6,
                  borderRadius: '50%',
                  transform: 'translate(-50%, -50%)',
                  background: index === 0 || index === screenRoute.length - 1 ? `rgba(${dsc.line}, 0.82)` : `rgba(${dsc.line}, 0.46)`,
                  boxShadow: `0 0 9px rgba(${dsc.line}, 0.28)`,
                }}
              />
            ))}
          </>
        )
      })()}
      {discoveryPulses.map(pulse => {
        const screenRoute = pulse.route.map(worldToScreenPoint)
        return getRouteSegments(screenRoute, 3.2).map((segment, index) => (
          <div
            key={`${pulse.id}-glow-${index}`}
            style={{
              position: 'absolute',
              left: segment.left,
              top: segment.top,
              width: segment.width,
              height: segment.height,
              borderRadius: 999,
              backgroundImage: segment.horizontal
                ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.76) 0 12px, transparent 12px 20px)`
                : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.76) 0 12px, transparent 12px 20px)`,
              filter: `drop-shadow(0 0 8px rgba(${dsc.line}, 0.28))`,
            }}
          />
        ))
      })}
    </div>
  )
}