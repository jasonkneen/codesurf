import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { authorizeRequestPath, inferMimeType } from './file-protocol-auth'

// Renderer-safe scheme for loading arbitrary local files as <img>/<video>/<audio>
// sources. The dev renderer origin is http://localhost:..., which means direct
// file:// URLs are blocked by Chromium's cross-origin policy even with
// webSecurity on. A custom privileged scheme sidesteps this without having to
// disable web security.
//
// URL form: codesurf-file:///absolute/path/to/file.mp4
// (three slashes — the "host" is empty and the path starts at /)
//
// Range requests are forwarded to net.fetch() so <video> seeking and partial
// loading work correctly for large media files.

const SCHEME = 'codesurf-file'

function decodeRequestPath(url: URL): string {
  const host = decodeURIComponent(url.host || '')
  const pathname = decodeURIComponent(url.pathname || '')

  if (process.platform === 'win32') {
    if (/^[a-zA-Z]:$/.test(host)) return `${host}${pathname}`
    if (host) return `//${host}${pathname}`
  }

  return host ? `/${host}${pathname}` : pathname
}

// Must run at module-load time, BEFORE app.ready fires.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

export function registerFileProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = authorizeRequestPath(decodeRequestPath(url), homedir())

      // Forward range headers so video seeking works without loading the whole file
      const rangeHeader = request.headers.get('range')
      const init: RequestInit = rangeHeader ? { headers: { range: rangeHeader } } : {}
      const resp = await net.fetch(pathToFileURL(filePath).toString(), init)
      const headers = new Headers(resp.headers)

      if (!headers.get('content-type')) {
        headers.set('content-type', inferMimeType(filePath))
      }
      headers.set('cache-control', 'no-store, no-cache, must-revalidate')
      // SVG documents execute scripts when loaded as a top-level document (e.g.
      // a browser tile navigated to the file) — and every codesurf-file:// URL
      // shares one origin, so that script could same-origin fetch every other
      // served media file on disk. Loaded via <img> scripts never run anyway,
      // so banning script execution costs nothing and closes the hole.
      if (inferMimeType(filePath) === 'image/svg+xml') {
        headers.set('content-security-policy', "script-src 'none'")
      }
      // risk-04: do NOT advertise wildcard CORS on a local-file scheme. Media
      // tiles load via <img>/<video>/<audio> src (no-cors) and never needed it;
      // removing it blocks cross-origin fetch()/canvas reads from webview-tile
      // pages that could otherwise exfiltrate local files.
      headers.delete('access-control-allow-origin')

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`codesurf-file error: ${message}`, { status: 500 })
    }
  })
}
