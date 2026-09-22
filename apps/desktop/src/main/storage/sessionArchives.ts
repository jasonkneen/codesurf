import { promises as fs } from 'fs'
import { dirname } from 'path'

interface SessionArchiveState {
  version: 1
  archivedSessionIds: string[]
}

export function normalizeArchivedSessionIds(value: unknown): string[] {
  const normalized = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string') continue
    const sessionId = entry.trim()
    if (!sessionId) continue
    normalized.add(sessionId)
  }
  return Array.from(normalized).sort((a, b) => a.localeCompare(b))
}

export async function readArchivedSessionIds(paths: string[]): Promise<Set<string>> {
  const archived = new Set<string>()
  for (const path of paths) {
    try {
      const raw = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<SessionArchiveState>
      for (const sessionId of normalizeArchivedSessionIds(raw?.archivedSessionIds)) {
        archived.add(sessionId)
      }
    } catch {
      // ignore missing or malformed archive files and continue
    }
  }
  return archived
}

export async function writeArchivedSessionIds(path: string, archivedSessionIds: Iterable<string>): Promise<void> {
  const normalized = normalizeArchivedSessionIds(Array.from(archivedSessionIds))
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify({
    version: 1,
    archivedSessionIds: normalized,
  }, null, 2))
}

/** Per-write-path promise chains so read→modify→write cycles never interleave. */
const archiveMutationQueues = new Map<string, Promise<unknown>>()

/**
 * Atomically mutate the archived-session set persisted at `writePath`.
 *
 * Concurrent callers targeting the same `writePath` are serialized through a
 * promise queue — without this, parallel `canvas:setSessionArchived` IPC calls
 * (e.g. the sidebar's bulk "Archive chats" action firing one call per session)
 * each read the same initial file, apply one change, and overwrite each other,
 * silently dropping all but the last archive flag.
 *
 * `readPaths` are merged into the working set before mutating (legacy storage
 * locations). The mutator returns whether it changed the set; the file is only
 * rewritten when it did.
 */
export async function mutateArchivedSessionIds(
  readPaths: string[],
  writePath: string,
  mutate: (archivedIds: Set<string>) => boolean,
): Promise<boolean> {
  const previous = archiveMutationQueues.get(writePath) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    const archivedIds = await readArchivedSessionIds(readPaths)
    const changed = mutate(archivedIds)
    if (changed) await writeArchivedSessionIds(writePath, archivedIds)
    return changed
  })
  archiveMutationQueues.set(writePath, task)
  void task.catch(() => {}).finally(() => {
    if (archiveMutationQueues.get(writePath) === task) archiveMutationQueues.delete(writePath)
  })
  return task
}
