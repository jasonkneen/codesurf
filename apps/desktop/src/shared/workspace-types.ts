import type { AppSettings } from './settings-runtime.ts'

export interface Workspace {
  id: string
  name: string
  /** Primary project folder for legacy callers. */
  path: string
  /** All project folders attached to this workspace/canvas tab. */
  projectPaths?: string[]
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
}

export interface WorkspaceRecord {
  id: string
  name: string
  projectIds: string[]
  primaryProjectId?: string | null
}

export interface Config {
  version: 2
  projects: ProjectRecord[]
  workspaces: WorkspaceRecord[]
  activeWorkspaceId: string | null
  settings: AppSettings
}
