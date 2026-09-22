import type { TileContextEntry } from '../../src/shared/types.ts'
import type { TileContextChangedPayload } from '../../src/shared/tileContextScope.ts'

type TileEntries = Map<string, TileContextEntry>
type WorkspaceTiles = Map<string, TileEntries>

export type ElectrobunTileContextStore = ReturnType<typeof createElectrobunTileContextStore>

export interface ElectrobunTileContextPersistence {
  load: (workspaceId: string, tileId: string) => Promise<Record<string, TileContextEntry>>
  save: (
    workspaceId: string,
    tileId: string,
    context: Record<string, TileContextEntry>,
  ) => Promise<void>
  delete?: (workspaceId: string, tileId: string) => Promise<void>
}

export async function invokeElectrobunTileContext(
  store: ElectrobunTileContextStore,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  switch (channel) {
    case 'tileContext:get':
      return await store.get(
        String(args[0] ?? ''),
        String(args[1] ?? ''),
        typeof args[2] === 'string' ? args[2] : undefined,
      )
    case 'tileContext:getAll':
      return await store.getAll(
        String(args[0] ?? ''),
        String(args[1] ?? ''),
        typeof args[2] === 'string' ? args[2] : undefined,
      )
    case 'tileContext:set':
      return await store.set(
        String(args[0] ?? ''),
        String(args[1] ?? ''),
        String(args[2] ?? ''),
        args[3],
      )
    case 'tileContext:delete':
      return await store.delete(
        String(args[0] ?? ''),
        String(args[1] ?? ''),
        String(args[2] ?? ''),
      )
    default:
      throw new Error(`Unsupported Electrobun tile context channel: ${channel}`)
  }
}

export function createElectrobunTileContextStore(options: {
  now?: () => number
  onChanged?: (payload: TileContextChangedPayload) => void
  persistence?: ElectrobunTileContextPersistence
} = {}) {
  const workspaces = new Map<string, WorkspaceTiles>()
  const hydration = new Map<string, Promise<void>>()
  const mutationLanes = new Map<string, Promise<void>>()
  const generations = new Map<string, number>()
  const now = options.now ?? Date.now

  function requirePart(value: string, label: string): string {
    const normalized = String(value ?? '').trim()
    if (!normalized) throw new Error(`${label} is required for tile context`)
    return normalized
  }

  function scopeKey(workspaceId: string, tileId: string): string {
    return JSON.stringify([workspaceId, tileId])
  }

  function cachedEntries(
    workspaceId: string,
    tileId: string,
    create = false,
  ): TileEntries | undefined {
    const workspace = workspaces.get(workspaceId)
    if (workspace) {
      const existing = workspace.get(tileId)
      if (existing || !create) return existing
      const entries = new Map<string, TileContextEntry>()
      workspace.set(tileId, entries)
      return entries
    }
    if (!create) return undefined
    const entries = new Map<string, TileContextEntry>()
    workspaces.set(workspaceId, new Map([[tileId, entries]]))
    return entries
  }

  function cacheEntries(workspaceId: string, tileId: string, entries: TileEntries): void {
    const workspace = workspaces.get(workspaceId)
    if (workspace) {
      workspace.set(tileId, entries)
    } else {
      workspaces.set(workspaceId, new Map([[tileId, entries]]))
    }
  }

  function persistedEntries(value: unknown): TileEntries {
    const entries = new Map<string, TileContextEntry>()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return entries
    for (const [key, candidate] of Object.entries(value)) {
      if (!key || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const entry = candidate as Partial<TileContextEntry>
      if (!Number.isFinite(entry.updatedAt)) continue
      entries.set(key, {
        key,
        value: entry.value,
        updatedAt: Number(entry.updatedAt),
        source: typeof entry.source === 'string' && entry.source ? entry.source : '',
      })
    }
    return entries
  }

  async function entriesFor(workspaceId: string, tileId: string): Promise<TileEntries> {
    const cached = cachedEntries(workspaceId, tileId)
    if (cached) return cached

    const scope = scopeKey(workspaceId, tileId)
    const generation = generations.get(scope) ?? 0
    let pending = hydration.get(scope)
    if (!pending) {
      pending = (async () => {
        const loaded = options.persistence
          ? await options.persistence.load(workspaceId, tileId)
          : {}
        if ((generations.get(scope) ?? 0) === generation) {
          cacheEntries(workspaceId, tileId, persistedEntries(loaded))
        }
      })()
      hydration.set(scope, pending)
    }
    try {
      await pending
    } finally {
      if (hydration.get(scope) === pending) hydration.delete(scope)
    }
    return cachedEntries(workspaceId, tileId, true)!
  }

  function contextRecord(entries: TileEntries): Record<string, TileContextEntry> {
    return Object.fromEntries(
      [...entries.entries()].map(([entryKey, entry]) => [entryKey, { ...entry }]),
    )
  }

  async function waitForMutations(workspaceId: string, tileId: string): Promise<void> {
    await mutationLanes.get(scopeKey(workspaceId, tileId))
  }

  async function mutate(
    workspaceId: string,
    tileId: string,
    update: (entries: TileEntries) => TileContextChangedPayload | null,
  ): Promise<void> {
    const scope = scopeKey(workspaceId, tileId)
    const previous = mutationLanes.get(scope) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const next = new Map(await entriesFor(workspaceId, tileId))
      const changed = update(next)
      if (!changed) return
      if (options.persistence) {
        await options.persistence.save(workspaceId, tileId, contextRecord(next))
      }
      cacheEntries(workspaceId, tileId, next)
      options.onChanged?.(changed)
    })
    const lane = operation.then(() => {}, () => {})
    mutationLanes.set(scope, lane)
    try {
      await operation
    } finally {
      if (mutationLanes.get(scope) === lane) mutationLanes.delete(scope)
    }
  }

  async function get(workspaceId: string, tileId: string, key?: string): Promise<TileContextEntry | Record<string, TileContextEntry> | null> {
    workspaceId = requirePart(workspaceId, 'workspaceId')
    tileId = requirePart(tileId, 'tileId')
    await waitForMutations(workspaceId, tileId)
    const entries = await entriesFor(workspaceId, tileId)
    if (key) {
      const entry = entries.get(key)
      return entry ? { ...entry } : null
    }
    return contextRecord(entries)
  }

  async function getAll(workspaceId: string, tileId: string, tagPrefix?: string): Promise<TileContextEntry[]> {
    workspaceId = requirePart(workspaceId, 'workspaceId')
    tileId = requirePart(tileId, 'tileId')
    await waitForMutations(workspaceId, tileId)
    const entries = [...(await entriesFor(workspaceId, tileId)).values()]
    return entries
      .filter(entry => !tagPrefix || entry.key.startsWith(tagPrefix))
      .map(entry => ({ ...entry }))
  }

  async function set(workspaceId: string, tileId: string, key: string, value: unknown): Promise<true> {
    workspaceId = requirePart(workspaceId, 'workspaceId')
    tileId = requirePart(tileId, 'tileId')
    key = requirePart(key, 'key')
    const entry: TileContextEntry = {
      key,
      value,
      updatedAt: now(),
      source: tileId,
    }
    await mutate(workspaceId, tileId, entries => {
      entries.set(key, entry)
      return { workspaceId, tileId, key, value }
    })
    return true
  }

  async function deleteEntry(workspaceId: string, tileId: string, key: string): Promise<true> {
    workspaceId = requirePart(workspaceId, 'workspaceId')
    tileId = requirePart(tileId, 'tileId')
    key = requirePart(key, 'key')
    await mutate(workspaceId, tileId, entries => {
      if (!entries.delete(key)) return null
      return { workspaceId, tileId, key, value: null }
    })
    return true
  }

  async function reset(workspaceId: string, tileId: string): Promise<void> {
    workspaceId = requirePart(workspaceId, 'workspaceId')
    tileId = requirePart(tileId, 'tileId')
    const scope = scopeKey(workspaceId, tileId)
    generations.set(scope, (generations.get(scope) ?? 0) + 1)
    hydration.delete(scope)
    const previous = mutationLanes.get(scope) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const workspace = workspaces.get(workspaceId)
      workspace?.delete(tileId)
      if (workspace?.size === 0) workspaces.delete(workspaceId)
      await options.persistence?.delete?.(workspaceId, tileId)
    })
    const lane = operation.then(() => {}, () => {})
    mutationLanes.set(scope, lane)
    try {
      await operation
    } finally {
      if (mutationLanes.get(scope) === lane) mutationLanes.delete(scope)
    }
  }

  return {
    get,
    getAll,
    set,
    delete: deleteEntry,
    reset,
  }
}
