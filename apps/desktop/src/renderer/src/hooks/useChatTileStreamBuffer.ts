import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ChatMessage } from '../../../shared/chat-types'
import { normalizeMessagesForMemory } from '../components/chat/messageNormalization'
import { CHAT_STREAM_FLUSH_INTERVAL_MS } from '../components/chat/largeContent'
import { appendStreamingAssistantText } from '../components/chat/chatMessagesStore'

export function useChatTileStreamBuffer(options: {
  workspaceId: string
  tileId: string
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  pagedLinkedHistoryEnabled: boolean
  isStreaming: boolean
}) {
  const {
    workspaceId,
    tileId,
    setMessages,
    pagedLinkedHistoryEnabled,
    isStreaming,
  } = options
  const pagedLinkedHistoryEnabledRef = useRef(pagedLinkedHistoryEnabled)
  pagedLinkedHistoryEnabledRef.current = pagedLinkedHistoryEnabled
  const isStreamingRef = useRef(false)
  const pendingStreamTextRef = useRef('')
  const pendingStreamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setMessagesSafe = useCallback((updater: React.SetStateAction<ChatMessage[]>) => {
    setMessages(prev => {
      const next = typeof updater === 'function'
        ? (updater as (prev: ChatMessage[]) => ChatMessage[])(prev)
        : updater
      if (pagedLinkedHistoryEnabledRef.current) return next
      if (isStreamingRef.current && next.length === prev.length && next[next.length - 1]?.isStreaming) {
        return next
      }
      return normalizeMessagesForMemory(next)
    })
  }, [setMessages])

  const flushPendingStreamText = useCallback(() => {
    const text = pendingStreamTextRef.current
    if (!text) return
    pendingStreamTextRef.current = ''
    // Pure-text flush goes through the isolation store so chrome snapshots stay
    // stable; setMessages is the same store-backed updater from core state.
    appendStreamingAssistantText(workspaceId, tileId, text)
  }, [workspaceId, tileId])

  const queueStreamText = useCallback((text: string) => {
    if (!text) return
    pendingStreamTextRef.current += text
    if (pendingStreamFlushTimerRef.current) return
    pendingStreamFlushTimerRef.current = setTimeout(() => {
      pendingStreamFlushTimerRef.current = null
      flushPendingStreamText()
    }, CHAT_STREAM_FLUSH_INTERVAL_MS)
  }, [flushPendingStreamText])

  useEffect(() => () => {
    if (pendingStreamFlushTimerRef.current) {
      clearTimeout(pendingStreamFlushTimerRef.current)
      pendingStreamFlushTimerRef.current = null
    }
    pendingStreamTextRef.current = ''
  }, [])

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  return {
    isStreamingRef,
    setMessagesSafe,
    queueStreamText,
    flushPendingStreamText,
  }
}
