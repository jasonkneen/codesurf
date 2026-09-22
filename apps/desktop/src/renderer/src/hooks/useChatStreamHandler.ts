import { useEffect } from 'react'
import type { ChatMessage, ToolBlock } from '../../../shared/chat-types'
import { normalizeToolName } from '../../../shared/tool-normalization.ts'
import type { ToolPermissionDecision, ToolPermissionRequest } from '../components/ai-elements/ToolPermission'
import { subscribeChatStream } from '../components/chat/chatStreamHub'
import { applyChatStreamEvent, mergeToolBlockDuplicate } from './chatStreamReducer'

export interface ChatStreamHandlerArgs {
  workspaceId: string
  tileId: string
  setMessagesSafe: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void
  setSessionId: (id: string) => void
  setIsStreaming: (v: boolean) => void
  setJobId: (id: string) => void
  setJobSequence: (seq: number) => void
  flushPendingStreamText: () => void
  queueStreamText: (text: string) => void
  lastJobSequenceRef: React.MutableRefObject<number>
  setPendingToolPermissions: React.Dispatch<React.SetStateAction<Map<string, ToolPermissionRequest>>>
  setResolvedToolPermissions: React.Dispatch<React.SetStateAction<Map<string, ToolPermissionDecision>>>
}

export function useChatStreamHandler({
  workspaceId,
  tileId,
  setMessagesSafe,
  setSessionId,
  setIsStreaming,
  setJobId,
  setJobSequence,
  flushPendingStreamText,
  queueStreamText,
  lastJobSequenceRef,
  setPendingToolPermissions,
  setResolvedToolPermissions,
}: ChatStreamHandlerArgs): void {

  useEffect(() => {
    const publishActivity = (message: string, details?: Record<string, unknown>) => {
      window.electron?.bus?.publish(`tile:${workspaceId}:${tileId}`, 'activity', `chat:${workspaceId}:${tileId}`, {
        message,
        role: 'assistant',
        ...(details ?? {}),
      })
    }

    const buildToolBlock = (id: string, rawName: string, status: ToolBlock['status'] = 'running'): ToolBlock => {
      const normalized = normalizeToolName(rawName)
      return {
        id,
        name: normalized.rawName,
        rawName: normalized.rawName,
        canonicalName: normalized.canonicalName,
        displayName: normalized.displayName,
        groupKey: normalized.groupKey,
        category: normalized.category,
        provider: normalized.provider,
        namespace: normalized.namespace,
        input: '',
        status,
      }
    }

    const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessagesSafe(prev => {
        const last = prev[prev.length - 1]
        if (last?.isStreaming) return [...prev.slice(0, -1), fn(last)]
        return prev
      })

    // Demux: one global IPC subscription, fan-out by workspace/card identity.
    const cleanup = subscribeChatStream(workspaceId, tileId, (event) => {
      if (typeof event.sequence === 'number') {
        if (event.sequence <= lastJobSequenceRef.current) return
        lastJobSequenceRef.current = event.sequence
        setJobSequence(event.sequence)
      }
      if (typeof event.jobId === 'string') {
        setJobId(event.jobId)
      }

      if (event.type !== 'text') flushPendingStreamText()

      switch (event.type) {
        case 'session':
          if (typeof event.sessionId === 'string' && event.sessionId) setSessionId(event.sessionId)
          break

        case 'text':
          if (typeof event.text === 'string' && event.text) queueStreamText(event.text)
          break

        case 'thinking_start':
          updateLast(m => applyChatStreamEvent(m, event))
          break

        case 'thinking':
          if (event.text) updateLast(m => applyChatStreamEvent(m, event))
          break

        case 'tool_start':
          updateLast(m => applyChatStreamEvent(m, event))
          publishActivity(`Started ${normalizeToolName(event.toolName).displayName}`, {
            toolName: event.toolName,
            toolId: event.toolId,
          })
          break

        case 'tool_input':
          if (event.text) updateLast(m => applyChatStreamEvent(m, event))
          break

        case 'tool_use':
          updateLast(m => applyChatStreamEvent(m, event))
          break

        case 'tool_summary':
          updateLast(m => applyChatStreamEvent(m, event))
          if (typeof event.text === 'string' && event.text.trim()) {
            publishActivity(`Finished ${normalizeToolName(event.toolName).displayName}`, {
              toolName: event.toolName,
              toolId: event.toolId,
            })
          }
          break

        case 'ask_user_question': {
          const pid = typeof event.toolId === 'string' ? event.toolId : null
          if (!pid || !Array.isArray(event.questions) || event.questions.length === 0) break
          const askInput = JSON.stringify({ questions: event.questions })
          updateLast(m => {
            const nextBlock: ToolBlock = { ...buildToolBlock(pid, 'AskUserQuestion'), input: askInput }
            const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === pid)
            const toolBlocks = existingIndex >= 0
              ? (m.toolBlocks ?? []).map((block, index) => index === existingIndex ? { ...block, ...nextBlock } : block)
              : [...(m.toolBlocks ?? []), nextBlock]
            const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === pid)
            return {
              ...m,
              toolBlocks,
              contentBlocks: hasContentRef
                ? m.contentBlocks
                : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId: pid }],
            }
          })
          break
        }

        case 'tool_permission_request': {
          const pid = typeof event.toolId === 'string' ? event.toolId : null
          if (!pid) break
          const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
          const request: ToolPermissionRequest = {
            toolId: pid,
            toolName,
            provider: typeof event.provider === 'string' ? event.provider : 'claude',
            title: typeof event.title === 'string' ? event.title : null,
            description: typeof event.description === 'string' ? event.description : null,
            blockedPath: typeof event.blockedPath === 'string' ? event.blockedPath : null,
            workspaceDir: typeof event.workspaceDir === 'string' ? event.workspaceDir : null,
          }
          updateLast(m => {
            const nextBlock: ToolBlock = buildToolBlock(pid, toolName)
            const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === pid)
            const toolBlocks = existingIndex >= 0
              ? (m.toolBlocks ?? []).map((block, index) => index === existingIndex ? mergeToolBlockDuplicate(block, nextBlock) : block)
              : [...(m.toolBlocks ?? []), nextBlock]
            const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === pid)
            return {
              ...m,
              toolBlocks,
              contentBlocks: hasContentRef
                ? m.contentBlocks
                : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId: pid }],
            }
          })
          setPendingToolPermissions(prev => {
            const next = new Map(prev)
            next.set(pid, request)
            return next
          })
          setResolvedToolPermissions(prev => {
            if (!prev.has(pid)) return prev
            const next = new Map(prev)
            next.delete(pid)
            return next
          })
          break
        }

        case 'tool_permission_resolved': {
          const pid = typeof event.toolId === 'string' ? event.toolId : null
          if (!pid) break
          const decision: ToolPermissionDecision =
            event.decision === 'deny' || event.decision === 'never' || event.decision === 'once' || event.decision === 'session'
              || event.decision === 'today' || event.decision === 'forever'
              ? event.decision
              : 'once'
          setPendingToolPermissions(prev => {
            if (!prev.has(pid)) return prev
            const next = new Map(prev)
            next.delete(pid)
            return next
          })
          if (decision === 'deny' || decision === 'never') {
            updateLast(m => {
              const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
              const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === pid)
              const toolBlocks = existingIndex >= 0
                ? (m.toolBlocks ?? []).map(block => block.id === pid ? { ...block, ...buildToolBlock(pid, toolName, 'done'), input: block.input } : block)
                : [...(m.toolBlocks ?? []), buildToolBlock(pid, toolName, 'done')]
              const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === pid)
              return {
                ...m,
                toolBlocks,
                contentBlocks: hasContentRef
                  ? m.contentBlocks
                  : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId: pid }],
              }
            })
            setResolvedToolPermissions(prev => {
              const next = new Map(prev)
              next.set(pid, decision)
              return next
            })
          }
          break
        }

        case 'tool_progress':
          updateLast(m => applyChatStreamEvent(m, event))
          break

        case 'block_stop':
          updateLast(m => applyChatStreamEvent(m, event))
          break

        case 'done':
          if (typeof event.sessionId === 'string' && event.sessionId) setSessionId(event.sessionId)
          updateLast(m => applyChatStreamEvent(m, event))
          setIsStreaming(false)
          publishActivity('Assistant responded')
          break

        case 'error':
          updateLast(m => applyChatStreamEvent(m, event))
          setIsStreaming(false)
          publishActivity(`Agent error: ${String(event.error ?? 'unknown error')}`)
          break
      }
    })
    return cleanup
  }, [
    workspaceId,
    tileId,
    flushPendingStreamText,
    queueStreamText,
    setMessagesSafe,
    setSessionId,
    setIsStreaming,
    setJobId,
    setJobSequence,
    lastJobSequenceRef,
    setPendingToolPermissions,
    setResolvedToolPermissions,
  ])
}
