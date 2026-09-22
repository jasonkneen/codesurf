import { homedir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  type ImportedChatMessage,
  type ImportedChatState,
  statSafe,
  truncate,
  epochMsFromUnknown,
  sessionTitleFromText,
  pathScope,
  extractProjectPathFromSessionText,
  isExternalSessionImportableInChat,
  makeImportedRichMessage,
  roleFromUnknown,
} from './shared.ts'

type HermesSessionRow = {
  id: string
  source: string | null
  model: string | null
  billing_provider: string | null
  title: string | null
  system_prompt: string | null
  started_at: number | null
  message_count: number | null
  first_user: string | null
  last_message: string | null
  last_active: number | null
}

type HermesMessageRow = {
  id: number
  role: string | null
  content: string | null
  timestamp: number | null
  reasoning: string | null
  reasoning_content: string | null
}

export async function listHermesSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const dbPath = join(homedir(), '.hermes', 'state.db')
  const stat = await statSafe(dbPath)
  if (!stat?.isFile()) return []

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.prepare(`
      SELECT
        s.id,
        s.source,
        s.model,
        s.billing_provider,
        s.title,
        s.system_prompt,
        s.started_at,
        s.message_count,
        (
          SELECT m.content
          FROM messages m
          WHERE m.session_id = s.id
            AND m.role = 'user'
            AND m.content IS NOT NULL
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ) AS first_user,
        (
          SELECT m.content
          FROM messages m
          WHERE m.session_id = s.id
            AND m.role IN ('user', 'assistant')
            AND m.content IS NOT NULL
          ORDER BY m.timestamp DESC, m.id DESC
          LIMIT 1
        ) AS last_message,
        COALESCE(
          (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id),
          s.started_at
        ) AS last_active
      FROM sessions s
      WHERE s.parent_session_id IS NULL
      ORDER BY last_active DESC
      LIMIT 500
    `).all() as HermesSessionRow[]

    return rows.map(row => {
      const sessionId = String(row.id ?? '').trim()
      const firstUser = typeof row.first_user === 'string' ? row.first_user : null
      const systemPrompt = typeof row.system_prompt === 'string' ? row.system_prompt : null
      const projectPath = extractProjectPathFromSessionText(firstUser) ?? extractProjectPathFromSessionText(systemPrompt)
      const titleFromUser = sessionTitleFromText('', firstUser)
      const dbTitle = String(row.title ?? '').trim()
      const title = titleFromUser || dbTitle || 'Hermes session'
      const detailSource = String(row.source ?? '').trim()
      const billingProvider = String(row.billing_provider ?? '').trim()
      const sourceDetail = detailSource && billingProvider && detailSource.toLowerCase() !== billingProvider.toLowerCase()
        ? `${detailSource} via ${billingProvider}`
        : detailSource || 'cli'

      return {
        id: `hermes:${sessionId}`,
        source: 'hermes' as const,
        scope: pathScope(workspacePath, projectPath, 'user'),
        tileId: null,
        sessionId,
        provider: 'hermes',
        model: String(row.model ?? '').trim(),
        messageCount: Number(row.message_count) || 0,
        lastMessage: truncate(row.last_message, 400),
        updatedAt: epochMsFromUnknown(row.last_active ?? row.started_at),
        filePath: dbPath,
        title,
        projectPath,
        sourceLabel: 'Hermes',
        sourceDetail,
        canOpenInChat: isExternalSessionImportableInChat(row.message_count, row.last_message),
        canOpenInApp: true,
        resumeBin: 'hermes',
        resumeArgs: sessionId ? ['--resume', sessionId] : [],
      }
    }).filter(entry => entry.sessionId)
  } catch {
    return []
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

export async function parseHermesChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const sessionId = String(entry.sessionId ?? '').trim()
  if (!sessionId) return null

  let db: Database.Database | null = null
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true })
    const session = db.prepare('SELECT model FROM sessions WHERE id = ?').get(sessionId) as { model?: string | null } | undefined
    const rows = db.prepare(`
      SELECT id, role, content, timestamp, reasoning, reasoning_content
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp, id
    `).all(sessionId) as HermesMessageRow[]

    const messages = rows
      .map((row, index) => {
        const role = roleFromUnknown(row.role)
        if (!role) return null
        const thinkingContent = role === 'assistant'
          ? String(row.reasoning_content ?? row.reasoning ?? '').trim()
          : ''
        return makeImportedRichMessage({
          id: `hermes-${sessionId}-${row.id ?? index}`,
          role,
          content: typeof row.content === 'string' ? row.content : '',
          timestamp: epochMsFromUnknown(row.timestamp) || Date.now() + index,
          thinking: thinkingContent ? { content: thinkingContent, done: true } : undefined,
        })
      })
      .filter(Boolean) as ImportedChatMessage[]

    return {
      provider: 'hermes',
      model: String(session?.model ?? entry.model ?? '').trim(),
      sessionId,
      messages,
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}
