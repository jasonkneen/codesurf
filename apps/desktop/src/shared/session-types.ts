export type SessionSource = 'codesurf' | 'claude' | 'codex' | 'cursor' | 'hermes' | 'openclaw' | 'opencode' | 'csagent'
export type SessionScope = 'workspace' | 'project' | 'user'

export interface SessionEntryHint {
  id: string
  source: SessionSource
  filePath?: string
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  title: string
  projectPath?: string | null
}

export interface AggregatedSessionEntry {
  id: string
  source: SessionSource
  scope: SessionScope
  tileId: string | null
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  lastMessage: string | null
  updatedAt: number
  sizeBytes?: number
  filePath?: string
  title: string
  projectPath?: string | null
  sourceLabel: string
  sourceDetail?: string
  checkpointCount?: number
  isArchived?: boolean
  canOpenInChat?: boolean
  canOpenInApp?: boolean
  resumeBin?: string
  resumeArgs?: string[]
  relatedGroupId?: string | null
  nestingLevel?: number
}

export interface WorkspaceSessionEntry extends AggregatedSessionEntry {
  workspaceId: string
  workspaceName: string
  workspacePath: string
}
