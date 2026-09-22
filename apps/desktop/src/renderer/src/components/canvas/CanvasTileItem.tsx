import React, { Suspense } from 'react'
import { Link2 } from 'lucide-react'
import type { TileState } from '../../../../shared/types'
import { TileColorProvider } from '../../TileColorContext'
import { TileChrome } from '../TileChrome'
import type { AppTheme } from '../../theme'
import type { RenderTileBodyOptions } from '../../hooks/useRenderTileBody'
import type { AnchorPoint } from '../../lib/discoveryRuntime'
import { getConnectionHandlePoint } from '../../lib/connectionRoutes'
import { createLoadableModuleTile } from '../../lib/loadableTile'
import { perfFlags } from '../../perfFlags'

const LazyStickyColorPicker = createLoadableModuleTile(
  () => import('../NoteTile'),
  module => module.StickyColorPicker,
  () => null,
)

type ResizeDir = 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'
type Side = AnchorPoint['side']

export type CanvasTileItemProps = {
  tile: TileState
  zoom: number
  /** Perf: tile is fully outside the viewport — body stops painting (state kept). */
  bodyCulled: boolean
  /** Perf: zoomed out past the LOD threshold — body hidden behind a light card. */
  lodPlaceholder: boolean
  workspaceId?: string
  workspaceDir?: string
  isActiveDrag: boolean
  isSelected: boolean
  isConnectionSource: boolean
  isConnectionTarget: boolean
  /** True only while a connection drag is in progress (any tile). */
  connectionDragActive: boolean
  showConnectionHandle: boolean
  activeHandleSide: Side
  forceExpanded: boolean
  discoveryConnected: boolean
  connectedPeers: string[]
  isUntitledNote: boolean
  dscLine: string
  dscText: string
  theme: AppTheme
  onClose: (tileId: string) => void
  onActivate: (tileId: string) => void
  onTitlebarMouseDown: (e: React.MouseEvent, tile: TileState) => void
  onResizeMouseDown: (e: React.MouseEvent, tile: TileState, dir: ResizeDir) => void
  onContextMenu: (e: React.MouseEvent, tile: TileState) => void
  onEnterExpandedMode: (tileId: string) => void
  onExitExpandedMode: () => void
  onConnectionMouseDown: (e: React.MouseEvent, tile: TileState, side: Side) => void
  showConnectionHandleForSide: (tileId: string, side: Side) => void
  scheduleConnectionHandleHide: (tileId: string, side: Side) => void
  setCanvasPointerWorld: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number }
  renderTileBody: (tile: TileState, options?: RenderTileBodyOptions) => React.ReactNode
}

function CanvasTileItemComponent(props: CanvasTileItemProps): JSX.Element {
  const {
    tile,
    zoom,
    bodyCulled,
    lodPlaceholder,
    workspaceId,
    workspaceDir,
    isActiveDrag,
    isSelected,
    isConnectionSource,
    isConnectionTarget,
    connectionDragActive,
    showConnectionHandle,
    activeHandleSide,
    forceExpanded,
    discoveryConnected,
    connectedPeers,
    isUntitledNote,
    dscLine,
    dscText,
    theme,
    onClose,
    onActivate,
    onTitlebarMouseDown,
    onResizeMouseDown,
    onContextMenu,
    onEnterExpandedMode,
    onExitExpandedMode,
    onConnectionMouseDown,
    showConnectionHandleForSide,
    scheduleConnectionHandleHide,
    setCanvasPointerWorld,
    screenToWorld,
    renderTileBody,
  } = props

  const z = Math.max(0.25, zoom)
  // Startup-constant: flags come from env, so the wrapper structure never
  // toggles at runtime (a structure change would remount the body).
  const perfEnabled = perfFlags.viewportCulling || perfFlags.zoomLod
  const hideBody = bodyCulled || lodPlaceholder
  const chromeTile = isActiveDrag ? { ...tile, zIndex: 99990 } : tile
  const handlePoint = getConnectionHandlePoint(tile, activeHandleSide)
  const handleSize = 22 / z
  const sensorThickness = 52 / z
  const sensorOverlap = 16 / z
  const isSelectedImageTile = tile.type === 'image' && isSelected

  return (
    <Suspense
      fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12, background: theme.surface.panel }}>Loading block…</div>}
    >
      <>
        <TileColorProvider>
          <TileChrome
            tile={chromeTile}
            workspaceId={workspaceId}
            workspaceDir={workspaceDir}
            onClose={() => onClose(tile.id)}
            onActivate={() => onActivate(tile.id)}
            onTitlebarMouseDown={e => onTitlebarMouseDown(e, tile)}
            onResizeMouseDown={(e, dir) => onResizeMouseDown(e, tile, dir)}
            onContextMenu={e => onContextMenu(e, tile)}
            isSelected={isSelected}
            isInteracting={isActiveDrag}
            allowOverflow={isSelectedImageTile}
            forceExpanded={forceExpanded}
            onExpandChange={expanded => expanded ? onEnterExpandedMode(tile.id) : onExitExpandedMode()}
            discoveryConnected={discoveryConnected}
            connectedPeers={connectedPeers}
            titlebarExtra={isUntitledNote ? <Suspense fallback={null}><LazyStickyColorPicker /></Suspense> : undefined}
          >
            <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12, background: theme.surface.panelMuted }}>Loading block…</div>}>
              {perfEnabled ? (
                // Stable wrapper (present whenever culling/LOD flags are on) so
                // toggling hidden/LOD only flips styles — the body subtree is
                // never remounted and terminals/webviews keep their state.
                <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      ...(hideBody ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : null),
                    }}
                  >
                    {renderTileBody(tile, { isInteracting: isActiveDrag, isSelected })}
                  </div>
                  {lodPlaceholder && !bodyCulled && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6 / z,
                        background: theme.surface.panelMuted,
                        pointerEvents: 'none',
                      }}
                    >
                      <div style={{ fontSize: Math.min(64, 14 / z), fontWeight: 600, color: theme.text.muted, maxWidth: '85%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tile.label || tile.type}
                      </div>
                      <div style={{ fontSize: Math.min(44, 10 / z), color: theme.text.muted, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 1 }}>
                        {tile.type.startsWith('ext:') ? tile.type.slice(4) : tile.type}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                renderTileBody(tile, { isInteracting: isActiveDrag, isSelected })
              )}
            </Suspense>
          </TileChrome>
        </TileColorProvider>
        {isConnectionTarget && (
          <div
            style={{
              position: 'absolute',
              left: tile.x - 7 / zoom,
              top: tile.y - 7 / zoom,
              width: tile.width + 14 / zoom,
              height: tile.height + 14 / zoom,
              borderRadius: 12,
              border: `${2 / z}px solid rgba(${dscLine}, 0.78)`,
              boxShadow: `0 0 ${18 / z}px rgba(${dscLine}, 0.24)`,
              pointerEvents: 'none',
              zIndex: 99991,
            }}
          />
        )}
        {(['left', 'right', 'top', 'bottom'] as const).map(side => {
          const sensorStyle: React.CSSProperties = {
            position: 'absolute',
            pointerEvents: (connectionDragActive || isSelectedImageTile) ? 'none' : 'all',
            // Discovery hit areas extend beyond their tile. Keep them below
            // tile chrome so a nearby tile's invisible sensor cannot steal
            // resize, titlebar, or content input from the visible tile.
            zIndex: Math.max(0, tile.zIndex - 1),
          }
          if (side === 'left') Object.assign(sensorStyle, {
            left: tile.x - sensorThickness,
            top: tile.y - sensorOverlap,
            width: sensorThickness,
            height: tile.height + sensorOverlap * 2,
          })
          if (side === 'right') Object.assign(sensorStyle, {
            left: tile.x + tile.width,
            top: tile.y - sensorOverlap,
            width: sensorThickness,
            height: tile.height + sensorOverlap * 2,
          })
          if (side === 'top') Object.assign(sensorStyle, {
            left: tile.x - sensorOverlap,
            top: tile.y - sensorThickness,
            width: tile.width + sensorOverlap * 2,
            height: sensorThickness,
          })
          if (side === 'bottom') Object.assign(sensorStyle, {
            left: tile.x - sensorOverlap,
            top: tile.y + tile.height,
            width: tile.width + sensorOverlap * 2,
            height: sensorThickness,
          })
          return (
            <div
              key={`${tile.id}-link-sensor-${side}`}
              data-tile-chrome="true"
              style={sensorStyle}
              onMouseDown={e => e.stopPropagation()}
              onMouseEnter={() => showConnectionHandleForSide(tile.id, side)}
              onMouseMove={e => {
                showConnectionHandleForSide(tile.id, side)
                setCanvasPointerWorld(screenToWorld(e.clientX, e.clientY))
              }}
              onMouseLeave={() => scheduleConnectionHandleHide(tile.id, side)}
            />
          )
        })}
        <button
          type="button"
          title="Drag to link blocks"
          aria-label="Drag to link blocks"
          onMouseDown={e => onConnectionMouseDown(e, tile, activeHandleSide)}
          style={{
            position: 'absolute',
            left: handlePoint.x - handleSize / 2,
            top: handlePoint.y - handleSize / 2,
            width: handleSize,
            height: handleSize,
            borderRadius: '50%',
            border: `${1.5 / z}px solid rgba(${dscLine}, ${isConnectionSource ? 0.9 : 0.48})`,
            background: isConnectionSource ? `rgba(${dscLine}, 0.28)` : theme.surface.panelElevated,
            color: dscText,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            cursor: isConnectionSource ? 'grabbing' : 'grab',
            opacity: showConnectionHandle ? 1 : 0,
            pointerEvents: showConnectionHandle ? 'all' : 'none',
            zIndex: 99992,
            boxShadow: isConnectionSource ? `0 0 ${14 / z}px rgba(${dscLine}, 0.34)` : '0 2px 8px rgba(0,0,0,0.22)',
          }}
          onMouseEnter={() => showConnectionHandleForSide(tile.id, activeHandleSide)}
          onMouseMove={e => {
            showConnectionHandleForSide(tile.id, activeHandleSide)
            setCanvasPointerWorld(screenToWorld(e.clientX, e.clientY))
          }}
          onMouseLeave={() => {
            if (!isConnectionSource) scheduleConnectionHandleHide(tile.id, activeHandleSide)
          }}
        >
          <Link2 size={Math.max(8, 11 / z)} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </>
    </Suspense>
  )
}

// Custom equality: tile by reference (only the dragged/edited tile gets a new object),
// connectedPeers by content (the parent rebuilds this array every render), and every
// other prop by reference/value. Callbacks are useCallback-stable upstream, so comparing
// them by reference is correct — if one is ever unstable the item simply re-renders
// (no benefit) rather than going stale.
function arePropsEqual(a: CanvasTileItemProps, b: CanvasTileItemProps): boolean {
  if (a.tile !== b.tile) return false
  if (a.connectedPeers.length !== b.connectedPeers.length) return false
  for (let i = 0; i < a.connectedPeers.length; i++) {
    if (a.connectedPeers[i] !== b.connectedPeers[i]) return false
  }
  const keys = Object.keys(a) as (keyof CanvasTileItemProps)[]
  for (const key of keys) {
    if (key === 'tile' || key === 'connectedPeers') continue
    if (a[key] !== b[key]) return false
  }
  return true
}

export const CanvasTileItem = React.memo(CanvasTileItemComponent, arePropsEqual)
