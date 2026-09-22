/** Agent room event kinds (Mosaic-style ledger). */
export type RoomEventKind =
  | 'message'
  | 'task'
  | 'handoff'
  | 'summary'
  | 'status'
  | 'finding'
  | 'blocker'
  | 'question'
  | 'decision'
  | 'fileChanged'
  | 'testResult'
  | 'reviewFinding'

export type MemberStatus = 'idle' | 'working' | 'blocked' | 'waiting' | 'done' | 'unknown'

export interface RoomMember {
  tileId: string
  tileType: string
  displayName?: string
  status: MemberStatus
  task: string
  files: string[]
  /** Last ledger sequence this member has consumed (ack cursor). */
  acknowledgedSeq: number
  joinedAt: number
  updatedAt: number
  truncation?: {
    task: boolean
    filesOmitted: number
    fileFieldsTruncated: number
  }
}

export interface RoomEvent {
  id: string
  sequence: number
  roomId: string
  kind: RoomEventKind
  fromTileId: string
  fromTileType: string
  text: string
  /** Empty = room-wide. Otherwise only these members see it in consume. */
  targetTileIds: string[]
  createdAt: number
  meta?: Record<string, unknown>
}

export interface AgentRoom {
  id: string
  workspaceId: string
  /** Stable fingerprint of sorted member ids for reconciling wire graphs. */
  memberKey: string
  members: Map<string, RoomMember>
  events: RoomEvent[]
  nextSequence: number
  createdAt: number
  updatedAt: number
}

export interface RoomSnapshot {
  id: string
  workspaceId: string
  memberKey: string
  members: RoomMember[]
  eventCount: number
  latestSequence: number
  createdAt: number
  updatedAt: number
  truncation?: {
    membersOmitted: number
    memberFieldsTruncated: number
  }
}

export interface ConsumeResult {
  workspaceId: string | null
  roomId: string | null
  text: string
  events: RoomEvent[]
  latestSequence: number
  members: RoomMember[]
  truncation?: {
    eventsOmitted: number
    eventFieldsTruncated: number
    membersOmitted: number
  }
}

export interface PostInput {
  fromTileId: string
  text: string
  kind?: RoomEventKind
  targetTileIds?: string[]
  fromTileType?: string
  meta?: Record<string, unknown>
}
