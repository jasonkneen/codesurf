import { useLayoutEffect, useMemo, useSyncExternalStore, type RefObject } from 'react'
import type { ChatMessage } from '../../../shared/chat-types.ts'
import {
  getTileMessagesSnapshot,
  subscribeTileMessages,
} from '../components/chat/chatMessagesStore.ts'

export function mergeLiveTranscriptMessages(
  renderedMessages: ChatMessage[],
  liveMessages: readonly ChatMessage[],
): ChatMessage[] {
  if (renderedMessages.length === 0 || liveMessages.length === 0) return renderedMessages
  const liveById = new Map(liveMessages.map(message => [message.id, message]))
  let changed = false
  const merged = renderedMessages.map(message => {
    const live = liveById.get(message.id)
    if (!live || live === message) return message
    changed = true
    return live
  })
  return changed ? merged : renderedMessages
}

export function useTileTranscriptMessages(options: {
  workspaceId: string
  tileId: string
  renderedMessages: ChatMessage[]
  messagesRef: RefObject<HTMLDivElement | null>
  stickToBottomRef: RefObject<boolean>
}): ChatMessage[] {
  const {
    workspaceId,
    tileId,
    renderedMessages,
    messagesRef,
    stickToBottomRef,
  } = options
  const snapshot = useSyncExternalStore(
    listener => subscribeTileMessages(workspaceId, tileId, listener),
    () => getTileMessagesSnapshot(workspaceId, tileId),
    () => getTileMessagesSnapshot(workspaceId, tileId),
  )
  const merged = useMemo(
    () => mergeLiveTranscriptMessages(renderedMessages, snapshot.messages),
    [renderedMessages, snapshot],
  )

  useLayoutEffect(() => {
    const el = messagesRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messagesRef, snapshot.revision, stickToBottomRef])

  return merged
}
