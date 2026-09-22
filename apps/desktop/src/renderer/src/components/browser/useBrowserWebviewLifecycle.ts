import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { BrowserEvidenceInput } from '../../../../shared/browserEvidence'
import { isElectronHost } from '../../platform'
import { dispatchOpenLink } from '../../utils/links'
import { classifyBrowserConsoleMessage } from './browserWebviewMessages'
import { useBrowserCluso } from './useBrowserCluso'
import {
  DESKTOP_UA,
  HOMEPAGE,
  MOBILE_UA,
  createBusBridgeScript,
  getOrCreateManagedWebview,
  getWebviewParkingRoot,
  isAllowedBrowserUrl,
  isEmbeddedPreviewWebview,
  safeLoadURL,
  scheduleManagedWebviewDisposal,
  shouldInjectHostBridge,
} from './webviewManager'

/**
 * Cross-instance de-duplication for the shared `webview:new-window` channel.
 * Returns true when this event was already claimed by another listener.
 */
const POPUP_CLAIM_WINDOW_MS = 250
let lastClaimedPopup: { url: string; at: number } = { url: '', at: 0 }

function claimPopupUrl(url: string): boolean {
  const now = Date.now()
  if (url === lastClaimedPopup.url && now - lastClaimedPopup.at < POPUP_CLAIM_WINDOW_MS) return true
  lastClaimedPopup = { url, at: now }
  return false
}

export type BrowserMode = 'desktop' | 'mobile'

export interface BrowserNavigationState {
  url?: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

interface BrowserWebviewLifecycleEvents {
  onNavigation: (state: BrowserNavigationState) => void
  onLoadingChange: (isLoading: boolean) => void
  recordEvidence: (input: Omit<BrowserEvidenceInput, 'tileId'>) => void
}

interface BrowserWebviewSurfaceState {
  isVisible: boolean
  isToolbarHovered: boolean
  isAddressFocused: boolean
  isInteracting: boolean
}

interface UseBrowserWebviewLifecycleOptions {
  tileId: string
  initialUrl: string
  stateLoaded: boolean
  background: string
  surface: BrowserWebviewSurfaceState
  events: BrowserWebviewLifecycleEvents
}

export interface BrowserWebviewLifecycle {
  containerRef: RefObject<HTMLDivElement | null>
  isEmbeddedPreview: boolean
  isClusoReady: boolean
  isClusoActive: boolean
  loadUrl: (url: string) => void
  restoreUrl: (url: string) => void
  goBack: () => void
  goForward: () => void
  reload: () => boolean
  stop: () => void
  setMode: (mode: BrowserMode) => void
  toggleCluso: () => void
}

export function useBrowserWebviewLifecycle({
  tileId,
  initialUrl,
  stateLoaded,
  background,
  surface,
  events,
}: UseBrowserWebviewLifecycleOptions): BrowserWebviewLifecycle {
  const containerRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const readyRef = useRef(false)
  const mountedRef = useRef(true)
  const bridgeTokenRef = useRef(crypto.randomUUID())
  const initialUrlRef = useRef(initialUrl)
  const backgroundRef = useRef(background)
  const eventsRef = useRef(events)
  initialUrlRef.current = initialUrl
  backgroundRef.current = background
  eventsRef.current = events

  const [isEmbeddedPreview, setIsEmbeddedPreview] = useState(() => !isElectronHost())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const executeInWebview = useCallback((script: string): Promise<unknown> => {
    const webview = webviewRef.current
    if (!webview || !mountedRef.current) {
      return Promise.reject(new Error('Webview unavailable'))
    }

    if (readyRef.current) return webview.executeJavaScript(script)

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        webview.removeEventListener('dom-ready', onReady)
      }
      const onReady = () => {
        if (!mountedRef.current || !readyRef.current) {
          cleanup()
          reject(new Error('Webview became unavailable before ready'))
          return
        }
        webview.executeJavaScript(script).then(resolve).catch(reject).finally(cleanup)
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Webview ready timeout'))
      }, 5000)

      webview.addEventListener('dom-ready', onReady)
    })
  }, [])

  const isWebviewAvailable = useCallback(
    () => Boolean(webviewRef.current && readyRef.current && mountedRef.current),
    [],
  )
  const cluso = useBrowserCluso({
    executeInWebview,
    isWebviewAvailable,
  })

  useEffect(() => {
    if (!stateLoaded) return

    const container = containerRef.current
    if (!container) return

    const { webview, reused } = getOrCreateManagedWebview(
      tileId,
      initialUrlRef.current,
      backgroundRef.current,
    )
    const embeddedPreview = isEmbeddedPreviewWebview(webview)

    webviewRef.current = webview
    readyRef.current = false
    setIsEmbeddedPreview(embeddedPreview)
    webview.style.background = backgroundRef.current

    const updateNavigation = () => {
      if (webviewRef.current !== webview || !readyRef.current) return

      try {
        const url = webview.getURL()
        if (url) {
          window.electron?.bus?.publish(
            `tile:${tileId}`,
            'activity',
            `browser:${tileId}`,
            { kind: 'navigation', event: 'navigated', url },
          )
        }
        eventsRef.current.onNavigation({
          ...(url ? { url } : {}),
          title: webview.getTitle?.() || '',
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward(),
          isLoading: webview.isLoading(),
        })
      } catch {
        readyRef.current = false
      }
    }

    const injectDarkBackground = () => {
      if (!readyRef.current) return
      const currentBackground = backgroundRef.current
      webview.insertCSS(
        `html:not([style*="background"]):not([class]) { background-color: ${currentBackground} !important; }`
        + `body:not([style*="background"]):not([class]) { background-color: ${currentBackground} !important; }`,
      ).catch(() => { /* webview may not be ready yet */ })
    }

    const onDomReady = () => {
      readyRef.current = true
      if (!embeddedPreview) injectDarkBackground()
      updateNavigation()
    }
    const onStartLoad = () => eventsRef.current.onLoadingChange(true)
    const onStopLoad = () => {
      eventsRef.current.onLoadingChange(false)
      updateNavigation()
      cluso.reset()
      if (embeddedPreview) return

      cluso.inject()
      if (shouldInjectHostBridge(webview.getURL())) {
        executeInWebview(createBusBridgeScript(tileId, bridgeTokenRef.current))
          .catch(error => console.warn('[BrowserTile] Bus bridge injection failed:', error))
      }
    }
    const onFrameFinishLoad = (event: Event) => {
      const frameEvent = event as Event & { isMainFrame?: boolean }
      if (frameEvent.isMainFrame === false) return

      updateNavigation()
      eventsRef.current.recordEvidence({
        kind: 'lifecycle',
        message: 'Frame finished loading',
        url: webview.getURL(),
        details: {
          title: webview.getTitle?.() || '',
          isLoading: webview.isLoading(),
        },
      })
    }
    const onFailLoad = (event: Event) => {
      eventsRef.current.onLoadingChange(false)
      cluso.reset()

      const loadEvent = event as Event & {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
        url?: string
        isMainFrame?: boolean
      }
      eventsRef.current.recordEvidence({
        kind: 'load-failure',
        message: loadEvent.errorDescription
          || `Load failed${typeof loadEvent.errorCode === 'number' ? ` (${loadEvent.errorCode})` : ''}`,
        url: loadEvent.validatedURL || loadEvent.url || webview.getURL(),
        errorCode: loadEvent.errorCode,
        details: typeof loadEvent.isMainFrame === 'boolean'
          ? { isMainFrame: loadEvent.isMainFrame }
          : undefined,
      })
    }
    const onNavigate = () => updateNavigation()
    const onNavigateInPage = () => updateNavigation()
    const onWillNavigate = (event: Event) => {
      const navigationEvent = event as Event & { url?: string }
      if (!navigationEvent.url || isAllowedBrowserUrl(navigationEvent.url)) return
      event.preventDefault()
      void webview.loadURL(HOMEPAGE)
    }
    const onConsoleMessage = (event: Electron.ConsoleMessageEvent) => {
      const consoleEvent = event as Electron.ConsoleMessageEvent & {
        level?: string | number
        sourceId?: string
        line?: number
        column?: number
      }
      const message = consoleEvent.message
      const action = classifyBrowserConsoleMessage(message, {
        tileId,
        bridgeToken: bridgeTokenRef.current,
        bridgeAllowed: message.startsWith('{"__contex"')
          && shouldInjectHostBridge(webview.getURL()),
      })

      if (action.kind === 'bridge') {
        window.electron?.bus?.publish(
          `browser:${tileId}`,
          action.eventType,
          `browser:${tileId}`,
          action.payload,
        )
        return
      }
      if (action.kind === 'evidence') {
        eventsRef.current.recordEvidence({
          kind: 'console',
          message,
          level: consoleEvent.level,
          source: consoleEvent.sourceId,
          line: consoleEvent.line,
          column: consoleEvent.column,
          url: webview.getURL(),
        })
        return
      }
      if (action.kind === 'cluso-ready') {
        cluso.markReady(action.active)
        console.log('[BrowserTile] Cluso ready')
        return
      }
      if (action.kind === 'cluso-active') {
        cluso.markActive(action.active)
        return
      }
      if (action.kind === 'cluso-error') {
        console.error('[BrowserTile] Cluso error:', message)
      }
    }

    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-start-loading', onStartLoad)
    webview.addEventListener('did-stop-loading', onStopLoad)
    webview.addEventListener('did-frame-finish-load', onFrameFinishLoad)
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('will-navigate', onWillNavigate)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigateInPage)
    webview.addEventListener('console-message', onConsoleMessage)

    const attachWebview = () => {
      if (!mountedRef.current || webviewRef.current !== webview) return
      if (!container.contains(webview)) container.appendChild(webview)
    }

    if (!reused && !container.contains(webview)) {
      window.electron?.settings?.get().then(settings => {
        if (!settings?.chromeSyncEnabled || !settings.chromeSyncProfileDir) {
          attachWebview()
          return
        }
        const partition = `persist:browser-tile-${tileId}`
        window.electron?.chromeSync?.syncCookies(settings.chromeSyncProfileDir, partition)
          .then(() => attachWebview())
          .catch(() => attachWebview())
      }).catch(() => attachWebview())
    } else if (!container.contains(webview)) {
      container.appendChild(webview)
    }

    if (reused && !embeddedPreview) {
      requestAnimationFrame(() => {
        if (!mountedRef.current || webviewRef.current !== webview) return

        readyRef.current = true
        updateNavigation()
        cluso.inject()

        let reattachUrl: string | null
        try {
          reattachUrl = webview.getURL()
        } catch {
          reattachUrl = null
        }
        if (reattachUrl && shouldInjectHostBridge(reattachUrl)) {
          executeInWebview(createBusBridgeScript(tileId, bridgeTokenRef.current))
            .catch(error => console.warn('[BrowserTile] Bus bridge reinjection failed:', error))
        }
      })
    }

    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-start-loading', onStartLoad)
      webview.removeEventListener('did-stop-loading', onStopLoad)
      webview.removeEventListener('did-frame-finish-load', onFrameFinishLoad)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('will-navigate', onWillNavigate)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigateInPage)
      webview.removeEventListener('console-message', onConsoleMessage)

      const parkingRoot = getWebviewParkingRoot()
      if (container.contains(webview) || webview.parentElement !== parkingRoot) {
        parkingRoot.appendChild(webview)
      }
      webviewRef.current = null
      readyRef.current = false
      scheduleManagedWebviewDisposal(tileId, webview)
    }
  }, [
    cluso.inject,
    cluso.markActive,
    cluso.markReady,
    cluso.reset,
    executeInWebview,
    stateLoaded,
    tileId,
  ])

  useEffect(() => {
    const unsubscribe = window.electron?.browserTile?.onNewWindow?.((event: { url: string }) => {
      // `webview:new-window` is a SHARED channel: main sends one message to the
      // parent WebContents with no guest or tile identity, and every mounted
      // BrowserTile has a listener — so one target="_blank" click opened one
      // tile per open browser tile, or launched N external browsers.
      //
      // Main carries no attribution to filter on, so collapse the fan-out here:
      // the first listener to see a given URL claims it and the rest ignore it.
      // Cross-instance because the claim lives at module scope, and it survives
      // an owner tile unmounting, which a single-owner election would not.
      if (claimPopupUrl(event.url)) return
      // Page-controlled data: main denies the popup, so Chromium never applied
      // its local-resource check. normalizeOpenableHref accepts any scheme and
      // re-emits file:// as a local path, which App.tsx then mounts as a
      // code/note/image tile — so a `file:///…/.env` link would render the
      // file. Match the address-bar ingress and accept only http(s).
      if (event.url && isAllowedBrowserUrl(event.url)) void dispatchOpenLink(event.url)
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (webview) webview.style.background = background
  }, [background])

  useEffect(() => {
    const webview = webviewRef.current
    const container = containerRef.current
    if (!webview) return

    const blockPointerCapture = Boolean(
      !surface.isVisible
      || surface.isToolbarHovered
      || surface.isAddressFocused
      || surface.isInteracting
    )
    const hideWebviewSurface = Boolean(!surface.isVisible || surface.isInteracting)
    webview.style.pointerEvents = blockPointerCapture ? 'none' : 'auto'
    webview.style.visibility = hideWebviewSurface ? 'hidden' : 'visible'
    webview.style.opacity = hideWebviewSurface ? '0' : '1'
    if (container) container.style.pointerEvents = blockPointerCapture ? 'none' : 'auto'
  }, [
    surface.isAddressFocused,
    surface.isInteracting,
    surface.isToolbarHovered,
    surface.isVisible,
  ])

  const loadUrl = useCallback((url: string) => {
    if (readyRef.current && webviewRef.current) safeLoadURL(webviewRef.current, url)
  }, [])
  const restoreUrl = useCallback((url: string) => {
    const webview = webviewRef.current
    if (!webview) return
    if (readyRef.current) {
      safeLoadURL(webview, url)
    } else {
      webview.src = url
    }
  }, [])
  const goBack = useCallback(() => {
    if (readyRef.current && webviewRef.current) webviewRef.current.goBack()
  }, [])
  const goForward = useCallback(() => {
    if (readyRef.current && webviewRef.current) webviewRef.current.goForward()
  }, [])
  const reload = useCallback(() => {
    if (!readyRef.current || !webviewRef.current) return false
    webviewRef.current.reload()
    return true
  }, [])
  const stop = useCallback(() => {
    if (readyRef.current && webviewRef.current) webviewRef.current.stop()
  }, [])
  const setMode = useCallback((mode: BrowserMode) => {
    if (isEmbeddedPreview || !readyRef.current || !webviewRef.current) return
    webviewRef.current.setUserAgent(mode === 'mobile' ? MOBILE_UA : DESKTOP_UA)
    webviewRef.current.reload()
  }, [isEmbeddedPreview])
  const toggleCluso = useCallback(() => {
    cluso.toggle(isEmbeddedPreview)
  }, [cluso.toggle, isEmbeddedPreview])

  return {
    containerRef,
    isEmbeddedPreview,
    isClusoReady: cluso.isReady,
    isClusoActive: cluso.isActive,
    loadUrl,
    restoreUrl,
    goBack,
    goForward,
    reload,
    stop,
    setMode,
    toggleCluso,
  }
}
