import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'

// Renderer-safe scheme for loading arbitrary local files as <img>/<video>/<audio>
// sources. The dev renderer origin is http://localhost:..., which means direct
// file:// URLs are blocked by Chromium's cross-origin policy even with
// webSecurity on. A custom privileged scheme sidesteps this without having to
// disable web security.
//
// URL form: contex-file:///absolute/path/to/file.mp4
// (three slashes — the "host" is empty and the path starts at /)
//
// Range requests are forwarded to net.fetch() so <video> seeking and partial
// loading work correctly for large media files.

const SCHEME = 'contex-file'

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
      bypassCSP: true,
    },
  },
])

export function registerFileProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // pathname is /Users/... — decode in case the caller URI-encoded it
      const filePath = decodeURIComponent(url.pathname)

      // Forward range headers so video seeking works without loading the whole file
      const rangeHeader = request.headers.get('range')
      const init: RequestInit = rangeHeader ? { headers: { range: rangeHeader } } : {}

      return await net.fetch(pathToFileURL(filePath).toString(), init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`contex-file error: ${message}`, { status: 500 })
    }
  })
}
