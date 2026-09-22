import { promises as fs } from 'fs'
import { join } from 'path'
import { CODESURF_HOME } from '../paths.ts'
import { readJsonArtifact, writeJsonArtifactAtomic } from './jsonArtifacts.ts'
import { TileStateSaveCoordinator } from './tileStateSaveCoordinator.ts'

// Tile state and context entries share one artifact. Renderer effects can save
// both concurrently, so serialize each artifact's read/merge/write sequence or
// a stale merge can erase a navigation field (or a freshly written context key).
const tileStateSaveCoordinator = new TileStateSaveCoordinator()
export const SKIP_WORKSPACE_TILE_STATE_WRITE = Symbol('skip-workspace-tile-state-write')

export function assertSafeWorkspaceArtifactId(id: string): void {
  if (/[\/\\]|\.\./.test(id)) throw new Error(`Unsafe ID: ${id}`)
}

async function migrateStorageToContexDir(storageId: string): Promise<void> {
  assertSafeWorkspaceArtifactId(storageId)
  const workspaceDir = join(CODESURF_HOME, 'workspaces', storageId)
  const contexDir = join(workspaceDir, '.codesurf')

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
  // Artifact ownership is workspace-scoped: a workspace ID is also its sole
  // storage ID. Keep this invariant in the storage layer instead of importing
  // the Electron workspace IPC module. Besides avoiding a storage -> IPC
  // dependency, this lets non-Electron hosts (the MCP HTTP server and daemon
  // tests) read authoritative canvas state without bootstrapping Electron.
  return [workspaceId]
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
  return join(CODESURF_HOME, 'workspaces', storageId, '.codesurf', 'canvas-state.json')
}

export function kanbanStatePath(storageId: string, tileId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  assertSafeWorkspaceArtifactId(tileId)
  return join(CODESURF_HOME, 'workspaces', storageId, '.codesurf', `kanban-${tileId}.json`)
}

export function tileStatePath(storageId: string, tileId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  assertSafeWorkspaceArtifactId(tileId)
  return join(CODESURF_HOME, 'workspaces', storageId, '.codesurf', `tile-state-${tileId}.json`)
}

export function tileSessionSummaryPath(storageId: string, tileId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  assertSafeWorkspaceArtifactId(tileId)
  return join(CODESURF_HOME, 'workspaces', storageId, '.codesurf', `tile-session-${tileId}.json`)
}

export function sessionArchiveStatePath(storageId: string): string {
  assertSafeWorkspaceArtifactId(storageId)
  return join(CODESURF_HOME, 'workspaces', storageId, '.codesurf', 'session-archives.json')
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mergeTileState(existing: unknown, patch: unknown): unknown {
  if (!isMergeableObject(patch)) {
    return patch
  }
  if (!isMergeableObject(existing)) {
    return patch
  }

  const result: Record<string, unknown> = { ...existing }
  for (const [key, patchValue] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }
    const existingValue = result[key]
    if (isMergeableObject(patchValue) && isMergeableObject(existingValue)) {
      result[key] = mergeTileState(existingValue, patchValue)
    } else {
      result[key] = patchValue
    }
  }
  return result
}

export async function loadWorkspaceTileState<T>(workspaceId: string, tileId: string, fallback: T): Promise<T> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  for (const storageId of storageIds) {
    const path = tileStatePath(storageId, tileId)
    const parsed = await readJsonArtifact<T>(path)
    if (parsed) {
      if (parsed.recovered) {
        await writeJsonArtifactAtomic(path, parsed.value).catch(() => {})
      }
      return parsed.value
    }
  }
  return fallback
}

export async function updateWorkspaceTileState(
  workspaceId: string,
  tileId: string,
  update: (
    existing: unknown | undefined,
  ) => unknown | typeof SKIP_WORKSPACE_TILE_STATE_WRITE | Promise<unknown | typeof SKIP_WORKSPACE_TILE_STATE_WRITE>,
): Promise<{ storageId: string; path: string; state: unknown | undefined; changed: boolean }> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  const storageId = storageIds[0] ?? workspaceId
  return tileStateSaveCoordinator.run(storageId, tileId, async () => {
    const dir = join(CODESURF_HOME, 'workspaces', storageId, '.codesurf')
    const path = tileStatePath(storageId, tileId)
    const existing = await readJsonArtifact(path)
    const nextState = await update(existing?.value)
    if (nextState === SKIP_WORKSPACE_TILE_STATE_WRITE) {
      return { storageId, path, state: existing?.value, changed: false }
    }
    await fs.mkdir(dir, { recursive: true })
    await writeJsonArtifactAtomic(path, nextState)
    return { storageId, path, state: nextState, changed: true }
  })
}

export async function saveWorkspaceTileState(workspaceId: string, tileId: string, state: unknown): Promise<{ storageId: string; path: string }> {
  const result = await updateWorkspaceTileState(
    workspaceId,
    tileId,
    existing => mergeTileState(existing, state),
  )
  return { storageId: result.storageId, path: result.path }
}
