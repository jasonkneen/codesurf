import { isValidExtensionId } from '../extensions/identity.ts'
import {
  isExtensionMediaIdentity,
  type SensitiveMediaCapability,
} from '../../shared/extension-sensitive-media.ts'
import type {
  BrowserWindowLike,
  DisplayMediaRequest,
  ExtensionPermissionDescriptor,
  FrameLike,
  FrameNavigationIdentity,
  MediaAccessKind,
  PermissionBoundary,
  PermissionBoundaryOptions,
  PermissionBoundaryRuntime,
  PermissionCheckDetails,
  PermissionRequestDetails,
  PermissionSession,
  RequestedMediaType,
  WebContentsLike,
} from './permissionBoundaryTypes.ts'

export type {
  BrowserWindowLike,
  DisplayMediaRequest,
  DisplaySourceSelection,
  DisplayStreams,
  ExtensionPermissionDescriptor,
  FrameLike,
  FrameNavigationIdentity,
  MediaAccessKind,
  PermissionBoundary,
  PermissionBoundaryOptions,
  PermissionBoundaryRuntime,
  PermissionCheckDetails,
  PermissionRequestDetails,
  PermissionSession,
  RequestedMediaType,
  WebContentsLike,
} from './permissionBoundaryTypes.ts'

type AllowedRenderer = {
  readonly fileUrl: boolean
  readonly origin: string
  readonly url: URL
}

type Principal = {
  readonly frameKey: string
  readonly key: string
  readonly kind: 'app' | 'extension'
  readonly owner: BrowserWindowLike
  readonly extension?: ExtensionPermissionDescriptor
}

type NavigationEpoch = {
  readonly contents: number
  readonly frame: number
  readonly frameKey: string
}

type NavigationEpochState = {
  contents: number
  readonly frames: Map<string, number>
}

const boundariesByRuntime = new WeakMap<object, PermissionBoundary<unknown>>()

function getAllowedRenderer(options: PermissionBoundaryOptions): AllowedRenderer {
  const url = new URL(options.developmentRendererUrl ?? options.productionRendererUrl)
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
    throw new Error(`Unsupported renderer URL protocol: ${url.protocol}`)
  }
  return { fileUrl: url.protocol === 'file:', origin: url.origin, url }
}

function sameFrame(left: FrameLike | null | undefined, right: FrameLike | null | undefined): boolean {
  return Boolean(left && right
    && left.frameTreeNodeId === right.frameTreeNodeId
    && left.processId === right.processId
    && left.routingId === right.routingId)
}

function frameKey(frame: Pick<FrameLike, 'processId' | 'routingId'>): string {
  return `${frame.processId}:${frame.routingId}`
}

function once<T>(callback: (value: T) => void): (value: T) => void {
  let called = false
  return value => {
    if (called) return
    called = true
    callback(value)
  }
}

function getExtensionLocation(rawUrl: string | undefined): {
  readonly id: string
  readonly frameOrigin: string
  readonly securityOrigin: string
} | undefined {
  if (!rawUrl) return undefined
  try {
    const url = new URL(rawUrl)
    const id = url.hostname
    if (
      url.protocol !== 'codesurf-ext:'
      || !isValidExtensionId(id)
      || url.host !== id
      || url.username
      || url.password
      || url.port
    ) {
      return undefined
    }
    return {
      id,
      frameOrigin: `codesurf-ext://${id}`,
      securityOrigin: `codesurf-ext://${id}/`,
    }
  } catch {
    return undefined
  }
}

function mediaKind(type: RequestedMediaType): MediaAccessKind {
  return type === 'audio' ? 'microphone' : 'camera'
}

export function createPermissionBoundary<DisplaySource>(
  runtime: PermissionBoundaryRuntime<DisplaySource>,
  options: PermissionBoundaryOptions,
): PermissionBoundary<DisplaySource> {
  const cached = boundariesByRuntime.get(runtime as object)
  if (cached) return cached as PermissionBoundary<DisplaySource>

  const allowedRenderer = getAllowedRenderer(options)
  const installedSessions = new WeakSet<object>()
  const registeredContents = new Set<WebContentsLike>()
  const trustedOwners = new WeakMap<object, BrowserWindowLike>()
  const grants = new WeakMap<object, Map<string, Set<SensitiveMediaCapability>>>()
  const navigationEpochs = new WeakMap<object, NavigationEpochState>()

  const getNavigationState = (webContents: WebContentsLike): NavigationEpochState => {
    let state = navigationEpochs.get(webContents as object)
    if (!state) {
      state = { contents: 0, frames: new Map() }
      navigationEpochs.set(webContents as object, state)
    }
    return state
  }

  const captureNavigationEpoch = (
    webContents: WebContentsLike,
    principal: Principal,
  ): NavigationEpoch => {
    const state = getNavigationState(webContents)
    return {
      contents: state.contents,
      frame: state.frames.get(principal.frameKey) ?? 0,
      frameKey: principal.frameKey,
    }
  }

  const isNavigationEpochCurrent = (
    webContents: WebContentsLike,
    principal: Principal,
    epoch: NavigationEpoch,
  ): boolean => {
    const state = getNavigationState(webContents)
    return principal.frameKey === epoch.frameKey
      && state.contents === epoch.contents
      && (state.frames.get(epoch.frameKey) ?? 0) === epoch.frame
  }

  const isAllowedUrl = (rawUrl: string | undefined): boolean => {
    if (!rawUrl) return false
    try {
      const candidate = new URL(rawUrl)
      if (allowedRenderer.fileUrl) {
        const expected = new URL(allowedRenderer.url.href)
        candidate.search = ''
        candidate.hash = ''
        expected.search = ''
        expected.hash = ''
        return candidate.href === expected.href
      }
      return candidate.origin === allowedRenderer.origin
        && candidate.username === allowedRenderer.url.username
        && candidate.password === allowedRenderer.url.password
        && candidate.pathname === allowedRenderer.url.pathname
    } catch {
      return false
    }
  }

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return false
    if (allowedRenderer.fileUrl) {
      return origin === 'file://' || origin === 'file:///' || origin === 'null'
    }
    return origin === allowedRenderer.origin
  }

  const getTrustedOwner = (
    session: PermissionSession<DisplaySource>,
    webContents: WebContentsLike | null | undefined,
  ): BrowserWindowLike | undefined => {
    if (!webContents || webContents.isDestroyed() || webContents.getType() !== 'window') return
    if (runtime.getSession(webContents) !== session) return
    const owner = trustedOwners.get(webContents as object)
    if (
      !owner
      || owner.isDestroyed()
      || owner.webContents !== webContents
      || runtime.getOwnerWindow(webContents) !== owner
    ) return
    const frame = webContents.mainFrame
    if (
      frame.isDestroyed()
      || frame.detached
      || frame.parent !== null
      || !sameFrame(frame, frame.top)
      || !isAllowedUrl(webContents.getURL())
      || !isAllowedUrl(frame.url)
      || !isAllowedOrigin(frame.origin)
    ) return
    return owner
  }

  const getPrincipal = (
    session: PermissionSession<DisplaySource>,
    webContents: WebContentsLike | null | undefined,
    details: PermissionCheckDetails | PermissionRequestDetails,
    requestingOrigin?: string,
  ): Principal | undefined => {
    if (!webContents) return
    const owner = getTrustedOwner(session, webContents)
    if (!owner) return
    if (details.isMainFrame === true) {
      const allowedRequest = isAllowedUrl(details.requestingUrl)
        || (!details.requestingUrl && isAllowedUrl(details.embeddingOrigin))
      const emptyFileOrigin = allowedRenderer.fileUrl
        && requestingOrigin === ''
        && isAllowedUrl(details.embeddingOrigin)
      if (
        !allowedRequest
        || (requestingOrigin !== undefined
          && !emptyFileOrigin
          && !isAllowedOrigin(requestingOrigin))
        || (details.securityOrigin !== undefined
          && !isAllowedOrigin(details.securityOrigin))
      ) return
      const mainFrameKey = frameKey(webContents.mainFrame)
      return {
        frameKey: mainFrameKey,
        key: `app:${allowedRenderer.url.href}:${mainFrameKey}`,
        kind: 'app',
        owner,
      }
    }

    const location = getExtensionLocation(details.requestingUrl)
    if (
      details.isMainFrame !== false
      || !location
      || (requestingOrigin === undefined
        ? details.securityOrigin !== location.securityOrigin
        : requestingOrigin !== location.securityOrigin
          || (details.securityOrigin !== undefined
            && details.securityOrigin !== location.securityOrigin))
      || (details.embeddingOrigin !== undefined
        && !isAllowedOrigin(details.embeddingOrigin)
        && !isAllowedUrl(details.embeddingOrigin))
    ) return
    const childFrame = runtime.getDirectChildFrame(
        webContents,
        details.requestingUrl ?? '',
        location.frameOrigin,
      )
    if (!childFrame) return
    const extension = runtime.getExtensionPermission(location.id)
    if (
      !extension
      || extension.id !== location.id
      || !isExtensionMediaIdentity(extension.identity)
      || !extension.enabled
    ) return
    const childFrameKey = frameKey(childFrame)
    return {
      frameKey: childFrameKey,
      key: `extension:${extension.id}:${extension.identity}:${location.frameOrigin}:${childFrameKey}`,
      kind: 'extension',
      owner,
      extension,
    }
  }

  const isAuthorized = (
    principal: Principal,
    kind: SensitiveMediaCapability,
  ): boolean => {
    if (principal.kind === 'app') return true
    const id = principal.extension?.id
    if (!id) return false
    const current = runtime.getExtensionPermission(id)
    return Boolean(
      current
      && current.id === id
      && isExtensionMediaIdentity(current.identity)
      && current.identity === principal.extension?.identity
      && current.enabled
      && current.declaredMedia.includes(kind)
      && runtime.hasExtensionConsent(id, current.identity, kind),
    )
  }

  const hasGrant = (
    webContents: WebContentsLike,
    principal: Principal,
    kind: SensitiveMediaCapability,
  ): boolean => grants.get(webContents as object)?.get(principal.key)?.has(kind) === true

  const addGrants = (
    webContents: WebContentsLike,
    principal: Principal,
    kinds: readonly SensitiveMediaCapability[],
  ): void => {
    let byPrincipal = grants.get(webContents as object)
    if (!byPrincipal) {
      byPrincipal = new Map()
      grants.set(webContents as object, byPrincipal)
    }
    let granted = byPrincipal.get(principal.key)
    if (!granted) {
      granted = new Set()
      byPrincipal.set(principal.key, granted)
    }
    for (const kind of kinds) granted.add(kind)
  }

  const authorizeExtension = async (
    principal: Principal,
    kinds: readonly SensitiveMediaCapability[],
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    if (principal.kind === 'app') return isCurrent()
    const extension = principal.extension
    if (!extension || kinds.some(kind => !extension.declaredMedia.includes(kind))) return false
    for (const kind of kinds) {
      if (!runtime.hasExtensionConsent(extension.id, extension.identity, kind)) {
        const allowed = await runtime.requestExtensionConsent(extension, kind, principal.owner)
        if (!isCurrent() || !allowed) return false
      }
      if (!isCurrent() || !isAuthorized(principal, kind)) return false
    }
    return isCurrent()
  }

  const getDisplayPrincipal = (
    session: PermissionSession<DisplaySource>,
    request: DisplayMediaRequest,
  ): { principal: Principal; webContents: WebContentsLike } | undefined => {
    const frame = request.frame
    if (!frame || frame.isDestroyed() || frame.detached) return
    const webContents = runtime.getWebContentsForFrame(frame)
    const owner = getTrustedOwner(session, webContents)
    if (!webContents || !owner) return
    if (
      sameFrame(frame, webContents.mainFrame)
      && frame.parent === null
      && sameFrame(frame, frame.top)
      && isAllowedUrl(frame.url)
      && isAllowedOrigin(frame.origin)
      && isAllowedOrigin(request.securityOrigin)
    ) {
      return {
        principal: {
          frameKey: frameKey(frame),
          key: `app:${allowedRenderer.url.href}:${frameKey(frame)}`,
          kind: 'app',
          owner,
        },
        webContents,
      }
    }
    const location = getExtensionLocation(frame.url)
    if (
      !location
      || frame.origin !== location.frameOrigin
      || request.securityOrigin !== location.securityOrigin
      || !sameFrame(frame.parent, webContents.mainFrame)
      || !sameFrame(frame.top, webContents.mainFrame)
    ) return
    const extension = runtime.getExtensionPermission(location.id)
    if (
      !extension
      || extension.id !== location.id
      || !isExtensionMediaIdentity(extension.identity)
      || !extension.enabled
    ) return
    const extensionFrameKey = frameKey(frame)
    return {
      principal: {
        frameKey: extensionFrameKey,
        key: `extension:${extension.id}:${extension.identity}:${location.frameOrigin}:${extensionFrameKey}`,
        kind: 'extension',
        owner,
        extension,
      },
      webContents,
    }
  }

  const installSession = (session: PermissionSession<DisplaySource>): void => {
    if (installedSessions.has(session as object)) return
    installedSessions.add(session as object)

    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const principal = getPrincipal(session, webContents, details, requestingOrigin)
      if (!principal || !webContents) return false
      if (permission === 'clipboard-sanitized-write') return principal.kind === 'app'
      if (permission === 'display-capture') {
        return isAuthorized(principal, 'display-capture')
          && hasGrant(webContents, principal, 'display-capture')
      }
      if (permission !== 'media') return false
      const kind = details.mediaType === 'audio'
        ? 'microphone'
        : details.mediaType === 'video'
          ? 'camera'
          : undefined
      return Boolean(kind && isAuthorized(principal, kind) && hasGrant(webContents, principal, kind))
    })

    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const finish = once(callback)
      const principal = getPrincipal(session, webContents, details)
      if (!principal) return finish(false)
      const navigationEpoch = captureNavigationEpoch(webContents, principal)
      const getCurrentPrincipal = (): Principal | undefined => {
        const current = getPrincipal(session, webContents, details)
        return current?.key === principal.key
          && isNavigationEpochCurrent(webContents, current, navigationEpoch)
          ? current
          : undefined
      }
      if (permission === 'clipboard-sanitized-write') {
        return finish(principal.kind === 'app')
      }

      const displayPreflight = permission === 'display-capture'
        || (permission === 'media'
          && Array.isArray(details.mediaTypes)
          && details.mediaTypes.length === 0)
      if (displayPreflight) {
        void authorizeExtension(
          principal,
          ['display-capture'],
          () => getCurrentPrincipal() !== undefined,
        ).then(allowed => {
          const current = getCurrentPrincipal()
          const granted = allowed
            && current !== undefined
            && isAuthorized(current, 'display-capture')
          if (granted) addGrants(webContents, current, ['display-capture'])
          finish(granted)
        }).catch(error => {
          runtime.warn('Display permission preflight failed', error)
          finish(false)
        })
        return
      }
      if (permission !== 'media') return finish(false)
      const requestedTypes = [...new Set(details.mediaTypes ?? [])]
      if (
        requestedTypes.length === 0
        || requestedTypes.some(type => type !== 'audio' && type !== 'video')
      ) return finish(false)
      const requestedKinds = requestedTypes.map(mediaKind)

      void authorizeExtension(
        principal,
        requestedKinds,
        () => getCurrentPrincipal() !== undefined,
      ).then(async consented => {
        if (!consented || !getCurrentPrincipal()) return false
        const osResults = await Promise.all(
          requestedKinds.map(kind => runtime.requestMediaAccess(kind)),
        )
        return Boolean(getCurrentPrincipal()) && osResults.every(Boolean)
      }).then(allowed => {
        const current = getCurrentPrincipal()
        const granted = allowed
          && current !== undefined
          && requestedKinds.every(kind => isAuthorized(current, kind))
        if (granted) addGrants(webContents, current, requestedKinds)
        finish(granted)
      }).catch(error => {
        runtime.warn('Media permission request failed', error)
        finish(false)
      })
    })

    session.setDisplayMediaRequestHandler((request, callback) => {
      const finish = once(callback)
      const initial = getDisplayPrincipal(session, request)
      if (
        !initial
        || request.userGesture !== true
        || request.videoRequested !== true
        || (request.audioRequested && runtime.platform !== 'win32')
        || !isAuthorized(initial.principal, 'display-capture')
        || !hasGrant(initial.webContents, initial.principal, 'display-capture')
      ) return finish({})
      const navigationEpoch = captureNavigationEpoch(
        initial.webContents,
        initial.principal,
      )
      const getCurrentPrincipal = (): Principal | undefined => {
        const current = getDisplayPrincipal(session, request)
        return current
          && current.webContents === initial.webContents
          && current.principal.key === initial.principal.key
          && isNavigationEpochCurrent(
            current.webContents,
            current.principal,
            navigationEpoch,
          )
          ? current.principal
          : undefined
      }

      void runtime.getDisplaySources().then(async sources => {
        if (!getCurrentPrincipal()) return
        if (sources.length === 0) return
        const selected = await runtime.selectDisplaySource({
          owner: initial.principal.owner,
          requester: initial.principal.kind === 'extension' && initial.principal.extension
            ? { kind: 'extension', extension: initial.principal.extension }
            : { kind: 'host' },
          sources,
        })
        return getCurrentPrincipal() && selected && sources.includes(selected)
          ? selected
          : undefined
      }).then(selected => {
        const current = getCurrentPrincipal()
        const stillAuthorized = current
          && isAuthorized(current, 'display-capture')
          && hasGrant(initial.webContents, current, 'display-capture')
        if (!selected || !stillAuthorized) return finish({})
        finish({
          video: selected,
          ...(request.audioRequested ? { audio: 'loopback' as const } : {}),
        })
      }).catch(error => {
        runtime.warn('Display media request failed', error)
        finish({})
      })
    })

    session.setDevicePermissionHandler(() => false)
  }

  const registerAppWindow = (window: BrowserWindowLike): void => {
    const webContents = window.webContents
    if (
      window.isDestroyed()
      || webContents.isDestroyed()
      || webContents.getType() !== 'window'
      || runtime.getOwnerWindow(webContents) !== window
    ) return
    installSession(runtime.getSession(webContents))
    trustedOwners.set(webContents as object, window)
    if (registeredContents.has(webContents)) return
    registeredContents.add(webContents)
    runtime.onWebContentsNavigation(webContents, (frame: FrameNavigationIdentity | undefined) => {
      const state = getNavigationState(webContents)
      state.contents += 1
      if (frame) {
        const key = frameKey(frame)
        state.frames.set(key, (state.frames.get(key) ?? 0) + 1)
      }
      grants.delete(webContents as object)
    })
    webContents.once('destroyed', () => {
      registeredContents.delete(webContents)
      trustedOwners.delete(webContents as object)
      grants.delete(webContents as object)
      navigationEpochs.delete(webContents as object)
    })
  }

  const clearExtensionGrants = (extensionId: string): void => {
    const prefix = `extension:${extensionId}:`
    for (const webContents of registeredContents) {
      const byPrincipal = grants.get(webContents as object)
      if (!byPrincipal) continue
      for (const key of byPrincipal.keys()) {
        if (key.startsWith(prefix)) byPrincipal.delete(key)
      }
    }
  }

  const terminateExtensionMediaFrames = async (extensionId: string): Promise<void> => {
    if (!isValidExtensionId(extensionId)) return
    const expectedOrigin = `codesurf-ext://${extensionId}`
    const fallbackNavigations: Promise<unknown>[] = []
    for (const webContents of registeredContents) {
      const session = runtime.getSession(webContents)
      if (!getTrustedOwner(session, webContents)) continue
      let frames: readonly FrameLike[]
      try {
        frames = runtime.getDirectChildFrames(webContents)
      } catch (error) {
        runtime.warn(`Unable to enumerate media frames for extension ${extensionId}`, error)
        continue
      }
      for (const frame of frames) {
        const location = getExtensionLocation(frame.url)
        if (
          frame.isDestroyed()
          || frame.detached
          || !sameFrame(frame.parent, webContents.mainFrame)
          || !sameFrame(frame.top, webContents.mainFrame)
          || frame.origin !== expectedOrigin
          || location?.id !== extensionId
          || location.frameOrigin !== expectedOrigin
        ) continue
        const navigateAway = (): void => {
          try {
            fallbackNavigations.push(
              frame.executeJavaScript('window.location.replace("about:blank")'),
            )
          } catch (error) {
            runtime.warn(
              `Unable to navigate active media frame for extension ${extensionId}`,
              error,
            )
          }
        }
        try {
          if (!frame.reload()) navigateAway()
        } catch (error) {
          runtime.warn(`Unable to reload active media frame for extension ${extensionId}`, error)
          navigateAway()
        }
      }
    }
    const fallbackResults = await Promise.allSettled(fallbackNavigations)
    for (const result of fallbackResults) {
      if (result.status === 'rejected') {
        runtime.warn(
          `Unable to navigate active media frame for extension ${extensionId}`,
          result.reason,
        )
      }
    }
  }

  runtime.onSessionCreated(installSession)
  runtime.onWebContentsCreated(webContents => installSession(runtime.getSession(webContents)))
  const ready = runtime.whenReady().then(() => {
    const defaultSession = runtime.getDefaultSession()
    if (defaultSession) installSession(defaultSession)
  }).catch(error => {
    runtime.warn('Unable to install default-session permission handlers', error)
  })
  const boundary: PermissionBoundary<DisplaySource> = {
    clearExtensionGrants,
    installSession,
    ready,
    registerAppWindow,
    terminateExtensionMediaFrames,
  }
  boundariesByRuntime.set(runtime as object, boundary as PermissionBoundary<unknown>)
  return boundary
}
