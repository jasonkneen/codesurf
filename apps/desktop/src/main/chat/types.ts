import type { Persona, ExecutionPreference, ExtensionChatTransportConfig, OmnigentSettings } from '../../shared/types'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface PeerAction {
  name: string
  description: string
}

export interface PeerContext {
  peerId: string
  peerType: string
  tools: string[]
  actions?: PeerAction[]
  context?: Record<string, unknown>
}

export interface ChatImageAttachment {
  path: string
  mediaType: string
  displayPath: string
  byteCount: number
  /** Host-verified file identity captured while expanding an attachment capability. */
  device: string
  inode: string
  mtimeMs: number
  ctimeMs: number
  /** Host-only ownership bit for renderer-authored temporary bytes. */
  ownedTemporary?: boolean
}

export interface ChatContextBucketSection {
  scope: string
  displayPath: string
  importedFrom?: string | null
}

export interface ChatContextBucketRecord {
  bucket: string
  included: boolean
  sectionCount: number
  sections: ChatContextBucketSection[]
}

export interface ChatContextBucketBundle {
  version: number
  includedBuckets: string[]
  buckets: ChatContextBucketRecord[]
  inspect?: {
    summary?: string
    input?: string
  }
}

export interface ChatRequest {
  cardId: string
  workspaceId?: string
  provider: string
  model: string
  messages: ChatMessage[]
  expandedMessages?: ChatMessage[]
  mode?: string
  thinking?: string
  /** Selected persona id (Persona.id) for this turn, if any. */
  agentId?: string | null
  /** Fully-resolved Persona for this turn. Sent by the renderer so the daemon
   *  (incl. cloud, which has no access to the workspace agents.json) can apply the
   *  persona's systemPrompt + tools allow-list. Field name `agentMode` is retained
   *  for cross-process wire compatibility (renaming it would break the
   *  renderer↔main↔daemon contract); its type is now Persona. */
  agentMode?: Persona | null
  workspaceDir?: string
  mcpEnabled?: boolean
  negotiatedTools?: string[]
  peers?: PeerContext[]
  sessionId?: string | null
  providerTransport?: ExtensionChatTransportConfig | null
  executionTarget?: 'local' | 'cloud'
  cloudHostId?: string | null
  executionPreference?: ExecutionPreference | null
  omnigent?: OmnigentSettings | null
  jobId?: string | null
  jobSequence?: number
  runMode?: 'foreground' | 'background'
  asyncExecution?: {
    requestedRunMode: 'foreground' | 'background'
    backend: 'runtime' | 'daemon'
    hostType: 'runtime' | 'local-daemon' | 'remote-daemon'
    hostLabel: string
    providerNativeBackground: boolean
    detachedDaemonAvailable: boolean
    detachedDaemonPreferred: boolean
  }
  memoryPrompt?: string
  /** Agent-room standing + consumed traffic for this turn (main injects). */
  roomContext?: string
  /** Main-process-only cursor reservation; never trusted from renderer input. */
  roomAckSequence?: number
  /** Host-composed provider system context. Stripped at every inbound boundary. */
  contextPrompt?: string
  /** Host-expanded workspace file content, delivered as untrusted user data. */
  fileReferencePrompt?: string
  /** Renderer-derived recent edit hint; host bounds and labels it as untrusted user data. */
  recentEditContext?: string
  /** Renderer-derived transcript block notes; host bounds and labels them as untrusted user data. */
  blockNotesContext?: string
  /** Host-filtered renderer peer observations, delivered only as untrusted user data. */
  untrustedPeerContext?: string
  skillsPrompt?: string
  skillsSummary?: string | null
  contextBuckets?: ChatContextBucketBundle
  /** Opaque host-issued receipts for durable attachment selections. */
  attachmentSelections?: Array<{ selectionReceipt: string }>
  imageAttachments?: ChatImageAttachment[]
}

export interface RuntimeChatSessionState {
  provider: string
  model: string
  sessionId: string | null
  jobId: string | null
  jobSequence: number
  executionTarget: 'local' | 'cloud'
  cloudHostId: string | null
  isStreaming: boolean
  messages: ChatMessage[]
}
