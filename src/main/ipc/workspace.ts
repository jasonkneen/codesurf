import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve, basename } from 'path'
import { homedir } from 'os'
import type { Config, Workspace, AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../../shared/types'
import { writeMCPConfigToWorkspace } from '../mcp-server'

const COLLAB_DIR = join(homedir(), 'clawd-collab')
const CONFIG_PATH = join(COLLAB_DIR, 'config.json')

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function readConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    // Merge in any missing settings keys from defaults
    return {
      ...parsed,
      settings: withDefaultSettings({ ...(parsed.settings ?? {}) })
    }
  } catch {
    return { workspaces: [], activeWorkspaceIndex: 0, settings: { ...DEFAULT_SETTINGS } }
  }
}

async function writeConfig(config: Config): Promise<void> {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export async function initWorkspaces(): Promise<void> {
  await ensureDir(COLLAB_DIR)
  let config = await readConfig()

  if (config.workspaces.length === 0) {
    const defaultId = 'default'
    const defaultPath = join(COLLAB_DIR, 'workspaces', defaultId)
    await ensureDir(defaultPath)
    config = {
      workspaces: [{ id: defaultId, name: 'Default', path: defaultPath }],
      activeWorkspaceIndex: 0
    }
    await writeConfig(config)
  }

  // Ensure all workspace dirs exist
  for (const ws of config.workspaces) {
    const wsPath = ws.path.startsWith('~') ? resolve(homedir(), ws.path.slice(2)) : ws.path
    await ensureDir(wsPath)
  }
}

export function registerWorkspaceIPC(): void {
  ipcMain.handle('workspace:list', async () => {
    const config = await readConfig()
    return config.workspaces
  })

  ipcMain.handle('workspace:getActive', async () => {
    const config = await readConfig()
    return config.workspaces[config.activeWorkspaceIndex] ?? config.workspaces[0] ?? null
  })

  ipcMain.handle('workspace:create', async (_, name: string) => {
    const config = await readConfig()
    const id = `ws-${Date.now()}`
    const wsPath = join(COLLAB_DIR, 'workspaces', id)
    await ensureDir(wsPath)
    const workspace: Workspace = { id, name, path: wsPath }
    config.workspaces.push(workspace)
    config.activeWorkspaceIndex = config.workspaces.length - 1
    await writeConfig(config)
    return workspace
  })

  ipcMain.handle('workspace:openFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Open Project Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:createFromFolder', async (_, folderPath: string) => {
    const config = await readConfig()
    // Don't add duplicates — if a workspace already points at this path, just switch to it
    const existing = config.workspaces.find(w => w.path === folderPath)
    if (existing) {
      config.activeWorkspaceIndex = config.workspaces.indexOf(existing)
      await writeConfig(config)
      // Write MCP config so Claude Code in terminal tiles auto-discovers our tools
      writeMCPConfigToWorkspace(folderPath).catch(() => {})
      return existing
    }
    const id = `ws-${Date.now()}`
    const name = basename(folderPath)
    const workspace: Workspace = { id, name, path: folderPath }
    config.workspaces.push(workspace)
    config.activeWorkspaceIndex = config.workspaces.length - 1
    await writeConfig(config)
    writeMCPConfigToWorkspace(folderPath).catch(() => {})
    return workspace
  })

  ipcMain.handle('workspace:setActive', async (_, id: string) => {
    const config = await readConfig()
    const idx = config.workspaces.findIndex(w => w.id === id)
    if (idx !== -1) {
      config.activeWorkspaceIndex = idx
      await writeConfig(config)
      writeMCPConfigToWorkspace(config.workspaces[idx].path).catch(() => {})
    }
  })

  ipcMain.handle('settings:get', async () => {
    const config = await readConfig()
    return config.settings
  })

  ipcMain.handle('settings:set', async (_, settings: AppSettings) => {
    const config = await readConfig()
    config.settings = withDefaultSettings(settings)
    await writeConfig(config)
    return config.settings
  })

  ipcMain.handle('settings:getRawJson', async () => {
    try {
      const raw = await fs.readFile(CONFIG_PATH, 'utf8')
      return { path: CONFIG_PATH, content: raw }
    } catch {
      return { path: CONFIG_PATH, content: '{}' }
    }
  })

  ipcMain.handle('settings:setRawJson', async (_, json: string) => {
    try {
      const parsed = JSON.parse(json)
      if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, error: 'Root must be a JSON object' }
      }
      await writeConfig({
        ...parsed,
        settings: withDefaultSettings(parsed.settings ?? {})
      })
      const config = await readConfig()
      return { ok: true, settings: config.settings }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('workspace:delete', async (_, id: string) => {
    const config = await readConfig()
    const idx = config.workspaces.findIndex(w => w.id === id)
    if (idx !== -1) {
      config.workspaces.splice(idx, 1)
      if (config.activeWorkspaceIndex >= config.workspaces.length) {
        config.activeWorkspaceIndex = Math.max(0, config.workspaces.length - 1)
      }
      await writeConfig(config)
    }
  })
}
