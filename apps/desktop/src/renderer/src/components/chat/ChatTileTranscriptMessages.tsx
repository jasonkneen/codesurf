import { startTransition, type ReactNode } from 'react'
import { Mic } from 'lucide-react'
import type { ToolBlock, ChatMessage } from '../../../../shared/chat-types'
import type { Persona, VoiceSettings } from '../../../../shared/types'
import { resolveReplyAvatarPersona, type ReplyAvatarPersona } from '../../lib/replyAvatar'
import { ReplyAvatar } from './ReplyAvatar'
import { useTheme } from '../../ThemeContext'
import { WorkingDots } from '../shared/streamdown-utils'
import { speakMessage } from '../../hooks/useAutoSpeak'
import { ttsPlayer, type TtsPlayerState } from '../../utils/ttsPlayer'
import { BlockNoteAffordance } from './BlockNoteAffordance'
import { isCheckpointToolBlock } from './checkpointToolActions'
import { isDreamToolBlock } from './dreamToolActions'
import {
  ThinkingBlockView,
  MixedToolGroup,
  CollapsedToolGroup,
  ThinkingGroupChip,
  ToolGroupChip,
  ToolMegaChip,
  ToolBlockView,
} from './ToolBlockView'
import { collateClusterChips, type ClusterChip } from './toolChipCollation'
import { ChatMessageContent } from './ChatTileViews'
import {
  CHAT_CHIP_ROW_STYLE,
  CHAT_OFFSCREEN_MESSAGE_STYLE,
} from './chatTileLayout'
import {
  shouldRenderToolBlock,
  getExternalAgentToolBlocks,
  isExternalAgentToolOnlyText,
  relativeTime,
} from './chatTileUtils'
import type { BlockNoteTarget } from '../../hooks/useChatTileBlockNotes'

export interface ChatTileTranscriptMessagesProps {
  renderedMessages: ChatMessage[]
  isStreaming: boolean
  toolCollapseTick: number
  explodedChipGroups: ReadonlySet<string>
  toggleExplodedChipGroup: (clusterId: string, collationId: string) => void
  updateBlockNote: (target: BlockNoteTarget, text: string | null) => void
  onAnnotationComposerActiveChange: (active: boolean) => void
  readAttachmentPaths: Set<string>
  fontSize: number
  fontLineHeight: number
  fontMono: string
  monoSize: number
  ttsState: TtsPlayerState
  voiceSettings: Pick<VoiceSettings, 'ttsProvider' | 'ttsVoice' | 'spokifyModel'>
  personas: ReadonlyArray<Pick<Persona, 'id' | 'name' | 'color'>>
  fallbackProvider?: string | null
}

export function ChatTileTranscriptMessages({
  renderedMessages,
  isStreaming,
  toolCollapseTick,
  explodedChipGroups,
  toggleExplodedChipGroup,
  updateBlockNote,
  onAnnotationComposerActiveChange,
  readAttachmentPaths,
  fontSize,
  fontLineHeight,
  fontMono,
  monoSize,
  ttsState,
  voiceSettings,
  personas,
  fallbackProvider,
}: ChatTileTranscriptMessagesProps): JSX.Element {
  const theme = useTheme()

  // Walk the message list and group *consecutive* chip-only assistant messages.
  const nodes: JSX.Element[] = []
  void toolCollapseTick

  let clusterItems: ClusterChip[] = []
  let clusterStartKey: string | null = null
  let clusterMsgIds: string[] = []

  const buildMessageBlockLookup = (msg: ChatMessage) => ({
    thinkingById: new Map((msg.thinkingBlocks ?? []).map(block => [block.id, block])),
    toolById: new Map((msg.toolBlocks ?? []).map(block => [block.id, block])),
  })

  const extractChipsFromMessage = (msg: ChatMessage, isLiveMessage: boolean): ClusterChip[] => {
    const items: ClusterChip[] = []
    const blocks = msg.contentBlocks ?? []
    if (blocks.length === 0 && isExternalAgentToolOnlyText(msg.content ?? '')) {
      for (const tb of getExternalAgentToolBlocks(msg.content ?? '')) {
        if (!shouldRenderToolBlock(tb)) continue
        items.push({ kind: 'tool', key: `${msg.id}-${tb.id}`, block: tb, isLive: isLiveMessage })
      }
      return items
    }
    const { thinkingById, toolById } = buildMessageBlockLookup(msg)
    for (const block of blocks) {
      if (block.type === 'thinking') {
        const tb = thinkingById.get(block.thinkingId)
        if (tb && (!isLiveMessage || tb.done)) items.push({
          kind: 'thinking',
          key: `${msg.id}-think-${block.thinkingId}`,
          block: !isLiveMessage && !tb.done ? { ...tb, done: true } : tb,
        })
        continue
      }
      if (block.type === 'tool') {
        const tb = toolById.get(block.toolId)
        if (tb && shouldRenderToolBlock(tb)) {
          items.push({ kind: 'tool', key: `${msg.id}-${tb.id}`, block: tb, isLive: isLiveMessage })
        }
      }
    }
    return items
  }

  const renderChipItem = (item: ReturnType<typeof collateClusterChips>[number], clusterId: string, itemIndex?: number): JSX.Element => {
    if (item.kind === 'thinking') {
      return <ThinkingBlockView key={item.key} thinking={item.block} />
    }
    if (item.kind === 'thinking-group') {
      return (
        <ThinkingGroupChip
          key={item.key}
          count={item.blocks.length}
          expanded={item.expanded}
          onToggle={() => startTransition(() => toggleExplodedChipGroup(clusterId, item.id))}
        />
      )
    }
    if (item.kind === 'tool-single') {
      const variant = itemIndex !== undefined ? 'b' : undefined
      return <ToolBlockView key={item.key} block={item.block} isLive={item.isLive} chipVariant={variant} />
    }
    if (item.kind === 'tool-group') {
      return (
        <ToolGroupChip
          key={item.key}
          toolName={item.toolName}
          count={item.blocks.length}
          expanded={item.expanded}
          onToggle={() => startTransition(() => toggleExplodedChipGroup(clusterId, item.id))}
        />
      )
    }
    return (
      <ToolMegaChip
        key={item.key}
        count={item.blocks.length}
        expanded={item.expanded}
        onToggle={() => startTransition(() => toggleExplodedChipGroup(clusterId, item.id))}
      />
    )
  }

  const renderChipRow = (items: JSX.Element[], key: string): JSX.Element => {
    return (
      <div key={key} style={CHAT_CHIP_ROW_STYLE}>
        {items}
      </div>
    )
  }

  const wrapAssistant = (
    key: string,
    persona: ReplyAvatarPersona,
    streaming: boolean,
    body: ReactNode,
  ): JSX.Element => (
    <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', minWidth: 0 }}>
      <ReplyAvatar persona={persona} streaming={streaming} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        {body}
      </div>
    </div>
  )

  const isChipOnly = (msg: ChatMessage): boolean => {
    if (msg.role !== 'assistant') return false
    const blocks = msg.contentBlocks ?? []
    if (blocks.length === 0) return isExternalAgentToolOnlyText(msg.content ?? '')
    if (blocks.some(b => b.type === 'text')) return false
    if ((msg.content ?? '').trim().length > 0) return false
    return blocks.some(b => b.type === 'tool' || b.type === 'thinking')
  }

  const flushCluster = () => {
    if (clusterItems.length === 0) return
    const lastId = clusterMsgIds[clusterMsgIds.length - 1]
    const lastMsg = renderedMessages.find(m => m.id === lastId)
    const clusterId = clusterStartKey ?? 'cluster'
    const prefix = `${clusterId}::`
    const clusterExploded = new Set<string>()
    for (const k of explodedChipGroups) {
      if (k.startsWith(prefix)) clusterExploded.add(k.slice(prefix.length))
    }
    const finalItems = collateClusterChips(clusterItems, clusterExploded)
    const clusterStreaming = Boolean(
      lastMsg
      && isStreaming
      && lastMsg.isStreaming
      && lastMsg.id === renderedMessages[renderedMessages.length - 1]?.id
    )
    nodes.push(
      <BlockNoteAffordance
        key={`cluster-${clusterId}`}
        note={lastMsg?.note}
        side="right"
        onComposerActiveChange={onAnnotationComposerActiveChange}
        onUpdateNote={(text) => updateBlockNote({ kind: 'message', messageId: lastId }, text)}
      >
        {wrapAssistant(
          `cluster-avatar-${clusterId}`,
          resolveReplyAvatarPersona(lastMsg ?? {}, personas, fallbackProvider),
          clusterStreaming,
          renderChipRow(finalItems.map((item, idx) => renderChipItem(item, clusterId, idx)), `cluster-row-${clusterId}`),
        )}
      </BlockNoteAffordance>
    )
    clusterItems = []
    clusterStartKey = null
    clusterMsgIds = []
  }

  for (const msg of renderedMessages) {
    const isLiveMessage = Boolean(
      msg.role === 'assistant'
      && isStreaming
      && msg.isStreaming
      && msg.id === renderedMessages[renderedMessages.length - 1]?.id
    )
    if (isChipOnly(msg)) {
      const items = extractChipsFromMessage(msg, isLiveMessage)
      if (clusterItems.length === 0) clusterStartKey = msg.id
      clusterItems.push(...items)
      clusterMsgIds.push(msg.id)
      continue
    }
    flushCluster()
    const { thinkingById, toolById } = buildMessageBlockLookup(msg)
    const visibleToolBlocks = msg.toolBlocks?.filter(shouldRenderToolBlock) ?? []
    const hasVisibleToolBlocks = visibleToolBlocks.length > 0
    const annotationSide: 'left' | 'right' = msg.role === 'user' ? 'left' : 'right'
    nodes.push(
      <BlockNoteAffordance
        key={msg.id}
        note={msg.note}
        side={annotationSide}
        onComposerActiveChange={onAnnotationComposerActiveChange}
        onUpdateNote={(text) => updateBlockNote({ kind: 'message', messageId: msg.id }, text)}
      >
        <div style={{
          display: 'flex', flexDirection: 'column',
          alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
          width: msg.role === 'user' ? 'auto' : '100%',
          maxWidth: msg.role === 'user' ? '60%' : '100%',
          minWidth: 0,
          alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
          marginBottom: msg.role === 'user' ? 5 : 0,
          gap: 2,
          ...(isLiveMessage ? {} : CHAT_OFFSCREEN_MESSAGE_STYLE),
        }}>
          {(() => {
            const body = <>
          {(() => {
            const hasInlineThinking = (msg.contentBlocks ?? []).some(b => b.type === 'thinking')
            const legacyThinking = msg.thinking
              ? (!isLiveMessage && !msg.thinking.done ? { ...msg.thinking, done: true } : msg.thinking)
              : (isLiveMessage && !msg.content ? { content: '', done: false } : null)
            const showLegacy = !hasInlineThinking && Boolean(legacyThinking) && (!isLiveMessage || legacyThinking?.done)
            return showLegacy
              ? <ThinkingBlockView thinking={legacyThinking ?? { content: '', done: false }} />
              : null
          })()}

          {(msg.contentBlocks?.length ?? 0) > 0 ? (
            (() => {
              const elements: JSX.Element[] = []
              const blocks = msg.contentBlocks!
              let i = 0
              let chipRow: JSX.Element[] = []
              let chipRowStartIdx = i
              const flushChipRow = () => {
                if (chipRow.length === 0) return
                elements.push(renderChipRow(chipRow, `chiprow-${chipRowStartIdx}`))
                chipRow = []
              }
              while (i < blocks.length) {
                const block = blocks[i]
                if (block.type === 'thinking') {
                  if (chipRow.length === 0) chipRowStartIdx = i
                  const tb = thinkingById.get(block.thinkingId)
                  if (tb && (!isLiveMessage || tb.done)) {
                    chipRow.push(
                      <ThinkingBlockView
                        key={`think-${block.thinkingId}`}
                        thinking={!isLiveMessage && !tb.done ? { ...tb, done: true } : tb}
                      />
                    )
                  }
                  i++
                  continue
                }
                if (block.type === 'tool') {
                  if (chipRow.length === 0) chipRowStartIdx = i
                  const rawTools: ToolBlock[] = []
                  while (i < blocks.length) {
                    const cb = blocks[i]
                    if (cb.type !== 'tool') break
                    const tb = toolById.get(cb.toolId)
                    if (tb && shouldRenderToolBlock(tb)) rawTools.push(tb)
                    i++
                  }
                  const collapsibleTools = rawTools.filter(tb => tb.status === 'done' && !(tb.fileChanges?.length) && !isCheckpointToolBlock(tb) && !isDreamToolBlock(tb))
                  const collapsibleIds = new Set(collapsibleTools.map(t => t.id))
                  const uniqueNames = new Set(collapsibleTools.map(t => t.name))
                  const useSameNameGroup = collapsibleTools.length >= 3 && uniqueNames.size === 1
                  const useMixedGroup = collapsibleTools.length >= 3 && uniqueNames.size > 1
                  let groupEmitted = false
                  for (const tb of rawTools) {
                    if (collapsibleIds.has(tb.id) && (useSameNameGroup || useMixedGroup)) {
                      if (!groupEmitted) {
                        groupEmitted = true
                        if (useSameNameGroup) {
                          chipRow.push(<CollapsedToolGroup key={`grp-${tb.id}`} name={tb.name} blocks={collapsibleTools} />)
                        } else {
                          chipRow.push(<MixedToolGroup key={`mgrp-${tb.id}`} blocks={collapsibleTools} />)
                        }
                      }
                      continue
                    }
                    chipRow.push(<ToolBlockView key={tb.id} block={tb} isLive={isLiveMessage} chipVariant="b" />)
                  }
                  continue
                }
                {
                  flushChipRow()
                  const isLastBlock = i === blocks.length - 1
                  elements.push(
                    <div key={`text-${i}`} style={{
                      background: msg.role === 'user' ? theme.chat.userBubble : 'transparent',
                      border: msg.role === 'user' ? '1px solid transparent' : '0',
                      boxShadow: msg.role === 'user'
                        ? theme.mode === 'light'
                          ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
                          : 'var(--cs-edge-shadow)'
                        : undefined,
                      borderRadius: 14,
                      padding: '8px 12px',
                      margin: msg.role === 'user' ? '2px' : 0,
                      fontSize, lineHeight: fontLineHeight,
                      wordBreak: 'break-word',
                      color: theme.chat.text, position: 'relative',
                      width: msg.role === 'user' ? 'calc(100% - 4px)' : '100%', minWidth: 0, overflow: 'visible', boxSizing: 'border-box',
                    }}>
                      <ChatMessageContent text={block.text} isStreaming={isLiveMessage && isLastBlock} isUser={msg.role === 'user'} readAttachmentPaths={readAttachmentPaths} />
                    </div>
                  )
                  i++
                }
              }
              flushChipRow()
              return elements
            })()
          ) : (
            <>
              {hasVisibleToolBlocks && (
                (() => {
                  const out: JSX.Element[] = []
                  const collapsibleTools = visibleToolBlocks.filter(tb => tb.status === 'done' && !(tb.fileChanges?.length))
                  const collapsibleIds = new Set(collapsibleTools.map(t => t.id))
                  const uniqueNames = new Set(collapsibleTools.map(t => t.name))
                  const useSameNameGroup = collapsibleTools.length >= 3 && uniqueNames.size === 1
                  const useMixedGroup = collapsibleTools.length >= 3 && uniqueNames.size > 1
                  let groupEmitted = false
                  for (const tb of visibleToolBlocks) {
                    if (collapsibleIds.has(tb.id) && (useSameNameGroup || useMixedGroup)) {
                      if (!groupEmitted) {
                        groupEmitted = true
                        if (useSameNameGroup) {
                          out.push(<CollapsedToolGroup key={`grp-${tb.id}`} name={tb.name} blocks={collapsibleTools} />)
                        } else {
                          out.push(<MixedToolGroup key={`mgrp-${tb.id}`} blocks={collapsibleTools} />)
                        }
                      }
                      continue
                    }
                    out.push(<ToolBlockView key={tb.id} block={tb} isLive={isLiveMessage} />)
                  }
                  return renderChipRow(out, `legacy-tools-${msg.id}`)
                })()
              )}
              {msg.content && (
                <div style={{
                  background: msg.role === 'user' ? theme.chat.userBubble : 'transparent',
                  border: msg.role === 'user' ? '1px solid transparent' : '0',
                  boxShadow: msg.role === 'user'
                    ? theme.mode === 'light'
                      ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
                      : 'var(--cs-edge-shadow)'
                    : undefined,
                  borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  padding: '8px 12px',
                  margin: msg.role === 'user' ? '2px' : 0,
                  fontSize, lineHeight: fontLineHeight,
                  wordBreak: 'break-word',
                  color: theme.chat.text, position: 'relative',
                  width: msg.role === 'user' ? 'calc(100% - 4px)' : '100%', minWidth: 0, overflow: 'visible', boxSizing: 'border-box',
                }}>
                  <ChatMessageContent text={msg.content} isStreaming={isLiveMessage} isUser={msg.role === 'user'} readAttachmentPaths={readAttachmentPaths} />
                  {isLiveMessage && msg.content.length === 0 && !hasVisibleToolBlocks && (
                    <WorkingDots />
                  )}
                </div>
              )}
            </>
          )}

          {msg.role === 'assistant' && !isLiveMessage && msg.cost != null && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: monoSize - 2, color: theme.chat.subtle, fontFamily: fontMono,
              padding: '0 4px',
              marginTop: 2,
              lineHeight: 1.2,
            }}>
              <span>${msg.cost.toFixed(4)}</span>
              {msg.turns != null && (
                <span>{msg.turns} turn{msg.turns !== 1 ? 's' : ''}</span>
              )}
              <span>{relativeTime(msg.timestamp)}</span>
              <button
                type="button"
                onClick={() => {
                  if (ttsState.currentMessageId === msg.id) {
                    ttsPlayer.stopMessage(msg.id)
                  } else {
                    void speakMessage({
                      messageId: msg.id,
                      text: msg.content,
                      ttsProvider: voiceSettings.ttsProvider,
                      ttsVoice: voiceSettings.ttsVoice,
                      spokifyModel: voiceSettings.spokifyModel,
                      force: true,
                    })
                  }
                }}
                onMouseDown={e => e.preventDefault()}
                title={ttsState.currentMessageId === msg.id ? 'Stop speaking' : 'Speak this message'}
                style={{
                  marginLeft: 'auto', background: 'transparent', border: 'none',
                  cursor: 'pointer', padding: 2, display: 'flex',
                  color: ttsState.currentMessageId === msg.id ? theme.accent.base : theme.chat.subtle,
                }}
              >
                <Mic size={10} strokeWidth={2.2} />
              </button>
            </div>
          )}

          {!isLiveMessage && msg.role === 'user' && (
            <div style={{
              fontSize: monoSize - 2, color: theme.chat.subtle, fontFamily: fontMono,
              padding: '0 6px', textAlign: 'right',
              marginTop: 2,
              lineHeight: 1.2,
              alignSelf: 'flex-end',
              overflow: 'visible',
            }}>
              {relativeTime(msg.timestamp)}
            </div>
          )}
            </>
            if (msg.role === 'assistant') {
              return wrapAssistant(
                `avatar-${msg.id}`,
                resolveReplyAvatarPersona(msg, personas, fallbackProvider),
                isLiveMessage,
                body,
              )
            }
            return body
          })()}
        </div>
      </BlockNoteAffordance>
    )
  }
  flushCluster()

  return <>{nodes}</>
}