import type { AggregatedSessionEntry } from '../../../shared/session-types'
import type { CanvasState } from '../../../shared/types'

function api() {
  return window.electron.canvas
}

export function load(workspaceId: string): Promise<unknown> {
  return api().load(workspaceId)
}

export function save(workspaceId: string, state: CanvasState): Promise<void> {
  return api().save(workspaceId, state)
}

export function loadTileState(workspaceId: string, tileId: string): Promise<unknown> {
  return api().loadTileState(workspaceId, tileId)
}

export function saveTileState(workspaceId: string, tileId: string, state: unknown): Promise<void> {
  return api().saveTileState(workspaceId, tileId, state)
}

export function clearTileState(workspaceId: string, tileId: string): Promise<void> {
  return api().clearTileState(workspaceId, tileId)
}

export function deleteTileArtifacts(workspaceId: string, tileId: string): Promise<void> {
  return api().deleteTileArtifacts(workspaceId, tileId)
}

export function listSessions(workspaceId: string, forceRefresh = false): Promise<AggregatedSessionEntry[]> {
  return api().listSessions(workspaceId, forceRefresh)
}

export function onSessionsChanged(callback: (payload: { workspaceId: string }) => void): () => void {
  return api().onSessionsChanged(callback)
}
