import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const COLLAB_DIR = join(homedir(), 'clawd-collab')

function canvasStatePath(workspaceId: string): string {
  return join(COLLAB_DIR, 'workspaces', workspaceId, 'canvas-state.json')
}

export function registerCanvasIPC(): void {
  ipcMain.handle('canvas:load', async (_, workspaceId: string) => {
    try {
      const raw = await fs.readFile(canvasStatePath(workspaceId), 'utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  })

  ipcMain.handle('canvas:save', async (_, workspaceId: string, state: unknown) => {
    const path = canvasStatePath(workspaceId)
    await fs.writeFile(path, JSON.stringify(state, null, 2))
  })
}
