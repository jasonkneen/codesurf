import { ipcMain, BrowserWindow } from 'electron'
import type { TileContextEntry } from '../../shared/types'
import { bus } from '../event-bus'
import { loadWorkspaceTileState, saveWorkspaceTileState } from '../storage/workspaceArtifacts'

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

function publishContextChanged(tileId: string, key: string, value: unknown): void {
  const evt = bus.publish({
    channel: `ctx:${tileId}`,
    type: 'data',
    source: `tile:${tileId}`,
    payload: { action: 'context_changed', key, value, tileId },
  })
  // Forward to renderer
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('tileContext:changed', { tileId, key, value })
  })
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
    const state = await loadTileState(workspaceId, tileId)
    if (!state._context) state._context = {}
    state._context[key] = { key, value, updatedAt: Date.now(), source: tileId }
    await saveTileState(workspaceId, tileId, state)
    publishContextChanged(tileId, key, value)
    return true
  })

  // Delete a context entry
  ipcMain.handle('tileContext:delete', async (_, workspaceId: string, tileId: string, key: string) => {
    const state = await loadTileState(workspaceId, tileId)
    if (state._context) {
      delete state._context[key]
      await saveTileState(workspaceId, tileId, state)
      publishContextChanged(tileId, key, null)
    }
    return true
  })
}
