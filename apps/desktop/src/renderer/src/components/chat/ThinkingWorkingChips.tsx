import React, { startTransition, useState, useEffect, useRef } from 'react'
// useState still used by ThinkingBlockView expand + WorkingChip internals
import { Brain, Check, ChevronRight, Cog } from 'lucide-react'
import type { ThinkingBlock, ChatMessage, ToolBlock } from '../../../../shared/chat-types'
import { useTheme } from '../../ThemeContext'
import { ShimmerText } from '../shared/streamdown-utils'
import {
  useFonts,
  TOOL_BLOCK_MAX_WIDTH,
} from './chatTileContexts'
import { getToolDisplayName } from './chatTileUtils'
import {
  finalizeThinkingElapsedSec,
  resolveThinkingDisplayedElapsed,
  useSharedThinkingClock,
} from './thinkingClock'

function getToolBlockDisplayName(block: ToolBlock): string {
  return block.displayName ?? getToolDisplayName(block.name)
}

export const ThinkingBlockView = React.memo(function ThinkingBlockView({ thinking }: { thinking: ThinkingBlock }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const isActive = !thinking.done
  const hasContent = thinking.content.length > 0

  // Shared clock: N active thinking chips → one interval, not N.
  const nowMs = useSharedThinkingClock(isActive)
  const startTimeRef = useRef<number | null>(null)
  const finalElapsedRef = useRef<number | null>(null)

  if (startTimeRef.current == null && isActive) {
    startTimeRef.current = Date.now()
  }

  useEffect(() => {
    if (thinking.done && finalElapsedRef.current == null) {
      const start = startTimeRef.current ?? Date.now()
      finalElapsedRef.current = finalizeThinkingElapsedSec(start, Date.now())
    }
  }, [thinking.done])

  // No auto-expand — user opens thinking content on demand only

  const displayedElapsed = resolveThinkingDisplayedElapsed(
    startTimeRef.current,
    nowMs,
    thinking.done,
    finalElapsedRef.current,
  )
  const elapsedSec = displayedElapsed

  // Styled to mirror the tool chip (CollapsedToolGroup / ToolBlockView) so it
  // can sit inline in the same chip row without breaking the visual rhythm.
  // The outer container is a column so the expanded quote content can still
  // render underneath the chip in full width when opened.
  const thinkLightLine = `color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
  const thinkOuterDark = theme.mode === 'light'
    ? `color-mix(in srgb, ${theme.text.primary} 45%, transparent)`
    : `rgba(0,0,0,0.75)`

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: expanded ? 6 : 0,
      width: 'fit-content',
      maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
      minWidth: 0,
      flex: '0 0 auto',
    }}>
      {/* Chip pill — same chrome as ToolBlockView */}
      <div style={{
        background: theme.chat.assistantBubble,
        border: '0.5px solid transparent',
        boxShadow: `var(--cs-edge-shadow), 0 0 0 0.5px ${thinkLightLine}, 0 0 0 1px ${thinkOuterDark}`,
        margin: 1,
        borderRadius: 8,
        overflow: 'hidden',
        width: 'fit-content',
        maxWidth: `min(calc(100% - 2px), ${TOOL_BLOCK_MAX_WIDTH}px)`,
        flex: '0 0 auto',
        minWidth: 0,
      }}>
        <button
          onClick={() => {
            if (hasContent) startTransition(() => setExpanded(e => !e))
          }}
          style={{
            background: 'none',
            border: 'none',
            boxShadow: 'none',
            margin: 0,
            padding: '0 8px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            minHeight: 20,
            boxSizing: 'border-box',
            cursor: hasContent ? 'pointer' : 'default',
            color: isActive ? theme.chat.textSecondary : theme.chat.muted,
            fontSize: 10.5,
            fontFamily: fonts.sans,
            fontWeight: 500,
            lineHeight: 1,
            width: 'fit-content',
            maxWidth: '100%',
          }}
        >
          <Brain size={11} style={{ opacity: isActive ? 0.75 : 0.5, flexShrink: 0 }} />
          {isActive ? (
            <ShimmerText baseColor={theme.chat.textSecondary} style={{
              fontSize: 10.5, fontWeight: 500, lineHeight: 1,
              minWidth: 0, flex: '1 1 auto',
              overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
              letterSpacing: 0.2,
            }}>
              {`${elapsedSec}s`}
            </ShimmerText>
          ) : (
            <span style={{
              fontSize: 10.5, fontWeight: 500, lineHeight: 1,
              minWidth: 0, flex: '1 1 auto',
              overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
              letterSpacing: 0.2,
            }}>
              {`${displayedElapsed}s`}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 2, flexShrink: 0 }}>
            {!isActive && (
              <Check size={11} color={theme.status.success} style={{ flexShrink: 0 }} />
            )}
            {hasContent && (
              <ChevronRight size={12} style={{
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s',
                opacity: 0.4, flexShrink: 0,
              }} />
            )}
          </div>
        </button>
      </div>

      {/* Expanded thinking content — quote-indent style, no background.
          Rendered on its own row beneath the chip when expanded. */}
      {expanded && hasContent && (
        <div style={{
          marginLeft: 6,
          paddingLeft: 10,
          paddingTop: 2,
          paddingBottom: 2,
          borderLeft: `2px solid ${theme.chat.muted}`,
          fontSize: 12, lineHeight: fonts.lineHeight, color: theme.chat.muted,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: fonts.sans, maxHeight: 200, overflowY: 'auto',
          background: 'transparent',
          borderRadius: 0,
          backdropFilter: 'none',
          opacity: 0.85,
        }}>
          {thinking.content}
          {isActive && (
            <span style={{
              display: 'inline-block', width: 5, height: 12,
              marginLeft: 2, verticalAlign: 'text-bottom',
              background: theme.chat.muted, borderRadius: 1,
              animation: 'chat-pulse 1s ease-in-out infinite',
            }} />
          )}
        </div>
      )}
    </div>
  )
})

/**
 * WorkingChipView — sibling to ThinkingBlockView, shown at the end of a
 * streaming assistant message when the agent is "doing something" that isn't
 * thinking and isn't producing text.
 *
 * Two states, picked automatically:
 *   - A ToolBlock with `status: 'running'` exists → `Running {toolName}` chip
 *     with a live-ticking elapsed counter measured from the tool's first-seen
 *     running moment.
 *   - No running tool, but the message has been streaming for ≥ 2s → generic
 *     `Working for Ns` chip measured from message-stream start.
 *
 * Hidden whenever a thinking block is currently active — the ThinkingBlockView
 * chip is already occupying that visual slot. Also hidden on non-streaming
 * messages. The 2s grace keeps fast responses (< 2s, no tools) from flashing a
 * chip the user never reads.
 *
 * Mirrors the ThinkingBlockView chip shell so the two read as one family.
 */
export const WorkingChipView = React.memo(function WorkingChipView({ message }: { message: ChatMessage }): JSX.Element | null {
  const theme = useTheme()
  const fonts = useFonts()

  const activeThinking = (message.thinkingBlocks ?? []).find(t => !t.done)
  const activeTool = (() => {
    const blocks = message.toolBlocks ?? []
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].status === 'running') return blocks[i]
    }
    return null
  })()

  if (!message.isStreaming) return null
  if (activeThinking) return null

  const label = activeTool
    ? `Running ${getToolBlockDisplayName(activeTool)}`
    : 'Working'

  const lightLine = `color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
  const outerDarkLine = theme.mode === 'light'
    ? `color-mix(in srgb, ${theme.text.primary} 45%, transparent)`
    : `rgba(0,0,0,0.75)`

  return (
    <div style={{
      background: theme.chat.assistantBubble,
      border: '0.5px solid transparent',
      boxShadow: `var(--cs-edge-shadow), 0 0 0 0.5px ${lightLine}, 0 0 0 1px ${outerDarkLine}`,
      margin: 1,
      borderRadius: 8,
      overflow: 'hidden',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '0 8px',
      minHeight: 22,
      boxSizing: 'border-box',
      color: theme.chat.textSecondary,
      fontSize: 10.5,
      fontFamily: fonts.sans,
      fontWeight: 500,
      lineHeight: 1,
      width: 'fit-content',
      maxWidth: `min(calc(100% - 2px), ${TOOL_BLOCK_MAX_WIDTH}px)`,
      flex: '0 0 auto',
    }}>
      <Cog size={11} style={{
        opacity: 0.75,
        flexShrink: 0,
        animation: 'chat-spin 2.4s linear infinite',
      }} />
      <ShimmerText baseColor={theme.chat.textSecondary} style={{
        fontSize: 10.5, fontWeight: 500, lineHeight: 1,
        minWidth: 0,
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        textTransform: 'uppercase', letterSpacing: 0.3,
      }}>
        {label}
      </ShimmerText>
    </div>
  )
})

export const StreamingLivenessIndicator = React.memo(function StreamingLivenessIndicator({ lastActivityAtMs }: {
  lastActivityAtMs: number
}): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  // Share the global UI clock with thinking chips (no per-indicator setInterval).
  const nowMs = useSharedThinkingClock(true)

  const quietMs = Math.max(0, nowMs - lastActivityAtMs)
  const showCounter = quietMs > 2500
  const elapsedSec = Math.floor(quietMs / 1000)

  return (
    <div
      title={showCounter
        ? `Waiting on server — ${elapsedSec}s since last update`
        : 'Working…'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginRight: 4,
        color: theme.chat.muted,
        fontSize: 10.5,
        fontFamily: fonts.sans,
        lineHeight: 1,
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: showCounter ? theme.status.warning : theme.accent.base,
        animation: 'chat-pulse 1.6s ease-in-out infinite',
        display: 'inline-block',
      }} />
      {showCounter && (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {elapsedSec}s
        </span>
      )}
    </div>
  )
})
