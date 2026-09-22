/**
 * Chat tile session core — one orchestration point for:
 * core state, stream buffer, stream demux handler, and transcript window.
 *
 * Keeps ChatTile focused on composer / chrome UI while the stream path stays
 * a single composed unit (builds on chatMessagesStore + chatStreamHub).
 */

import { useEffect, useMemo, useRef } from 'react'
import type { AppSettings } from '../../../shared/types'
import { canUsePagedLinkedHistory, type DiscoveryPeer } from '../components/chat/chatTileUtils'
import { useChatStreamHandler } from './useChatStreamHandler'
import { useChatTileCoreState } from './useChatTileCoreState'
import { useChatTileStreamBuffer } from './useChatTileStreamBuffer'
import { useChatTileTranscript } from './useChatTileTranscript'

export interface UseChatTileSessionCoreOptions {
  tileId: string
  workspaceId: string
  settings?: AppSettings
}

export function useChatTileSessionCore(options: UseChatTileSessionCoreOptions) {
  const { tileId, workspaceId, settings } = options

  const core = useChatTileCoreState({ tileId, workspaceId, settings })
  const {
    initialJobSequence,
    messages,
    setMessages,
    isStreaming,
    setIsStreaming,
    sessionId,
    commitSessionId,
    jobId,
    setJobId,
    jobSequence,
    setJobSequence,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    setHasEarlierMessages,
    setPendingToolPermissions,
    setResolvedToolPermissions,
  } = core

  const pagedLinkedHistoryEnabled = canUsePagedLinkedHistory(
    linkedSessionEntryId,
    linkedSessionHint,
    sessionId,
  )

  const lastStreamingAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      if (m.isStreaming) return true
      if ((m.toolBlocks ?? []).some(tb => tb.status === 'running')) return true
      if (m.thinking && !m.thinking.done) return true
      if ((m.thinkingBlocks ?? []).some(tb => !tb.done)) return true
      return false
    }
    return false
  }, [messages])

  const hasStreamingContent = isStreaming || lastStreamingAssistantMessage

  const {
    isStreamingRef,
    setMessagesSafe,
    queueStreamText,
    flushPendingStreamText,
  } = useChatTileStreamBuffer({
    workspaceId,
    tileId,
    setMessages,
    pagedLinkedHistoryEnabled,
    isStreaming: hasStreamingContent,
  })

  const lastJobSequenceRef = useRef<number>(initialJobSequence)
  const resumedJobKeyRef = useRef<string | null>(null)

  useEffect(() => {
    lastJobSequenceRef.current = jobSequence
  }, [jobSequence])

  useEffect(() => {
    if (!jobId) {
      resumedJobKeyRef.current = null
    }
  }, [jobId])

  useChatStreamHandler({
    workspaceId,
    tileId,
    setMessagesSafe,
    // Prefer commitSessionId so provider session maps stay in sync (same as ChatTile).
    setSessionId: commitSessionId,
    setIsStreaming,
    setJobId,
    setJobSequence,
    flushPendingStreamText,
    queueStreamText,
    lastJobSequenceRef,
    setPendingToolPermissions,
    setResolvedToolPermissions,
  })

  const transcript = useChatTileTranscript({
    workspaceId,
    sessionId,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    setHasEarlierMessages,
    messages,
    setMessages,
    pagedLinkedHistoryEnabled,
    isStreaming,
  })

  return {
    ...core,
    pagedLinkedHistoryEnabled,
    hasStreamingContent,
    lastStreamingAssistantMessage,
    isStreamingRef,
    setMessagesSafe,
    queueStreamText,
    flushPendingStreamText,
    lastJobSequenceRef,
    resumedJobKeyRef,
    ...transcript,
  }
}

export type { DiscoveryPeer }
