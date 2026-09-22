import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AggregatedSessionEntry } from '../../shared/session-types.ts'
import {
  type ImportedChatMessage,
  type ImportedChatState,
  fileExists,
  readJsonSafe,
  readTextSafe,
  pathScope,
  extractTextParts,
  makeImportedMessage,
  compareSessions,
  humanizeSlug,
  roleFromUnknown,
} from './shared.ts'

const GENERIC_OPENCLAW_LABELS = new Set(['openclaw studio', 'openclawstudio', 'openclaw-tui', 'vibeclaw', 'heartbeat'])

function isGenericOpenClawLabel(value: string | null | undefined): boolean {
  if (!value) return true
  return GENERIC_OPENCLAW_LABELS.has(value.trim().toLowerCase())
}

function parseOpenClawKey(sessionKey: string): { agentId: string; route: string; groupId: string; isSubagent: boolean } {
  const parts = sessionKey.split(':')
  const agentId = parts[1] || 'main'
  const route = parts[2] || 'main'
  return {
    agentId,
    route,
    groupId: `openclaw:${agentId}`,
    isSubagent: route === 'subagent',
  }
}

function formatOpenClawTitle(agentId: string, sessionKey: string, meta: any): { title: string; detail: string; relatedGroupId: string; nestingLevel: number } {
  const parsed = parseOpenClawKey(sessionKey)
  const agentLabel = humanizeSlug(agentId)
  const preferred = typeof meta?.label === 'string' && meta.label.trim()
    ? meta.label.trim()
    : typeof meta?.origin?.label === 'string' && meta.origin.label.trim()
      ? meta.origin.label.trim()
      : ''

  let title = preferred
  if (isGenericOpenClawLabel(title)) {
    if (parsed.isSubagent) title = `Subagent ${meta?.sessionId ? String(meta.sessionId).slice(0, 8) : ''}`.trim()
    else if (parsed.route === 'cron') title = 'Scheduled task'
    else if (parsed.route === 'webchat') title = 'Web chat'
    else if (parsed.route === 'main') title = `${agentLabel} chat`
    else title = humanizeSlug(parsed.route)
  }

  const detailParts = ['OpenClaw', agentLabel]
  if (parsed.route !== 'main' && parsed.route !== 'subagent') detailParts.push(humanizeSlug(parsed.route))
  if (parsed.isSubagent) detailParts.push('Subagent')

  return {
    title,
    detail: detailParts.join(' · '),
    relatedGroupId: parsed.groupId,
    nestingLevel: parsed.isSubagent ? 1 : 0,
  }
}

export async function listOpenClawSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.openclaw', 'agents')
  if (!(await fileExists(root))) return []

  let agentDirs: Array<import('fs').Dirent> = []
  try {
    agentDirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: AggregatedSessionEntry[] = []

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue
    const agentId = dirent.name
    const sessionsIndexPath = join(root, agentId, 'sessions', 'sessions.json')
    const parsed = await readJsonSafe(sessionsIndexPath)
    if (!parsed || typeof parsed !== 'object') continue

    for (const [key, value] of Object.entries(parsed)) {
      const meta = value as any
      if (typeof meta?.deletedAt === 'number') continue
      const updatedAt = typeof meta?.updatedAt === 'number' ? meta.updatedAt : 0
      const sessionFile = typeof meta?.sessionFile === 'string' ? meta.sessionFile : undefined
      const label = formatOpenClawTitle(agentId, key, meta)
      const projectPath = typeof meta?.cwd === 'string' && meta.cwd.startsWith('/') ? meta.cwd
        : typeof meta?.projectPath === 'string' && meta.projectPath.startsWith('/') ? meta.projectPath
        : typeof meta?.workingDirectory === 'string' && meta.workingDirectory.startsWith('/') ? meta.workingDirectory
        : null
      entries.push({
        id: `openclaw:${agentId}:${key}`,
        source: 'openclaw',
        scope: pathScope(workspacePath, projectPath, 'user'),
        tileId: null,
        sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : null,
        provider: 'openclaw',
        model: agentId,
        messageCount: 0,
        lastMessage: null,
        updatedAt,
        filePath: sessionFile,
        title: label.title,
        projectPath,
        sourceLabel: 'OpenClaw',
        sourceDetail: label.detail,
        canOpenInChat: Boolean(sessionFile),
        canOpenInApp: true,
        resumeBin: 'openclaw',
        resumeArgs: ['tui', '--session', key],
        relatedGroupId: label.relatedGroupId,
        nestingLevel: label.nestingLevel,
      })
    }
  }

  return entries.sort(compareSessions).slice(0, 500)
}

export async function parseOpenClawChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const raw = await readTextSafe(filePath)
  if (!raw) return null
  const messages = raw.split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const evt = JSON.parse(line)
        if (evt?.type !== 'message') return null
        const role = roleFromUnknown(evt?.message?.role)
        if (!role) return null
        return makeImportedMessage(`openclaw-${index}`, role, extractTextParts(evt?.message?.content), Date.parse(evt?.timestamp ?? '') || Number(evt?.message?.timestamp) || Date.now() + index)
      } catch {
        return null
      }
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'openclaw',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}
