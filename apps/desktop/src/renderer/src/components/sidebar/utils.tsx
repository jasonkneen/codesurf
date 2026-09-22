import React from 'react'
import type { Workspace } from '../../../../shared/types'
import { basename } from '../../utils/dnd'
import { compareSessionsWithSelectionPriority } from './session-ordering'
import { normalizeSidebarPath } from './path-utils'
import type { DisplaySessionEntry, ProjectListEntry, SessionEntry, ThreadSortMode } from './types'

export function deriveProjectsFromWorkspaces(workspaces: Workspace[]): ProjectListEntry[] {
  const byPath = new Map<string, ProjectListEntry>()

  for (const workspaceEntry of workspaces) {
    const candidatePaths = getWorkspaceProjectPaths(workspaceEntry)
    for (const path of candidatePaths) {
      if (byPath.has(path)) continue
      byPath.set(path, {
        id: `derived:${path}`,
        name: basename(path) || workspaceEntry.name || 'Project',
        path,
        workspaceIds: [],
        representativeWorkspaceId: null,
      })
    }
  }

  return [...byPath.values()].sort((a, b) => getProjectDisplayLabel(a).localeCompare(getProjectDisplayLabel(b), undefined, { sensitivity: 'base' }))
}

export function sessionMetaText(session: SessionEntry): string {
  return `${session.title} ${session.sourceLabel} ${session.sourceDetail ?? ''}`.toLowerCase()
}

function stripMarkdownTitleSyntax(title: string): string {
  return title
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

function normalizeSessionTitle(title: string): string {
  let next = stripMarkdownTitleSyntax(String(title ?? '').replace(/\r\n/g, '\n'))
    .split(/\r?\n/, 1)[0]
    .trim()

  next = next.replace(/^[-*+]\s+/, '')
  next = next.replace(/^\[[ xX]\]\s+/, '')
  next = next.replace(/^\d+\.\s+/, '')
  next = next.replace(/^#+\s+/, '')
  next = next.replace(/\s+/g, ' ').trim()

  return next
}

/**
 * Conversation-title display policy for the sidebar.
 *
 * Visual truncation is handled by CSS (`overflow: hidden; text-overflow:
 * ellipsis`) on the label span, so titles automatically fit the current
 * sidebar width — resize the sidebar and they grow/shrink with it.
 *
 * This helper just normalizes whitespace (collapse newlines/tabs to single
 * spaces, trim) and applies a generous safety cap to keep pathological
 * multi-KB titles from bloating the DOM. The full title is still shown in
 * the row's `title` tooltip.
 */
export function formatSessionTitleForSidebar(title: string, hardCap = 160): string {
  const clean = normalizeSessionTitle(title)
  return clean.length > hardCap ? `${clean.slice(0, hardCap).trimEnd()}…` : clean
}

export { normalizeSidebarPath, sidebarPathBelongsToProject } from './path-utils'

export function getProjectDisplayLabel(project: { name: string; path: string }): string {
  const normalizedPath = normalizeSidebarPath(project.path)
  const pathLabel = basename(normalizedPath)
  const nameLabel = project.name?.trim() || ''
  const looksGenerated = /^ws-\d{6,}$/.test(pathLabel)
  // A user-renamed project carries a `name` that no longer matches the
  // folder basename — respect it over the path. Otherwise default to the
  // folder basename, which reads more naturally than a generated id.
  if (nameLabel && nameLabel.toLowerCase() !== pathLabel.toLowerCase()) return nameLabel
  if (pathLabel && !looksGenerated) return pathLabel
  return nameLabel || pathLabel || 'Project'
}

export function getWorkspaceProjectPaths(workspaceEntry: Workspace | null | undefined): string[] {
  if (!workspaceEntry) return []
  const seen = new Set<string>()
  const paths = [workspaceEntry.path, ...(workspaceEntry.projectPaths ?? [])]

  for (const candidate of paths) {
    const normalized = normalizeSidebarPath(candidate)
    if (normalized) seen.add(normalized)
  }

  return [...seen]
}

export function isCronSession(session: SessionEntry): boolean {
  const meta = sessionMetaText(session)
  return meta.includes('scheduled task') || meta.includes('cron')
}

export function isSubagentSession(session: SessionEntry): boolean {
  if ((session.nestingLevel ?? 0) > 0) return true
  return sessionMetaText(session).includes('subagent')
}

export function getSessionAgentKey(session: SessionEntry): string {
  const provider = String(session.provider ?? '').trim().toLowerCase()
  if (session.source === 'codesurf' && provider) return provider
  return String(session.source ?? 'codesurf').trim().toLowerCase() || 'codesurf'
}

export function getSessionAgentLabel(session: SessionEntry): string {
  const key = getSessionAgentKey(session)
  if (key === 'claude') return 'Claude'
  if (key === 'codex') return 'Codex'
  if (key === 'cursor') return 'Cursor'
  if (key === 'hermes') return 'Hermes'
  if (key === 'openclaw') return 'OpenClaw'
  if (key === 'opencode') return 'OpenCode'
  if (key === 'csagent' || key === 'pi') return 'Pi Agent'
  return session.sourceLabel || 'CodeSurf'
}

export function compareSessions(
  a: SessionEntry,
  b: SessionEntry,
  sortMode: ThreadSortMode,
  promotedAtById: Record<string, number> = {},
): number {
  return compareSessionsWithSelectionPriority(a, b, sortMode, promotedAtById)
}

export function buildNestedSessionList(
  sessions: SessionEntry[],
  sortMode: ThreadSortMode,
  promotedAtById: Record<string, number> = {},
): DisplaySessionEntry[] {
  type SessionNode = {
    session: SessionEntry
    children: SessionNode[]
    parentId: string | null
    subtreeUpdatedAt: number
  }

  const sorted = [...sessions].sort((a, b) => compareSessions(a, b, sortMode, promotedAtById))
  const nodes = new Map<string, SessionNode>(sorted.map(session => [session.id, {
    session,
    children: [],
    parentId: null,
    subtreeUpdatedAt: session.updatedAt,
  } satisfies SessionNode] as const))
  const byGroup = new Map<string, SessionEntry[]>()

  for (const session of sorted) {
    if (!session.relatedGroupId) continue
    const group = byGroup.get(session.relatedGroupId) ?? []
    group.push(session)
    byGroup.set(session.relatedGroupId, group)
  }

  const chooseParent = (session: SessionEntry): SessionEntry | null => {
    const groupId = session.relatedGroupId
    const level = session.nestingLevel ?? 0
    if (!groupId || level <= 0) return null

    const candidates = (byGroup.get(groupId) ?? []).filter(candidate => {
      if (candidate.id === session.id) return false
      return (candidate.nestingLevel ?? 0) < level
    })
    if (candidates.length === 0) return null

    const preferredLevel = level - 1
    const preferred = candidates.filter(candidate => (candidate.nestingLevel ?? 0) === preferredLevel)
    const pool = preferred.length > 0 ? preferred : candidates
    const older = pool.filter(candidate => candidate.updatedAt <= session.updatedAt)
    if (older.length > 0) {
      older.sort((a, b) => b.updatedAt - a.updatedAt)
      return older[0]
    }
    return [...pool].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  for (const session of sorted) {
    const parent = chooseParent(session)
    const parentNode = parent ? nodes.get(parent.id) : null
    const childNode = nodes.get(session.id)
    if (!parentNode || !childNode) continue
    childNode.parentId = parent!.id
    parentNode.children.push(childNode)
  }

  const computeSubtree = (node: SessionNode): number => {
    let latest = node.session.updatedAt
    for (const child of node.children) {
      latest = Math.max(latest, computeSubtree(child))
    }
    node.children.sort((a, b) => compareSessions(a.session, b.session, sortMode, promotedAtById))
    node.subtreeUpdatedAt = latest
    return latest
  }

  const roots = [...nodes.values()].filter(node => !node.parentId)
  for (const root of roots) computeSubtree(root)
  roots.sort((a, b) => compareSessions(a.session, b.session, sortMode, promotedAtById))

  const flattened: DisplaySessionEntry[] = []
  const walk = (node: SessionNode, depth: number) => {
    flattened.push({ ...node.session, displayIndent: depth })
    for (const child of node.children) walk(child, depth + 1)
  }

  for (const root of roots) walk(root, 0)
  return flattened
}

export const TILE_ICONS: Record<string, React.JSX.Element> = {
  terminal: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M7 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>,
  code: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M5 3L1 7l4 4M9 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  note: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>,
  browser: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M1 5h12" stroke="currentColor" strokeWidth="1.2" /></svg>,
  chat: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 2h10a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 2.5V10H2a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  files: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1 3C1 2.17 1.67 1.5 2.5 1.5H5L6.5 3H11.5C12.33 3 13 3.67 13 4.5V11C13 11.83 12.33 12.5 11.5 12.5H2.5C1.67 12.5 1 11.83 1 11V3Z" stroke="currentColor" strokeWidth="1.2" /></svg>,
  kanban: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /></svg>,
  image: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="5" cy="5" r="1.2" stroke="currentColor" strokeWidth="1" /><path d="M1.5 10l3-3 2 2 2.5-3 3.5 4" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /></svg>,
}

export const RESOURCE_ITEMS = [
  { id: 'prompts', label: 'Prompts', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3 2h8a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" /><path d="M4 5h6M4 7.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg> },
  { id: 'skills', label: 'Skills', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.8 3.6L13 5.2l-3 2.9.7 4.1L7 10.3 3.3 12.2l.7-4.1-3-2.9 4.2-.6L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg> },
  { id: 'tools', label: 'Tools', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M8.5 2.5a3 3 0 00-4.2 4.2L2 9l1 2 2 1 2.3-2.3a3 3 0 004.2-4.2L9.5 7.5 8 7l-.5-1.5L9.5 3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg> },
  { id: 'agents', label: 'Personas', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 12.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg> },
  { id: 'extensions', label: 'Plugins', icon: <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="4" height="4" rx="0.9" stroke="currentColor" strokeWidth="1.25" /><rect x="8" y="2" width="4" height="4" rx="0.9" stroke="currentColor" strokeWidth="1.25" /><rect x="2" y="8" width="4" height="4" rx="0.9" stroke="currentColor" strokeWidth="1.25" /><path d="M10 8v4M8 10h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg> },
] as const

// Use the shared brand icons (same set the ChatTile provider menu renders)
// so the sidebar, dropdowns, and pills stay visually consistent.
import {
  ClaudeIcon,
  CodeSurfIcon,
  CodexIcon,
  CursorIcon,
  HermesIcon,
  OpenClawIcon,
  OpenCodeIcon,
  PiIcon,
} from '../icons/providerIcons'

export const SESSION_SOURCE_ICONS: Record<string, React.JSX.Element> = {
  codesurf: <CodeSurfIcon size={14} />,
  claude:   <ClaudeIcon size={14} />,
  codex:    <CodexIcon size={14} />,
  cursor:   <CursorIcon size={14} />,
  hermes:   <HermesIcon size={14} />,
  openclaw: <OpenClawIcon size={14} />,
  opencode: <OpenCodeIcon size={14} />,
  csagent: <PiIcon size={14} />,
}

export function SpinnerIcon({ size = 14, color = 'currentColor' }: { size?: number; color?: string }): React.JSX.Element {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size }}
      aria-label="Thread is active"
    >
      <svg width={size} height={size} viewBox="0 0 16 16" style={{ animation: 'cs-sidebar-spin 0.9s linear infinite' }}>
        <circle cx="8" cy="8" r="6" stroke={color} strokeOpacity={0.25} strokeWidth="1.6" fill="none" />
        <path d="M14 8a6 6 0 00-6-6" stroke={color} strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
      <style>{`@keyframes cs-sidebar-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  )
}

export function getSessionAgentIcon(session: SessionEntry, opts?: { streaming?: boolean }): React.JSX.Element {
  if (opts?.streaming) return <SpinnerIcon size={14} />
  return SESSION_SOURCE_ICONS[getSessionAgentKey(session)] ?? SESSION_SOURCE_ICONS[session.source] ?? <CodeSurfIcon size={14} />
}
