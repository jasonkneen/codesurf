/**
 * ChatTile UI orchestration — domain hooks that are not session-core.
 * Keeps ChatTile primarily layout/chrome composition.
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import type { AppSettings } from '../../../shared/types'
import type { ChatMessage } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import type { DiscoveryPeer } from '../components/chat/chatTileUtils'
import { useChatGitState } from './useChatGitState'
import { useAutoSpeak } from './useAutoSpeak'
import { ttsPlayer, type TtsPlayerState } from '../utils/ttsPlayer'
import { useChatDictation } from './useChatDictation'
import { useChatExecutionHosts } from './useChatExecutionHosts'
import { useChatTileProviders } from './useChatTileProviders'
import { useChatTilePersistence } from './useChatTilePersistence'
import { useChatTileBlockNotes } from './useChatTileBlockNotes'
import { useChatTileLatestChangeDrawer } from './useChatTileLatestChangeDrawer'
import { useChatTileComposerMenus } from './useChatTileComposerMenus'
import { useChatTileLiveComposerActivity } from './useChatTileLiveComposerActivity'
import { useChatTilePeerContext } from './useChatTilePeerContext'
import { useChatTileInventories } from './useChatTileInventories'
import { useChatTileWorkspaceSkills } from './useChatTileWorkspaceSkills'
import { useChatTileLifecycleEffects } from './useChatTileLifecycleEffects'
import { useChatTileContextUsage } from './useChatTileContextUsage'
import { useChatTileGitMenus } from './useChatTileGitMenus'
import { useChatTileSurfaces } from './useChatTileSurfaces'
import { useChatTileAgentModes } from './useChatTileAgentModes'
import { useChatAutocomplete } from './useChatAutocomplete'
import { useChatTileDreamPolling } from './useChatTileDreamPolling'
import { useTileTodos } from '../state/tileTodosStore'
import { useContributions } from './useContributions'
import type { PaletteCommand } from '../lib/commandRegistry'
import { ensureChatMdStyle } from '../components/chat/ChatTileViews'
import type { ChatTilePersistedState, ChatTileActiveView, QueuedChatTurn } from '../components/chat/chatTileTypes'
import type { ActiveChatSurface, PendingAttachment } from '../components/chat/chatTileUtils'
import type { MutableRefObject, Dispatch, SetStateAction } from 'react'

export interface UseChatTileShellModelOptions {
  tileId: string
  workspaceId: string
  workspaceDir: string
  reloadToken: number
  settings?: AppSettings
  connectedPeers: DiscoveryPeer[]
  isConnected?: boolean
  isAutoConnected?: boolean
  // session core slice
  initialRuntimeStateRef: MutableRefObject<ChatTilePersistedState | null>
  initialMode: string
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
  swapProviderSession: (from: string, to: string) => void
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
  toolCompletedAtRef: MutableRefObject<Map<string, number>>
  pagedLinkedHistoryEnabled: boolean
  hasStreamingContent: boolean
  isStreamingRef: MutableRefObject<boolean>
  setMessagesSafe: (updater: SetStateAction<ChatMessage[]>) => void
  lastJobSequenceRef: MutableRefObject<number>
  resumedJobKeyRef: MutableRefObject<string | null>
  historicalMessages: ChatMessage[]
  setHistoricalMessages: Dispatch<SetStateAction<ChatMessage[]>>
  allMessages: ChatMessage[]
  renderedMessages: ChatMessage[]
  chatSurfaceThemeColors: Record<string, string>
  chatSurfaceThemeVars: Record<string, string>
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  acRef: MutableRefObject<HTMLDivElement | null>
}

export function useChatTileShellModel(opts: UseChatTileShellModelOptions) {
  const {
    tileId, workspaceId, workspaceDir, reloadToken, settings, connectedPeers,
    isConnected, isAutoConnected,
    initialRuntimeStateRef, initialMode,
    messages, setMessages, input, setInput, isStreaming, setIsStreaming,
    executionTarget, setExecutionTarget, cloudHostId, setCloudHostId,
    provider, setProvider, model, setModel, mcpEnabled, setMcpEnabled,
    mode, setMode, thinking, setThinking, agentId, setAgentId, autoAgentMode, setAutoAgentMode,
    attachments, setAttachments, queuedTurns, setQueuedTurns,
    openChatSurfaces, setOpenChatSurfaces, activeChatSurfaceId, setActiveChatSurfaceId,
    sessionId, setSessionId, sessionIdsByProvider, setSessionIdsByProvider, swapProviderSession,
    jobId, setJobId, jobSequence, setJobSequence,
    linkedSessionEntryId, setLinkedSessionEntryId, linkedSessionHint, setLinkedSessionHint,
    preserveSessionSummary, setPreserveSessionSummary, hasEarlierMessages, setHasEarlierMessages,
    activeView, setActiveView,
    lastActivityAtRef, toolCollapseTick, setToolCollapseTick, toolCompletedAtRef,
    pagedLinkedHistoryEnabled, hasStreamingContent, isStreamingRef, setMessagesSafe,
    lastJobSequenceRef, resumedJobKeyRef,
    historicalMessages, setHistoricalMessages, allMessages, renderedMessages,
    chatSurfaceThemeColors, chatSurfaceThemeVars,
    textareaRef, acRef,
  } = opts

  const { workspaceSkills } = useChatTileWorkspaceSkills(workspaceDir)
  const { peerContextRef, peerContextVersion, implicitPeerImageAttachments } = useChatTilePeerContext({
    tileId, workspaceId, connectedPeers,
  })
  const { mcpServers, peerToolNames } = useChatTileInventories({
    tileId, provider, model, mcpEnabled, connectedPeers, workspaceSkills,
  })
  const [disabledServers, setDisabledServers] = useState<Set<string>>(new Set())
  const lastPushedModeRef = useRef<string>(initialMode)
  const effectiveAgentMode = Boolean(isConnected || isAutoConnected || autoAgentMode)
  const closeProviderMenuRef = useRef<() => void>(() => {})
  const closeAutocompleteRef = useRef<() => void>(() => {})

  const {
    providerEntries, providerEntryById, currentProviderEntry,
    modeOptions, currentMode, optionNoun, currentModel, thinkingOptions,
    handleProviderChange,
  } = useChatTileProviders({
    provider, setProvider, model, setModel, mode, setMode, thinking, setThinking,
    settings, connectedPeers, peerContextRef, peerContextVersion,
    onProviderChanged: () => closeProviderMenuRef.current(),
    swapProviderSession,
  })

  const menus = useChatTileComposerMenus({
    textareaRef, acRef,
    onCloseAutocomplete: () => closeAutocompleteRef.current(),
  })
  closeProviderMenuRef.current = () => menus.setShowProviderMenu(false)

  const {
    agentModes, agentModesLoaded, resolvedAgentMode, modelLock,
  } = useChatTileAgentModes({
    workspaceDir, agentId, showAgentMenu: menus.showAgentMenu,
    workspaceSkills, setProvider, setModel,
  })

  const surfaces = useChatTileSurfaces({
    tileId, workspaceId, workspaceDir,
    openChatSurfaces, setOpenChatSurfaces, activeChatSurfaceId, setActiveChatSurfaceId,
    setShowInsertMenu: menus.setShowInsertMenu,
    chatSurfaceThemeColors, chatSurfaceThemeVars,
  })

  const execution = useChatExecutionHosts({
    executionPreference: settings?.execution ?? null,
    executionTarget, cloudHostId,
  })

  const hasSendableDraft = input.trim().length > 0 || attachments.length > 0 || implicitPeerImageAttachments.length > 0
  const [draggingTurnId, setDraggingTurnId] = useState<string | null>(null)
  const [dragOverTurn, setDragOverTurn] = useState<{ id: string; mode: 'before' | 'after' | 'into' } | null>(null)
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  const { gitStatus, gitBranches, refreshGitState } = useChatGitState(workspaceDir)

  const persistence = useChatTilePersistence({
    tileId, workspaceId, reloadToken, initialRuntimeStateRef,
    fallbackProvider: provider, messages, input, attachments, queuedTurns,
    openChatSurfaces, activeChatSurfaceId, executionTarget, provider, model, mcpEnabled,
    mode, thinking, agentId, effectiveAgentMode, autoAgentMode, preserveSessionSummary,
    linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, sessionId, sessionIdsByProvider,
    jobId, jobSequence, cloudHostId, isStreaming, activeView, setMessagesSafe,
    setInput, setAttachments, setQueuedTurns, setOpenChatSurfaces, setActiveChatSurfaceId, setActiveView,
    setProvider, setModel, setExecutionTarget, setMcpEnabled, setMode, setThinking, setAgentId,
    setAutoAgentMode, setPreserveSessionSummary, setLinkedSessionEntryId, setLinkedSessionHint,
    setHasEarlierMessages, setSessionId, setSessionIdsByProvider, setJobId, setJobSequence,
    setCloudHostId, setIsStreaming, lastJobSequenceRef,
  })

  const { updateBlockNote, exportNotesToClipboard } = useChatTileBlockNotes({
    allMessages, setMessagesSafe, setHistoricalMessages,
  })

  const voiceSettings = settings?.voice ?? {
    sttProvider: 'openai' as const,
    sttLang: 'en',
    ttsProvider: 'cartesia' as const,
    spokifyModel: 'claude-haiku-4-5-20251001',
    autoSpeak: 'off' as const,
    bargeIn: true,
  }
  const dictation = useChatDictation({ voiceSettings })
  const { isDictating, dictationText, dictationError, toggleDictation, clearDictationError } = dictation
  const autoSpeakEnabled = voiceSettings.autoSpeak === 'last-message'
  const [ttsState, setTtsState] = useState<TtsPlayerState>(() => ttsPlayer.state)
  useEffect(() => ttsPlayer.subscribe(setTtsState), [])

  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i]
    }
    return null
  }, [messages])

  useAutoSpeak({
    enabled: autoSpeakEnabled,
    messageId: lastAssistantMessage?.id ?? null,
    text: lastAssistantMessage?.content ?? null,
    isStreaming: Boolean(lastAssistantMessage?.isStreaming) || hasStreamingContent,
    ttsProvider: voiceSettings.ttsProvider,
    ttsVoice: voiceSettings.ttsVoice,
    spokifyModel: voiceSettings.spokifyModel,
  })

  const planTodos = useTileTodos(tileId)
  const [isPlanOpen, setIsPlanOpen] = useState(false)
  useEffect(() => {
    if (!planTodos || planTodos.length === 0) setIsPlanOpen(false)
  }, [planTodos])
  const [planUpdatedAt, setPlanUpdatedAt] = useState<number | null>(null)
  useEffect(() => {
    if (planTodos && planTodos.length > 0) setPlanUpdatedAt(Date.now())
  }, [planTodos])

  const pluginCommands = useContributions('commands') as PaletteCommand[]
  const pluginSlashCommands = useMemo(
    () => pluginCommands
      .filter(c => typeof c.slash === 'string' && c.slash.trim())
      .map(c => ({ slash: c.slash as string, title: c.title })),
    [pluginCommands],
  )
  // pluginCommands itself is needed by messaging slash dispatch

  const autocomplete = useChatAutocomplete({
    workspaceDir, connectedPeers, workspaceSkills, pluginSlashCommands,
  })
  closeAutocompleteRef.current = () => {
    autocomplete.setAcType(null)
    autocomplete.setAcQuery('')
  }

  const latestChange = useChatTileLatestChangeDrawer({
    workspaceId, tileId, messages, setMessagesSafe,
  })

  const liveComposerActivityChip = useChatTileLiveComposerActivity({
    isStreaming, renderedMessages,
  })

  useChatTileDreamPolling(workspaceId, setMessagesSafe)
  useEffect(() => { ensureChatMdStyle() }, [])

  useChatTileLifecycleEffects({
    workspaceId, tileId, sessionId, linkedSessionEntryId, provider, model, mode,
    workspaceDir, executionTarget, cloudHostId,
    settingsExecution: settings?.execution ?? null,
    jobId, jobSequence, isStreaming, isStreamingRef, messages, historicalMessages,
    allMessages, queuedTurnsLength: queuedTurns.length, pagedLinkedHistoryEnabled,
    stateLoadedRef: persistence.stateLoadedRef, lastActivityAtRef, lastPushedModeRef,
    toolCompletedAtRef, toolCollapseTick, setToolCollapseTick, setMessages, setMessagesSafe,
    setQueueCollapsed, resumedJobKeyRef,
  })

  const contextUsage = useChatTileContextUsage({ provider, model, messages, input })
  const locationLabel = execution.executionDisplayLabel
  const gitMenus = useChatTileGitMenus({
    workspaceDir, workspaceId, executionTarget,
    executionTargetCloud: executionTarget === 'cloud',
    executionDisplayDetail: execution.executionDisplayDetail,
    gitStatus, gitBranches, refreshGitState,
    branchFilter: menus.branchFilter, setBranchFilter: menus.setBranchFilter,
    setShowBranchMenu: menus.setShowBranchMenu,
    remoteHosts: execution.remoteHosts, cloudHostId, setCloudHostId, setMessages,
  })

  useEffect(() => {
    dictation.onTranscription((text: string) => {
      setInput(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + text)
    })
  }, [dictation, setInput])

  return {
    workspaceSkills, peerContextRef, peerContextVersion, implicitPeerImageAttachments,
    mcpServers, peerToolNames, disabledServers, setDisabledServers,
    lastPushedModeRef, effectiveAgentMode,
    closeProviderMenuRef, closeAutocompleteRef,
    providerEntries, providerEntryById, currentProviderEntry,
    modeOptions, currentMode, optionNoun, currentModel, thinkingOptions, handleProviderChange,
    ...menus,
    agentModes, agentModesLoaded, resolvedAgentMode, modelLock,
    ...surfaces,
    ...execution,
    hasSendableDraft, draggingTurnId, setDraggingTurnId, dragOverTurn, setDragOverTurn,
    queueCollapsed, setQueueCollapsed,
    gitStatus, gitBranches, refreshGitState,
    ...persistence,
    updateBlockNote, exportNotesToClipboard,
    voiceSettings, dictation, isDictating, dictationText, dictationError, toggleDictation, clearDictationError,
    autoSpeakEnabled, ttsState, lastAssistantMessage,
    planTodos, isPlanOpen, setIsPlanOpen, planUpdatedAt,
    pluginCommands, pluginSlashCommands,
    ...autocomplete,
    ...latestChange,
    liveComposerActivityChip,
    ...contextUsage,
    locationLabel,
    ...gitMenus,
  }
}
