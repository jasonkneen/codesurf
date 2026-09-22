import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createPermissionBoundary,
  type BrowserWindowLike,
  type DisplayMediaRequest,
  type DisplaySourceSelection,
  type ExtensionPermissionDescriptor,
  type FrameLike,
  type FrameNavigationIdentity,
  type PermissionBoundaryRuntime,
  type PermissionRequestDetails,
  type PermissionSession,
  type WebContentsLike,
} from '../../src/main/security/permissionBoundaryCore.ts'

export type DisplaySource = { id: string; name: string }

export class FakeFrame implements FrameLike {
  detached = false
  executedScripts: string[] = []
  reloadCount = 0
  reloadResult = true
  parent: FrameLike | null = null
  top: FrameLike = this
  url: string
  origin: string
  frameTreeNodeId: number
  processId: number
  routingId: number

  constructor(
    url: string,
    origin: string,
    frameTreeNodeId = 1,
    processId = 2,
    routingId = 3,
  ) {
    this.url = url
    this.origin = origin
    this.frameTreeNodeId = frameTreeNodeId
    this.processId = processId
    this.routingId = routingId
  }

  isDestroyed(): boolean {
    return false
  }

  async executeJavaScript(code: string): Promise<unknown> {
    this.executedScripts.push(code)
  }

  reload(): boolean {
    this.reloadCount += 1
    return this.reloadResult
  }
}

export class FakeSession implements PermissionSession<DisplaySource> {
  checkHandler?: Parameters<PermissionSession<DisplaySource>['setPermissionCheckHandler']>[0]
  requestHandler?: Parameters<PermissionSession<DisplaySource>['setPermissionRequestHandler']>[0]
  displayHandler?: Parameters<PermissionSession<DisplaySource>['setDisplayMediaRequestHandler']>[0]
  deviceHandler?: Parameters<PermissionSession<DisplaySource>['setDevicePermissionHandler']>[0]
  installCounts = { check: 0, request: 0, display: 0, device: 0 }

  setPermissionCheckHandler(handler: NonNullable<typeof this.checkHandler>): void {
    this.installCounts.check += 1
    this.checkHandler = handler
  }

  setPermissionRequestHandler(handler: NonNullable<typeof this.requestHandler>): void {
    this.installCounts.request += 1
    this.requestHandler = handler
  }

  setDisplayMediaRequestHandler(handler: NonNullable<typeof this.displayHandler>): void {
    this.installCounts.display += 1
    this.displayHandler = handler
  }

  setDevicePermissionHandler(handler: NonNullable<typeof this.deviceHandler>): void {
    this.installCounts.device += 1
    this.deviceHandler = handler
  }
}

export class FakeWebContents implements WebContentsLike {
  destroyed = false
  private readonly destroyedListeners = new Set<() => void>()
  id: number
  session: FakeSession
  mainFrame: FakeFrame
  type: string

  constructor(
    id: number,
    session: FakeSession,
    mainFrame: FakeFrame,
    type = 'window',
  ) {
    this.id = id
    this.session = session
    this.mainFrame = mainFrame
    this.type = type
  }

  getType(): string {
    return this.type
  }

  getURL(): string {
    return this.mainFrame.url
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  once(event: 'destroyed', listener: () => void): void {
    if (event === 'destroyed') this.destroyedListeners.add(listener)
  }

  destroy(): void {
    this.destroyed = true
    for (const listener of this.destroyedListeners) listener()
    this.destroyedListeners.clear()
  }
}

class FakeWindow implements BrowserWindowLike {
  destroyed = false
  webContents: FakeWebContents

  constructor(webContents: FakeWebContents) {
    this.webContents = webContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

export function createHarness(options?: {
  platform?: NodeJS.Platform
  production?: boolean
  withDefaultSession?: boolean
}) {
  const devUrl = 'http://127.0.0.1:5173/'
  const productionUrl = 'file:///Applications/CodeSurf.app/renderer/index.html'
  const appUrl = options?.production ? productionUrl : devUrl
  const sessions = new Set<FakeSession>()
  const defaultSession = options?.withDefaultSession ? new FakeSession() : undefined
  const sessionListeners: Array<(session: PermissionSession<DisplaySource>) => void> = []
  const contentsListeners: Array<(contents: WebContentsLike) => void> = []
  const owners = new Map<WebContentsLike, BrowserWindowLike>()
  const frameOwners = new Map<FrameLike, WebContentsLike>()
  const navigationListeners = new Map<
    WebContentsLike,
    Set<(frame: FrameNavigationIdentity | undefined) => void>
  >()
  const extensions = new Map<string, ExtensionPermissionDescriptor>()
  const extensionConsents = new Map<string, Set<string>>()
  const extensionConsentPrompts: string[] = []
  const extensionConsentReasons: Array<string | undefined> = []
  const sources: DisplaySource[] = [
    { id: 'screen:1', name: 'Entire Screen' },
    { id: 'window:2', name: 'Editor' },
  ]
  const mediaPrompts: Array<'microphone' | 'camera'> = []
  let mediaResults: Partial<Record<'microphone' | 'camera', boolean>> = {
    microphone: true,
    camera: true,
  }
  let extensionConsentRequester: (
    extension: ExtensionPermissionDescriptor,
    kind: 'microphone' | 'camera' | 'display-capture',
  ) => Promise<boolean> = async () => true
  let mediaRequester: (kind: 'microphone' | 'camera') => Promise<boolean> = async kind => {
    return mediaResults[kind] ?? false
  }
  let selectedSource: DisplaySource | undefined = sources[1]
  let displaySelector: (
    selection: DisplaySourceSelection<DisplaySource>,
  ) => Promise<DisplaySource | undefined> = async () => selectedSource
  const displaySelections: DisplaySourceSelection<DisplaySource>[] = []
  let selectionCount = 0

  const runtime: PermissionBoundaryRuntime<DisplaySource> = {
    platform: options?.platform ?? 'darwin',
    whenReady: async () => undefined,
    getDefaultSession: () => defaultSession,
    getDirectChildFrames: contents => {
      return [...frameOwners].flatMap(([frame, owner]) => {
        return owner === contents
          && frame !== contents.mainFrame
          && frame.parent === contents.mainFrame
          ? [frame]
          : []
      })
    },
    onSessionCreated: listener => sessionListeners.push(listener),
    onWebContentsCreated: listener => contentsListeners.push(listener),
    onWebContentsNavigation: (contents, listener) => {
      let listeners = navigationListeners.get(contents)
      if (!listeners) {
        listeners = new Set()
        navigationListeners.set(contents, listeners)
      }
      listeners.add(listener)
    },
    getOwnerWindow: contents => owners.get(contents),
    getSession: contents => (contents as FakeWebContents).session,
    getWebContentsForFrame: frame => frameOwners.get(frame),
    getExtensionPermission: extensionId => extensions.get(extensionId),
    getDirectChildFrame: (contents, url, origin) => {
      let match: FrameLike | undefined
      for (const [frame, owner] of frameOwners) {
        if (
          owner === contents
          && frame !== contents.mainFrame
          && frame.url === url
          && frame.origin === origin
          && frame.parent === contents.mainFrame
          && frame.top === contents.mainFrame
        ) {
          if (match) return undefined
          match = frame
        }
      }
      return match
    },
    hasExtensionConsent: (extensionId, extensionIdentity, kind) => {
      return extensionConsents.get(`${extensionId}:${extensionIdentity}`)?.has(kind) === true
    },
    requestExtensionConsent: async (extension, kind) => {
      extensionConsentPrompts.push(`${extension.id}:${kind}`)
      extensionConsentReasons.push(extension.declaredMediaReasons[kind])
      const allowed = await extensionConsentRequester(extension, kind)
      if (!allowed) return false
      const consentKey = `${extension.id}:${extension.identity}`
      let consent = extensionConsents.get(consentKey)
      if (!consent) {
        consent = new Set()
        extensionConsents.set(consentKey, consent)
      }
      consent.add(kind)
      return true
    },
    requestMediaAccess: async kind => {
      mediaPrompts.push(kind)
      return await mediaRequester(kind)
    },
    getDisplaySources: async () => sources,
    selectDisplaySource: async selection => {
      selectionCount += 1
      displaySelections.push(selection)
      return await displaySelector(selection)
    },
    warn: () => undefined,
  }

  const boundary = createPermissionBoundary(runtime, {
    developmentRendererUrl: options?.production ? undefined : devUrl,
    productionRendererUrl: productionUrl,
  })

  const makeWindow = (url = appUrl, type = 'window') => {
    const session = new FakeSession()
    sessions.add(session)
    const parsed = new URL(url)
    const origin = parsed.protocol === 'file:' ? 'file://' : parsed.origin
    const contents = new FakeWebContents(
      sessions.size,
      session,
      new FakeFrame(url, origin, sessions.size),
      type,
    )
    const window = new FakeWindow(contents)
    owners.set(contents, window)
    frameOwners.set(contents.mainFrame, contents)
    return { session, contents, window }
  }

  return {
    appUrl,
    attachFrame: (contents: WebContentsLike, frame: FrameLike) => {
      frameOwners.set(frame, contents)
    },
    boundary,
    contentsListeners,
    defaultSession,
    displaySelections,
    extensionConsentPrompts,
    extensionConsentReasons,
    extensionConsents,
    extensions,
    makeWindow,
    mediaPrompts,
    owners,
    productionUrl,
    runtime,
    navigate: (contents: WebContentsLike, frame?: FrameLike) => {
      const identity = frame
        ? { processId: frame.processId, routingId: frame.routingId }
        : undefined
      for (const listener of navigationListeners.get(contents) ?? []) listener(identity)
    },
    sessionListeners,
    setMediaResults: (results: typeof mediaResults) => { mediaResults = results },
    setMediaRequester: (
      requester: (kind: 'microphone' | 'camera') => Promise<boolean>,
    ) => { mediaRequester = requester },
    setExtensionConsentRequester: (
      requester: (
        extension: ExtensionPermissionDescriptor,
        kind: 'microphone' | 'camera' | 'display-capture',
      ) => Promise<boolean>,
    ) => { extensionConsentRequester = requester },
    setExtension: (
      id: string,
      config?: Partial<Omit<ExtensionPermissionDescriptor, 'id'>>,
    ) => {
      extensions.set(id, {
        id,
        identity: config?.identity ?? `sha256:${createHash('sha256').update(id).digest('hex')}`,
        name: config?.name ?? id,
        enabled: config?.enabled ?? true,
        declaredMedia: config?.declaredMedia ?? [],
        declaredMediaReasons: config?.declaredMediaReasons ?? {},
      })
    },
    setExtensionConsent: (
      id: string,
      kinds: readonly ('microphone' | 'camera' | 'display-capture')[],
    ) => {
      const identity = extensions.get(id)?.identity
        ?? `sha256:${createHash('sha256').update(id).digest('hex')}`
      extensionConsents.set(`${id}:${identity}`, new Set(kinds))
    },
    setDisplaySources: (nextSources: readonly DisplaySource[]) => {
      sources.splice(0, sources.length, ...nextSources)
    },
    setDisplaySelectionIndex: (index: number | undefined) => {
      displaySelector = async selection => {
        return index === undefined ? undefined : selection.sources[index]
      }
    },
    setSelectedSource: (source: DisplaySource | undefined) => { selectedSource = source },
    setDisplaySelector: (
      selector: typeof displaySelector,
    ) => { displaySelector = selector },
    selectionCount: () => selectionCount,
    sources,
  }
}

export function mainFrameDetails(url: string) {
  const parsed = new URL(url)
  return {
    isMainFrame: true,
    requestingUrl: url,
    securityOrigin: parsed.protocol === 'file:' ? 'file://' : parsed.origin,
  }
}

export async function requestPermission(
  session: FakeSession,
  contents: FakeWebContents,
  permission: string,
  details: PermissionRequestDetails,
): Promise<boolean> {
  assert.ok(session.requestHandler)
  return await new Promise(resolve => {
    session.requestHandler?.(contents, permission, resolve, details)
  })
}

export async function requestDisplay(
  session: FakeSession,
  request: DisplayMediaRequest,
): Promise<Record<string, unknown>> {
  assert.ok(session.displayHandler)
  return await new Promise(resolve => {
    session.displayHandler?.(request, resolve)
  })
}
