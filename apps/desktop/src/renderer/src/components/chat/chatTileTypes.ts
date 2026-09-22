import type { ChatMessage } from '../../../../shared/chat-types'
import type { SessionEntryHint } from '../../../../shared/session-types'
import type { ActiveChatSurface, PendingAttachment } from './chatTileUtils'

/** Chat tile body view — the transcript or the embedded terminal. */
export type ChatTileActiveView = 'chat' | 'terminal'

/** Coerce any persisted/unknown value into a valid active view, defaulting to
 *  'chat'. Shared between core-state init and persistence load so the default
 *  and validation live in exactly one place. */
export function normalizeActiveView(value: unknown): ChatTileActiveView {
  return value === 'terminal' ? 'terminal' : 'chat'
}

export interface CheckpointRestoreContextValue {
  workspaceId: string | null
  tileId: string
  restoringCheckpointId: string | null
  restoreCheckpoint: (checkpointId: string, sessionEntryId: string, label?: string) => Promise<void>
}

export interface QueuedChatTurn {
  id: string
  content: string
  preview: string
  attachmentCount: number
  createdAt: number
  /** Optional parent turn id — when set, this turn renders indented beneath
   *  its parent as a sub-item, representing work the user intends to run
   *  *as part of* the parent turn rather than as its own top-level turn. */
  parentId?: string | null
}

export interface ChatTilePersistedState {
  messages: ChatMessage[]
  input: string
  attachments: PendingAttachment[]
  queuedTurns?: QueuedChatTurn[]
  openChatSurfaces?: ActiveChatSurface[]
  activeChatSurfaceId?: string | null
  provider: string
  model: string
  mcpEnabled: boolean
  mode: string
  thinking: string
  agentMode: boolean
  autoAgentMode: boolean
  /** Selected agent-definition id (AgentMode.id) for this tile, or null for none. */
  agentId?: string | null
  preserveSessionSummary?: boolean
  linkedSessionEntryId?: string | null
  linkedSessionHint?: SessionEntryHint | null
  hasEarlierMessages?: boolean
  sessionId: string | null
  /** Per-provider session ids so switching providers does not cross-contaminate resume ids. */
  sessionIdsByProvider?: Record<string, string>
  jobId?: string | null
  jobSequence?: number
  cloudHostId?: string | null
  isStreaming: boolean
  executionTarget?: 'local' | 'cloud'
  /** Which body view the chat tile is showing — the transcript ('chat') or the
   *  embedded terminal ('terminal'). Defaults to 'chat' when absent. */
  activeView?: 'chat' | 'terminal'
}