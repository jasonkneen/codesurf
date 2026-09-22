import { useMemo } from 'react'
import type { ChatMessage } from '../../../shared/chat-types'
import {
  getApproxContextWindowTokens,
  getApproxSystemOverheadTokens,
} from '../config/providers'
import { estimateMessageChars } from '../components/chat/messageNormalization'
import { collectModelReadPaths } from '../components/chat/chatTileUtils'

export function useChatTileContextUsage(options: {
  provider: string
  model: string
  messages: ChatMessage[]
  input: string
}) {
  const { provider, model, messages, input } = options

  const contextWindowLimit = useMemo(() => getApproxContextWindowTokens(provider, model), [provider, model])
  const systemOverheadTokens = useMemo(
    () => getApproxSystemOverheadTokens(provider, model),
    [provider, model],
  )

  const readPathsSnapshot = useMemo(
    () => [...collectModelReadPaths(messages)].sort().join('\u0000'),
    [messages],
  )
  const readAttachmentPaths = useMemo(
    () => new Set(readPathsSnapshot ? readPathsSnapshot.split('\u0000') : []),
    [readPathsSnapshot],
  )

  const conversationTokenEstimate = useMemo(() => {
    const totalChars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0)
    return Math.max(0, Math.round(totalChars / 4))
  }, [messages])

  const estimatedContextTokens = useMemo(() => {
    const inputTokens = Math.max(0, Math.round(input.length / 4))
    return conversationTokenEstimate + inputTokens + systemOverheadTokens
  }, [conversationTokenEstimate, input, systemOverheadTokens])

  const contextUsageRatio = contextWindowLimit > 0 ? Math.min(1, estimatedContextTokens / contextWindowLimit) : 0
  const contextUsagePercent = Math.max(1, Math.round(contextUsageRatio * 100))

  return {
    contextWindowLimit,
    systemOverheadTokens,
    readAttachmentPaths,
    estimatedContextTokens,
    contextUsageRatio,
    contextUsagePercent,
  }
}