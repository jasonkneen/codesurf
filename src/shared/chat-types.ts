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

export interface ToolBlock {
  id: string
  name: string
  input: string
  summary?: string
  elapsed?: number
  status: 'running' | 'done' | 'error'
  fileChanges?: FileChange[]
  commandEntries?: CommandEntry[]
}

export interface ThinkingBlock {
  content: string
  done: boolean
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolId: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  thinking?: ThinkingBlock
  toolBlocks?: ToolBlock[]
  contentBlocks?: ContentBlock[]
  cost?: number
  turns?: number
}
