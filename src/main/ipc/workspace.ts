import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings, Workspace } from '../../shared/types'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../../shared/types'
import { ensureDaemonRunning } from '../daemon/manager'
import { daemonClient } from '../daemon/client'
import { writeMCPConfigToWorkspace } from '../mcp-server'
import { applyWindowAppearance } from '../windowAppearance'
import { CONTEX_HOME } from '../paths'
import { ensureCodeSurfStructure } from '../session-sources'

const SETTINGS_PATH = join(CONTEX_HOME, 'settings.json')
const LEGACY_CONFIG_PATH = join(CONTEX_HOME, 'config.json')

type PersistedSettingsDocument = {
  version?: number
  settings?: Partial<AppSettings>
}

type LegacyConfigDocument = {
  settings?: Partial<AppSettings>
}

export function extractWorkspacePrimaryPath(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null
  const projectPath = Array.isArray(workspace.projectPaths) && workspace.projectPaths.length > 0
    ? workspace.projectPaths[0]
    : workspace.path
  const normalized = String(projectPath ?? '').trim()
  return normalized || null
}

function normalizeSettingsDocument(raw: string): AppSettings {
  try {
    const parsed = JSON.parse(raw) as PersistedSettingsDocument | LegacyConfigDocument
    if (parsed && typeof parsed === 'object' && 'settings' in parsed) {
      return withDefaultSettings(parsed.settings ?? {})
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_SETTINGS }
}

async function ensureWorkspaceSideEffects(workspace: Workspace | null): Promise<void> {
  const projectPaths = Array.isArray(workspace?.projectPaths) ? workspace?.projectPaths ?? [] : []
  for (const projectPath of projectPaths) {
    if (!projectPath) continue
    await ensureCodeSurfStructure(projectPath)
    writeMCPConfigToWorkspace(projectPath).catch(() => {})
  }
}

async function applySettingsSideEffects(): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) {
    applyWindowAppearance(win)
  }
}

export async function getWorkspacePathById(workspaceId: string): Promise<string | null> {
  await ensureDaemonRunning()
  const workspaces = await daemonClient.listWorkspaces()
  return extractWorkspacePrimaryPath(workspaces.find(workspace => workspace.id === workspaceId) ?? null)
}

export async function getWorkspaceStorageIds(workspaceId: string): Promise<string[]> {
  return [workspaceId]
}

export async function initWorkspaces(): Promise<void> {
  await ensureCodeSurfStructure()
  await ensureDaemonRunning()
  const projects = await daemonClient.listProjects()
  for (const project of projects) {
    await ensureCodeSurfStructure(project.path)
  }
}

export function readSettingsSync(): AppSettings {
  try {
    return normalizeSettingsDocument(readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    try {
      return normalizeSettingsDocument(readFileSync(LEGACY_CONFIG_PATH, 'utf8'))
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }
}

export function registerWorkspaceIPC(): void {
  ipcMain.handle('workspace:list', async () => {
    await ensureDaemonRunning()
    return await daemonClient.listWorkspaces()
  })

  ipcMain.handle('workspace:listProjects', async () => {
    await ensureDaemonRunning()
    return await daemonClient.listProjects()
  })

  ipcMain.handle('workspace:getActive', async () => {
    await ensureDaemonRunning()
    return await daemonClient.getActiveWorkspace()
  })

  ipcMain.handle('workspace:create', async (_, name: string) => {
    await ensureDaemonRunning()
    const workspace = await daemonClient.createWorkspace(name)
    await ensureWorkspaceSideEffects(workspace)
    return workspace
  })

  ipcMain.handle('workspace:createWithPath', async (_, name: string, projectPath: string) => {
    await ensureDaemonRunning()
    const workspace = await daemonClient.createWorkspaceWithPath(name, projectPath)
    await ensureWorkspaceSideEffects(workspace)
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

  ipcMain.handle('workspace:addProjectFolder', async (_, workspaceId: string, folderPath: string) => {
    await ensureDaemonRunning()
    const workspace = await daemonClient.addProjectFolder(workspaceId, folderPath)
    await ensureWorkspaceSideEffects(workspace)
    return workspace
  })

  ipcMain.handle('workspace:removeProjectFolder', async (_, workspaceId: string, folderPath: string) => {
    await ensureDaemonRunning()
    return await daemonClient.removeProjectFolder(workspaceId, folderPath)
  })

  ipcMain.handle('workspace:createFromFolder', async (_, folderPath: string) => {
    await ensureDaemonRunning()
    const workspace = await daemonClient.createWorkspaceFromFolder(folderPath)
    await ensureWorkspaceSideEffects(workspace)
    return workspace
  })

  ipcMain.handle('workspace:setActive', async (_, id: string) => {
    await ensureDaemonRunning()
    await daemonClient.setActiveWorkspace(id)
    const activeWorkspace = await daemonClient.getActiveWorkspace()
    await ensureWorkspaceSideEffects(activeWorkspace)
  })

  ipcMain.handle('settings:get', async () => {
    await ensureDaemonRunning()
    return withDefaultSettings(await daemonClient.getSettings())
  })

  ipcMain.handle('settings:set', async (_, settings: AppSettings) => {
    await ensureDaemonRunning()
    const next = withDefaultSettings(await daemonClient.setSettings(withDefaultSettings(settings)))
    await applySettingsSideEffects()
    return next
  })

  ipcMain.handle('settings:getRawJson', async () => {
    await ensureDaemonRunning()
    return await daemonClient.getRawSettingsJson()
  })

  ipcMain.handle('settings:setRawJson', async (_, json: string) => {
    await ensureDaemonRunning()
    const result = await daemonClient.setRawSettingsJson(json)
    if (result.ok) {
      await applySettingsSideEffects()
    }
    if (result.ok && result.settings) {
      return { ...result, settings: withDefaultSettings(result.settings) }
    }
    return result
  })

  ipcMain.handle('workspace:delete', async (_, id: string) => {
    await ensureDaemonRunning()
    await daemonClient.deleteWorkspace(id)
  })
}
