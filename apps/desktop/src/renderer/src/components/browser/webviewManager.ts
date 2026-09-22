/**
 * Webview management subsystem — extracted verbatim from BrowserTile.tsx.
 * Owns the managed-webview registry, the Electron/Electrobun webview adapters,
 * the cluso + bus bridge injection scripts, and URL helpers. Pure DOM/module
 * logic (no React); the BrowserTile component imports the public surface.
 */
import { formatGuestWebviewTagPreferences } from '../../../../shared/guest-webview-preferences'
import { resolveWebviewPaintCommand } from '../../../../shared/webview-paint-bridge'

export const HOMEPAGE = 'https://www.google.com'
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @codesurf/electron/0.2.0 Chrome/132.0.6834.159 Safari/537.36'
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const WEBVIEW_DISPOSE_DELAY_MS = 15000
const WEBVIEW_PARKING_ROOT_ID = 'browser-tile-webview-parking-root'
const CLUSO_TOOLBAR_WIDTH = 297
const CLUSO_TOOLBAR_HEIGHT = 44
const CLUSO_TOOLBAR_BOTTOM_OFFSET = 8

type WebviewRegistryEntry = {
  webview: Electron.WebviewTag
  disposeTimer: number | null
}

type ElectrobunWebviewElement = HTMLElement & {
  src: string | null
  webviewId?: number | null
  partition?: string | null
  renderer?: 'native' | 'cef'
  loadURL?: (url: string) => void
  loadHTML?: (html: string) => void
  canGoBack?: () => Promise<boolean>
  canGoForward?: () => Promise<boolean>
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  executeJavascript?: (script: string) => void
  openDevTools?: () => void
  syncDimensions?: (force?: boolean) => void
  on?: (event: string, listener: (event: CustomEvent) => void) => void
}

type AdaptedElectrobunWebview = ElectrobunWebviewElement & Electron.WebviewTag & { __codesurfElectrobunWebview?: true }

const webviewRegistry = new Map<string, WebviewRegistryEntry>()

export function getWebviewParkingRoot(): HTMLDivElement {
  let root = document.getElementById(WEBVIEW_PARKING_ROOT_ID) as HTMLDivElement | null
  if (root) return root

  root = document.createElement('div')
  root.id = WEBVIEW_PARKING_ROOT_ID
  root.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:-10000px',
    'width:1px',
    'height:1px',
    'overflow:hidden',
    'opacity:0',
    'pointer-events:none',
    'visibility:hidden',
    'z-index:-1',
  ].join(';')
  document.body.appendChild(root)
  return root
}

function emitFallbackWebviewEvent(target: EventTarget, type: string, url?: string): void {
  const event = new Event(type) as Event & { url?: string; message?: string }
  if (url) event.url = url
  target.dispatchEvent(event)
}

function eventUrl(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>
    if (typeof record.url === 'string') return record.url
    if (typeof record.detail === 'string') return record.detail
  }
  return fallback
}

function dispatchWebviewCompatEvent(target: EventTarget, type: string, detail: unknown, fallbackUrl: string): void {
  const event = new Event(type) as Event & { url?: string; message?: string }
  const url = eventUrl(detail, fallbackUrl)
  if (url) event.url = url
  if (!event.message && typeof detail === 'string') event.message = detail
  target.dispatchEvent(event)
}

type EmbeddedPreviewWebview = HTMLIFrameElement & Electron.WebviewTag & { __codesurfFallbackWebview?: true }

/**
 * The web and Native shell use a sandboxed iframe when no real guest-webview
 * implementation is available. It is intentionally only an embedded preview,
 * not a replacement for Electron's browser surface.
 */
export function isEmbeddedPreviewWebview(webview: Electron.WebviewTag | null | undefined): boolean {
  return Boolean((webview as EmbeddedPreviewWebview | null | undefined)?.__codesurfFallbackWebview)
}

function createFallbackWebview(src: string, bgColor = '#111317'): Electron.WebviewTag {
  const frame = document.createElement('iframe') as EmbeddedPreviewWebview
  frame.__codesurfFallbackWebview = true
  // Scripts and forms are sufficient for a basic public-page preview. Keeping
  // the iframe opaque prevents a guest page from becoming the host renderer.
  frame.setAttribute('sandbox', 'allow-scripts allow-forms')
  frame.referrerPolicy = 'no-referrer'
  frame.title = 'Embedded web preview'
  frame.style.cssText =
    `position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; border: none; background: ${bgColor};`

  let currentUrl = src
  let loading = true

  frame.loadURL = async (url: string) => {
    currentUrl = url
    loading = true
    emitFallbackWebviewEvent(frame, 'did-start-loading', url)
    frame.src = url
  }
  frame.getURL = () => currentUrl || frame.src
  frame.getTitle = () => {
    try {
      return frame.contentDocument?.title || currentUrl || 'Browser'
    } catch {
      return currentUrl || 'Browser'
    }
  }
  frame.canGoBack = () => false
  frame.canGoForward = () => false
  frame.isLoading = () => loading
  frame.goBack = () => {
    try { frame.contentWindow?.history.back() } catch { /* cross-origin iframe */ }
  }
  frame.goForward = () => {
    try { frame.contentWindow?.history.forward() } catch { /* cross-origin iframe */ }
  }
  frame.reload = () => {
    loading = true
    emitFallbackWebviewEvent(frame, 'did-start-loading', currentUrl)
    try { frame.contentWindow?.location.reload() } catch { frame.src = currentUrl }
  }
  frame.stop = () => {
    try { frame.contentWindow?.stop() } catch { /* ignore */ }
    loading = false
    emitFallbackWebviewEvent(frame, 'did-stop-loading', currentUrl)
  }
  frame.setUserAgent = () => { /* iframe fallback cannot change UA per tile */ }
  frame.openDevTools = () => { /* no-op outside Electron webview */ }
  frame.insertCSS = async () => ''
  frame.executeJavaScript = async (script: string) => {
    try {
      const targetWindow = frame.contentWindow as unknown as { eval?: (source: string) => unknown } | null
      return targetWindow?.eval?.(script) ?? null
    } catch { return null }
  }
  frame.send = async () => { /* no-op outside Electron webview */ }

  frame.addEventListener('load', () => {
    currentUrl = frame.src || currentUrl
    loading = false
    emitFallbackWebviewEvent(frame, 'dom-ready', currentUrl)
    emitFallbackWebviewEvent(frame, 'did-navigate', currentUrl)
    emitFallbackWebviewEvent(frame, 'did-stop-loading', currentUrl)
  })
  frame.addEventListener('error', () => {
    loading = false
    emitFallbackWebviewEvent(frame, 'did-fail-load', currentUrl)
  })

  void frame.loadURL(src)
  return frame
}

function createElectrobunWebview(src: string, bgColor = '#111317'): Electron.WebviewTag | null {
  if (!customElements.get('electrobun-webview')) return null

  const webview = document.createElement('electrobun-webview') as AdaptedElectrobunWebview
  if (typeof webview.loadURL !== 'function' || typeof webview.executeJavascript !== 'function') return null

  webview.__codesurfElectrobunWebview = true
  webview.setAttribute('partition', 'persist:browser-tile')
  webview.setAttribute('renderer', 'cef')
  webview.setAttribute('src', src)
  webview.style.cssText =
    `position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; border: none; background: ${bgColor};`

  const nativeLoadURL = webview.loadURL.bind(webview)
  const nativeCanGoBack = webview.canGoBack?.bind(webview)
  const nativeCanGoForward = webview.canGoForward?.bind(webview)
  const nativeExecuteJavascript = webview.executeJavascript.bind(webview)
  const nativeOpenDevTools = webview.openDevTools?.bind(webview)

  let currentUrl = src
  let loading = true
  let canGoBack = false
  let canGoForward = false

  const refreshNav = () => {
    void nativeCanGoBack?.().then(value => { canGoBack = Boolean(value) }).catch(() => { canGoBack = false })
    void nativeCanGoForward?.().then(value => { canGoForward = Boolean(value) }).catch(() => { canGoForward = false })
  }

  const onElectrobunEvent = (eventName: string, handler: (detail: unknown) => void) => {
    webview.on?.(eventName, event => handler(event.detail))
  }

  onElectrobunEvent('load-started', detail => {
    loading = true
    currentUrl = eventUrl(detail, currentUrl)
    dispatchWebviewCompatEvent(webview, 'did-start-loading', detail, currentUrl)
  })
  onElectrobunEvent('dom-ready', detail => {
    currentUrl = eventUrl(detail, currentUrl)
    dispatchWebviewCompatEvent(webview, 'dom-ready', detail, currentUrl)
    refreshNav()
  })
  onElectrobunEvent('load-finished', detail => {
    loading = false
    currentUrl = eventUrl(detail, currentUrl)
    dispatchWebviewCompatEvent(webview, 'did-stop-loading', detail, currentUrl)
    refreshNav()
  })
  onElectrobunEvent('did-navigate', detail => {
    currentUrl = eventUrl(detail, currentUrl)
    dispatchWebviewCompatEvent(webview, 'did-navigate', detail, currentUrl)
    refreshNav()
  })
  onElectrobunEvent('did-navigate-in-page', detail => {
    currentUrl = eventUrl(detail, currentUrl)
    dispatchWebviewCompatEvent(webview, 'did-navigate-in-page', detail, currentUrl)
    refreshNav()
  })
  onElectrobunEvent('new-window-open', detail => {
    dispatchWebviewCompatEvent(webview, 'new-window', detail, currentUrl)
  })
  onElectrobunEvent('host-message', detail => {
    const event = new Event('console-message') as Electron.ConsoleMessageEvent
    ;(event as unknown as { message: string }).message = typeof detail === 'string' ? detail : JSON.stringify(detail)
    webview.dispatchEvent(event)
  })

  webview.loadURL = async (url: string) => {
    currentUrl = url
    loading = true
    dispatchWebviewCompatEvent(webview, 'did-start-loading', url, currentUrl)
    nativeLoadURL(url)
  }
  webview.getURL = () => currentUrl || String(webview.getAttribute('src') ?? '')
  webview.getTitle = () => currentUrl || 'Browser'
  ;(webview as Electron.WebviewTag).canGoBack = () => canGoBack
  ;(webview as Electron.WebviewTag).canGoForward = () => canGoForward
  webview.isLoading = () => loading
  webview.stop = () => {
    loading = false
    dispatchWebviewCompatEvent(webview, 'did-stop-loading', currentUrl, currentUrl)
  }
  webview.setUserAgent = () => { /* Electrobun webview tag has no per-view UA setter yet */ }
  webview.openDevTools = () => { nativeOpenDevTools?.() }
  webview.insertCSS = async (css: string) => {
    nativeExecuteJavascript(`(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.documentElement.appendChild(style); })()`)
    return ''
  }
  webview.executeJavaScript = async (script: string) => {
    nativeExecuteJavascript(script)
    return null
  }
  webview.send = async () => { /* host-message bridge is available through Electrobun preload */ }

  requestAnimationFrame(() => {
    webview.syncDimensions?.(true)
    refreshNav()
  })

  return webview
}

function createManagedWebview(tileId: string, src: string, bgColor = '#111317'): Electron.WebviewTag {
  const candidate = document.createElement('webview') as Electron.WebviewTag & { loadURL?: unknown; executeJavaScript?: unknown }
  const hasElectronWebviewApi = typeof candidate.loadURL === 'function' && typeof candidate.executeJavaScript === 'function'
  if (!hasElectronWebviewApi) return createElectrobunWebview(src, bgColor) ?? createFallbackWebview(src, bgColor)

  const webview = candidate as Electron.WebviewTag
  webview.setAttribute('partition', `persist:browser-tile-${tileId}`)
  webview.setAttribute('useragent', DESKTOP_UA)
  // backgroundColor sets the Chromium compositor surface color — prevents white flash before content loads
  webview.setAttribute('webpreferences', formatGuestWebviewTagPreferences({ devTools: true, backgroundColor: bgColor }))
  webview.style.cssText =
    `position: absolute; top: 0; left: 0; right: 0; bottom: 0; border: none; background: ${bgColor};`
  webview.src = src
  return webview
}

/**
 * Throttle or restore guest webview frame production for a managed tile.
 *
 * Electron 41 WebviewTag has no getWebContents() — only getWebContentsId().
 * We resolve the paint command in the renderer, then hand webContentsId + fps
 * to main via webview:setFrameRate (webContents.fromId → setFrameRate).
 * Safe no-op for iframe fallback / Electrobun / unattached guests.
 */
export function setManagedWebviewPaintActive(tileId: string, paintActive: boolean): void {
  const entry = webviewRegistry.get(tileId)
  if (!entry) return
  const webview = entry.webview as Electron.WebviewTag & {
    getWebContentsId?: () => number
    isDestroyed?: () => boolean
  }
  try {
    if (typeof webview.isDestroyed === 'function' && webview.isDestroyed()) return
    const cmd = resolveWebviewPaintCommand(
      () => (typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : undefined),
      paintActive,
    )
    if (!cmd) return
    const api = (window as unknown as {
      electron?: { browserTile?: { setFrameRate?: (webContentsId: number, fps: number) => Promise<{ ok: boolean }> } }
    }).electron?.browserTile?.setFrameRate
    if (typeof api !== 'function') return
    void api(cmd.webContentsId, cmd.fps).catch(() => { /* best-effort */ })
  } catch {
    // Best-effort — destroyed guests or missing preload bridge.
  }
}

export function getOrCreateManagedWebview(tileId: string, src: string, bgColor?: string): { webview: Electron.WebviewTag; reused: boolean } {
  const existing = webviewRegistry.get(tileId)
  if (existing) {
    if (existing.disposeTimer !== null) window.clearTimeout(existing.disposeTimer)
    existing.disposeTimer = null

    // Reusing a detached webview is unstable: Electron may have already torn
    // down its guest instance, which shows up later as Invalid guestInstanceId.
    if (existing.webview.isConnected || existing.webview.parentElement) {
      return { webview: existing.webview, reused: true }
    }

    try { existing.webview.remove() } catch { /* ignore */ }
    webviewRegistry.delete(tileId)
  }

  const webview = createManagedWebview(tileId, src, bgColor)
  webviewRegistry.set(tileId, { webview, disposeTimer: null })
  return { webview, reused: false }
}

export function scheduleManagedWebviewDisposal(tileId: string, webview: Electron.WebviewTag): void {
  const entry = webviewRegistry.get(tileId)
  if (!entry || entry.webview !== webview) return

  if (entry.disposeTimer !== null) window.clearTimeout(entry.disposeTimer)

  entry.disposeTimer = window.setTimeout(() => {
    const latest = webviewRegistry.get(tileId)
    if (!latest || latest.webview !== webview) return
    if (webview.parentElement) webview.parentElement.removeChild(webview)
    try { webview.remove() } catch { /* ignore */ }
    webviewRegistry.delete(tileId)
  }, WEBVIEW_DISPOSE_DELAY_MS)
}

export function safeLoadURL(webview: Electron.WebviewTag, url: string): void {
  if (!webview.isConnected || !webview.parentElement) {
    webview.src = url
    return
  }
  try {
    void webview.loadURL(url).catch((err: { code?: string }) => {
      if (err?.code === 'ERR_ABORTED') return
      console.warn('[BrowserTile] loadURL failed:', err)
    })
  } catch (err) {
    webview.src = url
    console.warn('[BrowserTile] loadURL threw:', err)
  }
}

// ---------------------------------------------------------------------------
// Cluso injection script — ported verbatim from 1code agent-preview.tsx
// ---------------------------------------------------------------------------

/**
 * CLUSO_INJECTION_SCRIPT generator.
 *
 * Builds a self-executing JS string that, when evaluated inside a webview,
 * polyfills localStorage (for sandboxed contexts), creates an isolated
 * shadow-DOM-like mount point, injects the Cluso embed CSS/JS, and wires
 * up __CLUSO_HOST__ lifecycle hooks.  The returned string is passed to
 * webview.executeJavaScript() after every page load.
 */
export const createClusoInjectScript = (jsContent: string, cssContent: string): string => `
(() => {
  // Polyfill localStorage for sandboxed/blank webviews where access is denied
  try { void window.localStorage; } catch {
    const _memStore = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k) => Object.prototype.hasOwnProperty.call(_memStore, k) ? _memStore[k] : null,
        setItem: (k, v) => { _memStore[k] = String(v); },
        removeItem: (k) => { delete _memStore[k]; },
        clear: () => { for (const k in _memStore) delete _memStore[k]; },
        key: (i) => Object.keys(_memStore)[i] ?? null,
        get length() { return Object.keys(_memStore).length; },
      },
      writable: false,
      configurable: true,
    });
  }

  const ROOT_ID = '__huggi_cluso_root__';
  const MOUNT_ID = '__huggi_cluso_mount__';
  const CSS_ID = '__huggi_cluso_css__';
  const FLAG = '__huggiClusoBooting__';
  const TOOLBAR_POSITION_KEY = 'feedback-toolbar-position';
  const DEFAULT_TOOLBAR_WIDTH = ${CLUSO_TOOLBAR_WIDTH};
  const DEFAULT_TOOLBAR_HEIGHT = ${CLUSO_TOOLBAR_HEIGHT};
  const DEFAULT_TOOLBAR_BOTTOM_OFFSET = ${CLUSO_TOOLBAR_BOTTOM_OFFSET};
  const VISIBILITY_STYLE_ID = '__huggi_cluso_visibility__';
  const DESIRED_ACTIVE_KEY = '__huggi_cluso_desired_active__';

  function log(message) {
    try { console.log(message); } catch {}
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.style.cssText = [
        'position:fixed',
        'inset:0',
        'pointer-events:none',
        'z-index:2147483646',
        'contain:layout style paint',
        'background:transparent'
      ].join(';');
      document.body.appendChild(root);
    }
    return root;
  }

  function ensureMount(root) {
    let mount = document.getElementById(MOUNT_ID);
    if (!mount) {
      mount = document.createElement('div');
      mount.id = MOUNT_ID;
      mount.style.cssText = [
        'position:fixed',
        'inset:0',
        'pointer-events:none',
        'background:transparent'
      ].join(';');
      root.appendChild(mount);
    }
    return mount;
  }

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = ${JSON.stringify(cssContent)};
    document.head.appendChild(style);
  }

  function ensureVisibilityCss() {
    if (document.getElementById(VISIBILITY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = VISIBILITY_STYLE_ID;
    style.textContent = [
      'html[data-huggi-cluso-active="false"] [data-cluso-toolbar] {',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '  visibility: hidden !important;',
      '}',
    ].join('\\n');
    document.head.appendChild(style);
  }

  function syncToolbarVisibility(active) {
    try {
      document.documentElement.dataset.huggiClusoActive = active ? 'true' : 'false';
    } catch {}
  }

  function getDesiredActive() {
    return typeof window[DESIRED_ACTIVE_KEY] === 'boolean' ? !!window[DESIRED_ACTIVE_KEY] : null;
  }

  function getDefaultToolbarPosition() {
    return {
      x: Math.max(20, Math.round((window.innerWidth - DEFAULT_TOOLBAR_WIDTH) / 2)),
      y: Math.max(20, Math.round(window.innerHeight - DEFAULT_TOOLBAR_HEIGHT - DEFAULT_TOOLBAR_BOTTOM_OFFSET)),
    };
  }

  function seedToolbarPosition(force) {
    try {
      if (!force && localStorage.getItem(TOOLBAR_POSITION_KEY)) return;
      localStorage.setItem(TOOLBAR_POSITION_KEY, JSON.stringify(getDefaultToolbarPosition()));
    } catch {}
  }

  const root = ensureRoot();
  const mount = ensureMount(root);
  ensureCss();
  ensureVisibilityCss();
  seedToolbarPosition(false);
  syncToolbarVisibility(false);

  window.__CLUSO_EMBEDDED_CONFIG__ = {
    runtimeMode: 'embedded-release',
    showToolbar: true,
    hideCollapsedToolbar: true,
    defaultActive: getDesiredActive() ?? false,
    autoExitAfterSubmit: true,
    copyToClipboard: true,
    submitButtonLabel: 'Send to App',
    outputDetail: "forensic",
    visibleControls: {
      pause: true,
      markers: true,
      copy: true,
      send: true,
      clear: true,
      settings: true,
      inspector: false,
      exit: true,
    },
  };

  if (window[FLAG]) {
    return '__CLUSO_ALREADY_BOOTING__';
  }

  if (window.__CLUSO_HOST__) {
    const desiredActive = getDesiredActive();
    if (typeof desiredActive === 'boolean' && typeof window.__CLUSO_HOST__.setActive === 'function') {
      window.__CLUSO_HOST__.setActive(desiredActive);
    }
    syncToolbarVisibility(
      typeof window.__CLUSO_HOST__.getActive === 'function'
        ? !!window.__CLUSO_HOST__.getActive()
        : !!window.__CLUSO_HOST__.active
    );
    log('__CLUSO_READY__:' + JSON.stringify({
      reused: true,
      active: typeof window.__CLUSO_HOST__.getActive === 'function'
        ? !!window.__CLUSO_HOST__.getActive()
        : !!window.__CLUSO_HOST__.active,
    }));
    return '__CLUSO_ALREADY_READY__';
  }

  window[FLAG] = true;

  const originalGetElementById = document.getElementById.bind(document);
  document.getElementById = function(id) {
    if (id === 'root') return mount;
    return originalGetElementById(id);
  };

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    document.getElementById = originalGetElementById;
    window[FLAG] = false;
  };

  const emitReady = () => {
    const host = window.__CLUSO_HOST__;
    const active = host
      ? (typeof host.getActive === 'function' ? !!host.getActive() : !!host.active)
      : false;
    syncToolbarVisibility(active);
    log('__CLUSO_READY__:' + JSON.stringify({ embedded: true, active }));
  };

  const patchHost = (host) => {
    if (!host || host.__huggiClusoPatched) return;
    host.__huggiClusoPatched = true;

    const sync = () => {
      const active = typeof host.getActive === 'function' ? !!host.getActive() : !!host.active;
      syncToolbarVisibility(active);
    };

    if (typeof host.setActive === 'function') {
      const originalSetActive = host.setActive.bind(host);
      host.setActive = (nextActive) => {
        const result = originalSetActive(nextActive);
        window.setTimeout(sync, 0);
        return result;
      };
    }

    if (typeof host.toggleActive === 'function') {
      const originalToggleActive = host.toggleActive.bind(host);
      host.toggleActive = () => {
        const result = originalToggleActive();
        window.setTimeout(sync, 0);
        return result;
      };
    }

    sync();
  };

  const waitForHost = (attempt) => {
    if (window.__CLUSO_HOST__) {
      patchHost(window.__CLUSO_HOST__);
      const desiredActive = getDesiredActive();
      if (typeof desiredActive === 'boolean' && typeof window.__CLUSO_HOST__.setActive === 'function') {
        window.__CLUSO_HOST__.setActive(desiredActive);
      }
      restore();
      window.setTimeout(emitReady, 0);
      return;
    }
    if (attempt < 40) {
      window.setTimeout(() => waitForHost(attempt + 1), 50);
      return;
    }
    restore();
    log('__CLUSO_ERROR__:' + JSON.stringify({
      stage: 'host',
      message: 'Cluso host bridge did not register in time',
    }));
  };

  try {
    ${jsContent}
    waitForHost(0);
    return '__CLUSO_INJECTED__';
  } catch (error) {
    restore();
    log('__CLUSO_ERROR__:' + JSON.stringify({
      stage: 'execute',
      message: error && error.message ? String(error.message) : String(error),
    }));
    return '__CLUSO_EXECUTE_ERROR__';
  }
})();
`

// ---------------------------------------------------------------------------
// Bus bridge injection script — lets webview content publish to the EventBus
// ---------------------------------------------------------------------------

export function createBusBridgeScript(tileId: string, bridgeToken: string): string {
  const safeToken = JSON.stringify(bridgeToken)
  return `
    (function() {
      if (window.__contexBridge) return;
      window.__contexBridge = true;

      const BRIDGE_TOKEN = ${safeToken};
      const BRIDGE_CHANNEL = 'browser:${tileId}';

      // Allow localhost dev pages to send events to the host via console.log transport
      window.codesurf = {
        publish: function(type, payload) {
          console.log(JSON.stringify({
            __contex: true,
            token: BRIDGE_TOKEN,
            type: type || 'data',
            channel: BRIDGE_CHANNEL,
            payload: payload || {}
          }));
        },
        notify: function(message, level) {
          this.publish('notification', { message: message, level: level || 'info' });
        },
        progress: function(status, percent) {
          this.publish('progress', { status: status, percent: percent });
        },
        log: function(message) {
          this.publish('activity', { message: message });
        }
      };
    })();
  `
}

export function createClusoSetActiveScript(nextActive: boolean): string {
  return `
    (() => {
      window.__huggi_cluso_desired_active__ = ${nextActive ? 'true' : 'false'};
      try {
        document.documentElement.dataset.huggiClusoActive = ${nextActive ? '"true"' : '"false"'};
      } catch {}
      const host = window.__CLUSO_HOST__;
      if (!host) return '__CLUSO_PENDING__';
      try {
        if (${nextActive ? 'true' : 'false'}) {
          const position = {
            x: Math.max(20, Math.round((window.innerWidth - ${CLUSO_TOOLBAR_WIDTH}) / 2)),
            y: Math.max(20, Math.round(window.innerHeight - ${CLUSO_TOOLBAR_HEIGHT} - ${CLUSO_TOOLBAR_BOTTOM_OFFSET})),
          };
          try {
            localStorage.setItem('feedback-toolbar-position', JSON.stringify(position));
          } catch {}
        }

        if (typeof host.setActive === 'function') {
          host.setActive(${nextActive ? 'true' : 'false'});
          return '__CLUSO_TOGGLED__';
        }

        if (typeof host.toggleActive === 'function') {
          const current = typeof host.getActive === 'function' ? !!host.getActive() : !!host.active;
          if (current !== ${nextActive ? 'true' : 'false'}) {
            host.toggleActive();
          }
          return '__CLUSO_TOGGLED__';
        }

        return '__CLUSO_NO_HOST_API__';
      } catch (error) {
        return '__CLUSO_TOGGLE_ERROR__:' + (error && error.message ? String(error.message) : String(error));
      }
    })();
  `
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function isLikelyUrl(value: string): boolean {
  if (!value) return false
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(value)) return true
  if (/^localhost(?::\d+)?(\/|$)/i.test(value)) return true
  if (/^127\.0\.0\.1(?::\d+)?(\/|$)/.test(value)) return true
  if (value.includes('.') && !value.includes(' ')) return true
  return false
}

export function isAllowedBrowserUrl(value: string): boolean {
  if (value === 'about:blank') return true
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function shouldInjectHostBridge(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return HOMEPAGE
  if (trimmed === 'about:blank') return trimmed
  if (isLikelyUrl(trimmed)) {
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) {
      return isAllowedBrowserUrl(trimmed) ? trimmed : HOMEPAGE
    }
    if (/^localhost(?::\d+)?(\/|$)/i.test(trimmed) || /^127\.0\.0\.1(?::\d+)?(\/|$)/.test(trimmed))
      return `http://${trimmed}`
    return `https://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
