import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs, readFileSync } from 'fs'
import { join, resolve, basename, dirname } from 'path'
import { homedir } from 'os'
import type { Config, Workspace, AppSettings, ProjectRecord, WorkspaceRecord } from '../../shared/types'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../../shared/types'
import { writeMCPConfigToWorkspace } from '../mcp-server'
import { applyWindowAppearance } from '../windowAppearance'
import { CONTEX_HOME } from '../paths'
import { ensureCodeSurfStructure } from '../session-sources'

const CONTEX_DIR = CONTEX_HOME
const CONFIG_PATH = join(CONTEX_DIR, 'config.json')
const DEFAULT_WORKSPACES_DIR = join(homedir(), 'codesurf', 'workspaces')
const CONFIG_VERSION = 2 as const

type LegacyConfig = {
  workspaces?: Array<Partial<Workspace>>
  activeWorkspaceIndex?: number
  settings?: Partial<AppSettings>
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

function normalizePath(path: string | null | undefined): string {
  return String(path ?? '').trim().replace(/\/+$/, '')
}

function makeId(prefix: 'ws' | 'project'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function emptyConfig(): Config {
  return {
    version: CONFIG_VERSION,
    projects: [],
    workspaces: [],
    activeWorkspaceId: null,
    settings: { ...DEFAULT_SETTINGS },
  }
}

function isGeneratedWorkspaceShellPath(path: string | null | undefined): boolean {
  const normalized = normalizePath(path)
  if (!normalized) return false
  const parent = normalizePath(dirname(normalized))
  const base = basename(normalized)
  if (parent !== normalizePath(DEFAULT_WORKSPACES_DIR)) return false
  return base === 'default' || /^ws-\d{6,}(?:-[a-z0-9]+)?$/i.test(base)
}

function normalizeProject(project: Partial<ProjectRecord> | null | undefined): ProjectRecord | null {
  const id = String(project?.id ?? '').trim()
  const path = normalizePath(project?.path)
  if (!id || !path) return null

  return {
    id,
    name: String(project?.name ?? basename(path) ?? 'Project').trim() || basename(path) || 'Project',
    path,
  }
}

function normalizeWorkspaceRecord(workspace: Partial<WorkspaceRecord> | null | undefined): WorkspaceRecord | null {
  const id = String(workspace?.id ?? '').trim()
  if (!id) return null

  const projectIds = [...new Set(
    Array.isArray(workspace?.projectIds)
      ? workspace.projectIds.map(projectId => String(projectId ?? '').trim()).filter(Boolean)
      : [],
  )]

  const explicitPrimary = typeof workspace?.primaryProjectId === 'string'
    ? workspace.primaryProjectId.trim()
    : null
  const primaryProjectId = explicitPrimary && projectIds.includes(explicitPrimary)
    ? explicitPrimary
    : (projectIds[0] ?? null)

  return {
    id,
    name: String(workspace?.name ?? '').trim() || 'Workspace',
    projectIds,
    primaryProjectId,
  }
}

function pruneUnusedProjects(config: Config): Config {
  const referencedProjectIds = new Set(config.workspaces.flatMap(workspace => workspace.projectIds))
  return {
    ...config,
    projects: config.projects.filter(project => referencedProjectIds.has(project.id)),
  }
}

function materializeWorkspace(workspaceRecord: WorkspaceRecord, projectsById: Map<string, ProjectRecord>): Workspace {
  const projectEntries = workspaceRecord.projectIds
    .map(projectId => projectsById.get(projectId) ?? null)
    .filter((project): project is ProjectRecord => Boolean(project))

  const primaryProject = workspaceRecord.primaryProjectId
    ? (projectsById.get(workspaceRecord.primaryProjectId) ?? projectEntries[0] ?? null)
    : (projectEntries[0] ?? null)

  const projectPaths = projectEntries.map(project => project.path)

  return {
    id: workspaceRecord.id,
    name: workspaceRecord.name,
    path: primaryProject?.path ?? '',
    projectPaths,
  }
}

function materializeWorkspaces(config: Config): Workspace[] {
  const projectsById = new Map(config.projects.map(project => [project.id, project] as const))
  return config.workspaces.map(workspace => materializeWorkspace(workspace, projectsById))
}

function ensureProjectForPath(config: Config, folderPath: string): { config: Config; project: ProjectRecord } {
  const normalizedPath = normalizePath(folderPath)
  const existing = config.projects.find(project => normalizePath(project.path) === normalizedPath)
  if (existing) return { config, project: existing }

  const project: ProjectRecord = {
    id: makeId('project'),
    name: basename(normalizedPath) || 'Project',
    path: normalizedPath,
  }

  return {
    config: {
      ...config,
      projects: [...config.projects, project],
    },
    project,
  }
}

function migrateLegacyConfig(raw: LegacyConfig | null | undefined): Config {
  const settings = withDefaultSettings(raw?.settings ?? {})
  const config = emptyConfig()
  config.settings = settings

  const legacyWorkspaces = Array.isArray(raw?.workspaces) ? raw.workspaces : []
  for (const legacyWorkspace of legacyWorkspaces) {
    const id = String(legacyWorkspace?.id ?? '').trim() || makeId('ws')
    const name = String(legacyWorkspace?.name ?? '').trim() || 'Workspace'
    const candidatePaths = [
      ...(Array.isArray(legacyWorkspace?.projectPaths) ? legacyWorkspace.projectPaths : []),
      ...(typeof legacyWorkspace?.path === 'string' ? [legacyWorkspace.path] : []),
    ]

    const projectIds: string[] = []
    let nextConfig = config
    for (const candidatePath of candidatePaths) {
      const normalizedPath = normalizePath(candidatePath)
      if (!normalizedPath || isGeneratedWorkspaceShellPath(normalizedPath)) continue
      const ensured = ensureProjectForPath(nextConfig, normalizedPath)
      nextConfig = ensured.config
      if (!projectIds.includes(ensured.project.id)) projectIds.push(ensured.project.id)
    }

    config.projects = nextConfig.projects
    config.workspaces.push({
      id,
      name,
      projectIds,
      primaryProjectId: projectIds[0] ?? null,
    })
  }

  const activeWorkspaceIndex = Number.isInteger(raw?.activeWorkspaceIndex)
    ? Math.max(0, Number(raw?.activeWorkspaceIndex))
    : 0
  config.activeWorkspaceId = config.workspaces[activeWorkspaceIndex]?.id ?? config.workspaces[0]?.id ?? null

  return pruneUnusedProjects(config)
}

function normalizeConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') return emptyConfig()

  const maybeConfig = raw as Partial<Config>
  if (maybeConfig.version !== CONFIG_VERSION || !Array.isArray(maybeConfig.projects) || !Array.isArray(maybeConfig.workspaces)) {
    return migrateLegacyConfig(raw as LegacyConfig)
  }

  const settings = withDefaultSettings(maybeConfig.settings ?? {})
  const projects = (maybeConfig.projects ?? [])
    .map(project => normalizeProject(project))
    .filter((project): project is ProjectRecord => Boolean(project))
  const projectsById = new Map(projects.map(project => [project.id, project] as const))
  const workspaces = (maybeConfig.workspaces ?? [])
    .map(workspace => normalizeWorkspaceRecord(workspace))
    .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace))
    .map(workspace => ({
      ...workspace,
      projectIds: workspace.projectIds.filter(projectId => projectsById.has(projectId)),
      primaryProjectId: workspace.primaryProjectId && projectsById.has(workspace.primaryProjectId)
        ? workspace.primaryProjectId
        : (workspace.projectIds.find(projectId => projectsById.has(projectId)) ?? null),
    }))

  const activeWorkspaceId = typeof maybeConfig.activeWorkspaceId === 'string' && workspaces.some(workspace => workspace.id === maybeConfig.activeWorkspaceId)
    ? maybeConfig.activeWorkspaceId
    : (workspaces[0]?.id ?? null)

  return pruneUnusedProjects({
    version: CONFIG_VERSION,
    projects,
    workspaces,
    activeWorkspaceId,
    settings,
  })
}

async function readConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    return normalizeConfig(JSON.parse(raw))
  } catch {
    return emptyConfig()
  }
}

export function readSettingsSync(): AppSettings {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    return normalizeConfig(JSON.parse(raw)).settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function writeConfig(config: Config): Promise<void> {
  const normalized = normalizeConfig(config)
  await fs.writeFile(CONFIG_PATH, JSON.stringify(normalized, null, 2))
}

function getActiveWorkspaceRecord(config: Config): WorkspaceRecord | null {
  if (!config.activeWorkspaceId) return config.workspaces[0] ?? null
  return config.workspaces.find(workspace => workspace.id === config.activeWorkspaceId) ?? config.workspaces[0] ?? null
}

/** Filesystem path for a workspace id, materialized as its primary project folder. */
export async function getWorkspacePathById(workspaceId: string): Promise<string | null> {
  const config = await readConfig()
  const projectsById = new Map(config.projects.map(project => [project.id, project] as const))
  const workspace = config.workspaces.find(item => item.id === workspaceId)
  if (!workspace) return null
  return materializeWorkspace(workspace, projectsById).path || null
}

/**
 * Storage ids for a workspace.
 * Keep storage isolated per workspace id so canvas state is owned by the
 * workspace tab rather than any particular project folder.
 */
export async function getWorkspaceStorageIds(workspaceId: string): Promise<string[]> {
  return [workspaceId]
}

export async function initWorkspaces(): Promise<void> {
  await ensureDir(CONTEX_DIR)
  await ensureCodeSurfStructure()

  const config = await readConfig()
  await writeConfig(config)

  for (const project of config.projects) {
    const projectPath = project.path.startsWith('~') ? resolve(homedir(), project.path.slice(2)) : project.path
    if (!projectPath) continue
    await ensureDir(projectPath)
    await ensureCodeSurfStructure(projectPath)
  }
}

export function registerWorkspaceIPC(): void {
  ipcMain.handle('workspace:list', async () => {
    const config = await readConfig()
    return materializeWorkspaces(config)
  })

  ipcMain.handle('workspace:listProjects', async () => {
    const config = await readConfig()
    return [...config.projects].sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      if (nameCompare !== 0) return nameCompare
      return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
    })
  })

  ipcMain.handle('workspace:getActive', async () => {
    const config = await readConfig()
    const activeWorkspace = getActiveWorkspaceRecord(config)
    if (!activeWorkspace) return null
    const projectsById = new Map(config.projects.map(project => [project.id, project] as const))
    return materializeWorkspace(activeWorkspace, projectsById)
  })

  ipcMain.handle('workspace:create', async (_, name: string) => {
    const config = await readConfig()
    const workspaceRecord: WorkspaceRecord = {
      id: makeId('ws'),
      name: name.trim() || 'Workspace',
      projectIds: [],
      primaryProjectId: null,
    }
    config.workspaces.push(workspaceRecord)
    config.activeWorkspaceId = workspaceRecord.id
    await writeConfig(config)
    return materializeWorkspace(workspaceRecord, new Map(config.projects.map(project => [project.id, project] as const)))
  })

  ipcMain.handle('workspace:createWithPath', async (_, name: string, projectPath: string) => {
    let config = await readConfig()
    let projectIds: string[] = []

    const normalizedProjectPath = normalizePath(projectPath)
    if (normalizedProjectPath) {
      const ensured = ensureProjectForPath(config, normalizedProjectPath)
      config = ensured.config
      projectIds = [ensured.project.id]
      await ensureCodeSurfStructure(ensured.project.path)
      writeMCPConfigToWorkspace(ensured.project.path).catch(() => {})
    }

    const workspaceRecord: WorkspaceRecord = {
      id: makeId('ws'),
      name: name.trim() || 'Workspace',
      projectIds,
      primaryProjectId: projectIds[0] ?? null,
    }
    config.workspaces.push(workspaceRecord)
    config.activeWorkspaceId = workspaceRecord.id
    await writeConfig(config)
    return materializeWorkspace(workspaceRecord, new Map(config.projects.map(project => [project.id, project] as const)))
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
    let config = await readConfig()
    const index = config.workspaces.findIndex(workspace => workspace.id === workspaceId)
    if (index === -1) return null

    const ensured = ensureProjectForPath(config, folderPath)
    config = ensured.config

    const current = config.workspaces[index]
    const projectIds = current.projectIds.includes(ensured.project.id)
      ? current.projectIds
      : [...current.projectIds, ensured.project.id]

    config.workspaces[index] = {
      ...current,
      projectIds,
      primaryProjectId: current.primaryProjectId ?? ensured.project.id,
    }

    await ensureCodeSurfStructure(ensured.project.path)
    await writeConfig(config)
    writeMCPConfigToWorkspace(ensured.project.path).catch(() => {})

    return materializeWorkspace(config.workspaces[index], new Map(config.projects.map(project => [project.id, project] as const)))
  })

  ipcMain.handle('workspace:removeProjectFolder', async (_, workspaceId: string, folderPath: string) => {
    let config = await readConfig()
    const index = config.workspaces.findIndex(workspace => workspace.id === workspaceId)
    if (index === -1) return null

    const normalizedFolderPath = normalizePath(folderPath)
    const projectToRemove = config.projects.find(project => normalizePath(project.path) === normalizedFolderPath) ?? null
    if (!projectToRemove) return materializeWorkspace(config.workspaces[index], new Map(config.projects.map(project => [project.id, project] as const)))

    const current = config.workspaces[index]
    const projectIds = current.projectIds.filter(projectId => projectId !== projectToRemove.id)
    config.workspaces[index] = {
      ...current,
      projectIds,
      primaryProjectId: current.primaryProjectId === projectToRemove.id ? (projectIds[0] ?? null) : current.primaryProjectId,
    }

    config = pruneUnusedProjects(config)
    await writeConfig(config)
    return materializeWorkspace(config.workspaces[index], new Map(config.projects.map(project => [project.id, project] as const)))
  })

  ipcMain.handle('workspace:createFromFolder', async (_, folderPath: string) => {
    let config = await readConfig()
    const normalizedFolderPath = normalizePath(folderPath)
    const existingProject = config.projects.find(project => normalizePath(project.path) === normalizedFolderPath) ?? null
    const existingWorkspace = existingProject
      ? (config.workspaces.find(workspace => workspace.projectIds.includes(existingProject.id)) ?? null)
      : null

    if (existingWorkspace) {
      config.activeWorkspaceId = existingWorkspace.id
      await writeConfig(config)
      writeMCPConfigToWorkspace(normalizedFolderPath).catch(() => {})
      return materializeWorkspace(existingWorkspace, new Map(config.projects.map(project => [project.id, project] as const)))
    }

    const ensured = ensureProjectForPath(config, normalizedFolderPath)
    config = ensured.config
    const workspaceRecord: WorkspaceRecord = {
      id: makeId('ws'),
      name: basename(normalizedFolderPath) || 'Workspace',
      projectIds: [ensured.project.id],
      primaryProjectId: ensured.project.id,
    }

    config.workspaces.push(workspaceRecord)
    config.activeWorkspaceId = workspaceRecord.id
    await ensureCodeSurfStructure(ensured.project.path)
    await writeConfig(config)
    writeMCPConfigToWorkspace(ensured.project.path).catch(() => {})

    return materializeWorkspace(workspaceRecord, new Map(config.projects.map(project => [project.id, project] as const)))
  })

  ipcMain.handle('workspace:setActive', async (_, id: string) => {
    const config = await readConfig()
    const workspace = config.workspaces.find(item => item.id === id)
    if (!workspace) return

    config.activeWorkspaceId = workspace.id
    await writeConfig(config)

    const projectsById = new Map(config.projects.map(project => [project.id, project] as const))
    const materialized = materializeWorkspace(workspace, projectsById)
    if (materialized.path) {
      await ensureCodeSurfStructure(materialized.path)
      writeMCPConfigToWorkspace(materialized.path).catch(() => {})
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
    for (const win of BrowserWindow.getAllWindows()) {
      applyWindowAppearance(win)
    }
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
      await writeConfig(parsed as Config)
      const config = await readConfig()
      for (const win of BrowserWindow.getAllWindows()) {
        applyWindowAppearance(win)
      }
      return { ok: true, settings: config.settings }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('workspace:delete', async (_, id: string) => {
    let config = await readConfig()
    config = {
      ...config,
      workspaces: config.workspaces.filter(workspace => workspace.id !== id),
      activeWorkspaceId: config.activeWorkspaceId === id
        ? (config.workspaces.find(workspace => workspace.id !== id)?.id ?? null)
        : config.activeWorkspaceId,
    }
    config = pruneUnusedProjects(config)
    await writeConfig(config)
  })
}
