import { homedir } from 'os'
import { basename, extname, join } from 'path'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  type ChatRole,
  type ImportedChatMessage,
  type ImportedChatState,
  CODEX_SESSION_LISTING_HEAD_BYTES,
  CODEX_SESSION_LISTING_TAIL_BYTES,
  CODEX_SESSION_EXACT_SCAN_MAX_BYTES,
  EXTERNAL_SESSION_HEAD_SAMPLE_BYTES,
  EXTERNAL_SESSION_TAIL_SAMPLE_BYTES,
  LARGE_EXTERNAL_SESSION_BYTES,
  MAX_SESSION_LISTING_JSON_BYTES,
  fileExists,
  readJsonSafe,
  readTextSafe,
  readTextPreviewSafe,
  readTextTailSafe,
  statSafe,
  scanJsonlFile,
  truncate,
  firstMeaningfulSessionTitleLine,
  sessionTitleFromText,
  pathScope,
  extractTextParts,
  makeImportedMessage,
  makeImportedRichMessage,
  makeTranscriptTruncationMessage,
  dedupeImportedMessages,
  parseJsonlLines,
  parseJsonObject,
  listFilesRecursive,
  isExternalSessionImportableInChat,
  roleFromUnknown,
} from './shared.ts'
import {
  type PendingImportedToolCall,
  extractCommandFromToolCall,
  extractApplyPatchText,
  parseApplyPatchFileChanges,
  classifyCommand,
  buildImportedToolBlocks,
  extractReasoningSummary,
  isImportedPlanToolName,
} from './tool-blocks.ts'
import { sanitizeToolOutputText } from '../chat/output-sanitizers.ts'

/**
 * Strip Codex internal control markers that occasionally bleed into message
 * content (e.g. `<turn_aborted>…</turn_aborted>` written into the turn log
 * when the user interrupts mid-run). These are protocol-level annotations,
 * not user-authored text, and must not render as chat bubbles.
 */
export function stripCodexSystemMarkers(text: string): string {
  if (!text) return text
  return text.replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, '').trim()
}

type CodexListingMeta = {
  sessionId: string | null
  title: string
  lastMessage: string | null
  messageCount: number
  projectPath: string | null
  model: string
  gitBranch: string | null
  createdAt: number
}

function parseCodexCreatedTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return 0
  const [, y, m, d, hh, mm, ss] = match
  return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`) || 0
}

function parseCodexToolCall(payload: any): PendingImportedToolCall | null {
  const callId = typeof payload?.call_id === 'string' ? payload.call_id : null
  const toolName = typeof payload?.name === 'string' ? payload.name : null
  if (!callId || !toolName) return null

  const rawInput = typeof payload?.arguments === 'string'
    ? payload.arguments
    : typeof payload?.input === 'string'
      ? payload.input
      : ''
  const command = extractCommandFromToolCall(toolName, rawInput)
  const patchText = toolName === 'apply_patch'
    ? extractApplyPatchText(rawInput) ?? rawInput
    : toolName === 'shell'
      ? extractApplyPatchText(command)
      : null

  const fileChanges = patchText ? parseApplyPatchFileChanges(patchText) : undefined
  const normalizedName = fileChanges && fileChanges.length > 0 ? 'apply_patch' : toolName
  const commandEntry = !fileChanges && command.trim()
    ? {
      label: command.trim(),
      command: command.trim(),
      kind: classifyCommand(command.trim()),
    }
    : undefined

  return {
    id: callId,
    name: normalizedName,
    input: fileChanges && fileChanges.length > 0 ? patchText ?? rawInput : rawInput,
    status: payload?.status === 'errored' ? 'error' : 'done',
    fileChanges,
    commandEntry,
  }
}

function scanCodexListingLines(
  lines: string[],
  meta: {
    sessionId: string | null
    projectPath: string | null
    model: string
    gitBranch: string | null
    threadName: string | null
    firstUserPrompt: string | null
    lastAssistantText: string | null
    lastConversationText: string | null
    messageCount: number
    createdAt: number
  },
  options?: { countMessages?: boolean },
): void {
  for (const line of lines) {
    const evt = parseJsonObject(line)
    if (!evt) continue
    const payload = evt.payload

    if (evt.type === 'session_meta') {
      if (!meta.sessionId && typeof payload?.id === 'string' && payload.id.trim()) meta.sessionId = payload.id.trim()
      if (!meta.projectPath && typeof payload?.cwd === 'string' && payload.cwd.trim()) meta.projectPath = payload.cwd.trim()
      if (!meta.model && typeof payload?.model === 'string' && payload.model.trim()) meta.model = payload.model.trim()
      if (!meta.gitBranch && typeof payload?.git?.branch === 'string' && payload.git.branch.trim()) meta.gitBranch = payload.git.branch.trim()
      if (!meta.createdAt) {
        const createdAt = Date.parse(typeof payload?.timestamp === 'string' ? payload.timestamp : '')
        if (Number.isFinite(createdAt) && createdAt > 0) meta.createdAt = createdAt
      }
      continue
    }

    if (evt.type === 'turn_context') {
      if (!meta.projectPath && typeof payload?.cwd === 'string' && payload.cwd.trim()) meta.projectPath = payload.cwd.trim()
      if (!meta.model && typeof payload?.model === 'string' && payload.model.trim()) meta.model = payload.model.trim()
      continue
    }

    if (evt.type === 'event_msg') {
      if (!meta.threadName && payload?.type === 'thread_name_updated' && typeof payload?.thread_name === 'string' && payload.thread_name.trim()) {
        meta.threadName = truncate(payload.thread_name, 200)
      }
      if (!meta.firstUserPrompt && payload?.type === 'user_message' && typeof payload?.message === 'string') {
        const rawMessage = stripCodexSystemMarkers(payload.message)
        meta.firstUserPrompt = truncate(firstMeaningfulSessionTitleLine(rawMessage) ?? rawMessage, 400)
      }
      continue
    }

    if (evt.type !== 'response_item' || payload?.type !== 'message') continue
    const role = roleFromUnknown(payload?.role)
    if (!role || role === 'system') continue

    const rawText = stripCodexSystemMarkers(extractTextParts(payload.content))
    const titleText = firstMeaningfulSessionTitleLine(rawText) ?? rawText
    const text = truncate(titleText, 400)
    if (!text) continue

    if (options?.countMessages) meta.messageCount += 1
    if (role === 'user' && !meta.firstUserPrompt) meta.firstUserPrompt = text
    if (role === 'assistant') meta.lastAssistantText = text
    meta.lastConversationText = text
  }
}

async function readCodexListingMeta(
  filePath: string,
  stat: import('fs').Stats,
): Promise<CodexListingMeta> {
  const baseMeta = {
    sessionId: basename(filePath, '.jsonl'),
    projectPath: null as string | null,
    model: '',
    gitBranch: null as string | null,
    threadName: null as string | null,
    firstUserPrompt: null as string | null,
    lastAssistantText: null as string | null,
    lastConversationText: null as string | null,
    messageCount: 0,
    createdAt: parseCodexCreatedTimestamp(filePath),
  }

  if (stat.size <= CODEX_SESSION_EXACT_SCAN_MAX_BYTES) {
    const raw = await readTextSafe(filePath)
    scanCodexListingLines(parseJsonlLines(raw ?? ''), baseMeta, { countMessages: true })
  } else {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, CODEX_SESSION_LISTING_HEAD_BYTES),
      readTextTailSafe(filePath, CODEX_SESSION_LISTING_TAIL_BYTES),
    ])
    scanCodexListingLines(parseJsonlLines(headRaw ?? ''), baseMeta)
    scanCodexListingLines(parseJsonlLines(tailRaw ?? ''), baseMeta)
  }

  const title = sessionTitleFromText('Codex session', baseMeta.threadName ?? baseMeta.firstUserPrompt ?? baseMeta.lastAssistantText ?? baseMeta.lastConversationText)
  return {
    sessionId: baseMeta.sessionId,
    title,
    lastMessage: baseMeta.lastAssistantText ?? baseMeta.lastConversationText ?? baseMeta.firstUserPrompt,
    messageCount: baseMeta.messageCount,
    projectPath: baseMeta.projectPath,
    model: baseMeta.model,
    gitBranch: baseMeta.gitBranch,
    createdAt: baseMeta.createdAt,
  }
}

export async function listCodexSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.codex', 'sessions')
  if (!(await fileExists(root))) return []

  const withStat = await Promise.all((await listFilesRecursive(root, path => {
    const ext = extname(path).toLowerCase()
    return ext === '.jsonl' || ext === '.json'
  }, 4)).map(async filePath => ({
    filePath,
    stat: await statSafe(filePath),
  })))

  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 500)

  const entries = await Promise.all(recent.map(async ({ filePath, stat }) => {
    const ext = extname(filePath).toLowerCase()
    let listing: CodexListingMeta = {
      sessionId: basename(filePath, ext),
      title: 'Codex session',
      lastMessage: null,
      messageCount: 0,
      projectPath: null,
      model: '',
      gitBranch: null,
      createdAt: parseCodexCreatedTimestamp(filePath),
    }

    if (ext === '.jsonl') {
      listing = await readCodexListingMeta(filePath, stat!)
    } else {
      const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
      if (parsed && typeof parsed === 'object') {
        const messages = Array.isArray(parsed.items) ? parsed.items.filter(item => item?.type === 'message') : []
        const meaningfulMessages = messages
          .map(item => ({
            role: roleFromUnknown(item?.role),
            text: truncate(firstMeaningfulSessionTitleLine(stripCodexSystemMarkers(extractTextParts(item?.content))) ?? stripCodexSystemMarkers(extractTextParts(item?.content)), 400),
          }))
          .filter(item => item.role && item.role !== 'system' && item.text) as Array<{ role: ChatRole; text: string }>
        const firstUserPrompt = meaningfulMessages.find(item => item.role === 'user')?.text ?? null
        const lastAssistantText = [...meaningfulMessages].reverse().find(item => item.role === 'assistant')?.text ?? null
        const lastConversationText = meaningfulMessages[meaningfulMessages.length - 1]?.text ?? null
        const sessionId = typeof parsed.session?.id === 'string' && parsed.session.id.trim()
          ? parsed.session.id.trim()
          : basename(filePath, ext)
        const createdAt = Date.parse(typeof parsed.session?.timestamp === 'string' ? parsed.session.timestamp : '') || parseCodexCreatedTimestamp(filePath)
        const title = sessionTitleFromText('Codex session', firstUserPrompt ?? lastAssistantText ?? lastConversationText)
        listing = {
          sessionId,
          title,
          lastMessage: lastAssistantText ?? lastConversationText ?? firstUserPrompt,
          messageCount: meaningfulMessages.length,
          projectPath: null,
          model: typeof parsed.session?.model === 'string' ? parsed.session.model.trim() : '',
          gitBranch: typeof parsed.session?.git?.branch === 'string' ? parsed.session.git.branch.trim() : null,
          createdAt,
        }
      }
    }

    return {
      id: `codex:${filePath}`,
      source: 'codex' as const,
      scope: pathScope(workspacePath, listing.projectPath, 'user'),
      tileId: null,
      sessionId: listing.sessionId,
      provider: 'codex',
      model: listing.model,
      messageCount: listing.messageCount,
      lastMessage: listing.lastMessage,
      updatedAt: stat?.mtimeMs ?? listing.createdAt,
      sizeBytes: stat?.size ?? 0,
      filePath,
      title: listing.title,
      projectPath: listing.projectPath,
      sourceLabel: 'Codex',
      sourceDetail: listing.gitBranch ?? undefined,
      canOpenInChat: isExternalSessionImportableInChat(listing.messageCount, listing.lastMessage),
      canOpenInApp: true,
      resumeBin: 'codex',
      resumeArgs: listing.sessionId ? ['resume', listing.sessionId] : ['resume'],
    }
  }))

  return entries
}

export function parseCodexChatStateFromLines(lines: string[], entry: AggregatedSessionEntry, offset = 0): ImportedChatState {
  const messages: ImportedChatMessage[] = []
  const pendingToolCalls = new Map<string, PendingImportedToolCall>()
  let pendingThinking: string[] = []
  let pendingCalls: PendingImportedToolCall[] = []
  let model = entry.model
  let sessionId = entry.sessionId

  const flushAssistantArtifacts = (index: number, timestamp: number, content = '') => {
    const next = makeImportedRichMessage({
      // Assistant artifact flushes can happen immediately before a user
      // message at the same absolute line index, so they need their own id
      // namespace to keep React keys stable.
      id: `codex-assistant-${index}`,
      role: 'assistant',
      content,
      timestamp,
      thinking: pendingThinking.length > 0 ? { content: pendingThinking.join('\n\n'), done: true } : undefined,
      toolBlocks: buildImportedToolBlocks(pendingCalls),
    })
    if (next) messages.push(next)
    pendingThinking = []
    pendingCalls = []
    pendingToolCalls.clear()
  }

  let lastIndex = offset
  lines.forEach((line, index) => {
    const absoluteIndex = offset + index
    lastIndex = absoluteIndex
    try {
      const evt = JSON.parse(line)
      const timestamp = Date.parse(evt?.timestamp ?? '') || Date.now() + absoluteIndex
      const payload = evt?.payload

      if (!model && typeof payload?.model === 'string') model = payload.model
      // Only accept UUID-shaped ids as resumable session ids;
      // msg_… ids are message ids, not session ids.
      if (!sessionId && typeof payload?.id === 'string' && /^[0-9a-f-]{36}$/i.test(payload.id)) {
        sessionId = payload.id
      }

      if (evt?.type !== 'response_item') return

      if (payload?.type === 'reasoning') {
        const summary = extractReasoningSummary(payload)
        if (summary) pendingThinking.push(summary)
        return
      }

      if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
        const call = parseCodexToolCall(payload)
        if (!call) return
        pendingToolCalls.set(call.id, call)
        pendingCalls.push(call)
        return
      }

      if (payload?.type === 'function_call_output') {
        const callId = typeof payload?.call_id === 'string' ? payload.call_id : null
        if (!callId) return
        const existing = pendingToolCalls.get(callId)
        if (!existing) return
        existing.output = sanitizeToolOutputText(typeof payload?.output === 'string' ? payload.output : '')
        if (existing.commandEntry) existing.commandEntry.output = existing.output
        return
      }

      if (payload?.type !== 'message') return
      const role = roleFromUnknown(payload?.role)
      if (!role) return

      const content = stripCodexSystemMarkers(extractTextParts(payload.content))
      if (role === 'assistant') {
        flushAssistantArtifacts(absoluteIndex, timestamp, content)
        return
      }

      if (pendingThinking.length > 0 || pendingCalls.length > 0) {
        flushAssistantArtifacts(absoluteIndex, timestamp, '')
      }

      const message = makeImportedMessage(`codex-${absoluteIndex}`, role, content, timestamp)
      if (message) messages.push(message)
    } catch {
      // ignore malformed session lines
    }
  })

  if (pendingThinking.length > 0 || pendingCalls.length > 0) {
    flushAssistantArtifacts(lastIndex + 1, Date.now())
  }

  return {
    provider: 'codex',
    model,
    sessionId,
    messages,
  }
}

/**
 * Find the last plan-snapshot tool call from a pre-read set of JSONL lines.
 * When dealing with large files the caller passes only the tail sample lines so
 * the whole file is never scanned just to recover a plan chip.
 *
 * NOTE: a plan snapshot that lives earlier in the file (before the tail window)
 * will be missed on the fast path — this is an accepted tradeoff documented in
 * the backlog plan (Phase 2c). Full-file access falls back to the slow path.
 */
function findLatestCodexPlanSnapshotMessageFromLines(
  lines: string[],
): ImportedChatMessage | null {
  let latest: { lineNumber: number; timestamp: number; call: PendingImportedToolCall } | null = null

  lines.forEach((line, index) => {
    try {
      const evt = JSON.parse(line)
      const payload = evt?.payload
      if (evt?.type !== 'response_item') return
      if (payload?.type !== 'function_call' && payload?.type !== 'custom_tool_call') return
      if (!isImportedPlanToolName(typeof payload?.name === 'string' ? payload.name : null)) return
      const call = parseCodexToolCall(payload)
      if (!call) return
      const timestamp = Date.parse(evt?.timestamp ?? '') || Date.now() + index
      latest = { lineNumber: index, timestamp, call }
    } catch {
      // ignore malformed lines
    }
  })

  if (!latest) return null
  const planSnapshot = latest as { lineNumber: number; timestamp: number; call: PendingImportedToolCall }

  return makeImportedRichMessage({
    id: `codex-plan-${planSnapshot.lineNumber}`,
    role: 'assistant',
    content: '',
    timestamp: planSnapshot.timestamp,
    toolBlocks: buildImportedToolBlocks([planSnapshot.call]),
  })
}

export async function parseCodexChatState(
  filePath: string,
  entry: AggregatedSessionEntry,
  options?: { full?: boolean },
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) return null

  if (!options?.full && stat.size > LARGE_EXTERNAL_SESSION_BYTES) {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, EXTERNAL_SESSION_HEAD_SAMPLE_BYTES),
      readTextTailSafe(filePath, EXTERNAL_SESSION_TAIL_SAMPLE_BYTES),
    ])
    const headLines = parseJsonlLines(headRaw ?? '')
    const tailLines = parseJsonlLines(tailRaw ?? '')
    // Scan only the tail sample for the latest plan snapshot (tradeoff: a plan
    // that appears before the tail window will be missed — see BACKLOG_PLAN.md 2c).
    const recoveredPlanMessage = findLatestCodexPlanSnapshotMessageFromLines(tailLines)
    const firstChunk = parseCodexChatStateFromLines(headLines, entry, 0)
    const recentChunk = parseCodexChatStateFromLines(tailLines, entry, Math.max(10_000, tailLines.length))
    const firstMessage = firstChunk.messages.find(message => message.role === 'user') ?? firstChunk.messages[0] ?? null
    const messages = dedupeImportedMessages([
      ...(firstMessage ? [firstMessage] : []),
      makeTranscriptTruncationMessage('codex', stat.size),
      ...(recoveredPlanMessage ? [recoveredPlanMessage] : []),
      ...recentChunk.messages,
    ])
    return {
      provider: 'codex',
      model: recentChunk.model || firstChunk.model,
      sessionId: recentChunk.sessionId ?? firstChunk.sessionId,
      messages,
    }
  }

  const lines: string[] = []
  try {
    await scanJsonlFile(filePath, line => {
      lines.push(line)
    })
  } catch {
    return null
  }
  return parseCodexChatStateFromLines(lines, entry, 0)
}
