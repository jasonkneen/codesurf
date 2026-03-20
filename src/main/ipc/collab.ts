import { ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { CollabState, CollabSkills } from '../../shared/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function collabDir(workspacePath: string, tileId: string): string {
  return join(workspacePath, '.collab', tileId)
}

function contextDir(workspacePath: string, tileId: string): string {
  return join(workspacePath, '.collab', tileId, 'context')
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await fs.writeFile(path, JSON.stringify(data, null, 2))
}

// ─── Watcher state ──────────────────────────────────────────────────────────

const watchers = new Map<string, { close: () => void }>()

async function startWatcher(workspacePath: string, tileId: string): Promise<void> {
  const key = `${workspacePath}:${tileId}`
  if (watchers.has(key)) return

  const statePath = join(collabDir(workspacePath, tileId), 'state.json')

  // Lazy-import chokidar (already a project dep)
  const chokidar = await import('chokidar')
  const watcher = chokidar.watch(statePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  watcher.on('change', async () => {
    const state = await readJsonSafe<CollabState>(statePath, { tasks: [], paused: false })
    // Broadcast to all renderer windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('collab:stateChanged', { workspacePath, tileId, state })
    }
  })

  watchers.set(key, { close: () => watcher.close() })
}

function stopWatcher(workspacePath: string, tileId: string): void {
  const key = `${workspacePath}:${tileId}`
  const w = watchers.get(key)
  if (w) {
    w.close()
    watchers.delete(key)
  }
}

// ─── IPC Registration ───────────────────────────────────────────────────────

export function registerCollabIPC(): void {

  // Ensure .collab/{tileId}/context/ exists
  ipcMain.handle('collab:ensureDir', async (_, workspacePath: string, tileId: string) => {
    await fs.mkdir(contextDir(workspacePath, tileId), { recursive: true })
    return true
  })

  // ── Objective ─────────────────────────────────────────────────────────────

  ipcMain.handle('collab:writeObjective', async (_, workspacePath: string, tileId: string, md: string) => {
    const dir = collabDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'objective.md'), md)
    return true
  })

  ipcMain.handle('collab:readObjective', async (_, workspacePath: string, tileId: string) => {
    try {
      return await fs.readFile(join(collabDir(workspacePath, tileId), 'objective.md'), 'utf8')
    } catch {
      return null
    }
  })

  // ── Skills ────────────────────────────────────────────────────────────────

  ipcMain.handle('collab:writeSkills', async (_, workspacePath: string, tileId: string, skills: CollabSkills) => {
    const dir = collabDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'skills.json'), skills)
    return true
  })

  ipcMain.handle('collab:readSkills', async (_, workspacePath: string, tileId: string) => {
    return readJsonSafe<CollabSkills>(
      join(collabDir(workspacePath, tileId), 'skills.json'),
      { enabled: [], disabled: [] },
    )
  })

  // ── State ─────────────────────────────────────────────────────────────────

  ipcMain.handle('collab:writeState', async (_, workspacePath: string, tileId: string, state: CollabState) => {
    const dir = collabDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'state.json'), state)
    return true
  })

  ipcMain.handle('collab:readState', async (_, workspacePath: string, tileId: string) => {
    return readJsonSafe<CollabState>(
      join(collabDir(workspacePath, tileId), 'state.json'),
      { tasks: [], paused: false },
    )
  })

  // ── Context files ─────────────────────────────────────────────────────────

  ipcMain.handle('collab:addContext', async (_, workspacePath: string, tileId: string, filename: string, content: string) => {
    const dir = contextDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, filename), content)
    return true
  })

  ipcMain.handle('collab:removeContext', async (_, workspacePath: string, tileId: string, filename: string) => {
    try {
      await fs.unlink(join(contextDir(workspacePath, tileId), filename))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('collab:listContext', async (_, workspacePath: string, tileId: string) => {
    try {
      const dir = contextDir(workspacePath, tileId)
      const entries = await fs.readdir(dir)
      return entries.filter(e => !e.startsWith('.'))
    } catch {
      return []
    }
  })

  ipcMain.handle('collab:readContext', async (_, workspacePath: string, tileId: string, filename: string) => {
    try {
      return await fs.readFile(join(contextDir(workspacePath, tileId), filename), 'utf8')
    } catch {
      return null
    }
  })

  // ── Watcher ───────────────────────────────────────────────────────────────

  ipcMain.handle('collab:watchState', async (_, workspacePath: string, tileId: string) => {
    await startWatcher(workspacePath, tileId)
    return true
  })

  ipcMain.handle('collab:unwatchState', (_, workspacePath: string, tileId: string) => {
    stopWatcher(workspacePath, tileId)
    return true
  })
}

/** Stop all watchers (call on app quit) */
export function stopAllCollabWatchers(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
}
