import React, { Suspense } from 'react'
import type { AggregatedSessionEntry, WorkspaceSessionEntry } from '../../../shared/session-types'
import type { AppSettings, ExtensionTileContrib, TileState, TileType, Workspace } from '../../../shared/types'
import type { AppTheme } from '../theme'
import { MainStatusBar } from './MainStatusBar'

const LazySidebar = React.lazy(() => import('./Sidebar').then(m => ({ default: m.Sidebar })))
const LazySidebarFooter = React.lazy(() => import('./Sidebar').then(m => ({ default: m.SidebarFooter })))

type ActiveChatSessionMatch = {
  sessionId: string | null
  entryId: string | null
}

type SessionTargetEntry = AggregatedSessionEntry | WorkspaceSessionEntry
type FocusOpenOptions = { persist?: boolean, sourceTileId?: string }

export type AppSidebarRegionProps = {
  theme: AppTheme
  sidebarCollapsed: boolean
  sidebarWidth: number
  mainPanelBottomInset: number
  sidebarFooterHeight: number
  mainPanelLeft: number
  mainPanelTop: number

  sidebarFooterLeft: number
  sidebarFooterBottom: number
  mainStatusBarLeft: number
  workspace: Workspace | null
  workspaces: Workspace[]
  tiles: TileState[]
  activeChatTileId: string | null
  activeChatSessionMatch: ActiveChatSessionMatch
  settings: AppSettings
  visibleSidebarExtensionTiles: ExtensionTileContrib[]
  visibleSidebarExtensionEntries: Array<{ id: string, name: string, icon?: string | null, enabled: boolean }>
  viewport: { tx: number, ty: number, zoom: number }
  nextZIndex: number
  expandedTileIdRef: React.MutableRefObject<string | null>
  onSwitchWorkspace: (id: string) => void | Promise<void>
  onDeleteWorkspace: (id: string) => void | Promise<void>
  onNewWorkspace: (name: string) => void | Promise<void>
  onOpenFolder: () => void | Promise<void>
  onOpenFile: (path: string) => void
  bringToFront: (tileId: string) => void
  setTiles: React.Dispatch<React.SetStateAction<TileState[]>>
  saveCanvas: (tiles: TileState[], viewport: { tx: number, ty: number, zoom: number }, nextZIndex: number) => void
  closeTile: (tileId: string) => void
  addTile: (type: TileType, filePath?: string, world?: { x: number, y: number }) => string
  setShowSettings: React.Dispatch<React.SetStateAction<string | false>>
  openSessionInChat: (session: SessionTargetEntry, options?: FocusOpenOptions) => void | Promise<void>
  openSessionInApp: (session: SessionTargetEntry) => void | Promise<void>
  updateAppSettings: (patch: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) => void
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>
  setSidebarResizing: React.Dispatch<React.SetStateAction<boolean>>
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setExpandedTileId: React.Dispatch<React.SetStateAction<string | null>>
  setShowExtensionsGallery: (open: boolean) => void
  openDaemonTask: (task: {
    id: string
    taskLabel: string | null
    status: string
    provider: string | null
    model: string | null
    workspaceDir: string | null
    sessionId: string | null
  }) => void | Promise<void>
}

export function AppSidebarRegion(props: AppSidebarRegionProps): JSX.Element {
  const {
    theme,
    sidebarCollapsed,
    sidebarWidth,
    mainPanelBottomInset,
    sidebarFooterHeight,
    mainPanelLeft,
    mainPanelTop,
    sidebarFooterLeft,
    sidebarFooterBottom,
    mainStatusBarLeft,
    workspace,
    workspaces,
    tiles,
    activeChatTileId,
    activeChatSessionMatch,
    settings,
    visibleSidebarExtensionTiles,
    visibleSidebarExtensionEntries,
    viewport,
    nextZIndex,
    expandedTileIdRef,
    onSwitchWorkspace,
    onDeleteWorkspace,
    onNewWorkspace,
    onOpenFolder,
    onOpenFile,
    bringToFront,
    setTiles,
    saveCanvas,
    closeTile,
    addTile,
    setShowSettings,
    openSessionInChat,
    openSessionInApp,
    updateAppSettings,
    setSidebarWidth,
    setSidebarResizing,
    setSidebarCollapsed,
    setExpandedTileId,
    setShowExtensionsGallery,
    openDaemonTask,
  } = props

  return (
    <>
    {/* Sidebar inset panel — floats over the canvas */}
    <div style={{
      position: 'absolute',
      top: 19,
      left: 6,
      bottom: mainPanelBottomInset,
      padding: '0px',
      width: sidebarCollapsed ? 0 : sidebarWidth,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      minWidth: sidebarCollapsed ? 0 : 270,
      zIndex: 10,
      pointerEvents: 'none',
      transition: 'width 0.15s ease',
    }}>
      <div style={{
        width: '100%',
        height: '100%',
        background: 'transparent',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        borderRadius: 12,
        border: 'none',
        paddingTop: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
        position: 'relative',
      }}>
        {/* Sidebar content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingBottom: sidebarFooterHeight, position: 'relative', zIndex: 2 }}>
          <Suspense fallback={
            <div style={{
              flex: 1,
              color: theme.text.disabled,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11
            }}>
              Loading sidebar…
            </div>
          }>
            <LazySidebar
              workspace={workspace}
              workspaces={workspaces}
              tiles={tiles}
              activeChatTileId={activeChatTileId}
              activeChatSessionId={activeChatSessionMatch.sessionId}
              activeChatSessionEntryId={activeChatSessionMatch.entryId}
              onSwitchWorkspace={onSwitchWorkspace}
              onDeleteWorkspace={onDeleteWorkspace}
              onNewWorkspace={onNewWorkspace}
              onOpenFolder={onOpenFolder}
              onOpenFile={onOpenFile}
              onFocusTile={bringToFront}
              onUpdateTile={(tileId, patch) => {
                setTiles(prev => {
                  const updated = prev.map(t => t.id === tileId ? { ...t, ...patch } : t)
                  saveCanvas(updated, viewport, nextZIndex)
                  return updated
                })
              }}
              onCloseTile={closeTile}
              onNewTerminal={() => addTile('terminal')}
              onNewKanban={() => addTile('kanban')}
              onNewBrowser={() => addTile('browser')}
              onNewChat={() => addTile('chat')}
              onNewChatForProject={async ({ workspaceId }) => {
                // Switch to the project's workspace first (if different)
                // so the newly created chat inherits the right context.
                if (workspaceId && workspaceId !== workspace?.id) {
                    await onSwitchWorkspace(workspaceId)
                }
                const chatTileId = addTile('chat')
                bringToFront(chatTileId)
                // If we're currently in fullscreen mode, make the new chat
                // the fullscreen tile so the user lands directly in it.
                // Otherwise it just appears on the canvas.
                if (expandedTileIdRef.current) {
                  setExpandedTileId(chatTileId)
                }
              }}
              onNewFiles={() => addTile('files')}
              onOpenSettings={(tab) => setShowSettings(tab)}
              onOpenSessionInChat={openSessionInChat}
              onOpenSessionInApp={openSessionInApp}
              extensionTiles={visibleSidebarExtensionTiles}
              extensionEntries={visibleSidebarExtensionEntries}
              onAddExtensionTile={(type) => addTile(type as TileType)}
              pinnedExtensionIds={settings.extensionsDisabled ? [] : (settings.pinnedExtensionIds ?? [])}
              onTogglePinnedExtension={(key) => {
                updateAppSettings(current => {
                  const pinned = current.pinnedExtensionIds ?? []
                  return {
                    pinnedExtensionIds: pinned.includes(key)
                      ? pinned.filter(id => id !== key)
                      : [...pinned, key],
                  }
                })
              }}
              collapsed={sidebarCollapsed}
              width={sidebarWidth}
              onWidthChange={setSidebarWidth}
              onResizeStateChange={setSidebarResizing}
              onToggleCollapse={() => setSidebarCollapsed(p => !p)}
              showFooter={false}
            />
          </Suspense>
        </div>
      </div>
    </div>
    
    {!sidebarCollapsed && (
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: mainPanelLeft,
          top: mainPanelTop,
          bottom: mainPanelBottomInset,
          width: 0.5,
          background: theme.border.subtle,
          pointerEvents: 'none',
          zIndex: 92,
          transition: 'left 0.15s ease',
        }}
      />
    )}
    
    <div
      style={{
        position: 'absolute',
        left: sidebarCollapsed ? 0 : sidebarFooterLeft,
        bottom: sidebarFooterBottom,
        // Toolbar persists above canvas and spills past the sidebar edge when
        // content is wider than the sidebar (e.g. Get Extensions + tile icons).
        // Width is always intrinsic so the icons never stack vertically.
        height: sidebarFooterHeight,
        zIndex: 140,
        pointerEvents: 'auto',
        transition: 'left 0.15s ease',
        overflow: 'visible',
      }}
    >
      <Suspense fallback={null}>
        <LazySidebarFooter
          onNewTerminal={() => addTile('terminal')}
          onNewKanban={() => addTile('kanban')}
          onNewBrowser={() => addTile('browser')}
          onNewChat={() => addTile('chat')}
          onNewFiles={() => addTile('files')}
          onOpenSettings={(tab) => setShowSettings(tab)}
          extensionTiles={visibleSidebarExtensionTiles}
          extensionEntries={visibleSidebarExtensionEntries}
          onAddExtensionTile={(type) => addTile(type as TileType)}
          collapsed={sidebarCollapsed}
          galleryEnabled={settings.extensionsGalleryEnabled !== false}
          onOpenGallery={() => setShowExtensionsGallery(true)}
        />
      </Suspense>
    </div>
    
    <div
      style={{
        position: 'absolute',
        left: mainStatusBarLeft,
        right: 0,
        bottom: 0,
        height: sidebarFooterHeight,
        zIndex: 95,
        pointerEvents: 'none',
        transform: 'translateY(5px)',
        transition: 'left 0.15s ease',
      }}
    >
      <MainStatusBar onOpenDaemonTask={openDaemonTask} health={settings.statusBarHealth ?? 'compact'} />
    </div>
    </>
  )
}
