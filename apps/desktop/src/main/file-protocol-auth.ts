/**
 * Pure path-authorization for the `codesurf-file://` privileged scheme, extracted
 * from `file-protocol.ts` so the security-sensitive logic is unit-testable
 * (see `test/file-protocol-auth.test.ts`).
 *
 * risk-04: the primary cross-origin exfil boundary is now that the protocol
 * response no longer sends `Access-Control-Allow-Origin: *` — media tiles load
 * via `<img>/<video>/<audio> src` (no-cors), which never needed CORS, so a
 * webview page can no longer `fetch()`/read codesurf-file responses cross-origin.
 * The checks below are defense-in-depth: a media-extension filter plus a
 * denylist of sensitive home directories. A positive workspace/media-root
 * allowlist (per-file registration) is the remaining hardening and is tracked
 * as deferred — it needs every media-open call site + the running app to verify.
 */

import { extname, resolve, sep } from 'path'
import { SENSITIVE_HOME_DIRS } from './security/sensitivePaths.ts'

// First-home-segment denylist. Expanded past the original 4 (`.ssh`/`.gnupg`/
// `.aws`/`.config`) to cover credential/config trees that can hold
// media-extension files (`~/.config/**/*.png`, browser caches, etc.). Files
// with no media extension are already rejected by the extension filter, so this
// set matters mainly for media-typed files nested inside sensitive trees.
// Shared with the fs IPC surface (`ipc/fs.ts`) via `security/sensitivePaths.ts`
// so both boundaries guarding the home directory stay in sync.
export { SENSITIVE_HOME_DIRS }

export const MIME_TYPES: Record<string, string> = {
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

export function inferMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

// True when `filePath` lives directly under one of the denylisted first-level
// home directories. `home` is injectable for testing. The home-prefix check
// uses `home + sep` (not a bare prefix) so `${home}-evil/...` cannot slip past.
export function isSensitiveHomePath(filePath: string, home: string): boolean {
  const resolvedHome = resolve(home)
  const resolved = resolve(filePath)
  if (resolved === resolvedHome) return false
  if (!resolved.startsWith(resolvedHome + sep)) return false
  const firstSegment = resolved.slice(resolvedHome.length + 1).split(sep)[0]
  return SENSITIVE_HOME_DIRS.has(firstSegment)
}

// Resolve + authorize a requested path. Throws on an unsupported (non-media)
// extension or a sensitive-home-dir hit. `..` traversal is normalized by
// `resolve()` before any check runs. Returns the canonical absolute path.
export function authorizeRequestPath(filePath: string, home: string): string {
  const resolved = resolve(filePath)

  if (inferMimeType(resolved) === 'application/octet-stream') {
    throw new Error(`Unsupported codesurf-file type: ${extname(resolved) || '(none)'}`)
  }
  if (isSensitiveHomePath(resolved, home)) {
    throw new Error('Access denied: sensitive home directory')
  }
  return resolved
}
