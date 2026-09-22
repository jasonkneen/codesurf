import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { callHost, subscribe, type BridgeContext, type ChannelName } from '@codesurf/chat-bridge'

type ChatMessage = ThreadMessageLike & { id: string }
const STREAM_FLUSH_INTERVAL_MS = 50

interface Props {
  context: BridgeContext | null
  children: ReactNode
}

/**
 * Bridges assistant-ui's runtime to the host. When a host is
 * connected we:
 *   - on send: callHost('chat.send', { messages, tileId, ... })
 *   - subscribe to stream:${tileId} for chunks, translating
 *     each chunk into the assistant message's parts on the fly.
 * When standalone (no host) we run a local echo so the preview is
 * usable without codesurf behind it.
 */
export function CodesurfRuntimeProvider({ context, children }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const streamingIdRef = useRef<string | null>(null)
  const pendingStreamTextRef = useRef('')
  const pendingStreamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tileId = context?.tileId ?? null

  const flushPendingStreamText = () => {
    const targetId = streamingIdRef.current
    const text = pendingStreamTextRef.current
    if (!targetId || !text) return
    pendingStreamTextRef.current = ''
    setMessages(prev => prev.map(msg => {
      if (msg.id !== targetId) return msg
      const existingText = typeof msg.content === 'string' ? msg.content : ''
      return { ...msg, content: existingText + text }
    }))
  }

  const queueStreamText = (text: string) => {
    if (!text) return
    pendingStreamTextRef.current += text
    if (pendingStreamFlushTimerRef.current) return
    pendingStreamFlushTimerRef.current = setTimeout(() => {
      pendingStreamFlushTimerRef.current = null
      flushPendingStreamText()
    }, STREAM_FLUSH_INTERVAL_MS)
  }

  useEffect(() => {
    return () => {
      if (pendingStreamFlushTimerRef.current) {
        clearTimeout(pendingStreamFlushTimerRef.current)
        pendingStreamFlushTimerRef.current = null
      }
      pendingStreamTextRef.current = ''
    }
  }, [])

  // Stream subscription (only when we have a host context).
  useEffect(() => {
    if (!tileId) return
    const channel = `stream:${tileId}` as ChannelName
    const unsubscribe = subscribe(channel, (chunk: any) => {
      if (!chunk || typeof chunk !== 'object') return
      const targetId = streamingIdRef.current
      if (!targetId) return
      // Minimal subset of V1 chunk types — enough to demonstrate the
      // round trip. Full mapping (thinking, tool_*, permission, etc.)
      // lands in subsequent commits.
      if (chunk.type === 'text' && typeof chunk.text === 'string') {
        queueStreamText(chunk.text)
      } else if (chunk.type === 'done' || chunk.type === 'error') {
        flushPendingStreamText()
        setMessages(prev => prev.map(msg => msg.id === targetId
          ? (chunk.type === 'error'
              ? { ...msg, content: typeof msg.content === 'string' && msg.content ? msg.content : `Error: ${chunk.error ?? 'unknown'}` }
              : msg)
          : msg))
        setIsRunning(false)
        pendingStreamTextRef.current = ''
        streamingIdRef.current = null
      }
    })
    return () => { unsubscribe() }
  }, [tileId])

  const adapter = useMemo<ExternalStoreAdapter<ChatMessage>>(() => ({
    messages,
    isRunning,
    setMessages: (next) => setMessages(next as ChatMessage[]),
    convertMessage: (message) => message,
    onNew: async (newMessage) => {
      const id = `user-${Date.now()}`
      const userMsg: ChatMessage = { id, role: 'user', content: textOf(newMessage.content) }
      const assistantId = `assistant-${Date.now() + 1}`
      const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '' }
      streamingIdRef.current = assistantId
      setMessages(prev => [...prev, userMsg, assistantMsg])
      setIsRunning(true)

      if (!context) {
        // Standalone fallback — synthesize a local echo so preview works
        // without codesurf behind it.
        await sleep(120)
        setMessages(prev => prev.map(msg => msg.id === assistantId
          ? { ...msg, content: `(standalone preview) you said: ${textOf(newMessage.content)}` }
          : msg))
        setIsRunning(false)
        streamingIdRef.current = null
        return
      }

      try {
        await callHost('chat.send', {
          cardId: context.tileId,
          workspaceId: context.workspaceId,
          workspaceDir: context.workspaceDir,
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: textOf(m.content) })),
        })
      } catch (err) {
        setMessages(prev => prev.map(msg => msg.id === assistantId
          ? { ...msg, content: `Error: ${err instanceof Error ? err.message : String(err)}` }
          : msg))
        setIsRunning(false)
        streamingIdRef.current = null
      }
    },
    onCancel: async () => {
      if (!context) {
        setIsRunning(false)
        streamingIdRef.current = null
        return
      }
      try { await callHost('chat.stop', context.tileId) } catch { /* swallow */ }
      setIsRunning(false)
      streamingIdRef.current = null
    },
  }), [messages, isRunning, context])

  const runtime = useExternalStoreRuntime(adapter)

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : (part as { text?: string }).text ?? '')
      .join('')
  }
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
