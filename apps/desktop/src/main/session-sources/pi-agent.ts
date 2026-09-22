import { homedir } from 'os'
import { basename, extname, join } from 'path'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  type ImportedChatMessage,
  type ImportedChatState,
  CODEX_SESSION_LISTING_HEAD_BYTES,
  CODEX_SESSION_LISTING_TAIL_BYTES,
  CODEX_SESSION_EXACT_SCAN_MAX_BYTES,
  fileExists,
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
  makeImportedRichMessage,
  parseJsonlLines,
  parseJsonObject,
  listFilesRecursive,
  isExternalSessionImportableInChat,
  roleFromUnknown,
} from './shared.ts'
import { CODESURF_HOME } from '../paths.ts'

const CODESURF_AGENT_SESSION_DIR = join(CODESURF_HOME, 'agent-sessions')

type PiListingMeta = {
  sessionId: string | null
  title: string
  lastMessage: string | null
  messageCount: number
  projectPath: string | null
  model: string
  provider: string
  createdAt: number
}

function encodePiProjectDirName(workspacePath: string): string {
  return `-${workspacePath.replace(/[\\/]+/g, '-')}-`
}

function parsePiCreatedTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/)
  if (!match) return 0
  return Date.parse(match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')) || 0
}

function stripCodeSurfPiPromptPrefix(text: string): string {
  const marker = '\n\n---\n\n'
  const index = text.indexOf(marker)
  if (index === -1) return text
  const prefix = text.slice(0, index)
  return prefix.includes('## CodeSurf Task-Completion Convention') || prefix.includes('## CodeSurf Insight Convention')
    ? text.slice(index + marker.length).trim()
    : text
}

function scanPiListingLines(lines: string[], meta: {
  sessionId: string | null
  projectPath: string | null
  model: string
  provider: string
  firstUserPrompt: string | null
  lastAssistantText: string | null
  lastConversationText: string | null
  messageCount: number
  createdAt: number
}): void {
  for (const line of lines) {
    const evt = parseJsonObject(line)
    if (!evt) continue

    if (evt.type === 'session') {
      if (!meta.sessionId && typeof evt.id === 'string' && evt.id.trim()) meta.sessionId = evt.id.trim()
      if (!meta.projectPath && typeof evt.cwd === 'string' && evt.cwd.startsWith('/')) meta.projectPath = evt.cwd
      if (!meta.createdAt) {
        const createdAt = Date.parse(typeof evt.timestamp === 'string' ? evt.timestamp : '')
        if (Number.isFinite(createdAt) && createdAt > 0) meta.createdAt = createdAt
      }
      continue
    }

    if (evt.type === 'model_change') {
      if (typeof evt.provider === 'string' && evt.provider.trim()) meta.provider = evt.provider.trim()
      if (typeof evt.modelId === 'string' && evt.modelId.trim()) meta.model = evt.modelId.trim()
      continue
    }

    if (evt.type !== 'message') continue
    const role = roleFromUnknown(evt.message?.role)
    if (!role || role === 'system') continue
    const rawText = stripCodeSurfPiPromptPrefix(extractTextParts(evt.message?.content))
    const text = truncate(firstMeaningfulSessionTitleLine(rawText) ?? rawText, 400)
    if (!text) continue
    meta.messageCount += 1
    if (role === 'user' && !meta.firstUserPrompt) meta.firstUserPrompt = text
    if (role === 'assistant') meta.lastAssistantText = text
    meta.lastConversationText = text
  }
}

async function readPiListingMeta(filePath: string): Promise<PiListingMeta> {
  const baseMeta = {
    sessionId: basename(filePath, '.jsonl'),
    projectPath: null as string | null,
    model: '',
    provider: 'csagent',
    firstUserPrompt: null as string | null,
    lastAssistantText: null as string | null,
    lastConversationText: null as string | null,
    messageCount: 0,
    createdAt: parsePiCreatedTimestamp(filePath),
  }

  const stat = await statSafe(filePath)
  if (stat?.isFile() && stat.size <= CODEX_SESSION_EXACT_SCAN_MAX_BYTES) {
    const raw = await readTextSafe(filePath)
    scanPiListingLines(parseJsonlLines(raw ?? ''), baseMeta)
  } else {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, CODEX_SESSION_LISTING_HEAD_BYTES),
      readTextTailSafe(filePath, CODEX_SESSION_LISTING_TAIL_BYTES),
    ])
    scanPiListingLines(parseJsonlLines(headRaw ?? ''), baseMeta)
    scanPiListingLines(parseJsonlLines(tailRaw ?? ''), baseMeta)
  }

  return {
    sessionId: baseMeta.sessionId,
    title: sessionTitleFromText('Pi Agent session', baseMeta.firstUserPrompt ?? baseMeta.lastAssistantText ?? baseMeta.lastConversationText),
    lastMessage: baseMeta.lastAssistantText ?? baseMeta.lastConversationText ?? baseMeta.firstUserPrompt,
    messageCount: baseMeta.messageCount,
    projectPath: baseMeta.projectPath,
    model: baseMeta.model,
    provider: baseMeta.provider,
    createdAt: baseMeta.createdAt,
  }
}

export async function listPiAgentSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const candidateFiles = new Map<string, string | null>()

  if (await fileExists(CODESURF_AGENT_SESSION_DIR)) {
    const files = await listFilesRecursive(CODESURF_AGENT_SESSION_DIR, path => extname(path).toLowerCase() === '.jsonl', 1)
    for (const filePath of files) candidateFiles.set(filePath, null)
  }

  const piSessionsRoot = join(homedir(), '.pi', 'agent', 'sessions')
  if (workspacePath) {
    const exactProjectDir = join(piSessionsRoot, encodePiProjectDirName(workspacePath))
    if (await fileExists(exactProjectDir)) {
      const files = await listFilesRecursive(exactProjectDir, path => extname(path).toLowerCase() === '.jsonl', 1)
      for (const filePath of files) candidateFiles.set(filePath, workspacePath)
    }
  }
  if (await fileExists(piSessionsRoot)) {
    const files = await listFilesRecursive(piSessionsRoot, path => extname(path).toLowerCase() === '.jsonl', 2)
    for (const filePath of files) if (!candidateFiles.has(filePath)) candidateFiles.set(filePath, null)
  }

  const withStat = await Promise.all(
    [...candidateFiles.entries()].map(async ([filePath, projectPathHint]) => ({
      filePath,
      projectPathHint,
      stat: await statSafe(filePath),
    })),
  )
  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 500)

  const entries = await Promise.all(recent.map(async ({ filePath, projectPathHint, stat }) => {
    const listing = await readPiListingMeta(filePath)
    const projectPath = listing.projectPath ?? projectPathHint
    return {
      id: `csagent:${filePath}`,
      source: 'csagent' as const,
      scope: pathScope(workspacePath, projectPath, 'user'),
      tileId: null,
      sessionId: listing.sessionId,
      provider: 'csagent',
      model: listing.model,
      messageCount: listing.messageCount,
      lastMessage: listing.lastMessage,
      updatedAt: stat?.mtimeMs ?? listing.createdAt,
      sizeBytes: stat?.size ?? 0,
      filePath,
      title: listing.title,
      projectPath,
      sourceLabel: 'Pi Agent',
      sourceDetail: listing.model || listing.provider,
      canOpenInChat: isExternalSessionImportableInChat(listing.messageCount, listing.lastMessage),
      canOpenInApp: false,
      resumeBin: 'pi',
      resumeArgs: listing.sessionId ? ['--resume', listing.sessionId] : [],
    }
  }))

  return entries
}

export async function parsePiAgentChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const messages: ImportedChatMessage[] = []
  let model = entry.model
  let provider = 'csagent'
  let sessionId = entry.sessionId

  try {
    await scanJsonlFile(filePath, (line, lineNumber) => {
      const evt = parseJsonObject(line)
      if (!evt) return
      const timestamp = Date.parse(typeof evt.timestamp === 'string' ? evt.timestamp : '')
        || Number(evt.message?.timestamp)
        || Date.now() + lineNumber

      if (evt.type === 'session') {
        if (!sessionId && typeof evt.id === 'string' && evt.id.trim()) sessionId = evt.id.trim()
        return
      }
      if (evt.type === 'model_change') {
        if (typeof evt.provider === 'string' && evt.provider.trim()) provider = evt.provider.trim()
        if (typeof evt.modelId === 'string' && evt.modelId.trim()) model = evt.modelId.trim()
        return
      }
      if (evt.type !== 'message') return

      const role = roleFromUnknown(evt.message?.role)
      if (!role) return

      const content = Array.isArray(evt.message?.content) ? evt.message.content : []
      const thinking = content
        .filter((part: { type?: string; thinking?: string }) => part?.type === 'thinking' && typeof part.thinking === 'string')
        .map((part: { thinking?: string }) => part.thinking)
        .filter(Boolean)
        .join('\n\n')
      const text = role === 'user'
        ? stripCodeSurfPiPromptPrefix(extractTextParts(evt.message?.content))
        : extractTextParts(evt.message?.content)
      const message = makeImportedRichMessage({
        id: `csagent-${lineNumber}`,
        role,
        content: text,
        timestamp,
        thinking: thinking ? { content: thinking, done: true } : undefined,
      })
      if (message) messages.push(message)
    })
  } catch {
    return null
  }

  return {
    provider: 'csagent',
    model: model || provider,
    sessionId,
    messages,
  }
}
