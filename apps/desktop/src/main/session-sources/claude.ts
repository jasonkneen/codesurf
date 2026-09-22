import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, extname, join } from 'path'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  type ChatRole,
  type ImportedChatMessage,
  type ImportedChatState,
  CLAUDE_SESSION_LISTING_HEAD_BYTES,
  CLAUDE_SESSION_LISTING_TAIL_BYTES,
  CLAUDE_SESSION_EXACT_SCAN_MAX_BYTES,
  EXTERNAL_SESSION_HEAD_SAMPLE_BYTES,
  EXTERNAL_SESSION_TAIL_SAMPLE_BYTES,
  LARGE_EXTERNAL_SESSION_BYTES,
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
  makeImportedMessage,
  makeTranscriptTruncationMessage,
  dedupeImportedMessages,
  parseJsonlLines,
  parseJsonObject,
  listFilesRecursive,
  isExternalSessionImportableInChat,
  roleFromUnknown,
} from './shared.ts'

function getClaudeProjectPathCandidate(evt: Record<string, any> | null): string | null {
  if (!evt) return null
  const candidate = typeof evt.cwd === 'string' ? evt.cwd
    : typeof evt.workingDirectory === 'string' ? evt.workingDirectory
    : typeof evt.projectPath === 'string' ? evt.projectPath
    : typeof evt.project?.path === 'string' ? evt.project.path
    : typeof evt.meta?.cwd === 'string' ? evt.meta.cwd
    : typeof evt.session?.cwd === 'string' ? evt.session.cwd
    : null
  return candidate && candidate.startsWith('/') ? candidate : null
}

function getClaudeRole(evt: Record<string, any> | null): ChatRole | null {
  if (!evt) return null
  return roleFromUnknown(evt.message?.role) ?? roleFromUnknown(evt.type) ?? roleFromUnknown(evt.role)
}

function extractClaudeContentText(
  content: unknown,
  options?: {
    includeThinking?: boolean
    includeToolResults?: boolean
  },
): string {
  if (!Array.isArray(content)) return extractTextParts(content)

  return content.map(part => {
    if (typeof part === 'string') return part
    const type = typeof part?.type === 'string' ? part.type : ''
    if (type === 'text') return typeof part.text === 'string' ? part.text : ''
    if (type === 'thinking') {
      if (!options?.includeThinking) return ''
      return typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : ''
    }
    if (type === 'tool_result') {
      return options?.includeToolResults ? extractTextParts(part.content) : ''
    }
    if (type === 'input_text') return typeof part.text === 'string' ? part.text : typeof part.input_text === 'string' ? part.input_text : ''
    if (type === 'output_text') return typeof part.text === 'string' ? part.text : typeof part.output_text === 'string' ? part.output_text : ''
    if (type === 'tool_use') return ''
    return extractTextParts(part)
  }).filter(Boolean).join('\n\n').trim()
}

function getClaudeEventText(
  evt: Record<string, any> | null,
  options?: {
    includeThinking?: boolean
    includeToolResults?: boolean
  },
): string {
  if (!evt) return ''
  return extractClaudeContentText(evt.message?.content ?? evt.content, options).trim()
}

function isClaudeToolResultOnly(evt: Record<string, any> | null): boolean {
  const content = evt?.message?.content
  return Array.isArray(content) && content.length > 0 && content.every(part => part?.type === 'tool_result')
}

function shouldImportClaudeEvent(evt: Record<string, any> | null): boolean {
  const role = getClaudeRole(evt)
  if (!role || role === 'system') return false
  if (role === 'user' && isClaudeToolResultOnly(evt)) return false
  return true
}

function getClaudeModel(evt: Record<string, any> | null): string {
  if (!evt) return ''
  const candidate = typeof evt.message?.model === 'string' ? evt.message.model
    : typeof evt.advisorModel === 'string' ? evt.advisorModel
    : typeof evt.model === 'string' ? evt.model
    : ''
  return candidate.trim()
}

function encodeClaudeProjectDirName(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/').replace(/\//g, '-')
}

type ClaudeListingMeta = {
  sessionId: string | null
  title: string
  lastMessage: string | null
  messageCount: number
  projectPath: string | null
  model: string
  gitBranch: string | null
}

function scanClaudeListingLines(
  lines: string[],
  meta: {
    sessionId: string | null
    projectPath: string | null
    model: string
    gitBranch: string | null
    firstUserPrompt: string | null
    lastPrompt: string | null
    lastAssistantText: string | null
    messageCount: number
  },
  options?: { countMessages?: boolean },
): void {
  for (const line of lines) {
    const evt = parseJsonObject(line)
    if (!evt) continue

    if (!meta.projectPath) meta.projectPath = getClaudeProjectPathCandidate(evt)
    if (!meta.sessionId && typeof evt.sessionId === 'string' && evt.sessionId.trim()) meta.sessionId = evt.sessionId.trim()
    if (!meta.model) meta.model = getClaudeModel(evt)
    if (!meta.gitBranch && typeof evt.gitBranch === 'string' && evt.gitBranch.trim()) meta.gitBranch = evt.gitBranch.trim()

    if (!meta.lastPrompt && evt.type === 'last-prompt' && typeof evt.lastPrompt === 'string' && evt.lastPrompt.trim()) {
      meta.lastPrompt = truncate(evt.lastPrompt, 400)
    }

    if (!shouldImportClaudeEvent(evt)) continue

    const role = getClaudeRole(evt)
    const rawText = getClaudeEventText(evt)
    const titleText = firstMeaningfulSessionTitleLine(rawText) ?? rawText
    const text = truncate(titleText, 400)
    if (!text) continue

    if (options?.countMessages) meta.messageCount += 1
    if (role === 'user' && !meta.firstUserPrompt) meta.firstUserPrompt = text
    if (role === 'assistant') meta.lastAssistantText = text
  }
}

async function readClaudeListingMeta(
  filePath: string,
  stat: import('fs').Stats,
  fallbackProjectPath?: string | null,
): Promise<ClaudeListingMeta> {
  const baseMeta = {
    sessionId: basename(filePath, '.jsonl'),
    projectPath: fallbackProjectPath ?? null,
    model: '',
    gitBranch: null as string | null,
    firstUserPrompt: null as string | null,
    lastPrompt: null as string | null,
    lastAssistantText: null as string | null,
    messageCount: 0,
  }

  if (stat.size <= CLAUDE_SESSION_EXACT_SCAN_MAX_BYTES) {
    const raw = await readTextSafe(filePath)
    scanClaudeListingLines(parseJsonlLines(raw ?? ''), baseMeta, { countMessages: true })
  } else {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, CLAUDE_SESSION_LISTING_HEAD_BYTES),
      readTextTailSafe(filePath, CLAUDE_SESSION_LISTING_TAIL_BYTES),
    ])
    scanClaudeListingLines(parseJsonlLines(headRaw ?? ''), baseMeta)
    scanClaudeListingLines(parseJsonlLines(tailRaw ?? ''), baseMeta)
  }

  const title = sessionTitleFromText('Claude session', baseMeta.lastPrompt ?? baseMeta.firstUserPrompt ?? baseMeta.lastAssistantText)
  return {
    sessionId: baseMeta.sessionId,
    title,
    lastMessage: baseMeta.lastAssistantText ?? baseMeta.lastPrompt ?? baseMeta.firstUserPrompt,
    messageCount: baseMeta.messageCount,
    projectPath: baseMeta.projectPath,
    model: baseMeta.model,
    gitBranch: baseMeta.gitBranch,
  }
}

export function parseClaudeLine(line: string, index: number): ImportedChatMessage | null {
  try {
    const evt = JSON.parse(line)
    if (!shouldImportClaudeEvent(evt)) return null
    const role = getClaudeRole(evt)
    if (!role) return null
    const text = getClaudeEventText(evt)
    if (!text) return null
    return makeImportedMessage(
      `claude-${index}`,
      role,
      text,
      Date.parse(evt?.timestamp ?? '') || Date.now() + index,
    )
  } catch {
    return null
  }
}

export function parseClaudeMessagesFromLines(lines: string[], offset = 0): ImportedChatMessage[] {
  return lines
    .map((line, index) => parseClaudeLine(line, offset + index))
    .filter(Boolean) as ImportedChatMessage[]
}

export async function listClaudeSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const projectRoot = join(homedir(), '.claude', 'projects')
  const transcriptRoot = join(homedir(), '.claude', 'transcripts')
  const candidateFiles = new Map<string, string | null>()

  if (workspacePath) {
    const exactProjectDir = join(projectRoot, encodeClaudeProjectDirName(workspacePath))
    if (await fileExists(exactProjectDir)) {
      try {
        const names = await fs.readdir(exactProjectDir)
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue
          candidateFiles.set(join(exactProjectDir, name), workspacePath)
        }
      } catch {
        // ignore unreadable Claude project dir
      }
    }
  }

  if (candidateFiles.size === 0 && await fileExists(projectRoot)) {
    const files = await listFilesRecursive(projectRoot, path => extname(path).toLowerCase() === '.jsonl', 2)
    for (const filePath of files) candidateFiles.set(filePath, null)
  }

  if (await fileExists(transcriptRoot)) {
    try {
      const names = await fs.readdir(transcriptRoot)
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const filePath = join(transcriptRoot, name)
        if (!candidateFiles.has(filePath)) candidateFiles.set(filePath, null)
      }
    } catch {
      // ignore unreadable transcript dir
    }
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
    const listing = await readClaudeListingMeta(filePath, stat!, projectPathHint)

    return {
      id: `claude:${filePath}`,
      source: 'claude' as const,
      scope: pathScope(workspacePath, listing.projectPath, 'user'),
      tileId: null,
      sessionId: listing.sessionId,
      provider: 'claude',
      model: listing.model,
      messageCount: listing.messageCount,
      lastMessage: listing.lastMessage,
      updatedAt: stat?.mtimeMs ?? 0,
      sizeBytes: stat?.size ?? 0,
      filePath,
      title: listing.title,
      projectPath: listing.projectPath,
      sourceLabel: 'Claude',
      sourceDetail: listing.gitBranch ?? undefined,
      canOpenInChat: isExternalSessionImportableInChat(listing.messageCount, listing.lastMessage),
      canOpenInApp: true,
      resumeBin: 'claude',
      resumeArgs: listing.sessionId ? ['--resume', listing.sessionId] : ['--resume'],
    }
  }))

  return entries
}

export async function parseClaudeChatState(
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

    const headMessages = parseClaudeMessagesFromLines(parseJsonlLines(headRaw ?? ''), 0)
    const tailLines = parseJsonlLines(tailRaw ?? '')
    // Tail sample uses a disjoint id namespace so React keys don't collide with the head sample.
    // Head uses offsets 0..N; tail uses offsets 100_000_000..100_000_000+N.
    const tailMessages = parseClaudeMessagesFromLines(tailLines, 100_000_000)
    const firstMessage = headMessages.find(message => message.role !== 'system') ?? headMessages[0] ?? null
    const messages = dedupeImportedMessages([
      ...(firstMessage ? [firstMessage] : []),
      makeTranscriptTruncationMessage('claude', stat.size),
      ...tailMessages,
    ])

    return {
      provider: 'claude',
      model: entry.model,
      sessionId: entry.sessionId,
      messages,
    }
  }

  const messages: ImportedChatMessage[] = []

  try {
    await scanJsonlFile(filePath, (line, lineNumber) => {
      const message = parseClaudeLine(line, lineNumber - 1)
      if (message) messages.push(message)
    })
  } catch {
    return null
  }

  return {
    provider: 'claude',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}
