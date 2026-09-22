import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { ChatMessage } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import { buildChatMessageHistoryFingerprint } from '../../../shared/chat-history'
import { mergeHistoricalMessages } from '../components/chat/chatTileUtils'
import {
  CHAT_INITIAL_RENDER_WINDOW,
  LINKED_SESSION_LIVE_TAIL_LIMIT,
  LINKED_SESSION_HISTORY_PAGE_SIZE,
  LINKED_SESSION_HISTORY_LOAD_THRESHOLD,
  CHAT_AUTO_SCROLL_THRESHOLD,
} from '../components/chat/chatTileLayout'
import {
  selectTranscriptWindow,
  expandTranscriptWindow,
  resetTranscriptWindow,
} from '../components/chat/transcriptWindow'

export interface UseChatTileTranscriptOptions {
  workspaceId: string
  sessionId: string | null
  linkedSessionEntryId: string | null
  linkedSessionHint: SessionEntryHint | null
  hasEarlierMessages: boolean
  setHasEarlierMessages: Dispatch<SetStateAction<boolean>>
  messages: ChatMessage[]
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  pagedLinkedHistoryEnabled: boolean
  isStreaming: boolean
}

export interface UseChatTileTranscriptResult {
  messagesRef: MutableRefObject<HTMLDivElement | null>
  stickToBottomRef: MutableRefObject<boolean>
  historicalMessages: ChatMessage[]
  setHistoricalMessages: Dispatch<SetStateAction<ChatMessage[]>>
  allMessages: ChatMessage[]
  renderedMessages: ChatMessage[]
  hiddenMessageCount: number
  loadingEarlier: boolean
  earlierLoadError: string | null
  showScrollToLatest: boolean
  scrollToLatest: (behavior?: ScrollBehavior) => void
  reviewLatestChanges: () => void
  handleMessagesScroll: () => void
  handleMessagesWheel: (ev: React.WheelEvent<HTMLDivElement>) => void
  handleMessagesKeyDown: (ev: React.KeyboardEvent<HTMLDivElement>) => void
  setAnnotationComposerActive: (active: boolean) => void
}

export function useChatTileTranscript(options: UseChatTileTranscriptOptions): UseChatTileTranscriptResult {
  const {
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
  } = options

  const [historicalMessages, setHistoricalMessages] = useState<ChatMessage[]>([])
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(CHAT_INITIAL_RENDER_WINDOW)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierLoadError, setEarlierLoadError] = useState<string | null>(null)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)

  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef<number>(0)
  const showScrollToLatestRef = useRef(false)
  const programmaticScrollToLatestRef = useRef(false)
  const pendingHistoryPrependRef = useRef<{ previousHeight: number; previousTop: number } | null>(null)
  const loadEarlierMessagesRef = useRef<() => Promise<void>>(async () => {})
  const annotationComposerActiveRef = useRef(false)

  const loadEarlierMessages = useCallback(async () => {
    if (!pagedLinkedHistoryEnabled || !workspaceId || !linkedSessionEntryId || !hasEarlierMessages || loadingEarlier) return
    const api = window.electron?.chat?.loadSessionHistory
    if (typeof api !== 'function') {
      setEarlierLoadError('History loader unavailable')
      return
    }

    const oldestLoadedMessage = historicalMessages[0] ?? messages[0] ?? null
    const beforeFingerprint = oldestLoadedMessage
      ? buildChatMessageHistoryFingerprint(oldestLoadedMessage)
      : null
    const scroller = messagesRef.current
    if (scroller) {
      pendingHistoryPrependRef.current = {
        previousHeight: scroller.scrollHeight,
        previousTop: scroller.scrollTop,
      }
    }

    setLoadingEarlier(true)
    setEarlierLoadError(null)
    try {
      const res = await api({
        workspaceId,
        sessionEntryId: linkedSessionEntryId,
        entryHint: linkedSessionHint ?? null,
        beforeFingerprint,
        limit: LINKED_SESSION_HISTORY_PAGE_SIZE,
      })
      if (!res?.ok || !Array.isArray(res.messages)) {
        setEarlierLoadError(res?.error || 'Could not load earlier messages')
        pendingHistoryPrependRef.current = null
        return
      }
      const liveFingerprints = new Set(messages.map(message => buildChatMessageHistoryFingerprint(message)))
      const olderPage = (res.messages as ChatMessage[]).filter(message => !liveFingerprints.has(buildChatMessageHistoryFingerprint(message)))
      if (olderPage.length === 0) {
        pendingHistoryPrependRef.current = null
      } else {
        setHistoricalMessages(prev => mergeHistoricalMessages(prev, olderPage))
      }
      setHasEarlierMessages(res.hasMore === true)
    } catch (err: unknown) {
      pendingHistoryPrependRef.current = null
      const message = err instanceof Error ? err.message : String(err ?? 'Load failed')
      setEarlierLoadError(message)
    } finally {
      setLoadingEarlier(false)
    }
  }, [pagedLinkedHistoryEnabled, workspaceId, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, loadingEarlier, historicalMessages, messages, setHasEarlierMessages])

  useEffect(() => {
    loadEarlierMessagesRef.current = loadEarlierMessages
  }, [loadEarlierMessages])

  const { rendered: renderedMessages, combined: allMessages, hiddenCount: hiddenMessageCount } = useMemo(
    () => selectTranscriptWindow(messages, historicalMessages, visibleMessageLimit),
    [historicalMessages, messages, visibleMessageLimit],
  )

  useEffect(() => {
    if (!pagedLinkedHistoryEnabled || isStreaming) return
    if (messages.length <= LINKED_SESSION_LIVE_TAIL_LIMIT) return

    const overflowCount = messages.length - LINKED_SESSION_LIVE_TAIL_LIMIT
    if (overflowCount <= 0) return

    const overflowMessages = messages.slice(0, overflowCount)
    if (overflowMessages.length === 0) return

    setHistoricalMessages(prev => mergeHistoricalMessages(prev, overflowMessages))
    setMessages(prev => prev.slice(-LINKED_SESSION_LIVE_TAIL_LIMIT))
    setHasEarlierMessages(true)
  }, [pagedLinkedHistoryEnabled, isStreaming, messages, setMessages, setHasEarlierMessages])

  useEffect(() => {
    setHistoricalMessages([])
    setEarlierLoadError(null)
    pendingHistoryPrependRef.current = null
  }, [sessionId, linkedSessionEntryId])

  const isNearLatest = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_AUTO_SCROLL_THRESHOLD
  }, [])

  const syncScrollToLatestVisibility = useCallback((next: boolean) => {
    if (showScrollToLatestRef.current === next) return
    showScrollToLatestRef.current = next
    setShowScrollToLatest(next)
  }, [])

  const scrollToLatest = useCallback((behavior?: ScrollBehavior) => {
    const el = messagesRef.current
    if (!el) return
    stickToBottomRef.current = true
    programmaticScrollToLatestRef.current = true
    syncScrollToLatestVisibility(false)
    const resolvedBehavior = behavior ?? (isStreaming ? 'auto' : 'smooth')
    el.scrollTo({ top: el.scrollHeight, behavior: resolvedBehavior })
    if (resolvedBehavior === 'auto') {
      lastScrollTopRef.current = el.scrollTop
    }
  }, [isStreaming, syncScrollToLatestVisibility])

  const reviewLatestChanges = useCallback(() => {
    const scroller = messagesRef.current
    if (!scroller) return
    const blocks = scroller.querySelectorAll<HTMLElement>('[data-tool-block-kind="file-changes"]')
    const latestBlock = blocks.item(blocks.length - 1)
    if (!latestBlock) {
      scrollToLatest()
      return
    }

    stickToBottomRef.current = false
    syncScrollToLatestVisibility(true)
    latestBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [scrollToLatest, syncScrollToLatestVisibility])

  const handleMessagesWheel = useCallback((ev: React.WheelEvent<HTMLDivElement>) => {
    if (ev.deltaY < 0) {
      programmaticScrollToLatestRef.current = false
      stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }
  }, [syncScrollToLatestVisibility])

  const handleMessagesKeyDown = useCallback((ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === 'ArrowUp' || ev.key === 'PageUp' || ev.key === 'Home') {
      programmaticScrollToLatestRef.current = false
      stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }
  }, [syncScrollToLatestVisibility])

  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current
    if (!el) return

    const prevTop = lastScrollTopRef.current
    const currentTop = el.scrollTop
    lastScrollTopRef.current = currentTop

    if (isNearLatest(el)) {
      programmaticScrollToLatestRef.current = false
      if (!stickToBottomRef.current) stickToBottomRef.current = true
      if (visibleMessageLimit !== CHAT_INITIAL_RENDER_WINDOW) {
        setVisibleMessageLimit(resetTranscriptWindow())
      }
      syncScrollToLatestVisibility(false)
    } else if (currentTop < prevTop && !programmaticScrollToLatestRef.current) {
      if (stickToBottomRef.current) stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }

    if (el.scrollTop <= LINKED_SESSION_HISTORY_LOAD_THRESHOLD && !loadingEarlier) {
      pendingHistoryPrependRef.current = { previousHeight: el.scrollHeight, previousTop: el.scrollTop }
      if (hiddenMessageCount > 0) {
        setVisibleMessageLimit(prev => expandTranscriptWindow(prev))
      } else if (pagedLinkedHistoryEnabled && hasEarlierMessages) {
        void loadEarlierMessagesRef.current()
      }
    }
  }, [isNearLatest, syncScrollToLatestVisibility, pagedLinkedHistoryEnabled, hasEarlierMessages, loadingEarlier, hiddenMessageCount, visibleMessageLimit])

  useLayoutEffect(() => {
    const pending = pendingHistoryPrependRef.current
    const el = messagesRef.current
    if (!pending || !el) return
    pendingHistoryPrependRef.current = null
    const delta = el.scrollHeight - pending.previousHeight
    el.scrollTop = pending.previousTop + delta
  }, [historicalMessages, visibleMessageLimit])

  useEffect(() => {
    if (loadingEarlier) return
    const el = messagesRef.current
    if (!el) return
    if (el.scrollHeight > el.clientHeight + LINKED_SESSION_HISTORY_LOAD_THRESHOLD) return

    pendingHistoryPrependRef.current = { previousHeight: el.scrollHeight, previousTop: el.scrollTop }
    if (hiddenMessageCount > 0) {
      setVisibleMessageLimit(prev => expandTranscriptWindow(prev))
    } else if (pagedLinkedHistoryEnabled && hasEarlierMessages) {
      void loadEarlierMessagesRef.current()
    }
  }, [pagedLinkedHistoryEnabled, hasEarlierMessages, loadingEarlier, historicalMessages.length, messages.length, hiddenMessageCount, visibleMessageLimit])

  const setAnnotationComposerActive = useCallback((active: boolean) => {
    annotationComposerActiveRef.current = active
    if (active) {
      stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }
  }, [syncScrollToLatestVisibility])

  useLayoutEffect(() => {
    const el = messagesRef.current
    if (!el) return
    if (annotationComposerActiveRef.current) return
    if (!stickToBottomRef.current) {
      syncScrollToLatestVisibility(true)
      return
    }
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
    programmaticScrollToLatestRef.current = false
    syncScrollToLatestVisibility(false)
  }, [messages, syncScrollToLatestVisibility])

  return {
    messagesRef,
    stickToBottomRef,
    historicalMessages,
    setHistoricalMessages,
    allMessages,
    renderedMessages,
    hiddenMessageCount,
    loadingEarlier,
    earlierLoadError,
    showScrollToLatest,
    scrollToLatest,
    reviewLatestChanges,
    handleMessagesScroll,
    handleMessagesWheel,
    handleMessagesKeyDown,
    setAnnotationComposerActive,
  }
}