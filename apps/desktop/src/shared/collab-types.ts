import type { ActivityStatus } from './activity-types.ts'

/** A skill/tool available to an agent — toggleable from the drawer */
export interface SkillConfig {
  id: string
  name: string
  enabled: boolean
  source: 'builtin' | 'mcp' | 'workspace' | 'command'
  server?: string          // MCP server name (if source === 'mcp')
  description?: string
}

/** A context item dropped into the drawer — notes or reference files */
export interface ContextItem {
  id: string
  name: string
  type: 'note' | 'file'
  content?: string         // inline text (notes)
  path?: string            // filesystem path (files)
}

/** Per-tile collab state persisted to .collab/{tileId}/state.json */
export interface CollabState {
  tasks: CollabTask[]
  paused: boolean
  pausedAt?: number
}

/** A task within collab state — superset of what shows in the drawer */
export interface CollabTask {
  id: string
  title: string
  status: ActivityStatus
  createdAt: number
  updatedAt: number
  agent?: string
  detail?: string
}

/** Skills selection persisted to .collab/{tileId}/skills.json */
export interface CollabSkills {
  enabled: string[]
  disabled: string[]
}

export type CollabMailbox = 'inbox' | 'sent' | 'memory' | 'bin'
export type CollabMessageType = 'request' | 'reply' | 'note' | 'signal' | 'memory'
export type CollabMessageStatus = 'unread' | 'read' | 'sent' | 'archived'

export interface CollabMessageMeta {
  protocol: 'codesurf-message/v1'
  id: string
  threadId: string
  fromTileId: string
  toTileId: string
  type: CollabMessageType
  subject: string
  status: CollabMessageStatus
  createdAt: string
  createdTs: number
  updatedAt: string
  updatedTs: number
  replyToId?: string
}

export interface CollabMessage {
  mailbox: CollabMailbox
  filename: string
  meta: CollabMessageMeta
  body: string
  data?: Record<string, unknown>
}

export interface CollabMessageDraft {
  toTileId: string
  subject: string
  body: string
  type?: CollabMessageType
  threadId?: string
  replyToId?: string
  data?: Record<string, unknown>
}

export interface CollabMessageListItem {
  mailbox: CollabMailbox
  filename: string
  meta: CollabMessageMeta
}
