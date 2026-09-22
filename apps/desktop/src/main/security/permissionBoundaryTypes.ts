import type { SensitiveMediaCapability } from '../../shared/extension-sensitive-media.ts'

export type MediaAccessKind = 'microphone' | 'camera'
export type RequestedMediaType = 'audio' | 'video'

export interface FrameLike {
  readonly detached: boolean
  readonly frameTreeNodeId: number
  readonly origin: string
  readonly parent: FrameLike | null
  readonly processId: number
  readonly routingId: number
  readonly top: FrameLike | null
  readonly url: string
  executeJavaScript(code: string): Promise<unknown>
  isDestroyed(): boolean
  reload(): boolean
}

export interface FrameNavigationIdentity {
  readonly processId: number
  readonly routingId: number
}

export interface WebContentsLike {
  readonly id: number
  readonly mainFrame: FrameLike
  getType(): string
  getURL(): string
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): void
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike
  isDestroyed(): boolean
}

export interface PermissionCheckDetails {
  readonly embeddingOrigin?: string
  readonly isMainFrame: boolean
  readonly mediaType?: 'video' | 'audio' | 'unknown'
  readonly requestingUrl?: string
  readonly securityOrigin?: string
}

export interface PermissionRequestDetails {
  readonly embeddingOrigin?: string
  readonly isMainFrame: boolean
  readonly mediaTypes?: RequestedMediaType[]
  readonly requestingUrl: string
  readonly securityOrigin?: string
}

export interface DisplayMediaRequest {
  readonly frame: FrameLike | null
  readonly securityOrigin: string
  readonly videoRequested: boolean
  readonly audioRequested: boolean
  readonly userGesture: boolean
}

export interface DisplayStreams<DisplaySource> {
  video?: DisplaySource
  audio?: 'loopback'
}

export interface ExtensionPermissionDescriptor {
  readonly id: string
  readonly identity: string
  readonly name: string
  readonly enabled: boolean
  readonly declaredMedia: readonly SensitiveMediaCapability[]
  readonly declaredMediaReasons: Readonly<
    Partial<Record<SensitiveMediaCapability, string>>
  >
}

type PermissionCheckHandler = (
  webContents: WebContentsLike | null,
  permission: string,
  requestingOrigin: string,
  details: PermissionCheckDetails,
) => boolean

type PermissionRequestHandler = (
  webContents: WebContentsLike,
  permission: string,
  callback: (granted: boolean) => void,
  details: PermissionRequestDetails,
) => void

type DisplayMediaRequestHandler<DisplaySource> = (
  request: DisplayMediaRequest,
  callback: (streams: DisplayStreams<DisplaySource>) => void,
) => void

export interface PermissionSession<DisplaySource> {
  setPermissionCheckHandler(handler: PermissionCheckHandler): void
  setPermissionRequestHandler(handler: PermissionRequestHandler): void
  setDisplayMediaRequestHandler(handler: DisplayMediaRequestHandler<DisplaySource>): void
  setDevicePermissionHandler(handler: () => boolean): void
}

export interface DisplaySourceSelection<DisplaySource> {
  readonly owner: BrowserWindowLike
  readonly requester:
    | { readonly kind: 'host' }
    | {
      readonly kind: 'extension'
      readonly extension: ExtensionPermissionDescriptor
    }
  readonly sources: readonly DisplaySource[]
}

export interface PermissionBoundaryRuntime<DisplaySource> {
  readonly platform: NodeJS.Platform
  getDefaultSession(): PermissionSession<DisplaySource> | undefined
  getDirectChildFrames(webContents: WebContentsLike): readonly FrameLike[]
  getDisplaySources(): Promise<DisplaySource[]>
  getExtensionPermission(extensionId: string): ExtensionPermissionDescriptor | undefined
  getDirectChildFrame(
    webContents: WebContentsLike,
    url: string,
    origin: string,
  ): FrameLike | undefined
  getOwnerWindow(webContents: WebContentsLike): BrowserWindowLike | undefined
  getSession(webContents: WebContentsLike): PermissionSession<DisplaySource>
  getWebContentsForFrame(frame: FrameLike): WebContentsLike | undefined
  hasExtensionConsent(
    extensionId: string,
    extensionIdentity: string,
    kind: SensitiveMediaCapability,
  ): boolean
  onSessionCreated(listener: (session: PermissionSession<DisplaySource>) => void): void
  onWebContentsCreated(listener: (webContents: WebContentsLike) => void): void
  onWebContentsNavigation(
    webContents: WebContentsLike,
    listener: (frame: FrameNavigationIdentity | undefined) => void,
  ): void
  requestExtensionConsent(
    extension: ExtensionPermissionDescriptor,
    kind: SensitiveMediaCapability,
    owner: BrowserWindowLike,
  ): Promise<boolean>
  requestMediaAccess(kind: MediaAccessKind): Promise<boolean>
  selectDisplaySource(selection: DisplaySourceSelection<DisplaySource>): Promise<DisplaySource | undefined>
  warn(message: string, error?: unknown): void
  whenReady(): Promise<void>
}

export interface PermissionBoundaryOptions {
  readonly developmentRendererUrl?: string
  readonly productionRendererUrl: string
}

export interface PermissionBoundary<DisplaySource> {
  readonly ready: Promise<void>
  clearExtensionGrants(extensionId: string): void
  installSession(session: PermissionSession<DisplaySource>): void
  registerAppWindow(window: BrowserWindowLike): void
  terminateExtensionMediaFrames(extensionId: string): Promise<void>
}
