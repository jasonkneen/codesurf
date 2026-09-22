/**
 * ChatTile send-path orchestration: messaging, attachments, autocomplete pick,
 * composer keys, and height sync.
 */

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AppSettings } from '../../../shared/types'
import type { ChatMessage } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import type {
  ActiveChatSurface,
  DiscoveryPeer,
  PendingAttachment,
} from '../components/chat/chatTileUtils'
import type { ChatTilePersistedState, QueuedChatTurn } from '../components/chat/chatTileTypes'
import type { PaletteCommand } from '../lib/commandRegistry'
import { CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT } from '../components/chat/chatTileLayout'
import {
  useChatTileMessaging,
  type UseChatTileMessagingOptions,
} from './useChatTileMessaging'
import { useChatTileAttachments } from './useChatTileAttachments'
import { useChatAutocompleteSelection } from './useChatAutocompleteSelection'
import { useChatTileComposerKeys } from './useChatTileComposerKeys'
import type { AutocompleteItem } from './useChatAutocomplete'
import type { AgentMode } from '../../../shared/types'
import type { ProviderEntry } from './useChatTileProviders'

export type UseChatTileSendPathOptions = Omit<
  UseChatTileMessagingOptions,
  'focusComposer' | 'setAcType' | 'setAcQuery'
> & {
  setAcType: (type: 'slash' | 'mention' | null) => void
  setAcQuery: (query: string) => void
  acType: 'slash' | 'mention' | null
  acItems: AutocompleteItem[]
  acIndex: number
  setAcIndex: Dispatch<SetStateAction<number>>
  isDictating: boolean
  toggleDictation: () => void
  handleComposerInputChange: (
    e: React.ChangeEvent<HTMLTextAreaElement>,
    setInput: Dispatch<SetStateAction<string>>,
    syncHeight: () => void,
  ) => void
  setShowInsertMenu: Dispatch<SetStateAction<boolean>>
}

export function useChatTileSendPath(opts: UseChatTileSendPathOptions) {
  const {
    textareaRef,
    setAttachments,
    setAcType,
    setAcQuery,
    setShowInsertMenu,
    handleComposerInputChange,
    setInput,
    input,
    acType,
    acItems,
    acIndex,
    setAcIndex,
    isDictating,
    toggleDictation,
  } = opts

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = ta.value.length
      ta.setSelectionRange(pos, pos)
    })
  }, [textareaRef])

  const syncComposerHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT, Math.min(ta.scrollHeight, 134))}px`
  }, [textareaRef])

  const messaging = useChatTileMessaging({
    tileId: opts.tileId,
    workspaceId: opts.workspaceId,
    workspaceDir: opts.workspaceDir,
    settings: opts.settings,
    isStreaming: opts.isStreaming,
    input: opts.input,
    attachments: opts.attachments,
    implicitPeerImageAttachments: opts.implicitPeerImageAttachments,
    queuedTurns: opts.queuedTurns,
    messages: opts.messages,
    provider: opts.provider,
    model: opts.model,
    mode: opts.mode,
    thinking: opts.thinking,
    agentId: opts.agentId,
    resolvedAgentMode: opts.resolvedAgentMode,
    agentModesLoaded: opts.agentModesLoaded,
    sessionId: opts.sessionId,
    mcpEnabled: opts.mcpEnabled,
    executionTarget: opts.executionTarget,
    cloudHostId: opts.cloudHostId,
    effectiveAgentMode: opts.effectiveAgentMode,
    autoAgentMode: opts.autoAgentMode,
    linkedSessionEntryId: opts.linkedSessionEntryId,
    linkedSessionHint: opts.linkedSessionHint,
    hasEarlierMessages: opts.hasEarlierMessages,
    connectedPeers: opts.connectedPeers,
    peerContextRef: opts.peerContextRef,
    peerToolNames: opts.peerToolNames,
    providerEntryById: opts.providerEntryById,
    currentProviderEntry: opts.currentProviderEntry,
    activeCloudHost: opts.activeCloudHost,
    latestStateRef: opts.latestStateRef,
    persistLatestState: opts.persistLatestState,
    lastJobSequenceRef: opts.lastJobSequenceRef,
    resumedJobKeyRef: opts.resumedJobKeyRef,
    stickToBottomRef: opts.stickToBottomRef,
    activeChatSurfaceRef: opts.activeChatSurfaceRef,
    openChatSurfacesRef: opts.openChatSurfacesRef,
    textareaRef,
    setMessagesSafe: opts.setMessagesSafe,
    setInput: opts.setInput,
    setAttachments: opts.setAttachments,
    setQueuedTurns: opts.setQueuedTurns,
    setOpenChatSurfaces: opts.setOpenChatSurfaces,
    setActiveChatSurfaceId: opts.setActiveChatSurfaceId,
    setIsStreaming: opts.setIsStreaming,
    setJobId: opts.setJobId,
    setJobSequence: opts.setJobSequence,
    setPreserveSessionSummary: opts.setPreserveSessionSummary,
    setAcType,
    setAcQuery,
    focusComposer,
    getChatSurfaceIframe: opts.getChatSurfaceIframe,
    postToChatSurface: opts.postToChatSurface,
    exportNotesToClipboard: opts.exportNotesToClipboard,
    pluginCommands: opts.pluginCommands,
  })

  const attachmentsApi = useChatTileAttachments({
    textareaRef,
    workspaceId: opts.workspaceId,
    cardId: opts.tileId,
    syncComposerHeight,
    setAttachments,
    setAcType,
    setAcQuery,
    setShowInsertMenu,
  })

  const { selectAcItem } = useChatAutocompleteSelection({
    input,
    acType,
    textareaRef,
    syncComposerHeight,
    setInput,
    setAttachments,
    setAcType,
    setAcQuery,
  })

  const { handleKeyDown, handleKeyUp } = useChatTileComposerKeys({
    input,
    isDictating,
    toggleDictation,
    acType,
    acItems,
    acIndex,
    setAcIndex,
    setAcType,
    setAcQuery,
    selectAcItem,
    sendMessage: messaging.sendMessage,
  })

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleComposerInputChange(e, setInput, syncComposerHeight)
  }, [handleComposerInputChange, setInput, syncComposerHeight])

  return {
    focusComposer,
    syncComposerHeight,
    ...messaging,
    ...attachmentsApi,
    selectAcItem,
    handleKeyDown,
    handleKeyUp,
    handleInputChange,
  }
}

// Re-export types used by ChatTile callers for convenience
export type {
  AppSettings,
  ChatMessage,
  SessionEntryHint,
  ActiveChatSurface,
  DiscoveryPeer,
  PendingAttachment,
  ChatTilePersistedState,
  QueuedChatTurn,
  PaletteCommand,
  AgentMode,
  ProviderEntry,
  MutableRefObject,
  Dispatch,
  SetStateAction,
}
