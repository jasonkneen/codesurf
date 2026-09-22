// Wire protocol between a host (Electron renderer / Swift WKWebView /
// daemon HTTP page / RN WebView) and the embedded chat-app iframe.
// Messages flow over postMessage in both directions. Host implements
// methods; chat-app calls them. Channels are server-push streams the
// chat-app subscribes to (stream chunks, bus events).

export const PROTOCOL_VERSION = 1
export const BRIDGE_NAMESPACE = 'codesurf-chat-bridge'

export type RequestMethod =
  // Send pipeline
  | 'chat.send'
  | 'chat.steer'
  | 'chat.stop'
  | 'chat.clearSession'
  | 'chat.setPermissionMode'
  | 'chat.resumeJob'
  | 'chat.loadSessionHistory'
  | 'chat.opencodeModels'
  | 'chat.openclawAgents'
  | 'chat.answerToolPermission'
  | 'chat.answerUserQuestion'
  | 'chat.selectFiles'
  // Tile / canvas state
  | 'canvas.saveTileState'
  | 'canvas.loadTileState'
  | 'canvas.getSessionState'
  | 'canvas.restoreCheckpoint'
  // Filesystem (for skills, workspace file index, recent edit context)
  | 'fs.readDir'
  | 'fs.readFile'
  // Git
  | 'git.status'
  | 'git.branches'
  | 'git.checkoutBranch'
  | 'git.createBranch'
  // Execution targets (cloud / local)
  | 'execution.listHosts'
  | 'execution.resolveTarget'
  // Workspace
  | 'workspace.openFolder'
  | 'workspace.addProjectFolder'
  // Extensions / surfaces
  | 'extensions.invoke'
  | 'extensions.getSettings'
  | 'extensions.setSettings'
  // System
  | 'system.daemonSummary'
  | 'tileContext.getAll'
  | 'transcribe.run'
  | 'window.openMiniChat'
  // Bus pub
  | 'bus.publish'
  // Bridge meta
  | 'bridge.handshake'

export type ChannelName =
  | `stream:${string}`              // stream:${tileId} → stream chunks
  | `bus:${string}:${string}`       // bus:${channel}:${subscriberId}

export interface BridgeRequest {
  kind: 'request'
  id: string
  method: RequestMethod
  params?: unknown
}

export interface BridgeResponseOk {
  kind: 'response'
  id: string
  ok: true
  value: unknown
}

export interface BridgeResponseErr {
  kind: 'response'
  id: string
  ok: false
  error: string
}

export interface BridgeEvent {
  kind: 'event'
  channel: ChannelName
  payload: unknown
}

export interface BridgeSubscribe {
  kind: 'subscribe'
  channel: ChannelName
}

export interface BridgeUnsubscribe {
  kind: 'unsubscribe'
  channel: ChannelName
}

// Sent host → chat once at mount, and again whenever they change.
// Carries the original Props that V1 ChatTile receives, plus theme/font
// tokens so the chat-app can render with host styling without coupling
// to the host's React tree.
export interface BridgeContext {
  kind: 'context'
  protocolVersion: number
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  reloadToken: number
  isConnected?: boolean
  isAutoConnected?: boolean
  connectedPeers?: unknown[]   // DiscoveryPeer[] — opaque to bridge
  settings?: unknown            // AppSettings — opaque to bridge
  theme: Record<string, string> // CSS variable map
  fonts: Record<string, string | number>
}

// Chat → host once on mount, before requesting handshake.
export interface BridgeReady {
  kind: 'ready'
  protocolVersion: number
}

export type BridgeMessage =
  | BridgeRequest
  | BridgeResponseOk
  | BridgeResponseErr
  | BridgeEvent
  | BridgeSubscribe
  | BridgeUnsubscribe
  | BridgeContext
  | BridgeReady

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'request'
    || kind === 'response'
    || kind === 'event'
    || kind === 'subscribe'
    || kind === 'unsubscribe'
    || kind === 'context'
    || kind === 'ready'
}

export function withNamespace<T extends BridgeMessage>(message: T): T & { __ns: typeof BRIDGE_NAMESPACE } {
  return { ...message, __ns: BRIDGE_NAMESPACE }
}

export function isNamespacedBridgeMessage(value: unknown): value is BridgeMessage & { __ns: typeof BRIDGE_NAMESPACE } {
  if (!isBridgeMessage(value)) return false
  return (value as { __ns?: unknown }).__ns === BRIDGE_NAMESPACE
}
