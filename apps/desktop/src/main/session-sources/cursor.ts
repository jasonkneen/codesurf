import { homedir } from 'os'
import { basename, join } from 'path'
import Database from 'better-sqlite3'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  fileExists,
  statSafe,
  listFilesRecursive,
} from './shared.ts'

function decodeCursorMeta(hex: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(hex.trim(), 'hex').toString('utf8'))
  } catch {
    return null
  }
}

export async function listCursorSessions(_workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.cursor', 'chats')
  if (!(await fileExists(root))) return []

  const dbFiles = await listFilesRecursive(root, path => basename(path) === 'store.db', 3)
  const withStat = await Promise.all(dbFiles.map(async filePath => ({ filePath, stat: await statSafe(filePath) })))
  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 60)

  return recent.map(({ filePath, stat }) => {
    let title = 'Cursor chat'
    let sessionId = basename(filePath)

    try {
      const db = new Database(filePath, { readonly: true })
      const row = db.prepare("select value from meta where key='0'").get() as { value?: string } | undefined
      const meta = row?.value ? decodeCursorMeta(row.value) : null
      if (typeof meta?.name === 'string' && meta.name.trim()) title = meta.name.trim()
      if (typeof meta?.agentId === 'string') sessionId = meta.agentId
      db.close()
    } catch {
      // ignore cursor db parse issues
    }

    return {
      id: `cursor:${filePath}`,
      source: 'cursor' as const,
      scope: 'user' as const,
      tileId: null,
      sessionId,
      provider: 'cursor',
      model: '',
      messageCount: 0,
      lastMessage: null,
      updatedAt: stat?.mtimeMs ?? 0,
      filePath,
      title,
      projectPath: null,
      sourceLabel: 'Cursor',
      sourceDetail: 'Local chat store',
      canOpenInChat: false,
      canOpenInApp: false,
    }
  })
}
