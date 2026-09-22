/** Shared chat message types used by ChatTile, KanbanCard, and main-process IPC. */

export interface FileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

export interface CommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

export interface FileChangesOrigin {
  workspaceId: string
  cardId: string
  provider: string
  executionTarget: 'local' | 'cloud'
  sessionId: string | null
}

export interface ToolBlock {
  id: string
  /** Provider-native tool name, kept for debugging, permissions, and expanded detail. */
  name: string
  rawName?: string
  canonicalName?: string
  displayName?: string
  groupKey?: string
  category?: string
  provider?: string
  namespace?: string
  input: string
  summary?: string
  elapsed?: number
  status: 'running' | 'done' | 'error'
  fileChanges?: FileChange[]
  /** Main-process attestation for bounded local recent-edit reads. */
  fileChangesTrusted?: boolean
  /** Exact local turn identity that produced an attested file-change summary. */
  fileChangesOrigin?: FileChangesOrigin
  commandEntries?: CommandEntry[]
  /** User-written margin note "stuck" to this tool-call block. */
  note?: BlockNote
}

export interface ThinkingBlock {
  content: string
  done: boolean
  id?: string
  /** User-written margin note "stuck" to this thinking block. */
  note?: BlockNote
}

/**
 * A free-form user note attached to a specific chat record (message, tool
 * call, or thinking block). One note per block by design — editing replaces
 * the previous text. Stored inline on the record so it travels with the
 * conversation wherever the record goes.
 */
export interface BlockNote {
  text: string
  createdAt: number
  updatedAt?: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolId: string }
  | { type: 'thinking'; thinkingId: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  thinking?: ThinkingBlock
  thinkingBlocks?: ThinkingBlock[]
  toolBlocks?: ToolBlock[]
  contentBlocks?: ContentBlock[]
  cost?: number
  turns?: number
  /** Persona that produced this assistant turn. Null/absent = no persona. */
  agentId?: string | null
  /** Provider id used for the fallback reply avatar. */
  provider?: string
  /** User-written margin note "stuck" to this whole message. */
  note?: BlockNote
  /**
   * Tile id of the PEER AGENT that injected this message, when it did not come
   * from the operator. Peer traffic arrives via chat_send_message /
   * chat_acknowledge and was previously appended as a plain role:'user' turn
   * whose only provenance was a leading emoji inside the content — so a
   * prompt-injected agent could post an instruction indistinguishable from
   * operator input, and the target executed it with its granted permissions.
   * Absent means the message is operator- or assistant-authored.
   */
  peerTileId?: string
}
