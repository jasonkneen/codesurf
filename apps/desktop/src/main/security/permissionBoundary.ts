import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  session,
  systemPreferences,
  webContents as electronWebContents,
  type DesktopCapturerSource,
  type Session,
  type WebContents,
  type WebFrameMain,
} from 'electron'
import { pathToFileURL } from 'node:url'
import {
  createPermissionBoundary,
  type BrowserWindowLike,
  type ExtensionPermissionDescriptor,
  type FrameLike,
  type PermissionBoundary,
  type PermissionBoundaryRuntime,
  type PermissionSession,
  type WebContentsLike,
} from './permissionBoundaryCore'
import {
  ExtensionMediaConsentManager,
  ExtensionMediaConsentStore,
} from './extensionMediaConsent'
import {
  EXTENSION_MEDIA_DIALOG_TEXT_BYTES,
  getSafeDisplaySourceDialogChoices,
  getSafeExtensionMediaAttribution,
  sanitizeExtensionMediaDialogText,
  type SensitiveMediaCapability,
} from '../../shared/extension-sensitive-media'

export interface ElectronPermissionBoundaryOptions {
  readonly developmentRendererUrl?: string
  readonly productionRendererFilePath: string
}

export interface ElectronPermissionBoundary {
  readonly ready: Promise<void>
  revokeExtensionMedia(extensionId: string): Promise<void>
  registerAppWindow(window: BrowserWindow): void
  setExtensionAuthorizer(authorizer: ElectronExtensionMediaAuthorizer): void
}

export interface ElectronExtensionMediaAuthorizer {
  getExtensionMediaPermission(extensionId: string): ExtensionPermissionDescriptor | undefined
}

const MAX_DISPLAY_SOURCE_CHOICES = 20
let installedBoundary: ElectronPermissionBoundary | undefined

function asFrame(frame: WebFrameMain): FrameLike {
  return frame as unknown as FrameLike
}

function asWebContents(contents: WebContents): WebContentsLike {
  return contents as unknown as WebContentsLike
}

function asBrowserWindow(window: BrowserWindow): BrowserWindowLike {
  return window as unknown as BrowserWindowLike
}

function sameElectronFrame(
  left: WebFrameMain | null | undefined,
  right: WebFrameMain | null | undefined,
): boolean {
  return Boolean(left && right
    && left.frameTreeNodeId === right.frameTreeNodeId
    && left.processId === right.processId
    && left.routingId === right.routingId)
}

export function installElectronPermissionBoundary(
  options: ElectronPermissionBoundaryOptions,
): ElectronPermissionBoundary {
  if (installedBoundary) return installedBoundary

  let extensionAuthorizer: ElectronExtensionMediaAuthorizer | undefined
  const consentManager = new ExtensionMediaConsentManager(
    new ExtensionMediaConsentStore(),
    async request => {
      const owner = request.owner as BrowserWindow | undefined
      if (!owner || owner.isDestroyed()) return false
      const attribution = getSafeExtensionMediaAttribution(
        request.extensionId,
        request.extensionName,
        request.reason,
      )
      const kindLabel: Record<SensitiveMediaCapability, string> = {
        microphone: 'microphone',
        camera: 'camera',
        'display-capture': 'screen or window',
      }
      const message = sanitizeExtensionMediaDialogText(
        `${attribution.name} wants to use your ${kindLabel[request.kind]}`,
        `${attribution.id} wants to use this media capability`,
        EXTENSION_MEDIA_DIALOG_TEXT_BYTES.message,
      )
      const detail = sanitizeExtensionMediaDialogText(
        [
          attribution.reason ? `Reason: ${attribution.reason}.` : '',
          `Extension ID: ${attribution.id}.`,
          'You can revoke access by disabling the extension.',
        ].filter(Boolean).join(' '),
        `Extension ID: ${attribution.id}.`,
        EXTENSION_MEDIA_DIALOG_TEXT_BYTES.detail,
      )
      const result = await dialog.showMessageBox(owner, {
        type: 'question',
        title: 'Extension media permission',
        message,
        detail,
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0
    },
  )
  const sessionAdapters = new WeakMap<Session, PermissionSession<DesktopCapturerSource>>()
  const adaptSession = (electronSession: Session): PermissionSession<DesktopCapturerSource> => {
    const cached = sessionAdapters.get(electronSession)
    if (cached) return cached

    const adapted: PermissionSession<DesktopCapturerSource> = {
      setPermissionCheckHandler(handler): void {
        electronSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
          return handler(
            contents ? asWebContents(contents) : null,
            permission,
            requestingOrigin,
            details,
          )
        })
      },
      setPermissionRequestHandler(handler): void {
        electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
          handler(
            asWebContents(contents),
            permission,
            callback,
            details,
          )
        })
      },
      setDisplayMediaRequestHandler(handler): void {
        electronSession.setDisplayMediaRequestHandler((request, callback) => {
          handler(
            {
              ...request,
              frame: request.frame ? asFrame(request.frame) : null,
            },
            callback,
          )
        })
      },
      setDevicePermissionHandler(handler): void {
        electronSession.setDevicePermissionHandler(() => handler())
      },
    }
    sessionAdapters.set(electronSession, adapted)
    return adapted
  }

  const runtime: PermissionBoundaryRuntime<DesktopCapturerSource> = {
    platform: process.platform,
    whenReady: () => app.whenReady(),
    getDefaultSession: () => adaptSession(session.defaultSession),
    getDirectChildFrames: contents => {
      const electronContents = contents as unknown as WebContents
      if (electronContents.isDestroyed()) return []
      return electronContents.mainFrame.frames.map(asFrame)
    },
    getDisplaySources: () => desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: { width: 0, height: 0 },
    }),
    getOwnerWindow: contents => {
      const owner = BrowserWindow.fromWebContents(contents as unknown as WebContents)
      return owner ? asBrowserWindow(owner) : undefined
    },
    getSession: contents => {
      return adaptSession((contents as unknown as WebContents).session)
    },
    getExtensionPermission: extensionId => {
      return extensionAuthorizer?.getExtensionMediaPermission(extensionId)
    },
    getDirectChildFrame: (contents, url, origin) => {
      const electronContents = contents as unknown as WebContents
      const mainFrame = electronContents.mainFrame
      let match: WebFrameMain | undefined
      for (const frame of mainFrame.framesInSubtree) {
        const matches = !frame.isDestroyed()
          && !frame.detached
          && frame.url === url
          && frame.origin === origin
          && sameElectronFrame(frame.parent, mainFrame)
          && sameElectronFrame(frame.top, mainFrame)
        if (!matches) continue
        if (match) return undefined
        match = frame
      }
      return match ? asFrame(match) : undefined
    },
    hasExtensionConsent: (extensionId, extensionIdentity, kind) => {
      return consentManager.hasConsent(extensionId, extensionIdentity, kind)
    },
    getWebContentsForFrame: frame => {
      const contents = electronWebContents.fromFrame(frame as unknown as WebFrameMain)
      return contents ? asWebContents(contents) : undefined
    },
    onSessionCreated: listener => {
      app.on('session-created', createdSession => {
        listener(adaptSession(createdSession))
      })
    },
    onWebContentsCreated: listener => {
      app.on('web-contents-created', (_event, contents) => {
        listener(asWebContents(contents))
      })
    },
    onWebContentsNavigation: (contents, listener) => {
      const electronContents = contents as unknown as WebContents
      electronContents.on(
        'did-frame-navigate',
        (_event, _url, _responseCode, _statusText, _isMainFrame, processId, routingId) => {
          listener({ processId, routingId })
        },
      )
      electronContents.on(
        'did-navigate-in-page',
        (_event, _url, _isMainFrame, processId, routingId) => {
          listener({ processId, routingId })
        },
      )
    },
    requestExtensionConsent: (extension, kind, owner) => {
      return consentManager.requestConsent({
        extensionId: extension.id,
        extensionIdentity: extension.identity,
        extensionName: extension.name,
        kind,
        owner: owner as unknown as BrowserWindow,
        reason: extension.declaredMediaReasons[kind],
      })
    },
    requestMediaAccess: async kind => {
      if (process.platform !== 'darwin') return true
      try {
        return await systemPreferences.askForMediaAccess(kind)
      } catch (error) {
        console.warn(`[Permissions] Failed requesting ${kind} access:`, error)
        return false
      }
    },
    selectDisplaySource: async ({ owner, requester, sources }) => {
      const choices = getSafeDisplaySourceDialogChoices(
        sources,
        MAX_DISPLAY_SOURCE_CHOICES,
      )
      if (choices.length === 0) return undefined
      const attribution = requester.kind === 'extension'
        ? getSafeExtensionMediaAttribution(
          requester.extension.id,
          requester.extension.name,
          requester.extension.declaredMediaReasons['display-capture'],
        )
        : undefined
      const message = attribution
        ? sanitizeExtensionMediaDialogText(
          `Choose what ${attribution.name} may share`,
          `Choose what ${attribution.id} may share`,
          EXTENSION_MEDIA_DIALOG_TEXT_BYTES.message,
        )
        : 'Choose what CodeSurf may share'
      const detail = attribution
        ? sanitizeExtensionMediaDialogText(
          [
            attribution.reason ? `Reason: ${attribution.reason}.` : '',
            `Extension ID: ${attribution.id}.`,
            sources.length > choices.length
              ? `Showing the first ${choices.length} available sources.`
              : 'Nothing is shared until you choose a source.',
          ].filter(Boolean).join(' '),
          `Extension ID: ${attribution.id}.`,
          EXTENSION_MEDIA_DIALOG_TEXT_BYTES.detail,
        )
        : sources.length > choices.length
          ? `Showing the first ${choices.length} available sources.`
          : 'Nothing is shared until you choose a source.'
      const cancelId = choices.length
      const result = await dialog.showMessageBox(
        owner as unknown as BrowserWindow,
        {
          type: 'question',
          title: 'Share a screen or window',
          message,
          detail,
          buttons: [
            ...choices.map(choice => choice.label),
            'Cancel',
          ],
          defaultId: cancelId,
          cancelId,
          noLink: true,
        },
      )
      return result.response >= 0 && result.response < choices.length
        ? choices[result.response]?.source
        : undefined
    },
    warn: (message, error) => {
      console.warn(`[Permissions] ${message}:`, error)
    },
  }

  const boundary: PermissionBoundary<DesktopCapturerSource> = createPermissionBoundary(
    runtime,
    {
      developmentRendererUrl: options.developmentRendererUrl,
      productionRendererUrl: pathToFileURL(options.productionRendererFilePath).href,
    },
  )

  installedBoundary = {
    ready: Promise.all([boundary.ready, consentManager.ready]).then(() => undefined),
    revokeExtensionMedia: async extensionId => {
      boundary.clearExtensionGrants(extensionId)
      const revokeConsent = consentManager.revokeExtension(extensionId)
      const terminateFrames = boundary.terminateExtensionMediaFrames(extensionId)
      await Promise.all([revokeConsent, terminateFrames])
    },
    registerAppWindow: window => boundary.registerAppWindow(asBrowserWindow(window)),
    setExtensionAuthorizer: authorizer => {
      extensionAuthorizer = authorizer
    },
  }
  return installedBoundary
}
