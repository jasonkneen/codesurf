import type { WorkspaceSessionEntry } from '../../../../shared/session-types'

export interface ProjectListEntry {
  id: string
  name: string
  path: string
  workspaceIds: string[]
  representativeWorkspaceId: string | null
}

export type SessionEntry = WorkspaceSessionEntry

export interface DisplaySessionEntry extends SessionEntry {
  displayIndent: number
}

export interface SessionProjectGroup {
  projectId: string
  projectPath: string
  representativeWorkspaceId: string | null
  key: string
  label: string
  sessions: DisplaySessionEntry[]
}

export type ThreadOrganizeMode = 'project' | 'chronological'
export type ThreadSortMode = 'updated' | 'title'

export const SESSION_PAGE_SIZE = 50
