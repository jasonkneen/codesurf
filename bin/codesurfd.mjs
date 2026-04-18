#!/usr/bin/env node

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { findSessionEntryById, getExternalSessionChatState, invalidateExternalSessionCache, listExternalSessionEntries } from './session-index.mjs'
import { createChatJobManager } from './chat-jobs.mjs'

const HOME = process.env.CODESURF_HOME || join(homedir(), '.codesurf')
const PID_PATH = process.env.CODESURF_DAEMON_PID_PATH || join(HOME, 'daemon', 'pid.json')
const PROTOCOL_VERSION = 1
const APP_VERSION = String(process.env.CODESURF_APP_VERSION ?? '').trim() || null
const STARTED_AT = new Date().toISOString()
const LEGACY_CONFIG_PATH = join(HOME, 'config.json')
const WORKSPACES_FILE = join(HOME, 'workspaces', 'workspaces.json')
const PROJECTS_FILE = join(HOME, 'projects', 'projects.json')
const HOSTS_FILE = join(HOME, 'hosts', 'hosts.json')
const SETTINGS_FILE = join(HOME, 'settings.json')
const AGENT_KANBAN_DIR = join(HOME, 'agent-kanban')
const SESSION_TITLE_OVERRIDES_FILE = join(HOME, 'session-title-overrides.json')
const AUTH_TOKEN = randomUUID()
const SESSION_TEXT_LIMIT = 120
const chatJobs = createChatJobManager({ homeDir: HOME })

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function normalizePath(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function atomicWriteJson(filePath, value) {
  ensureDir(dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tempPath, filePath)
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function readSessionTitleOverrides() {
  const parsed = readJsonFile(SESSION_TITLE_OVERRIDES_FILE, {})
  return parsed && typeof parsed === 'object' ? parsed : {}
}

function writeSessionTitleOverrides(overrides) {
  atomicWriteJson(SESSION_TITLE_OVERRIDES_FILE, overrides)
}

function localSessionOverrideKey(workspaceId, sessionEntryId) {
  return `local:${String(workspaceId ?? '').trim()}:${String(sessionEntryId ?? '').trim()}`
}

function externalSessionOverrideKey(workspacePath, sessionEntryId) {
  return `external:${normalizePath(workspacePath) || '__global__'}:${String(sessionEntryId ?? '').trim()}`
}

function applyLocalSessionTitleOverride(workspaceId, entry) {
  const overrides = readSessionTitleOverrides()
  const override = overrides[localSessionOverrideKey(workspaceId, entry.id)]
  if (typeof override !== 'string' || !override.trim()) return entry
  return { ...entry, title: override.trim() }
}

function setLocalSessionTitleOverride(workspaceId, sessionEntryId, title) {
  const trimmedTitle = String(title ?? '').trim()
  if (!trimmedTitle) return { ok: false, error: 'title is required' }
  const overrides = readSessionTitleOverrides()
  overrides[localSessionOverrideKey(workspaceId, sessionEntryId)] = trimmedTitle
  writeSessionTitleOverrides(overrides)
  return { ok: true, title: trimmedTitle }
}

function deleteLocalSessionTitleOverride(workspaceId, sessionEntryId) {
  const overrides = readSessionTitleOverrides()
  const key = localSessionOverrideKey(workspaceId, sessionEntryId)
  if (!(key in overrides)) return
  delete overrides[key]
  writeSessionTitleOverrides(overrides)
}

function setExternalSessionTitleOverride(workspacePath, sessionEntryId, title) {
  const trimmedTitle = String(title ?? '').trim()
  if (!trimmedTitle) return { ok: false, error: 'title is required' }
  const overrides = readSessionTitleOverrides()
  overrides[externalSessionOverrideKey(workspacePath, sessionEntryId)] = trimmedTitle
  writeSessionTitleOverrides(overrides)
  invalidateExternalSessionCache(workspacePath)
  return { ok: true, title: trimmedTitle }
}

function deleteExternalSessionTitleOverride(workspacePath, sessionEntryId) {
  const overrides = readSessionTitleOverrides()
  const key = externalSessionOverrideKey(workspacePath, sessionEntryId)
  if (!(key in overrides)) return
  delete overrides[key]
  writeSessionTitleOverrides(overrides)
  invalidateExternalSessionCache(workspacePath)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function emptyLegacyConfig() {
  return {
    version: 2,
    projects: [],
    workspaces: [],
    activeWorkspaceId: null,
    settings: {},
  }
}

function normalizeProject(project) {
  const id = String(project?.id ?? '').trim()
  const path = normalizePath(project?.path)
  if (!id || !path) return null
  return {
    id,
    name: String(project?.name ?? basename(path) ?? 'Project').trim() || basename(path) || 'Project',
    path,
  }
}

function builtinExecutionHosts() {
  return [
    {
      id: 'local-runtime',
      type: 'runtime',
      label: 'This app',
      enabled: true,
      url: null,
      authToken: null,
    },
    {
      id: 'local-daemon',
      type: 'local-daemon',
      label: 'Local daemon',
      enabled: true,
      url: 'http://127.0.0.1',
      authToken: null,
    },
  ]
}

function normalizeExecutionHost(host) {
  const id = String(host?.id ?? '').trim()
  const type = String(host?.type ?? '').trim()
  if (!id || !type) return null
  if (!['runtime', 'local-daemon', 'remote-daemon'].includes(type)) return null
  return {
    id,
    type,
    label: String(host?.label ?? id).trim() || id,
    enabled: host?.enabled !== false,
    url: typeof host?.url === 'string' && host.url.trim().length > 0 ? host.url.trim() : null,
    authToken: typeof host?.authToken === 'string' && host.authToken.trim().length > 0 ? host.authToken.trim() : null,
  }
}

function mergeExecutionHosts(records) {
  const merged = new Map()
  for (const builtin of builtinExecutionHosts()) {
    merged.set(builtin.id, builtin)
  }
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizeExecutionHost(record)
    if (!normalized) continue
    const base = merged.get(normalized.id)
    merged.set(normalized.id, {
      ...(base ?? {}),
      ...normalized,
    })
  }
  return [...merged.values()].sort((a, b) => {
    const orderA = a.id === 'local-runtime' ? 0 : (a.id === 'local-daemon' ? 1 : 2)
    const orderB = b.id === 'local-runtime' ? 0 : (b.id === 'local-daemon' ? 1 : 2)
    if (orderA !== orderB) return orderA - orderB
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })
}

function normalizeWorkspaceRecord(workspace) {
  const id = String(workspace?.id ?? '').trim()
  if (!id) return null
  const projectIds = Array.from(new Set(
    Array.isArray(workspace?.projectIds)
      ? workspace.projectIds.map(projectId => String(projectId ?? '').trim()).filter(Boolean)
      : [],
  ))
  const explicitPrimary = typeof workspace?.primaryProjectId === 'string'
    ? workspace.primaryProjectId.trim()
    : null
  return {
    id,
    name: String(workspace?.name ?? '').trim() || 'Workspace',
    projectIds,
    primaryProjectId: explicitPrimary && projectIds.includes(explicitPrimary)
      ? explicitPrimary
      : (projectIds[0] ?? null),
  }
}

function ensureProjectForPath(state, folderPath) {
  const normalizedPath = normalizePath(folderPath)
  const existing = state.projects.find(project => normalizePath(project.path) === normalizedPath)
  if (existing) return { state, project: existing }
  const project = {
    id: makeId('project'),
    name: basename(normalizedPath) || 'Project',
    path: normalizedPath,
  }
  return {
    state: { ...state, projects: [...state.projects, project] },
    project,
  }
}

function migrateLegacyConfig(raw) {
  const config = emptyLegacyConfig()
  config.settings = typeof raw?.settings === 'object' && raw.settings ? raw.settings : {}
  const legacyWorkspaces = Array.isArray(raw?.workspaces) ? raw.workspaces : []
  for (const legacyWorkspace of legacyWorkspaces) {
    const id = String(legacyWorkspace?.id ?? '').trim() || makeId('ws')
    const name = String(legacyWorkspace?.name ?? '').trim() || 'Workspace'
    const candidatePaths = [
      ...(Array.isArray(legacyWorkspace?.projectPaths) ? legacyWorkspace.projectPaths : []),
      ...(typeof legacyWorkspace?.path === 'string' ? [legacyWorkspace.path] : []),
    ]
    let projectIds = []
    let next = config
    for (const candidatePath of candidatePaths) {
      const normalized = normalizePath(candidatePath)
      if (!normalized) continue
      const ensured = ensureProjectForPath(next, normalized)
      next = ensured.state
      if (!projectIds.includes(ensured.project.id)) projectIds.push(ensured.project.id)
    }
    config.projects = next.projects
    config.workspaces.push({
      id,
      name,
      projectIds,
      primaryProjectId: projectIds[0] ?? null,
    })
  }
  const activeWorkspaceIndex = Number.isInteger(raw?.activeWorkspaceIndex)
    ? Math.max(0, Number(raw.activeWorkspaceIndex))
    : 0
  config.activeWorkspaceId = config.workspaces[activeWorkspaceIndex]?.id ?? config.workspaces[0]?.id ?? null
  return config
}

function loadLegacyConfig() {
  const parsed = readJsonFile(LEGACY_CONFIG_PATH, emptyLegacyConfig())
  if (parsed?.version === 2 && Array.isArray(parsed?.projects) && Array.isArray(parsed?.workspaces)) {
    return {
      version: 2,
      projects: parsed.projects.map(normalizeProject).filter(Boolean),
      workspaces: parsed.workspaces.map(normalizeWorkspaceRecord).filter(Boolean),
      activeWorkspaceId: typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null,
      settings: typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {},
    }
  }
  return migrateLegacyConfig(parsed)
}

function ensureStateFiles() {
  ensureDir(join(HOME, 'daemon'))
  ensureDir(join(HOME, 'workspaces'))
  ensureDir(join(HOME, 'projects'))
  ensureDir(join(HOME, 'hosts'))

  if (!existsSync(WORKSPACES_FILE) || !existsSync(PROJECTS_FILE) || !existsSync(SETTINGS_FILE) || !existsSync(HOSTS_FILE)) {
    const legacy = loadLegacyConfig()
    if (!existsSync(WORKSPACES_FILE)) {
      atomicWriteJson(WORKSPACES_FILE, {
        version: 1,
        activeWorkspaceId: legacy.activeWorkspaceId,
        workspaces: legacy.workspaces,
      })
    }
    if (!existsSync(PROJECTS_FILE)) {
      atomicWriteJson(PROJECTS_FILE, {
        version: 1,
        projects: legacy.projects,
      })
    }
    if (!existsSync(SETTINGS_FILE)) {
      atomicWriteJson(SETTINGS_FILE, {
        version: 1,
        settings: legacy.settings ?? {},
      })
    }
    if (!existsSync(HOSTS_FILE)) {
      atomicWriteJson(HOSTS_FILE, {
        version: 1,
        hosts: builtinExecutionHosts(),
      })
    }
  }
}

function isActiveJobStatus(status) {
  return status === 'running' || status === 'starting' || status === 'queued' || status === 'reconnecting'
}

function readDaemonJobRecords(limit = 100, liveJobIds = new Set()) {
  const jobsDir = join(HOME, 'jobs')
  if (!existsSync(jobsDir)) return []

  const records = []
  for (const entry of readDirNames(jobsDir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(jobsDir, entry), 'utf8'))
      if (!parsed || typeof parsed.id !== 'string') continue
      const rawStatus = typeof parsed.status === 'string' ? parsed.status : 'unknown'
      const status = isActiveJobStatus(rawStatus) && !liveJobIds.has(parsed.id)
        ? 'lost'
        : rawStatus
      records.push({
        id: parsed.id,
        taskLabel: typeof parsed.taskLabel === 'string' ? parsed.taskLabel : null,
        status,
        runMode: typeof parsed.runMode === 'string' ? parsed.runMode : 'foreground',
        workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : null,
        cardId: typeof parsed.cardId === 'string' ? parsed.cardId : null,
        provider: typeof parsed.provider === 'string' ? parsed.provider : null,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        workspaceDir: typeof parsed.workspaceDir === 'string' ? parsed.workspaceDir : null,
        initialPrompt: typeof parsed.initialPrompt === 'string' ? parsed.initialPrompt : null,
        requestedAt: typeof parsed.requestedAt === 'string' ? parsed.requestedAt : null,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
        lastSequence: typeof parsed.lastSequence === 'number' ? parsed.lastSequence : 0,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
      })
    } catch {
      // ignore corrupt metadata
    }
  }

  return records
    .sort((a, b) => {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0
      return bTime - aTime
    })
    .slice(0, limit)
}

function summarizeDaemonJobs(records) {
  return records.reduce((acc, record) => {
    acc.total += 1
    if (isActiveJobStatus(record.status)) {
      acc.active += 1
      if (record.runMode === 'background') acc.backgroundActive += 1
    } else if (record.status === 'completed') {
      acc.completed += 1
    } else if (record.status === 'failed' || record.status === 'lost') {
      acc.failed += 1
    } else if (record.status === 'cancelled') {
      acc.cancelled += 1
    } else {
      acc.other += 1
    }
    return acc
  }, {
    total: 0,
    active: 0,
    backgroundActive: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    other: 0,
  })
}

function readDaemonJobTimeline(jobId, limit = 200) {
  const safeId = String(jobId ?? '').trim()
  if (!safeId || /[\/\\]|\\.\\./.test(safeId)) return []

  const timelinePath = join(HOME, 'timelines', `${safeId}.jsonl`)
  if (!existsSync(timelinePath)) return []

  const stats = statSync(timelinePath)
  const events = []
  const BUFFER_SIZE = 8192
  const file = readFileSync(timelinePath, 'utf8')
  
  // For small files, parse all (cheaper than reverse iteration)
  if (stats.size < BUFFER_SIZE * 10) {
    const lines = file.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed.sequence === 'number') {
          events.push(parsed)
          if (events.length >= limit) break
        }
      } catch {
        // ignore corrupt timeline entries
      }
    }
    return events
  }
  
  // For large files, read from end backwards (much faster)
  const lines = file.split('\n')
  let collected = 0
  for (let i = lines.length - 1; i >= 0 && collected < limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.sequence === 'number') {
        events.push(parsed)
        collected++
      }
    } catch {
      // ignore corrupt timeline entries
    }
  }
  
  // Reverse to maintain chronological order
  return events.reverse()
}

function agentKanbanBoardPath(workspacePath) {
  const safe = String(workspacePath || 'default')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80)
  return join(AGENT_KANBAN_DIR, `${safe}.json`)
}

function defaultAgentKanbanBoard() {
  return {
    columns: [
      { id: 'backlog', label: 'Backlog', cards: [] },
      { id: 'in_progress', label: 'In Progress', cards: [] },
      { id: 'review', label: 'Review', cards: [] },
      { id: 'trash', label: 'Trash', cards: [] },
    ],
    dependencies: [],
    version: 2,
  }
}

function readAgentKanbanBoard(workspacePath) {
  return readJsonFile(agentKanbanBoardPath(workspacePath), defaultAgentKanbanBoard())
}

function writeAgentKanbanBoard(workspacePath, board) {
  atomicWriteJson(agentKanbanBoardPath(workspacePath), board)
}

function agentKanbanTaskTitle(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim()
  if (!text) return 'Untitled task'
  return text.length > 96 ? `${text.slice(0, 95).trimEnd()}…` : text
}

function createShortTaskId() {
  return randomUUID().replaceAll('-', '').slice(0, 5)
}

function createUniqueAgentKanbanTaskId(board) {
  const existing = new Set(board.columns.flatMap(column => column.cards.map(card => card.id)))
  for (let index = 0; index < 16; index += 1) {
    const id = createShortTaskId()
    if (!existing.has(id)) return id
  }
  return (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 5)
}

function findAgentKanbanTask(board, taskId) {
  for (let columnIndex = 0; columnIndex < board.columns.length; columnIndex += 1) {
    const column = board.columns[columnIndex]
    const taskIndex = column.cards.findIndex(card => card.id === taskId)
    if (taskIndex !== -1) {
      return {
        columnIndex,
        taskIndex,
        columnId: column.id,
        task: column.cards[taskIndex],
      }
    }
  }
  return null
}

function getAgentKanbanTaskColumnId(board, taskId) {
  return findAgentKanbanTask(board, taskId)?.columnId ?? null
}

function normalizeAgentKanbanDependencies(board) {
  if (!Array.isArray(board.dependencies) || board.dependencies.length === 0) return board
  const allIds = new Set(board.columns.flatMap(column => column.cards.map(card => card.id)))
  const seen = new Set()
  const dependencies = []
  for (const dep of board.dependencies) {
    const fromTaskId = String(dep?.fromTaskId ?? '').trim()
    const toTaskId = String(dep?.toTaskId ?? '').trim()
    if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) continue
    if (!allIds.has(fromTaskId) || !allIds.has(toTaskId)) continue
    const fromColumnId = getAgentKanbanTaskColumnId(board, fromTaskId)
    const toColumnId = getAgentKanbanTaskColumnId(board, toTaskId)
    if (!fromColumnId || !toColumnId || fromColumnId === 'trash' || toColumnId === 'trash') continue
    const key = `${fromTaskId}::${toTaskId}`
    if (seen.has(key)) continue
    seen.add(key)
    dependencies.push({
      id: String(dep?.id ?? randomUUID().replaceAll('-', '').slice(0, 8)),
      fromTaskId,
      toTaskId,
      createdAt: Number(dep?.createdAt ?? Date.now()),
    })
  }
  return { ...board, dependencies }
}

function addAgentKanbanTask(board, columnId, input) {
  const task = {
    id: createUniqueAgentKanbanTaskId(board),
    prompt: String(input?.prompt ?? '').trim(),
    agentId: String(input?.agentId ?? 'claude').trim() || 'claude',
    baseRef: String(input?.baseRef ?? 'HEAD').trim() || 'HEAD',
    startInPlanMode: Boolean(input?.startInPlanMode),
    autoReviewEnabled: Boolean(input?.autoReviewEnabled),
    autoReviewMode: String(input?.autoReviewMode ?? 'commit').trim() || 'commit',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const columns = board.columns.map(column =>
    column.id === columnId
      ? { ...column, cards: [task, ...column.cards] }
      : column
  )
  return { board: { ...board, columns }, task }
}

function moveAgentKanbanTask(board, taskId, targetColumnId) {
  const loc = findAgentKanbanTask(board, taskId)
  if (!loc) return { moved: false, board, task: null, fromColumnId: null }
  if (loc.columnId === targetColumnId) {
    return { moved: false, board, task: loc.task, fromColumnId: loc.columnId }
  }

  const movedTask = { ...loc.task, updatedAt: Date.now() }
  const columns = board.columns.map((column, columnIndex) => {
    if (columnIndex === loc.columnIndex) {
      return { ...column, cards: column.cards.filter((_, taskIndex) => taskIndex !== loc.taskIndex) }
    }
    if (column.id === targetColumnId) {
      return {
        ...column,
        cards: targetColumnId === 'trash'
          ? [movedTask, ...column.cards]
          : [...column.cards, movedTask],
      }
    }
    return column
  })
  return {
    moved: true,
    board: normalizeAgentKanbanDependencies({ ...board, columns }),
    task: movedTask,
    fromColumnId: loc.columnId,
  }
}

function updateAgentKanbanTask(board, taskId, input) {
  let updatedTask = null
  const columns = board.columns.map(column => ({
    ...column,
    cards: column.cards.map(card => {
      if (card.id !== taskId) return card
      updatedTask = { ...card, ...input, id: card.id, updatedAt: Date.now() }
      return updatedTask
    }),
  }))
  return { board: { ...board, columns }, task: updatedTask, updated: Boolean(updatedTask) }
}

function deleteAgentKanbanTask(board, taskId) {
  const columns = board.columns.map(column => ({
    ...column,
    cards: column.cards.filter(card => card.id !== taskId),
  }))
  const dependencies = board.dependencies.filter(dep => dep.fromTaskId !== taskId && dep.toTaskId !== taskId)
  return { board: { ...board, columns, dependencies } }
}

function addAgentKanbanDependency(board, fromTaskId, toTaskId) {
  const fromId = String(fromTaskId ?? '').trim()
  const toId = String(toTaskId ?? '').trim()
  if (!fromId || !toId || fromId === toId) return { board, added: false, reason: 'same_task' }

  const fromColumnId = getAgentKanbanTaskColumnId(board, fromId)
  const toColumnId = getAgentKanbanTaskColumnId(board, toId)
  if (!fromColumnId || !toColumnId) return { board, added: false, reason: 'missing_task' }
  if (fromColumnId === 'trash' || toColumnId === 'trash') return { board, added: false, reason: 'trash_task' }

  let backlogId = fromId
  let linkedId = toId
  if (fromColumnId !== 'backlog' && toColumnId === 'backlog') {
    backlogId = toId
    linkedId = fromId
  }
  if (fromColumnId !== 'backlog' && toColumnId !== 'backlog') return { board, added: false, reason: 'non_backlog' }

  const duplicate = board.dependencies.some(dep => dep.fromTaskId === backlogId && dep.toTaskId === linkedId)
  if (duplicate) return { board, added: false, reason: 'duplicate' }

  const dependency = {
    id: randomUUID().replaceAll('-', '').slice(0, 8),
    fromTaskId: backlogId,
    toTaskId: linkedId,
    createdAt: Date.now(),
  }
  return {
    board: { ...board, dependencies: [...board.dependencies, dependency] },
    added: true,
    dependency,
  }
}

function removeAgentKanbanDependency(board, dependencyId) {
  const dependencies = board.dependencies.filter(dep => dep.id !== dependencyId)
  if (dependencies.length === board.dependencies.length) return { board, removed: false }
  return { board: { ...board, dependencies }, removed: true }
}

function annotateAgentKanbanTask(task) {
  return {
    ...task,
    title: agentKanbanTaskTitle(task.prompt),
    worktreeCreated: false,
    session: null,
  }
}

function buildAgentKanbanBoardPayload(workspacePath, board) {
  return {
    workspacePath: workspacePath || '',
    projectName: workspacePath ? basename(workspacePath) : 'default',
    updatedAt: new Date().toISOString(),
    version: board.version || 1,
    dependencies: Array.isArray(board.dependencies) ? board.dependencies : [],
    columns: board.columns.map(column => ({
      ...column,
      cards: column.cards.map(annotateAgentKanbanTask),
    })),
  }
}

function buildAgentKanbanSummary(workspacePath, board) {
  const tasks = board.columns.flatMap(column =>
    column.cards.map(task => ({
      ...annotateAgentKanbanTask(task),
      columnId: column.id,
    })),
  )
  const counts = {
    backlog: tasks.filter(task => task.columnId === 'backlog').length,
    active: tasks.filter(task => task.columnId === 'in_progress').length,
    review: tasks.filter(task => task.columnId === 'review').length,
    completed: tasks.filter(task => task.columnId === 'trash').length,
    failed: 0,
    total: tasks.length,
  }
  return {
    workspacePath: workspacePath || '',
    projectName: workspacePath ? basename(workspacePath) : 'default',
    updatedAt: new Date().toISOString(),
    counts,
    checklist: tasks
      .filter(task => task.columnId !== 'trash')
      .slice(0, 8)
      .map(task => ({
        id: task.id,
        title: task.title,
        done: false,
        state: 'idle',
        columnId: task.columnId,
      })),
    tasks: tasks.map(task => ({
      id: task.id,
      title: task.title,
      columnId: task.columnId,
      state: 'idle',
      agentId: task.agentId || 'claude',
      blocked: false,
    })),
  }
}

function renderDashboardHtml() {
  const initialJobs = readDaemonJobRecords(50, new Set(chatJobs.listLiveJobIds()))
  const initialSummary = summarizeDaemonJobs(initialJobs)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeSurf Daemon</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #111317;
        --panel: #171b21;
        --panel-2: #1d222b;
        --text: #edf2f7;
        --muted: #97a3b6;
        --border: #2a3140;
        --accent: #79a8ff;
        --green: #4ad295;
        --red: #ff7b72;
        --yellow: #f4c96b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #0f1115 0%, var(--bg) 100%);
        color: var(--text);
      }
      .wrap {
        max-width: 1400px;
        margin: 0 auto;
        padding: 24px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 16px;
        margin-bottom: 20px;
      }
      .title {
        font-size: 28px;
        font-weight: 650;
        letter-spacing: 0.02em;
      }
      .sub {
        color: var(--muted);
        font-size: 13px;
        margin-top: 6px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
        color: var(--muted);
        font-size: 12px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--green);
        box-shadow: 0 0 0 4px rgba(74,210,149,0.12);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 20px;
      }
      .stat {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 14px 16px;
      }
      .stat-label {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .stat-value {
        font-size: 24px;
        font-weight: 650;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(420px, 540px) minmax(0, 1fr);
        gap: 16px;
        min-height: 620px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        overflow: hidden;
        min-height: 0;
      }
      .panel-header {
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .panel-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .jobs {
        display: flex;
        flex-direction: column;
        max-height: 740px;
        overflow: auto;
      }
      .job {
        width: 100%;
        text-align: left;
        border: 0;
        background: transparent;
        color: inherit;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
      }
      .job:hover, .job.active {
        background: var(--panel-2);
      }
      .job-top, .job-bottom {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .job-top { margin-bottom: 7px; }
      .job-id {
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status {
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        border: 1px solid var(--border);
      }
      .status.running, .status.starting, .status.queued, .status.reconnecting { color: var(--yellow); }
      .status.completed { color: var(--green); }
      .status.failed, .status.lost, .status.cancelled { color: var(--red); }
      .job-meta {
        color: var(--muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .detail {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
      }
      .detail-body {
        padding: 16px;
        display: grid;
        gap: 14px;
      }
      .kv {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 8px 12px;
        align-items: baseline;
        font-size: 13px;
      }
      .kv .k { color: var(--muted); }
      .mono {
        font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
        font-size: 12px;
        word-break: break-word;
      }
      .error {
        color: var(--red);
        background: rgba(255,123,114,0.08);
        border: 1px solid rgba(255,123,114,0.22);
        border-radius: 12px;
        padding: 12px;
      }
      .timeline {
        border-top: 1px solid var(--border);
        padding: 0;
        margin: 0;
        list-style: none;
        max-height: 420px;
        overflow: auto;
      }
      .event {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
      }
      .event-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 6px;
      }
      .event-type {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .event-seq {
        color: var(--muted);
        font-size: 12px;
      }
      .event-text {
        color: var(--text);
        font-size: 13px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty {
        color: var(--muted);
        padding: 24px 16px;
        text-align: center;
      }
      @media (max-width: 980px) {
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <div>
          <div class="title">CodeSurf Daemon Jobs</div>
          <div class="sub">Read-only dashboard for daemon-backed chat execution.</div>
        </div>
        <div class="pill"><span class="dot"></span><span>Daemon active</span></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-label">Active</div><div class="stat-value" id="stat-active">${initialSummary.active}</div></div>
        <div class="stat"><div class="stat-label">Completed</div><div class="stat-value" id="stat-completed">${initialSummary.completed}</div></div>
        <div class="stat"><div class="stat-label">Failed</div><div class="stat-value" id="stat-failed">${initialSummary.failed}</div></div>
        <div class="stat"><div class="stat-label">Cancelled</div><div class="stat-value" id="stat-cancelled">${initialSummary.cancelled}</div></div>
        <div class="stat"><div class="stat-label">Total</div><div class="stat-value" id="stat-total">${initialSummary.total}</div></div>
      </div>
      <div class="layout">
        <section class="panel">
          <div class="panel-header">
            <div class="panel-title">Jobs</div>
            <div class="sub" id="jobs-count">${initialJobs.length} loaded</div>
          </div>
          <div class="jobs" id="jobs"></div>
        </section>
        <section class="panel detail">
          <div class="panel-header">
            <div class="panel-title">Detail</div>
            <div class="sub" id="detail-updated">Waiting</div>
          </div>
          <div class="detail-body" id="detail-body">
            <div class="empty">Select a job to inspect its timeline.</div>
          </div>
          <ul class="timeline" id="timeline"></ul>
        </section>
      </div>
    </div>
    <script>
      const token = new URLSearchParams(window.location.search).get('token') || '';
      const jobsEl = document.getElementById('jobs');
      const detailBodyEl = document.getElementById('detail-body');
      const timelineEl = document.getElementById('timeline');
      const detailUpdatedEl = document.getElementById('detail-updated');
      const stats = {
        active: document.getElementById('stat-active'),
        completed: document.getElementById('stat-completed'),
        failed: document.getElementById('stat-failed'),
        cancelled: document.getElementById('stat-cancelled'),
        total: document.getElementById('stat-total'),
      };
      const jobsCountEl = document.getElementById('jobs-count');
      let selectedJobId = null;

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function fmtTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
      }

      async function api(path) {
        const url = new URL(path, window.location.origin);
        if (token) url.searchParams.set('token', token);
        const res = await fetch(url);
        if (!res.ok) throw new Error('Request failed: ' + res.status);
        return await res.json();
      }

      function renderJobs(payload) {
        const jobs = payload.jobs || [];
        jobsCountEl.textContent = jobs.length + ' loaded';
        stats.active.textContent = String(payload.summary.active || 0);
        stats.completed.textContent = String(payload.summary.completed || 0);
        stats.failed.textContent = String(payload.summary.failed || 0);
        stats.cancelled.textContent = String(payload.summary.cancelled || 0);
        stats.total.textContent = String(payload.summary.total || 0);

        if (!selectedJobId && jobs.length) {
          selectedJobId = jobs[0].id;
        }
        if (selectedJobId && !jobs.some(job => job.id === selectedJobId)) {
          selectedJobId = jobs[0] ? jobs[0].id : null;
        }

        jobsEl.innerHTML = jobs.length ? jobs.map(job => {
          const active = job.id === selectedJobId ? ' active' : '';
          const statusClass = escapeHtml(job.status || 'unknown');
          return '<button class="job' + active + '" data-job-id="' + escapeHtml(job.id) + '">' +
            '<div class="job-top">' +
              '<div class="job-id">' + escapeHtml(job.taskLabel || job.id) + '</div>' +
              '<div class="status ' + statusClass + '">' + escapeHtml(job.status || 'unknown') + '</div>' +
            '</div>' +
            '<div class="job-bottom">' +
              '<div class="job-meta">' + escapeHtml([job.provider, job.model].filter(Boolean).join(' · ') || 'Unknown provider') + '</div>' +
              '<div class="job-meta">' + escapeHtml(fmtTime(job.updatedAt)) + '</div>' +
            '</div>' +
          '</button>';
        }).join('') : '<div class="empty">No daemon jobs recorded yet.</div>';

        jobsEl.querySelectorAll('[data-job-id]').forEach(button => {
          button.addEventListener('click', () => {
            selectedJobId = button.getAttribute('data-job-id');
            void refreshDetail();
            void refreshJobs();
          });
        });
      }

      function renderDetail(payload) {
        const job = payload.job;
        const timeline = payload.timeline || [];
        if (!job) {
          detailBodyEl.innerHTML = '<div class="empty">Select a job to inspect its timeline.</div>';
          timelineEl.innerHTML = '';
          detailUpdatedEl.textContent = 'Waiting';
          return;
        }

        detailUpdatedEl.textContent = 'Updated ' + fmtTime(job.updatedAt);
        detailBodyEl.innerHTML =
          '<div class="kv">' +
            '<div class="k">Job</div><div class="mono">' + escapeHtml(job.id) + '</div>' +
            '<div class="k">Task</div><div>' + escapeHtml(job.taskLabel || '—') + '</div>' +
            '<div class="k">Status</div><div>' + escapeHtml(job.status || 'unknown') + '</div>' +
            '<div class="k">Provider</div><div>' + escapeHtml(job.provider || '—') + '</div>' +
            '<div class="k">Model</div><div>' + escapeHtml(job.model || '—') + '</div>' +
            '<div class="k">Workspace</div><div class="mono">' + escapeHtml(job.workspaceDir || '—') + '</div>' +
            '<div class="k">Requested</div><div>' + escapeHtml(fmtTime(job.requestedAt)) + '</div>' +
            '<div class="k">Completed</div><div>' + escapeHtml(fmtTime(job.completedAt)) + '</div>' +
            '<div class="k">Session</div><div class="mono">' + escapeHtml(job.sessionId || '—') + '</div>' +
            '<div class="k">Sequence</div><div>' + escapeHtml(String(job.lastSequence || 0)) + '</div>' +
          '</div>' +
          (job.error ? '<div class="error mono">' + escapeHtml(job.error) + '</div>' : '');

        timelineEl.innerHTML = timeline.length ? timeline.map(event => (
          '<li class="event">' +
            '<div class="event-top">' +
              '<div class="event-type">' + escapeHtml(event.type || 'event') + '</div>' +
              '<div class="event-seq">#' + escapeHtml(String(event.sequence || 0)) + '</div>' +
            '</div>' +
            '<div class="event-text mono">' + escapeHtml(
              event.text || event.error || event.resultText || event.toolName || event.sessionId || JSON.stringify(event)
            ) + '</div>' +
          '</li>'
        )).join('') : '<li class="empty">No timeline recorded yet.</li>';
      }

      async function refreshJobs() {
        try {
          const payload = await api('/dashboard/api/jobs');
          renderJobs(payload);
        } catch (error) {
          jobsEl.innerHTML = '<div class="empty">' + escapeHtml(error.message || String(error)) + '</div>';
        }
      }

      async function refreshDetail() {
        if (!selectedJobId) {
          renderDetail({ job: null, timeline: [] });
          return;
        }
        try {
          const payload = await api('/dashboard/api/job?jobId=' + encodeURIComponent(selectedJobId));
          renderDetail(payload);
        } catch (error) {
          detailBodyEl.innerHTML = '<div class="error mono">' + escapeHtml(error.message || String(error)) + '</div>';
          timelineEl.innerHTML = '';
        }
      }

      async function refreshAll() {
        await refreshJobs();
        await refreshDetail();
      }

      void refreshAll();
      window.setInterval(() => { void refreshAll(); }, 3000);
    </script>
  </body>
</html>`
}

function readWorkspaceState() {
  ensureStateFiles()
  const workspaceDoc = readJsonFile(WORKSPACES_FILE, { version: 1, activeWorkspaceId: null, workspaces: [] })
  const projectDoc = readJsonFile(PROJECTS_FILE, { version: 1, projects: [] })
  const hostsDoc = readJsonFile(HOSTS_FILE, { version: 1, hosts: builtinExecutionHosts() })
  const settingsDoc = readJsonFile(SETTINGS_FILE, { version: 1, settings: {} })
  const projects = Array.isArray(projectDoc.projects) ? projectDoc.projects.map(normalizeProject).filter(Boolean) : []
  const projectIds = new Set(projects.map(project => project.id))
  const workspaces = Array.isArray(workspaceDoc.workspaces)
    ? workspaceDoc.workspaces
      .map(normalizeWorkspaceRecord)
      .filter(Boolean)
      .map(workspace => ({
        ...workspace,
        projectIds: workspace.projectIds.filter(projectId => projectIds.has(projectId)),
        primaryProjectId: workspace.primaryProjectId && projectIds.has(workspace.primaryProjectId)
          ? workspace.primaryProjectId
          : (workspace.projectIds.find(projectId => projectIds.has(projectId)) ?? null),
      }))
    : []
  return {
    projects,
    hosts: mergeExecutionHosts(hostsDoc.hosts),
    workspaces,
    activeWorkspaceId: typeof workspaceDoc.activeWorkspaceId === 'string'
      ? workspaceDoc.activeWorkspaceId
      : (workspaces[0]?.id ?? null),
    settings: typeof settingsDoc.settings === 'object' && settingsDoc.settings ? settingsDoc.settings : {},
  }
}

function writeWorkspaceState(state) {
  atomicWriteJson(WORKSPACES_FILE, {
    version: 1,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces,
  })
  atomicWriteJson(PROJECTS_FILE, {
    version: 1,
    projects: state.projects,
  })
}

function writeHosts(hosts) {
  atomicWriteJson(HOSTS_FILE, {
    version: 1,
    hosts: mergeExecutionHosts(hosts),
  })
}

function writeSettings(settings) {
  atomicWriteJson(SETTINGS_FILE, {
    version: 1,
    settings,
  })
}

function materializeWorkspace(workspace, projects) {
  const byId = new Map(projects.map(project => [project.id, project]))
  const entries = workspace.projectIds.map(id => byId.get(id)).filter(Boolean)
  const primary = workspace.primaryProjectId ? (byId.get(workspace.primaryProjectId) ?? entries[0] ?? null) : (entries[0] ?? null)
  return {
    id: workspace.id,
    name: workspace.name,
    path: primary?.path ?? '',
    projectPaths: entries.map(project => project.path),
  }
}

function assertSafeId(id) {
  if (/[\/\\]|\.\./.test(String(id ?? ''))) {
    throw new Error(`Unsafe ID: ${id}`)
  }
}

function workspaceContexDir(workspaceId) {
  assertSafeId(workspaceId)
  return join(HOME, 'workspaces', workspaceId, '.contex')
}

function tileStatePath(workspaceId, tileId) {
  assertSafeId(workspaceId)
  assertSafeId(tileId)
  return join(workspaceContexDir(workspaceId), `tile-state-${tileId}.json`)
}

function tileSessionSummaryPath(workspaceId, tileId) {
  assertSafeId(workspaceId)
  assertSafeId(tileId)
  return join(workspaceContexDir(workspaceId), `tile-session-${tileId}.json`)
}

function truncateSessionText(text, length = SESSION_TEXT_LIMIT) {
  if (!text) return null
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function sessionTitleFromText(text, provider) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return `${provider} session`
  return trimmed.split(/\r?\n/, 1)[0].slice(0, 80)
}

function extractSessionTitle(messages, provider) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const text = truncateSessionText(typeof message.content === 'string' ? message.content : null)
    if (!text) continue
    return sessionTitleFromText(text, provider)
  }
  return null
}

function extractTileSessionSummary(tileId, state) {
  if (!state || typeof state !== 'object') return null
  const record = state
  const messages = Array.isArray(record.messages) ? record.messages : null
  if (!messages || messages.length === 0) return null

  let lastMessage = null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    const text = truncateSessionText(typeof message.content === 'string' ? message.content : null)
    if (text) {
      lastMessage = text
      break
    }
  }

  const provider = typeof record.provider === 'string' && record.provider.trim()
    ? record.provider
    : 'claude'
  const model = typeof record.model === 'string' ? record.model : ''
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null

  return {
    version: 1,
    tileId,
    sessionId,
    provider,
    model,
    messageCount: messages.length,
    lastMessage,
    title: extractSessionTitle(messages, provider) ?? sessionTitleFromText(lastMessage, provider),
    updatedAt: Date.now(),
  }
}

function pathExists(filePath) {
  return existsSync(filePath)
}

function moveFileToDeleted(filePath) {
  const sourceDir = dirname(filePath)
  const deletedDir = join(sourceDir, 'deleted')
  ensureDir(deletedDir)

  const base = basename(filePath)
  let targetPath = join(deletedDir, base)
  if (pathExists(targetPath)) {
    targetPath = join(deletedDir, `${Date.now()}-${base}`)
  }

  renameSync(filePath, targetPath)
  return targetPath
}

function cleanupOldDeletedFiles(maxAgeDays = 30) {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)
  
  // Clean ~/.contex/deleted
  const homeDeleted = join(HOME, 'deleted')
  if (existsSync(homeDeleted)) {
    try {
      for (const name of readDirNames(homeDeleted)) {
        const filePath = join(homeDeleted, name)
        try {
          const stat = statSync(filePath)
          if (stat.mtimeMs < cutoff) {
            rmSync(filePath, { force: true })
          }
        } catch {
          // ignore stat errors
        }
      }
    } catch {
      // ignore directory read errors
    }
  }
  
  // Clean ~/.contex/jobs/deleted
  const jobsDeleted = join(HOME, 'jobs', 'deleted')
  if (existsSync(jobsDeleted)) {
    try {
      for (const name of readDirNames(jobsDeleted)) {
        const filePath = join(jobsDeleted, name)
        try {
          const stat = statSync(filePath)
          if (stat.mtimeMs < cutoff) {
            rmSync(filePath, { force: true })
          }
        } catch {
          // ignore stat errors
        }
      }
    } catch {
      // ignore directory read errors
    }
  }
  
  // Clean ~/.contex/timelines/deleted
  const timelinesDeleted = join(HOME, 'timelines', 'deleted')
  if (existsSync(timelinesDeleted)) {
    try {
      for (const name of readDirNames(timelinesDeleted)) {
        const filePath = join(timelinesDeleted, name)
        try {
          const stat = statSync(filePath)
          if (stat.mtimeMs < cutoff) {
            rmSync(filePath, { force: true })
          }
        } catch {
          // ignore stat errors
        }
      }
    } catch {
      // ignore directory read errors
    }
  }
  
  // Clean workspace .contex/deleted directories
  const workspacesDir = join(HOME, 'workspaces')
  if (existsSync(workspacesDir)) {
    try {
      for (const workspaceId of readDirNames(workspacesDir)) {
        const workspaceDeleted = join(workspacesDir, workspaceId, '.contex', 'deleted')
        if (existsSync(workspaceDeleted)) {
          try {
            for (const name of readDirNames(workspaceDeleted)) {
              const filePath = join(workspaceDeleted, name)
              try {
                const stat = statSync(filePath)
                if (stat.mtimeMs < cutoff) {
                  rmSync(filePath, { force: true })
                }
              } catch {
                // ignore stat errors
              }
            }
          } catch {
            // ignore directory read errors
          }
        }
      }
    } catch {
      // ignore directory read errors
    }
  }
}

function deleteExternalSession(codesurfHome, workspacePath, sessionEntryId) {
  return findSessionEntryById(codesurfHome, workspacePath, sessionEntryId).then(entry => {
    if (!entry?.filePath) return { ok: false, error: 'Session file missing' }
    if (!pathExists(entry.filePath)) return { ok: false, error: 'Session file missing' }

    const deletedPath = moveFileToDeleted(entry.filePath)

    if (entry.source === 'openclaw') {
      const [, agentId, ...keyParts] = sessionEntryId.split(':')
      const sessionKey = keyParts.join(':')
      const indexPath = join(process.env.HOME || process.env.USERPROFILE || homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json')
      if (agentId && sessionKey && pathExists(indexPath)) {
        try {
          const raw = readFileSync(indexPath, 'utf8')
          const parsed = JSON.parse(raw)
          if (parsed?.[sessionKey] && typeof parsed[sessionKey] === 'object') {
            parsed[sessionKey] = {
              ...parsed[sessionKey],
              deletedAt: Date.now(),
              deletedFile: deletedPath,
              sessionFile: deletedPath,
            }
            atomicWriteJson(indexPath, parsed)
          }
        } catch {
          // ignore index update failures; file move already succeeded
        }
      }
    }

    invalidateExternalSessionCache(workspacePath)
    deleteExternalSessionTitleOverride(workspacePath, sessionEntryId)
    return { ok: true }
  })
}

function renameExternalSession(codesurfHome, workspacePath, sessionEntryId, title) {
  return findSessionEntryById(codesurfHome, workspacePath, sessionEntryId).then(entry => {
    if (!entry) return { ok: false, error: 'Session not found' }
    return setExternalSessionTitleOverride(workspacePath, sessionEntryId, title)
  })
}

function listLocalWorkspaceSessions(workspaceId) {
  const dotDir = workspaceContexDir(workspaceId)
  const entries = []
  
  // Scan tile sessions
  if (existsSync(dotDir)) {
    for (const name of readDirNames(dotDir)) {
      if (!name.startsWith('tile-state-') || !name.endsWith('.json')) continue

      const filePath = join(dotDir, name)
      const tileId = name.replace('tile-state-', '').replace('.json', '')
      const summaryPath = tileSessionSummaryPath(workspaceId, tileId)

      let summary = readJsonFile(summaryPath, null)
      
      // Fix 3: Rebuild summary if tile state is newer
      let shouldRebuildSummary = false
      if (!summary) {
        shouldRebuildSummary = true
      } else {
        try {
          const stat = statSync(filePath)
          const summaryStat = statSync(summaryPath)
          // If tile state is newer than summary, rebuild it
          if (!summaryStat || stat.mtimeMs > summaryStat.mtimeMs) {
            shouldRebuildSummary = true
          }
        } catch {
          shouldRebuildSummary = true
        }
      }
      
      if (shouldRebuildSummary) {
        const state = readJsonFile(filePath, null)
        if (!state) continue
        summary = extractTileSessionSummary(tileId, state)
        if (!summary) continue
        try {
          const stat = statSync(filePath)
          summary.updatedAt = stat.mtimeMs
        } catch {}
        atomicWriteJson(summaryPath, summary)
      }

      entries.push(applyLocalSessionTitleOverride(workspaceId, {
        id: `codesurf-tile:${name}`,
        source: 'codesurf',
        scope: 'workspace',
        tileId,
        sessionId: summary.sessionId ?? null,
        provider: summary.provider ?? 'claude',
        model: summary.model ?? '',
        messageCount: Number(summary.messageCount ?? 0),
        lastMessage: summary.lastMessage ?? null,
        updatedAt: Number(summary.updatedAt ?? Date.now()),
        title: summary.title ?? sessionTitleFromText(summary.lastMessage ?? null, summary.provider ?? 'claude'),
        filePath,
        projectPath: resolveWorkspaceProjectPath(workspaceId, null),
        sourceLabel: 'CodeSurf',
        sourceDetail: summary.provider || 'Workspace chat',
        canOpenInChat: true,
        canOpenInApp: false,
        nestingLevel: 0,
      }))
    }
  }

  // Add daemon sessions
  const daemonEntries = listDaemonWorkspaceSessions(workspaceId, entries)
  
  // Fix 1: Session ID deduplication
  // Build a map of sessionId -> best entry (by updatedAt)
  const sessionMap = new Map()
  
  // First, add all tile sessions
  for (const entry of entries) {
    if (!entry.sessionId) {
      // No sessionId, can't dedupe, add directly
      sessionMap.set(`nosession-${entry.id}`, entry)
    } else {
      const existing = sessionMap.get(entry.sessionId)
      if (!existing || entry.updatedAt > existing.updatedAt) {
        sessionMap.set(entry.sessionId, entry)
      }
    }
  }
  
  // Then, add daemon sessions, keeping the most recent for each sessionId
  for (const entry of daemonEntries) {
    if (!entry.sessionId) {
      sessionMap.set(`daemon-${entry.id}`, entry)
    } else {
      const existing = sessionMap.get(entry.sessionId)
      if (!existing || entry.updatedAt > existing.updatedAt) {
        sessionMap.set(entry.sessionId, entry)
      }
    }
  }
  
  // Convert map to array and sort by updatedAt
  const dedupedEntries = Array.from(sessionMap.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  return dedupedEntries
}

function getLocalSessionState(workspaceId, sessionEntryId) {
  const normalizedId = String(sessionEntryId)
  if (normalizedId.startsWith('codesurf-tile:')) {
    const tileId = normalizedId.replace('codesurf-tile:tile-state-', '').replace('.json', '')
    return readJsonFile(tileStatePath(workspaceId, tileId), null)
  }
  if (normalizedId.startsWith('codesurf-job:')) {
    const jobId = normalizedId.replace('codesurf-job:', '')
    return buildDaemonSessionState(jobId, workspaceId)
  }
  return null
}

function deleteLocalSession(workspaceId, sessionEntryId) {
  const normalizedId = String(sessionEntryId)
  if (normalizedId.startsWith('codesurf-tile:')) {
    const tileId = normalizedId.replace('codesurf-tile:tile-state-', '').replace('.json', '')
    const filePath = tileStatePath(workspaceId, tileId)
    if (!pathExists(filePath)) return { ok: false, error: 'Session file missing' }

    moveFileToDeleted(filePath)
    rmSync(tileSessionSummaryPath(workspaceId, tileId), { force: true })
    deleteLocalSessionTitleOverride(workspaceId, sessionEntryId)
    return { ok: true }
  }
  if (normalizedId.startsWith('codesurf-job:')) {
    const jobId = normalizedId.replace('codesurf-job:', '')
    const metadata = readDaemonJobRecord(jobId)
    if (!metadata) return { ok: false, error: 'Job not found' }
    
    // Fix 2: Move to deleted/ instead of rmSync
    const jobFilePath = join(HOME, 'jobs', `${jobId}.json`)
    const timelineFilePath = join(HOME, 'timelines', `${jobId}.jsonl`)
    
    if (pathExists(jobFilePath)) {
      moveFileToDeleted(jobFilePath)
    }
    if (pathExists(timelineFilePath)) {
      moveFileToDeleted(timelineFilePath)
    }
    
    deleteLocalSessionTitleOverride(workspaceId, sessionEntryId)
    return { ok: true }
  }
  return { ok: false, error: 'Unsupported local session id' }
}

function renameLocalSession(workspaceId, sessionEntryId, title) {
  const normalizedId = String(sessionEntryId)
  if (normalizedId.startsWith('codesurf-tile:')) {
    const tileId = normalizedId.replace('codesurf-tile:tile-state-', '').replace('.json', '')
    const filePath = tileStatePath(workspaceId, tileId)
    if (!pathExists(filePath)) return { ok: false, error: 'Session file missing' }
    return setLocalSessionTitleOverride(workspaceId, sessionEntryId, title)
  }
  if (normalizedId.startsWith('codesurf-job:')) {
    const jobId = normalizedId.replace('codesurf-job:', '')
    const metadata = readDaemonJobRecord(jobId)
    if (!metadata) return { ok: false, error: 'Job not found' }
    return setLocalSessionTitleOverride(workspaceId, sessionEntryId, title)
  }
  return { ok: false, error: 'Unsupported local session id' }
}

function readDaemonJobRecord(jobId) {
  const safeId = String(jobId ?? '').trim()
  if (!safeId || /[\/\\]|\.\./.test(safeId)) return null
  const records = readDaemonJobRecords(500, new Set(chatJobs.listLiveJobIds()))
  return records.find(record => record.id === safeId) ?? null
}

function resolveWorkspaceProjectPath(workspaceId, fallbackPath = null) {
  const state = readWorkspaceState()
  const workspace = state.workspaces.find(entry => entry.id === workspaceId)
  if (!workspace) return normalizePath(fallbackPath)
  const materialized = materializeWorkspace(workspace, state.projects)
  const projectPaths = [
    materialized.path,
    ...(Array.isArray(materialized.projectPaths) ? materialized.projectPaths : []),
  ]
    .map(path => normalizePath(path))
    .filter(Boolean)
  return projectPaths[0] ?? normalizePath(fallbackPath)
}

function listDaemonWorkspaceSessions(workspaceId, existingEntries) {
  const state = readWorkspaceState()
  const workspace = state.workspaces.find(entry => entry.id === workspaceId)
  if (!workspace) return []

  const materialized = materializeWorkspace(workspace, state.projects)
  const workspacePaths = new Set([
    materialized.path,
    ...(Array.isArray(materialized.projectPaths) ? materialized.projectPaths : []),
  ].map(path => normalizePath(path)).filter(Boolean))
  if (workspacePaths.size === 0) return []

  const seenSessionIds = new Set(existingEntries.map(entry => entry.sessionId).filter(Boolean))
  const seenTileIds = new Set(existingEntries.map(entry => entry.tileId).filter(Boolean))
  const liveJobIds = new Set(chatJobs.listLiveJobIds())
  const jobs = readDaemonJobRecords(200, liveJobIds)
  const now = Date.now()

  return jobs
    .filter(job => {
      if (job.workspaceId && job.workspaceId !== workspaceId) return false
      const normalizedWorkspaceDir = normalizePath(job.workspaceDir)
      if (!normalizedWorkspaceDir || !workspacePaths.has(normalizedWorkspaceDir)) return false
      if (job.cardId && seenTileIds.has(job.cardId)) return false
      if (job.sessionId && seenSessionIds.has(job.sessionId)) return false
      if (job.status === 'cancelled') return false
      if (isActiveJobStatus(job.status) || job.status === 'lost') return true
      const updatedAt = job.updatedAt ? Date.parse(job.updatedAt) : 0
      return updatedAt > 0 && (now - updatedAt) <= 24 * 60 * 60 * 1000
    })
    .map(job => applyLocalSessionTitleOverride(workspaceId, {
      id: `codesurf-job:${job.id}`,
      source: 'codesurf',
      scope: 'workspace',
      tileId: job.cardId ?? null,
      sessionId: job.sessionId ?? null,
      provider: job.provider ?? 'claude',
      model: job.model ?? '',
      messageCount: 2,
      lastMessage: job.taskLabel ?? job.initialPrompt ?? `${job.provider ?? 'Agent'} task`,
      updatedAt: job.updatedAt ? Date.parse(job.updatedAt) : Date.now(),
      title: sessionTitleFromText(job.initialPrompt ?? job.taskLabel, job.provider ?? 'claude'),
      projectPath: normalizedWorkspaceDirOrNull(job.workspaceDir),
      sourceLabel: 'CodeSurf',
      sourceDetail: `${job.provider ?? 'Agent'} daemon`,
      canOpenInChat: true,
      canOpenInApp: false,
      nestingLevel: 0,
    }))
}

function normalizedWorkspaceDirOrNull(workspaceDir) {
  const normalized = normalizePath(workspaceDir)
  return normalized || null
}

function buildDaemonSessionState(jobId, workspaceId, limit = 100) {
  const metadata = readDaemonJobRecord(jobId)
  if (!metadata) return null

  const timeline = readDaemonJobTimeline(jobId, limit)
  const requestedAt = metadata.requestedAt ? Date.parse(metadata.requestedAt) : Date.now()
  const initialPrompt = String(metadata.initialPrompt ?? metadata.taskLabel ?? `${metadata.provider ?? 'Agent'} task`).trim()
  const userMessage = {
    id: `job-${jobId}-user`,
    role: 'user',
    content: initialPrompt,
    timestamp: Number.isFinite(requestedAt) ? requestedAt : Date.now(),
  }
  const assistantMessage = {
    id: `job-${jobId}-assistant`,
    role: 'assistant',
    content: '',
    timestamp: Number.isFinite(requestedAt) ? requestedAt + 1 : Date.now(),
    isStreaming: isActiveJobStatus(metadata.status),
    toolBlocks: [],
    contentBlocks: [],
  }

  for (const event of timeline) {
    if (!event || typeof event !== 'object') continue
    if (typeof event.sessionId === 'string') metadata.sessionId = event.sessionId

    switch (event.type) {
      case 'text': {
        if (typeof event.text !== 'string' || !event.text) break
        assistantMessage.content += event.text
        const lastBlock = assistantMessage.contentBlocks[assistantMessage.contentBlocks.length - 1]
        if (lastBlock?.type === 'text') {
          lastBlock.text += event.text
        } else {
          assistantMessage.contentBlocks.push({ type: 'text', text: event.text })
        }
        break
      }
      case 'thinking_start':
        assistantMessage.thinking = { content: '', done: false }
        break
      case 'thinking':
        if (typeof event.text === 'string' && event.text) {
          assistantMessage.thinking = {
            content: `${assistantMessage.thinking?.content ?? ''}${event.text}`,
            done: false,
          }
        }
        break
      case 'tool_start': {
        const toolId = typeof event.toolId === 'string' && event.toolId ? event.toolId : `tool-${assistantMessage.toolBlocks.length + 1}`
        assistantMessage.toolBlocks.push({
          id: toolId,
          name: typeof event.toolName === 'string' && event.toolName ? event.toolName : 'tool',
          input: '',
          status: 'running',
        })
        assistantMessage.contentBlocks.push({ type: 'tool', toolId })
        break
      }
      case 'tool_input': {
        if (typeof event.text !== 'string') break
        const targetIndex = typeof event.toolId === 'string'
          ? assistantMessage.toolBlocks.findIndex(block => block.id === event.toolId)
          : assistantMessage.toolBlocks.length - 1
        if (targetIndex >= 0) {
          assistantMessage.toolBlocks[targetIndex].input += event.text
        }
        break
      }
      case 'tool_use': {
        const targetIndex = typeof event.toolId === 'string'
          ? assistantMessage.toolBlocks.findIndex(block => block.id === event.toolId)
          : assistantMessage.toolBlocks.findIndex(block => block.status === 'running')
        if (targetIndex >= 0) {
          assistantMessage.toolBlocks[targetIndex] = {
            ...assistantMessage.toolBlocks[targetIndex],
            name: typeof event.toolName === 'string' && event.toolName ? event.toolName : assistantMessage.toolBlocks[targetIndex].name,
            input: typeof event.toolInput === 'string' ? event.toolInput : assistantMessage.toolBlocks[targetIndex].input,
            status: 'done',
          }
        }
        break
      }
      case 'tool_summary': {
        const targetIndex = typeof event.toolId === 'string'
          ? assistantMessage.toolBlocks.findIndex(block => block.id === event.toolId)
          : assistantMessage.toolBlocks.findIndex(block => block.status === 'running')
        if (targetIndex >= 0) {
          assistantMessage.toolBlocks[targetIndex] = {
            ...assistantMessage.toolBlocks[targetIndex],
            name: typeof event.toolName === 'string' && event.toolName ? event.toolName : assistantMessage.toolBlocks[targetIndex].name,
            summary: typeof event.text === 'string' ? event.text : assistantMessage.toolBlocks[targetIndex].summary,
            fileChanges: Array.isArray(event.fileChanges) ? event.fileChanges : assistantMessage.toolBlocks[targetIndex].fileChanges,
            commandEntries: Array.isArray(event.commandEntries) ? event.commandEntries : assistantMessage.toolBlocks[targetIndex].commandEntries,
            status: 'done',
          }
        }
        break
      }
      case 'tool_progress': {
        const targetIndex = assistantMessage.toolBlocks.findIndex(block => block.status === 'running' && block.name === event.toolName)
        if (targetIndex >= 0 && typeof event.elapsed === 'number') {
          assistantMessage.toolBlocks[targetIndex] = {
            ...assistantMessage.toolBlocks[targetIndex],
            elapsed: event.elapsed,
          }
        }
        break
      }
      case 'block_stop': {
        if (assistantMessage.thinking) {
          assistantMessage.thinking = { ...assistantMessage.thinking, done: true }
        }
        const lastRunningIndex = assistantMessage.toolBlocks.findLastIndex(block => block.status === 'running')
        if (lastRunningIndex >= 0) {
          assistantMessage.toolBlocks[lastRunningIndex] = {
            ...assistantMessage.toolBlocks[lastRunningIndex],
            status: 'done',
          }
        }
        break
      }
      case 'error':
        if (!assistantMessage.content && typeof event.error === 'string' && event.error) {
          assistantMessage.content = `Error: ${event.error}`
          assistantMessage.contentBlocks.push({ type: 'text', text: assistantMessage.content })
        }
        assistantMessage.isStreaming = false
        break
      case 'done':
        assistantMessage.isStreaming = false
        break
    }
  }

  if (metadata.error && !assistantMessage.content) {
    assistantMessage.content = `Error: ${metadata.error}`
    assistantMessage.contentBlocks.push({ type: 'text', text: assistantMessage.content })
  }
  if (!assistantMessage.content && assistantMessage.contentBlocks.length === 0 && assistantMessage.toolBlocks.length === 0) {
    assistantMessage.content = assistantMessage.isStreaming ? '' : 'No output captured yet.'
    if (assistantMessage.content) {
      assistantMessage.contentBlocks.push({ type: 'text', text: assistantMessage.content })
    }
  }

  return {
    messages: [userMessage, assistantMessage],
    input: '',
    attachments: [],
    provider: metadata.provider ?? 'claude',
    model: metadata.model ?? '',
    mcpEnabled: true,
    mode: metadata.provider === 'codex' ? 'full-auto' : 'default',
    thinking: 'adaptive',
    agentMode: false,
    autoAgentMode: false,
    sessionId: metadata.sessionId ?? null,
    jobId: metadata.id,
    jobSequence: Number(metadata.lastSequence ?? 0),
    cloudHostId: null,
    isStreaming: isActiveJobStatus(metadata.status),
    executionTarget: 'local',
    workspaceId,
  }
}

function readDirNames(dirPath) {
  try {
    return readdirSync(dirPath)
  } catch {
    return []
  }
}

function materializeWorkspaces(state) {
  return state.workspaces.map(workspace => materializeWorkspace(workspace, state.projects))
}

function getActiveWorkspace(state) {
  const match = state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)
  return match ?? state.workspaces[0] ?? null
}

function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    if (nameCompare !== 0) return nameCompare
    return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
  })
}

function upsertExecutionHost(currentHosts, input) {
  const normalized = normalizeExecutionHost(input)
  if (!normalized || normalized.id === 'local-runtime' || normalized.id === 'local-daemon') {
    return mergeExecutionHosts(currentHosts)
  }
  const next = mergeExecutionHosts(currentHosts).filter(host => host.id !== normalized.id)
  next.push(normalized)
  return mergeExecutionHosts(next)
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(`${JSON.stringify(payload)}\n`)
}

function readPidInfo() {
  try {
    const parsed = JSON.parse(readFileSync(PID_PATH, 'utf8'))
    if (
      typeof parsed?.pid !== 'number'
      || typeof parsed?.port !== 'number'
      || typeof parsed?.token !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : ''
    return code === 'EPERM'
  }
}

async function healthcheck(info) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(2_000),
      headers: {
        Authorization: `Bearer ${info.token}`,
      },
    })
    if (!response.ok) return false
    const payload = await response.json()
    return payload?.ok === true
  } catch {
    return false
  }
}

async function reuseExistingDaemonIfHealthy() {
  const existing = readPidInfo()
  if (!existing || !isProcessAlive(existing.pid)) return false
  return await healthcheck(existing)
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function authorized(req, url) {
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return true
  const token = String(url?.searchParams?.get('token') ?? '').trim()
  return token.length > 0 && token === AUTH_TOKEN
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')

  if (!authorized(req, url)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  const method = req.method || 'GET'

  try {
    if (method === 'GET' && url.pathname === '/dashboard') {
      sendHtml(res, 200, renderDashboardHtml())
      return
    }

    if (method === 'GET' && url.pathname === '/dashboard/api/jobs') {
      const jobs = readDaemonJobRecords(100, new Set(chatJobs.listLiveJobIds()))
      sendJson(res, 200, {
        jobs,
        summary: summarizeDaemonJobs(jobs),
        daemon: {
          pid: process.pid,
          startedAt: STARTED_AT,
          appVersion: APP_VERSION,
        },
      })
      return
    }

    if (method === 'GET' && url.pathname === '/dashboard/api/job') {
      const jobId = String(url.searchParams.get('jobId') ?? '').trim()
      if (!jobId) {
        sendJson(res, 400, { error: 'jobId is required' })
        return
      }

      const job = await chatJobs.getJobState(jobId)
      if (!job) {
        sendJson(res, 404, { error: 'Job not found' })
        return
      }
      const effectiveJob = {
        ...job,
        status: isActiveJobStatus(job.status) && !chatJobs.listLiveJobIds().includes(jobId)
          ? 'lost'
          : job.status,
      }

      sendJson(res, 200, {
        job: effectiveJob,
        timeline: readDaemonJobTimeline(jobId, 200),
      })
      return
    }

    if (method === 'GET' && url.pathname === '/agent-kanban/board') {
      const workspacePath = String(url.searchParams.get('workspacePath') ?? '').trim()
      const board = readAgentKanbanBoard(workspacePath)
      sendJson(res, 200, buildAgentKanbanBoardPayload(workspacePath, board))
      return
    }

    if (method === 'GET' && url.pathname === '/agent-kanban/summary') {
      const workspacePath = String(url.searchParams.get('workspacePath') ?? '').trim()
      const board = readAgentKanbanBoard(workspacePath)
      sendJson(res, 200, buildAgentKanbanSummary(workspacePath, board))
      return
    }

    if (method === 'GET' && url.pathname === '/agent-kanban/task') {
      const workspacePath = String(url.searchParams.get('workspacePath') ?? '').trim()
      const taskId = String(url.searchParams.get('taskId') ?? '').trim()
      if (!taskId) {
        sendJson(res, 400, { error: 'taskId is required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const task = board.columns.flatMap(column => column.cards).find(card => card.id === taskId) ?? null
      sendJson(res, 200, task ? annotateAgentKanbanTask(task) : null)
      return
    }

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        startedAt: STARTED_AT,
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
      })
      return
    }

    if (method === 'GET' && url.pathname === '/workspace/list') {
      const state = readWorkspaceState()
      sendJson(res, 200, materializeWorkspaces(state))
      return
    }

    if (method === 'GET' && url.pathname === '/workspace/projects') {
      const state = readWorkspaceState()
      sendJson(res, 200, sortProjects(state.projects))
      return
    }

    if (method === 'GET' && url.pathname === '/workspace/active') {
      const state = readWorkspaceState()
      const active = getActiveWorkspace(state)
      sendJson(res, 200, active ? materializeWorkspace(active, state.projects) : null)
      return
    }

    if (method === 'GET' && url.pathname === '/session/local/list') {
      const workspaceId = String(url.searchParams.get('workspaceId') ?? '').trim()
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' })
        return
      }
      sendJson(res, 200, listLocalWorkspaceSessions(workspaceId))
      return
    }

    if (method === 'POST' && url.pathname === '/chat/job/start') {
      const body = await parseRequestBody(req)
      if (!body?.request || typeof body.request !== 'object') {
        sendJson(res, 400, { error: 'request is required' })
        return
      }
      const job = await chatJobs.startJob(body.request)
      sendJson(res, 200, job)
      return
    }

    if (method === 'GET' && url.pathname === '/chat/job/state') {
      const jobId = String(url.searchParams.get('jobId') ?? '').trim()
      if (!jobId) {
        sendJson(res, 400, { error: 'jobId is required' })
        return
      }
      const state = await chatJobs.getJobState(jobId)
      sendJson(res, state ? 200 : 404, state ?? { error: 'Job not found' })
      return
    }

    if (method === 'GET' && url.pathname === '/chat/job/events') {
      const jobId = String(url.searchParams.get('jobId') ?? '').trim()
      const sinceSequence = Number(url.searchParams.get('since') ?? '0') || 0
      if (!jobId) {
        sendJson(res, 400, { error: 'jobId is required' })
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })

      const keepOpen = await chatJobs.streamJob(jobId, sinceSequence, res)
      if (!keepOpen) {
        res.end()
      } else {
        req.on('close', () => {
          res.end()
        })
      }
      return
    }

    if (method === 'POST' && url.pathname === '/chat/job/cancel') {
      const body = await parseRequestBody(req)
      const jobId = String(body?.jobId ?? '').trim()
      if (!jobId) {
        sendJson(res, 400, { error: 'jobId is required' })
        return
      }
      sendJson(res, 200, await chatJobs.cancelJob(jobId))
      return
    }

    if (method === 'GET' && url.pathname === '/session/external/list') {
      const workspacePath = String(url.searchParams.get('workspacePath') ?? '').trim() || null
      const force = url.searchParams.get('force') === '1'
      sendJson(res, 200, await listExternalSessionEntries(HOME, workspacePath, { force }))
      return
    }

    if (method === 'GET' && url.pathname === '/session/external/state') {
      const workspacePath = String(url.searchParams.get('workspacePath') ?? '').trim() || null
      const sessionEntryId = String(url.searchParams.get('sessionEntryId') ?? '').trim()
      if (!sessionEntryId) {
        sendJson(res, 400, { error: 'sessionEntryId is required' })
        return
      }
      sendJson(res, 200, await getExternalSessionChatState(HOME, workspacePath, sessionEntryId))
      return
    }

    if (method === 'GET' && url.pathname === '/session/local/state') {
      const workspaceId = String(url.searchParams.get('workspaceId') ?? '').trim()
      const sessionEntryId = String(url.searchParams.get('sessionEntryId') ?? '').trim()
      if (!workspaceId || !sessionEntryId) {
        sendJson(res, 400, { error: 'workspaceId and sessionEntryId are required' })
        return
      }
      sendJson(res, 200, getLocalSessionState(workspaceId, sessionEntryId))
      return
    }

    if (method === 'POST' && url.pathname === '/session/local/delete') {
      const body = await parseRequestBody(req)
      const workspaceId = String(body?.workspaceId ?? '').trim()
      const sessionEntryId = String(body?.sessionEntryId ?? '').trim()
      if (!workspaceId || !sessionEntryId) {
        sendJson(res, 400, { error: 'workspaceId and sessionEntryId are required' })
        return
      }
      sendJson(res, 200, deleteLocalSession(workspaceId, sessionEntryId))
      return
    }

    if (method === 'POST' && url.pathname === '/session/local/rename') {
      const body = await parseRequestBody(req)
      const workspaceId = String(body?.workspaceId ?? '').trim()
      const sessionEntryId = String(body?.sessionEntryId ?? '').trim()
      const title = String(body?.title ?? '').trim()
      if (!workspaceId || !sessionEntryId || !title) {
        sendJson(res, 400, { error: 'workspaceId, sessionEntryId, and title are required' })
        return
      }
      sendJson(res, 200, renameLocalSession(workspaceId, sessionEntryId, title))
      return
    }

    if (method === 'POST' && url.pathname === '/session/external/invalidate') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim() || null
      invalidateExternalSessionCache(workspacePath)
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && url.pathname === '/session/external/delete') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim() || null
      const sessionEntryId = String(body?.sessionEntryId ?? '').trim()
      if (!sessionEntryId) {
        sendJson(res, 400, { error: 'sessionEntryId is required' })
        return
      }
      sendJson(res, 200, await deleteExternalSession(HOME, workspacePath, sessionEntryId))
      return
    }

    if (method === 'POST' && url.pathname === '/session/external/rename') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim() || null
      const sessionEntryId = String(body?.sessionEntryId ?? '').trim()
      const title = String(body?.title ?? '').trim()
      if (!sessionEntryId || !title) {
        sendJson(res, 400, { error: 'sessionEntryId and title are required' })
        return
      }
      sendJson(res, 200, await renameExternalSession(HOME, workspacePath, sessionEntryId, title))
      return
    }

    if (method === 'POST' && url.pathname === '/workspace/create') {
      const body = await parseRequestBody(req)
      const state = readWorkspaceState()
      const workspace = {
        id: makeId('ws'),
        name: String(body?.name ?? '').trim() || 'Workspace',
        projectIds: [],
        primaryProjectId: null,
      }
      state.workspaces.push(workspace)
      state.activeWorkspaceId = workspace.id
      writeWorkspaceState(state)
      sendJson(res, 200, materializeWorkspace(workspace, state.projects))
      return
    }

    if (method === 'POST' && url.pathname === '/workspace/create-with-path') {
      const body = await parseRequestBody(req)
      let state = readWorkspaceState()
      const normalizedProjectPath = normalizePath(body?.projectPath)
      let projectIds = []
      if (normalizedProjectPath) {
        const ensured = ensureProjectForPath(state, normalizedProjectPath)
        state = ensured.state
        projectIds = [ensured.project.id]
      }
      const workspace = {
        id: makeId('ws'),
        name: String(body?.name ?? '').trim() || 'Workspace',
        projectIds,
        primaryProjectId: projectIds[0] ?? null,
      }
      state.workspaces.push(workspace)
      state.activeWorkspaceId = workspace.id
      writeWorkspaceState(state)
      sendJson(res, 200, materializeWorkspace(workspace, state.projects))
      return
    }

    if (method === 'POST' && url.pathname === '/workspace/create-from-folder') {
      const body = await parseRequestBody(req)
      let state = readWorkspaceState()
      const normalizedFolderPath = normalizePath(body?.folderPath)
      const existingProject = state.projects.find(project => normalizePath(project.path) === normalizedFolderPath) ?? null
      const existingWorkspace = existingProject
        ? (state.workspaces.find(workspace => workspace.projectIds.includes(existingProject.id)) ?? null)
        : null
      if (existingWorkspace) {
        state.activeWorkspaceId = existingWorkspace.id
        writeWorkspaceState(state)
        sendJson(res, 200, materializeWorkspace(existingWorkspace, state.projects))
        return
      }

      const ensured = ensureProjectForPath(state, normalizedFolderPath)
      state = ensured.state
      const workspace = {
        id: makeId('ws'),
        name: basename(normalizedFolderPath) || 'Workspace',
        projectIds: [ensured.project.id],
        primaryProjectId: ensured.project.id,
      }
      state.workspaces.push(workspace)
      state.activeWorkspaceId = workspace.id
      writeWorkspaceState(state)
      sendJson(res, 200, materializeWorkspace(workspace, state.projects))
      return
    }

    if (method === 'POST' && url.pathname === '/workspace/add-project-folder') {
      const body = await parseRequestBody(req)
      let state = readWorkspaceState()
      const index = state.workspaces.findIndex(workspace => workspace.id === body?.workspaceId)
      if (index === -1) {
        sendJson(res, 200, null)
        return
      }
      const ensured = ensureProjectForPath(state, body?.folderPath)
      state = ensured.state
      const current = state.workspaces[index]
      const projectIds = current.projectIds.includes(ensured.project.id)
        ? current.projectIds
        : [...current.projectIds, ensured.project.id]
      state.workspaces[index] = {
        ...current,
        projectIds,
        primaryProjectId: current.primaryProjectId ?? ensured.project.id,
      }
      writeWorkspaceState(state)
      sendJson(res, 200, materializeWorkspace(state.workspaces[index], state.projects))
      return
    }

    if (method === 'POST' && url.pathname === '/workspace/remove-project-folder') {
      const body = await parseRequestBody(req)
      const state = readWorkspaceState()
      const index = state.workspaces.findIndex(workspace => workspace.id === body?.workspaceId)
      if (index === -1) {
        sendJson(res, 200, null)
        return
      }
      const normalizedFolderPath = normalizePath(body?.folderPath)
      const projectToRemove = state.projects.find(project => normalizePath(project.path) === normalizedFolderPath) ?? null
      if (!projectToRemove) {
        sendJson(res, 200, materializeWorkspace(state.workspaces[index], state.projects))
        return
      }
      const current = state.workspaces[index]
      const projectIds = current.projectIds.filter(projectId => projectId !== projectToRemove.id)
      state.workspaces[index] = {
        ...current,
        projectIds,
        primaryProjectId: current.primaryProjectId === projectToRemove.id ? (projectIds[0] ?? null) : current.primaryProjectId,
      }
      const referencedIds = new Set(state.workspaces.flatMap(workspace => workspace.projectIds))
      state.projects = state.projects.filter(project => referencedIds.has(project.id))
      writeWorkspaceState(state)
      sendJson(res, 200, materializeWorkspace(state.workspaces[index], state.projects))
      return
    }

    if (method === 'POST' && url.pathname === '/workspace/set-active') {
      const body = await parseRequestBody(req)
      const state = readWorkspaceState()
      const workspace = state.workspaces.find(item => item.id === body?.id)
      if (!workspace) {
        sendJson(res, 404, { error: 'Workspace not found' })
        return
      }
      state.activeWorkspaceId = workspace.id
      writeWorkspaceState(state)
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/task/create') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const prompt = String(body?.prompt ?? '').trim()
      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = addAgentKanbanTask(board, String(body?.columnId ?? 'backlog').trim() || 'backlog', body)
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
        task: annotateAgentKanbanTask(result.task),
      })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/task/update') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const taskId = String(body?.taskId ?? '').trim()
      if (!taskId) {
        sendJson(res, 400, { error: 'taskId is required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = updateAgentKanbanTask(board, taskId, {
        prompt: body?.prompt,
        agentId: body?.agentId,
        baseRef: body?.baseRef,
        startInPlanMode: body?.startInPlanMode,
        autoReviewEnabled: body?.autoReviewEnabled,
        autoReviewMode: body?.autoReviewMode,
      })
      if (!result.updated || !result.task) {
        sendJson(res, 404, { error: 'Task not found' })
        return
      }
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
        task: annotateAgentKanbanTask(result.task),
      })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/task/move') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const taskId = String(body?.taskId ?? '').trim()
      const columnId = String(body?.columnId ?? '').trim()
      if (!taskId || !columnId) {
        sendJson(res, 400, { error: 'taskId and columnId are required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = moveAgentKanbanTask(board, taskId, columnId)
      if (!result.moved || !result.task) {
        sendJson(res, 404, { error: 'Task not found or already in target column' })
        return
      }
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        fromColumnId: result.fromColumnId,
        toColumnId: columnId,
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
        task: annotateAgentKanbanTask(result.task),
      })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/task/archive') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const taskId = String(body?.taskId ?? '').trim()
      if (!taskId) {
        sendJson(res, 400, { error: 'taskId is required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = moveAgentKanbanTask(board, taskId, 'trash')
      if (!result.moved || !result.task) {
        sendJson(res, 404, { error: 'Task not found or already archived' })
        return
      }
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
        task: annotateAgentKanbanTask(result.task),
      })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/task/delete') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const taskId = String(body?.taskId ?? '').trim()
      if (!taskId) {
        sendJson(res, 400, { error: 'taskId is required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = deleteAgentKanbanTask(board, taskId)
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
        ok: true,
      })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/dependency/add') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const fromTaskId = String(body?.fromTaskId ?? '').trim()
      const toTaskId = String(body?.toTaskId ?? '').trim()
      if (!fromTaskId || !toTaskId) {
        sendJson(res, 400, { error: 'fromTaskId and toTaskId are required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = addAgentKanbanDependency(board, fromTaskId, toTaskId)
      if (!result.added) {
        sendJson(res, 200, { ok: false, reason: result.reason, board: buildAgentKanbanBoardPayload(workspacePath, result.board) })
        return
      }
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        ok: true,
        dependency: result.dependency,
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
      })
      return
    }

    if (method === 'POST' && url.pathname === '/agent-kanban/dependency/remove') {
      const body = await parseRequestBody(req)
      const workspacePath = String(body?.workspacePath ?? '').trim()
      const dependencyId = String(body?.dependencyId ?? '').trim()
      if (!dependencyId) {
        sendJson(res, 400, { error: 'dependencyId is required' })
        return
      }
      const board = readAgentKanbanBoard(workspacePath)
      const result = removeAgentKanbanDependency(board, dependencyId)
      if (!result.removed) {
        sendJson(res, 404, { error: 'Dependency not found' })
        return
      }
      writeAgentKanbanBoard(workspacePath, result.board)
      sendJson(res, 200, {
        ok: true,
        board: buildAgentKanbanBoardPayload(workspacePath, result.board),
        summary: buildAgentKanbanSummary(workspacePath, result.board),
      })
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/workspace/')) {
      const workspaceId = decodeURIComponent(url.pathname.slice('/workspace/'.length))
      const state = readWorkspaceState()
      state.workspaces = state.workspaces.filter(workspace => workspace.id !== workspaceId)
      if (state.activeWorkspaceId === workspaceId) {
        state.activeWorkspaceId = state.workspaces[0]?.id ?? null
      }
      const referencedIds = new Set(state.workspaces.flatMap(workspace => workspace.projectIds))
      state.projects = state.projects.filter(project => referencedIds.has(project.id))
      writeWorkspaceState(state)
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'GET' && url.pathname === '/host/list') {
      const state = readWorkspaceState()
      sendJson(res, 200, state.hosts)
      return
    }

    if (method === 'POST' && url.pathname === '/host/upsert') {
      const body = await parseRequestBody(req)
      const state = readWorkspaceState()
      const nextHosts = upsertExecutionHost(state.hosts, body?.host)
      writeHosts(nextHosts)
      sendJson(res, 200, nextHosts)
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/host/')) {
      const hostId = decodeURIComponent(url.pathname.slice('/host/'.length))
      if (hostId === 'local-runtime' || hostId === 'local-daemon') {
        sendJson(res, 400, { error: 'Built-in hosts cannot be deleted' })
        return
      }
      const state = readWorkspaceState()
      const nextHosts = mergeExecutionHosts(state.hosts).filter(host => host.id !== hostId)
      writeHosts(nextHosts)
      sendJson(res, 200, { ok: true, hosts: nextHosts })
      return
    }

    if (method === 'GET' && url.pathname === '/settings') {
      const state = readWorkspaceState()
      sendJson(res, 200, state.settings)
      return
    }

    if (method === 'POST' && url.pathname === '/settings') {
      const body = await parseRequestBody(req)
      writeSettings(typeof body?.settings === 'object' && body.settings ? body.settings : {})
      const state = readWorkspaceState()
      sendJson(res, 200, state.settings)
      return
    }

    if (method === 'GET' && url.pathname === '/settings/raw') {
      ensureStateFiles()
      sendJson(res, 200, { path: SETTINGS_FILE, content: readFileSync(SETTINGS_FILE, 'utf8') })
      return
    }

    if (method === 'POST' && url.pathname === '/settings/raw') {
      const body = await parseRequestBody(req)
      try {
        const parsed = JSON.parse(String(body?.json ?? '{}'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 200, { ok: false, error: 'Root must be a JSON object' })
          return
        }
        writeSettings(parsed)
        const state = readWorkspaceState()
        sendJson(res, 200, { ok: true, settings: state.settings })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

async function start() {
  ensureStateFiles()
  if (await reuseExistingDaemonIfHealthy()) {
    process.exit(0)
    return
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  atomicWriteJson(PID_PATH, {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: STARTED_AT,
    protocolVersion: PROTOCOL_VERSION,
    appVersion: APP_VERSION,
  })
  
  // Start periodic cleanup task (every 24 hours)
  setInterval(() => {
    try {
      cleanupOldDeletedFiles(30)
    } catch (error) {
      console.error('[codesurfd] cleanupOldDeletedFiles failed:', error)
    }
  }, 24 * 60 * 60 * 1000)
  
  // Run cleanup once on startup
  try {
    cleanupOldDeletedFiles(30)
  } catch (error) {
    console.error('[codesurfd] initial cleanupOldDeletedFiles failed:', error)
  }
}

let shuttingDown = false

function removeOwnedPidFile() {
  try {
    const parsed = readPidInfo()
    if (!parsed || parsed.pid === process.pid) {
      rmSync(PID_PATH, { force: true })
    }
  } catch {}
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    removeOwnedPidFile()
  } catch {}
  await new Promise(resolve => server.close(() => resolve()))
}

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0))
})
process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0))
})
process.on('exit', () => {
  try {
    removeOwnedPidFile()
  } catch {}
})
process.on('uncaughtException', (error) => {
  console.error('[codesurfd] uncaught exception', error)
  shutdown().finally(() => process.exit(1))
})
process.on('unhandledRejection', (error) => {
  console.error('[codesurfd] unhandled rejection', error)
  shutdown().finally(() => process.exit(1))
})

await start()
