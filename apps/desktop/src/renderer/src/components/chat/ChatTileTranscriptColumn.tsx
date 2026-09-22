import React from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage } from '../../../../shared/chat-types'
import type { Persona, VoiceSettings } from '../../../../shared/types'
import type { TtsPlayerState } from '../../utils/ttsPlayer'
import type { BlockNoteTarget } from '../../hooks/useChatTileBlockNotes'
import { useTheme } from '../../ThemeContext'
import { ChatTileTranscriptMessages } from './ChatTileTranscriptMessages'
import { ChatTileLatestChangeDrawer, type LatestChangeDrawerState } from './ChatTileLatestChangeDrawer'
import { ChatTileQueuedTurnsDrawer } from './ChatTileQueuedTurnsDrawer'
import { CHAT_MESSAGE_MAX_WIDTH } from './chatTileLayout'
import type { QueuedChatTurn } from './chatTileTypes'
import { useTileTranscriptMessages } from '../../hooks/useTileTranscriptMessages'

const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

export interface ChatTileTranscriptColumnProps {
  workspaceId: string
  tileId: string
  isStartScreen: boolean
  messagesRef: React.RefObject<HTMLDivElement | null>
  stickToBottomRef: React.RefObject<boolean>
  handleMessagesScroll: () => void
  handleMessagesWheel: (event: React.WheelEvent<HTMLDivElement>) => void
  handleMessagesKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  hiddenMessageCount: number
  renderedMessages: ChatMessage[]
  pagedLinkedHistoryEnabled: boolean
  loadingEarlier: boolean
  earlierLoadError: string | null
  isStreaming: boolean
  toolCollapseTick: number
  explodedChipGroups: ReadonlySet<string>
  toggleExplodedChipGroup: (clusterId: string, collationId: string) => void
  updateBlockNote: (target: BlockNoteTarget, text: string | null) => void
  setAnnotationComposerActive: (active: boolean) => void
  readAttachmentPaths: Set<string>
  fontSize: number
  fontLineHeight: number
  fontMono: string
  monoSize: number
  ttsState: TtsPlayerState
  voiceSettings: Pick<VoiceSettings, 'ttsProvider' | 'ttsVoice' | 'spokifyModel'>
  showScrollToLatest: boolean
  scrollToLatest: () => void
  liveComposerActivityChip: React.ReactNode
  latestChangeDrawer: LatestChangeDrawerState | null
  latestChangeDrawerHasStats: boolean
  latestChangeDrawerExpanded: boolean
  latestChangeDrawerExpandedFiles: Record<string, boolean>
  latestCheckpointId: string | null
  isRestoringLatestCheckpoint: boolean
  fontSans: string
  onToggleLatestChangeDrawerExpanded: () => void
  onToggleLatestChangeDrawerFile: (path: string) => void
  onRestoreLatestCheckpoint: () => void
  onReviewLatestChanges: () => void
  queuedTurns: QueuedChatTurn[]
  queueCollapsed: boolean
  draggingTurnId: string | null
  dragOverTurn: { id: string; mode: 'before' | 'after' | 'into' } | null
  onToggleQueueCollapsed: () => void
  onSetDraggingTurnId: (turnId: string | null) => void
  onSetDragOverTurn: (value: { id: string; mode: 'before' | 'after' | 'into' } | null) => void
  onReorderQueuedTurn: (draggedId: string, targetId: string, mode: 'before' | 'after' | 'into') => void
  onSteerQueuedTurn: (turn: QueuedChatTurn) => void
  onDeleteQueuedTurn: (turnId: string) => void
  /** Which body view to show — the transcript ('chat') or the embedded
   *  terminal ('terminal'). */
  activeView: 'chat' | 'terminal'
  /** The embedded terminal node, rendered once it has first been opened and
   *  kept mounted thereafter (hidden via layout-preserving CSS when on Chat).
   *  Null until the terminal has been opened at least once. */
  embeddedTerminal: React.ReactNode
  children: React.ReactNode
  personas: ReadonlyArray<Pick<Persona, 'id' | 'name' | 'color'>>
  fallbackProvider?: string | null
}

export function ChatTileTranscriptColumn({
  workspaceId,
  tileId,
  isStartScreen,
  messagesRef,
  stickToBottomRef,
  handleMessagesScroll,
  handleMessagesWheel,
  handleMessagesKeyDown,
  hiddenMessageCount,
  renderedMessages,
  pagedLinkedHistoryEnabled,
  loadingEarlier,
  earlierLoadError,
  isStreaming,
  toolCollapseTick,
  explodedChipGroups,
  toggleExplodedChipGroup,
  updateBlockNote,
  setAnnotationComposerActive,
  readAttachmentPaths,
  fontSize,
  fontLineHeight,
  fontMono,
  monoSize,
  ttsState,
  voiceSettings,
  showScrollToLatest,
  scrollToLatest,
  liveComposerActivityChip,
  latestChangeDrawer,
  latestChangeDrawerHasStats,
  latestChangeDrawerExpanded,
  latestChangeDrawerExpandedFiles,
  latestCheckpointId,
  isRestoringLatestCheckpoint,
  fontSans,
  onToggleLatestChangeDrawerExpanded,
  onToggleLatestChangeDrawerFile,
  onRestoreLatestCheckpoint,
  onReviewLatestChanges,
  queuedTurns,
  queueCollapsed,
  draggingTurnId,
  dragOverTurn,
  onToggleQueueCollapsed,
  onSetDraggingTurnId,
  onSetDragOverTurn,
  onReorderQueuedTurn,
  onSteerQueuedTurn,
  onDeleteQueuedTurn,
  activeView,
  embeddedTerminal,
  children,
  personas,
  fallbackProvider,
}: ChatTileTranscriptColumnProps): JSX.Element {
  const theme = useTheme()
  const terminalActive = activeView === 'terminal'
  const liveRenderedMessages = useTileTranscriptMessages({
    workspaceId,
    tileId,
    renderedMessages,
    messagesRef,
    stickToBottomRef,
  })

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      minWidth: 0,
      position: 'relative',
      justifyContent: isStartScreen ? 'center' : undefined,
    }}>
      <div style={{
        flex: terminalActive ? 1 : (isStartScreen ? '0 0 auto' : 1),
        position: 'relative',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
      <div
        ref={messagesRef}
        className={`chat-messages ${isStartScreen ? '' : 'cs-fade-scroll-y cs-fade-scroll-y-lg'}`}
        onScroll={handleMessagesScroll}
        onWheel={handleMessagesWheel}
        onKeyDown={handleMessagesKeyDown}
        tabIndex={-1}
        style={{
          display: terminalActive ? 'none' : undefined,
          flex: isStartScreen ? '0 0 auto' : 1,
          overflowY: isStartScreen ? 'visible' : 'auto',
          padding: isStartScreen ? '12px 14px 4px' : '12px 14px 44px',
          overflowX: 'hidden',
          minHeight: 0,
          scrollbarGutter: 'stable both-edges' as React.CSSProperties['scrollbarGutter'],
          scrollbarWidth: 'none' as React.CSSProperties['scrollbarWidth'],
          overflowAnchor: 'none',
        }}
      >
        <div className="cs-chat-message-stack" style={{
          width: '100%',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: '100%',
        }}>
          {isStartScreen && (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              color: theme.chat.text, textAlign: 'center',
              fontSize: 'clamp(24px, 3vw, 34px)',
              lineHeight: 1.15,
              fontWeight: 550,
              letterSpacing: 0,
            }}>
              What do you want to build today with CodeSurf?
            </div>
          )}

          {hiddenMessageCount > 0 && (
            <div style={{
              alignSelf: 'center',
              maxWidth: CHAT_MESSAGE_MAX_WIDTH,
              padding: '8px 12px',
              borderRadius: 10,
              border: `1px solid ${theme.chat.divider}`,
              background: theme.chat.userBubble,
              color: theme.chat.muted,
              fontSize: 11,
              textAlign: 'center',
            }}>
              Showing the latest {liveRenderedMessages.length} messages. Scroll up to reveal older pages; {hiddenMessageCount} older message{hiddenMessageCount === 1 ? '' : 's'} are preserved but not mounted.
            </div>
          )}

          {pagedLinkedHistoryEnabled && (loadingEarlier || earlierLoadError) && (
            <div style={{
              alignSelf: 'center',
              padding: '6px 12px 2px',
              borderRadius: 999,
              border: `1px solid ${theme.chat.divider}`,
              background: theme.chat.userBubble,
              color: theme.chat.muted,
              fontSize: 11,
              textAlign: 'center',
            }}>
              {loadingEarlier ? 'Loading older messages…' : earlierLoadError}
            </div>
          )}

          <ChatTileTranscriptMessages
            renderedMessages={liveRenderedMessages}
            isStreaming={isStreaming}
            toolCollapseTick={toolCollapseTick}
            explodedChipGroups={explodedChipGroups}
            toggleExplodedChipGroup={toggleExplodedChipGroup}
            updateBlockNote={updateBlockNote}
            onAnnotationComposerActiveChange={setAnnotationComposerActive}
            readAttachmentPaths={readAttachmentPaths}
            fontSize={fontSize}
            fontLineHeight={fontLineHeight}
            fontMono={fontMono}
            monoSize={monoSize}
            ttsState={ttsState}
            voiceSettings={voiceSettings}
            personas={personas}
            fallbackProvider={fallbackProvider}
          />
        </div>
      </div>

      {/* Embedded terminal — absolutely positioned over the transcript region so
          it keeps full size (layout-preserving) and stays mounted across tab
          switches; only visibility toggles. Unmounting would kill its PTY. */}
      {embeddedTerminal && (
        <div style={{
          position: 'absolute',
          inset: 0,
          visibility: terminalActive ? 'visible' : 'hidden',
          pointerEvents: terminalActive ? 'auto' : 'none',
          zIndex: terminalActive ? 1 : 0,
        }}>
          {embeddedTerminal}
        </div>
      )}
      </div>

      <div style={{ flexShrink: 0, position: 'relative', overflow: 'visible' }}>
        {!terminalActive && showScrollToLatest && (
          <button
            onClick={() => scrollToLatest()}
            title="Jump to latest"
            style={{
              position: 'absolute',
              top: 0,
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              minWidth: 30,
              padding: 0,
              borderRadius: '50%',
              border: `0.5px solid ${theme.border.strong}`,
              background: theme.surface.panelElevated,
              color: theme.text.secondary,
              cursor: 'pointer',
              boxShadow: theme.shadow.panel,
              backdropFilter: 'blur(10px)',
              ...NON_SELECTABLE_UI_STYLE,
            }}
          >
            <ArrowDown size={15} strokeWidth={1.8} />
          </button>
        )}

        {liveComposerActivityChip}

        {latestChangeDrawer && (
          <ChatTileLatestChangeDrawer
            drawer={latestChangeDrawer}
            hasStats={latestChangeDrawerHasStats}
            expanded={latestChangeDrawerExpanded}
            expandedFiles={latestChangeDrawerExpandedFiles}
            latestCheckpointId={latestCheckpointId}
            isRestoringLatestCheckpoint={isRestoringLatestCheckpoint}
            fontSans={fontSans}
            monoSize={monoSize}
            onToggleExpanded={onToggleLatestChangeDrawerExpanded}
            onToggleFile={onToggleLatestChangeDrawerFile}
            onRestoreLatestCheckpoint={onRestoreLatestCheckpoint}
            onReviewLatestChanges={onReviewLatestChanges}
          />
        )}

        <ChatTileQueuedTurnsDrawer
          queuedTurns={queuedTurns}
          queueCollapsed={queueCollapsed}
          draggingTurnId={draggingTurnId}
          dragOverTurn={dragOverTurn}
          joinedToPrevious={Boolean(latestChangeDrawer)}
          isStreaming={isStreaming}
          fontSans={fontSans}
          fontSize={fontSize}
          onToggleCollapsed={onToggleQueueCollapsed}
          onSetDraggingTurnId={onSetDraggingTurnId}
          onSetDragOverTurn={onSetDragOverTurn}
          onReorderQueuedTurn={onReorderQueuedTurn}
          onSteerTurn={onSteerQueuedTurn}
          onDeleteTurn={onDeleteQueuedTurn}
        />

        {children}
      </div>
    </div>
  )
}
