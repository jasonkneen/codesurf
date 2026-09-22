import { homedir } from 'os'
import { basename, extname, join } from 'path'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  type ImportedChatMessage,
  type ImportedChatState,
  MAX_SESSION_LISTING_JSON_BYTES,
  fileExists,
  readJsonSafe,
  truncate,
  sessionTitleFromText,
  pathScope,
  extractTextParts,
  makeImportedMessage,
  isExternalSessionImportableInChat,
  roleFromUnknown,
  listFilesRecursive,
} from './shared.ts'

function parseOpenCodeTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/)
  if (!match) return 0
  const [, date, hh, mm, ss, ms] = match
  return Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`) || 0
}

export async function listOpenCodeSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.opencode', 'conversations')
  if (!(await fileExists(root))) return []

  const files = await listFilesRecursive(root, path => extname(path).toLowerCase() === '.json', 3)
  const recent = files
    .map(filePath => ({ filePath, ts: parseOpenCodeTimestamp(filePath) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 500)

  const entries = await Promise.all(recent.map(async ({ filePath, ts }) => {
    const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
    const projectPath = typeof parsed?.projectPath === 'string' ? parsed.projectPath : null
    const meaningfulMessages = Array.isArray(parsed?.messages)
      ? parsed.messages.filter((m: { content?: string; role?: string }) => typeof m?.content === 'string' && m.role !== 'system' && m.content.trim())
      : []
    const lastMessage = truncate(meaningfulMessages.slice(-1)[0]?.content)
    const sessionId = typeof parsed?.id === 'string' ? parsed.id : basename(filePath, '.json')

    return {
      id: `opencode:${filePath}`,
      source: 'opencode' as const,
      scope: pathScope(workspacePath, projectPath, 'user'),
      tileId: null,
      sessionId,
      provider: 'opencode',
      model: typeof parsed?.model === 'string' ? parsed.model : '',
      messageCount: meaningfulMessages.length,
      lastMessage,
      updatedAt: ts || Date.parse(parsed?.startTime ?? '') || 0,
      filePath,
      title: sessionTitleFromText('OpenCode session', lastMessage),
      projectPath,
      sourceLabel: 'OpenCode',
      sourceDetail: typeof parsed?.model === 'string' ? parsed.model : 'Conversation',
      canOpenInChat: isExternalSessionImportableInChat(meaningfulMessages.length, lastMessage),
      canOpenInApp: true,
      resumeBin: 'opencode',
      resumeArgs: sessionId ? ['--session', sessionId] : [],
    }
  }))

  return entries
}

export async function parseOpenCodeChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const parsed = await readJsonSafe(filePath)
  if (!parsed || !Array.isArray(parsed.messages)) return null
  const messages = parsed.messages
    .map((message: any, index: number) => {
      const role = roleFromUnknown(message?.role)
      if (!role) return null
      return makeImportedMessage(`opencode-${index}`, role, extractTextParts(message?.content), Number(message?.timestamp) || Date.now() + index)
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'opencode',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}
