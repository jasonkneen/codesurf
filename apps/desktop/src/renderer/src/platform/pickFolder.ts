/**
 * Pick a project folder for web / Native hosts.
 *
 * Priority:
 * 1. Native SDK bridge (`window.zero`) — real OS dialog inside Native shell
 * 2. Local web-host `/host/dialog/openFolder` — OS dialog on the machine running codesurf
 *    (returns absolute path the daemon can use; no window.prompt)
 * 3. Browser File System Access API (`showDirectoryPicker`) — real browser file-access
 *    permission UI. Absolute paths are not exposed by the browser; when only a name
 *    is available we ask the host to resolve a best-effort path under the home tree
 *    is NOT attempted — host dialog should have already run for local dev.
 *
 * Never uses window.prompt.
 */

import { createHostHeaders, hostUrl } from './hostConfig'

export interface PickFolderResult {
  path: string | null
  source: 'zero' | 'host-dialog' | 'file-system-access' | 'cancelled' | 'unavailable'
}

async function pickViaZero(): Promise<string | null> {
  const w = window as Window & {
    zero?: { invoke?: (name: string, args?: unknown) => Promise<unknown> }
  }
  if (!w.zero?.invoke) return null
  try {
    const result = await w.zero.invoke('native-sdk.dialog.openFile', {
      allowDirectories: true,
      // Prefer directory-only when the SDK supports it
      multiple: false,
    }) as { path?: string; paths?: string[] } | string | null
    if (typeof result === 'string' && result.trim()) return result.trim()
    if (result && typeof result === 'object') {
      return result.path || result.paths?.[0] || null
    }
  } catch (err) {
    console.warn('[codesurf-platform] zero folder dialog failed', err)
  }
  return null
}

async function pickViaHostDialog(prompt = 'Choose project folder'): Promise<string | null> {
  try {
    const res = await fetch(hostUrl('/host/dialog/openFolder'), {
      method: 'POST',
      headers: createHostHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(300_000), // dialog can sit open a long time
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `host dialog failed: ${res.status}`)
    }
    const body = await res.json() as { path?: string | null; cancelled?: boolean; error?: string }
    if (body.error && !body.path) throw new Error(body.error)
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    return path || null
  } catch (err) {
    console.warn('[codesurf-platform] host folder dialog failed', err)
    return null
  }
}

/**
 * Browser-native directory picker (File System Access API).
 * Returns the directory name only in pure browsers — full paths are not exposed.
 * Prefer host/zero dialogs when an absolute path is required.
 */
async function pickViaFileSystemAccess(): Promise<{ name: string; handle: FileSystemDirectoryHandle } | null> {
  const w = window as Window & {
    showDirectoryPicker?: (options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: string
    }) => Promise<FileSystemDirectoryHandle>
  }
  if (typeof w.showDirectoryPicker !== 'function') return null
  try {
    const handle = await w.showDirectoryPicker({
      id: 'codesurf-project-folder',
      mode: 'readwrite',
      startIn: 'documents',
    })
    // Persist permission for this origin (best-effort)
    try {
      const perm = await (handle as FileSystemDirectoryHandle & {
        requestPermission?: (opts: { mode: string }) => Promise<string>
      }).requestPermission?.({ mode: 'readwrite' })
      if (perm && perm !== 'granted') {
        console.warn('[codesurf-platform] directory permission not granted:', perm)
      }
    } catch {
      // older browsers
    }
    return { name: handle.name, handle }
  } catch (err) {
    // User cancelled → AbortError
    const name = (err as Error)?.name
    if (name === 'AbortError') return null
    console.warn('[codesurf-platform] showDirectoryPicker failed', err)
    return null
  }
}

/**
 * Resolve an absolute project folder path for daemon/workspace APIs.
 * Uses OS dialogs first so the daemon receives a real filesystem path.
 */
export async function pickProjectFolderPath(prompt = 'Choose project folder'): Promise<PickFolderResult> {
  // 1. Native shell
  const zeroPath = await pickViaZero()
  if (zeroPath) return { path: zeroPath, source: 'zero' }

  // 2. Local web-host OS dialog (absolute path) — primary for browser + local daemon
  const hostPath = await pickViaHostDialog(prompt)
  if (hostPath) return { path: hostPath, source: 'host-dialog' }

  // 3. Browser File System Access — UX only; cannot produce absolute paths.
  //    If host dialog failed (host down / remote), we still request access so
  //    the user sees a real picker, then surface unavailable for path-based APIs.
  const fsa = await pickViaFileSystemAccess()
  if (fsa) {
    // Store handle for future browser-side FS work
    try {
      const w = window as Window & { __CODESURF_DIR_HANDLES__?: Map<string, FileSystemDirectoryHandle> }
      w.__CODESURF_DIR_HANDLES__ ??= new Map()
      w.__CODESURF_DIR_HANDLES__.set(fsa.name, fsa.handle)
    } catch {
      // ignore
    }
    // Without an absolute path the daemon cannot open the folder. Prefer null
    // over a fake path so callers can show a proper error.
    console.warn(
      '[codesurf-platform] File System Access granted for',
      fsa.name,
      'but no absolute path is available. Ensure web-host is running for OS dialogs.',
    )
    return { path: null, source: 'file-system-access' }
  }

  return { path: null, source: 'cancelled' }
}
