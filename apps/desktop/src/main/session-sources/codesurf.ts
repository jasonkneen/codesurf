import { basename, extname, join } from 'path'
import type { AggregatedSessionEntry, SessionScope } from '../../shared/session-types.ts'
import {
  type ImportedChatMessage,
  type ImportedChatState,
  MAX_SESSION_LISTING_JSON_BYTES,
  fileExists,
  readJsonSafe,
  readTextSafe,
  readTextPreviewSafe,
  statSafe,
  truncate,
  sessionTitleFromText,
  extractTextParts,
  makeImportedRichMessage,
  roleFromUnknown,
  listFilesRecursive,
  getProjectCodeSurfDir,
} from './shared.ts'
import { CODESURF_HOME } from '../paths.ts'

export async function listCodeSurfSessionFiles(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const roots: Array<{ dir: string; scope: SessionScope }> = []
  if (workspacePath) roots.push({ dir: join(getProjectCodeSurfDir(workspacePath), 'sessions'), scope: 'project' })
  roots.push({ dir: join(CODESURF_HOME, 'sessions'), scope: 'user' })

  const entries: AggregatedSessionEntry[] = []

  for (const root of roots) {
    if (!(await fileExists(root.dir))) continue
    const files = await listFilesRecursive(root.dir, path => ['.json', '.jsonl', '.md', '.txt'].includes(extname(path).toLowerCase()), 3)

    for (const filePath of files) {
      const stat = await statSafe(filePath)
      if (!stat?.isFile()) continue

      let title = basename(filePath)
      let lastMessage: string | null = null
      let messageCount = 0
      let sessionId: string | null = basename(filePath, extname(filePath))
      let provider = 'codesurf'
      let model = ''
      const ext = extname(filePath).toLowerCase()

      if (ext === '.json') {
        const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.messages)) {
            messageCount = parsed.messages.length
            const last = parsed.messages[parsed.messages.length - 1]
            lastMessage = truncate(typeof last?.content === 'string' ? last.content : extractTextParts(last?.content))
            title = sessionTitleFromText(title, lastMessage)
          } else if (Array.isArray(parsed.entries)) {
            messageCount = parsed.entries.length
          }
          if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId
          if (typeof parsed.provider === 'string') provider = parsed.provider
          if (typeof parsed.model === 'string') model = parsed.model
          if (typeof parsed.title === 'string' && parsed.title.trim()) title = parsed.title.trim()
        }
      } else if (ext === '.md' || ext === '.txt') {
        const raw = await readTextPreviewSafe(filePath)
        lastMessage = truncate(raw)
        title = sessionTitleFromText(title, raw)
      }

      entries.push({
        id: `codesurf-file:${filePath}`,
        source: 'codesurf',
        scope: root.scope,
        tileId: null,
        sessionId,
        provider,
        model,
        messageCount,
        lastMessage,
        updatedAt: stat.mtimeMs,
        filePath,
        title,
        projectPath: root.scope === 'project' ? workspacePath : null,
        sourceLabel: 'CodeSurf',
        sourceDetail: root.scope === 'project' ? 'Project session' : 'User session',
        canOpenInChat: true,
        canOpenInApp: false,
      })
    }
  }

  return entries
}

export async function parseCodeSurfChatState(filePath: string): Promise<ImportedChatState | null> {
  const parsed = await readJsonSafe(filePath)
  if (parsed && Array.isArray(parsed.messages)) {
    const messages = parsed.messages
      .map((message: any, index: number) => {
        const role = roleFromUnknown(message?.role) ?? 'assistant'
        return makeImportedRichMessage({
          id: `codesurf-${index}`,
          role,
          content: typeof message?.content === 'string' ? message.content : extractTextParts(message?.content),
          timestamp: Number(message?.timestamp) || Date.now() + index,
          thinking: typeof message?.thinking?.content === 'string'
            ? { content: message.thinking.content, done: message.thinking.done !== false }
            : undefined,
          toolBlocks: Array.isArray(message?.toolBlocks) ? message.toolBlocks : undefined,
        })
      })
      .filter(Boolean) as ImportedChatMessage[]

    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'claude',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      messages,
    }
  }

  const raw = await readTextSafe(filePath)
  if (!raw) return null
  return {
    provider: 'claude',
    model: '',
    sessionId: null,
    messages: [
      {
        id: 'codesurf-import-0',
        role: 'system',
        content: raw,
        timestamp: Date.now(),
      },
    ],
  }
}
