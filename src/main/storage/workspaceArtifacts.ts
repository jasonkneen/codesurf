import { promises as fs } from 'fs'
import { join } from 'path'
import { CONTEX_HOME } from '../paths'
import { getWorkspaceStorageIds } from '../ipc/workspace'

export function assertSafeWorkspaceArtifactId(id: string): void {
  if (/[\/\\]|\.\./.test(id)) throw new Error(`Unsafe ID: ${id}`)
}

async function migrateStorageToContexDir(storageId: string): Promise<void> {
  assertSafeWorkspaceArtifactId(storageId)
  const workspaceDir = join(CONTEX_HOME, 'workspaces', storageId)
  const contexDir = join(workspaceDir, '.contex')

  try {
    await fs.mkdir(contexDir, { recursive: true })
  } catch {
    // ignore mkdir failures here; later reads/writes will surface real errors
  }

  try {
    const entries = await fs.readdir(workspaceDir)
    const migratable = entries.filter(name =>
      name === 'canvas-state.json'
      || name === 'activity.json'
      || name === 'mcp-merged.json'
      || name.startsWith('tile-state-')
      || name.startsWith('kanban-'),
    )

    for (const name of migratable) {
      const sourcePath = join(workspaceDir, name)
      const destinationPath = join(contexDir, name)
      try {
        await fs.access(destinationPath)
      } catch {
        await fs.rename(sourcePath, destinationPath)
      }
    }
  } catch {
    // workspace dir may not exist yet
  }
}

const migratedStorageIds = new Set<string>()

async function resolveStorageIds(workspaceId: string): Promise<string[]> {
  const ids = await getWorkspaceStorageIds(workspaceId)
  return Array.from(new Set(ids))
}

export async function ensureWorkspaceStorageMigrated(workspaceId: string): Promise<string[]> {
  const storageIds = await resolveStorageIds(workspaceId)
  for (const storageId of storageIds) {
    if (migratedStorageIds.has(storageId)) continue
    migratedStorageIds.add(storageId)
    await migrateStorageToContexDir(storageId)
  }
  return storageIds
}

export function canvasStatePath(storageId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', 'canvas-state.json')
}

export function kanbanStatePath(storageId: string, tileId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  assertSafeWorkspaceArtifactId(tileId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', `kanban-${tileId}.json`)
}

export function tileStatePath(storageId: string, tileId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  assertSafeWorkspaceArtifactId(tileId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', `tile-state-${tileId}.json`)
}

export function tileSessionSummaryPath(storageId: string, tileId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  assertSafeWorkspaceArtifactId(tileId)
  return join(CONTEX_HOME, 'workspaces', storageId, '.contex', `tile-session-${tileId}.json`)
}

export async function loadWorkspaceTileState<T>(workspaceId: string, tileId: string, fallback: T): Promise<T> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  for (const storageId of storageIds) {
    try {
      const raw = await fs.readFile(tileStatePath(storageId, tileId), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      // try next alias storage dir
    }
  }
  return fallback
}

export async function saveWorkspaceTileState(workspaceId: string, tileId: string, state: unknown): Promise<{ storageId: string; path: string }> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  const storageId = storageIds[0] ?? workspaceId
  const dir = join(CONTEX_HOME, 'workspaces', storageId, '.contex')
  const path = tileStatePath(storageId, tileId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, JSON.stringify(state, null, 2))
  return { storageId, path }
}
