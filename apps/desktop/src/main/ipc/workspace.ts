import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFileSync, statSync } from 'fs'
import path, { join } from 'path'
import type { AppSettings, Workspace } from '../../shared/types'
import {
  applyNewInstallSecurityDefaults,
  applyFsScopingMigration,
  normalizeLoadedSettings,
  withDefaultSettings,
  withFreshInstallDefaults,
} from '../../shared/types'
import { ensureDaemonRunning } from '../daemon/manager'
import { daemonClient } from '../daemon/client'
import { log } from '../utils/logger.ts'

const wsLog = log.scope('workspace')
import { writeMCPConfigToWorkspace } from '../mcp-server'
import { applyWindowAppearance } from '../windowAppearance'
import { CODESURF_HOME } from '../paths'
import { ensureCodeSurfStructure } from '../session-sources'
import { validateGenerationProvider } from '../generation-provider-validation'
import { persistGenerationKeys, resolveGenerationKeys, setGenerationSecretStore } from '../generation-secrets'
import { getSecret, setSecret } from '../secrets'

const SETTINGS_PATH = join(CODESURF_HOME, 'settings.json')
const LEGACY_CONFIG_PATH = join(CODESURF_HOME, 'config.json')

// gap-03: inject the real keychain-backed store into the (electron-free,
// testable) generation-secrets module. Only stores function refs here;
// safeStorage is not touched until a settings handler actually runs.
setGenerationSecretStore({ getSecret, setSecret })

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

/** All project folders attached to a workspace (primary + projectPaths). */
export function extractWorkspaceProjectPaths(workspace: Workspace | null | undefined): string[] {
  if (!workspace) return []
  const paths = new Set<string>()
  const primary = extractWorkspacePrimaryPath(workspace)
  if (primary) paths.add(primary)
  if (Array.isArray(workspace.projectPaths)) {
    for (const projectPath of workspace.projectPaths) {
      const normalized = String(projectPath ?? '').trim()
      if (normalized) paths.add(normalized)
    }
  }
  if (workspace.path) {
    const legacyPath = String(workspace.path).trim()
    if (legacyPath) paths.add(legacyPath)
  }
  return [...paths]
}

export async function getAllWorkspaceProjectPaths(): Promise<string[]> {
  await ensureDaemonRunning()
  const workspaces = await daemonClient.listWorkspaces()
  const paths = new Set<string>()
  for (const workspace of workspaces) {
    for (const projectPath of extractWorkspaceProjectPaths(workspace)) {
      paths.add(path.resolve(projectPath))
    }
  }
  return [...paths]
}

export async function getWorkspaceProjectPathsById(workspaceId: string): Promise<string[]> {
  await ensureDaemonRunning()
  const workspaces = await daemonClient.listWorkspaces()
  const workspace = workspaces.find(entry => entry.id === workspaceId) ?? null
  return extractWorkspaceProjectPaths(workspace).map(projectPath => path.resolve(projectPath))
}

function normalizeSettingsDocument(raw: string): AppSettings {
  try {
    const parsed = JSON.parse(raw) as PersistedSettingsDocument | LegacyConfigDocument
    if (parsed && typeof parsed === 'object' && 'settings' in parsed) {
      return normalizeLoadedSettings(withDefaultSettings(parsed.settings ?? {}))
    }
  } catch {
    // fall through to defaults
  }
  return withFreshInstallDefaults()
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

let cachedSettings: AppSettings | null = null
let cachedSettingsMtimeMs = -1

export function readSettingsSync(): AppSettings {
  try {
    const mtimeMs = statSync(SETTINGS_PATH).mtimeMs
    if (cachedSettings && mtimeMs === cachedSettingsMtimeMs) return cachedSettings
    const parsed = normalizeLoadedSettings(normalizeSettingsDocument(readFileSync(SETTINGS_PATH, 'utf8')))
    cachedSettings = parsed
    cachedSettingsMtimeMs = mtimeMs
    return parsed
  } catch {
    cachedSettings = null
    cachedSettingsMtimeMs = -1
    try {
      return normalizeLoadedSettings(normalizeSettingsDocument(readFileSync(LEGACY_CONFIG_PATH, 'utf8')))
    } catch {
      return withFreshInstallDefaults()
    }
  }
}

/** One-time startup migration for legacy installs still on default-off FS scoping. */
export async function migrateFsScopingIfNeeded(): Promise<void> {
  try {
    await ensureDaemonRunning()
    const current = withDefaultSettings(await daemonClient.getSettings())
    const migrated = applyFsScopingMigration(applyNewInstallSecurityDefaults(current))
    if (
      migrated.security.restrictFsToWorkspaceRoots !== current.security.restrictFsToWorkspaceRoots
      || migrated.security.fsScopingMigrated !== current.security.fsScopingMigrated
    ) {
      await daemonClient.setSettings(migrated)
      // eslint-disable-next-line no-console
      wsLog.info('[SEC-03] migrated legacy install to workspace filesystem scoping')
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[SEC-03] FS scoping migration failed:', err)
  }
}

// gap-03: one-time startup migration. Existing installs may have plaintext
// generation keys in settings.json from before keychain storage; move them into
// the keychain so users who never reopen Settings are migrated too. Idempotent —
// a no-op once every key is already blanked/keychain-backed.
export async function migrateGenerationKeysToKeychain(): Promise<void> {
  try {
    await ensureDaemonRunning()
    const current = withDefaultSettings(await daemonClient.getSettings())
    const { settings: sanitized, migrated } = persistGenerationKeys(current)
    if (migrated > 0) {
      await daemonClient.setSettings(sanitized)
      // eslint-disable-next-line no-console
      wsLog.info(`[gap-03] migrated ${migrated} generation key(s) from settings.json into the keychain`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[gap-03] generation key migration failed:', err)
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

  ipcMain.handle('workspace:renameProject', async (_, args: { projectId?: string; projectPath?: string; name: string }) => {
    await ensureDaemonRunning()
    return await daemonClient.renameProject(args).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  })

  ipcMain.handle('workspace:createProjectWorktree', async (_, args: { projectId?: string; projectPath?: string; name: string; branch?: string }) => {
    await ensureDaemonRunning()
    return await daemonClient.createProjectWorktree(args).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
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
    // gap-03: settings.json stores generation keys as keychain-backed blanks;
    // re-fill them from the keychain for the renderer/consumers.
    return resolveGenerationKeys(withDefaultSettings(await daemonClient.getSettings()))
  })

  ipcMain.handle('settings:set', async (_, settings: AppSettings) => {
    await ensureDaemonRunning()
    // gap-03: move any plaintext generation key into the keychain and blank the
    // field before it is persisted; return resolved settings so the renderer's
    // settings view still shows the key.
    const { settings: sanitized } = persistGenerationKeys(withDefaultSettings(settings))
    const saved = withDefaultSettings(await daemonClient.setSettings(sanitized))
    await applySettingsSideEffects()
    return resolveGenerationKeys(saved)
  })

  ipcMain.handle('settings:getRawJson', async () => {
    await ensureDaemonRunning()
    return await daemonClient.getRawSettingsJson()
  })

  ipcMain.handle('settings:setRawJson', async (_, json: string) => {
    await ensureDaemonRunning()
    const result = await daemonClient.setRawSettingsJson(json)
    if (result.ok && result.settings) {
      // gap-03: a raw edit can reintroduce a plaintext generation key — migrate
      // it to the keychain and re-persist the blanked settings before returning.
      const { settings: sanitized, migrated } = persistGenerationKeys(withDefaultSettings(result.settings))
      if (migrated > 0) {
        await daemonClient.setSettings(sanitized)
      }
      await applySettingsSideEffects()
      return { ...result, settings: resolveGenerationKeys(sanitized) }
    }
    if (result.ok) {
      await applySettingsSideEffects()
    }
    return result
  })

  ipcMain.handle('settings:validateGenerationProvider', async (_, providerId: string, providerPatch?: Partial<AppSettings['generationProviders'][string]>) => {
    // gap-03: resolve keychain-backed keys so a saved (blanked) key still
    // validates when the renderer doesn't re-send it in the patch.
    const settings = resolveGenerationKeys(readSettingsSync())
    const provider = settings.generationProviders?.[providerId]
    if (!provider) {
      return {
        ok: false,
        providerId,
        message: `Provider "${providerId}" is not configured.`,
        models: [],
        imageModels: [],
        videoModels: [],
      }
    }
    return validateGenerationProvider({ ...provider, ...(providerPatch ?? {}), id: providerId })
  })

  ipcMain.handle('workspace:delete', async (_, id: string) => {
    await ensureDaemonRunning()
    await daemonClient.deleteWorkspace(id)
  })
}
