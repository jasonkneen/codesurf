import { BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { CONTEX_HOME } from '../paths'

const UI_STATE_PATH = join(CONTEX_HOME, 'ui-state.json')

interface UIState {
  zoomLevel?: number
}

let cached: UIState | null = null

async function readState(): Promise<UIState> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(UI_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as UIState
    cached = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    cached = {}
  }
  return cached
}

async function writeState(next: UIState): Promise<void> {
  cached = next
  try {
    await fs.mkdir(CONTEX_HOME, { recursive: true })
    await fs.writeFile(UI_STATE_PATH, JSON.stringify(next, null, 2))
  } catch {
    // best-effort — a write failure shouldn't crash the app
  }
}

/** Read the saved zoom level (defaults to 0 = 100%). */
export async function getSavedZoomLevel(): Promise<number> {
  const state = await readState()
  return typeof state.zoomLevel === 'number' ? state.zoomLevel : 0
}

export function registerUIIPC(): void {
  ipcMain.handle('ui:getZoomLevel', async () => getSavedZoomLevel())

  ipcMain.handle('ui:setZoomLevel', async (event, level: number) => {
    if (typeof level !== 'number' || !Number.isFinite(level)) return
    const state = await readState()
    await writeState({ ...state, zoomLevel: level })
    // Apply to the sender's webContents so all windows stay consistent
    // when the same sender drives zoom; other windows pick up the new
    // value on their next did-finish-load restore.
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.setZoomLevel(level)
    }
  })
}
