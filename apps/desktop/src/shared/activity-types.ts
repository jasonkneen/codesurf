export type ActivityType = 'task' | 'tool' | 'skill' | 'context'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'error' | 'paused'
export type ActivityMetadataValue = string | number | boolean | null
export type ActivityMetadata = Record<string, ActivityMetadataValue>

export const ACTIVITY_LIMITS = {
  workspaceId: 128,
  tileId: 256,
  id: 256,
  title: 512,
  detail: 4096,
  agent: 256,
  metadataBytes: 4096,
  metadataKeys: 16,
  metadataString: 1024,
} as const

/** A single activity record persisted per-workspace */
export interface ActivityRecord {
  id: string
  tileId: string
  workspaceId: string
  type: ActivityType
  status: ActivityStatus
  title: string
  detail?: string
  metadata?: ActivityMetadata
  agent?: string
  createdAt: number
  updatedAt: number
}

export interface ActivityUpsertInput {
  id?: string
  tileId: string
  type: ActivityType
  status?: ActivityStatus
  title: string
  detail?: string
  metadata?: ActivityMetadata
  agent?: string
}

/** Query filter for activity:query IPC */
export interface ActivityQuery {
  workspaceId: string
  tileId?: string
  type?: ActivityType
  status?: ActivityStatus
  agent?: string
  limit?: number
}

export type ActivityHealthOperation = 'load' | 'save'

export interface ActivityHealthIssue {
  operation: ActivityHealthOperation
  code: string
  occurredAt: number
}

export interface ActivityHealthSnapshot {
  available: boolean
  status: 'healthy' | 'degraded' | 'unavailable'
  lastIssue?: ActivityHealthIssue
}

export interface ActivityHealthEvent extends ActivityHealthIssue {
  workspaceId: string
}
