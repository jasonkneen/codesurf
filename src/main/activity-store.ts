import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'node:crypto'
import type { ActivityRecord, ActivityQuery, ActivityType, ActivityStatus } from '../shared/types'

const COLLAB_DIR = join(homedir(), 'clawd-collab')
const SAVE_DEBOUNCE_MS = 1000

interface StoreState {
  records: ActivityRecord[]
  dirty: boolean
  saveTimer: ReturnType<typeof setTimeout> | null
}

// Per-workspace in-memory state, lazy-loaded from disk
const stores = new Map<string, StoreState>()

function storePath(workspaceId: string): string {
  return join(COLLAB_DIR, 'workspaces', workspaceId, 'activity.json')
}

async function ensureDir(workspaceId: string): Promise<void> {
  await fs.mkdir(join(COLLAB_DIR, 'workspaces', workspaceId), { recursive: true })
}

async function loadStore(workspaceId: string): Promise<StoreState> {
  const existing = stores.get(workspaceId)
  if (existing) return existing

  let records: ActivityRecord[] = []
  try {
    const raw = await fs.readFile(storePath(workspaceId), 'utf8')
    records = JSON.parse(raw)
  } catch {
    // No file yet — start empty
  }

  const state: StoreState = { records, dirty: false, saveTimer: null }
  stores.set(workspaceId, state)
  return state
}

function scheduleSave(workspaceId: string, state: StoreState): void {
  state.dirty = true
  if (state.saveTimer) return
  state.saveTimer = setTimeout(async () => {
    state.saveTimer = null
    if (!state.dirty) return
    state.dirty = false
    try {
      await ensureDir(workspaceId)
      await fs.writeFile(storePath(workspaceId), JSON.stringify(state.records, null, 2))
    } catch {
      // Write failed — will retry on next change
      state.dirty = true
    }
  }, SAVE_DEBOUNCE_MS)
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function upsertActivity(
  workspaceId: string,
  data: {
    id?: string
    tileId: string
    type: ActivityType
    status?: ActivityStatus
    title: string
    detail?: string
    metadata?: Record<string, unknown>
    agent?: string
  },
): Promise<ActivityRecord> {
  const store = await loadStore(workspaceId)
  const now = Date.now()

  // Update existing record if ID matches
  if (data.id) {
    const idx = store.records.findIndex(r => r.id === data.id)
    if (idx !== -1) {
      const existing = store.records[idx]
      store.records[idx] = {
        ...existing,
        status: data.status ?? existing.status,
        title: data.title ?? existing.title,
        detail: data.detail ?? existing.detail,
        metadata: data.metadata ? { ...existing.metadata, ...data.metadata } : existing.metadata,
        agent: data.agent ?? existing.agent,
        updatedAt: now,
      }
      scheduleSave(workspaceId, store)
      return store.records[idx]
    }
  }

  // Create new record
  const record: ActivityRecord = {
    id: data.id ?? randomUUID(),
    tileId: data.tileId,
    workspaceId,
    type: data.type,
    status: data.status ?? 'pending',
    title: data.title,
    detail: data.detail,
    metadata: data.metadata,
    agent: data.agent,
    createdAt: now,
    updatedAt: now,
  }
  store.records.push(record)
  scheduleSave(workspaceId, store)
  return record
}

export async function queryActivity(query: ActivityQuery): Promise<ActivityRecord[]> {
  const store = await loadStore(query.workspaceId)
  let results = store.records

  if (query.tileId) results = results.filter(r => r.tileId === query.tileId)
  if (query.type) results = results.filter(r => r.type === query.type)
  if (query.status) results = results.filter(r => r.status === query.status)
  if (query.agent) results = results.filter(r => r.agent === query.agent)

  // Most recent first
  results = results.sort((a, b) => b.updatedAt - a.updatedAt)

  if (query.limit) results = results.slice(0, query.limit)
  return results
}

export async function getActivityByTile(workspaceId: string, tileId: string): Promise<ActivityRecord[]> {
  return queryActivity({ workspaceId, tileId })
}

export async function deleteActivity(workspaceId: string, id: string): Promise<boolean> {
  const store = await loadStore(workspaceId)
  const idx = store.records.findIndex(r => r.id === id)
  if (idx === -1) return false
  store.records.splice(idx, 1)
  scheduleSave(workspaceId, store)
  return true
}

export async function clearTileActivity(workspaceId: string, tileId: string): Promise<number> {
  const store = await loadStore(workspaceId)
  const before = store.records.length
  store.records = store.records.filter(r => r.tileId !== tileId)
  const removed = before - store.records.length
  if (removed > 0) scheduleSave(workspaceId, store)
  return removed
}

/** Aggregate activity grouped by agent across all tiles in a workspace */
export async function getActivityByAgent(workspaceId: string): Promise<Record<string, ActivityRecord[]>> {
  const store = await loadStore(workspaceId)
  const groups: Record<string, ActivityRecord[]> = {}
  for (const r of store.records) {
    const key = r.agent ?? `tile:${r.tileId}`
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  }
  return groups
}

/** Flush all pending writes (call on app quit) */
export async function flushAll(): Promise<void> {
  for (const [workspaceId, state] of stores) {
    if (state.saveTimer) clearTimeout(state.saveTimer)
    if (state.dirty) {
      try {
        await ensureDir(workspaceId)
        await fs.writeFile(storePath(workspaceId), JSON.stringify(state.records, null, 2))
        state.dirty = false
      } catch {
        // Best effort on shutdown
      }
    }
  }
}
