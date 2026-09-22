import { ChevronRight } from 'lucide-react'
import type { FileChange } from '../../../../shared/chat-types'
import { useTheme } from '../../ThemeContext'
import { DiffView } from './DiffView'
import { ChatComposerDrawerFrame } from './ChatComposer'
import {
  CHAT_COMPOSER_WIDTH,
  CHAT_COMPOSER_MIN_WIDTH_STYLE,
} from './chatTileLayout'
import {
  hasRenderableFileChangeDiff,
  hasVisibleFileChangeStats,
} from './chatTileUtils'

export type LatestChangeDrawerState = {
  key: string
  messageId: string
  toolBlockId: string
  fileChanges: FileChange[]
  fileCount: number
  additions: number
  deletions: number
  changeBlockCount: number
}

const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

export interface ChatTileLatestChangeDrawerProps {
  drawer: LatestChangeDrawerState
  hasStats: boolean
  expanded: boolean
  expandedFiles: Record<string, boolean>
  latestCheckpointId: string | null
  isRestoringLatestCheckpoint: boolean
  fontSans: string
  monoSize: number
  onToggleExpanded: () => void
  onToggleFile: (fileKey: string) => void
  onRestoreLatestCheckpoint: () => void
  onReviewLatestChanges: () => void
}

export function ChatTileLatestChangeDrawer({
  drawer,
  hasStats,
  expanded,
  expandedFiles,
  latestCheckpointId,
  isRestoringLatestCheckpoint,
  fontSans,
  monoSize,
  onToggleExpanded,
  onToggleFile,
  onRestoreLatestCheckpoint,
  onReviewLatestChanges,
}: ChatTileLatestChangeDrawerProps): JSX.Element {
  const theme = useTheme()

  return (
    <ChatComposerDrawerFrame style={{
      width: `calc(${CHAT_COMPOSER_WIDTH} - 24px)`,
      minWidth: `calc(${CHAT_COMPOSER_MIN_WIDTH_STYLE} - 24px)`,
      margin: '0 auto 0 auto',
    }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 14px',
          ...NON_SELECTABLE_UI_STYLE,
        }}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flexWrap: 'wrap',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
            color: theme.chat.textSecondary,
            fontFamily: fontSans,
            ...NON_SELECTABLE_UI_STYLE,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: theme.chat.text }}>
            {drawer.fileCount} file{drawer.fileCount === 1 ? '' : 's'} changed
          </span>
          {hasStats && (
            <>
              <span style={{ fontSize: 12, fontWeight: 600, color: theme.status.success }}>
                +{drawer.additions}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: theme.status.danger }}>
                -{drawer.deletions}
              </span>
            </>
          )}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {latestCheckpointId && (
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onRestoreLatestCheckpoint()
              }}
              disabled={isRestoringLatestCheckpoint}
              style={{
                border: 'none',
                background: 'transparent',
                color: isRestoringLatestCheckpoint ? theme.chat.muted : theme.chat.text,
                fontSize: 12,
                fontFamily: fontSans,
                fontWeight: 500,
                cursor: isRestoringLatestCheckpoint ? 'default' : 'pointer',
                padding: 0,
                opacity: isRestoringLatestCheckpoint ? 0.6 : 1,
                ...NON_SELECTABLE_UI_STYLE,
              }}
            >
              {isRestoringLatestCheckpoint ? 'Undoing…' : 'Undo'}
            </button>
          )}
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              onToggleExpanded()
            }}
            title={expanded ? 'Collapse changes' : 'Expand changes'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              border: 'none',
              background: 'transparent',
              color: theme.chat.textSecondary,
              cursor: 'pointer',
              padding: 0,
              ...NON_SELECTABLE_UI_STYLE,
            }}
          >
            <ChevronRight size={14} style={{
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s',
              opacity: 0.55,
            }} />
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{
          borderTop: `1px solid ${theme.chat.divider}`,
          display: 'flex',
          flexDirection: 'column',
        }}>
          {drawer.fileChanges.map((change, index) => {
            const fileKey = `${drawer.key}:${change.path}:${index}`
            const fileHasDiff = hasRenderableFileChangeDiff(change)
            const isFileExpanded = expandedFiles[fileKey] ?? false
            const fileHasStats = hasVisibleFileChangeStats(change)
            return (
              <div
                key={fileKey}
                style={{
                  borderTop: index > 0 ? `1px solid ${theme.chat.divider}` : 'none',
                  background: theme.surface.panelMuted,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (fileHasDiff) onToggleFile(fileKey)
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '12px 14px',
                    border: 'none',
                    background: 'transparent',
                    cursor: fileHasDiff ? 'pointer' : 'default',
                    textAlign: 'left',
                    color: theme.chat.text,
                    fontFamily: fontSans,
                    fontSize: 12,
                    ...NON_SELECTABLE_UI_STYLE,
                  }}
                >
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {change.path}
                  </span>
                  {fileHasStats && (
                    <>
                      <span style={{ color: theme.status.success, fontWeight: 600, flexShrink: 0 }}>
                        +{change.additions}
                      </span>
                      <span style={{ color: theme.status.danger, fontWeight: 600, flexShrink: 0 }}>
                        -{change.deletions}
                      </span>
                    </>
                  )}
                  <ChevronRight size={14} style={{
                    transform: isFileExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.15s',
                    opacity: fileHasDiff ? 0.55 : 0,
                    flexShrink: 0,
                  }} />
                </button>
                {isFileExpanded && fileHasDiff && (
                  <div style={{ borderTop: `1px solid ${theme.chat.divider}` }}>
                    <DiffView
                      diff={change.diff}
                      path={change.path}
                      fontSize={Math.max(10, monoSize - 2)}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 14px 12px',
            borderTop: `1px solid ${theme.chat.divider}`,
            background: theme.surface.panelMuted,
          }}>
            <button
              type="button"
              onClick={onReviewLatestChanges}
              style={{
                border: 'none',
                background: 'transparent',
                color: theme.chat.textSecondary,
                fontSize: 11,
                fontFamily: fontSans,
                fontWeight: 500,
                cursor: 'pointer',
                padding: 0,
                ...NON_SELECTABLE_UI_STYLE,
              }}
            >
              Jump to message
            </button>
          </div>
        </div>
      )}
    </ChatComposerDrawerFrame>
  )
}