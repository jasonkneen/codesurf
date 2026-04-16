export type SessionSource = 'codesurf' | 'claude' | 'codex' | 'cursor' | 'openclaw' | 'opencode'
export type SessionScope = 'workspace' | 'project' | 'user'

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
  filePath?: string
  title: string
  projectPath?: string | null
  sourceLabel: string
  sourceDetail?: string
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
