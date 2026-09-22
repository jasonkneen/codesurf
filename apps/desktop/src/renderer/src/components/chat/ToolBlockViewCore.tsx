import React, { useState, useMemo, useCallback, startTransition } from 'react'
import { Check, ChevronRight, Clock, History, RotateCcw, Sparkles, Wrench } from 'lucide-react'
import type { ToolBlock } from '../../../../shared/chat-types'
import { useTheme } from '../../ThemeContext'
import { ShimmerText } from '../shared/streamdown-utils'
import { DiffView } from './DiffView'
import { isCheckpointToolBlock, getCheckpointRestoreAction } from './checkpointToolActions'
import { isDreamToolBlock } from './dreamToolActions'
import {
  parseAskUserQuestionInput,
  AskUserQuestionChip,
} from './AskUserQuestionForm'
import {
  ToolPermissionCard,
  useToolPermissionContext,
} from '../ai-elements/ToolPermission'
import {
  useFonts,
  CheckpointRestoreContext,
  TOOL_BLOCK_MAX_WIDTH,
  NON_SELECTABLE_UI_STYLE,
} from './chatTileContexts'
import {
  getToolDisplayName,
  hasVisibleFileChangeStats,
  hasRenderableFileChangeDiff,
} from './chatTileUtils'
import { ToolInputView } from './ToolInputView'

function getToolBlockDisplayName(block: ToolBlock): string {
  return block.displayName ?? getToolDisplayName(block.name)
}

export const ToolBlockView = React.memo(function ToolBlockView({ block, isLive = false, chipVariant }: { block: ToolBlock; isLive?: boolean; chipVariant?: 'a' | 'b' }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const codePanelFontSize = Math.max(11, fonts.size - 1)
  const isFileChangeBlock = (block.fileChanges?.length ?? 0) > 0
  const displayName = getToolBlockDisplayName(block)
  const rawToolName = block.rawName ?? block.name
  const checkpointRestoreCtx = React.useContext(CheckpointRestoreContext)

  const permissionCtx = useToolPermissionContext()
  const permissionRequest = permissionCtx?.pending.get(block.id) ?? null
  const resolvedDecision = permissionCtx?.resolved.get(block.id) ?? null

  // All hooks must run unconditionally before the early returns below:
  // permissionRequest/resolvedDecision and block.summary change over the
  // lifetime of a single mounted chip, so a conditional hook count would
  // crash React with a "rendered more/fewer hooks" error.
  const fileChangeSummary = useMemo(() => {
    const fileChanges = block.fileChanges ?? []
    return {
      fileCount: fileChanges.length,
      additions: fileChanges.reduce((sum, change) => sum + change.additions, 0),
      deletions: fileChanges.reduce((sum, change) => sum + change.deletions, 0),
    }
  }, [block.fileChanges])
  const [expanded, setExpanded] = useState(isFileChangeBlock)
  // For file-change blocks default the per-file diff panels to open: the
  // whole reason we're showing a file-change block is the diff itself. For
  // regular tool blocks (Bash output, etc.) default to closed — users click
  // to drill in.
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>(() => {
    if (!isFileChangeBlock) return {}
    const map: Record<string, boolean> = {}
    block.fileChanges?.forEach((change, index) => {
      map[`${change.path}:${index}`] = hasRenderableFileChangeDiff(change)
    })
    return map
  })
  const toggleFile = useCallback((key: string) => {
    setExpandedFiles(prev => {
      const current = prev[key] ?? false
      return { ...prev, [key]: !current }
    })
  }, [])

  // Intercept tool-permission requests — when the agent needs user approval for
  // this tool call, show an inline Allow/Deny prompt instead of (or alongside)
  // the raw tool chip. Mirrors the AskUserQuestion pattern.
  if (permissionRequest || resolvedDecision) {
    return (
      <ToolPermissionCard
        toolId={block.id}
        fallbackToolName={rawToolName}
        request={permissionRequest}
        resolvedDecision={resolvedDecision}
        theme={theme}
        fonts={{ sans: fonts.sans, mono: fonts.mono }}
      />
    )
  }

  // Intercept AskUserQuestion tool blocks: render an interactive form so the user
  // can actually answer the question instead of seeing a raw JSON chip.
  // Once submitted, the main process emits a tool_summary so `block.summary`
  // is set, at which point we fall through to the normal chip rendering.
  if ((block.name === 'AskUserQuestion' || block.canonicalName === 'ask_user') && !block.summary) {
    const askPayload = parseAskUserQuestionInput(block.input)
    if (askPayload && askPayload.questions.length > 0) {
      return (
        <AskUserQuestionChip
          block={block}
          payload={askPayload}
        />
      )
    }
  }
  const isRunning = isLive && block.status === 'running'
  const hasNestedData = (block.fileChanges?.length ?? 0) > 0 || (block.commandEntries?.length ?? 0) > 0
  const isCheckpoint = isCheckpointToolBlock(block)
  const isDream = isDreamToolBlock(block)
  const checkpointRestoreAction = checkpointRestoreCtx
    ? getCheckpointRestoreAction(block, checkpointRestoreCtx)
    : null
  const isRestoringCheckpoint = Boolean(
    checkpointRestoreAction
    && checkpointRestoreCtx?.restoringCheckpointId === checkpointRestoreAction.checkpointId,
  )

  return (
    <div
      data-tool-block-kind={isFileChangeBlock ? 'file-changes' : 'tool'}
      title={displayName === rawToolName ? undefined : `${displayName} (${rawToolName})`}
      style={{
        background: theme.chat.assistantBubble,
        border: '0.5px solid transparent',
        boxShadow: (() => {
          const lightLine = `color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
          const base = `var(--cs-edge-shadow), 0 0 0 0.5px ${lightLine}`
          const outerDarkLine = theme.mode === 'light'
            ? `color-mix(in srgb, ${theme.text.primary} 45%, transparent)`
            : `rgba(0,0,0,0.75)`
          if (chipVariant) return `${base}, 0 0 0 1px ${outerDarkLine}`
          return base
        })(),
        margin: 1,
        borderRadius: 8,
        overflow: 'hidden',
        maxWidth: expanded || isFileChangeBlock ? 'calc(100% - 2px)' : `min(calc(100% - 2px), ${TOOL_BLOCK_MAX_WIDTH}px)`,
        width: expanded || isFileChangeBlock ? 'calc(100% - 2px)' : 'fit-content',
        alignSelf: 'stretch',
        flex: expanded || isFileChangeBlock ? '1 1 100%' : '0 0 auto',
        minWidth: 0,
      }}
    >
      <button
        onClick={() => startTransition(() => setExpanded(e => !e))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          width: '100%',
          maxWidth: expanded || isFileChangeBlock ? '100%' : `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
          padding: isFileChangeBlock ? '12px 16px' : '0 8px',
          // ToolBlockView is a nested chip: the outer <div> carries the 1px
          // border, so we shave 2px off the inner button's minHeight to land
          // at an outer rendered height of 22px — matching the single-layer
          // ThinkingBlockView / CollapsedToolGroup / MixedToolGroup chips so
          // they line up on a shared chip row.
          minHeight: isFileChangeBlock ? undefined : 20,
          boxSizing: 'border-box',
          background: 'none', border: 'none',
          cursor: 'pointer',
          color: isDream
            ? theme.accent.base
            : (isRunning ? theme.chat.textSecondary : theme.chat.muted),
          fontSize: 10, fontFamily: fonts.sans, lineHeight: 1, minWidth: 0,
        }}
      >
        {isDream
          ? <Sparkles size={11} style={{ color: theme.accent.base, opacity: 0.95, flexShrink: 0 }} />
          : isCheckpoint
            ? <History size={11} style={{ opacity: 0.62, flexShrink: 0 }} />
            : <Wrench size={11} style={{ opacity: isRunning ? 0.7 : 0.5, flexShrink: 0 }} />}

        {/* Collapsed chip header shows only the tool name. Detailed summaries stay in the expanded body. */}
        {isRunning ? (
          <ShimmerText baseColor={theme.chat.textSecondary} style={{
            fontSize: 10.5,
            fontFamily: fonts.sans,
            fontWeight: 500,
            minWidth: 0,
            flex: expanded || isFileChangeBlock ? 1 : '0 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textTransform: 'uppercase', letterSpacing: 0.3,
            }}>
            {displayName}
          </ShimmerText>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            minWidth: 0,
            flex: expanded || isFileChangeBlock ? 1 : '0 1 auto',
            overflow: 'hidden',
          }}>
            {isFileChangeBlock ? (
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                minWidth: 0,
                flexWrap: 'nowrap',
                overflow: 'hidden',
              }}>
                <span style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: 10.5,
                  color: theme.chat.text,
                  flexShrink: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}>
                  {fileChangeSummary.fileCount} file{fileChangeSummary.fileCount === 1 ? '' : 's'} changed
                </span>
                {hasVisibleFileChangeStats(fileChangeSummary) && (
                  <>
                    <span style={{ color: theme.status.success, fontSize: 10.5, fontWeight: 600, flexShrink: 0 }}>
                      +{fileChangeSummary.additions}
                    </span>
                    <span style={{ color: theme.status.danger, fontSize: 10.5, fontWeight: 600, flexShrink: 0 }}>
                      -{fileChangeSummary.deletions}
                    </span>
                  </>
                )}
              </div>
            ) : (
              <span style={{
                fontWeight: 500,
                fontSize: 10.5,
                flex: '1 1 auto',
                flexShrink: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textTransform: 'uppercase', letterSpacing: 0.3,
              }}>
                {displayName}
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto', flexShrink: 0 }}>
          {block.elapsed != null && (
            <span style={{
              fontSize: 10, color: theme.chat.muted, display: 'flex', alignItems: 'center', gap: 3,
              fontFamily: fonts.mono, flexShrink: 0,
            }}>
              <Clock size={9} /> {block.elapsed.toFixed(1)}s
            </span>
          )}
          {!isRunning && !block.elapsed && (
            <Check size={11} color={isCheckpoint ? theme.chat.muted : theme.status.success} style={{ flexShrink: 0, opacity: isCheckpoint ? 0.75 : 1 }} />
          )}
          <ChevronRight size={12} style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
            opacity: 0.4, flexShrink: 0,
          }} />
        </div>
      </button>

      {/* Expanded: show imported file-change structure first when available */}
      {expanded && hasNestedData && (
        <div style={{
          padding: isFileChangeBlock ? 0 : '4px 10px 8px 10px',
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
        }}>
          {(block.fileChanges?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: isFileChangeBlock ? 0 : 6 }}>
              {block.fileChanges?.map((change, index) => {
                const fileKey = `${change.path}:${index}`
                const fileHasDiff = hasRenderableFileChangeDiff(change)
                const isExpanded = expandedFiles[fileKey] ?? false
                return (
                  <div key={fileKey} style={{
                    borderRadius: isFileChangeBlock ? 0 : 8,
                    border: isFileChangeBlock
                      ? 'none'
                      : `1px solid ${theme.chat.assistantBubbleBorder}`,
                    overflow: 'hidden',
                    background: isFileChangeBlock ? 'transparent' : theme.surface.panelMuted,
                    borderTop: isFileChangeBlock && index > 0 ? `1px solid ${theme.chat.assistantBubbleBorder}` : undefined,
                  }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (fileHasDiff) toggleFile(fileKey)
                      }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        background: 'transparent',
                        border: 'none',
                        padding: isFileChangeBlock ? '14px 16px' : '8px 10px',
                        cursor: fileHasDiff ? 'pointer' : 'default',
                        color: theme.chat.text,
                        fontFamily: isFileChangeBlock ? fonts.sans : fonts.mono,
                        fontSize: isFileChangeBlock ? fonts.size : 11,
                        fontWeight: isFileChangeBlock ? 500 : fonts.monoWeight,
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {change.path}
                      </span>
                      {hasVisibleFileChangeStats(change) && (
                        <>
                          <span style={{ color: theme.status.success, flexShrink: 0 }}>+{change.additions}</span>
                          <span style={{ color: theme.status.danger, flexShrink: 0 }}>-{change.deletions}</span>
                        </>
                      )}
                      <ChevronRight size={12} style={{
                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                        transition: 'transform 0.15s',
                        opacity: fileHasDiff ? 0.5 : 0,
                        flexShrink: 0,
                      }} />
                    </button>
                    {isExpanded && fileHasDiff && (
                      <div style={{ borderTop: `1px solid ${theme.chat.assistantBubbleBorder}` }}>
                        <DiffView
                          diff={change.diff}
                          path={change.path}
                          fontSize={codePanelFontSize}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {(block.commandEntries?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: (block.fileChanges?.length ?? 0) > 0 ? 8 : 0 }}>
              {block.commandEntries?.map((entry, index) => (
                <div key={`${entry.command ?? entry.label}:${index}`} style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: theme.chat.background,
                  border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                }}>
                  <div style={{
                    fontSize: codePanelFontSize,
                    color: theme.chat.text,
                    fontFamily: fonts.mono,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {entry.command ?? entry.label}
                  </div>
                  {entry.output && (
                    <pre style={{
                      margin: '6px 0 0',
                      fontSize: codePanelFontSize,
                      lineHeight: fonts.monoLineHeight,
                      color: theme.chat.muted,
                      fontFamily: fonts.mono,
                      fontWeight: fonts.monoWeight,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 120,
                      overflowY: 'auto',
                    }}>
                      {entry.output}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

        </div>
      )}

      {expanded && checkpointRestoreAction && (
        <div style={{
          padding: '8px 10px',
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {block.input && (
            <ToolInputView
              toolName={rawToolName}
              input={block.input}
              codePanelFontSize={codePanelFontSize}
            />
          )}
          {block.summary && (
            <div style={{
              fontSize: 11,
              color: theme.chat.muted,
              fontFamily: fonts.sans,
              lineHeight: 1.4,
            }}>
              {block.summary}
            </div>
          )}
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              if (!checkpointRestoreCtx || !checkpointRestoreAction || isRestoringCheckpoint) return
              void checkpointRestoreCtx.restoreCheckpoint(
                checkpointRestoreAction.checkpointId,
                checkpointRestoreAction.sessionEntryId,
                checkpointRestoreAction.label,
              )
            }}
            disabled={isRestoringCheckpoint || !checkpointRestoreCtx}
            title="Restore workspace files from this checkpoint"
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${theme.chat.assistantBubbleBorder}`,
              background: theme.surface.panelMuted,
              color: isRestoringCheckpoint ? theme.chat.muted : theme.chat.text,
              borderRadius: 999,
              padding: '5px 9px',
              fontSize: 11,
              fontFamily: fonts.sans,
              fontWeight: 600,
              cursor: isRestoringCheckpoint ? 'default' : 'pointer',
              opacity: isRestoringCheckpoint ? 0.65 : 1,
              ...NON_SELECTABLE_UI_STYLE,
            }}
          >
            <RotateCcw size={12} />
            {isRestoringCheckpoint ? 'Restoring…' : 'Restore this checkpoint'}
          </button>
        </div>
      )}

      {expanded && !checkpointRestoreAction && !hasNestedData && block.input && (
        <div style={{
          padding: '4px 10px 8px 10px',
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
        }}>
          <ToolInputView
            toolName={rawToolName}
            input={block.input}
            codePanelFontSize={codePanelFontSize}
          />
          {block.summary && (
            <div style={{
              marginTop: 6, padding: '4px 0',
              fontSize: 11, color: theme.chat.muted, fontFamily: fonts.mono,
            }}>
              {block.summary}
            </div>
          )}
        </div>
      )}

    </div>
  )
})

