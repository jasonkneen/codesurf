import { useMemo, type ReactNode } from 'react'
import type { ChatMessage } from '../../../shared/chat-types'
import { ThinkingBlockView, WorkingChipView } from '../components/chat/ToolBlockView'
import { CHAT_COMPOSER_MIN_WIDTH_STYLE, CHAT_COMPOSER_WIDTH } from '../components/chat/chatTileLayout'

type UseChatTileLiveComposerActivityArgs = {
  isStreaming: boolean
  renderedMessages: ChatMessage[]
}

export function useChatTileLiveComposerActivity({
  isStreaming,
  renderedMessages,
}: UseChatTileLiveComposerActivityArgs): ReactNode {
  return useMemo(() => {
    if (!isStreaming) return null
    const liveMsg = renderedMessages[renderedMessages.length - 1]
    if (!liveMsg || liveMsg.role !== 'assistant' || !liveMsg.isStreaming) return null

    const activeThinking = liveMsg.thinkingBlocks?.find(tb => !tb.done)
      ?? (!(liveMsg.contentBlocks ?? []).some(b => b.type === 'thinking') && liveMsg.thinking && !liveMsg.thinking.done
        ? liveMsg.thinking
        : null)

    return (
      <div style={{
        width: CHAT_COMPOSER_WIDTH,
        minWidth: CHAT_COMPOSER_MIN_WIDTH_STYLE,
        margin: '0 auto',
        paddingTop: 4,
        paddingBottom: 4,
        position: 'relative',
        zIndex: 2,
      }}>
        {activeThinking
          ? <ThinkingBlockView thinking={activeThinking} />
          : <WorkingChipView message={liveMsg} />
        }
      </div>
    )
  }, [isStreaming, renderedMessages])
}