import React, { useState, useMemo } from 'react'
import type { ExtensionChatProviderConfig } from '../../../../shared/types'
import {
  Brain, Bug, Check, ChevronRight, ClipboardCheck, Cog, Copy, FileText,
  Pencil, ShieldCheck, Sparkles, Wrench, Bot,
} from 'lucide-react'
import { basename } from '../../utils/dnd'
import { dispatchOpenLink } from '../../utils/links'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { ensureShimmerStyles, ChatMarkdown } from '../shared/streamdown-utils'
import { DiffView } from './DiffView'
import { CHAT_TILE_STYLES } from './chatStyles'
import {
  isLargeArtifact, isLargeMessage, measureText, previewText, splitRawDiffText, type RawDiffFile,
} from './largeContent'
import type { ChatSurfaceMenuEntry } from './ChatComposerMenus'
import { splitInsightSegments } from './insightSegments'
import { ToolBlockView } from './ToolBlockView'
import {
  splitMessageAttachmentPaths,
  withAlpha,
  splitExternalAgentMarkup,
} from './chatTileUtils'
import { CHAT_CHIP_ROW_STYLE, TOOLBAR_PILL_ICON_SIZE } from './chatTileLayout'

const THINKING_LEVELS: Record<string, number> = { none: 0, low: 1, medium: 2, adaptive: 3, high: 4, max: 5 }

export function ThinkingIcon({ level }: { level: string }): JSX.Element {
  const bars = THINKING_LEVELS[level] ?? 3
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Brain size={14} />
      <svg width="12" height="14" viewBox="0 0 10 12">
        {[0, 1, 2, 3, 4].map(i => (
          <rect
            key={i}
            x={i * 2}
            y={12 - (i + 1) * 2.2}
            width="1.4"
            height={(i + 1) * 2.2}
            rx="0.4"
            fill="currentColor"
            opacity={i < bars ? 1 : 0.2}
          />
        ))}
      </svg>
    </div>
  )
}

export function renderChatSurfaceIcon(icon: string | undefined, size = 14): JSX.Element {
  const name = String(icon ?? '').toLowerCase()
  if (name === 'sparkles' || name === 'builder') return <Sparkles size={size} />
  if (name === 'pencil' || name === 'sketch') return <Pencil size={size} />
  if (name === 'settings' || name === 'cog') return <Cog size={size} />
  if (name === 'clipboard-check' || name === 'qa-report') return <ClipboardCheck size={size} />
  if (name === 'bug' || name === 'qa-workbench') return <Bug size={size} />
  return <Wrench size={size} />
}

export function normalizeChatSurfaceMenuEntry(entry: any): ChatSurfaceMenuEntry {
  return {
    extId: String(entry.extId),
    surfaceId: String(entry.id ?? entry.surfaceId),
    label: String(entry.label ?? entry.id ?? entry.surfaceId),
    description: entry.description ? String(entry.description) : undefined,
    icon: entry.icon ? String(entry.icon) : undefined,
    emits: entry.emits === 'text' ? 'text' : 'image',
    defaultHeight: Number.isFinite(entry.defaultHeight) ? Number(entry.defaultHeight) : 260,
    minHeight: Number.isFinite(entry.minHeight) ? Number(entry.minHeight) : 160,
  }
}

function LargeTextBlock({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [expanded, setExpanded] = useState(false)
  const measure = useMemo(() => measureText(text), [text])
  const preview = useMemo(() => previewText(text), [text])

  if (expanded) {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 8,
            border: `1px solid ${theme.chat.assistantBubbleBorder}`,
            borderRadius: 8,
            background: theme.chat.assistantBubble,
            color: theme.chat.textSecondary,
            padding: '5px 9px',
            fontSize: fonts.secondarySize,
            cursor: 'pointer',
          }}
        >
          <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} />
          Collapse large message
        </button>
        <ChatMarkdown text={text} isStreaming={isStreaming} />
      </div>
    )
  }

  return (
    <div
      className={className}
      style={{
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderRadius: 10,
        background: theme.chat.assistantBubble,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${theme.chat.assistantBubbleBorder}` }}>
        <FileText size={13} color={theme.chat.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1, color: theme.chat.textSecondary, fontSize: fonts.secondarySize, fontWeight: 600 }}>
          Large message - {measure.lines.toLocaleString()} lines - {measure.chars.toLocaleString()} chars
        </div>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(text).catch(() => {}) }}
          title="Copy full message"
          style={{ border: 'none', background: 'transparent', color: theme.chat.muted, cursor: 'pointer', padding: 4, display: 'inline-flex' }}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            border: `1px solid ${theme.chat.assistantBubbleBorder}`,
            borderRadius: 7,
            background: theme.surface.panelMuted,
            color: theme.chat.textSecondary,
            padding: '4px 8px',
            fontSize: fonts.secondarySize,
            cursor: 'pointer',
          }}
        >
          Expand
        </button>
      </div>
      <pre
        className="allow-text-selection"
        style={{
          margin: 0,
          maxHeight: 320,
          overflow: 'auto',
          padding: 10,
          color: theme.chat.text,
          background: theme.surface.panelMuted,
          fontFamily: fonts.mono,
          fontSize: Math.max(10, fonts.size - 2),
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {preview}
      </pre>
    </div>
  )
}

function RawDiffFileBlock({ file }: { file: RawDiffFile }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [expanded, setExpanded] = useState(false)
  const [renderFull, setRenderFull] = useState(false)
  const large = useMemo(() => isLargeArtifact(file.diff), [file.diff])
  const preview = useMemo(() => previewText(file.diff), [file.diff])

  return (
    <div style={{ borderTop: `1px solid ${theme.chat.assistantBubbleBorder}` }}>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          border: 'none',
          background: 'transparent',
          color: theme.chat.textSecondary,
          padding: '7px 10px',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <ChevronRight size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: fonts.mono, fontSize: Math.max(10, fonts.size - 2) }}>
          {file.path}
        </span>
        <span style={{ color: theme.status.success, fontFamily: fonts.mono, fontSize: 11 }}>+{file.additions}</span>
        <span style={{ color: theme.status.danger, fontFamily: fonts.mono, fontSize: 11 }}>-{file.deletions}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 10px 10px' }}>
          {large && !renderFull ? (
            <>
              <pre
                className="allow-text-selection"
                style={{
                  margin: 0,
                  maxHeight: 280,
                  overflow: 'auto',
                  borderRadius: 8,
                  background: theme.surface.panelMuted,
                  color: theme.chat.text,
                  padding: 10,
                  fontFamily: fonts.mono,
                  fontSize: Math.max(10, fonts.size - 2),
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {preview}
              </pre>
              <button
                type="button"
                onClick={() => setRenderFull(true)}
                style={{
                  marginTop: 8,
                  border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                  borderRadius: 7,
                  background: theme.surface.panelMuted,
                  color: theme.chat.textSecondary,
                  padding: '4px 8px',
                  fontSize: fonts.secondarySize,
                  cursor: 'pointer',
                }}
              >
                Render full diff
              </button>
            </>
          ) : (
            <DiffView diff={file.diff} />
          )}
        </div>
      )}
    </div>
  )
}

function RawDiffBlock({ files }: { files: RawDiffFile[] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const totals = useMemo(() => files.reduce((acc, file) => ({
    additions: acc.additions + file.additions,
    deletions: acc.deletions + file.deletions,
  }), { additions: 0, deletions: 0 }), [files])
  const raw = useMemo(() => files.map(file => file.diff).join('\n\n'), [files])

  return (
    <div
      style={{
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderRadius: 12,
        background: theme.chat.assistantBubble,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
        <FileText size={13} color={theme.chat.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1, color: theme.chat.textSecondary, fontSize: fonts.secondarySize, fontWeight: 600 }}>
          Diff - {files.length} file{files.length === 1 ? '' : 's'}
        </div>
        <span style={{ color: theme.status.success, fontFamily: fonts.mono, fontSize: 11 }}>+{totals.additions}</span>
        <span style={{ color: theme.status.danger, fontFamily: fonts.mono, fontSize: 11 }}>-{totals.deletions}</span>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(raw).catch(() => {}) }}
          title="Copy raw diff"
          style={{ border: 'none', background: 'transparent', color: theme.chat.muted, cursor: 'pointer', padding: 4, display: 'inline-flex' }}
        >
          <Copy size={13} />
        </button>
      </div>
      {files.map((file, index) => <RawDiffFileBlock key={`${file.path}:${index}`} file={file} />)}
    </div>
  )
}

function looksLikeUnfencedDiff(text: string): boolean {
  const lines = text.split('\n')
  const hasHunk = lines.some(line => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line.trim()))
  const hasReviewDiffHeader = lines.some(line => /^review diff\s+a\/.+\s+(?:→|->)\s+b\/.+@@/.test(line.trim()))
  const markdownTrapLines = lines.filter(line => /^[+-]\s{2,}\S/.test(line)).length
  return (hasHunk || hasReviewDiffHeader) && markdownTrapLines >= 2
}

export function GuardedChatMarkdown({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const diff = useMemo(() => isStreaming ? null : splitRawDiffText(text), [isStreaming, text])

  if (!isStreaming && !diff && looksLikeUnfencedDiff(text)) {
    return (
      <div className={className} style={{ minWidth: 0 }}>
        <pre
          className="allow-text-selection"
          style={{
            margin: 0,
            maxWidth: '100%',
            overflow: 'auto',
            borderRadius: 8,
            background: theme.surface.panelMuted,
            color: theme.chat.text,
            padding: 10,
            fontFamily: fonts.mono,
            fontSize: Math.max(10, fonts.size - 2),
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </pre>
      </div>
    )
  }

  if (diff) {
    return (
      <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {diff.prefix && (
          isLargeMessage(diff.prefix)
            ? <LargeTextBlock text={diff.prefix} isStreaming={isStreaming} />
            : <ChatMarkdown text={diff.prefix} isStreaming={isStreaming} />
        )}
        <RawDiffBlock files={diff.files} />
      </div>
    )
  }

  if (isLargeMessage(text)) {
    return <LargeTextBlock text={text} isStreaming={isStreaming} className={className} />
  }

  return <ChatMarkdown text={text} isStreaming={isStreaming} className={className} />
}

export function getExtensionProviderIcon(icon: ExtensionChatProviderConfig['icon'] | undefined): React.ReactNode {
  switch (icon) {
    case 'server':
      return <ShieldCheck size={TOOLBAR_PILL_ICON_SIZE} />
    case 'plug':
      return <Wrench size={TOOLBAR_PILL_ICON_SIZE} />
    case 'bot':
    default:
      return <Bot size={TOOLBAR_PILL_ICON_SIZE} />
  }
}

const SHIMMER_ID = 'chat-tile-shimmer'

export function ensureChatMdStyle(): void {
  ensureShimmerStyles()
  let style = document.getElementById(SHIMMER_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = SHIMMER_ID
    document.head.appendChild(style)
  }
  style.textContent = CHAT_TILE_STYLES
}

interface InsightBlockProps {
  text: string
  closed: boolean
  isStreaming?: boolean
  accent: string
  textColor: string
}

const InsightBlock = React.memo(({ text, closed, isStreaming, accent, textColor }: InsightBlockProps): JSX.Element => {
  void closed
  // Pre-existing hole: InsightBlock referenced `theme` (boxShadow below) without
  // ever resolving it, unlike its 6 sibling components — a ReferenceError the
  // moment an insight rendered. Resolve it via the same hook the siblings use.
  const theme = useTheme()
  return (
    <div
      className="chat-insight"
      style={{
        // ── Glass panel in the active accent color ──────────────────────
        // Layered for the "tinted glass" effect:
        //   1. accent-tinted fill at ~14% so the color reads even against
        //      opaque backgrounds (chat surface is theme.surface.panel)
        //   2. backdrop-filter blur softens whatever sits behind
        //   3. hairline accent border at ~30% alpha gives the edge definition
        //      that the removed left rule used to provide
        background: withAlpha(accent, '24'),                          // ~14% tint
        backdropFilter: 'blur(14px) saturate(160%)',
        WebkitBackdropFilter: 'blur(14px) saturate(160%)',
        border: `1px solid ${withAlpha(accent, '4d')}`,               // ~30% accent edge
        borderRadius: 12,                                              // matches code-block radius cohesion
        padding: '12px 16px',
        margin: '10px 0',
        color: textColor,
        // Subtle inner highlight on the top edge — a small touch that
        // sells the "glass" reading without being explicit about it.
        // Drop shadow anchored on #000 in dark mode (text.primary would lift
        // toward white at high contrast and turn the shadow into a glow);
        // light mode keeps text.primary so the shadow is genuinely dark
        // against paper.
        boxShadow: `0 1px 0 0 ${withAlpha(accent, '14')} inset, 0 1px 2px ${theme.mode === 'light' ? `color-mix(in srgb, ${theme.text.primary} 4%, transparent)` : `rgba(0,0,0,0.18)`}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: accent,
          marginBottom: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>★</span>
        <span>Insight</span>
      </div>
      <GuardedChatMarkdown text={text} isStreaming={isStreaming} />
    </div>
  )
})

export const ChatMessageContent = React.memo(({
  text,
  isStreaming,
  isUser,
  className,
  readAttachmentPaths,
}: {
  text: string
  isStreaming?: boolean
  isUser?: boolean
  className?: string
  /** Paths that the model has demonstrably loaded via Read-style tools.
   *  Used to render a confirmation tick on attachment chips — must only be
   *  set when the attachment was actually consumed by the model. */
  readAttachmentPaths?: Set<string>
}) => {
  const theme = useTheme()
  const fonts = useAppFonts()
  const { bodyText, attachmentPaths } = useMemo(() => splitMessageAttachmentPaths(text), [text])
  // Chip colors must stay legible regardless of whether the parent message
  // bubble is dark (dark theme user bubble) or light (light theme user
  // bubble). In light mode we pick an explicitly-white chip surface with a
  // strong border and a forced-dark text colour so we don't blend into the
  // pale user bubble — previously `theme.surface.panelElevated` was nearly
  // identical to the bubble and child text colours were inheriting light
  // values from elsewhere, producing a "ghost chip" effect.
  void isUser
  const isLight = theme.mode === 'light'
  // Chip surfaces follow theme: in light mode the canvas-anchored chip should
  // read as paper, so use surface.app rather than panelElevated (which is the
  // chat shell background and would blend in). Borders come from the theme's
  // own gradient so contrast tracks.
  const chipBackground = isLight ? theme.surface.app : theme.surface.panelElevated
  const chipBorder = isLight ? theme.border.default : theme.border.default
  const chipText = theme.text.primary
  const chipMeta = theme.text.secondary

  const attachments = attachmentPaths.length > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: bodyText ? 8 : 0, minWidth: 0 }}>
      {bodyText && (
        <div
          style={{
            fontSize: Math.max(10, fonts.secondarySize - 1),
            color: chipMeta,
            fontWeight: 600,
            letterSpacing: 0.2,
          }}
        >
          Attached file paths
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
        {attachmentPaths.map(path => {
          const wasRead = readAttachmentPaths?.has(path) === true
          return (
            <button
              key={path}
              type="button"
              title={wasRead ? `${path} — read by the model` : path}
              onClick={() => { void dispatchOpenLink(path) }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
                maxWidth: '100%',
                borderRadius: 6,
                border: `1px solid ${chipBorder}`,
                background: chipBackground,
                color: chipText,
                padding: '3px 7px',
                cursor: 'pointer',
              }}
            >
              <FileText size={10} color={chipText} style={{ flexShrink: 0, opacity: 0.85 }} />
              <span
                style={{
                  minWidth: 0,
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: Math.max(10, fonts.size - 2),
                  lineHeight: 1.2,
                  color: chipText,
                  paddingRight: 0,
                }}
              >
                {basename(path)}
              </span>
              {wasRead && (
                <Check
                  size={10}
                  color={theme.status.success}
                  style={{ flexShrink: 0, marginRight: 0 }}
                  aria-label="Read by the model"
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  // Hooks must run unconditionally before the early return below: bodyText
  // flips between empty and non-empty while attachment markers stream in,
  // and a conditional hook count would crash React.
  const accent = theme.accent.base
  const textColor = theme.text.primary
  const externalAgentSegments = useMemo(() => splitExternalAgentMarkup(bodyText), [bodyText])
  const hasExternalAgentMarkup = externalAgentSegments.some(seg => seg.kind === 'tool')
  const segments = useMemo(() => splitInsightSegments(bodyText), [bodyText])

  if (!bodyText) return attachments ?? null

  // Split body into markdown / insight segments. Insights become styled
  // blocks rendered with the active accent color; everything else flows
  // through the normal markdown pipeline.
  const renderedBody = hasExternalAgentMarkup
    ? (
      <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {(() => {
          const elements: JSX.Element[] = []
          let chipRow: JSX.Element[] = []
          let chipRowStart = 0
          const flushChipRow = () => {
            if (chipRow.length === 0) return
            elements.push(
              <div key={`external-tool-row-${chipRowStart}`} style={CHAT_CHIP_ROW_STYLE}>
                {chipRow}
              </div>
            )
            chipRow = []
          }
          externalAgentSegments.forEach((seg, i) => {
            if (seg.kind === 'tool') {
              if (chipRow.length === 0) chipRowStart = i
              chipRow.push(<ToolBlockView key={seg.block.id} block={seg.block} />)
              return
            }
            if (!seg.text.trim()) return
            flushChipRow()
            elements.push(<GuardedChatMarkdown key={`external-md-${i}`} text={seg.text} isStreaming={isStreaming} />)
          })
          flushChipRow()
          return elements
        })()}
      </div>
    )
    : segments.length === 1 && segments[0].kind === 'md'
      ? <GuardedChatMarkdown text={segments[0].text} isStreaming={isStreaming} className={className} />
      : (
        <div className={className}>
          {segments.map((seg, i) => seg.kind === 'insight'
            ? <InsightBlock key={i} text={seg.text} closed={seg.closed} isStreaming={isStreaming} accent={accent} textColor={textColor} />
            : <GuardedChatMarkdown key={i} text={seg.text} isStreaming={isStreaming} />
          )}
        </div>
      )

  if (!attachments) return renderedBody
  return <>{renderedBody}{attachments}</>
})