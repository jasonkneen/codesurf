import {
  useState,
  useRef,
  useCallback,
  useSyncExternalStore,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { AppSettings } from '../../../shared/types'
import type { ChatMessage } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_ID,
  isBuiltinProvider,
  resolveProviderModeId,
} from '../config/providers'
import { getChatTileRuntimeState } from '../components/chatTileRuntimeState'
import {
  getTileChromeSnapshot,
  getTileMessages,
  replaceTileMessages,
  subscribeTileMessages,
  updateTileMessages,
} from '../components/chat/chatMessagesStore'
import type {
  ToolPermissionDecision,
  ToolPermissionRequest,
} from '../components/ai-elements/ToolPermission'
import {
  normalizePersistedChatSurfaces,
  type ActiveChatSurface,
  type PendingAttachment,
} from '../components/chat/chatTileUtils'
import {
  normalizeActiveView,
  type ChatTileActiveView,
  type ChatTilePersistedState,
  type QueuedChatTurn,
} from '../components/chat/chatTileTypes'

export interface UseChatTileCoreStateOptions {
  tileId: string
  workspaceId: string
  settings?: AppSettings
}

export interface UseChatTileCoreStateResult {
  initialRuntimeStateRef: MutableRefObject<ChatTilePersistedState | null>
  initialProvider: string
  initialModel: string
  initialMode: string
  initialExecutionTarget: 'local' | 'cloud'
  initialCloudHostId: string | null
  initialJobId: string | null
  initialJobSequence: number

  messages: ChatMessage[]
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  input: string
  setInput: Dispatch<SetStateAction<string>>
  isStreaming: boolean
  setIsStreaming: Dispatch<SetStateAction<boolean>>
  executionTarget: 'local' | 'cloud'
  setExecutionTarget: Dispatch<SetStateAction<'local' | 'cloud'>>
  cloudHostId: string | null
  setCloudHostId: Dispatch<SetStateAction<string | null>>
  provider: string
  setProvider: Dispatch<SetStateAction<string>>
  model: string
  setModel: Dispatch<SetStateAction<string>>
  mcpEnabled: boolean
  setMcpEnabled: Dispatch<SetStateAction<boolean>>
  mode: string
  setMode: Dispatch<SetStateAction<string>>
  thinking: string
  setThinking: Dispatch<SetStateAction<string>>
  agentId: string | null
  setAgentId: Dispatch<SetStateAction<string | null>>
  autoAgentMode: boolean
  setAutoAgentMode: Dispatch<SetStateAction<boolean>>
  attachments: PendingAttachment[]
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
  queuedTurns: QueuedChatTurn[]
  setQueuedTurns: Dispatch<SetStateAction<QueuedChatTurn[]>>
  openChatSurfaces: ActiveChatSurface[]
  setOpenChatSurfaces: Dispatch<SetStateAction<ActiveChatSurface[]>>
  activeChatSurfaceId: string | null
  setActiveChatSurfaceId: Dispatch<SetStateAction<string | null>>
  sessionId: string | null
  setSessionId: Dispatch<SetStateAction<string | null>>
  sessionIdsByProvider: Record<string, string>
  setSessionIdsByProvider: Dispatch<SetStateAction<Record<string, string>>>
  commitSessionId: (id: string | null, providerId?: string) => void
  swapProviderSession: (fromProvider: string, toProvider: string) => void
  jobId: string | null
  setJobId: Dispatch<SetStateAction<string | null>>
  jobSequence: number
  setJobSequence: Dispatch<SetStateAction<number>>
  linkedSessionEntryId: string | null
  setLinkedSessionEntryId: Dispatch<SetStateAction<string | null>>
  linkedSessionHint: SessionEntryHint | null
  setLinkedSessionHint: Dispatch<SetStateAction<SessionEntryHint | null>>
  preserveSessionSummary: boolean
  setPreserveSessionSummary: Dispatch<SetStateAction<boolean>>
  hasEarlierMessages: boolean
  setHasEarlierMessages: Dispatch<SetStateAction<boolean>>
  activeView: ChatTileActiveView
  setActiveView: Dispatch<SetStateAction<ChatTileActiveView>>

  lastActivityAtRef: MutableRefObject<number>
  toolCollapseTick: number
  setToolCollapseTick: Dispatch<SetStateAction<number>>
  explodedChipGroups: ReadonlySet<string>
  toggleExplodedChipGroup: (clusterId: string, collationId: string) => void
  pendingToolPermissions: Map<string, ToolPermissionRequest>
  setPendingToolPermissions: Dispatch<SetStateAction<Map<string, ToolPermissionRequest>>>
  resolvedToolPermissions: Map<string, ToolPermissionDecision>
  setResolvedToolPermissions: Dispatch<SetStateAction<Map<string, ToolPermissionDecision>>>
  handleToolPermissionDecision: (args: {
    cardId: string
    toolId: string
    decision: ToolPermissionDecision
  }) => Promise<{ ok: boolean }>
  toolCompletedAtRef: MutableRefObject<Map<string, number>>
}

export function useChatTileCoreState({
  tileId,
  workspaceId,
  settings,
}: UseChatTileCoreStateOptions): UseChatTileCoreStateResult {
  const workspaceTileKey = JSON.stringify([workspaceId, tileId])
  const initialRuntimeScopeKeyRef = useRef(workspaceTileKey)
  const initialRuntimeStateRef = useRef<ChatTilePersistedState | null>(
    getChatTileRuntimeState<ChatTilePersistedState>(workspaceId, tileId),
  )
  if (initialRuntimeScopeKeyRef.current !== workspaceTileKey) {
    initialRuntimeScopeKeyRef.current = workspaceTileKey
    initialRuntimeStateRef.current = getChatTileRuntimeState<ChatTilePersistedState>(
      workspaceId,
      tileId,
    )
  }
  const initialProvider = initialRuntimeStateRef.current?.provider ?? DEFAULT_PROVIDER_ID
  const initialModel = initialRuntimeStateRef.current?.model
    ?? (isBuiltinProvider(initialProvider)
      ? DEFAULT_MODELS[initialProvider][0]?.id
      : DEFAULT_MODELS[DEFAULT_PROVIDER_ID][0]?.id)
    ?? ''
  const initialMode = resolveProviderModeId(
    initialProvider,
    initialRuntimeStateRef.current?.mode ?? settings?.chatProviderModes?.[initialProvider],
  )
  const initialExecutionTarget = initialRuntimeStateRef.current?.executionTarget ?? 'local'
  const initialCloudHostId = initialRuntimeStateRef.current?.cloudHostId ?? null
  const initialJobId = initialRuntimeStateRef.current?.jobId ?? null
  const initialJobSequence = initialRuntimeStateRef.current?.jobSequence ?? 0

  // Synchronous seed so the first render already sees restored runtime messages.
  const seededTileRef = useRef<string | null>(null)
  if (seededTileRef.current !== workspaceTileKey) {
    seededTileRef.current = workspaceTileKey
    const restored = initialRuntimeStateRef.current?.messages ?? []
    if (getTileMessages(workspaceId, tileId).length === 0 && restored.length > 0) {
      replaceTileMessages(workspaceId, tileId, restored)
    }
  }

  useSyncExternalStore(
    (listener) => subscribeTileMessages(workspaceId, tileId, listener),
    () => getTileChromeSnapshot(workspaceId, tileId),
    () => getTileChromeSnapshot(workspaceId, tileId),
  )
  // Structural/chrome updates rerender ChatTile. Pure text growth is consumed
  // directly by ChatTileTranscriptColumn so shell/send-path hooks stay still.
  const messages = getTileMessages(workspaceId, tileId)
  const setMessages = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>((updater) => {
    updateTileMessages(workspaceId, tileId, updater)
  }, [workspaceId, tileId])
  const [input, setInput] = useState(() => initialRuntimeStateRef.current?.input ?? '')
  const [isStreaming, setIsStreaming] = useState(
    () => (initialRuntimeStateRef.current?.isStreaming && initialJobId) ? true : false,
  )
  const lastActivityAtRef = useRef<number>(Date.now())
  const [toolCollapseTick, setToolCollapseTick] = useState(0)
  const [explodedChipGroups, setExplodedChipGroups] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExplodedChipGroup = useCallback((clusterId: string, collationId: string) => {
    const key = `${clusterId}::${collationId}`
    setExplodedChipGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const toolCompletedAtRef = useRef<Map<string, number>>(new Map())
  const [pendingToolPermissions, setPendingToolPermissions] = useState<Map<string, ToolPermissionRequest>>(
    () => new Map(),
  )
  const [resolvedToolPermissions, setResolvedToolPermissions] = useState<Map<string, ToolPermissionDecision>>(
    () => new Map(),
  )
  const handleToolPermissionDecision = useCallback(async (args: {
    cardId: string
    toolId: string
    decision: ToolPermissionDecision
  }) => {
    const res = await window.electron?.chat?.answerToolPermission?.({
      workspaceId,
      ...args,
    })
    return res ?? { ok: true }
  }, [workspaceId])
  const [executionTarget, setExecutionTarget] = useState<'local' | 'cloud'>(() => initialExecutionTarget)
  const [cloudHostId, setCloudHostId] = useState<string | null>(() => initialCloudHostId)
  const [provider, setProvider] = useState<string>(() => initialProvider)
  const [model, setModel] = useState(() => initialModel)
  const [mcpEnabled, setMcpEnabled] = useState(() => initialRuntimeStateRef.current?.mcpEnabled ?? true)
  const [mode, setMode] = useState(() => initialMode)
  const [thinking, setThinking] = useState(() => initialRuntimeStateRef.current?.thinking ?? 'adaptive')
  const [agentId, setAgentId] = useState<string | null>(
    () => initialRuntimeStateRef.current?.agentId ?? null,
  )
  const [autoAgentMode, setAutoAgentMode] = useState(
    () => initialRuntimeStateRef.current?.autoAgentMode ?? false,
  )
  const [sessionIdsByProvider, setSessionIdsByProvider] = useState<Record<string, string>>(() => {
    const saved = initialRuntimeStateRef.current
    if (saved?.sessionIdsByProvider && typeof saved.sessionIdsByProvider === 'object') {
      return { ...saved.sessionIdsByProvider }
    }
    if (saved?.sessionId && saved.provider) {
      return { [saved.provider]: saved.sessionId }
    }
    return {}
  })
  const [sessionId, setSessionId] = useState<string | null>(() => {
    const saved = initialRuntimeStateRef.current
    const providerKey = saved?.provider ?? initialProvider
    if (saved?.sessionIdsByProvider?.[providerKey]) {
      return saved.sessionIdsByProvider[providerKey] ?? null
    }
    return saved?.sessionId ?? null
  })
  const commitSessionId = useCallback((id: string | null, providerId?: string) => {
    const key = providerId ?? provider
    setSessionId(id)
    setSessionIdsByProvider(prev => {
      if (!id) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      if (prev[key] === id) return prev
      return { ...prev, [key]: id }
    })
  }, [provider])
  const swapProviderSession = useCallback((fromProvider: string, toProvider: string) => {
    setSessionIdsByProvider(prev => {
      const next = { ...prev }
      if (sessionId) next[fromProvider] = sessionId
      else delete next[fromProvider]
      setSessionId(next[toProvider] ?? null)
      return next
    })
  }, [sessionId])
  const [linkedSessionEntryId, setLinkedSessionEntryId] = useState<string | null>(
    () => initialRuntimeStateRef.current?.linkedSessionEntryId ?? null,
  )
  const [linkedSessionHint, setLinkedSessionHint] = useState<SessionEntryHint | null>(
    () => initialRuntimeStateRef.current?.linkedSessionHint ?? null,
  )
  const [preserveSessionSummary, setPreserveSessionSummary] = useState<boolean>(
    () => initialRuntimeStateRef.current?.preserveSessionSummary === true,
  )
  const [hasEarlierMessages, setHasEarlierMessages] = useState<boolean>(
    () => initialRuntimeStateRef.current?.hasEarlierMessages === true,
  )
  const [jobId, setJobId] = useState<string | null>(() => initialJobId)
  const [jobSequence, setJobSequence] = useState<number>(() => initialJobSequence)
  const [attachments, setAttachments] = useState<PendingAttachment[]>(
    () => initialRuntimeStateRef.current?.attachments ?? [],
  )
  const [openChatSurfaces, setOpenChatSurfaces] = useState<ActiveChatSurface[]>(
    () => normalizePersistedChatSurfaces(initialRuntimeStateRef.current?.openChatSurfaces),
  )
  const [activeChatSurfaceId, setActiveChatSurfaceId] = useState<string | null>(
    () => initialRuntimeStateRef.current?.activeChatSurfaceId ?? null,
  )
  const [queuedTurns, setQueuedTurns] = useState<QueuedChatTurn[]>(
    () => initialRuntimeStateRef.current?.queuedTurns ?? [],
  )
  const [activeView, setActiveView] = useState<ChatTileActiveView>(
    () => normalizeActiveView(initialRuntimeStateRef.current?.activeView),
  )

  return {
    initialRuntimeStateRef,
    initialProvider,
    initialModel,
    initialMode,
    initialExecutionTarget,
    initialCloudHostId,
    initialJobId,
    initialJobSequence,
    messages,
    setMessages,
    input,
    setInput,
    isStreaming,
    setIsStreaming,
    executionTarget,
    setExecutionTarget,
    cloudHostId,
    setCloudHostId,
    provider,
    setProvider,
    model,
    setModel,
    mcpEnabled,
    setMcpEnabled,
    mode,
    setMode,
    thinking,
    setThinking,
    agentId,
    setAgentId,
    autoAgentMode,
    setAutoAgentMode,
    attachments,
    setAttachments,
    queuedTurns,
    setQueuedTurns,
    openChatSurfaces,
    setOpenChatSurfaces,
    activeChatSurfaceId,
    setActiveChatSurfaceId,
    sessionId,
    setSessionId,
    sessionIdsByProvider,
    setSessionIdsByProvider,
    commitSessionId,
    swapProviderSession,
    jobId,
    setJobId,
    jobSequence,
    setJobSequence,
    linkedSessionEntryId,
    setLinkedSessionEntryId,
    linkedSessionHint,
    setLinkedSessionHint,
    preserveSessionSummary,
    setPreserveSessionSummary,
    hasEarlierMessages,
    setHasEarlierMessages,
    activeView,
    setActiveView,
    lastActivityAtRef,
    toolCollapseTick,
    setToolCollapseTick,
    explodedChipGroups,
    toggleExplodedChipGroup,
    pendingToolPermissions,
    setPendingToolPermissions,
    resolvedToolPermissions,
    setResolvedToolPermissions,
    handleToolPermissionDecision,
    toolCompletedAtRef,
  }
}
