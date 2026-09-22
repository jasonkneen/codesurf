export const RECENT_EDIT_CONTEXT_READ_MAX_BYTES = 64 * 1024

export interface BoundedRecentEditFs {
  readFilePrefix(path: string, maxBytes: number, workspaceId?: string): Promise<string>
}

export interface TrustedRecentEditChange {
  displayPath: string
  resolvedPath: string
  diff: string
  changeType: string
}

export interface LoadedTrustedRecentEditChange extends TrustedRecentEditChange {
  fileContent: string
}

export interface RecentEditOrigin {
  workspaceId: string
  cardId: string
  provider: string
  executionTarget: 'local' | 'cloud'
  sessionId: string | null
}

interface RecentEditMessageLike {
  role?: string
  toolBlocks?: Array<{
    fileChangesTrusted?: boolean
    fileChangesOrigin?: RecentEditOrigin
    fileChanges?: Array<{ path?: string; diff?: string; changeType?: string }>
  }>
}

function workspacePath(pathValue: unknown, workspaceDir: string): string | null {
  const path = String(pathValue ?? '').trim()
  const root = workspaceDir.trim().replace(/\/+$/, '')
  if (!path || !root) return null
  if (path.startsWith('/')) {
    return path === root || path.startsWith(`${root}/`) ? path : null
  }
  const segments = path.replace(/^\/+/, '').split('/')
  if (segments.some(segment => segment === '..' || segment === '')) return null
  return `${root}/${segments.filter(segment => segment !== '.').join('/')}`
}

/** Select only main-process-attested local changes in the current workspace. */
export function collectTrustedRecentEditChanges(
  messages: readonly RecentEditMessageLike[],
  workspaceDir: string,
  activeOrigin: RecentEditOrigin | undefined,
  limit = 3,
): TrustedRecentEditChange[] {
  if (
    !activeOrigin
    || activeOrigin.executionTarget !== 'local'
    || !activeOrigin.workspaceId
    || !activeOrigin.cardId
    || !activeOrigin.provider
  ) return []

  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(3, limit))
    : 0
  const seen = new Set<string>()
  const output: TrustedRecentEditChange[] = []
  for (let messageIndex = messages.length - 1; messageIndex >= 0 && output.length < safeLimit; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.role !== 'assistant') continue
    const blocks = message.toolBlocks ?? []
    for (let blockIndex = blocks.length - 1; blockIndex >= 0 && output.length < safeLimit; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (block?.fileChangesTrusted !== true) continue
      const origin = block.fileChangesOrigin
      if (
        !origin
        || origin.workspaceId !== activeOrigin.workspaceId
        || origin.cardId !== activeOrigin.cardId
        || origin.provider !== activeOrigin.provider
        || origin.executionTarget !== activeOrigin.executionTarget
        || origin.sessionId !== activeOrigin.sessionId
      ) continue
      const changes = block.fileChanges ?? []
      for (let changeIndex = changes.length - 1; changeIndex >= 0 && output.length < safeLimit; changeIndex -= 1) {
        const change = changes[changeIndex]
        const resolvedPath = workspacePath(change?.path, workspaceDir)
        if (!resolvedPath || seen.has(resolvedPath)) continue
        seen.add(resolvedPath)
        output.push({
          displayPath: String(change?.path ?? '').slice(0, 512),
          resolvedPath,
          diff: String(change?.diff ?? '').slice(0, 64 * 1024),
          changeType: String(change?.changeType ?? 'update').slice(0, 32),
        })
      }
    }
  }
  return output
}

/** Always crosses the host boundary through the bounded prefix operation. */
export async function readRecentEditFilePrefix(
  fs: BoundedRecentEditFs,
  path: string,
  workspaceId?: string,
): Promise<string> {
  return await fs.readFilePrefix(path, RECENT_EDIT_CONTEXT_READ_MAX_BYTES, workspaceId)
}

/** Selects provenance-compatible changes before crossing the host boundary. */
export async function loadTrustedRecentEditFiles(
  messages: readonly RecentEditMessageLike[],
  workspaceDir: string,
  activeOrigin: RecentEditOrigin | undefined,
  fs: BoundedRecentEditFs,
  workspaceId?: string,
  limit = 3,
): Promise<LoadedTrustedRecentEditChange[]> {
  const changes = collectTrustedRecentEditChanges(
    messages,
    workspaceDir,
    activeOrigin,
    limit,
  )
  const loaded: LoadedTrustedRecentEditChange[] = []
  for (const change of changes) {
    try {
      loaded.push({
        ...change,
        fileContent: await readRecentEditFilePrefix(fs, change.resolvedPath, workspaceId),
      })
    } catch {
      // Files may have been moved/deleted; omit them without widening access.
    }
  }
  return loaded
}
