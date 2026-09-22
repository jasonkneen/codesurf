import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, watch as watchDirectory, type FSWatcher } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { ApplicationMenu, BrowserView, BrowserWindow, Utils } from 'electrobun/bun'
import type { CodeSurfElectrobunRPC } from '../../src/shared/electrobun-rpc.ts'
import type { AppSettings, ExecutionHostRecord, ExecutionPreference, ProjectRecord, Workspace, WorkspaceRecord } from '../../src/shared/types.ts'
import { DEFAULT_SETTINGS, normalizeLoadedSettings, withDefaultSettings, withFreshInstallDefaults } from '../../src/shared/types.ts'
import { buildOpenClawAgentArgs, buildOpenCodeRunArgs, sanitizeAgentCliDiagnostic } from '../../src/main/agents/agent-cli-contracts.ts'
import { CODESURF_HOME, WORKSPACES_DIR } from '../../src/main/paths.ts'
import {
  getDefaultElectrobunInvokeResponse,
  withElectrobunHostBootstrap,
} from '../../src/electrobun/browser/electron-facade.ts'
import {
  assertAuthorizedParentUnchanged,
  assertDirectoryNoFollow,
  assertPathMatchesAuthorization,
  assertSafeCardId,
  copyFileNoFollow,
  getUniqueCopyPath,
  isProbablyTextFile,
  readUtf8FilePrefixNoFollow,
  readUtf8FileNoFollow,
  statPathNoFollow,
  validateCanonicalFsPathDetails,
  writeUtf8FileNoFollow,
} from '../../src/main/ipc/fs.ts'
import { buildSafeSpawnEnv, isAllowedBinary } from '../../src/main/ipc/terminal-helpers.ts'
import type { ChatRequest } from '../../src/main/chat/types.ts'
import { tileContextChannel } from '../../src/shared/tileContextScope.ts'
import { acknowledgeThrough } from '../../src/main/agent-room/index.ts'
import {
  formatExtensionSidebarResponse,
  listExtensionsForBridge,
  scanExtensionManifests,
} from '../../src/main/extensions/light-scan.ts'
import { createElectrobunDbRuntime } from './runtime-db.ts'
import { builtInDaemonHosts, createElectrobunDaemonRuntime, sanitizeDaemonStatusError, summarizeDaemonDashboard } from './runtime-daemon.ts'
import { createClaudeStreamParser, createCodexStreamParser, parseOpenClawOutput, parseOpenCodeJsonLine, type ElectrobunStreamEvent } from './chat-streams.ts'
import {
  createElectrobunTileContextStore,
  invokeElectrobunTileContext,
} from './tile-context-runtime.ts'
import { ElectrobunTileStateRuntime } from './tile-state-runtime.ts'
import {
  type ElectrobunChatTurn,
} from './chat-room-lifecycle.ts'
import { ElectrobunChatRuntimeState } from './chat-runtime-state.ts'
import { loadElectrobunTrustedChatContext } from './trusted-context-runtime.ts'
import {
  buildClaudeStreamInput,
  insertCodexImageArgs,
  materializeVerifiedElectrobunImages,
  readVerifiedElectrobunImages,
  sweepStaleElectrobunImageDirectories,
} from './multimodal-runtime.ts'
import {
  ElectrobunOwnedAttachmentRegistry,
  issueElectrobunPickedAttachments,
  revokeElectrobunAttachmentSelections,
  writeElectrobunTempAttachment,
  type ElectrobunIssuedAttachment,
} from './attachment-capability-runtime.ts'
import { ElectrobunCodexStableContextRuntime } from './codex-stable-context-runtime.ts'
import {
  authorizeElectrobunFsPath,
  authorizeElectrobunTerminalPath,
  buildElectrobunClaudeSpawnArgs,
  buildElectrobunCodexSpawnArgs,
  buildElectrobunHermesSpawnArgs,
  buildElectrobunPersonaPrompt,
  canonicalizeElectrobunChatRequest,
  composeElectrobunProviderContext,
  prepareCanonicalElectrobunChatRequest,
  type ElectrobunChatRequest,
} from './trust-policy.ts'
import {
  galleryLocal as listPetsGalleryLocal,
  getPetManifest,
  installPet,
  listPets,
  removePet,
  spritesheetData as petSpritesheetData,
} from './runtime-pets.ts'

type WorkspacesDocument = {
  version?: number
  activeWorkspaceId?: string | null
  workspaces?: WorkspaceRecord[]
}

type ProjectsDocument = {
  version?: number
  projects?: ProjectRecord[]
}

type ElectrobunRPCInstance = typeof rpc

type LiveWindow = {
  win: BrowserWindow<ElectrobunRPCInstance>
  title: string
  fresh: boolean
}

type TerminalSession = {
  shell: string
  launchBin?: string
  launchArgs: string[]
  buffer: string
  cwd: string
  workspaceId: string | null
}

type PtyHostMessage = {
  type?: string
  tileId?: string
  data?: string
  error?: string
  exitCode?: number
  cols?: number
  rows?: number
  buffer?: string
}

type BusEvent = {
  channel: string
  type: string
  source: string
  payload?: unknown
  at: number
}

const RENDERER_DEV_URL = process.env.CODESURF_ELECTROBUN_RENDERER_URL ?? 'http://localhost:5173'
const RENDERER_BUNDLED_URL = 'views://mainview/index.html'
const BRIDGE_PRELOAD_URL = 'views://codesurf-electrobun/index.js'
const PROJECTS_PATH = join(CODESURF_HOME, 'projects', 'projects.json')
const FIRST_RUN_PROJECT_PATH = join(CODESURF_HOME, 'projects', 'electrobun-local')
const WORKSPACES_PATH = join(CODESURF_HOME, 'workspaces', 'workspaces.json')
const SETTINGS_PATH = join(CODESURF_HOME, 'settings.json')
const MCP_CONFIG_PATH = join(CODESURF_HOME, 'mcp-server.json')
const MAX_BUS_HISTORY = 500
const MAX_TERMINAL_BUFFER = 200_000
const dbRuntime = createElectrobunDbRuntime(CODESURF_HOME)
const daemonRuntime = createElectrobunDaemonRuntime(CODESURF_HOME)
const OPEN_CODE_FALLBACK_MODELS = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { id: 'openai/o4-mini', label: 'o4-mini' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
]
const SMOKE_FILE = process.env.CODESURF_ELECTROBUN_SMOKE_FILE ?? ''
const SMOKE_EXIT_AFTER_MS = Number(
  process.env.CODESURF_ELECTROBUN_SMOKE_EXIT_AFTER_MS
  ?? (process.env.CODESURF_ELECTROBUN_SMOKE === '1' ? '2500' : '0'),
)
const smokeStatusState: Record<string, unknown> = {}

const runtimeHost: ExecutionHostRecord = {
  id: 'electrobun-runtime',
  type: 'runtime',
  label: 'Electrobun Runtime',
  enabled: true,
}

async function listExecutionHostsFromDaemon(): Promise<ExecutionHostRecord[]> {
  try {
    await daemonRuntime.ensureRunning()
    const hosts = await daemonRuntime.request<ExecutionHostRecord[]>('/host/list')
    return Array.isArray(hosts) && hosts.length > 0 ? hosts : builtInDaemonHosts() as unknown as ExecutionHostRecord[]
  } catch {
    return builtInDaemonHosts() as unknown as ExecutionHostRecord[]
  }
}

async function resolveElectrobunExecutionTarget(preference: ExecutionPreference): Promise<{ host: ExecutionHostRecord, fallback: boolean, reason: string }> {
  const hosts = await listExecutionHostsFromDaemon()
  const daemonStatus = await daemonRuntime.status()
  const enabledHosts = hosts.filter(host => host.enabled !== false)
  const runtime = enabledHosts.find(host => host.type === 'runtime') ?? runtimeHost
  const localDaemon = enabledHosts.find(host => host.id === 'local-daemon' || host.type === 'local-daemon') ?? null
  const byId = new Map(enabledHosts.map(host => [host.id, host]))

  switch (preference?.mode) {
    case 'runtime-only':
      return { host: runtime, fallback: false, reason: 'Execution is pinned to the in-process runtime.' }
    case 'daemon-only':
      if (daemonStatus.running && localDaemon) return { host: localDaemon, fallback: false, reason: 'Execution requires the local daemon and it is available.' }
      return { host: runtime, fallback: true, reason: 'Local daemon is unavailable, so Electrobun fell back to the runtime.' }
    case 'specific-host': {
      const selected = preference.hostId ? byId.get(preference.hostId) : null
      if (selected) return { host: selected, fallback: false, reason: `Execution is pinned to ${selected.label}.` }
      if (daemonStatus.running && localDaemon) return { host: localDaemon, fallback: true, reason: 'Pinned host is missing or disabled, so execution fell back to the local daemon.' }
      return { host: runtime, fallback: true, reason: 'Pinned host is missing or disabled, so execution fell back to the runtime.' }
    }
    case 'prefer-local-daemon':
    case 'auto':
    default:
      if (daemonStatus.running && localDaemon) return { host: localDaemon, fallback: false, reason: 'Electrobun selected the live local daemon.' }
      return { host: runtime, fallback: true, reason: 'Local daemon is unavailable, so Electrobun fell back to the runtime.' }
  }
}

async function getDaemonSummaryForStatusBar() {
  try {
    const dashboard = await daemonRuntime.request<any>('/dashboard/api/jobs')
    const status = await daemonRuntime.status()
    return summarizeDaemonDashboard(dashboard, status)
  } catch (error) {
    const status = sanitizeDaemonStatusError(error)
    return {
      ...status,
      jobs: dbRuntime.getJobSummary(),
      dreaming: null,
    }
  }
}

const liveWindows = new Map<number, LiveWindow>()
const terminalSessions = new Map<string, TerminalSession>()
const ownedAttachmentDirectory = join(CODESURF_HOME, 'chat-attachments')
const codexImageDirectory = join(CODESURF_HOME, 'tmp', 'electrobun-images')
const ownedAttachments = new ElectrobunOwnedAttachmentRegistry(ownedAttachmentDirectory)
const chatRuntime = new ElectrobunChatRuntimeState(
  acknowledgeThrough,
  (scope, event) => broadcast('agent:stream', { ...scope, ...event }),
)
const codexStableContextRuntime = new ElectrobunCodexStableContextRuntime()
const busHistory = new Map<string, BusEvent[]>()
const tileStateRuntime = new ElectrobunTileStateRuntime(WORKSPACES_DIR)
const tileContext = createElectrobunTileContextStore({
  persistence: {
    load: (workspaceId, tileId) => tileStateRuntime.loadContext(workspaceId, tileId),
    save: (workspaceId, tileId, context) => tileStateRuntime.saveContext(workspaceId, tileId, context),
    delete: (workspaceId, tileId) => tileStateRuntime.delete(workspaceId, tileId),
  },
  onChanged: payload => {
    publishBus(
      tileContextChannel(payload.workspaceId, payload.tileId),
      'data',
      `tile:${payload.workspaceId}:${payload.tileId}`,
      { action: 'context_changed', ...payload },
    )
    broadcast('tileContext:changed', payload)
  },
})
const activityRecords = new Map<string, Record<string, unknown>>()
const fsWatchers = new Map<string, { watcher: FSWatcher, debounce: ReturnType<typeof setTimeout> | null }>()
let focusedWindowId = 1
let shellPathCache: string | null | undefined
let ptyHostProcess: ChildProcess | null = null
let ptyHostStdoutBuffer = ''
let defaultWorkspaceInitialization: Promise<Workspace[]> | null = null

function defaultWorkspace(): Workspace {
  return {
    id: 'electrobun-local',
    name: 'CodeSurf Workspace',
    path: FIRST_RUN_PROJECT_PATH,
    projectPaths: [FIRST_RUN_PROJECT_PATH],
  }
}

function safeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  const parent = dirname(filePath)
  const temporaryPath = join(parent, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await mkdir(parent, { recursive: true })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

async function writeSmokeStatus(phase: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!SMOKE_FILE) return
  Object.assign(smokeStatusState, payload)
  try {
    await writeJson(SMOKE_FILE, {
      ...smokeStatusState,
      phase,
      runtime: 'electrobun',
      pid: process.pid,
      platform: process.platform,
      at: new Date().toISOString(),
    })
  } catch (error) {
    console.warn('[Electrobun] smoke status write failed:', error)
  }
}

async function readProjectsDoc(): Promise<ProjectsDocument> {
  const doc = await readJson<ProjectsDocument>(PROJECTS_PATH, { version: 1, projects: [] })
  return { version: doc.version ?? 1, projects: Array.isArray(doc.projects) ? doc.projects : [] }
}

async function writeProjectsDoc(doc: ProjectsDocument): Promise<void> {
  await writeJson(PROJECTS_PATH, { version: doc.version ?? 1, projects: doc.projects ?? [] })
}

async function readWorkspacesDoc(): Promise<WorkspacesDocument> {
  const doc = await readJson<WorkspacesDocument>(WORKSPACES_PATH, { version: 1, activeWorkspaceId: null, workspaces: [] })
  return {
    version: doc.version ?? 1,
    activeWorkspaceId: doc.activeWorkspaceId ?? null,
    workspaces: Array.isArray(doc.workspaces) ? doc.workspaces : [],
  }
}

async function writeWorkspacesDoc(doc: WorkspacesDocument): Promise<void> {
  await writeJson(WORKSPACES_PATH, {
    version: doc.version ?? 1,
    activeWorkspaceId: doc.activeWorkspaceId ?? null,
    workspaces: doc.workspaces ?? [],
  })
}

async function listProjects(): Promise<ProjectRecord[]> {
  const doc = await readProjectsDoc()
  return doc.projects ?? []
}

function workspaceFromRecord(record: WorkspaceRecord, projectById: Map<string, ProjectRecord>): Workspace {
  const projectPaths = (record.projectIds ?? [])
    .map(id => projectById.get(id)?.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  const primaryPath = record.primaryProjectId ? projectById.get(record.primaryProjectId)?.path : null
  return {
    id: record.id,
    name: record.name,
    path: primaryPath ?? projectPaths[0] ?? '',
    projectPaths,
  }
}

async function initializeDefaultWorkspace(): Promise<Workspace[]> {
  // Re-read while holding the in-process single-flight. This avoids clobbering
  // a workspace persisted between the caller's empty read and initialization.
  const [workspaceDoc, projects] = await Promise.all([readWorkspacesDoc(), listProjects()])
  const projectById = new Map(projects.map(project => [project.id, project]))
  const records = Array.isArray(workspaceDoc.workspaces) ? workspaceDoc.workspaces : []
  const mapped = records.map(record => workspaceFromRecord(record, projectById))
  if (mapped.length > 0) return mapped

  // The renderer and daemon share these registries as their workspace trust
  // boundary. Persist the first-run fallback instead of exposing an in-memory
  // workspace id that the daemon cannot authorize for attachments and jobs.
  const fallback = defaultWorkspace()
  await mkdir(fallback.path, { recursive: true, mode: 0o700 })
  const project = await upsertProjectForPath(fallback.path)
  const record: WorkspaceRecord = {
    id: fallback.id,
    name: fallback.name,
    projectIds: [project.id],
    primaryProjectId: project.id,
  }
  await writeWorkspacesDoc({
    ...workspaceDoc,
    activeWorkspaceId: record.id,
    workspaces: [record],
  })
  return [workspaceFromRecord(record, new Map([[project.id, project]]))]
}

async function listWorkspaces(): Promise<Workspace[]> {
  const [workspaceDoc, projects] = await Promise.all([readWorkspacesDoc(), listProjects()])
  const projectById = new Map(projects.map(project => [project.id, project]))
  const records = Array.isArray(workspaceDoc.workspaces) ? workspaceDoc.workspaces : []
  const mapped = records.map(record => workspaceFromRecord(record, projectById))
  if (mapped.length > 0) return mapped

  if (!defaultWorkspaceInitialization) {
    defaultWorkspaceInitialization = initializeDefaultWorkspace()
  }
  try {
    return await defaultWorkspaceInitialization
  } catch (error) {
    defaultWorkspaceInitialization = null
    throw error
  }
}

async function getActiveWorkspace(): Promise<Workspace | null> {
  const [workspaceDoc, workspaces] = await Promise.all([readWorkspacesDoc(), listWorkspaces()])
  if (workspaceDoc.activeWorkspaceId) {
    const active = workspaces.find(workspace => workspace.id === workspaceDoc.activeWorkspaceId)
    if (active) return active
  }
  return workspaces[0] ?? null
}

async function setActiveWorkspace(id: string): Promise<boolean> {
  const workspace = (await listWorkspaces()).find(candidate => candidate.id === id)
  if (!workspace) throw new Error(`Workspace not found: ${id}`)
  const doc = await readWorkspacesDoc()
  doc.activeWorkspaceId = id
  await writeWorkspacesDoc(doc)
  broadcast('workspace:changed', { activeWorkspaceId: id })
  return true
}

async function upsertProjectForPath(projectPath: string): Promise<ProjectRecord> {
  const normalizedPath = (
    await validateCanonicalFsPathDetails(projectPath.trim(), 'directory')
  ).operationPath
  const doc = await readProjectsDoc()
  const existing = (doc.projects ?? []).find(project => project.path === normalizedPath)
  if (existing) return existing

  const project: ProjectRecord = {
    id: safeId('project'),
    name: basename(normalizedPath) || 'Project',
    path: normalizedPath,
  }
  doc.projects = [...(doc.projects ?? []), project]
  await writeProjectsDoc(doc)
  return project
}

async function createWorkspace(name: string, projectPath?: string | null): Promise<Workspace> {
  const trimmedName = name.trim() || (projectPath ? basename(projectPath) : 'Workspace') || 'Workspace'
  const project = projectPath ? await upsertProjectForPath(projectPath) : null
  const record: WorkspaceRecord = {
    id: safeId('workspace'),
    name: trimmedName,
    projectIds: project ? [project.id] : [],
    primaryProjectId: project?.id ?? null,
  }
  const doc = await readWorkspacesDoc()
  doc.workspaces = [...(doc.workspaces ?? []), record]
  doc.activeWorkspaceId = record.id
  await writeWorkspacesDoc(doc)
  const workspace = workspaceFromRecord(record, new Map(project ? [[project.id, project]] : []))
  broadcast('workspace:changed', { workspace })
  return workspace
}

async function addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
  const doc = await readWorkspacesDoc()
  const record = (doc.workspaces ?? []).find(item => item.id === workspaceId)
  if (!record) throw new Error(`Workspace not found: ${workspaceId}`)
  const project = await upsertProjectForPath(folderPath)
  const projects = await listProjects()
  const projectById = new Map(projects.map(item => [item.id, item]))
  projectById.set(project.id, project)
  record.projectIds = unique([...(record.projectIds ?? []), project.id])
  record.primaryProjectId = record.primaryProjectId ?? project.id
  await writeWorkspacesDoc(doc)
  const workspace = workspaceFromRecord(record, projectById)
  broadcast('workspace:changed', { workspace })
  return workspace
}

async function removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
  const projects = await listProjects()
  const project = projects.find(item => item.path === folderPath || item.id === folderPath)
  const doc = await readWorkspacesDoc()
  const record = (doc.workspaces ?? []).find(item => item.id === workspaceId)
  if (!record) throw new Error(`Workspace not found: ${workspaceId}`)
  if (!project) throw new Error(`Project not found: ${folderPath}`)
  record.projectIds = (record.projectIds ?? []).filter(id => id !== project.id)
  if (record.primaryProjectId === project.id) record.primaryProjectId = record.projectIds[0] ?? null
  await writeWorkspacesDoc(doc)
  const workspace = workspaceFromRecord(record, new Map(projects.map(item => [item.id, item])))
  broadcast('workspace:changed', { workspace })
  return workspace
}

async function deleteWorkspace(id: string): Promise<boolean> {
  const doc = await readWorkspacesDoc()
  if (!(doc.workspaces ?? []).some(item => item.id === id)) {
    throw new Error(`Workspace not found: ${id}`)
  }
  doc.workspaces = (doc.workspaces ?? []).filter(item => item.id !== id)
  if (doc.activeWorkspaceId === id) doc.activeWorkspaceId = doc.workspaces[0]?.id ?? null
  await writeWorkspacesDoc(doc)
  if (doc.workspaces.length === 0) defaultWorkspaceInitialization = null
  await rm(workspaceStorageDir(id), { recursive: true, force: true })
  broadcast('workspace:changed', { deletedWorkspaceId: id, activeWorkspaceId: doc.activeWorkspaceId ?? null })
  return true
}

async function renameProject(args: { projectId?: string, projectPath?: string, name?: string }): Promise<{ ok: boolean, project?: ProjectRecord, error?: string }> {
  const name = String(args.name ?? '').trim()
  if (!name) return { ok: false, error: 'Project name is required' }
  const doc = await readProjectsDoc()
  const project = (doc.projects ?? []).find(item => item.id === args.projectId || item.path === args.projectPath)
  if (!project) return { ok: false, error: 'Project not found' }
  project.name = name
  await writeProjectsDoc(doc)
  broadcast('workspace:changed', { project })
  return { ok: true, project }
}

// workspaceId/tileId come from the renderer and are interpolated into storage
// paths — reject segments that could escape the workspaces dir ('../../x').
function safeStorageSegment(value: string, label: string, fallback?: string): string {
  const segment = String(value ?? '').trim() || fallback || ''
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || segment.includes('\0')
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return segment
}

function workspaceStorageDir(workspaceId: string): string {
  return join(WORKSPACES_DIR, safeStorageSegment(workspaceId, 'workspaceId', 'default'))
}

async function loadCanvas(workspaceId: string): Promise<unknown | null> {
  return await readJson(join(workspaceStorageDir(workspaceId), 'canvas.json'), null)
}

async function saveCanvas(workspaceId: string, state: unknown): Promise<boolean> {
  await mkdir(workspaceStorageDir(workspaceId), { recursive: true })
  await writeFile(join(workspaceStorageDir(workspaceId), 'canvas.json'), JSON.stringify(state, null, 2))
  broadcast('canvas:saved', { workspaceId })
  return true
}

async function loadTileState(workspaceId: string, tileId: string): Promise<unknown | null> {
  return await tileStateRuntime.load(workspaceId || 'default', tileId)
}

async function saveTileState(workspaceId: string, tileId: string, state: unknown): Promise<boolean> {
  await tileStateRuntime.save(workspaceId || 'default', tileId, state)
  broadcast('canvas:sessionsChanged', { workspaceId, tileId })
  return true
}

function sessionTitleFromState(state: any): string {
  const explicit = typeof state?.title === 'string' ? state.title.trim() : ''
  if (explicit) return explicit.slice(0, 80)
  const messages = Array.isArray(state?.messages) ? state.messages : []
  const firstUser = messages.find((msg: any) => msg?.role === 'user' && typeof msg.content === 'string')
  const text = String(firstUser?.content ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 80) : 'CodeSurf session'
}

async function listSessions(workspaceId: string): Promise<unknown[]> {
  const tilesDir = join(workspaceStorageDir(workspaceId), 'tiles')
  let entries: Array<{ name: string, path: string, isFile: boolean }> = []
  try {
    entries = (await readdir(tilesDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => ({ name: entry.name, path: join(tilesDir, entry.name), isFile: true }))
  } catch {
    return []
  }

  const sessions: unknown[] = []
  for (const entry of entries) {
    const tileId = entry.name.replace(/\.json$/, '')
    const state = await readJson<any>(entry.path, null)
    const messages = Array.isArray(state?.messages) ? state.messages : []
    if (messages.length === 0) continue
    const fileInfo = await stat(entry.path).catch(() => null)
    const lastMessage = [...messages].reverse().find((msg: any) => typeof msg?.content === 'string' && msg.content.trim())
    sessions.push({
      id: `codesurf-tile:${workspaceId}:${tileId}`,
      source: 'codesurf',
      scope: 'workspace',
      tileId,
      sessionId: typeof state?.sessionId === 'string' ? state.sessionId : null,
      provider: typeof state?.provider === 'string' ? state.provider : 'codesurf',
      model: typeof state?.model === 'string' ? state.model : '',
      messageCount: messages.length,
      lastMessage: typeof lastMessage?.content === 'string' ? lastMessage.content.slice(0, 160) : null,
      updatedAt: fileInfo?.mtimeMs ?? Date.now(),
      sizeBytes: fileInfo?.size ?? 0,
      filePath: entry.path,
      title: sessionTitleFromState(state),
      projectPath: null,
      sourceLabel: 'CodeSurf',
      sourceDetail: 'Electrobun local tile state',
      canOpenInChat: true,
      canOpenInApp: true,
    })
  }

  return sessions.sort((a: any, b: any) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
}

async function getSessionState(workspaceId: string, entryId: string): Promise<unknown | null> {
  const direct = await loadTileState(workspaceId, entryId)
  if (direct) return direct
  const parts = String(entryId).split(':')
  const tileId = parts.length >= 3 ? parts[parts.length - 1] : entryId
  return await loadTileState(workspaceId, tileId)
}

async function appendQueuedMessageEvent(payload: any): Promise<boolean> {
  const workspaceId = String(payload?.workspaceId ?? 'default')
  const dir = workspaceStorageDir(workspaceId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'queued-messages.jsonl'), `${JSON.stringify({ ...payload, at: payload?.at ?? Date.now() })}\n`, { flag: 'a' })
  return true
}

async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await readJson<{ settings?: Partial<typeof DEFAULT_SETTINGS> } | Partial<typeof DEFAULT_SETTINGS>>(SETTINGS_PATH, DEFAULT_SETTINGS)
    if (raw && typeof raw === 'object' && 'settings' in raw) {
      return normalizeLoadedSettings(withDefaultSettings(raw.settings ?? {}))
    }
    return normalizeLoadedSettings(withDefaultSettings(raw as Partial<typeof DEFAULT_SETTINGS>))
  } catch {
    return withFreshInstallDefaults()
  }
}

async function writeSettings(settings: unknown): Promise<unknown> {
  const next = withDefaultSettings((settings ?? {}) as Partial<typeof DEFAULT_SETTINGS>)
  await writeJson(SETTINGS_PATH, { version: 1, settings: next })
  broadcast('appearance:updated', { shouldUseDark: true })
  return next
}

async function workspaceAuthority() {
  const [settings, workspaces] = await Promise.all([readSettings(), listWorkspaces()])
  return { settings, workspaces }
}

async function authorizeFsPath(
  filePath: string,
  intent: 'read' | 'create' | 'write' | 'delete-link' | 'directory',
  workspaceId?: unknown,
  allowReadOnlyOpenCodeConfig = false,
) {
  return await authorizeElectrobunFsPath({
    ...(await workspaceAuthority()),
    filePath,
    intent,
    workspaceId,
    allowReadOnlyOpenCodeConfig,
  })
}

function fsWatchKey(dirPath: string, workspaceId: unknown): string {
  return `${typeof workspaceId === 'string' ? workspaceId : ''}\0${dirPath}`
}

async function readDirEntries(dirPath: string): Promise<Array<{ name: string, path: string, isDirectory: boolean, isFile: boolean }>> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.map(entry => ({
      name: entry.name,
      path: join(dirPath, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function statPath(filePath: string): Promise<{ isFile: boolean, isDirectory: boolean, size: number, mtimeMs: number } | null> {
  try {
    const info = await stat(filePath)
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      size: info.size,
      mtimeMs: info.mtimeMs,
    }
  } catch {
    return null
  }
}

function broadcast(channel: string, payload?: unknown): void {
  for (const live of liveWindows.values()) {
    live.win.webview?.rpc?.send.event({ channel, payload })
  }
}

function publishBus(channel: string, type: string, source: string, payload?: unknown): void {
  const event: BusEvent = { channel, type, source, payload, at: Date.now() }
  const history = busHistory.get(channel) ?? []
  history.push(event)
  if (history.length > MAX_BUS_HISTORY) history.splice(0, history.length - MAX_BUS_HISTORY)
  busHistory.set(channel, history)
  broadcast('bus:event', event)
}

function windowList(): Array<{ id: number, title: string, focused: boolean }> {
  return [...liveWindows.entries()].map(([id, live]) => ({
    id,
    title: live.title,
    focused: id === focusedWindowId,
  }))
}

function broadcastWindowList(): void {
  broadcast('window:list-changed', windowList())
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || (existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
}

function getShellEnvPath(): string | null {
  if (shellPathCache !== undefined) return shellPathCache
  const shell = defaultShell()
  try {
    shellPathCache = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 3000 }).trim() || null
  } catch {
    shellPathCache = null
  }
  return shellPathCache
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const shellPath = getShellEnvPath()
  return buildSafeSpawnEnv({ ...(shellPath ? { PATH: shellPath } : {}), ...extra })
}

function resolvePtyHostPath(): string | null {
  const candidates = [
    join(process.cwd(), 'electrobun', 'helpers', 'pty-host.cjs'),
    join(process.cwd(), 'helpers', 'pty-host.cjs'),
    join(dirname(new URL(import.meta.url).pathname), '..', 'helpers', 'pty-host.cjs'),
    join(dirname(new URL(import.meta.url).pathname), 'helpers', 'pty-host.cjs'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function handlePtyHostMessage(message: PtyHostMessage): void {
  const tileId = String(message.tileId ?? '')
  if (message.type === 'data' && tileId) {
    const session = terminalSessions.get(tileId)
    const data = String(message.data ?? '')
    if (session) session.buffer = (session.buffer + data).slice(-MAX_TERMINAL_BUFFER)
    broadcast(`terminal:data:${tileId}`, data)
    return
  }
  if (message.type === 'active' && tileId) {
    broadcast(`terminal:active:${tileId}`)
    return
  }
  if (message.type === 'exit' && tileId) {
    terminalSessions.delete(tileId)
    const exitCode = Number(message.exitCode ?? 0)
    // Must match Electron terminal:exit:${tileId} so TerminalTile onExit fires
    // (facade maps window.electron.terminal.onExit → this channel).
    broadcast(`terminal:exit:${tileId}`, exitCode)
    broadcast(`terminal:data:${tileId}`, `\r\n[process exited ${exitCode}]\r\n`)
    publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'exited', exitCode })
    return
  }
  if (message.type === 'error') {
    const error = String(message.error ?? 'PTY host error')
    if (tileId) broadcast(`terminal:data:${tileId}`, `\r\n\x1b[31m${error}\x1b[0m\r\n`)
    else console.warn('[Electrobun PTY host]', error)
  }
}

function ensurePtyHost(): ChildProcess | null {
  if (ptyHostProcess && !ptyHostProcess.killed) return ptyHostProcess
  const helperPath = resolvePtyHostPath()
  const nodeBin = resolveCommand('node', 'NODE_BIN')
  if (!helperPath || !nodeBin) {
    console.warn('[Electrobun] PTY host unavailable', { helperPath, nodeBin })
    return null
  }

  const proc = spawn(nodeBin, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(),
  })
  ptyHostProcess = proc
  ptyHostStdoutBuffer = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    ptyHostStdoutBuffer += chunk.toString()
    const lines = ptyHostStdoutBuffer.split(/\r?\n/)
    ptyHostStdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { handlePtyHostMessage(JSON.parse(line) as PtyHostMessage) }
      catch { console.warn('[Electrobun] Ignoring malformed PTY host line:', line) }
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.warn('[Electrobun PTY host stderr]', text)
  })
  proc.on('close', () => {
    ptyHostProcess = null
    for (const tileId of [...terminalSessions.keys()]) {
      broadcast(`terminal:exit:${tileId}`, 1)
      broadcast(`terminal:data:${tileId}`, '\r\n\x1b[31mPTY host stopped\x1b[0m\r\n')
      publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'exited', exitCode: 1 })
    }
    terminalSessions.clear()
  })
  return proc
}

function sendPtyHost(message: Record<string, unknown>): boolean {
  const host = ensurePtyHost()
  if (!host?.stdin?.writable) return false
  host.stdin.write(`${JSON.stringify(message)}\n`)
  return true
}

function stopPtyHost(): void {
  const host = ptyHostProcess
  ptyHostProcess = null
  ptyHostStdoutBuffer = ''
  terminalSessions.clear()
  if (!host || host.killed) return
  try { host.stdin?.end() } catch { /* ignore */ }
  try { host.kill('SIGTERM') } catch { /* ignore */ }
}

async function stopAllChatProcesses(): Promise<boolean> {
  const results = await chatRuntime.stopAll()
  return results.every(result => result.confirmed)
}

function stopAllFsWatchers(): void {
  for (const entry of fsWatchers.values()) {
    if (entry.debounce) clearTimeout(entry.debounce)
    entry.watcher.close()
  }
  fsWatchers.clear()
}

let runtimeShutdown: Promise<boolean> | null = null

function shutdownRuntimeChildren(): Promise<boolean> {
  if (runtimeShutdown) return runtimeShutdown
  runtimeShutdown = (async () => {
    stopPtyHost()
    const chatStopped = await stopAllChatProcesses()
    await ownedAttachments.dispose()
    stopAllFsWatchers()
    return chatStopped
  })()
  return runtimeShutdown
}

function forceShutdownRuntimeChildren(): void {
  stopPtyHost()
  chatRuntime.forceStopAll()
  stopAllFsWatchers()
}

async function createTerminal(tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]): Promise<{ cols: number, rows: number, buffer: string }> {
  const existing = terminalSessions.get(tileId)
  const requestedArgs = Array.isArray(launchArgs) ? [...launchArgs] : []
  const launchChanged = launchBin !== undefined && (
    existing?.launchBin !== launchBin
    || existing.launchArgs.length !== requestedArgs.length
    || existing.launchArgs.some((value, index) => value !== requestedArgs[index])
  )
  if (existing && !launchChanged) return { cols: 80, rows: 24, buffer: existing.buffer }
  if (existing) {
    sendPtyHost({ type: 'destroy', tileId })
    terminalSessions.delete(tileId)
  }

  const authorized = await authorizeElectrobunTerminalPath({
    ...(await workspaceAuthority()),
    filePath: workspaceDir,
  })
  workspaceDir = authorized.path.operationPath
  if (launchBin && !isAllowedBinary(launchBin)) launchBin = undefined
  const shell = launchBin || defaultShell()
  const args = launchBin ? requestedArgs : []
  const session: TerminalSession = {
    shell,
    launchBin,
    launchArgs: launchBin ? requestedArgs : [],
    buffer: '',
    cwd: workspaceDir,
    workspaceId: authorized.workspaceId,
  }
  terminalSessions.set(tileId, session)
  publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'created', workspaceDir, runtime: 'electrobun-node-pty-host' })

  const ok = sendPtyHost({ type: 'create', tileId, cwd: workspaceDir, shell, args, env: { PATH: childEnv().PATH ?? '' } })
  if (!ok) {
    const error = 'PTY host is unavailable. Node or electrobun/helpers/pty-host.cjs could not be found.'
    broadcast(`terminal:data:${tileId}`, `\r\n\x1b[31m${error}\x1b[0m\r\n`)
    terminalSessions.delete(tileId)
    throw new Error(error)
  }

  return { cols: 80, rows: 24, buffer: '' }
}

function cdCommand(shell: string, dirPath: string): string {
  const shellBase = shell.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (shellBase === 'cmd.exe') return `cd /d "${dirPath.replace(/"/g, '""')}"`
  if (shellBase === 'powershell.exe' || shellBase === 'pwsh.exe') return `Set-Location -LiteralPath '${dirPath.replace(/'/g, "''")}'`
  return `cd '${dirPath.replace(/'/g, "'\\''")}'`
}

async function stopChat(scope: Pick<ElectrobunChatTurn, 'workspaceId' | 'cardId'>) {
  return await chatRuntime.stop(scope)
}

function broadcastChatStream(
  scope: Pick<ElectrobunChatTurn, 'workspaceId' | 'cardId'>,
  event: Record<string, unknown>,
): void {
  chatRuntime.sendDirect(scope, event)
}

function sendStream(turn: ElectrobunChatTurn, event: Record<string, unknown>): void {
  chatRuntime.send(turn, event)
}

function sendParsedStreamEvents(
  turn: ElectrobunChatTurn,
  provider: string,
  events: ElectrobunStreamEvent[],
): void {
  for (const event of events) {
    if (event.type === 'session') {
      chatRuntime.setSession(turn, provider, event.sessionId)
    }
    sendStream(turn, event)
  }
}

function lastUserMessage(req: ChatRequest): string | null {
  const messages = Array.isArray(req.expandedMessages) && req.expandedMessages.length > 0
    ? req.expandedMessages
    : Array.isArray(req.messages) ? req.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) return message.content
  }
  return null
}

function resolveCommand(command: string, envName?: string): string | null {
  const fromEnv = envName ? process.env[envName] : null
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (command.includes('/') && existsSync(command)) return command
  try {
    const shell = defaultShell()
    const resolved = execFileSync(shell, ['-lc', `command -v ${JSON.stringify(command)}`], {
      env: childEnv(),
      encoding: 'utf8',
      timeout: 3000,
    }).trim()
    return resolved || null
  } catch {
    return null
  }
}

function rejectUnsupportedImageAttachments(request: ChatRequest, provider: string): void {
  if ((request.imageAttachments?.length ?? 0) > 0) {
    throw new Error(`${provider} image attachments are not supported by the Electrobun runtime; use Claude or Codex.`)
  }
}

const detachedChatProcess = process.platform !== 'win32'

async function runHermesChat(req: ChatRequest, prompt: string, turn: ElectrobunChatTurn): Promise<{ ok: boolean, error?: string }> {
  const provider = 'hermes'
  rejectUnsupportedImageAttachments(req, 'Hermes')
  const hermesBin = resolveCommand('hermes', 'HERMES_BIN')
  if (!hermesBin) {
    const error = 'Hermes CLI not found. Install: pip install hermes-agent, or set HERMES_BIN.'
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }

  const args = buildElectrobunHermesSpawnArgs(
    req,
    prompt,
    req.sessionId ?? chatRuntime.getSession(turn, provider),
  )
  const cwd = req.workspaceDir
  const proc = spawn(hermesBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
    cwd,
    detached: detachedChatProcess,
  })
  if (!await chatRuntime.registerProcess(turn, proc)) {
    return { ok: false, error: 'Chat turn was superseded before Hermes started' }
  }
  const acceptedSpawn = chatRuntime.waitForAcceptedSpawn(
    proc,
    'Hermes CLI not found. Install: pip install hermes-agent, or set HERMES_BIN.',
  )

  let partial = ''
  chatRuntime.streamProcess(turn, proc, {
    missingBinaryMessage: 'Hermes CLI not found. Install: pip install hermes-agent, or set HERMES_BIN.',
    onStdoutText: (text) => {
      partial += text
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.trim().match(/^(?:session_id|session)\s*:\s*(\S+)$/i)
        if (match?.[1]) {
          chatRuntime.setSession(turn, provider, match[1])
          sendStream(turn, { type: 'session', sessionId: match[1] })
          continue
        }
        if (line) sendStream(turn, { type: 'text', text: `${line}\n` })
      }
    },
    onClose: (code, stderr) => {
      if (partial.trim()) sendStream(turn, { type: 'text', text: partial })
      if (code !== 0) sendStream(turn, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim() || `Hermes exited with ${code}`) })
    },
  })

  return await acceptedSpawn
}

async function runClaudeChat(req: ChatRequest, prompt: string, turn: ElectrobunChatTurn): Promise<{ ok: boolean, error?: string }> {
  const provider = 'claude'
  const claudeBin = resolveCommand('claude', 'CLAUDE_BIN')
  if (!claudeBin) {
    const error = 'Claude CLI not found. Install Claude Code, or set CLAUDE_BIN.'
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }

  const resumeSessionId = req.sessionId ?? chatRuntime.getSession(turn, provider)
  const images = await readVerifiedElectrobunImages(req.imageAttachments)
  const streamInput = images.length > 0
  const args = buildElectrobunClaudeSpawnArgs(req, prompt, resumeSessionId, { streamInput })

  const cwd = req.workspaceDir
  const proc = spawn(claudeBin, args, {
    stdio: [streamInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: childEnv(),
    cwd,
    detached: detachedChatProcess,
  })
  if (!await chatRuntime.registerProcess(turn, proc)) {
    return { ok: false, error: 'Chat turn was superseded before Claude started' }
  }
  const acceptedSpawn = chatRuntime.waitForAcceptedSpawn(
    proc,
    'Claude CLI not found. Install Claude Code, or set CLAUDE_BIN.',
  )

  const parser = createClaudeStreamParser()
  chatRuntime.streamProcess(turn, proc, {
    missingBinaryMessage: 'Claude CLI not found. Install Claude Code, or set CLAUDE_BIN.',
    onStdoutLine: (line) => sendParsedStreamEvents(turn, provider, parser.parseLine(line)),
    onClose: (code, stderr) => {
      if (code !== 0) sendStream(turn, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim() || `Claude exited with ${code}`) })
    },
  })
  if (streamInput) {
    const userContent = composeElectrobunProviderContext(req, prompt).userContent
    proc.stdin?.end(buildClaudeStreamInput(userContent, images))
  }

  return await acceptedSpawn
}

async function runOpenCodeChat(req: ChatRequest, prompt: string, turn: ElectrobunChatTurn): Promise<{ ok: boolean, error?: string }> {
  const provider = 'opencode'
  rejectUnsupportedImageAttachments(req, 'OpenCode')
  const opencodeBin = resolveCommand('opencode', 'OPENCODE_BIN')
  if (!opencodeBin) {
    const error = 'OpenCode CLI not found. Install opencode, or set OPENCODE_BIN.'
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }

  const args = buildOpenCodeRunArgs({
    prompt: buildElectrobunPersonaPrompt(prompt, req),
    model: req.model,
    sessionId: req.sessionId ?? chatRuntime.getSession(turn, provider),
    cwd: req.workspaceDir,
    bypassPermissions: req.mode === 'full-access' || req.mode === 'bypassPermissions',
  })

  const cwd = req.workspaceDir
  const proc = spawn(opencodeBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
    cwd,
    detached: detachedChatProcess,
  })
  if (!await chatRuntime.registerProcess(turn, proc)) {
    return { ok: false, error: 'Chat turn was superseded before OpenCode started' }
  }
  const acceptedSpawn = chatRuntime.waitForAcceptedSpawn(
    proc,
    'OpenCode CLI not found. Install opencode, or set OPENCODE_BIN.',
  )

  chatRuntime.streamProcess(turn, proc, {
    missingBinaryMessage: 'OpenCode CLI not found. Install opencode, or set OPENCODE_BIN.',
    onStdoutLine: (line) => sendParsedStreamEvents(turn, provider, parseOpenCodeJsonLine(line)),
    onClose: (code, stderr) => {
      if (code !== 0) sendStream(turn, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim() || `OpenCode exited with ${code}`) })
    },
  })

  return await acceptedSpawn
}

function normalizeModelRef(model?: string | null): string {
  return (model ?? '').trim().toLowerCase()
}

function parseOpenClawAgents(openclawBin: string): Array<{ id: string, name?: string, model?: string, isDefault?: boolean }> {
  try {
    const raw = execFileSync(openclawBin, ['agents', 'list', '--json'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 10_000,
    }).trim()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function listOpenClawAgentOptions(): { agents: Array<{ id: string, label: string, description?: string }>, source: string } {
  const openclawBin = resolveCommand('openclaw', 'OPENCLAW_BIN')
  if (!openclawBin) return { agents: [], source: 'missing-openclaw-cli' }
  const agents = parseOpenClawAgents(openclawBin).map(agent => ({
    id: agent.id,
    label: agent.name ? `${agent.name}${agent.isDefault ? ' (default)' : ''}` : `${agent.id}${agent.isDefault ? ' (default)' : ''}`,
    description: agent.model ?? agent.id,
  }))
  return { agents, source: 'openclaw-cli' }
}

function selectOpenClawAgentId(openclawBin: string, preferredModel?: string | null): string | null {
  const agents = parseOpenClawAgents(openclawBin)
  if (agents.length === 0) return 'main'

  const requested = normalizeModelRef(preferredModel)
  const isStable = (id: string): boolean => !id.startsWith('mc-gateway-') && !/^lead-[0-9a-f-]+$/i.test(id)

  if (requested) {
    const directStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.id) === requested)
    if (directStable) return directStable.id

    const directAny = agents.find(agent => normalizeModelRef(agent.id) === requested)
    if (directAny) return directAny.id

    const exactStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.model) === requested)
    if (exactStable) return exactStable.id

    const exactAny = agents.find(agent => normalizeModelRef(agent.model) === requested)
    if (exactAny) return exactAny.id

    return null
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

async function runOpenClawChat(req: ChatRequest, prompt: string, turn: ElectrobunChatTurn): Promise<{ ok: boolean, error?: string }> {
  const provider = 'openclaw'
  rejectUnsupportedImageAttachments(req, 'OpenClaw')
  const openclawBin = resolveCommand('openclaw', 'OPENCLAW_BIN')
  if (!openclawBin) {
    const error = 'OpenClaw CLI not found. Install: npm install -g openclaw, or set OPENCLAW_BIN.'
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }

  const existingSessionId = req.sessionId ?? chatRuntime.getSession(turn, provider)
  const selectedAgentId = existingSessionId ? null : selectOpenClawAgentId(openclawBin, req.model)
  if (!existingSessionId && req.model && !selectedAgentId) {
    const available = parseOpenClawAgents(openclawBin)
      .map(agent => agent.model || agent.id)
      .filter((value, index, all): value is string => typeof value === 'string' && value.trim().length > 0 && all.indexOf(value) === index)
    const details = available.length > 0 ? ` Available: ${available.join(', ')}` : ''
    const error = `OpenClaw model must match exactly: ${req.model}.${details}`
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }

  const thinkingMap: Record<string, string> = {
    none: 'off',
    low: 'minimal',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
    adaptive: 'medium',
  }
  const args = buildOpenClawAgentArgs({
    prompt: buildElectrobunPersonaPrompt(prompt, req),
    agentId: selectedAgentId ?? 'main',
    sessionId: existingSessionId,
    thinking: thinkingMap[req.thinking ?? ''] ?? null,
    local: true,
  })

  const cwd = req.workspaceDir
  const proc = spawn(openclawBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
    cwd,
    detached: detachedChatProcess,
  })
  if (!await chatRuntime.registerProcess(turn, proc)) {
    return { ok: false, error: 'Chat turn was superseded before OpenClaw started' }
  }
  const acceptedSpawn = chatRuntime.waitForAcceptedSpawn(
    proc,
    'OpenClaw CLI not found. Install: npm install -g openclaw, or set OPENCLAW_BIN.',
  )

  let stdout = ''
  chatRuntime.streamProcess(turn, proc, {
    missingBinaryMessage: 'OpenClaw CLI not found. Install: npm install -g openclaw, or set OPENCLAW_BIN.',
    onStdoutText: text => { stdout += text },
    onClose: (code, stderr) => {
      if (code !== 0) {
        sendStream(turn, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim() || stdout.trim() || `OpenClaw exited with ${code}`) })
        return
      }
      sendParsedStreamEvents(turn, provider, parseOpenClawOutput(stdout))
    },
  })

  return await acceptedSpawn
}

async function runCodexChat(req: ChatRequest, prompt: string, turn: ElectrobunChatTurn): Promise<{ ok: boolean, error?: string }> {
  const provider = 'codex'
  const codexBin = resolveCommand('codex', 'CODEX_BIN')
  if (!codexBin) {
    const error = 'Codex CLI not found. Install: npm install -g @openai/codex, or set CODEX_BIN.'
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }

  const workspaceDir = req.workspaceDir
  if (!workspaceDir) {
    const error = 'The authoritative workspace root is unavailable.'
    sendStream(turn, { type: 'error', error })
    sendStream(turn, { type: 'done' })
    return { ok: false, error }
  }
  const resumeThreadId = req.sessionId ?? chatRuntime.getSession(turn, provider)
  const prepared = codexStableContextRuntime.prepare(
    req,
    prompt,
    workspaceDir,
    { workspaceId: turn.workspaceId, cardId: turn.cardId },
    resumeThreadId,
  )
  const args = prepared.args
  const resumeIndex = args.indexOf('resume')
  args.splice(resumeIndex >= 0 ? resumeIndex : args.length - 1, 0, '-c', 'mcp_servers={}')
  let materialized: Awaited<ReturnType<typeof materializeVerifiedElectrobunImages>> | null = null
  let proc: ChildProcess
  try {
    const images = await readVerifiedElectrobunImages(req.imageAttachments)
    materialized = images.length > 0
      ? await materializeVerifiedElectrobunImages(images, codexImageDirectory)
      : null
    const spawnArgs = insertCodexImageArgs(args, materialized?.paths ?? [])
    proc = spawn(codexBin, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
      cwd: workspaceDir,
      detached: detachedChatProcess,
    })
  } catch (error) {
    codexStableContextRuntime.invalidate(prepared)
    await materialized?.cleanup()
    throw error
  }
  proc.once('error', () => {
    codexStableContextRuntime.invalidate(prepared)
  })
  if (materialized) {
    proc.once('close', () => { void materialized.cleanup() })
    proc.once('error', () => { void materialized.cleanup() })
  }
  if (!await chatRuntime.registerProcess(turn, proc)) {
    codexStableContextRuntime.invalidate(prepared)
    await materialized?.cleanup()
    return { ok: false, error: 'Chat turn was superseded before Codex started' }
  }
  const acceptedSpawn = chatRuntime.waitForAcceptedSpawn(
    proc,
    'Codex CLI not found. Install: npm install -g @openai/codex, or set CODEX_BIN.',
  )

  const parser = createCodexStreamParser()
  let providerSessionId = resumeThreadId ?? null
  let sawProviderAcceptance = false
  let providerError = false
  chatRuntime.streamProcess(turn, proc, {
    missingBinaryMessage: 'Codex CLI not found. Install: npm install -g @openai/codex, or set CODEX_BIN.',
    onStdoutLine: (line) => {
      const events = parser.parseLine(line)
      for (const event of events) {
        if (event.type === 'session') providerSessionId = event.sessionId
        if (event.type === 'prompt_accepted') sawProviderAcceptance = true
        if (event.type === 'error') providerError = true
      }
      sendParsedStreamEvents(turn, provider, events)
    },
    onClose: (code, stderr) => {
      codexStableContextRuntime.complete(prepared, {
        exitCode: code,
        sawProviderAcceptance,
        providerError,
        sessionId: providerSessionId ?? chatRuntime.getSession(turn, provider),
      })
      if (code !== 0) sendStream(turn, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim() || `Codex exited with ${code}`) })
    },
  })

  const accepted = await acceptedSpawn
  if (!accepted.ok) codexStableContextRuntime.invalidate(prepared)
  return accepted
}

async function sendChat(rawRequest: ElectrobunChatRequest): Promise<{ ok: boolean, error?: string, jobId?: string }> {
  const cardId = String(rawRequest.cardId ?? '')
  if (!cardId) return { ok: false, error: 'missing cardId' }
  let canonical: ChatRequest
  try {
    canonical = await canonicalizeElectrobunChatRequest(rawRequest, await listWorkspaces())
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  let turn: ElectrobunChatTurn
  try {
    // The scope is authoritative now. Supersede and fully terminate the prior
    // foreground turn before any slower context loading or capability redemption.
    turn = await chatRuntime.start(canonical)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  let req: ChatRequest
  let consumedAttachmentCapabilities: string[] = []
  try {
    req = await prepareCanonicalElectrobunChatRequest(
      canonical,
      rawRequest.peers,
      async request => {
        const trusted = await loadElectrobunTrustedChatContext(request, {
          request: async <T>(path: string, options?: { body?: unknown }): Promise<T> => {
            const response = await daemonRuntime.request<T>(path, options)
            if (path === '/file-references/expand') {
              const receiptCapabilities = ownedAttachments.registerExpansionResponse(response)
              consumedAttachmentCapabilities = [...new Set([
                ...consumedAttachmentCapabilities,
                ...receiptCapabilities,
              ])]
            }
            return response
          },
          status: () => daemonRuntime.status(),
        }, {
          isTurnCurrent: () => chatRuntime.isCurrent(turn),
          onConsumedAttachmentCapabilities: capabilities => {
            consumedAttachmentCapabilities = [...new Set([
              ...consumedAttachmentCapabilities,
              ...capabilities,
            ])]
          },
        })
        return trusted
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendStream(turn, { type: 'error', error: message })
    sendStream(turn, { type: 'done' })
    await ownedAttachments.cleanupCapabilities(consumedAttachmentCapabilities)
    return { ok: false, error: message }
  }
  try {
    if (!chatRuntime.bindRequest(turn, req)) {
      return { ok: false, error: 'Chat turn was superseded during context preparation' }
    }
    const prompt = lastUserMessage(req)
    if (!prompt) {
      sendStream(turn, { type: 'error', error: 'No user message' })
      sendStream(turn, { type: 'done' })
      return { ok: false, error: 'No user message' }
    }

    const provider = String(req.provider ?? 'claude').toLowerCase()
    const isBridgeSelfCheck = provider === 'codesurf-self-check'
      && process.env.CODESURF_ELECTROBUN_SELF_CHECK === '1'
    if (
      !isBridgeSelfCheck
      && !['claude', 'hermes', 'codex', 'opencode', 'openclaw'].includes(provider)
    ) {
      const error = `Provider "${provider}" is not supported by the Electrobun runtime. Use Claude, Codex, Hermes, OpenCode, or OpenClaw for Electrobun local chat.`
      sendStream(turn, { type: 'error', error })
      sendStream(turn, { type: 'done' })
      return { ok: false, error }
    }

    const result = await chatRuntime.runLaunch(turn, async () => {
      if (isBridgeSelfCheck) {
        const sessionId = `electrobun-self-check-${turn.turnId}`
        chatRuntime.setSession(turn, provider, sessionId)
        sendStream(turn, { type: 'session', sessionId })
        sendStream(turn, { type: 'text', text: 'Electrobun chat bridge self-check' })
        // Keep the launch live briefly so the renderer can exercise the real
        // stop/cancellation RPC while a turn is active, without launching an
        // external provider or making a network request.
        await new Promise(resolve => setTimeout(resolve, 150))
        sendStream(turn, { type: 'done' })
        return { ok: true, jobId: turn.turnId }
      }
      if (provider === 'claude') return await runClaudeChat(req, prompt, turn)
      if (provider === 'hermes') return await runHermesChat(req, prompt, turn)
      if (provider === 'codex') return await runCodexChat(req, prompt, turn)
      if (provider === 'opencode') return await runOpenCodeChat(req, prompt, turn)
      return await runOpenClawChat(req, prompt, turn)
    })
    if (!result.ok) {
      chatRuntime.reject(turn)
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendStream(turn, { type: 'error', error: message })
    sendStream(turn, { type: 'done' })
    return { ok: false, error: message }
  } finally {
    await ownedAttachments.cleanupCapabilities(consumedAttachmentCapabilities)
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, env: childEnv() }).trim()
}

function gitRoot(cwd: string): string | null {
  try { return runGit(cwd, ['rev-parse', '--show-toplevel']) } catch { return null }
}

function gitStatus(cwd: string): unknown {
  const root = gitRoot(cwd)
  if (!root) return { isRepo: false, root: cwd, files: [] }
  const output = runGit(root, ['status', '--porcelain=v1'])
  const files = output ? output.split(/\r?\n/).map(line => ({ status: line.slice(0, 2).trim(), path: line.slice(3) })) : []
  return { isRepo: true, root, files }
}

function gitBranches(cwd: string): unknown {
  const root = gitRoot(cwd)
  if (!root) return { isRepo: false, root: cwd, current: null, branches: [] }
  const current = runGit(root, ['branch', '--show-current']) || null
  const output = runGit(root, ['branch', '--format=%(refname:short)'])
  const branches = output ? output.split(/\r?\n/).filter(Boolean) : []
  return { isRepo: true, root, current, branches }
}

async function handleInvoke(channel: string, args: unknown[] = []): Promise<unknown> {
  switch (channel) {
      case 'appearance:shouldUseDark':
        return true
      case 'appearance:setThemeSource':
        return { ok: false, error: 'Electrobun theme source persistence is unavailable.' }

      case 'workspace:list':
        return await listWorkspaces()
      case 'workspace:listProjects':
        return await listProjects()
      case 'workspace:getActive':
        return await getActiveWorkspace()
      case 'workspace:setActive':
        return await setActiveWorkspace(String(args[0] ?? ''))
      case 'workspace:create':
        return await createWorkspace(String(args[0] ?? 'Workspace'))
      case 'workspace:createWithPath':
        return await createWorkspace(String(args[0] ?? basename(String(args[1] ?? 'Workspace'))), String(args[1] ?? process.cwd()))
      case 'workspace:createFromFolder':
        return await createWorkspace(basename(String(args[0] ?? process.cwd())) || 'Workspace', String(args[0] ?? process.cwd()))
      case 'workspace:addProjectFolder':
        return await addProjectFolder(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'workspace:removeProjectFolder':
        return await removeProjectFolder(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'workspace:renameProject':
        return await renameProject((args[0] ?? {}) as { projectId?: string, projectPath?: string, name?: string })
      case 'workspace:createProjectWorktree':
        return { ok: false, error: 'Electrobun runtime will not create git worktrees until that side-effect is explicitly routed through the daemon.' }
      case 'workspace:delete':
        return await deleteWorkspace(String(args[0] ?? ''))
      case 'workspace:openFolder': {
        const paths = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false })
        if (!paths[0]) return null
        return (await validateCanonicalFsPathDetails(paths[0], 'directory')).operationPath
      }

      case 'settings:get':
        return await readSettings()
      case 'settings:set':
        return await writeSettings(args[0])
      case 'settings:getRawJson':
        return JSON.stringify({ version: 1, settings: await readSettings() }, null, 2)
      case 'settings:setRawJson': {
        try {
          const parsed = JSON.parse(String(args[0] ?? '{}')) as { settings?: unknown }
          return { ok: true, settings: await writeSettings(parsed.settings ?? parsed) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'settings:validateGenerationProvider':
        return { ok: false, message: 'Provider validation is Electron-daemon backed; Electrobun runtime can still save settings.', models: [], imageModels: [], videoModels: [] }

      case 'db:status':
        return { ok: true, runtime: 'electrobun-bun-sqlite', status: dbRuntime.getStatus() }
      case 'db:reset': {
        const result = dbRuntime.reset()
        return { ok: true, runtime: 'electrobun-bun-sqlite', backupPath: result.backupPath, status: dbRuntime.getStatus() }
      }

      case 'canvas:load':
        return await loadCanvas(String(args[0] ?? ''))
      case 'canvas:save':
        return await saveCanvas(String(args[0] ?? ''), args[1])
      case 'canvas:loadTileState':
        return await loadTileState(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'canvas:saveTileState':
        return await saveTileState(String(args[0] ?? ''), String(args[1] ?? ''), args[2])
      case 'canvas:clearTileState':
      case 'canvas:deleteTileArtifacts': {
        const workspaceId = String(args[0] ?? '') || 'default'
        const tileId = String(args[1] ?? '')
        await tileContext.reset(workspaceId, tileId)
        broadcast('canvas:sessionsChanged', { workspaceId: args[0], tileId: args[1] })
        return true
      }
      case 'canvas:listSessions':
        return await listSessions(String(args[0] ?? ''))
      case 'canvas:getSessionState':
        return await getSessionState(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'canvas:renameSession':
      case 'canvas:setSessionArchived':
      case 'canvas:generateSessionTitle':
        return { ok: false, error: `${channel} is unavailable in the Electrobun local state store.` }
      case 'canvas:listCheckpoints':
        return await daemonRuntime.request('/checkpoint/list', {
          body: { workspaceId: String(args[0] ?? ''), sessionEntryId: String(args[1] ?? '') },
        }).catch(() => [])
      case 'canvas:restoreCheckpoint':
        return await daemonRuntime.request('/checkpoint/restore', {
          body: {
            workspaceId: String(args[0] ?? ''),
            checkpointId: String(args[1] ?? ''),
            sessionEntryId: typeof args[2] === 'string' ? args[2] : null,
          },
        }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      case 'canvas:queuedMessages:append':
        return await appendQueuedMessageEvent(args[0])
      case 'canvas:queuedMessages:listActive':
        return []

      case 'fs:readDir':
      {
        const { path: validated } = await authorizeFsPath(
          String(args[0] ?? ''),
          'directory',
          args[1],
          true,
        )
        await assertDirectoryNoFollow(validated.operationPath, validated.authorization)
        try {
          const entries = await readdir(validated.operationPath, { withFileTypes: true })
          return entries
            .map(entry => ({
              name: entry.name,
              path: join(validated.displayPath, entry.name),
              isDir: entry.isDirectory(),
              ext: entry.isDirectory() ? '' : extname(entry.name).toLowerCase(),
            }))
            .sort((left, right) => left.isDir === right.isDir
              ? left.name.localeCompare(right.name)
              : left.isDir ? -1 : 1)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
      }
      case 'fs:readFile': {
        const { path: validated } = await authorizeFsPath(
          String(args[0] ?? ''),
          'read',
          args[1],
          true,
        )
        try {
          return await readUtf8FileNoFollow(validated.operationPath, validated.authorization)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw error
        }
      }
      case 'fs:readFilePrefix': {
        const maxBytes = Number(args[1])
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) {
          throw new Error('maxBytes must be an integer between 1 and 65536')
        }
        const { path: validated } = await authorizeFsPath(
          String(args[0] ?? ''),
          'read',
          args[2],
          true,
        )
        return await readUtf8FilePrefixNoFollow(
          validated.operationPath,
          maxBytes,
          validated.authorization,
        )
      }
      case 'fs:writeFile': {
        const { path: validated } = await authorizeFsPath(String(args[0] ?? ''), 'write', args[2])
        await writeUtf8FileNoFollow(validated.operationPath, String(args[1] ?? ''), {
          authorization: validated.authorization,
        })
        return true
      }
      case 'fs:createFile': {
        const { path: validated } = await authorizeFsPath(String(args[0] ?? ''), 'create', args[1])
        await writeUtf8FileNoFollow(validated.operationPath, '', {
          authorization: validated.authorization,
        })
        return true
      }
      case 'fs:createDir': {
        const { path: validated } = await authorizeFsPath(String(args[0] ?? ''), 'directory', args[1])
        await assertAuthorizedParentUnchanged(validated.authorization)
        await mkdir(validated.operationPath, { recursive: true })
        return true
      }
      case 'fs:deleteFile': {
        const { path: validated } = await authorizeFsPath(String(args[0] ?? ''), 'delete-link', args[1])
        await assertAuthorizedParentUnchanged(validated.authorization)
        let current
        try {
          current = await lstat(validated.operationPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
          throw error
        }
        if (current.isSymbolicLink()) await unlink(validated.operationPath)
        else {
          await assertPathMatchesAuthorization(validated.operationPath, validated.authorization)
          await rm(validated.operationPath, { recursive: true, force: true })
        }
        return true
      }
      case 'fs:renameFile': {
        const oldPath = await authorizeFsPath(String(args[0] ?? ''), 'write', args[2])
        const newPath = await authorizeFsPath(String(args[1] ?? ''), 'create', args[2])
        await assertPathMatchesAuthorization(oldPath.path.operationPath, oldPath.path.authorization)
        await assertAuthorizedParentUnchanged(newPath.path.authorization)
        await rename(oldPath.path.operationPath, newPath.path.operationPath)
        return true
      }
      case 'fs:probeDir': {
        try {
          const { path: validated } = await authorizeFsPath(
            String(args[0] ?? ''),
            'directory',
            args[1],
            true,
          )
          await assertDirectoryNoFollow(validated.operationPath, validated.authorization)
          return { ok: true }
        } catch (error) {
          return { ok: false, code: (error as NodeJS.ErrnoException).code ?? 'ACCESS_DENIED' }
        }
      }
      case 'fs:stat': {
        try {
          const { path: validated } = await authorizeFsPath(
            String(args[0] ?? ''),
            'read',
            args[1],
            true,
          )
          const info = await statPathNoFollow(validated.operationPath, validated.authorization)
          return {
            size: info.size,
            mtimeMs: info.mtimeMs,
            isFile: info.isFile(),
            isDir: info.isDirectory(),
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }
      case 'fs:isProbablyTextFile': {
        const { path: validated } = await authorizeFsPath(String(args[0] ?? ''), 'read', args[1])
        const info = await statPathNoFollow(validated.operationPath, validated.authorization)
        if (!info.isFile()) return false
        return await isProbablyTextFile(validated.operationPath, validated.authorization)
      }
      case 'fs:revealInFinder': {
        const { path: validated } = await authorizeFsPath(String(args[0] ?? ''), 'read', args[1])
        await statPathNoFollow(validated.operationPath, validated.authorization)
        Utils.showItemInFolder(validated.operationPath)
        return true
      }
      case 'fs:copyIntoDir': {
        const source = await authorizeFsPath(String(args[0] ?? ''), 'read', args[2])
        const destinationDirectory = await authorizeFsPath(String(args[1] ?? ''), 'directory', args[2])
        await assertAuthorizedParentUnchanged(destinationDirectory.path.authorization)
        await mkdir(destinationDirectory.path.operationPath, { recursive: true })
        await assertDirectoryNoFollow(
          destinationDirectory.path.operationPath,
          destinationDirectory.path.authorization,
        )
        const sourceInfo = await statPathNoFollow(source.path.operationPath, source.path.authorization)
        if (!sourceInfo.isFile()) throw new Error('Only files can be copied into a workspace')
        const candidate = await getUniqueCopyPath(
          destinationDirectory.path.operationPath,
          source.path.displayPath,
        )
        const destination = await authorizeFsPath(candidate, 'create', args[2])
        await copyFileNoFollow(source.path.operationPath, destination.path.operationPath, {
          sourceAuthorization: source.path.authorization,
          destinationAuthorization: destination.path.authorization,
        })
        return { path: destination.path.displayPath }
      }
      case 'fs:writeBrief': {
        const cardId = String(args[0] ?? '')
        assertSafeCardId(cardId)
        const directory = await validateCanonicalFsPathDetails(join(CODESURF_HOME, 'briefs'), 'directory')
        await assertAuthorizedParentUnchanged(directory.authorization)
        await mkdir(directory.operationPath, { recursive: true })
        const brief = await validateCanonicalFsPathDetails(join(directory.displayPath, `${cardId}.md`), 'write')
        await writeUtf8FileNoFollow(brief.operationPath, String(args[1] ?? ''), {
          authorization: brief.authorization,
        })
        return brief.displayPath
      }
      case 'fs:watchStart': {
        const rawPath = String(args[0] ?? '')
        const key = fsWatchKey(rawPath, args[1])
        if (fsWatchers.has(key)) return true
        const { path: validated } = await authorizeFsPath(rawPath, 'directory', args[1])
        await assertDirectoryNoFollow(validated.operationPath, validated.authorization)
        const entry = { watcher: undefined as unknown as FSWatcher, debounce: null as ReturnType<typeof setTimeout> | null }
        entry.watcher = watchDirectory(validated.operationPath, { recursive: true }, () => {
          if (entry.debounce) clearTimeout(entry.debounce)
          entry.debounce = setTimeout(() => broadcast(`fs:watch:${rawPath}`), 200)
        })
        fsWatchers.set(key, entry)
        return true
      }
      case 'fs:watchStop': {
        const rawPath = String(args[0] ?? '')
        const key = fsWatchKey(rawPath, args[1])
        await authorizeFsPath(rawPath, 'directory', args[1])
        const entry = fsWatchers.get(key)
        if (entry) {
          if (entry.debounce) clearTimeout(entry.debounce)
          entry.watcher.close()
          fsWatchers.delete(key)
        }
        return true
      }

      case 'terminal:create': {
        // Keep the RPC shape aligned with Electron/preload:
        // (tileId, workspaceId, workspaceDir, launchBin, launchArgs, options).
        // The Bun host authorizes the canonical directory and does not need
        // the workspace id or renderer-only size hint. Accept the legacy
        // four-argument shape as well for older Native shells.
        const sharedShape = args.length >= 5
        const workspaceDir = String(args[sharedShape ? 2 : 1] ?? '')
        const launchBin = typeof args[sharedShape ? 3 : 2] === 'string'
          ? args[sharedShape ? 3 : 2] as string
          : undefined
        const launchArgs = Array.isArray(args[sharedShape ? 4 : 3])
          ? args[sharedShape ? 4 : 3] as string[]
          : undefined
        return await createTerminal(String(args[0] ?? ''), workspaceDir, launchBin, launchArgs)
      }
      case 'terminal:write': {
        const tileId = String(args[0] ?? '')
        if (!terminalSessions.has(tileId)) throw new Error(`Terminal session not found: ${tileId}`)
        if (!sendPtyHost({ type: 'write', tileId, data: String(args[1] ?? '') })) {
          throw new Error('PTY host is unavailable')
        }
        return true
      }
      case 'terminal:cd': {
        const tileId = String(args[0] ?? '')
        const session = terminalSessions.get(tileId)
        if (!session) throw new Error(`Terminal session not found: ${tileId}`)
        const requestedPath = String(args[1] ?? '')
        const authorized = session.workspaceId
          ? await authorizeFsPath(requestedPath, 'directory', session.workspaceId)
          : await authorizeElectrobunTerminalPath({
              ...(await workspaceAuthority()),
              filePath: requestedPath,
            })
        await assertDirectoryNoFollow(
          authorized.path.operationPath,
          authorized.path.authorization,
        )
        if (!sendPtyHost({
          type: 'write',
          tileId,
          data: `\x15${cdCommand(session.shell, authorized.path.operationPath)}\r`,
        })) throw new Error('PTY host is unavailable')
        session.cwd = authorized.path.operationPath
        return true
      }
      case 'terminal:resize': {
        const tileId = String(args[0] ?? '')
        const cols = Math.max(1, Math.floor(Number(args[1]) || 80))
        const rows = Math.max(1, Math.floor(Number(args[2]) || 24))
        sendPtyHost({ type: 'resize', tileId, cols, rows })
        return true
      }
      case 'terminal:destroy': {
        const tileId = String(args[0] ?? '')
        sendPtyHost({ type: 'destroy', tileId })
        terminalSessions.delete(tileId)
        publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'destroyed' })
        return true
      }
      case 'terminal:detach': {
        const tileId = String(args[0] ?? '')
        sendPtyHost({ type: 'detach', tileId })
        terminalSessions.delete(tileId)
        return true
      }
      case 'terminal:update-peers':
        return { ok: false, error: 'Electrobun terminal peer context updates are unavailable.' }

      case 'chat:send':
        return await sendChat((args[0] ?? {}) as ChatRequest)
      case 'chat:resumeJob':
        return await sendChat((args[0] ?? {}) as ChatRequest)
      case 'chat:stop': {
        const scope = { workspaceId: String(args[0] ?? ''), cardId: String(args[1] ?? '') }
        const stopped = await stopChat(scope)
        if (!stopped.confirmed) {
          const error = stopped.error ?? 'Unable to confirm chat process termination'
          broadcastChatStream(scope, { type: 'error', error })
          return { ok: false, error }
        }
        broadcastChatStream(scope, { type: 'done' })
        return { ok: true }
      }
      case 'chat:clearSession': {
        const scope = { workspaceId: String(args[0] ?? ''), cardId: String(args[1] ?? '') }
        const stopped = await chatRuntime.stopAndClearSessions(scope)
        if (!stopped.confirmed) return { ok: false, error: stopped.error ?? 'Unable to confirm chat process termination' }
        codexStableContextRuntime.clear(scope)
        broadcastChatStream(scope, { type: 'done' })
        return { ok: true }
      }
      case 'chat:steer':
        return { ok: false, error: 'Electrobun CLI subprocess providers cannot accept mid-stream steering events.' }
      case 'chat:setPermissionMode':
      case 'chat:answerUserQuestion':
      case 'chat:answerToolPermission':
        return { ok: false, error: `${channel} is unavailable for Electrobun CLI subprocess providers.` }
      case 'chat:disposeCard': {
        const scope = { workspaceId: String(args[0] ?? ''), cardId: String(args[1] ?? '') }
        const stopped = await stopChat(scope)
        if (!stopped.confirmed) return { ok: false, error: stopped.error ?? 'Unable to confirm chat process termination' }
        chatRuntime.clearSessions(scope)
        codexStableContextRuntime.clear(scope)
        return { ok: true }
      }
      case 'chat:selectFiles': {
        const paths = await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: true })
        return await issueElectrobunPickedAttachments(args[0], args[1], paths, async (workspaceId, cardId, selectedPaths) => {
          await daemonRuntime.ensureRunning()
          const response = await daemonRuntime.request<{ attachments?: ElectrobunIssuedAttachment[] }>(
            '/file-references/selections/issue',
            { body: { workspaceId, cardId, paths: selectedPaths, ownedTemporary: false } },
          )
          if (!Array.isArray(response.attachments)) throw new Error('Attachment selection issuer returned an invalid response')
          return response.attachments
        })
      }
      case 'chat:writeTempAttachment': {
        return await writeElectrobunTempAttachment(
          (args[0] ?? {}) as Parameters<typeof writeElectrobunTempAttachment>[0],
          ownedAttachmentDirectory,
          async (workspaceId, cardId, paths) => {
            await daemonRuntime.ensureRunning()
            const response = await daemonRuntime.request<{ attachments?: ElectrobunIssuedAttachment[] }>(
              '/file-references/selections/issue',
              { body: { workspaceId, cardId, paths, ownedTemporary: true } },
            )
            if (!Array.isArray(response.attachments)) throw new Error('Attachment selection issuer returned an invalid response')
            return response.attachments
          },
          ownedAttachments,
        )
      }
      case 'chat:revokeAttachmentSelections': {
        return await revokeElectrobunAttachmentSelections(
          (args[0] ?? {}) as Parameters<typeof revokeElectrobunAttachmentSelections>[0],
          async (workspaceId, cardId, selectionReceipts) => {
            await daemonRuntime.ensureRunning()
            return await daemonRuntime.request<{ ok: boolean, revoked?: number, error?: string }>(
              '/file-references/selections/revoke',
              { body: { workspaceId, cardId, selectionReceipts } },
            )
          },
          ownedAttachments,
        )
      }
      case 'chat:loadSessionHistory':
        return { ok: true, messages: [], hasMore: false, nextCursor: null }
      case 'chat:opencodeModels':
        return { models: OPEN_CODE_FALLBACK_MODELS, source: 'electrobun-fallback' }
      case 'chat:gatewayModels': {
        // Live catalog via the daemon; renderer keeps its built-in gateway
        // defaults when models comes back empty.
        try {
          await daemonRuntime.ensureRunning()
          return await daemonRuntime.request<{ models: unknown[], source?: string, error?: string }>('/chat/gateway-models')
        } catch (err) {
          return { models: [], source: 'none', error: err instanceof Error ? err.message : String(err) }
        }
      }
      case 'chat:openclawAgents':
        return listOpenClawAgentOptions()

      case 'jobs:recent':
        return dbRuntime.listRecentJobs((args[0] ?? {}) as { workspaceId?: string | null, limit?: number, offset?: number, includeArchived?: boolean })

      case 'git:status':
        return gitStatus(String(args[0] ?? process.cwd()))
      case 'git:branches':
        return gitBranches(String(args[0] ?? process.cwd()))
      case 'git:checkoutBranch': {
        const root = gitRoot(String(args[0] ?? process.cwd()))
        if (!root) return { ok: false, error: 'Not a git repository' }
        runGit(root, ['checkout', String(args[1] ?? '')])
        return { ok: true, ...(gitBranches(root) as object) }
      }
      case 'git:createBranch': {
        const root = gitRoot(String(args[0] ?? process.cwd()))
        if (!root) return { ok: false, error: 'Not a git repository' }
        runGit(root, ['checkout', '-b', String(args[1] ?? '')])
        return { ok: true, ...(gitBranches(root) as object) }
      }

      case 'shell:openExternal':
        return Utils.openExternal(String(args[0] ?? ''))
      case 'window:new':
      case 'window:newTab':
        await createWindow({ fresh: true })
        return true
      case 'window:list':
        return windowList()
      case 'window:getCurrentId':
        return focusedWindowId
      case 'window:setTitle': {
        const live = liveWindows.get(focusedWindowId)
        if (live) {
          live.title = String(args[0] ?? 'CodeSurf')
          live.win.setTitle(live.title)
          broadcastWindowList()
        }
        return true
      }
      case 'window:focusById': {
        const id = Number(args[0])
        liveWindows.get(id)?.win.focus()
        focusedWindowId = id
        broadcastWindowList()
        return true
      }
      case 'window:closeById': {
        const id = Number(args[0])
        liveWindows.get(id)?.win.close()
        return true
      }
      case 'window:isFresh': {
        const live = liveWindows.get(focusedWindowId)
        const fresh = Boolean(live?.fresh)
        if (live) live.fresh = false
        return fresh
      }
      case 'window:setSidebarCollapsed':
        return { ok: false, error: 'Electrobun sidebar collapse persistence is renderer-owned.' }
      case 'app:relaunch':
        shutdownRuntimeChildren()
        Utils.quit()
        return true

      case 'bus:publish': {
        const [eventChannel, type, source, payload] = args
        publishBus(String(eventChannel ?? ''), String(type ?? 'event'), String(source ?? 'renderer'), payload)
        return true
      }
      case 'bus:subscribe':
      case 'bus:unsubscribeAll':
      case 'bus:markRead':
        return true
      case 'bus:history': {
        const channelName = String(args[0] ?? '')
        return channelName ? (busHistory.get(channelName) ?? []) : [...busHistory.values()].flat()
      }
      case 'bus:channelInfo':
        return [...busHistory.entries()].map(([name, events]) => ({ name, eventCount: events.length }))
      case 'bus:unreadCount':
        return 0

      case 'tileContext:get':
      case 'tileContext:getAll':
      case 'tileContext:set':
      case 'tileContext:delete':
        return invokeElectrobunTileContext(tileContext, channel, args)

      case 'activity:upsert': {
        const record = (args[0] ?? {}) as Record<string, unknown>
        const id = String(record.id ?? record.tileId ?? safeId('activity'))
        activityRecords.set(id, { ...record, id, updatedAt: Date.now() })
        return activityRecords.get(id)
      }
      case 'activity:query':
        return [...activityRecords.values()]
      case 'activity:byTile':
        return [...activityRecords.values()].filter(record => record.tileId === args[0])
      case 'activity:byAgent':
        return [...activityRecords.values()].filter(record => record.agentId === args[0])
      case 'activity:delete':
        return activityRecords.delete(String(args[0] ?? ''))
      case 'activity:clearTile':
        for (const [id, record] of activityRecords) if (record.tileId === args[0]) activityRecords.delete(id)
        return true

      case 'execution:listHosts':
        return await listExecutionHostsFromDaemon()
      case 'execution:resolveTarget':
        return await resolveElectrobunExecutionTarget((args[0] ?? { mode: 'auto', hostId: null }) as ExecutionPreference)
      case 'execution:upsertHost':
        return await daemonRuntime.request('/host/upsert', { body: { host: args[0] } })
      case 'execution:deleteHost':
        return await daemonRuntime.request(`/host/${encodeURIComponent(String(args[0] ?? ''))}`, { method: 'DELETE' })

      case 'mcp:getConfig':
      case 'mcp:getMergedConfig':
        return await readJson(MCP_CONFIG_PATH, null)
      case 'mcp:getPort': {
        const config = await readJson<any>(MCP_CONFIG_PATH, null)
        return config?.port ?? null
      }
      case 'mcp:getWorkspaceServers':
        return {}
      case 'mcp:saveServers':
      case 'mcp:saveWorkspaceServers':
        return { ok: false, error: `${channel} is unavailable in the Electrobun host.` }

      case 'system:memStats':
        return process.memoryUsage()
      case 'system:gc':
        broadcast('system:gc-requested')
        return true
      case 'system:daemonStatus': {
        try {
          await daemonRuntime.ensureRunning()
          return await daemonRuntime.status()
        } catch (error) {
          return sanitizeDaemonStatusError(error)
        }
      }
      case 'system:daemonSummary':
        return await getDaemonSummaryForStatusBar()
      case 'system:restartDaemon': {
        await daemonRuntime.restart()
        return await daemonRuntime.status()
      }
      case 'system:cleanupTile':
        return { ok: false, error: 'Electrobun tile cleanup is unavailable.' }
      case 'homedir:get':
        return homedir()
      case 'ui:setZoomLevel': {
        const level = typeof args[0] === 'number' ? args[0] : 0
        liveWindows.get(focusedWindowId)?.win.setPageZoom(1 + (level * 0.2))
        return true
      }

      case 'browserTile:sync':
      case 'browserTile:command':
      case 'browserTile:destroy':
        return { ok: true, supported: true, runtime: 'electrobun-webview-tag' }
      case 'chromeSync:listProfiles':
        return []
      case 'chromeSync:getStatus':
        return { enabled: false, supported: false, runtime: 'electrobun' }
      case 'chromeSync:syncCookies':
        return { ok: false, supported: false, error: 'Chrome cookie sync depends on Electron session partitions; Electrobun browser tiles run with their own isolated partitions.' }
      case 'chromeSync:getBookmarks':
      case 'chromeSync:searchHistory':
        return []

      case 'localProxy:getStatus':
        return { running: false }
      case 'localProxy:probeBackends':
        return []
      case 'localProxy:start':
      case 'localProxy:stop':
        return { ok: false, error: 'Local proxy control remains on the Electron main-process path.' }
      case 'updater:check':
        return { ok: true, status: 'disabled-electrobun-runtime', updateAvailable: false }
      case 'updater:download':
      case 'updater:quitAndInstall':
        return { ok: false, error: 'Electrobun packaging does not use electron-updater.' }

      case 'ext:list':
      case 'extensions:list':
        return await listExtensionsForBridge()
      case 'ext:list-sidebar': {
        const workspacePath = typeof args[0] === 'string' ? args[0] : null
        return formatExtensionSidebarResponse(await scanExtensionManifests(workspacePath))
      }
      case 'ext:list-tiles':
        return (await scanExtensionManifests())
          .filter(manifest => manifest._enabled !== false)
          .flatMap(manifest => (manifest.contributes?.tiles ?? []).map(tile => ({
            extId: manifest.id,
            type: tile.type,
            label: tile.label,
            icon: tile.icon,
            defaultSize: tile.defaultSize ?? { w: 400, h: 300 },
            minSize: tile.minSize ?? { w: 200, h: 150 },
            uiMode: manifest.ui?.mode,
          })))
      case 'ext:list-chat-surfaces':
        return (await scanExtensionManifests())
          .filter(manifest => manifest._enabled !== false)
          .flatMap(manifest => (manifest.contributes?.chatSurfaces ?? []).map(surface => ({
            extId: manifest.id,
            id: surface.id,
            label: surface.label,
            icon: surface.icon,
            defaultHeight: surface.defaultHeight ?? 280,
            minHeight: surface.minHeight ?? 180,
            emits: surface.emits ?? [],
          })))
      case 'ext:context-menu-items':
        return []
      case 'ext:enable':
      case 'ext:disable':
      case 'ext:refresh':
        return { ok: false, error: `${channel} is unavailable in the Electrobun host.` }

      case 'permissions:list':
        return []
      case 'permissions:clear':
      case 'permissions:clearAll':
        return { ok: false, error: 'Electrobun does not provide a persistent permission grant store.' }

      case 'secrets:list':
        return { ok: false, names: [], error: 'Electrobun secure secret storage is unavailable.' }
      case 'secrets:has':
        return { ok: false, has: false, error: 'Electrobun secure secret storage is unavailable.' }
      case 'secrets:set':
      case 'secrets:delete':
        return { ok: false, error: 'Electrobun secure secret storage is unavailable.' }

      // Pets — local scan/install without Electron IPC (runtime-pets.ts)
      case 'pets:list':
        return listPets()
      case 'pets:gallery':
        // Remote petdex gallery is best-effort; fall back to local installed.
        try {
          const resp = await fetch('https://petdex.dev/api/manifest.json', {
            signal: AbortSignal.timeout(10000),
          })
          if (resp.ok) {
            const data = await resp.json() as Array<Record<string, unknown>> | { pets?: Array<Record<string, unknown>> }
            const entries = Array.isArray(data) ? data : data.pets ?? []
            const installed = new Set(listPets().map(p => p.id))
            return entries.map(e => ({
              id: String(e.id ?? ''),
              displayName: String(e.displayName ?? e.id ?? ''),
              description: String(e.description ?? ''),
              category: typeof e.category === 'string' ? e.category : undefined,
              installed: installed.has(String(e.id ?? '')),
            })).filter(e => e.id)
          }
        } catch { /* offline */ }
        return listPetsGalleryLocal()
      case 'pets:gallery-local':
        return listPetsGalleryLocal()
      case 'pets:install': {
        const result = await installPet(String(args[0] ?? ''))
        if (result.ok) broadcast('pets:gallery-changed', { slug: String(args[0] ?? '') })
        return result
      }
      case 'pets:remove': {
        const result = removePet(String(args[0] ?? ''))
        if (result.ok) broadcast('pets:gallery-changed', { slug: String(args[0] ?? '') })
        return result
      }
      case 'pets:thumbnail':
      case 'pets:thumbnailData':
        // sharp not available in Electrobun host — spritesheet data is enough for UI.
        return null
      case 'pets:spritesheetData':
        return petSpritesheetData(String(args[0] ?? ''))
      case 'pets:getManifest':
        return getPetManifest(String(args[0] ?? ''))

      // Guest paint throttle is Electron-WebContents-specific; no-op successfully
      // on Electrobun so the renderer path does not error.
      case 'webview:setFrameRate':
        return { ok: true, runtime: 'electrobun-noop' }

      default:
        return getDefaultElectrobunInvokeResponse(channel)
  }
}

async function runCoreIpcSelfCheck(): Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail?: unknown, error?: string }> }> {
  const checks: Array<{ name: string, ok: boolean, detail?: unknown, error?: string }> = []

  async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail })
    } catch (error) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const assert = (condition: unknown, message: string, detail?: unknown): unknown => {
    if (!condition) throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`)
    return detail ?? true
  }

  await check('workspace:list', async () => {
    const [listed, active] = await Promise.all([
      handleInvoke('workspace:list', []) as Promise<Workspace[]>,
      handleInvoke('workspace:getActive', []) as Promise<Workspace | null>,
    ])
    assert(listed.length === 1, 'concurrent first-run workspace:list did not return exactly one workspace', listed)
    assert(active?.id === listed[0]?.id, 'concurrent workspace:getActive returned a different workspace', { listed, active })

    const [workspaceDoc, projectsDoc] = await Promise.all([readWorkspacesDoc(), readProjectsDoc()])
    const record = workspaceDoc.workspaces?.find(candidate => candidate.id === listed[0]?.id)
    const project = projectsDoc.projects?.find(candidate => candidate.id === record?.primaryProjectId)
    const canonicalFirstRunProjectPath = await realpath(FIRST_RUN_PROJECT_PATH)
    assert(record?.projectIds?.length === 1, 'first-run workspace registry is not singular and durable', workspaceDoc)
    assert(project?.path === canonicalFirstRunProjectPath, 'first-run project authority is not app-owned', {
      expected: canonicalFirstRunProjectPath,
      project,
    })

    const [reloaded, reloadedActive] = await Promise.all([listWorkspaces(), getActiveWorkspace()])
    assert(reloaded.length === 1 && reloaded[0]?.path === canonicalFirstRunProjectPath, 'reloaded workspace lost its project authority', reloaded)
    assert(reloadedActive?.id === listed[0]?.id, 'reloaded active workspace changed identity', reloadedActive)
    return {
      workspaceId: listed[0]?.id,
      projectId: project?.id,
      projectPath: project?.path,
      reloadVerified: true,
    }
  })

  await check('settings:get', async () => {
    const result = await handleInvoke('settings:get', []) as Record<string, unknown>
    return assert(result && typeof result === 'object' && typeof result.appearance === 'string', 'settings:get did not return app settings', result)
  })

  await check('homedir:get', async () => {
    const result = await handleInvoke('homedir:get', [])
    return assert(result === homedir(), 'homedir:get did not return the host home directory', result)
  })

  await check('db:status', async () => {
    const result = await handleInvoke('db:status', []) as { ok?: boolean, status?: { schemaVersion?: number } }
    return assert(result?.ok === true && result.status?.schemaVersion === 4, 'db:status did not report migrated schema v4', result)
  })

  await check('system:daemonStatus', async () => {
    const result = await handleInvoke('system:daemonStatus', []) as { running?: boolean, info?: unknown }
    return assert(result?.running === true && result.info, 'system:daemonStatus did not report a live daemon', result)
  })

  await check('system:daemonSummary', async () => {
    const result = await handleInvoke('system:daemonSummary', []) as { running?: boolean, jobs?: unknown }
    return assert(result?.running === true && result.jobs && typeof result.jobs === 'object', 'system:daemonSummary did not return daemon job summary', result)
  })

  await check('execution:listHosts', async () => {
    const result = await handleInvoke('execution:listHosts', []) as ExecutionHostRecord[]
    return assert(Array.isArray(result) && result.some(host => host.id === 'local-daemon' || host.type === 'local-daemon'), 'execution:listHosts did not return daemon-backed hosts', result)
  })

  await check('execution:resolveTarget', async () => {
    const result = await handleInvoke('execution:resolveTarget', [{ mode: 'auto', hostId: null } satisfies ExecutionPreference]) as { host?: ExecutionHostRecord }
    return assert(result?.host && (result.host.id === 'local-daemon' || result.host.type === 'local-daemon'), 'execution:resolveTarget did not select the live local daemon', result)
  })

  await check('execution:upsertHost/deleteHost', async () => {
    const hostId = `electrobun-self-check-${process.pid}-${Date.now()}`
    const host: ExecutionHostRecord = {
      id: hostId,
      type: 'remote-daemon',
      label: 'Electrobun self-check host',
      enabled: true,
      url: 'http://127.0.0.1:9',
      authToken: null,
    }
    const upserted = await handleInvoke('execution:upsertHost', [host]) as ExecutionHostRecord[]
    assert(Array.isArray(upserted) && upserted.some(entry => entry.id === hostId), 'execution:upsertHost did not persist the self-check host', upserted)
    const deleted = await handleInvoke('execution:deleteHost', [hostId]) as { ok?: boolean, hosts?: ExecutionHostRecord[] }
    return assert(deleted?.ok === true && Array.isArray(deleted.hosts) && !deleted.hosts.some(entry => entry.id === hostId), 'execution:deleteHost did not remove the self-check host', deleted)
  })

  await check('canvas:listCheckpoints', async () => {
    const result = await handleInvoke('canvas:listCheckpoints', ['electrobun-self-check', 'codesurf-runtime:self-check'])
    return assert(Array.isArray(result), 'canvas:listCheckpoints did not return an array', result)
  })

  return { ok: checks.every(entry => entry.ok), checks }
}

const rpc = BrowserView.defineRPC<CodeSurfElectrobunRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      invoke: ({ channel, args }) => handleInvoke(channel, args ?? []),
    },
    messages: {
      log: ({ level = 'info', message, detail }) => {
        const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
        logger(`[renderer] ${message}`, detail ?? '')
      },
      bridgeReady: payload => {
        void writeSmokeStatus('renderer-bridge-ready', { bridge: payload })
        console.log('[Electrobun] renderer bridge ready', payload)
      },
    },
  },
})

async function resolveRendererUrl(): Promise<string> {
  if (process.env.CODESURF_ELECTROBUN_FORCE_BUNDLED === '1') return RENDERER_BUNDLED_URL
  try {
    const response = await fetch(RENDERER_DEV_URL, { method: 'HEAD', signal: AbortSignal.timeout(500) })
    if (response.ok) return RENDERER_DEV_URL
  } catch {
    // use bundled renderer below
  }
  return RENDERER_BUNDLED_URL
}

async function resolveBridgePreloadSource(): Promise<string> {
  const entryDir = typeof process.argv[1] === 'string' && process.argv[1]
    ? dirname(process.argv[1])
    : process.cwd()
  const candidates = [
    join(entryDir, 'app', 'views', 'codesurf-electrobun', 'index.js'),
    join(process.cwd(), '..', 'Resources', 'app', 'views', 'codesurf-electrobun', 'index.js'),
    join(process.cwd(), 'views', 'codesurf-electrobun', 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      const source = await readFile(candidate, 'utf8')
      if (source.trim()) return source
    } catch {
      // Try the next packaged runtime layout.
    }
  }
  throw new Error(`Electrobun bridge preload source was not found: ${candidates.join(', ')}`)
}

function installMenu(): void {
  ApplicationMenu.setApplicationMenu([
    {
      label: 'CodeSurf',
      submenu: [
        { role: 'about' },
        { type: 'divider' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', action: 'window:new' },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', action: 'window:new-tab' },
        { type: 'divider' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'divider' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'divider' },
        { role: 'togglefullscreen' },
      ],
    },
  ])
}

async function createWindow(options: { fresh?: boolean, url?: string } = {}): Promise<BrowserWindow<ElectrobunRPCInstance>> {
  const url = options.url ?? await resolveRendererUrl()
  const preload = withElectrobunHostBootstrap(
    await resolveBridgePreloadSource(),
    homedir(),
    process.env.CODESURF_ELECTROBUN_RENDERER_SELF_CHECK === '1',
  )
  const win = new BrowserWindow<ElectrobunRPCInstance>({
    title: 'CodeSurf',
    url,
    preload,
    rpc,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: {
      width: 1400,
      height: 900,
      x: 80,
      y: 80,
    },
    renderer: process.env.CODESURF_ELECTROBUN_RENDERER === 'cef' ? 'cef' : 'native',
  })

  focusedWindowId = win.id
  liveWindows.set(win.id, { win, title: 'CodeSurf', fresh: Boolean(options.fresh) })

  win.on('focus', () => {
    focusedWindowId = win.id
    broadcastWindowList()
  })
  win.on('close', () => {
    liveWindows.delete(win.id)
    broadcastWindowList()
    if (liveWindows.size === 0) {
      void shutdownRuntimeChildren().finally(() => Utils.quit())
    }
  })

  broadcastWindowList()
  return win
}

function installProcessCleanupHandlers(): void {
  process.once('exit', forceShutdownRuntimeChildren)
  process.once('SIGTERM', () => {
    void shutdownRuntimeChildren().finally(() => process.exit(0))
  })
  process.once('SIGINT', () => {
    void shutdownRuntimeChildren().finally(() => process.exit(0))
  })
}

await ownedAttachments.sweepStale().catch(error => {
  console.warn('[Electrobun] Failed to sweep stale private attachments:', error instanceof Error ? error.message : String(error))
})
await sweepStaleElectrobunImageDirectories(codexImageDirectory).catch(error => {
  console.warn('[Electrobun] Failed to sweep stale private Codex images:', error instanceof Error ? error.message : String(error))
})
installProcessCleanupHandlers()
installMenu()
const initialRendererUrl = await resolveRendererUrl()
const initialDaemonStatus = await (async () => {
  try {
    await daemonRuntime.ensureRunning()
    return await daemonRuntime.status()
  } catch (error) {
    return sanitizeDaemonStatusError(error)
  }
})()
const initialCoreIpcStatus = process.env.CODESURF_ELECTROBUN_SELF_CHECK === '1'
  || process.env.CODESURF_ELECTROBUN_SMOKE === '1'
  ? await runCoreIpcSelfCheck()
  : null
await writeSmokeStatus('starting', {
  rendererUrl: initialRendererUrl,
  bridgePreload: BRIDGE_PRELOAD_URL,
  bundledRenderer: RENDERER_BUNDLED_URL,
  daemonStatus: initialDaemonStatus,
  coreIpcStatus: initialCoreIpcStatus,
})
const initialWindow = await createWindow({ url: initialRendererUrl })
await writeSmokeStatus('started', {
  rendererUrl: initialRendererUrl,
  bridgePreload: BRIDGE_PRELOAD_URL,
  bundledRenderer: RENDERER_BUNDLED_URL,
  windowId: initialWindow.id,
  dbStatus: dbRuntime.getStatus(),
  daemonStatus: initialDaemonStatus,
  coreIpcStatus: initialCoreIpcStatus,
})

console.log('CodeSurf Electrobun runtime started')
console.log(`Renderer: ${initialRendererUrl}`)
console.log(`Bridge preload: ${BRIDGE_PRELOAD_URL}`)
console.log(`Fallback bundled renderer: ${RENDERER_BUNDLED_URL}`)

if (Number.isFinite(SMOKE_EXIT_AFTER_MS) && SMOKE_EXIT_AFTER_MS > 0) {
  setTimeout(() => {
    void (async () => {
      const daemonStatus = await daemonRuntime.status().catch(sanitizeDaemonStatusError)
      shutdownRuntimeChildren()
      await writeSmokeStatus('exiting', {
        rendererUrl: initialRendererUrl,
        windowCount: liveWindows.size,
        daemonStatus,
      })
    })().finally(() => Utils.quit())
  }, SMOKE_EXIT_AFTER_MS)
}
