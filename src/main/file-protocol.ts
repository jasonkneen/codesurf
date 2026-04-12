import { net, protocol } from 'electron'
import { extname } from 'path'
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

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
}

function inferMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

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
      bypassCSP: true,
    },
  },
])

export function registerFileProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeRequestPath(url)

      // Forward range headers so video seeking works without loading the whole file
      const rangeHeader = request.headers.get('range')
      const init: RequestInit = rangeHeader ? { headers: { range: rangeHeader } } : {}
      const resp = await net.fetch(pathToFileURL(filePath).toString(), init)
      const headers = new Headers(resp.headers)

      if (!headers.get('content-type')) {
        headers.set('content-type', inferMimeType(filePath))
      }
      headers.set('cache-control', 'no-store, no-cache, must-revalidate')
      headers.set('access-control-allow-origin', '*')

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`contex-file error: ${message}`, { status: 500 })
    }
  })
}
