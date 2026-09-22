import type { SessionEntryHint } from '../../../shared/session-types'

/**
 * Session management — rename, delete, fetch state.
 * Thin wrapper around `window.electron.canvas.*` session endpoints.
 */

function api() {
  return window.electron.canvas
}

export function getSessionState(
  workspaceId: string,
  sessionEntryId: string,
  options?: {
    tailLimit?: number
    entryHint?: SessionEntryHint | null
  },
): Promise<unknown> {
  return api().getSessionState(workspaceId, sessionEntryId, options)
}

export function deleteSession(
  workspaceId: string,
  sessionEntryId: string,
): Promise<{ ok: boolean; error?: string }> {
  return api().deleteSession(workspaceId, sessionEntryId)
}

export function renameSession(
  workspaceId: string,
  sessionEntryId: string,
  title: string,
): Promise<{ ok: boolean; error?: string; title?: string }> {
  return api().renameSession(workspaceId, sessionEntryId, title)
}
