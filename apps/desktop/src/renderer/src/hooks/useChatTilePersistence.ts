import { useRef, useEffect, useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ChatMessage } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import { DEFAULT_PROVIDER_ID, resolveProviderModeId } from '../config/providers'
import { isImagePath } from '../utils/dnd'
import {
  normalizePersistedChatSurfaces,
  buildQueuedTurnPreview,
  canUsePagedLinkedHistory,
  type ActiveChatSurface,
  type PendingAttachment,
} from '../components/chat/chatTileUtils'
import {
  normalizeActiveView,
  type ChatTileActiveView,
  type ChatTilePersistedState,
  type QueuedChatTurn,
} from '../components/chat/chatTileTypes'
import {
  getChatTileRuntimeState,
  setChatTileRuntimeState,
  reviveChatTileRuntimeState,
  isChatTileRuntimeStateDisposed,
} from '../components/chatTileRuntimeState'
import {
  LINKED_SESSION_HISTORY_PAGE_SIZE,
} from '../components/chat/chatTileLayout'

export interface UseChatTilePersistenceOptions {
  tileId: string
  workspaceId: string
  reloadToken: number
  initialRuntimeStateRef: MutableRefObject<ChatTilePersistedState | null>
  fallbackProvider: string

  messages: ChatMessage[]
  input: string
  attachments: PendingAttachment[]
  queuedTurns: QueuedChatTurn[]
  openChatSurfaces: ActiveChatSurface[]
  activeChatSurfaceId: string | null
  executionTarget: 'local' | 'cloud'
  provider: string
  model: string
  mcpEnabled: boolean
  mode: string
  thinking: string
  agentId: string | null
  effectiveAgentMode: boolean
  autoAgentMode: boolean
  preserveSessionSummary: boolean
  linkedSessionEntryId: string | null
  linkedSessionHint: SessionEntryHint | null
  hasEarlierMessages: boolean
  sessionId: string | null
  sessionIdsByProvider: Record<string, string>
  jobId: string | null
  jobSequence: number
  cloudHostId: string | null
  isStreaming: boolean
  activeView: ChatTileActiveView

  setMessagesSafe: (updater: SetStateAction<ChatMessage[]>) => void
  setInput: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
  setQueuedTurns: Dispatch<SetStateAction<QueuedChatTurn[]>>
  setOpenChatSurfaces: Dispatch<SetStateAction<ActiveChatSurface[]>>
  setActiveChatSurfaceId: Dispatch<SetStateAction<string | null>>
  setActiveView: Dispatch<SetStateAction<ChatTileActiveView>>
  setProvider: Dispatch<SetStateAction<string>>
  setModel: Dispatch<SetStateAction<string>>
  setExecutionTarget: Dispatch<SetStateAction<'local' | 'cloud'>>
  setMcpEnabled: Dispatch<SetStateAction<boolean>>
  setMode: Dispatch<SetStateAction<string>>
  setThinking: Dispatch<SetStateAction<string>>
  setAgentId: Dispatch<SetStateAction<string | null>>
  setAutoAgentMode: Dispatch<SetStateAction<boolean>>
  setPreserveSessionSummary: Dispatch<SetStateAction<boolean>>
  setLinkedSessionEntryId: Dispatch<SetStateAction<string | null>>
  setLinkedSessionHint: Dispatch<SetStateAction<SessionEntryHint | null>>
  setHasEarlierMessages: Dispatch<SetStateAction<boolean>>
  setSessionId: Dispatch<SetStateAction<string | null>>
  setSessionIdsByProvider: Dispatch<SetStateAction<Record<string, string>>>
  setJobId: Dispatch<SetStateAction<string | null>>
  setJobSequence: Dispatch<SetStateAction<number>>
  setCloudHostId: Dispatch<SetStateAction<string | null>>
  setIsStreaming: Dispatch<SetStateAction<boolean>>
  lastJobSequenceRef: MutableRefObject<number>
}

export interface UseChatTilePersistenceResult {
  latestStateRef: MutableRefObject<ChatTilePersistedState | null>
  stateLoadedRef: MutableRefObject<boolean>
  persistLatestState: (stateOverride?: ChatTilePersistedState | null) => void
}

export function useChatTilePersistence(options: UseChatTilePersistenceOptions): UseChatTilePersistenceResult {
  const {
    tileId,
    workspaceId,
    reloadToken,
    initialRuntimeStateRef,
    fallbackProvider,
    messages,
    input,
    attachments,
    queuedTurns,
    openChatSurfaces,
    activeChatSurfaceId,
    executionTarget,
    provider,
    model,
    mcpEnabled,
    mode,
    thinking,
    agentId,
    effectiveAgentMode,
    autoAgentMode,
    preserveSessionSummary,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    sessionId,
    sessionIdsByProvider,
    jobId,
    jobSequence,
    cloudHostId,
    isStreaming,
    activeView,
    setMessagesSafe,
    setInput,
    setAttachments,
    setQueuedTurns,
    setOpenChatSurfaces,
    setActiveChatSurfaceId,
    setActiveView,
    setProvider,
    setModel,
    setExecutionTarget,
    setMcpEnabled,
    setMode,
    setThinking,
    setAgentId,
    setAutoAgentMode,
    setPreserveSessionSummary,
    setLinkedSessionEntryId,
    setLinkedSessionHint,
    setHasEarlierMessages,
    setSessionId,
    setSessionIdsByProvider,
    setJobId,
    setJobSequence,
    setCloudHostId,
    setIsStreaming,
    lastJobSequenceRef,
  } = options

  const latestStateRef = useRef<ChatTilePersistedState | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateLoadedRef = useRef(false)
  const workspaceTileKey = JSON.stringify([workspaceId, tileId])
  const activeScopeKeyRef = useRef(workspaceTileKey)

  const persistLatestState = useCallback((stateOverride?: ChatTilePersistedState | null) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    const nextState = stateOverride ?? latestStateRef.current
    if (
      !workspaceId
      || !stateLoadedRef.current
      || !nextState
      || isChatTileRuntimeStateDisposed(workspaceId, tileId)
    ) return
    const persistedState = nextState.linkedSessionEntryId
      ? { ...nextState, messages: [] }
      : nextState
    void window.electron.canvas.saveTileState(workspaceId, tileId, persistedState).catch(() => {})
  }, [workspaceId, tileId])

  useEffect(() => {
    latestStateRef.current = {
      messages,
      input,
      attachments,
      queuedTurns,
      openChatSurfaces,
      activeChatSurfaceId,
      executionTarget,
      provider,
      model,
      mcpEnabled,
      mode,
      thinking,
      agentId,
      agentMode: effectiveAgentMode,
      autoAgentMode,
      preserveSessionSummary,
      linkedSessionEntryId,
      linkedSessionHint,
      hasEarlierMessages,
      sessionId,
      sessionIdsByProvider,
      jobId,
      jobSequence,
      cloudHostId,
      isStreaming,
      activeView,
    }
    if (
      stateLoadedRef.current
      && activeScopeKeyRef.current === workspaceTileKey
    ) {
      if (isChatTileRuntimeStateDisposed(workspaceId, tileId)) return
      setChatTileRuntimeState(workspaceId, tileId, latestStateRef.current)
    }
  }, [workspaceId, tileId, workspaceTileKey, messages, input, attachments, queuedTurns, openChatSurfaces, activeChatSurfaceId, executionTarget, provider, model, mcpEnabled, mode, thinking, agentId, effectiveAgentMode, autoAgentMode, preserveSessionSummary, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, sessionId, sessionIdsByProvider, jobId, jobSequence, cloudHostId, isStreaming, activeView])

  useEffect(() => {
    activeScopeKeyRef.current = workspaceTileKey
    reviveChatTileRuntimeState(workspaceId, tileId)
    stateLoadedRef.current = false

    const applySavedState = (saved: Partial<ChatTilePersistedState> | null | undefined) => {
      if (!saved) return
      if (Array.isArray(saved.messages)) setMessagesSafe(saved.messages)
      if (typeof saved.input === 'string') setInput(saved.input)
      if (Array.isArray(saved.attachments)) {
        setAttachments(saved.attachments.filter((item: PendingAttachment) => typeof item?.path === 'string').map((item: PendingAttachment) => ({
          path: item.path,
          kind: item.kind === 'image' || isImagePath(item.path) ? 'image' : 'file',
          ...(typeof item.capability === 'string' ? { capability: item.capability } : {}),
        })))
      }
      if (Array.isArray(saved.queuedTurns)) {
        setQueuedTurns(saved.queuedTurns.filter((item: QueuedChatTurn) => typeof item?.id === 'string' && typeof item?.content === 'string').map((item: QueuedChatTurn) => ({
          id: item.id,
          content: item.content,
          preview: typeof item.preview === 'string' ? item.preview : buildQueuedTurnPreview(item.content, Number(item.attachmentCount) || 0),
          attachmentCount: Number(item.attachmentCount) || 0,
          createdAt: Number(item.createdAt) || Date.now(),
          parentId: typeof item.parentId === 'string' ? item.parentId : null,
        })))
      }
      if (Array.isArray(saved.openChatSurfaces)) {
        const restoredSurfaces = normalizePersistedChatSurfaces(saved.openChatSurfaces)
        setOpenChatSurfaces(restoredSurfaces)
        if (typeof saved.activeChatSurfaceId === 'string' && restoredSurfaces.some(surface => surface.instanceId === saved.activeChatSurfaceId)) {
          setActiveChatSurfaceId(saved.activeChatSurfaceId)
        } else if (saved.activeChatSurfaceId === null) {
          setActiveChatSurfaceId(null)
        } else {
          setActiveChatSurfaceId(restoredSurfaces[restoredSurfaces.length - 1]?.instanceId ?? null)
        }
      } else if (saved.activeChatSurfaceId === null) {
        setActiveChatSurfaceId(null)
      }
      const savedProvider = typeof saved.provider === 'string' ? saved.provider : fallbackProvider
      if (saved.provider) setProvider(saved.provider)
      if (typeof saved.model === 'string') setModel(saved.model)
      if (saved.executionTarget === 'local' || saved.executionTarget === 'cloud') setExecutionTarget(saved.executionTarget)
      if (typeof saved.mcpEnabled === 'boolean') setMcpEnabled(saved.mcpEnabled)
      if (typeof saved.mode === 'string') setMode(resolveProviderModeId(savedProvider, saved.mode))
      if (typeof saved.thinking === 'string') setThinking(saved.thinking)
      if (typeof saved.agentId === 'string' || saved.agentId === null) setAgentId(saved.agentId ?? null)
      if (typeof saved.autoAgentMode === 'boolean') setAutoAgentMode(saved.autoAgentMode)
      if (typeof saved.preserveSessionSummary === 'boolean') setPreserveSessionSummary(saved.preserveSessionSummary)
      if (typeof saved.linkedSessionEntryId === 'string' || saved.linkedSessionEntryId === null) setLinkedSessionEntryId(saved.linkedSessionEntryId ?? null)
      if (saved.linkedSessionHint === null) {
        setLinkedSessionHint(null)
      } else if (saved.linkedSessionHint && typeof saved.linkedSessionHint === 'object') {
        const hint = saved.linkedSessionHint as Partial<SessionEntryHint>
        if (typeof hint.id === 'string' && typeof hint.source === 'string') {
          setLinkedSessionHint({
            id: hint.id,
            source: hint.source as SessionEntryHint['source'],
            filePath: typeof hint.filePath === 'string' ? hint.filePath : undefined,
            sessionId: typeof hint.sessionId === 'string' || hint.sessionId === null ? hint.sessionId : null,
            provider: typeof hint.provider === 'string' ? hint.provider : '',
            model: typeof hint.model === 'string' ? hint.model : '',
            messageCount: typeof hint.messageCount === 'number' ? hint.messageCount : 0,
            title: typeof hint.title === 'string' ? hint.title : '',
            projectPath: typeof hint.projectPath === 'string' || hint.projectPath === null ? hint.projectPath : null,
          })
        }
      }
      if (typeof saved.hasEarlierMessages === 'boolean') setHasEarlierMessages(saved.hasEarlierMessages)
      else if (saved.linkedSessionEntryId == null) setHasEarlierMessages(false)
      if (saved.sessionIdsByProvider && typeof saved.sessionIdsByProvider === 'object') {
        setSessionIdsByProvider({ ...saved.sessionIdsByProvider })
        const restoredProvider = typeof saved.provider === 'string' ? saved.provider : fallbackProvider
        const restoredSessionId = saved.sessionIdsByProvider[restoredProvider] ?? saved.sessionId ?? null
        setSessionId(typeof restoredSessionId === 'string' ? restoredSessionId : null)
      } else if (typeof saved.sessionId === 'string' || saved.sessionId === null) {
        setSessionId(saved.sessionId)
        const restoredProvider = typeof saved.provider === 'string' ? saved.provider : fallbackProvider
        if (saved.sessionId) {
          setSessionIdsByProvider({ [restoredProvider]: saved.sessionId })
        }
      }
      if (typeof saved.jobId === 'string' || saved.jobId === null) setJobId(saved.jobId ?? null)
      if (typeof saved.jobSequence === 'number') {
        setJobSequence(saved.jobSequence)
        lastJobSequenceRef.current = saved.jobSequence
      }
      if (typeof saved.cloudHostId === 'string' || saved.cloudHostId === null) setCloudHostId(saved.cloudHostId ?? null)
      if (typeof saved.isStreaming === 'boolean') {
        setIsStreaming(saved.isStreaming && Boolean(saved.jobId))
      }
      if (saved.activeView !== undefined) setActiveView(normalizeActiveView(saved.activeView))
    }

    const cached = reloadToken > 0
      ? getChatTileRuntimeState<ChatTilePersistedState>(workspaceId, tileId)
      : (
          initialRuntimeStateRef.current
          ?? getChatTileRuntimeState<ChatTilePersistedState>(workspaceId, tileId)
        )
    if (cached) {
      applySavedState(cached)
      stateLoadedRef.current = true
      return
    }

    if (!workspaceId) {
      stateLoadedRef.current = true
      return
    }

    let cancelled = false
    window.electron.canvas.loadTileState<Partial<ChatTilePersistedState> | null>(workspaceId, tileId).then(saved => {
      if (!cancelled) applySavedState(saved)
    }).catch(() => {}).finally(() => {
      if (!cancelled) stateLoadedRef.current = true
    })
    return () => { cancelled = true }
  }, [workspaceId, tileId, workspaceTileKey, reloadToken])

  useEffect(() => {
    if (!stateLoadedRef.current) return
    if (!workspaceId || !linkedSessionEntryId) return
    if (isStreaming) return

    const usePagedHistory = canUsePagedLinkedHistory(linkedSessionEntryId, linkedSessionHint, sessionId)
    let cancelled = false
    void window.electron.canvas.getSessionState(workspaceId, linkedSessionEntryId, {
      entryHint: linkedSessionHint ?? null,
      tailLimit: usePagedHistory ? LINKED_SESSION_HISTORY_PAGE_SIZE : undefined,
    })
      .then((raw: unknown) => {
        const saved = raw as Partial<ChatTilePersistedState> | null
        if (cancelled || !saved) return
        const savedProvider = typeof saved.provider === 'string'
          ? saved.provider
          : (latestStateRef.current?.provider ?? DEFAULT_PROVIDER_ID)
        if (Array.isArray(saved.messages)) setMessagesSafe(saved.messages)
        if (typeof saved.provider === 'string') setProvider(saved.provider)
        if (typeof saved.model === 'string') setModel(saved.model)
        if (typeof saved.mode === 'string') setMode(resolveProviderModeId(savedProvider, saved.mode))
        if (typeof saved.hasEarlierMessages === 'boolean') setHasEarlierMessages(saved.hasEarlierMessages)
        if (typeof saved.sessionId === 'string' || saved.sessionId === null) setSessionId(saved.sessionId ?? null)
        if (saved.executionTarget === 'local' || saved.executionTarget === 'cloud') setExecutionTarget(saved.executionTarget)
        if (typeof saved.cloudHostId === 'string' || saved.cloudHostId === null) setCloudHostId(saved.cloudHostId ?? null)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [workspaceId, linkedSessionEntryId, linkedSessionHint, reloadToken, isStreaming, sessionId, setMessagesSafe])

  useEffect(() => {
    if (
      !workspaceId
      || !stateLoadedRef.current
      || isChatTileRuntimeStateDisposed(workspaceId, tileId)
    ) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      persistLatestState()
    }, isStreaming ? 2000 : 500)

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
    }
  }, [workspaceId, tileId, messages, input, attachments, queuedTurns, openChatSurfaces, activeChatSurfaceId, executionTarget, provider, model, mcpEnabled, mode, thinking, agentId, effectiveAgentMode, autoAgentMode, preserveSessionSummary, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, sessionId, jobId, jobSequence, cloudHostId, isStreaming, activeView, persistLatestState])

  useEffect(() => {
    const handleBeforeUnload = (): void => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      const latest = latestStateRef.current
      if (latest && !isChatTileRuntimeStateDisposed(workspaceId, tileId)) {
        persistLatestState(latest)
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      const latest = latestStateRef.current
      if (!latest) return
      if (isChatTileRuntimeStateDisposed(workspaceId, tileId)) return
      setChatTileRuntimeState(workspaceId, tileId, latest)
      persistLatestState(latest)
    }
  }, [workspaceId, tileId, persistLatestState])

  return {
    latestStateRef,
    stateLoadedRef,
    persistLatestState,
  }
}
