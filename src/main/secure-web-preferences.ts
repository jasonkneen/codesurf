import type { WebContents, WebPreferences } from 'electron'
import { formatGuestWebviewTagPreferences } from '../shared/guest-webview-preferences.ts'

/**
 * Only http(s) popup URLs may be forwarded to the renderer. The address-bar
 * ingress is already guarded by isAllowedBrowserUrl/normalizeUrl; this is the
 * matching guard for the window.open path.
 */
function isForwardableGuestUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export { formatGuestWebviewTagPreferences }

/**
 * Main renderer windows intentionally use sandbox:false so the preload bridge
 * can reach Node-backed IPC (terminal/node-pty, fs, MCP). Mitigations:
 * - contextIsolation:true — renderer cannot touch Node/Electron directly
 * - nodeIntegration:false — no require() in the page
 * - Guest <webview> tags are hardened separately via will-attach-webview.
 */
export function createMainWindowWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: true,
  }
}

/** Enforced on every guest webview regardless of tag attributes. */
export const GUEST_WEBVIEW_WEB_PREFERENCES: Pick<
  WebPreferences,
  | 'sandbox'
  | 'contextIsolation'
  | 'nodeIntegration'
  | 'nodeIntegrationInSubFrames'
  | 'webSecurity'
  | 'allowRunningInsecureContent'
> = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
}

export function applyGuestWebviewWebPreferences(webPreferences: WebPreferences): void {
  webPreferences.preload = undefined
  Object.assign(webPreferences, GUEST_WEBVIEW_WEB_PREFERENCES)
}

export function attachGuestWebviewSecurityHandlers(contents: WebContents): void {
  contents.on('will-attach-webview', (_event, webPreferences, params) => {
    applyGuestWebviewWebPreferences(webPreferences)
    ;(params as { allowpopups?: boolean }).allowpopups = false
  })

  // The `new-window` DOM webview event was removed in Electron 22.
  // Handle window.open / target=_blank in the main process instead: intercept
  // via setWindowOpenHandler on the guest WebContents once attached, forward
  // the URL to the renderer via IPC, and deny the popup.
  contents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.setWindowOpenHandler(details => {
      // Forward to the parent renderer so BrowserTile can route through
      // dispatchOpenLink. Because the popup is DENIED, Chromium's own
      // local-resource check never runs and this URL is pure page data — so a
      // page could hand us `file:///Users/victim/proj/.env` and the renderer
      // would open a code tile showing its contents. Only http(s) is ever
      // forwarded; the renderer re-checks as well.
      if (!contents.isDestroyed() && isForwardableGuestUrl(details.url)) {
        contents.send('webview:new-window', { url: details.url })
      }
      return { action: 'deny' }
    })
  })
}