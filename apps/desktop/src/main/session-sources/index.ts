import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'
import { realpath } from 'fs/promises'
import type { AggregatedSessionEntry, SessionEntryHint } from '../../shared/session-types.ts'
import { CODESURF_HOME } from '../paths.ts'
import { buildChatMessageHistoryFingerprint } from '../../shared/chat-history.ts'
import {
  type ChatRole,
  type ImportedChatMessage,
  type ImportedChatState,
  type CachedExternalSessionState,
  type ImportedThinkingBlock,
  type ImportedToolFileChange,
  type ImportedToolCommandEntry,
  type ImportedToolBlock,
  type ImportedContentBlock,
  EXTERNAL_SESSION_CACHE_MS,
  EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES,
  EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES,
  LARGE_EXTERNAL_SESSION_BYTES,
  EXTERNAL_SESSION_TAIL_SAMPLE_BYTES,
  externalSessionCache,
  externalSessionStateCache,
  externalSessionFullStateCache,
  ensureCodeSurfStructure,
  statSafe,
  readTextTailSafe,
  getProjectCodeSurfDir,
  getCachedExternalSessionChatState,
  getFreshCachedExternalSessionChatState,
  pathScope,
  compareSessions,
  dedupeImportedMessages,
  parseJsonlLines,
} from './shared.ts'
import { listCodeSurfSessionFiles, parseCodeSurfChatState } from './codesurf.ts'
import { listClaudeSessions, parseClaudeChatState, parseClaudeMessagesFromLines } from './claude.ts'
import { listCodexSessions, parseCodexChatState, parseCodexChatStateFromLines } from './codex.ts'
import { listHermesSessions, parseHermesChatState } from './hermes.ts'
import { listPiAgentSessions, parsePiAgentChatState } from './pi-agent.ts'
import { listCursorSessions } from './cursor.ts'
import { listOpenClawSessions, parseOpenClawChatState } from './openclaw.ts'
import { listOpenCodeSessions, parseOpenCodeChatState } from './opencode.ts'

// Re-export all types and simple functions from shared
export type {
  ChatRole,
  ImportedChatMessage,
  ImportedChatState,
  CachedExternalSessionState,
  ImportedThinkingBlock,
  ImportedToolFileChange,
  ImportedToolCommandEntry,
  ImportedToolBlock,
  ImportedContentBlock,
}
export { isExternalSessionImportableInChat, ensureCodeSurfStructure } from './shared.ts'

export async function listExternalSessionEntries(
  workspacePath: string | null,
  options?: { force?: boolean },
): Promise<AggregatedSessionEntry[]> {
  const cacheKey = workspacePath ?? '__no_workspace__'
  const cached = externalSessionCache.get(cacheKey)

  // Stale-while-revalidate: when force is set but we have cached data,
  // return the stale entries immediately and refresh in the background.
  if (options?.force && cached) {
    void refreshExternalSessionEntries(workspacePath, cacheKey)
    return cached.entries
  }

  if (cached && (Date.now() - cached.at) < EXTERNAL_SESSION_CACHE_MS) {
    return cached.entries
  }

  return refreshExternalSessionEntries(workspacePath, cacheKey)
}

/** Inflight dedup for background refreshes so we don't double-scan. */
const inflightRefreshes = new Map<string, Promise<AggregatedSessionEntry[]>>()

async function refreshExternalSessionEntries(
  workspacePath: string | null,
  cacheKey: string,
): Promise<AggregatedSessionEntry[]> {
  const existing = inflightRefreshes.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    await ensureCodeSurfStructure(workspacePath)

    // Run all provider scans in parallel — they read independent directories.
    const results = await Promise.allSettled([
      listCodeSurfSessionFiles(workspacePath),
      listClaudeSessions(workspacePath),
      listCodexSessions(workspacePath),
      listHermesSessions(workspacePath),
      listPiAgentSessions(workspacePath),
      listCursorSessions(workspacePath),
      listOpenClawSessions(workspacePath),
      listOpenCodeSessions(workspacePath),
    ])

    const entries = results
      .flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .sort(compareSessions)

    externalSessionCache.set(cacheKey, { at: Date.now(), entries })
    return entries
  })()

  inflightRefreshes.set(cacheKey, promise)
  promise.finally(() => { inflightRefreshes.delete(cacheKey) })
  return promise
}

function buildEntryFromHint(workspacePath: string | null, hint: SessionEntryHint): AggregatedSessionEntry {
  return {
    id: hint.id,
    source: hint.source,
    scope: pathScope(workspacePath, hint.projectPath ?? null, 'user'),
    tileId: null,
    sessionId: hint.sessionId,
    provider: hint.provider,
    model: hint.model,
    messageCount: hint.messageCount,
    lastMessage: null,
    updatedAt: 0,
    filePath: hint.filePath,
    title: hint.title,
    projectPath: hint.projectPath ?? null,
    sourceLabel: hint.provider || hint.source,
    canOpenInChat: true,
    canOpenInApp: false,
  }
}

/**
 * Session-file roots trusted for renderer-supplied entry hints. Mirrors the
 * directories each provider's list* scanner reads — keep in sync when a
 * scanner gains a root. Without this confinement, chat:loadSessionHistory
 * could be pointed at any file on disk (e.g. ~/.ssh/id_rsa) and its contents
 * returned as chat messages.
 */
function sessionFileRoots(source: SessionEntryHint['source'], workspacePath: string | null): string[] {
  const home = homedir()
  switch (source) {
    case 'codesurf': {
      const roots = [join(CODESURF_HOME, 'sessions')]
      if (workspacePath) roots.push(join(getProjectCodeSurfDir(workspacePath), 'sessions'))
      return roots
    }
    case 'claude':
      return [join(home, '.claude', 'projects'), join(home, '.claude', 'transcripts')]
    case 'codex':
      return [join(home, '.codex', 'sessions')]
    case 'cursor':
      return [join(home, '.cursor', 'chats')]
    case 'hermes':
      return [join(home, '.hermes')]
    case 'openclaw':
      return [join(home, '.openclaw', 'agents')]
    case 'opencode':
      return [join(home, '.opencode', 'conversations')]
    case 'csagent':
      return [join(CODESURF_HOME, 'agent-sessions'), join(home, '.pi', 'agent', 'sessions')]
    default:
      return []
  }
}

async function isSessionFilePathAllowed(
  source: SessionEntryHint['source'],
  workspacePath: string | null,
  filePath: string,
): Promise<boolean> {
  if (!isAbsolute(filePath)) return false
  const roots = sessionFileRoots(source, workspacePath)
  if (roots.length === 0) return false
  // Resolve symlinks on both sides: the file may be a link escaping the root,
  // and the roots themselves may sit under symlinked dirs (/tmp, $HOME).
  const resolvedFile = await realpath(filePath).catch(() => resolve(filePath))
  const rootCandidates = new Set<string>()
  for (const root of roots) {
    rootCandidates.add(resolve(root))
    const real = await realpath(root).catch(() => null)
    if (real) rootCandidates.add(real)
  }
  // APFS/Windows are case-insensitive by default — compare case-folded so a
  // differently-cased escape can't slip past the prefix check.
  const foldCase = process.platform === 'darwin' || process.platform === 'win32'
  const fileCmp = foldCase ? resolvedFile.toLowerCase() : resolvedFile
  for (const root of rootCandidates) {
    const rootCmp = foldCase ? root.toLowerCase() : root
    if (fileCmp === rootCmp || fileCmp.startsWith(rootCmp + sep)) return true
  }
  return false
}

async function resolveSessionEntry(
  workspacePath: string | null,
  id: string,
  entryHint?: SessionEntryHint | null,
): Promise<AggregatedSessionEntry | null> {
  if (entryHint && entryHint.id === id && entryHint.filePath) {
    const stat = await statSafe(entryHint.filePath)
    if (stat?.isFile() && await isSessionFilePathAllowed(entryHint.source, workspacePath, entryHint.filePath)) {
      return buildEntryFromHint(workspacePath, entryHint)
    }
  }
  return findSessionEntryById(workspacePath, id)
}

export async function findSessionEntryById(workspacePath: string | null, id: string): Promise<AggregatedSessionEntry | null> {
  // First try the workspace-scoped list — fast path for the common case.
  const scoped = await listExternalSessionEntries(workspacePath)
  const scopedHit = scoped.find(entry => entry.id === id)
  if (scopedHit) return scopedHit

  // Sidebar listings go through the daemon indexer which sees globally; the
  // main-process scoped index occasionally misses sessions whose cwd doesn't
  // exactly match the workspace path (symlinks, alt paths, or user-scope
  // global sessions). Fall back to the unscoped list so clicking one of
  // those rows still loads its chat state instead of silently failing.
  if (workspacePath) {
    const global = await listExternalSessionEntries(null)
    const globalHit = global.find(entry => entry.id === id)
    if (globalHit) return globalHit
  }

  // Last-resort: force-refresh the scoped cache in case the session was just
  // created and the prior entry is stale.
  const refreshed = await listExternalSessionEntries(workspacePath, { force: true })
  const refreshedHit = refreshed.find(entry => entry.id === id)
  if (refreshedHit) return refreshedHit

  // The sidebar list comes from the daemon's global view, so a user-scoped
  // transcript can still be visible even when the workspace-scoped cache and
  // its forced refresh don't contain it yet.
  if (workspacePath) {
    const refreshedGlobal = await listExternalSessionEntries(null, { force: true })
    return refreshedGlobal.find(entry => entry.id === id) ?? null
  }

  return null
}

export function invalidateExternalSessionCache(workspacePath?: string | null): void {
  if (workspacePath) {
    externalSessionCache.delete(workspacePath)
    for (const key of externalSessionStateCache.keys()) {
      if (key.startsWith(`${workspacePath}::`)) externalSessionStateCache.delete(key)
    }
    for (const key of externalSessionFullStateCache.keys()) {
      if (key.startsWith(`${workspacePath}::`)) externalSessionFullStateCache.delete(key)
    }
    return
  }
  externalSessionCache.clear()
  externalSessionStateCache.clear()
  externalSessionFullStateCache.clear()
}

async function loadCachedExternalSessionState(entry: AggregatedSessionEntry, cacheKey: string): Promise<ImportedChatState | null> {
  if (!entry.filePath) return null

  return await getCachedExternalSessionChatState(
    externalSessionStateCache,
    EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES,
    cacheKey,
    entry.filePath,
    async () => {
      if (entry.source === 'codesurf') return parseCodeSurfChatState(entry.filePath!)
      if (entry.source === 'claude') return parseClaudeChatState(entry.filePath!, entry)
      if (entry.source === 'codex') return parseCodexChatState(entry.filePath!, entry)
      if (entry.source === 'hermes') return parseHermesChatState(entry.filePath!, entry)
      if (entry.source === 'csagent') return parsePiAgentChatState(entry.filePath!, entry)
      if (entry.source === 'openclaw') return parseOpenClawChatState(entry.filePath!, entry)
      if (entry.source === 'opencode') return parseOpenCodeChatState(entry.filePath!, entry)
      return null
    },
  )
}

async function loadCachedFullExternalSessionState(entry: AggregatedSessionEntry, cacheKey: string): Promise<ImportedChatState | null> {
  if (!entry.filePath) return null

  return await getCachedExternalSessionChatState(
    externalSessionFullStateCache,
    EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES,
    `${cacheKey}::full`,
    entry.filePath,
    async () => {
      if (entry.source === 'codesurf') return parseCodeSurfChatState(entry.filePath!)
      if (entry.source === 'claude') return parseClaudeChatState(entry.filePath!, entry, { full: true })
      if (entry.source === 'codex') return parseCodexChatState(entry.filePath!, entry, { full: true })
      if (entry.source === 'hermes') return parseHermesChatState(entry.filePath!, entry)
      if (entry.source === 'csagent') return parsePiAgentChatState(entry.filePath!, entry)
      if (entry.source === 'openclaw') return parseOpenClawChatState(entry.filePath!, entry)
      if (entry.source === 'opencode') return parseOpenCodeChatState(entry.filePath!, entry)
      return null
    },
  )
}

function inferHasEarlierMessages(entry: AggregatedSessionEntry, loadedCount: number, tailLimit?: number): boolean {
  if (tailLimit == null) return false
  if (loadedCount > tailLimit) return true
  return Number.isFinite(entry.messageCount) && entry.messageCount > Math.max(loadedCount, tailLimit)
}

export async function getExternalSessionChatState(
  workspacePath: string | null,
  id: string,
  options?: { entryHint?: SessionEntryHint | null; tailLimit?: number },
): Promise<(ImportedChatState & { hasEarlierMessages?: boolean }) | null> {
  const entry = await resolveSessionEntry(workspacePath, id, options?.entryHint)
  if (!entry?.filePath || !entry.canOpenInChat) return null
  const cacheKey = `${workspacePath ?? '__no_workspace__'}::${entry.source}::${entry.filePath}::${entry.id}`
  const tailLimit = typeof options?.tailLimit === 'number' && options.tailLimit > 0
    ? Math.max(1, Math.floor(options.tailLimit))
    : null

  const cachedFullState = tailLimit == null
    ? null
    : await getFreshCachedExternalSessionChatState(
        externalSessionFullStateCache,
        EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES,
        `${cacheKey}::full`,
        entry.filePath,
      )

  const state = cachedFullState ?? await loadCachedExternalSessionState(entry, cacheKey)
  if (!state) return null

  if (tailLimit == null || state.messages.length <= tailLimit) {
    return {
      ...state,
      hasEarlierMessages: inferHasEarlierMessages(entry, state.messages.length, tailLimit ?? undefined),
    }
  }

  return {
    ...state,
    messages: state.messages.slice(-tailLimit),
    hasEarlierMessages: true,
  }
}

export async function loadExternalSessionMessagesPage(
  workspacePath: string | null,
  id: string,
  options: {
    entryHint?: SessionEntryHint | null
    beforeFingerprint?: string | null
    limit?: number
  },
): Promise<{
  provider: string
  model: string
  sessionId: string | null
  total: number
  hasMore: boolean
  messages: ImportedChatMessage[]
} | null> {
  const entry = await resolveSessionEntry(workspacePath, id, options.entryHint)
  if (!entry?.filePath || !entry.canOpenInChat) return null

  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)))
  const largePage = await loadLargeExternalSessionMessagesPageFromTail(entry, {
    beforeFingerprint: String(options.beforeFingerprint ?? '').trim(),
    limit,
  })
  if (largePage) return largePage

  const cacheKey = `${workspacePath ?? '__no_workspace__'}::${entry.source}::${entry.filePath}::${entry.id}`
  const state = await loadCachedFullExternalSessionState(entry, cacheKey)
  if (!state) return null

  const beforeFingerprint = String(options.beforeFingerprint ?? '').trim()
  let endIndex = state.messages.length
  if (beforeFingerprint) {
    const matchIndex = state.messages.findIndex(message => buildChatMessageHistoryFingerprint(message as any) === beforeFingerprint)
    if (matchIndex < 0) {
      return {
        provider: state.provider,
        model: state.model,
        sessionId: state.sessionId,
        total: state.messages.length,
        hasMore: false,
        messages: [],
      }
    }
    endIndex = matchIndex
  }

  const startIndex = Math.max(0, endIndex - limit)
  return {
    provider: state.provider,
    model: state.model,
    sessionId: state.sessionId,
    total: state.messages.length,
    hasMore: startIndex > 0,
    messages: state.messages.slice(startIndex, endIndex),
  }
}

async function loadLargeExternalSessionMessagesPageFromTail(
  entry: AggregatedSessionEntry,
  options: { beforeFingerprint: string; limit: number },
): Promise<{
  provider: string
  model: string
  sessionId: string | null
  total: number
  hasMore: boolean
  messages: ImportedChatMessage[]
} | null> {
  if (entry.source !== 'claude' && entry.source !== 'codex') return null
  if (!entry.filePath) return null

  const stat = await statSafe(entry.filePath)
  if (!stat?.isFile() || stat.size <= LARGE_EXTERNAL_SESSION_BYTES) return null

  const sampleBytes = Math.min(stat.size, EXTERNAL_SESSION_TAIL_SAMPLE_BYTES * 2)
  const raw = await readTextTailSafe(entry.filePath, sampleBytes)
  const lines = parseJsonlLines(raw ?? '')
  const state = entry.source === 'claude'
    ? {
        provider: 'claude',
        model: entry.model,
        sessionId: entry.sessionId,
        // This path reads only the tail, so use the same disjoint namespace as the
        // tail sample path (100_000_000) to avoid duplicate React keys with any head.
        messages: parseClaudeMessagesFromLines(lines, 100_000_000),
      }
    : parseCodexChatStateFromLines(lines, entry, Math.max(10_000, lines.length))

  const messages = dedupeImportedMessages(state.messages)
  const beforeFingerprint = options.beforeFingerprint
  let endIndex = messages.length
  if (beforeFingerprint) {
    const matchIndex = messages.findIndex(message => buildChatMessageHistoryFingerprint(message as any) === beforeFingerprint)
    if (matchIndex < 0) {
      return {
        provider: state.provider,
        model: state.model,
        sessionId: state.sessionId,
        total: Number.isFinite(entry.messageCount) ? Number(entry.messageCount) : messages.length,
        hasMore: false,
        messages: [],
      }
    }
    endIndex = matchIndex
  }

  const startIndex = Math.max(0, endIndex - options.limit)
  return {
    provider: state.provider,
    model: state.model,
    sessionId: state.sessionId,
    total: Number.isFinite(entry.messageCount) ? Number(entry.messageCount) : messages.length,
    hasMore: startIndex > 0,
    messages: messages.slice(startIndex, endIndex),
  }
}
