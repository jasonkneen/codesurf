import type { ProjectListEntry, SessionEntry } from './types'
import { normalizeSidebarPath, sidebarPathBelongsToProject } from './path-utils.ts'

export interface ActiveSessionMatchState {
  activeChatTileId?: string | null
  activeChatSessionId?: string | null
  activeChatSessionEntryId?: string | null
}

export function isSessionActive(session: SessionEntry, activeState: ActiveSessionMatchState): boolean {
  const {
    activeChatTileId = null,
    activeChatSessionId = null,
    activeChatSessionEntryId = null,
  } = activeState
  const hasSpecificActiveSession = Boolean(activeChatSessionEntryId)
  if (hasSpecificActiveSession) return session.id === activeChatSessionEntryId
  if (activeChatSessionId) return session.sessionId === activeChatSessionId
  return Boolean(activeChatTileId) && session.tileId === activeChatTileId
}

export function applySessionPromotions<T extends SessionEntry>(sessions: T[], _promotedAtById: Record<string, number>): T[] {
  // Promotion is a sort hint only — it must not mutate `updatedAt`, which
  // drives the sidebar's relative-time label. `compareSessionsWithSelectionPriority`
  // already uses `promotedAtById` as the primary sort key, so we just pass
  // sessions through unchanged and let the comparator handle ordering.
  return sessions
}

export function compareSessionsWithSelectionPriority(
  a: SessionEntry,
  b: SessionEntry,
  sortMode: 'updated' | 'title',
  promotedAtById: Record<string, number>,
): number {
  const promotedA = Number.isFinite(promotedAtById[a.id]) ? promotedAtById[a.id]! : 0
  const promotedB = Number.isFinite(promotedAtById[b.id]) ? promotedAtById[b.id]! : 0
  if (promotedA !== promotedB) return promotedB - promotedA

  if (sortMode === 'title') {
    const titleCompare = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    if (titleCompare !== 0) return titleCompare
    return b.updatedAt - a.updatedAt
  }

  return b.updatedAt - a.updatedAt
}

export function sortProjectEntriesByRecentSession(
  projectEntries: ProjectListEntry[],
  sessions: SessionEntry[],
  getProjectLabel: (project: ProjectListEntry) => string,
  promotedAtById: Record<string, number> = {},
): ProjectListEntry[] {
  if (projectEntries.length <= 1) return projectEntries

  const latestByProjectId = new Map<string, number>()
  for (const projectEntry of projectEntries) {
    const projectPath = normalizeSidebarPath(projectEntry.path)
    const workspaceIdSet = new Set(projectEntry.workspaceIds)
    let latest = 0
    for (const session of sessions) {
      const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
      const belongs = sessionProjectPath
        ? sidebarPathBelongsToProject(projectPath, sessionProjectPath)
        : workspaceIdSet.has(session.workspaceId)
      if (!belongs) continue
      const promotedAt = Number.isFinite(promotedAtById[session.id]) ? promotedAtById[session.id]! : 0
      latest = Math.max(latest, promotedAt, session.updatedAt)
    }
    latestByProjectId.set(projectEntry.id, latest)
  }

  return [...projectEntries].sort((a, b) => {
    const latestA = latestByProjectId.get(a.id) ?? 0
    const latestB = latestByProjectId.get(b.id) ?? 0
    if (latestA !== latestB) return latestB - latestA
    return getProjectLabel(a).localeCompare(getProjectLabel(b), undefined, { sensitivity: 'base' })
  })
}
