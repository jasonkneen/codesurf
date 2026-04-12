import { BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import type { TileState } from '../../shared/types'
import { CONTEX_HOME } from '../paths'
import { findSessionEntryById, getExternalSessionChatState, invalidateExternalSessionCache, listExternalSessionEntries, type AggregatedSessionEntry } from '../session-sources'
import { getWorkspacePathById, getWorkspaceStorageIds } from './workspace'
import { isRelayHostActive } from '../relay/registration'
import { syncWorkspaceRelayParticipants } from '../relay/service'

function assertSafeId(id: string): void {
  if (/[\/\\]|\.\./.test(id)) throw new Error(`Unsafe ID: ${id}`)
}

/**
 * Migrate legacy flat files into .contex/ subfolder.
 * Runs once per storage dir — moves canvas-state, tile-state-*, kanban-* files.
 */
async function migrateStorageToContexDir(storageId: string): Promise<void> {
  assertSafeId(storageId)
  const wsDir = join(CONTEX_HOME, 'workspaces', storageId)
  const dotDir = join(wsDir, '.contex')
  try { await fs.mkdir(dotDir, { recursive: true }) } catch {}
  try {
    const entries = await fs.readdir(wsDir)
    const migratable = entries.filter(name =>
      name === 'canvas-state.json' ||
      name === 'activity.json' ||
      name === 'mcp-merged.json' ||
      name.startsWith('tile-state-') ||
      name.startsWith('kanban-')
    )
    for (const name of migratable) {
      const src = join(wsDir, name)
      const dest = join(dotDir, name)
      try {
        await fs.access(dest) // already migrated
      } catch {
        await fs.rename(src, dest)
      }
    }
  } catch {} // workspace dir may not exist yet
}
const migratedStorageIds = new Set<string>()

async function resolveStorageIds(workspaceId: string): Promise<string[]> {
  const ids = await getWorkspaceStorageIds(workspaceId)
  return Array.from(new Set(ids))
}

async function ensureWorkspaceStorageMigrated(workspaceId: string): Promise<string[]> {
  const storageIds = await resolveStorageIds(workspaceId)
  for (const storageId of storageIds) {
    if (migratedStorageIds.has(storageId)) continue
    migratedStorageIds.add(storageId)
    await migrateStorageToContexDir(storageId)
  }
  return storageIds
}

function canvasStatePath(storageId: string): string {
  assertSafeId(storageId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', 'canvas-state.json')
}

function kanbanStatePath(storageId: string, tileId: string): string {
  assertSafeId(storageId)
  assertSafeId(tileId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', `kanban-${tileId}.json`)
}

function tileStatePath(storageId: string, tileId: string): string {
  assertSafeId(storageId)
  assertSafeId(tileId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', `tile-state-${tileId}.json`)
}

function tileSessionSummaryPath(storageId: string, tileId: string): string {
  assertSafeId(storageId)
  assertSafeId(tileId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', `tile-session-${tileId}.json`)
}

interface TileSessionSummary {
  version: 1
  tileId: string
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  lastMessage: string | null
  title: string
  updatedAt: number
}

const tileSessionSummaryCache = new Map<string, TileSessionSummary | null>()

function truncateSessionText(text: string | null | undefined, length = 120): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function sessionTitleFromText(text: string | null | undefined, provider: string): string {
  const trimmed = text?.trim()
  if (!trimmed) return `${provider} session`
  return trimmed.split(/\r?\n/, 1)[0].slice(0, 80)
}

function extractTileSessionSummary(tileId: string, state: unknown): TileSessionSummary | null {
  if (!state || typeof state !== 'object') return null
  const record = state as Record<string, unknown>
  const messages = Array.isArray(record.messages) ? record.messages : null
  if (!messages || messages.length === 0) return null

  let lastMessage: string | null = null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown> | null | undefined
    if (!message) continue
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
    title: sessionTitleFromText(lastMessage, provider),
    updatedAt: Date.now(),
  }
}

function sameTileSessionSummary(a: TileSessionSummary | null, b: TileSessionSummary | null): boolean {
  if (!a || !b) return a === b
  return a.tileId === b.tileId
    && a.sessionId === b.sessionId
    && a.provider === b.provider
    && a.model === b.model
    && a.messageCount === b.messageCount
    && a.lastMessage === b.lastMessage
    && a.title === b.title
}

async function readTileSessionSummary(summaryPath: string): Promise<TileSessionSummary | null> {
  if (tileSessionSummaryCache.has(summaryPath)) {
    return tileSessionSummaryCache.get(summaryPath) ?? null
  }

  try {
    const raw = await fs.readFile(summaryPath, 'utf8')
    const parsed = JSON.parse(raw) as TileSessionSummary
    tileSessionSummaryCache.set(summaryPath, parsed)
    return parsed
  } catch {
    tileSessionSummaryCache.set(summaryPath, null)
    return null
  }
}

async function writeTileSessionSummary(storageId: string, tileId: string, state: unknown): Promise<{ changed: boolean; summary: TileSessionSummary | null }> {
  const summaryPath = tileSessionSummaryPath(storageId, tileId)
  const previous = await readTileSessionSummary(summaryPath)
  const next = extractTileSessionSummary(tileId, state)

  if (!next) {
    const changed = previous !== null
    await deleteFileIfExists(summaryPath)
    tileSessionSummaryCache.set(summaryPath, null)
    return { changed, summary: null }
  }

  if (sameTileSessionSummary(previous, next)) {
    const stable = previous ?? next
    tileSessionSummaryCache.set(summaryPath, stable)
    return { changed: false, summary: stable }
  }

  const summaryToWrite: TileSessionSummary = {
    ...next,
    updatedAt: Date.now(),
  }
  await fs.writeFile(summaryPath, JSON.stringify(summaryToWrite, null, 2))
  tileSessionSummaryCache.set(summaryPath, summaryToWrite)
  return { changed: true, summary: summaryToWrite }
}

function broadcastSessionsChanged(workspaceId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('canvas:sessionsChanged', { workspaceId })
  }
}

async function deleteFileIfExists(path: string): Promise<void> {
  try {
    await fs.unlink(path)
  } catch {
    // ignore missing files
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function moveFileToDeleted(filePath: string): Promise<string> {
  const sourceDir = dirname(filePath)
  const deletedDir = join(sourceDir, 'deleted')
  await fs.mkdir(deletedDir, { recursive: true })

  const base = basename(filePath)
  let targetPath = join(deletedDir, base)
  if (await pathExists(targetPath)) {
    targetPath = join(deletedDir, `${Date.now()}-${base}`)
  }

  await fs.rename(filePath, targetPath)
  return targetPath
}

export function registerCanvasIPC(): void {
  ipcMain.handle('canvas:load', async (_, workspaceId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    for (const storageId of storageIds) {
      try {
        const raw = await fs.readFile(canvasStatePath(storageId), 'utf8')
        return JSON.parse(raw)
      } catch {
        // try next alias storage dir
      }
    }
    return null
  })

  ipcMain.handle('canvas:save', async (_, workspaceId: string, state: unknown) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    const storageId = storageIds[0] ?? workspaceId
    const path = canvasStatePath(storageId)
    await fs.mkdir(join(CONTEX_HOME, 'workspaces', storageId, '.contex'), { recursive: true })
    await fs.writeFile(path, JSON.stringify(state, null, 2))

    if (isRelayHostActive() && state && typeof state === 'object' && Array.isArray((state as { tiles?: unknown }).tiles)) {
      const tiles = (state as { tiles: TileState[] }).tiles
      const wsPath = await getWorkspacePathById(workspaceId)
      if (wsPath) {
        void syncWorkspaceRelayParticipants(workspaceId, wsPath, tiles).catch(err => {
          console.warn('[Canvas] relay participant sync skipped:', err)
        })
      }
    }
  })

  ipcMain.handle('kanban:load', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    for (const storageId of storageIds) {
      try {
        const raw = await fs.readFile(kanbanStatePath(storageId, tileId), 'utf8')
        return JSON.parse(raw)
      } catch {
        // try next alias storage dir
      }
    }
    return null
  })

  ipcMain.handle('kanban:save', async (_, workspaceId: string, tileId: string, state: unknown) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    const storageId = storageIds[0] ?? workspaceId
    const path = kanbanStatePath(storageId, tileId)
    await fs.mkdir(join(CONTEX_HOME, 'workspaces', storageId, '.contex'), { recursive: true })
    await fs.writeFile(path, JSON.stringify(state, null, 2))
  })

  ipcMain.handle('canvas:loadTileState', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    for (const storageId of storageIds) {
      try {
        const raw = await fs.readFile(tileStatePath(storageId, tileId), 'utf8')
        return JSON.parse(raw)
      } catch {
        // try next alias storage dir
      }
    }
    return null
  })

  ipcMain.handle('canvas:saveTileState', async (_, workspaceId: string, tileId: string, state: unknown) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    const storageId = storageIds[0] ?? workspaceId
    const path = tileStatePath(storageId, tileId)
    await fs.mkdir(join(CONTEX_HOME, 'workspaces', storageId, '.contex'), { recursive: true })
    await fs.writeFile(path, JSON.stringify(state, null, 2))

    const { changed } = await writeTileSessionSummary(storageId, tileId, state)
    if (changed && (!(state && typeof state === 'object') || (state as { isStreaming?: boolean }).isStreaming !== true)) {
      broadcastSessionsChanged(workspaceId)
    }
  })

  ipcMain.handle('canvas:clearTileState', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    await Promise.all(storageIds.flatMap(storageId => [
      deleteFileIfExists(tileStatePath(storageId, tileId)),
      deleteFileIfExists(tileSessionSummaryPath(storageId, tileId)),
    ]))
    for (const storageId of storageIds) {
      tileSessionSummaryCache.delete(tileSessionSummaryPath(storageId, tileId))
    }
    broadcastSessionsChanged(workspaceId)
  })

  // List all chat sessions for a workspace by combining local CodeSurf tile sessions with
  // project/user .codesurf sessions and external provider session stores.
  ipcMain.handle('canvas:listSessions', async (_, workspaceId: string, forceRefresh = false) => {
    assertSafeId(workspaceId)
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    const workspacePath = await getWorkspacePathById(workspaceId)
    const sessions: AggregatedSessionEntry[] = []

    for (const storageId of storageIds) {
      const dotDir = join(CONTEX_HOME, 'workspaces', storageId, '.contex')
      try {
        const entries = await fs.readdir(dotDir)
        const tileStateFiles = entries.filter(name => name.startsWith('tile-state-') && name.endsWith('.json'))

        for (const file of tileStateFiles) {
          try {
            const filePath = join(dotDir, file)
            const tileId = file.replace('tile-state-', '').replace('.json', '')
            const summaryPath = tileSessionSummaryPath(storageId, tileId)
            let summary = await readTileSessionSummary(summaryPath)

            if (!summary) {
              const raw = await fs.readFile(filePath, 'utf8')
              const state = JSON.parse(raw)
              const stat = await fs.stat(filePath)
              summary = extractTileSessionSummary(tileId, state)
              if (summary) {
                summary.updatedAt = stat.mtimeMs
                await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2))
                tileSessionSummaryCache.set(summaryPath, summary)
              }
            }

            if (!summary) continue

            sessions.push({
              id: `codesurf-tile:${file}`,
              source: 'codesurf',
              scope: 'workspace',
              tileId,
              sessionId: summary.sessionId,
              provider: summary.provider,
              model: summary.model,
              messageCount: summary.messageCount,
              lastMessage: summary.lastMessage,
              updatedAt: summary.updatedAt,
              title: summary.title,
              filePath,
              projectPath: workspacePath,
              sourceLabel: 'CodeSurf',
              sourceDetail: summary.provider || 'Workspace chat',
              canOpenInChat: true,
              canOpenInApp: false,
              nestingLevel: 0,
            })
          } catch {
            // skip corrupt files
          }
        }
      } catch {
        // skip missing alias storage dirs
      }
    }

    sessions.push(...await listExternalSessionEntries(workspacePath, { force: forceRefresh }))
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  })

  ipcMain.handle('canvas:getSessionState', async (_, workspaceId: string, sessionEntryId: string) => {
    const workspacePath = await getWorkspacePathById(workspaceId)

    if (sessionEntryId.startsWith('codesurf-tile:')) {
      const tileId = sessionEntryId.replace('codesurf-tile:tile-state-', '').replace('.json', '')
      const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
      for (const storageId of storageIds) {
        try {
          const raw = await fs.readFile(tileStatePath(storageId, tileId), 'utf8')
          return JSON.parse(raw)
        } catch {
          // try next alias storage dir
        }
      }
      return null
    }

    return getExternalSessionChatState(workspacePath, sessionEntryId)
  })

  ipcMain.handle('canvas:deleteSession', async (_, workspaceId: string, sessionEntryId: string) => {
    assertSafeId(workspaceId)
    const workspacePath = await getWorkspacePathById(workspaceId)

    if (sessionEntryId.startsWith('codesurf-tile:')) {
      const tileId = sessionEntryId.replace('codesurf-tile:tile-state-', '').replace('.json', '')
      const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
      for (const storageId of storageIds) {
        const filePath = tileStatePath(storageId, tileId)
        if (!(await pathExists(filePath))) continue
        await moveFileToDeleted(filePath)
        await deleteFileIfExists(tileSessionSummaryPath(storageId, tileId))
        tileSessionSummaryCache.delete(tileSessionSummaryPath(storageId, tileId))
      }
      broadcastSessionsChanged(workspaceId)
      return { ok: true }
    }

    const entry = await findSessionEntryById(workspacePath, sessionEntryId)
    if (!entry?.filePath) return { ok: false, error: 'Session file not found' }
    if (!(await pathExists(entry.filePath))) return { ok: false, error: 'Session file missing' }

    const deletedPath = await moveFileToDeleted(entry.filePath)

    if (entry.source === 'openclaw') {
      const [, agentId, ...keyParts] = sessionEntryId.split(':')
      const sessionKey = keyParts.join(':')
      const indexPath = join(process.env.HOME || '', '.openclaw', 'agents', agentId, 'sessions', 'sessions.json')
      if (agentId && sessionKey && await pathExists(indexPath)) {
        try {
          const raw = await fs.readFile(indexPath, 'utf8')
          const parsed = JSON.parse(raw) as Record<string, any>
          if (parsed[sessionKey] && typeof parsed[sessionKey] === 'object') {
            parsed[sessionKey] = {
              ...parsed[sessionKey],
              deletedAt: Date.now(),
              deletedFile: deletedPath,
              sessionFile: deletedPath,
            }
            await fs.writeFile(indexPath, JSON.stringify(parsed, null, 2))
          }
        } catch {
          // ignore index update failures; file move already succeeded
        }
      }
    }

    invalidateExternalSessionCache(workspacePath)
    broadcastSessionsChanged(workspaceId)
    return { ok: true }
  })

  ipcMain.handle('canvas:deleteTileArtifacts', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    await Promise.all(storageIds.flatMap(storageId => [
      deleteFileIfExists(tileStatePath(storageId, tileId)),
      deleteFileIfExists(tileSessionSummaryPath(storageId, tileId)),
      deleteFileIfExists(kanbanStatePath(storageId, tileId)),
    ]))
    for (const storageId of storageIds) {
      tileSessionSummaryCache.delete(tileSessionSummaryPath(storageId, tileId))
    }
    broadcastSessionsChanged(workspaceId)
  })
}
