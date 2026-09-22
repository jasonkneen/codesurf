import React from 'react'
import { X } from 'lucide-react'
import type { AppSettings, GroupState, TileState } from '../../../shared/types'
import type { PanelNode } from './panelLayoutTree'
import type { AppTheme } from '../theme'
import type { AppFonts } from '../FontContext'
import { getDroppedPaths } from '../utils/dnd'
import { resolveFileTileType } from '../lib/fileTileType'

export type AppCanvasSurfaceProps = {
  canvasRef: React.RefObject<HTMLDivElement | null>
  mainPanelTop: number
  mainPanelLeft: number
  mainPanelBottomInset: number
  mainPanelBackground: string
  mainPanelBorderRadius: number | string
  mainPanelShadow: string
  mainPanelInsetEdgeShadow: string
  isDraggingCanvas: boolean
  spaceHeldRef: React.MutableRefObject<boolean>
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
  onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void
  updateCanvasGlow: (clientX: number, clientY: number) => void
  hideCanvasGlow: () => void
  setCanvasPointerWorld: React.Dispatch<React.SetStateAction<{ x: number, y: number } | null>>
  screenToWorld: (clientX: number, clientY: number) => { x: number, y: number }
  tiles: TileState[]
  bringToFront: (tileId: string) => void
  panToTile: (tile: TileState) => void
  addTile: (type: TileState['type'], filePath?: string, world?: { x: number, y: number }) => string
  setSkillInstallPath: (path: string | null) => void
  panelLayout: PanelNode | null
  expandedCanvasGroupId: string | null
  groups: GroupState[]
  exitCanvasExpanded: () => void
  theme: AppTheme
  appFonts: AppFonts
  settings: AppSettings
  viewport: { tx: number, ty: number, zoom: number }
  canvasGlowEnabled: boolean
  dotGlowSmallRef: React.RefObject<HTMLDivElement | null>
  dotGlowLargeRef: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
  surfaceOverlays?: React.ReactNode
}

export function AppCanvasSurface(props: AppCanvasSurfaceProps): JSX.Element {
  const {
    canvasRef,
    mainPanelTop,
    mainPanelLeft,
    mainPanelBottomInset,
    mainPanelBackground,
    mainPanelBorderRadius,
    mainPanelShadow,
    mainPanelInsetEdgeShadow,
    isDraggingCanvas,
    spaceHeldRef,
    onMouseDown,
    onDoubleClick,
    onContextMenu,
    onWheel,
    updateCanvasGlow,
    hideCanvasGlow,
    setCanvasPointerWorld,
    screenToWorld,
    tiles,
    bringToFront,
    panToTile,
    addTile,
    setSkillInstallPath,
    panelLayout,
    expandedCanvasGroupId,
    groups,
    exitCanvasExpanded,
    theme,
    appFonts,
    settings,
    viewport,
    canvasGlowEnabled,
    dotGlowSmallRef,
    dotGlowLargeRef,
    children,
    surfaceOverlays,
  } = props

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const world = screenToWorld(event.clientX, event.clientY)

    const linkedTileId = event.dataTransfer.getData('application/tile-id')
    if (linkedTileId) {
      bringToFront(linkedTileId)
      const target = tiles.find(tile => tile.id === linkedTileId)
      if (target) panToTile(target)
      return
    }

    const cardTitle = event.dataTransfer.getData('application/card-title')
    const cardType = event.dataTransfer.getData('application/card-type') as TileState['type'] | ''
    const cardFile = event.dataTransfer.getData('application/card-file')
    if (cardTitle) {
      addTile(cardType || 'note', cardFile || undefined, world)
      return
    }

    const droppedPaths = getDroppedPaths(event.dataTransfer)
    if (droppedPaths.length > 0) {
      const skillPath = droppedPaths.find(path => path.toLowerCase().endsWith('.skill'))
      if (skillPath) {
        setSkillInstallPath(skillPath)
        return
      }
      const vsixPath = droppedPaths.find(path => path.endsWith('.vsix'))
      if (vsixPath) {
        window.electron.extensions.installVsix?.(vsixPath).then(result => {
          if (result?.ok) {
            console.log('[vsix] Installed:', result.name)
            const firstTile = result.tiles?.[0]
            if (firstTile) {
              addTile(firstTile.type as TileState['type'], undefined, world)
            }
          } else {
            console.error('[vsix] Install failed:', result?.error)
          }
        })
        return
      }
      for (const path of droppedPaths) {
        void resolveFileTileType(path).then(type => addTile(type, path, world))
      }
      return
    }

    const filePath = event.dataTransfer.getData('text/plain')
    if (filePath) {
      if (filePath.toLowerCase().endsWith('.skill')) {
        setSkillInstallPath(filePath)
        return
      }
      void resolveFileTileType(filePath).then(type => addTile(type, filePath, world))
    }
  }

  return (
    <div
      ref={canvasRef}
      data-canvas-surface="true"
      className="absolute overflow-hidden"
      style={{
        top: mainPanelTop,
        left: mainPanelLeft,
        right: 6,
        bottom: mainPanelBottomInset,
        background: mainPanelBackground,
        borderRadius: mainPanelBorderRadius,
        border: '0.5px solid transparent',
        boxShadow: mainPanelShadow,
        cursor: isDraggingCanvas ? 'grabbing' : (spaceHeldRef.current ? 'grab' : 'default'),
        userSelect: 'none',
        WebkitUserSelect: 'none',
        zIndex: 0,
        transition: 'left 0.15s ease',
      } as React.CSSProperties}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
      onMouseMove={event => {
        updateCanvasGlow(event.clientX, event.clientY)
        setCanvasPointerWorld(screenToWorld(event.clientX, event.clientY))
      }}
      onMouseLeave={() => {
        hideCanvasGlow()
        setCanvasPointerWorld(null)
      }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={handleDrop}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          boxShadow: mainPanelInsetEdgeShadow,
          pointerEvents: 'none',
          zIndex: 100001,
        }}
      />
      <div style={{
        position: 'absolute',
        inset: 0,
        opacity: panelLayout ? 0 : 1,
        transition: 'opacity 0.3s ease',
        pointerEvents: panelLayout ? 'none' : 'auto',
      }}>
        {expandedCanvasGroupId && (() => {
          const expandedGroup = groups.find(group => group.id === expandedCanvasGroupId)
          if (!expandedGroup) return null
          const bannerColor = expandedGroup.color ?? '#4a9eff'
          return (
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 10px 6px 12px',
                background: theme.surface.panel,
                border: `1px solid ${bannerColor}aa`,
                borderRadius: 999,
                boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
                zIndex: 99996,
                fontSize: appFonts.secondarySize,
                color: theme.text.primary,
                userSelect: 'none',
              }}
              onMouseDown={event => event.stopPropagation()}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: bannerColor }} />
              <span style={{ fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>{expandedGroup.label ?? 'group'}</span>
              <span style={{ opacity: 0.5, fontSize: appFonts.secondarySize - 1 }}>· canvas</span>
              <button
                title="Exit (Esc)"
                onClick={event => { event.stopPropagation(); exitCanvasExpanded() }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.secondary,
                  cursor: 'pointer',
                  marginLeft: 4,
                }}
                onMouseEnter={event => { (event.currentTarget as HTMLButtonElement).style.background = theme.surface.app }}
                onMouseLeave={event => { (event.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
              >
                <X size={14} />
              </button>
            </div>
          )
        })()}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle, ${settings.gridColorSmall} 1px, transparent 1px)`,
            backgroundSize: `${settings.gridSpacingSmall * viewport.zoom}px ${settings.gridSpacingSmall * viewport.zoom}px`,
            backgroundPosition: `${viewport.tx % (settings.gridSpacingSmall * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingSmall * viewport.zoom)}px`,
          }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle, ${settings.gridColorLarge} 2px, transparent 2px)`,
            backgroundSize: `${settings.gridSpacingLarge * viewport.zoom}px ${settings.gridSpacingLarge * viewport.zoom}px`,
            backgroundPosition: `${viewport.tx % (settings.gridSpacingLarge * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingLarge * viewport.zoom)}px`,
          }}
        />
        {canvasGlowEnabled && (
          <div
            ref={dotGlowSmallRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(circle, ${theme.canvas.gridGlowSmall} 1px, transparent 1px)`,
              backgroundSize: `${settings.gridSpacingSmall * viewport.zoom}px ${settings.gridSpacingSmall * viewport.zoom}px`,
              backgroundPosition: `${viewport.tx % (settings.gridSpacingSmall * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingSmall * viewport.zoom)}px`,
              opacity: 0,
              transition: 'opacity 0.3s ease-out',
            }}
          />
        )}
        {canvasGlowEnabled && (
          <div
            ref={dotGlowLargeRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(circle, ${theme.canvas.gridGlowLarge} 2px, transparent 2px)`,
              backgroundSize: `${settings.gridSpacingLarge * viewport.zoom}px ${settings.gridSpacingLarge * viewport.zoom}px`,
              backgroundPosition: `${viewport.tx % (settings.gridSpacingLarge * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingLarge * viewport.zoom)}px`,
              opacity: 0,
              transition: 'opacity 0.3s ease-out',
            }}
          />
        )}
        {children}
      </div>
      {surfaceOverlays}
    </div>
  )
}