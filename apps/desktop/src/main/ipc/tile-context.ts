import { ipcMain } from 'electron'
import type { TileContextEntry } from '../../shared/types'
import { bus } from '../event-bus'
import { broadcastToRenderer } from '../utils/broadcast'
import {
  loadWorkspaceTileState,
  saveWorkspaceTileState,
  SKIP_WORKSPACE_TILE_STATE_WRITE,
  updateWorkspaceTileState,
} from '../storage/workspaceArtifacts'
import { tileContextChannel } from '../../shared/tileContextScope.ts'

interface TileContextState {
  _context?: Record<string, TileContextEntry>
  [k: string]: unknown
}

async function loadTileState(workspaceId: string, tileId: string): Promise<TileContextState> {
  return loadWorkspaceTileState<TileContextState>(workspaceId, tileId, {})
}

async function saveTileState(workspaceId: string, tileId: string, state: TileContextState): Promise<void> {
  await saveWorkspaceTileState(workspaceId, tileId, state)
}

function publishContextChanged(workspaceId: string, tileId: string, key: string, value: unknown): void {
  void bus.publish({
    channel: tileContextChannel(workspaceId, tileId),
    type: 'data',
    source: `tile:${workspaceId}:${tileId}`,
    payload: { action: 'context_changed', key, value, workspaceId, tileId },
  })
  // Forward to renderer
  broadcastToRenderer('tileContext:changed', { workspaceId, tileId, key, value })
}

export function registerTileContextIPC(): void {
  // Get a single context entry
  ipcMain.handle('tileContext:get', async (_, workspaceId: string, tileId: string, key?: string) => {
    const state = await loadTileState(workspaceId, tileId)
    const ctx = state._context ?? {}
    if (key) return ctx[key] ?? null
    return ctx
  })

  // Get all context entries, optionally filtered by tag prefix
  ipcMain.handle('tileContext:getAll', async (_, workspaceId: string, tileId: string, tagPrefix?: string) => {
    const state = await loadTileState(workspaceId, tileId)
    const ctx = state._context ?? {}
    if (!tagPrefix) return Object.values(ctx)
    return Object.values(ctx).filter(e => e.key.startsWith(tagPrefix))
  })

  // Set a context entry
  ipcMain.handle('tileContext:set', async (_, workspaceId: string, tileId: string, key: string, value: unknown) => {
    // Persist only the context entry being changed. Passing a full state loaded
    // before the save lane would let a stale context write overwrite newer tile
    // fields (for example BrowserTile's currentUrl during navigation).
    await saveTileState(workspaceId, tileId, {
      _context: {
        [key]: { key, value, updatedAt: Date.now(), source: tileId },
      },
    })
    publishContextChanged(workspaceId, tileId, key, value)
    return true
  })

  // Delete a context entry
  ipcMain.handle('tileContext:delete', async (_, workspaceId: string, tileId: string, key: string) => {
    let deleted = false
    await updateWorkspaceTileState(workspaceId, tileId, existing => {
      const state = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing as TileContextState
        : {}
      if (!state._context || !Object.prototype.hasOwnProperty.call(state._context, key)) {
        return SKIP_WORKSPACE_TILE_STATE_WRITE
      }
      const nextContext = { ...state._context }
      delete nextContext[key]
      deleted = true
      return { ...state, _context: nextContext }
    })
    if (deleted) publishContextChanged(workspaceId, tileId, key, null)
    return true
  })
}
