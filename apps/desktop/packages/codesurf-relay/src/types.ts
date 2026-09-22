export type RelayMailbox = 'inbox' | 'sent' | 'memory' | 'bin' | 'channel' | 'central'
export type RelayParticipantKind = 'agent' | 'human' | 'supervisor' | 'service' | 'system'
export type RelayParticipantStatus = 'spawning' | 'ready' | 'running' | 'blocked' | 'stopped' | 'error' | 'done'
export type RelayScope = 'direct' | 'channel' | 'broadcast' | 'system'
export type RelayPriority = 'low' | 'normal' | 'high' | 'critical'
export type RelayMessageKind = 'request' | 'reply' | 'update' | 'handoff' | 'alert' | 'memory' | 'channel' | 'system'
export type RelayMessageStatus = 'unread' | 'read' | 'sent' | 'archived'
export type RelayImpactSeverity = 'low' | 'medium' | 'high'

export interface RelayOperationContext {
  assertActive(): void
  signal?: AbortSignal
}

export interface RelayImpact {
  targetType: 'agent' | 'human' | 'system'
  targetId?: string
  description: string
  severity: RelayImpactSeverity
}

export interface RelayWorkContext {
  summary: string
  branch?: string
  worktreePath?: string
  files?: string[]
  topics?: string[]
  collaborators?: string[]
  blockers?: string[]
  impacts?: RelayImpact[]
  updatedAt?: string
  updatedTs?: number
}

export interface RelayParticipant {
  id: string
  name: string
  kind: RelayParticipantKind
  status: RelayParticipantStatus
  task?: string
  tileId?: string
  provider?: 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes' | 'unknown'
  model?: string
  channels: string[]
  readyAt?: string
  readyTs?: number
  startedAt?: string
  startedTs?: number
  stoppedAt?: string
  stoppedTs?: number
  work?: RelayWorkContext
  metadata?: Record<string, unknown>
}

export interface RelayChannelBridge {
  kind: 'whatsapp' | 'slack' | 'supervisor' | 'webhook' | 'custom'
  target: string
  enabled?: boolean
  metadata?: Record<string, unknown>
}

export interface RelayChannel {
  id: string
  name: string
  description?: string
  members: string[]
  bridges?: RelayChannelBridge[]
  createdAt: string
  createdTs: number
  updatedAt: string
  updatedTs: number
  metadata?: Record<string, unknown>
}

export interface RelayMessageMeta {
  protocol: 'codesurf-relay/v1'
  id: string
  threadId: string
  scope: RelayScope
  kind: RelayMessageKind
  priority: RelayPriority
  from: string
  to?: string
  channel?: string
  subject: string
  status: RelayMessageStatus
  createdAt: string
  createdTs: number
  updatedAt: string
  updatedTs: number
  replyToId?: string
  bcc: 'central'
}

export interface RelayMessage {
  mailbox: RelayMailbox
  filename: string
  meta: RelayMessageMeta
  body: string
  data?: Record<string, unknown>
}

export interface RelayDirectMessageDraft {
  to: string
  subject: string
  body: string
  kind?: RelayMessageKind
  priority?: RelayPriority
  threadId?: string
  replyToId?: string
  data?: Record<string, unknown>
}

export interface RelayChannelMessageDraft {
  channel: string
  subject: string
  body: string
  kind?: RelayMessageKind
  priority?: RelayPriority
  threadId?: string
  replyToId?: string
  data?: Record<string, unknown>
}

export interface RelayMessageListItem {
  mailbox: RelayMailbox
  filename: string
  meta: RelayMessageMeta
}

export interface RelayRelationshipHint {
  participants: [string, string]
  sameBranch: boolean
  sameWorktree: boolean
  sharedChannels: string[]
  overlappingFiles: string[]
  impacts: RelayImpact[]
  priority: RelayPriority
  summary: string
}

export interface RelayEventMap {
  participant_upserted: { participant: RelayParticipant }
  participant_status: { participantId: string; status: RelayParticipantStatus }
  direct_message: { from: string; to: string; message: RelayMessage }
  channel_message: { from: string; channel: string; message: RelayMessage }
  central_message: { message: RelayMessage }
  ready: { participantId: string }
  error: { participantId?: string; error: string }
}

export interface RelayEvent<K extends keyof RelayEventMap = keyof RelayEventMap> {
  type: K
  timestamp: number
  payload: RelayEventMap[K]
}

export interface RelayWaitOptions {
  timeoutMs?: number
}

export interface RelaySpawnRequest {
  id?: string
  name: string
  tileId?: string
  provider?: 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes' | 'unknown'
  model?: string
  task: string
  channels?: string[]
  metadata?: Record<string, unknown>
  mode?: string
  thinking?: string
  timeoutMs?: number
}

export interface RelayTurnInput {
  participant: RelayParticipant
  prompt: string
  unreadDirectMessages: RelayMessage[]
  unreadChannelMessages: RelayMessage[]
  relationships: RelayRelationshipHint[]
}

export interface RelayAgentTurnOutput {
  ready?: boolean
  status?: RelayParticipantStatus
  work?: RelayWorkContext
  messages?: Array<
    | ({ mode: 'direct'; to: string } & Omit<RelayDirectMessageDraft, 'to'>)
    | ({ mode: 'channel'; channel: string } & Omit<RelayChannelMessageDraft, 'channel'>)
  >
  memory?: Array<{ subject: string; body: string; data?: Record<string, unknown> }>
}

export interface RelayAgentExecutor {
  runTurn(input: RelayTurnInput, signal?: AbortSignal): Promise<string>
}
