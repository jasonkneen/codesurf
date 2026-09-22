import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../../../shared/chat-types'
import { DREAM_TOOL_ID_PREFIX, DREAM_TOOL_NAME } from '../components/chat/dreamToolActions'

type SetMessagesSafe = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void

export function useChatTileDreamPolling(
  workspaceId: string,
  setMessagesSafe: SetMessagesSafe,
) {
  const lastSeenDreamCompletionRef = useRef<string | null>(null)
  const dreamPollSeededRef = useRef(false)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    const poll = async () => {
      try {
        const summary = await window.electron?.system?.daemonSummary?.()
        if (cancelled) return
        const lastRun = summary?.dreaming?.lastRun
        if (!lastRun) return
        const matchesWorkspace = !lastRun.workspaceId || lastRun.workspaceId === workspaceId
        if (!matchesWorkspace) return
        const completedAt = lastRun.completedAt ?? null
        if (!completedAt) return
        if (!dreamPollSeededRef.current) {
          dreamPollSeededRef.current = true
          lastSeenDreamCompletionRef.current = completedAt
          return
        }
        if (lastSeenDreamCompletionRef.current === completedAt) return
        lastSeenDreamCompletionRef.current = completedAt
        if (lastRun.status === 'failed' || lastRun.status === 'cancelled') return

        const runId = String(lastRun.id ?? completedAt)
        const sessionsReviewed = Number(lastRun.sessionsReviewed ?? 0)
        const summaryText = sessionsReviewed > 0
          ? `Auto-dream consolidated ${sessionsReviewed} session${sessionsReviewed === 1 ? '' : 's'}`
          : 'Auto-dream completed'
        const toolId = `${DREAM_TOOL_ID_PREFIX}${runId}`
        const ts = Date.parse(completedAt) || Date.now()

        setMessagesSafe(prev => {
          if (prev.some(message => message.toolBlocks?.some(block => block.id === toolId))) return prev
          return [...prev, {
            id: `msg-dream-${runId}`,
            role: 'system',
            content: '',
            timestamp: ts,
            contentBlocks: [{ type: 'tool', toolId }],
            toolBlocks: [{
              id: toolId,
              name: DREAM_TOOL_NAME,
              input: '',
              summary: summaryText,
              status: 'done',
            }],
          }]
        })
      } catch {
        // Polling failures are non-fatal — try again next tick.
      }
    }

    poll()
    const interval = window.setInterval(poll, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [workspaceId, setMessagesSafe])
}