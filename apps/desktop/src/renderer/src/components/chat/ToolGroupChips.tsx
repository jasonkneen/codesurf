import React, { useState, startTransition } from 'react'
import { Brain, Check, ChevronRight, Cog, Wrench } from 'lucide-react'
import type { ToolBlock } from '../../../../shared/chat-types'
import { useTheme } from '../../ThemeContext'
import {
  useFonts,
  TOOL_BLOCK_MAX_WIDTH,
} from './chatTileContexts'
import { getToolDisplayName } from './chatTileUtils'
import { ToolBlockView } from './ToolBlockViewCore'

export const MixedToolGroup = React.memo(function MixedToolGroup({ blocks }: { blocks: ToolBlock[] }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const toggle = () => startTransition(() => setExpanded(e => !e))

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: expanded ? 6 : 0,
      width: 'fit-content',
      maxWidth: '100%',
      minWidth: 0,
      flex: '0 0 auto',
    }}>
      <div
        onClick={toggle}
        style={{
          background: theme.chat.assistantBubble,
          border: '0.5px solid transparent',
          boxShadow: theme.mode === 'light'
            ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
            : 'var(--cs-edge-shadow)',
          margin: 1,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 8px',
          minHeight: 22,
          boxSizing: 'border-box',
          cursor: 'pointer',
          color: theme.chat.muted,
          fontSize: 10,
          fontFamily: fonts.sans,
          lineHeight: 1,
          width: 'fit-content',
          maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
        }}
      >
        <Wrench size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
        <span style={{
          fontWeight: 500, fontSize: 10.5, lineHeight: 1,
          minWidth: 0, flex: '1 1 auto',
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          textTransform: 'uppercase', letterSpacing: 0.3,
        }}>
          {blocks.length} tools
        </span>
        <Check size={11} color={theme.status.success} style={{ flexShrink: 0 }} />
        <ChevronRight size={12} style={{
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
          opacity: 0.4,
          flexShrink: 0,
        }} />
      </div>
      {expanded && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'flex-start',
          alignContent: 'flex-start',
          maxWidth: '100%',
          overflow: 'visible',
        }}>
          {blocks.map(b => <ToolBlockView key={b.id} block={b} />)}
        </div>
      )}
    </div>
  )
})

/** Collapses consecutive same-name completed tool chips into "5 reads" style. */
function getGroupedToolLabel(name: string, count: number): string {
  const label = getToolDisplayName(name).trim() || 'tool'
  const plural = count === 1 || label.toLowerCase().endsWith('s') ? label : `${label}s`
  return `${count} ${plural}`
}

export const CollapsedToolGroup = React.memo(function CollapsedToolGroup({ name, blocks }: { name: string; blocks: ToolBlock[] }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const toggle = () => startTransition(() => setExpanded(e => !e))

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: expanded ? 6 : 0,
      width: 'fit-content',
      maxWidth: '100%',
      minWidth: 0,
      flex: '0 0 auto',
    }}>
      <div
        onClick={toggle}
        style={{
          background: theme.chat.assistantBubble,
          border: '0.5px solid transparent',
          boxShadow: theme.mode === 'light'
            ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
            : 'var(--cs-edge-shadow)',
          margin: 1,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 8px',
          minHeight: 22,
          boxSizing: 'border-box',
          cursor: 'pointer',
          color: theme.chat.muted,
          fontSize: 10,
          fontFamily: fonts.sans,
          lineHeight: 1,
          width: 'fit-content',
          maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
        }}
      >
        <Wrench size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
        <span style={{
          fontWeight: 500, fontSize: 10.5, lineHeight: 1,
          minWidth: 0, flex: '1 1 auto',
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          textTransform: 'uppercase', letterSpacing: 0.3,
        }}>
          {getGroupedToolLabel(name, blocks.length)}
        </span>
        <Check size={11} color={theme.status.success} style={{ flexShrink: 0 }} />
        <ChevronRight size={12} style={{
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
          opacity: 0.4,
          flexShrink: 0,
        }} />
      </div>
      {expanded && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'flex-start',
          alignContent: 'flex-start',
          maxWidth: '100%',
          overflow: 'visible',
        }}>
          {blocks.map(b => <ToolBlockView key={b.id} block={b} />)}
        </div>
      )}
    </div>
  )
})


/**
 * Compact grok-cli-style summary chip for name-based collation. Unlike
 * CollapsedToolGroup (which expands vertically below itself), this chip is
 * *controlled* — clicking toggles `expanded` via `onToggle`, and the parent
 * chip row renders the exploded children inline as siblings. Given an accent
 * colour scheme so the summary stands out from the plain tool chips around it.
 */
function CollationSummaryChip({ icon, label, count, expanded, onToggle }: {
  icon: JSX.Element
  label: string
  count: number
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const accent = theme.accent.base
  return (
    <button
      type="button"
      onClick={onToggle}
      title={expanded ? 'Collapse' : 'Expand'}
      style={{
        background: `color-mix(in srgb, ${accent} 14%, ${theme.chat.assistantBubble})`,
        border: `0.5px solid color-mix(in srgb, ${accent} 45%, transparent)`,
        boxShadow: 'var(--cs-edge-shadow)',
        margin: 1,
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 8px',
        minHeight: 22,
        boxSizing: 'border-box',
        cursor: 'pointer',
        color: `color-mix(in srgb, ${accent} 70%, ${theme.chat.text})`,
        fontSize: 10.5,
        fontFamily: fonts.sans,
        fontWeight: 600,
        lineHeight: 1,
        width: 'fit-content',
        maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
        flex: '0 0 auto',
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      {icon}
      <span style={{
        fontWeight: 600, fontSize: 10.5, lineHeight: 1,
        minWidth: 0, flex: '1 1 auto',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        letterSpacing: 0.3, fontVariantNumeric: 'tabular-nums',
      }}>
        {count}×{label}
      </span>
      <ChevronRight size={12} style={{
        transform: expanded ? 'rotate(90deg)' : 'none',
        transition: 'transform 0.15s',
        opacity: 0.55, flexShrink: 0,
      }} />
    </button>
  )
}

/** Tier-1 group summary: `3×READ`. Controlled inline-explode chip. */
export const ToolGroupChip = React.memo(function ToolGroupChip({ toolName, count, expanded, onToggle }: {
  toolName: string
  count: number
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const theme = useTheme()
  return (
    <CollationSummaryChip
      icon={<Wrench size={11} style={{ opacity: 0.7, flexShrink: 0, color: theme.accent.base }} />}
      label={getToolDisplayName(toolName).toUpperCase()}
      count={count}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
})

/** Thinking summary: `12×THOUGHT`. Controlled inline-explode chip. */
export const ThinkingGroupChip = React.memo(function ThinkingGroupChip({ count, expanded, onToggle }: {
  count: number
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const theme = useTheme()
  return (
    <CollationSummaryChip
      icon={<Brain size={11} style={{ opacity: 0.75, flexShrink: 0, color: theme.accent.base }} />}
      label="THOUGHT"
      count={count}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
})

/** Tier-2 mega summary: `12×TOOLS`. Controlled inline-explode chip. */
export const ToolMegaChip = React.memo(function ToolMegaChip({ count, expanded, onToggle }: {
  count: number
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const theme = useTheme()
  return (
    <CollationSummaryChip
      icon={<Cog size={11} style={{ opacity: 0.75, flexShrink: 0, color: theme.accent.base }} />}
      label="TOOLS"
      count={count}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
})


