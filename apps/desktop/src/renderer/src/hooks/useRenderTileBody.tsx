import React, { useCallback, useEffect, useRef } from 'react'
import type { AppSettings, TileState, TileType, Workspace } from '../../../shared/types'
import { getCurvierBlockRadius } from '../../../shared/types'
import { stripCapabilityPrefix } from '../../../shared/nodeTools'
import { toFileUrl } from '../utils/dnd'
import type { DiscoveryCapabilityLink } from '../lib/discoveryRuntime'
import { createLoadableModuleTile } from '../lib/loadableTile'
import type { ExtensionAction } from '../components/ExtensionTile'

const LazyTerminalTile = createLoadableModuleTile(
  () => import('../components/TerminalTile'),
  module => module.TerminalTile,
)
const LazyCodeTile = createLoadableModuleTile(
  () => import('../components/CodeTile'),
  module => module.CodeTile,
)
const LazyNoteTile = createLoadableModuleTile(
  () => import('../components/NoteTile'),
  module => module.NoteTile,
)
const LazyImageTile = createLoadableModuleTile(
  () => import('../components/ImageTile'),
  module => module.ImageTile,
)
const LazyMediaTile = createLoadableModuleTile(
  () => import('../components/MediaTile'),
  module => module.MediaTile,
)
const LazyFileTile = createLoadableModuleTile(
  () => import('../components/FileTile'),
  module => module.FileTile,
)
const LazyBrowserTile = createLoadableModuleTile(
  () => import('../components/BrowserTile'),
  module => module.BrowserTile,
)
const LazyKanbanTile = createLoadableModuleTile(
  () => import('../components/KanbanTile'),
  module => module.KanbanTile,
)
const LazyChatTile = createLoadableModuleTile(
  () => import('../components/ChatTile'),
  module => module.ChatTile,
)
const LazyChatTileWebview = createLoadableModuleTile(
  () => import('../components/ChatTileWebview'),
  module => module.ChatTileWebview,
)
const LazyFileExplorerTile = createLoadableModuleTile(
  () => import('../components/FileExplorerTile'),
  module => module.default,
)
const LazyExtensionTile = createLoadableModuleTile(
  () => import('../components/ExtensionTile'),
  module => module.ExtensionTile,
)

export type RenderTileBodyOptions = {
  isInteracting?: boolean
  isActive?: boolean
  isSelected?: boolean
}

export type RenderTileBodyPeer = DiscoveryCapabilityLink & {
  actions?: ExtensionAction[]
  filePath?: string
  label?: string
}

export type UseRenderTileBodyParams = {
  workspace: Workspace | null | undefined
  settings: AppSettings
  terminalFontFamily: string
  terminalFontSize: number
  viewportZoom: number
  tileByIdMap: Map<string, TileState>
  chatReloadTokens: Record<string, number>
  byTileConnections: Map<string, DiscoveryCapabilityLink[]>
  connectedTileIds: Set<string>
  sidebarSelectedPath: string | null | undefined
  onImageReplaceSource: (tileId: string, filePath: string) => void
  onFocusLinkedTile: (linkedId: string) => void
  onChatModePreferenceChange: (providerId: string, modeId: string) => void
  onOpenFile: (filePath: string, options?: { sourceTileId?: string }) => void
  onOpenWorkspace: () => void
  onAddTile: (
    type: TileType,
    filePath?: string,
    pos?: { x: number, y: number },
    initialOptions?: { hideTitlebar?: boolean, hideNavbar?: boolean },
  ) => string | null | void
  onExtensionActionsChanged: (tileId: string, actions: ExtensionAction[]) => void
  getExtensionActions: (tileId: string) => ExtensionAction[] | undefined
}

function toBrowserTileUrl(filePath: string): string {
  if (!filePath) return ''
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(filePath)) return filePath
  if (filePath === 'about:blank') return filePath
  if (filePath.startsWith('/')) return toFileUrl(filePath)
  return filePath
}

function mapConnectedPeers(
  tileId: string,
  byTileConnections: Map<string, DiscoveryCapabilityLink[]>,
  tileByIdMap: Map<string, TileState>,
  getExtensionActions: (tileId: string) => ExtensionAction[] | undefined,
): RenderTileBodyPeer[] {
  return (byTileConnections.get(tileId) ?? []).map(peer => {
    const peerTile = tileByIdMap.get(peer.peerId)
    return {
      ...peer,
      actions: getExtensionActions(peer.peerId),
      filePath: peerTile?.filePath,
      label: peerTile?.label,
    }
  })
}

export function useRenderTileBody(params: UseRenderTileBodyParams): (
  tile: TileState,
  options?: RenderTileBodyOptions,
) => React.ReactNode {
  const {
    workspace,
    settings,
    terminalFontFamily,
    terminalFontSize,
    viewportZoom,
    tileByIdMap,
    chatReloadTokens,
    byTileConnections,
    connectedTileIds,
    sidebarSelectedPath,
    onImageReplaceSource,
    onFocusLinkedTile,
    onChatModePreferenceChange,
    onOpenFile,
    onOpenWorkspace,
    onAddTile,
    onExtensionActionsChanged,
    getExtensionActions,
  } = params

  // --- volatile-dep refs: keep the callback identity stable across drags/zooms ---
  const viewportZoomRef = useRef(viewportZoom)
  const tileByIdMapRef = useRef(tileByIdMap)
  const chatReloadTokensRef = useRef(chatReloadTokens)
  const byTileConnectionsRef = useRef(byTileConnections)
  const connectedTileIdsRef = useRef(connectedTileIds)
  const sidebarSelectedPathRef = useRef(sidebarSelectedPath)
  const onFocusLinkedTileRef = useRef(onFocusLinkedTile)

  useEffect(() => { viewportZoomRef.current = viewportZoom }, [viewportZoom])
  useEffect(() => { tileByIdMapRef.current = tileByIdMap }, [tileByIdMap])
  useEffect(() => { chatReloadTokensRef.current = chatReloadTokens }, [chatReloadTokens])
  useEffect(() => { byTileConnectionsRef.current = byTileConnections }, [byTileConnections])
  useEffect(() => { connectedTileIdsRef.current = connectedTileIds }, [connectedTileIds])
  useEffect(() => { sidebarSelectedPathRef.current = sidebarSelectedPath }, [sidebarSelectedPath])
  useEffect(() => { onFocusLinkedTileRef.current = onFocusLinkedTile }, [onFocusLinkedTile])

  return useCallback((tile: TileState, options?: RenderTileBodyOptions): React.ReactNode => {
    const isTileInteracting = Boolean(options?.isInteracting)
    const isTileSelected = Boolean(options?.isSelected)

    switch (tile.type) {
      case 'terminal':
        return (
          <LazyTerminalTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            fontSize={terminalFontSize}
            fontFamily={terminalFontFamily}
            launchBin={tile.launchBin}
            launchArgs={tile.launchArgs}
          />
        )
      case 'code':
        return <LazyCodeTile filePath={tile.filePath} />
      case 'note':
        return <LazyNoteTile tileId={tile.id} workspaceId={workspace?.id} filePath={tile.filePath} workspacePath={workspace?.path} />
      case 'image':
        return tile.filePath ? (
          <LazyImageTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            filePath={tile.filePath}
            onReplaceFilePath={onImageReplaceSource}
            isSelected={isTileSelected}
            borderRadius={getCurvierBlockRadius(tile.borderRadius)}
            zoom={viewportZoomRef.current}
          />
        ) : null
      case 'media':
        return tile.filePath ? <LazyMediaTile tileId={tile.id} filePath={tile.filePath} /> : null
      case 'file':
        return tile.filePath ? (
          <LazyFileTile
            tileId={tile.id}
            filePath={tile.filePath}
            workspacePath={workspace?.path}
            secondaryFont={settings.fonts.secondary}
          />
        ) : null
      case 'browser':
        return (
          <LazyBrowserTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            initialUrl={toBrowserTileUrl(tile.filePath ?? '')}
            width={tile.width}
            height={tile.height}
            zIndex={tile.zIndex}
            isInteracting={isTileInteracting}
            isVisible={options?.isActive !== false}
            connectedPeers={byTileConnectionsRef.current.get(tile.id)?.map(link => link.peerId) ?? []}
            hideNavbar={tile.hideNavbar}
          />
        )
      case 'kanban':
        return (
          <LazyKanbanTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            onFocusTile={onFocusLinkedTileRef.current}
          />
        )
      case 'chat': {
        const chatPeers = mapConnectedPeers(tile.id, byTileConnectionsRef.current, tileByIdMapRef.current, getExtensionActions)
        const useWebviewChat = (settings as { experimental?: { chatTileWebview?: boolean } } | undefined)
          ?.experimental?.chatTileWebview === true
        const ChatComponent = useWebviewChat ? LazyChatTileWebview : LazyChatTile
        return (
          <ChatComponent
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            reloadToken={chatReloadTokensRef.current[tile.id] ?? 0}
            settings={settings}
            onChatModePreferenceChange={onChatModePreferenceChange}
            isConnected={connectedTileIdsRef.current.has(tile.id)}
            isAutoConnected={tile.autoAgentMode && connectedTileIdsRef.current.has(tile.id)}
            connectedPeers={chatPeers}
          />
        )
      }
      case 'files': {
        const terminalPeerIds = (byTileConnectionsRef.current.get(tile.id) ?? [])
          .filter(link => link.peerType === 'terminal')
          .map(link => link.peerId)
        return (
          <LazyFileExplorerTile
            tileId={tile.id}
            workspacePath={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            onOpenFile={(filePath, openOptions) => onOpenFile(filePath, { ...openOptions, sourceTileId: tile.id })}
            onOpenWorkspace={onOpenWorkspace}
            selectedFilePath={sidebarSelectedPathRef.current}
            connectedTerminalIds={terminalPeerIds}
          />
        )
      }
      default:
        if (tile.type.startsWith('ext:')) {
          const extensionPeers = (byTileConnectionsRef.current.get(tile.id) ?? []).map(peer => {
            const peerTile = tileByIdMapRef.current.get(peer.peerId)
            return {
              peerId: peer.peerId,
              peerType: peer.peerType,
              tools: peer.capabilities.filter(cap => cap.startsWith('tool:')).map(cap => stripCapabilityPrefix(cap)),
              actions: getExtensionActions(peer.peerId),
              filePath: peerTile?.filePath,
              label: peerTile?.label,
            }
          })
          return (
            <LazyExtensionTile
              tileId={tile.id}
              extType={tile.type}
              width={tile.width}
              height={tile.height}
              workspaceId={workspace?.id ?? ''}
              workspacePath={workspace?.path ?? ''}
              isInteracting={isTileInteracting}
              connectedPeers={extensionPeers}
              onCreateTile={(type, opts) => onAddTile(
                type as TileType,
                opts?.filePath,
                opts?.x !== undefined && opts?.y !== undefined ? { x: opts.x, y: opts.y } : undefined,
                { hideTitlebar: opts?.hideTitlebar, hideNavbar: opts?.hideNavbar },
              ) ?? null}
              onActionsChanged={onExtensionActionsChanged}
            />
          )
        }
        return null
    }
  }, [
    workspace,
    settings,
    terminalFontFamily,
    terminalFontSize,
    onImageReplaceSource,
    onChatModePreferenceChange,
    onOpenFile,
    onOpenWorkspace,
    onAddTile,
    onExtensionActionsChanged,
    getExtensionActions,
  ])
}
