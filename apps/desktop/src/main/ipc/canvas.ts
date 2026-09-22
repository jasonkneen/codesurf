import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AggregatedSessionEntry, SessionEntryHint } from '../../shared/session-types'
import { handleTyped, ipcSchemas } from './handleTyped.ts'
import {
  assertSafeWorkspaceArtifactId,
  canvasStatePath,
  ensureWorkspaceStorageMigrated,
  kanbanStatePath,
  loadWorkspaceTileState,
  saveWorkspaceTileState,
  sessionArchiveStatePath,
  tileSessionSummaryPath,
  tileStatePath,
} from '../storage/workspaceArtifacts'
import { writeJsonArtifactAtomic } from '../storage/jsonArtifacts'
import { WorkspaceSaveArbiter } from '../storage/workspaceSaveArbiter'
import {
  appendQueuedMessageEvent,
  listActiveQueuedMessages,
  type QueuedMessageEvent,
} from '../storage/queuedMessagesLog'
import { getWorkspacePathById } from './workspace'
import { deleteFileIfExists } from '../utils/fs'
import { broadcastToRenderer } from '../utils/broadcast'
import {
  captureCanvasRelayProjectionToken,
  scheduleCanvasRelayProjection,
} from '../relay/canvasProjection'
import { daemonClient } from '../daemon/client'
import { getIndexerStatus, indexAllSources, listThreadsFromDb, renameIndexedThread } from '../db/thread-indexer'
import { getExternalSessionChatState } from '../session-sources'
import { mutateArchivedSessionIds, readArchivedSessionIds } from '../storage/sessionArchives'
import { getAgentPath } from '../agent-paths'
import { log } from '../utils/logger.ts'

import {
  GENERATED_TITLE_MAX_CHARS,
  GENERATED_TITLE_MODEL,
  buildSessionTitlePrompt,
  buildTitleTranscript,
  cleanSessionTitleCandidate,
  createSessionTitleGenerationGate,
  deriveFallbackSessionTitle,
  describeSessionTitleModelCandidate,
  hasSessionTitleChangedDuringGeneration,
  redactTitleGenerationError,
  resolveSessionTitleModelCandidates,
  sanitizeGeneratedSessionTitle,
  type SessionTitleModelCandidate,
} from './session-title-generation'

const sessionsLog = log.scope('sessions')
const canvasSaveArbiter = new WorkspaceSaveArbiter()

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
const sessionTitleGenerationGate = createSessionTitleGenerationGate<{
  ok: boolean
  title?: string
  error?: string
}>()

function truncateSessionText(text: string | null | undefined, length = 120): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function extractInitialSessionTitle(messages: Record<string, unknown>[]): string | null {
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue
    const text = truncateSessionText(typeof rawMessage.content === 'string' ? rawMessage.content : null)
    const title = cleanSessionTitleCandidate(text)
    if (title) return title
  }
  return null
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

  const explicitTitle = cleanSessionTitleCandidate(typeof record.title === 'string' ? record.title : null)

  return {
    version: 1,
    tileId,
    sessionId,
    provider,
    model,
    messageCount: messages.length,
    lastMessage,
    title: explicitTitle ?? extractInitialSessionTitle(messages as Record<string, unknown>[]) ?? `${provider} session`,
    updatedAt: Date.now(),
  }
}

function isLocalSessionEntry(sessionEntryId: string): boolean {
  return sessionEntryId.startsWith('codesurf-runtime:')
    || sessionEntryId.startsWith('codesurf-tile:')
    || sessionEntryId.startsWith('codesurf-job:')
}

async function generateTitleWithClaude(prompt: string, model = GENERATED_TITLE_MODEL): Promise<string> {
  // `permissionMode: 'plan'` and `thinking.disabled` are valid SDK runtime
  // values whose literal types the published Options type doesn't expose; the
  // casts bridge that gap. pathToClaudeCodeExecutable is likewise an
  // undocumented-but-supported option field.
  const options: Options = {
    model,
    permissionMode: 'plan' as Options['permissionMode'],
    thinking: { type: 'disabled' } as Options['thinking'],
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    persistSession: false,
  }
  const claudePath = getAgentPath('claude')
  if (claudePath) {
    ;(options as { pathToClaudeCodeExecutable?: string }).pathToClaudeCodeExecutable = claudePath
  }

  const q = query({ prompt, options })
  let text = ''

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const blocks: Array<{ type?: string; text?: string }> =
        (msg as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content ?? []
      text += blocks
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
    } else if (msg.type === 'result') {
      const result = (msg as { result?: unknown }).result
      if (typeof result === 'string' && result.trim()) text = result
    }
  }

  return text.trim()
}

// Parses provider title responses across OpenAI-compatible shapes. Input is
// untrusted JSON, so it's typed `unknown` and every field access is guarded.
function extractOpenAiCompatibleTitleText(payload: unknown): string {
  const root = (payload ?? {}) as Record<string, unknown>
  const pickText = (part: unknown): string =>
    typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : ''

  const choices = Array.isArray(root.choices) ? root.choices : []
  for (const choice of choices as Array<Record<string, unknown>>) {
    const messageContent = (choice?.message as Record<string, unknown> | undefined)?.content
    if (typeof messageContent === 'string' && messageContent.trim()) return messageContent.trim()
    if (Array.isArray(messageContent)) {
      const text = messageContent.map(pickText).filter(Boolean).join('').trim()
      if (text) return text
    }
    if (typeof choice?.text === 'string' && choice.text.trim()) return choice.text.trim()
  }

  if (typeof root.output_text === 'string' && root.output_text.trim()) return root.output_text.trim()
  if (Array.isArray(root.output)) {
    const text = root.output
      .flatMap((item: unknown) => Array.isArray((item as { content?: unknown })?.content) ? (item as { content: unknown[] }).content : [])
      .map(pickText)
      .filter(Boolean)
      .join('')
      .trim()
    if (text) return text
  }

  return ''
}

function providerErrorMessage(payload: unknown, raw: string, fallback: string): string {
  const root = (payload ?? {}) as { error?: { message?: unknown; details?: unknown } | unknown; message?: unknown }
  const err = root.error as { message?: unknown; details?: unknown } | undefined
  const value = err?.message
    ?? err?.details
    ?? root.error
    ?? root.message
    ?? raw
    ?? fallback
  return redactTitleGenerationError(String(value || fallback)).slice(0, 500)
}

function buildOpenAiCompatibleTitleBody(candidate: Extract<SessionTitleModelCandidate, { kind: 'openai-compatible' }>, prompt: string): Record<string, unknown> {
  const messages = [
    {
      role: 'system',
      content: 'Generate compact thread titles only. Return JSON only: {"title":"Three Four Word Title"}. No markdown, no explanation, no tools.',
    },
    { role: 'user', content: prompt },
  ]

  if (candidate.provider === 'openai') {
    return {
      model: candidate.model,
      stream: false,
      max_completion_tokens: 80,
      messages,
    }
  }

  return {
    model: candidate.model,
    stream: false,
    max_tokens: 80,
    temperature: 0,
    messages,
  }
}

async function generateTitleWithOpenAiCompatible(prompt: string, candidate: Extract<SessionTitleModelCandidate, { kind: 'openai-compatible' }>): Promise<string> {
  const response = await fetch(`${candidate.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${candidate.apiKey}`,
      ...(candidate.provider === 'openrouter' ? {
        'HTTP-Referer': 'https://codesurf.local',
        'X-Title': 'CodeSurf',
      } : {}),
    },
    body: JSON.stringify(buildOpenAiCompatibleTitleBody(candidate, prompt)),
    signal: AbortSignal.timeout(20_000),
  })

  const raw = await response.text()
  let payload: unknown = null
  try {
    payload = raw.trim() ? JSON.parse(raw) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new Error(`${candidate.provider} title request failed (${response.status}): ${providerErrorMessage(payload, raw, response.statusText)}`)
  }

  const text = extractOpenAiCompatibleTitleText(payload)
  if (!text) throw new Error(`${candidate.provider} title request returned no text`)
  return text
}

async function generateTitleWithCandidate(prompt: string, candidate: SessionTitleModelCandidate): Promise<string> {
  if (candidate.kind === 'claude-sdk') return generateTitleWithClaude(prompt, candidate.model)
  return generateTitleWithOpenAiCompatible(prompt, candidate)
}

async function generateSessionTitleFromMessages(session: SessionEntryHint | AggregatedSessionEntry, messages: Record<string, unknown>[]): Promise<string> {
  const transcript = buildTitleTranscript(messages)
  const fallbackTitle = cleanSessionTitleCandidate(session.title, GENERATED_TITLE_MAX_CHARS) ?? 'Untitled Chat Thread'
  if (!transcript) return fallbackTitle

  const prompt = buildSessionTitlePrompt({
    currentTitle: fallbackTitle,
    provider: session.provider || 'unknown',
    model: session.model || 'unknown',
    messageCount: messages.length,
    transcript,
  })

  const candidates = resolveSessionTitleModelCandidates({
    provider: session.provider,
    model: session.model,
  })

  for (const candidate of candidates) {
    try {
      const generated = await generateTitleWithCandidate(prompt, candidate)
      return sanitizeGeneratedSessionTitle(generated, fallbackTitle)
    } catch (error) {
      console.warn(
        `[sessions] ${describeSessionTitleModelCandidate(candidate)} title generation failed, trying next title fallback:`,
        redactTitleGenerationError(error),
      )
    }
  }

  if (candidates.length === 0) {
    console.warn('[sessions] No provider title model configured, using local title fallback.')
  } else {
    console.warn('[sessions] Provider title generation failed, using local title fallback.')
  }
  return deriveFallbackSessionTitle(transcript, fallbackTitle)
}

async function loadSessionStateForTitleGeneration(
  workspaceId: string,
  sessionEntryId: string,
  entryHint: SessionEntryHint | null,
): Promise<{
  provider: string
  model: string
  messages: Record<string, unknown>[]
}> {
  const workspacePath = await getWorkspacePathById(workspaceId)

  if (isLocalSessionEntry(sessionEntryId)) {
    const local = await daemonClient.getLocalSessionState(workspaceId, sessionEntryId).catch(() => null)
    const localRec = local as Record<string, unknown> | null
    if (localRec && Array.isArray(localRec.messages)) {
      return {
        provider: typeof localRec.provider === 'string' ? localRec.provider : (entryHint?.provider ?? 'claude'),
        model: typeof localRec.model === 'string' ? localRec.model : (entryHint?.model ?? ''),
        messages: localRec.messages as Record<string, unknown>[],
      }
    }

    if (sessionEntryId.startsWith('codesurf-tile:tile-state-')) {
      const tileId = sessionEntryId.replace('codesurf-tile:tile-state-', '').replace(/\.json$/, '')
      const tileState = await loadWorkspaceTileState<Record<string, unknown> | null>(workspaceId, tileId, null)
      if (tileState && Array.isArray(tileState.messages)) {
        return {
          provider: typeof tileState.provider === 'string' ? tileState.provider : (entryHint?.provider ?? 'claude'),
          model: typeof tileState.model === 'string' ? tileState.model : (entryHint?.model ?? ''),
          messages: tileState.messages as Record<string, unknown>[],
        }
      }
    }

    throw new Error('Could not load local session transcript.')
  }

  const external = await getExternalSessionChatState(workspacePath, sessionEntryId, { entryHint }).catch(() => null)
  if (external && Array.isArray(external.messages)) {
    return {
      provider: external.provider,
      model: external.model,
      messages: external.messages as unknown as Record<string, unknown>[],
    }
  }

  const fallback = await daemonClient.getExternalSessionState(workspacePath, sessionEntryId).catch(() => null)
  const fallbackRec = fallback as Record<string, unknown> | null
  if (fallbackRec && Array.isArray(fallbackRec.messages)) {
    return {
      provider: typeof fallbackRec.provider === 'string' ? fallbackRec.provider : (entryHint?.provider ?? 'unknown'),
      model: typeof fallbackRec.model === 'string' ? fallbackRec.model : (entryHint?.model ?? ''),
      messages: fallbackRec.messages as Record<string, unknown>[],
    }
  }

  throw new Error('Could not load session transcript.')
}

async function getCurrentSessionTitleForTitleGeneration(
  workspaceId: string,
  sessionEntryId: string,
  workspacePath: string | null,
): Promise<string | null> {
  if (isLocalSessionEntry(sessionEntryId)) {
    const localSessions = await daemonClient.listLocalSessions(workspaceId).catch(() => [])
    const match = localSessions.find(session => session.id === sessionEntryId)
    return typeof match?.title === 'string' ? match.title : null
  }

  const indexedMatch = listThreadsFromDb(workspacePath).find(session => session.id === sessionEntryId)
  if (typeof indexedMatch?.title === 'string') return indexedMatch.title

  const daemonMatch = await daemonClient.listExternalSessions(workspacePath, true)
    .then(sessions => sessions.find(session => session.id === sessionEntryId) ?? null)
    .catch(() => null)
  return typeof daemonMatch?.title === 'string' ? daemonMatch.title : null
}

async function renameSessionTitleForSidebar(
  workspaceId: string,
  sessionEntryId: string,
  workspacePath: string | null,
  title: string,
): Promise<{ ok: boolean; error?: string; title?: string }> {
  if (isLocalSessionEntry(sessionEntryId)) {
    return await daemonClient.renameLocalSession(workspaceId, sessionEntryId, title).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  const scopedResult = await daemonClient.renameExternalSession(workspacePath, sessionEntryId, title).catch(error => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  if (scopedResult.ok) {
    renameIndexedThread(sessionEntryId, title)
    return scopedResult
  }

  const globalResult = workspacePath
    ? await daemonClient.renameExternalSession(null, sessionEntryId, title).catch(error => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    : scopedResult
  if (globalResult.ok) {
    renameIndexedThread(sessionEntryId, title)
    return globalResult
  }

  // Sidebar sessions are read from the SQLite thread index. Some sources are
  // index-only from the main process, so the daemon may not be able to resolve
  // them even though the row is visible and loadable. In that case persist the
  // user-owned title override directly in the index instead of failing with
  // "Session not found".
  if (renameIndexedThread(sessionEntryId, title)) return { ok: true, title }

  return globalResult.ok ? globalResult : scopedResult
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
  const record = state && typeof state === 'object' ? state as Record<string, unknown> : null
  const linkedSessionEntryId = typeof record?.linkedSessionEntryId === 'string' ? record.linkedSessionEntryId.trim() : ''
  const preserveSessionSummary = record?.preserveSessionSummary === true

  if (linkedSessionEntryId) {
    const changed = previous !== null
    await deleteFileIfExists(summaryPath)
    tileSessionSummaryCache.set(summaryPath, null)
    return { changed, summary: null }
  }

  if (preserveSessionSummary) {
    if (previous) {
      tileSessionSummaryCache.set(summaryPath, previous)
      return { changed: false, summary: previous }
    }
    tileSessionSummaryCache.set(summaryPath, null)
    return { changed: false, summary: null }
  }

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
    updatedAt: previous ? Date.now() : next.updatedAt,
  }
  await writeJsonArtifactAtomic(summaryPath, summaryToWrite)
  tileSessionSummaryCache.set(summaryPath, summaryToWrite)
  return { changed: true, summary: summaryToWrite }
}

// Track the last-seen summary signature per tile so we only broadcast
// sessionsChanged when something user-visible actually changes (not every
// token during a streaming turn).
const sessionSummarySignatures = new Map<string, string>()

// Debounce sessionsChanged broadcasts per workspace. Chat tiles save their
// state often (per turn, per keystroke during draft input, ...); each save
// may legitimately change the session summary, but broadcasting that to the
// sidebar every time causes a refetch storm. Coalesce rapid calls into a
// single broadcast. 3s is long enough to absorb bursts of activity (typing +
// streaming) but short enough that list still feels live after a conversation
// pauses.
const SESSIONS_CHANGED_DEBOUNCE_MS = 3000
const sessionsChangedTimers = new Map<string, NodeJS.Timeout>()
const sessionsChangedCallCounts = new Map<string, number>()

function broadcastSessionsChanged(workspaceId: string, reason: string = 'unknown'): void {
  const key = workspaceId || '*'
  const existing = sessionsChangedTimers.get(key)
  const callCount = (sessionsChangedCallCounts.get(key) ?? 0) + 1
  sessionsChangedCallCounts.set(key, callCount)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    sessionsChangedTimers.delete(key)
    const count = sessionsChangedCallCounts.get(key) ?? 1
    sessionsChangedCallCounts.delete(key)
    // eslint-disable-next-line no-console
    sessionsLog.info(`broadcast workspaceId=${workspaceId || '(empty)'} reason=${reason} coalesced=${count}`)
    broadcastToRenderer('canvas:sessionsChanged', { workspaceId })
  }, SESSIONS_CHANGED_DEBOUNCE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  sessionsChangedTimers.set(key, timer)
}

/** Immediate-fire variant: use when the event MUST land before a response
 *  (e.g. after delete/rename IPC replies so the renderer sees the result). */
function broadcastSessionsChangedNow(workspaceId: string, reason: string = 'explicit'): void {
  const existing = sessionsChangedTimers.get(workspaceId || '*')
  if (existing) {
    clearTimeout(existing)
    sessionsChangedTimers.delete(workspaceId || '*')
  }
  sessionsChangedCallCounts.delete(workspaceId || '*')
  // eslint-disable-next-line no-console
  sessionsLog.info(`broadcast(now) workspaceId=${workspaceId || '(empty)'} reason=${reason}`)
  broadcastToRenderer('canvas:sessionsChanged', { workspaceId })
}

async function readWorkspaceArchivedSessionIds(workspaceId: string): Promise<Set<string>> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  const paths = storageIds.map(storageId => sessionArchiveStatePath(storageId))
  return await readArchivedSessionIds(paths)
}

/**
 * Stable archive identity for a conversation. The aggregated entry `id` is NOT
 * stable — `mergeSessionEntries` collapses entries that share a provider
 * sessionId into one survivor whose `id` is chosen by priority/recency, so the
 * same chat can surface under different ids across listings. Keying archive
 * state on `agent:sessionId` (when a real sessionId exists) survives the merge;
 * returns null when there's no sessionId so callers fall back to the raw id.
 * Must mirror the renderer's key (`sid:${getSessionAgentKey}:${sessionId}`).
 */
function sessionArchiveIdentityKey(entry: AggregatedSessionEntry): string | null {
  const sessionId = String(entry.sessionId ?? '').trim()
  if (!sessionId) return null
  return `sid:${sessionIdentityAgent(entry)}:${sessionId}`
}

async function setWorkspaceSessionArchived(
  workspaceId: string,
  sessionEntryId: string,
  archived: boolean,
  identityKey?: string | null,
): Promise<boolean> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  const primaryStorageId = storageIds[0] ?? workspaceId
  const archivePath = sessionArchiveStatePath(primaryStorageId)
  // Prefer the stable identity key; fall back to the raw entry id when the
  // session has no provider sessionId (key is null/empty).
  const stableKey = String(identityKey ?? '').trim() || sessionEntryId
  // Serialized read→modify→write: concurrent archive calls (bulk "Archive
  // chats" fires one IPC call per session) must not overwrite each other.
  return await mutateArchivedSessionIds(
    storageIds.map(storageId => sessionArchiveStatePath(storageId)),
    archivePath,
    archivedIds => {
      if (archived) {
        if (archivedIds.has(stableKey)) return false
        archivedIds.add(stableKey)
        return true
      }
      // Clear both the stable key and any legacy raw-id entry so unarchiving a
      // session archived under the old id-based scheme also sticks.
      const hadEntry = archivedIds.has(stableKey) || archivedIds.has(sessionEntryId)
      if (!hadEntry) return false
      archivedIds.delete(stableKey)
      archivedIds.delete(sessionEntryId)
      return true
    },
  )
}

function applyArchivedSessionState(sessions: AggregatedSessionEntry[], archivedIds: Set<string>): AggregatedSessionEntry[] {
  return sessions.map(session => {
    const identityKey = sessionArchiveIdentityKey(session)
    // Match the stable identity key first; keep matching the raw id so archive
    // files written under the old scheme still resolve.
    const isArchived = (identityKey != null && archivedIds.has(identityKey)) || archivedIds.has(session.id)
    return session.isArchived === isArchived ? session : { ...session, isArchived }
  })
}

function normalizeSessionPath(path: string | null | undefined): string | null {
  const normalized = String(path ?? '').trim()
  return normalized || null
}

function listIndexedSessionsForWorkspacePaths(workspaceProjectPaths: Set<string>): AggregatedSessionEntry[] {
  const byId = new Map<string, AggregatedSessionEntry>()
  for (const projectPath of workspaceProjectPaths) {
    const normalizedPath = normalizeSessionPath(projectPath)
    if (!normalizedPath) continue
    const scopedEntries = listThreadsFromDb(normalizedPath)
    for (const entry of scopedEntries) {
      const existing = byId.get(entry.id)
      if (!existing || entry.updatedAt > existing.updatedAt) {
        byId.set(entry.id, entry)
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function sessionIdentityAgent(entry: AggregatedSessionEntry): string {
  if (entry.source === 'codesurf') {
    const provider = String(entry.provider ?? '').trim().toLowerCase()
    if (provider) return provider
  }
  return String(entry.source ?? 'codesurf').trim().toLowerCase() || 'codesurf'
}

function normalizeSessionIdentityText(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function fallbackSessionIdentityKey(entry: AggregatedSessionEntry): string | null {
  const agent = sessionIdentityAgent(entry)
  const title = normalizeSessionIdentityText(entry.title)
  if (!agent || !title) return null
  const projectPath = normalizeSessionIdentityText(entry.projectPath)
  return `${agent}:${projectPath}:${title}`
}

function mergeSessionEntries(localSessions: AggregatedSessionEntry[], nativeSessions: AggregatedSessionEntry[]): AggregatedSessionEntry[] {
  const byKey = new Map<string, AggregatedSessionEntry>()

  const priority = (entry: AggregatedSessionEntry): number => {
    if (entry.id.startsWith('codesurf-runtime:')) return 5
    if (entry.id.startsWith('codesurf-job:')) return 4
    if (entry.id.startsWith('codesurf-tile:')) return 3
    return 1
  }

  const mergeCanonicalMetadata = (
    preferred: AggregatedSessionEntry,
    alternate: AggregatedSessionEntry,
  ): AggregatedSessionEntry => {
    const canonical = [preferred, alternate].find(candidate =>
      candidate.source !== 'codesurf'
      && typeof candidate.title === 'string'
      && candidate.title.trim().length > 0,
    ) ?? null

    if (!canonical) return preferred

    return {
      ...preferred,
      title: canonical.title,
      filePath: preferred.filePath || canonical.filePath,
      sizeBytes: (typeof preferred.sizeBytes === 'number' && preferred.sizeBytes > 0) ? preferred.sizeBytes : canonical.sizeBytes,
      sourceDetail: preferred.sourceDetail || canonical.sourceDetail,
      model: preferred.model || canonical.model,
    }
  }

  for (const entry of [...nativeSessions, ...localSessions]) {
    const key = entry.sessionId ? `session:${sessionIdentityAgent(entry)}:${entry.sessionId}` : `entry:${entry.id}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, entry)
      continue
    }
    const existingPriority = priority(existing)
    const nextPriority = priority(entry)
    if (nextPriority > existingPriority || (nextPriority === existingPriority && entry.updatedAt > existing.updatedAt)) {
      byKey.set(key, mergeCanonicalMetadata(entry, existing))
      continue
    }
    byKey.set(key, mergeCanonicalMetadata(existing, entry))
  }

  const merged = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const hermesNativeByFallbackKey = new Map<string, AggregatedSessionEntry>()
  for (const entry of merged) {
    if (entry.source !== 'hermes' || !entry.sessionId) continue
    const key = fallbackSessionIdentityKey(entry)
    if (key) hermesNativeByFallbackKey.set(key, entry)
  }

  return merged.filter(entry => {
    if (entry.source !== 'codesurf') return true
    if (sessionIdentityAgent(entry) !== 'hermes') return true
    if (entry.sessionId) return true

    const key = fallbackSessionIdentityKey(entry)
    const native = key ? hermesNativeByFallbackKey.get(key) : null
    if (!native) return true

    const timeDelta = Math.abs((entry.updatedAt || 0) - (native.updatedAt || 0))
    return timeDelta > 30 * 60 * 1000
  })
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

  handleTyped('canvas:save', {
    args: [ipcSchemas.boundedString(), ipcSchemas.passthroughObject] as const,
    handler: async (_evt, workspaceId, state) => {
    // Capture relay lifecycle ownership before the save awaits its FIFO lane.
    // Shutdown/deactivation invalidates this token even if the disk write
    // completes later.
    const relayProjectionToken = captureCanvasRelayProjectionToken()
    // Reserve the per-workspace lane before any async migration or path
    // resolution. Otherwise a later handler can resolve first and let an older
    // request overwrite it.
    await canvasSaveArbiter.run(workspaceId, async () => {
      const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
      const storageId = storageIds[0] ?? workspaceId
      const path = canvasStatePath(storageId)
      await fs.mkdir(dirname(path), { recursive: true })
      await writeJsonArtifactAtomic(path, state)

      // Queue the derived relay projection at the same point as its durable
      // source state. The detached lane serializes by workspace and coalesces
      // pending work, so an older slow sync cannot become the final projection.
      if (
        relayProjectionToken
        && state
        && typeof state === 'object'
        && Array.isArray(state.tiles)
      ) {
        scheduleCanvasRelayProjection(
          workspaceId,
          relayProjectionToken,
          state.tiles,
        )
      }
    })
    },
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
    await fs.mkdir(dirname(path), { recursive: true })
    await writeJsonArtifactAtomic(path, state)
  })

  ipcMain.handle('canvas:loadTileState', async (_, workspaceId: string, tileId: string) => {
    return await loadWorkspaceTileState(workspaceId, tileId, null)
  })

  ipcMain.handle('canvas:saveTileState', async (_, workspaceId: string, tileId: string, state: unknown) => {
    const { storageId } = await saveWorkspaceTileState(workspaceId, tileId, state)

    const { changed, summary } = await writeTileSessionSummary(storageId, tileId, state)
    const isStreaming = state && typeof state === 'object' && (state as { isStreaming?: boolean }).isStreaming === true
    // Previously we broadcasted on ANY summary change, which fires every time
    // a chat message is appended (dozens of times during a streaming turn
    // even with isStreaming=true gating). That nuked sidebar stability.
    //
    // Instead: only broadcast when something the sidebar actually renders has
    // meaningfully changed vs what's already in the cache — i.e. the title
    // changed (rename or first message sets it) or this is the first save.
    const prevKey = sessionSummarySignatures.get(`${storageId}:${tileId}`) ?? null
    const nextKey = summary ? `${summary.title}|${summary.messageCount}` : null
    const titleOrFirstSaveChanged = prevKey === null
      ? nextKey !== null
      : nextKey !== null && prevKey.split('|')[0] !== nextKey.split('|')[0]
    if (summary) sessionSummarySignatures.set(`${storageId}:${tileId}`, nextKey!)
    else sessionSummarySignatures.delete(`${storageId}:${tileId}`)

    if (changed && !isStreaming && titleOrFirstSaveChanged) {
      broadcastSessionsChanged(workspaceId, 'saveTileState/title')
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

  // List workspace sessions by merging our local runtime/tile sessions with
  // native CLI session stores (Claude/Codex/OpenCode/OpenClaw/etc.) relevant
  // to this workspace's project paths. Native sessions remain the source of
  // truth; local entries only win when they represent the actively loaded
  // runtime view of the same session.
  ipcMain.handle('canvas:listSessions', async (_, workspaceId: string, forceRefresh = false) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const workspaces = await daemonClient.listWorkspaces().catch(() => [])
    const workspaceEntry = workspaces.find(entry => entry.id === workspaceId) ?? null
    const workspacePath = normalizeSessionPath(workspaceEntry?.path) ?? await getWorkspacePathById(workspaceId)
    const workspaceProjectPaths = new Set<string>(
      (workspaceEntry?.projectPaths ?? [])
        .map(projectPath => normalizeSessionPath(projectPath))
        .filter((projectPath): projectPath is string => Boolean(projectPath)),
    )
    if (workspacePath) workspaceProjectPaths.add(workspacePath)

    const localSessions: AggregatedSessionEntry[] = await daemonClient.listLocalSessions(workspaceId).catch(() => [])
    for (const session of localSessions) {
      if (!session.projectPath) session.projectPath = workspacePath
    }

    let nativeSessions: AggregatedSessionEntry[] = []
    if (workspaceProjectPaths.size > 0) {
      if (forceRefresh) {
        await indexAllSources().catch(error => {
          console.warn('[sessions] thread index refresh failed:', error)
        })
      }

      nativeSessions = listIndexedSessionsForWorkspacePaths(workspaceProjectPaths)
      if (nativeSessions.length === 0) {
        await indexAllSources().catch(error => {
          console.warn('[sessions] initial thread index build failed:', error)
        })
        nativeSessions = listIndexedSessionsForWorkspacePaths(workspaceProjectPaths)
      }
    }

    const relevantNativeSessions = nativeSessions
      .filter(session => session.source !== 'codesurf')
      .map(session => ({
        ...session,
        projectPath: normalizeSessionPath(session.projectPath) ?? workspacePath,
      }))

    const archivedIds = await readWorkspaceArchivedSessionIds(workspaceId)
    return applyArchivedSessionState(mergeSessionEntries(localSessions, relevantNativeSessions), archivedIds)
  })

  ipcMain.handle('threads:indexStatus', () => {
    try { return { ok: true, status: getIndexerStatus() } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('threads:reindex', async () => {
    try {
      await indexAllSources({ force: true })
      return { ok: true, ...getIndexerStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('canvas:getSessionState', async (
    _,
    workspaceId: string,
    sessionEntryId: string,
    options?: {
      tailLimit?: number
      entryHint?: SessionEntryHint | null
    },
  ) => {
    const workspacePath = await getWorkspacePathById(workspaceId)

    if (sessionEntryId.startsWith('codesurf-runtime:') || sessionEntryId.startsWith('codesurf-tile:') || sessionEntryId.startsWith('codesurf-job:')) {
      const local = await daemonClient.getLocalSessionState(workspaceId, sessionEntryId).catch(() => null)
      if (local) return local
      if (sessionEntryId.startsWith('codesurf-tile:tile-state-')) {
        const tileId = sessionEntryId.replace('codesurf-tile:tile-state-', '').replace(/\.json$/, '')
        return await loadWorkspaceTileState(workspaceId, tileId, null)
      }
      return null
    }

    // For external sessions (claude, codex, cursor, openclaw, opencode) parse
    // directly in the main process — the daemon's HTTP path returns null when
    // its own walker cache misses the file, which falls back to opening the
    // raw JSONL. Parsing locally avoids the round-trip entirely and always
    // uses fresh data from disk.
    const local = await getExternalSessionChatState(workspacePath, sessionEntryId, {
      entryHint: options?.entryHint ?? null,
      tailLimit: typeof options?.tailLimit === 'number' ? options.tailLimit : undefined,
    }).catch(() => null)
    if (local) return local
    // Keep daemon as last-resort fallback in case a provider type is only
    // supported there (e.g. future cloud-only sources).
    return await daemonClient.getExternalSessionState(workspacePath, sessionEntryId).catch(() => null)
  })

  ipcMain.handle('canvas:deleteSession', async (_, workspaceId: string, sessionEntryId: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const workspacePath = await getWorkspacePathById(workspaceId)

    if (sessionEntryId.startsWith('codesurf-runtime:') || sessionEntryId.startsWith('codesurf-tile:') || sessionEntryId.startsWith('codesurf-job:')) {
      const result = await daemonClient.deleteLocalSession(workspaceId, sessionEntryId).catch(error => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      if (result.ok) broadcastSessionsChangedNow(workspaceId)
      return result
    }

    const result = await daemonClient.deleteExternalSession(workspacePath, sessionEntryId).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (result.ok) {
      await indexAllSources().catch(error => {
        console.warn('[sessions] thread index refresh after delete failed:', error)
      })
      broadcastSessionsChangedNow(workspaceId)
    }
    return result
  })

  ipcMain.handle('canvas:renameSession', async (_, workspaceId: string, sessionEntryId: string, title: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const workspacePath = await getWorkspacePathById(workspaceId)

    const result = await renameSessionTitleForSidebar(workspaceId, sessionEntryId, workspacePath, title)

    if (result.ok) {
      broadcastSessionsChangedNow(workspaceId)
    }
    return result
  })

  ipcMain.handle('canvas:generateSessionTitle', async (
    _,
    workspaceId: string,
    sessionEntryId: string,
    entryHint?: SessionEntryHint | null,
  ) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const generationKey = `${workspaceId}::${sessionEntryId}`

    return await sessionTitleGenerationGate.run(generationKey, async () => {
      const workspacePath = await getWorkspacePathById(workspaceId)
      const currentTitleBeforeGeneration = await getCurrentSessionTitleForTitleGeneration(workspaceId, sessionEntryId, workspacePath)
      const initialTitle = cleanSessionTitleCandidate(entryHint?.title) ?? currentTitleBeforeGeneration ?? ''
      const state = await loadSessionStateForTitleGeneration(workspaceId, sessionEntryId, entryHint ?? null)
      if (!Array.isArray(state.messages) || state.messages.length === 0) {
        return { ok: false, error: 'Session has no transcript to title.' }
      }

      const title = await generateSessionTitleFromMessages({
        id: sessionEntryId,
        source: (entryHint?.source ?? 'codesurf') as SessionEntryHint['source'],
        provider: state.provider,
        model: state.model,
        messageCount: state.messages.length,
        title: initialTitle,
        sessionId: entryHint?.sessionId ?? null,
        filePath: entryHint?.filePath,
        projectPath: entryHint?.projectPath ?? null,
      }, state.messages)

      if (!title.trim()) {
        return { ok: false, error: 'Title generation returned an empty title.' }
      }

      const currentTitle = await getCurrentSessionTitleForTitleGeneration(workspaceId, sessionEntryId, workspacePath)
      if (hasSessionTitleChangedDuringGeneration(initialTitle, currentTitle)) {
        return {
          ok: false,
          error: 'Thread title changed while title generation was running; generated title was not applied.',
        }
      }

      const result = await renameSessionTitleForSidebar(workspaceId, sessionEntryId, workspacePath, title)

      if (result.ok) {
        broadcastSessionsChangedNow(workspaceId, 'generateSessionTitle')
      }

      return result.ok
        ? { ok: true, title }
        : { ok: false, error: result.error || 'Failed to apply generated title.' }
    })
  })

  ipcMain.handle('canvas:setSessionArchived', async (_, workspaceId: string, sessionEntryId: string, archived: boolean, identityKey?: string | null) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const changed = await setWorkspaceSessionArchived(workspaceId, sessionEntryId, archived, identityKey).catch(error => {
      throw new Error(error instanceof Error ? error.message : String(error))
    })
    if (changed) broadcastSessionsChangedNow(workspaceId, archived ? 'archiveSession' : 'unarchiveSession')
    return { ok: true, changed, archived }
  })

  ipcMain.handle('canvas:listCheckpoints', async (_, workspaceId: string, sessionEntryId: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    if (!sessionEntryId.startsWith('codesurf-runtime:')) return []
    return await daemonClient.listCheckpoints(workspaceId, sessionEntryId).catch(() => [])
  })

  ipcMain.handle('canvas:restoreCheckpoint', async (_, workspaceId: string, checkpointId: string, sessionEntryId?: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const result = await daemonClient.restoreCheckpoint(workspaceId, checkpointId, sessionEntryId ?? null).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (result.ok) broadcastSessionsChangedNow(workspaceId)
    return result
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
    // Any queued messages belonging to this tile are now orphaned by definition;
    // mark them cleared so the log stays consistent.
    try {
      await appendQueuedMessageEvent({
        type: 'clear',
        at: Date.now(),
        workspaceId,
        tileId,
      })
    } catch { /* best-effort */ }
    broadcastSessionsChanged(workspaceId)
  })

  // Queued-message event log (append-only JSONL) used to track orphans
  // across crashes and tile deletions.
  ipcMain.handle('canvas:queuedMessages:append', async (_, event: unknown) => {
    if (!event || typeof event !== 'object') return
    const record = event as Record<string, unknown>
    const type = record.type
    if (type !== 'enqueue' && type !== 'dispatch' && type !== 'delete' && type !== 'complete' && type !== 'clear') return
    const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : ''
    const tileId = typeof record.tileId === 'string' ? record.tileId : ''
    if (!workspaceId || !tileId) return
    const payload: QueuedMessageEvent = {
      type,
      workspaceId,
      tileId,
      at: typeof record.at === 'number' ? record.at : Date.now(),
    }
    if (typeof record.queueId === 'string') payload.queueId = record.queueId
    if (typeof record.content === 'string') payload.content = record.content
    if (typeof record.preview === 'string') payload.preview = record.preview
    if (typeof record.attachmentCount === 'number') payload.attachmentCount = record.attachmentCount
    if (typeof record.createdAt === 'number') payload.createdAt = record.createdAt
    await appendQueuedMessageEvent(payload)
  })

  ipcMain.handle('canvas:queuedMessages:listActive', async () => {
    return await listActiveQueuedMessages()
  })
}
