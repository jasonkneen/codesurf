import React from 'react'
import {
  ArrowUp,
  Bot,
  Brain,
  Maximize2,
  MessageSquare,
  Mic,
  Plus,
  Square,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { AgentMode, ExecutionHostRecord } from '../../../../shared/types'
import type { ModeOption, ThinkingOption } from '../../config/providers'
import type { MCPServerEntry } from '../../hooks/useMCPServers'
import type { ProviderEntry } from '../../hooks/useChatTileProviders'
import type { TileTodoItem } from '../../state/tileTodosStore'
import type { TtsPlayerState } from '../../utils/ttsPlayer'
import { useTheme } from '../../ThemeContext'
import type { AutocompleteItem } from '../../hooks/useChatAutocomplete'
import {
  ChatComposerAttachments,
  ChatComposerAutocompletePopup,
  ChatComposerBranchMenu,
  type ChatComposerBranch,
  ChatComposerCard,
  ChatComposerContextUsageDial,
  ChatComposerInput,
  ChatComposerLocationMenu,
  ChatComposerModeMenu,
  ChatComposerAgentMenu,
  ChatComposerPrimaryToolbar,
  ChatComposerProjectPathButton,
  ChatComposerSecondaryToolbar,
  ChatComposerSurfaceHost,
  ChatComposerVoiceStatus,
  ChatComposerWrap,
} from './ChatComposer'
import { ToolbarBtn, ToolbarPill } from './ChatComposerControls'
import {
  ComposerInsertMenu,
  Dropdown,
  DropdownItem,
  MenuPortal,
  ModelDropdown,
  type ChatSurfaceMenuEntry,
} from './ChatComposerMenus'
import { PlanChip } from './PlanChip'
import { StreamingLivenessIndicator } from './ToolBlockView'
import { ThinkingIcon, renderChatSurfaceIcon } from './ChatTileViews'
import {
  CHAT_COMPOSER_WIDTH,
  CHAT_COMPOSER_MIN_WIDTH_STYLE,
  CHAT_COMPOSER_BOTTOM_INSET,
  CHAT_COMPOSER_RADIUS,
  CHAT_COMPOSER_MIN_HEIGHT,
  CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT,
  TOOLBAR_ICON_SIZE,
  TOOLBAR_PILL_ICON_SIZE,
} from './chatTileLayout'
import type { ActiveChatSurface, PendingAttachment } from './chatTileUtils'

const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

/** Segmented [Chat | Terminal] toggle that flips the chat tile's body between
 *  the transcript and the embedded terminal. The terminal stays mounted once
 *  opened (see ChatTile) — this only drives which view is visible. */
function ChatViewToggle({ activeView, onSelectView, theme }: {
  activeView: 'chat' | 'terminal'
  onSelectView: (view: 'chat' | 'terminal') => void
  theme: ReturnType<typeof useTheme>
}): JSX.Element {
  const options: Array<{ id: 'chat' | 'terminal'; label: string; icon: React.ReactNode }> = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare size={12} strokeWidth={2} /> },
    { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={12} strokeWidth={2} /> },
  ]
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2,
      padding: 2,
      borderRadius: 8,
      background: theme.surface.panelMuted,
      ...NON_SELECTABLE_UI_STYLE,
    }}>
      {options.map(opt => {
        const active = activeView === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelectView(opt.id)}
            onMouseDown={e => e.preventDefault()}
            title={`Show ${opt.label.toLowerCase()}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              appearance: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '3px 9px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: active ? 600 : 500,
              lineHeight: 1.2,
              background: active ? theme.surface.hover : 'transparent',
              color: active ? theme.chat.text : theme.chat.muted,
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <span style={{ display: 'flex', opacity: 0.85 }}>{opt.icon}</span>
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export interface ChatTileComposerProps {
  isStartScreen: boolean
  isDropTarget: boolean
  composerBackground: string
  composerBorder: string | undefined

  acRef: React.RefObject<HTMLDivElement | null>
  acType: 'slash' | 'mention' | null
  acQuery: string
  acItems: AutocompleteItem[]
  acIndex: number
  fontSans: string
  fontMono: string
  onAcHoverIndex: (index: number) => void
  onAcSelect: (item: AutocompleteItem) => void

  isDictating: boolean
  dictationText: string
  dictationError: string | null
  ttsState: TtsPlayerState
  onRetryDictation: () => void
  onDismissDictationError: () => void
  onStopVoicePlayback: () => void

  openChatSurfaces: ActiveChatSurface[]
  activeChatSurface: ActiveChatSurface | null
  chatSurfaceMenu: ChatSurfaceMenuEntry[]
  onActivateSurface: (instanceId: string) => void
  onCloseSurface: (instanceId?: string) => void
  onOpenBuilderFromSketch: () => void
  onSetSurfaceIframeRef: (instanceId: string, node: HTMLIFrameElement | null) => void

  attachments: PendingAttachment[]
  onRemoveAttachment: (path: string) => void

  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  input: string
  fontSize: number
  fontLineHeight: number | string
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onInputKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void

  insertMenuRef: React.RefObject<HTMLDivElement | null>
  showInsertMenu: boolean
  onToggleMenu: (which: 'model' | 'provider' | 'insert' | 'mode' | 'thinking' | 'location' | 'branch' | 'context' | 'agent') => void
  onAttachFiles: () => void
  mcpEnabled: boolean
  onToggleMcpEnabled: () => void
  mcpServers: MCPServerEntry[]
  disabledServers: Set<string>
  setDisabledServers: React.Dispatch<React.SetStateAction<Set<string>>>
  peerToolNames: string[]
  onOpenChatSurface: (entry: ChatSurfaceMenuEntry, options?: { initialContext?: Record<string, unknown> }) => void

  showProviderPicker: boolean
  providerMenuRef: React.RefObject<HTMLDivElement | null>
  showProviderMenu: boolean
  providerEntries: ProviderEntry[]
  provider: string
  onProviderChange: (providerId: string) => void

  modelMenuRef: React.RefObject<HTMLDivElement | null>
  showModelMenu: boolean
  currentProviderEntry: ProviderEntry | undefined
  currentModelLabel: string
  /** P1b-2 (layer 1): a linked skill pins the model — disable the model/provider pickers. */
  modelLocked?: boolean
  /** Tooltip explaining the lock, shown on the disabled pills. */
  lockReason?: string
  model: string
  modelFilter: string
  onModelFilterChange: (value: string) => void
  optionNoun: 'model' | 'agent'
  onSelectModel: (id: string) => void

  thinkingMenuRef: React.RefObject<HTMLDivElement | null>
  showThinkingMenu: boolean
  thinking: string
  thinkingOptions: ThinkingOption[]
  onSelectThinking: (id: string) => void

  onOpenMiniChat: () => void
  isStreaming: boolean
  lastActivityAtRef: React.MutableRefObject<number>
  onToggleDictation: () => void
  hasSendableDraft: boolean
  onStopStreaming: () => void
  onSendMessage: () => void

  locationMenuRef: React.RefObject<HTMLDivElement | null>
  showLocationMenu: boolean
  executionTarget: 'local' | 'cloud'
  locationLabel: string
  localExecutionLabel: string
  normalizedRepoRoot: string
  remoteHosts: ExecutionHostRecord[]
  activeCloudHost: ExecutionHostRecord | null
  onSelectLocalExecution: () => void
  onSelectCloudExecution: () => void
  onSelectRemoteHost: (hostId: string) => void

  branchMenuRef: React.RefObject<HTMLDivElement | null>
  showBranchMenu: boolean
  isGitRepo: boolean
  filteredBranches: ChatComposerBranch[]
  branchFilter: string
  branchMenuCreateEnabled: boolean
  currentBranchLabel: string
  projectFolderName: string
  changedCount: number
  onBranchFilterChange: (value: string) => void
  onSelectBranch: (branchName: string) => void
  onCreateBranch: () => void

  activeProjectPathLabel: string
  onProjectFolderSwitch: () => void

  modeMenuRef: React.RefObject<HTMLDivElement | null>
  showModeMenu: boolean
  mode: string
  currentMode: ModeOption
  modeOptions: ModeOption[]
  onSelectMode: (modeId: string) => void

  agentMenuRef: React.RefObject<HTMLDivElement | null>
  showAgentMenu: boolean
  agentId: string | null
  agentModes: AgentMode[]
  onSelectAgent: (agentId: string | null) => void

  planTodos: TileTodoItem[] | null
  isPlanOpen: boolean
  onTogglePlanOpen: () => void

  contextMenuRef: React.RefObject<HTMLDivElement | null>
  showContextMenu: boolean
  contextUsageRatio: number
  contextUsagePercent: number
  estimatedContextTokens: number
  contextWindowLimit: number
  systemOverheadTokens: number

  activeView: 'chat' | 'terminal'
  onSelectView: (view: 'chat' | 'terminal') => void
}

export function ChatTileComposer({
  isStartScreen,
  isDropTarget,
  composerBackground,
  composerBorder: _composerBorder,
  acRef,
  acType,
  acQuery,
  acItems,
  acIndex,
  fontSans,
  fontMono,
  onAcHoverIndex,
  onAcSelect,
  isDictating,
  dictationText,
  dictationError,
  ttsState,
  onRetryDictation,
  onDismissDictationError,
  onStopVoicePlayback,
  openChatSurfaces,
  activeChatSurface,
  chatSurfaceMenu,
  onActivateSurface,
  onCloseSurface,
  onOpenBuilderFromSketch,
  onSetSurfaceIframeRef,
  attachments,
  onRemoveAttachment,
  textareaRef,
  input,
  fontSize,
  fontLineHeight,
  onInputChange,
  onInputKeyDown,
  onInputKeyUp,
  insertMenuRef,
  showInsertMenu,
  onToggleMenu,
  onAttachFiles,
  mcpEnabled,
  onToggleMcpEnabled,
  mcpServers,
  disabledServers,
  setDisabledServers,
  peerToolNames,
  onOpenChatSurface,
  showProviderPicker,
  providerMenuRef,
  showProviderMenu,
  providerEntries,
  provider,
  onProviderChange,
  modelMenuRef,
  showModelMenu,
  currentProviderEntry,
  currentModelLabel,
  modelLocked,
  lockReason,
  model,
  modelFilter,
  onModelFilterChange,
  optionNoun,
  onSelectModel,
  thinkingMenuRef,
  showThinkingMenu,
  thinking,
  thinkingOptions,
  onSelectThinking,
  onOpenMiniChat,
  isStreaming,
  lastActivityAtRef,
  onToggleDictation,
  hasSendableDraft,
  onStopStreaming,
  onSendMessage,
  locationMenuRef,
  showLocationMenu,
  executionTarget,
  locationLabel,
  localExecutionLabel,
  normalizedRepoRoot,
  remoteHosts,
  activeCloudHost,
  onSelectLocalExecution,
  onSelectCloudExecution,
  onSelectRemoteHost,
  branchMenuRef,
  showBranchMenu,
  isGitRepo,
  filteredBranches,
  branchFilter,
  branchMenuCreateEnabled,
  currentBranchLabel,
  projectFolderName,
  changedCount,
  onBranchFilterChange,
  onSelectBranch,
  onCreateBranch,
  activeProjectPathLabel,
  onProjectFolderSwitch,
  modeMenuRef,
  showModeMenu,
  mode,
  currentMode,
  modeOptions,
  onSelectMode,
  agentMenuRef,
  showAgentMenu,
  agentId,
  agentModes,
  onSelectAgent,
  planTodos,
  isPlanOpen,
  onTogglePlanOpen,
  contextMenuRef,
  showContextMenu,
  contextUsageRatio,
  contextUsagePercent,
  estimatedContextTokens,
  contextWindowLimit,
  systemOverheadTokens,
  activeView,
  onSelectView,
}: ChatTileComposerProps): JSX.Element {
  const theme = useTheme()

  return (
    <ChatComposerWrap style={{
      flexShrink: 0,
      width: CHAT_COMPOSER_WIDTH,
      minWidth: CHAT_COMPOSER_MIN_WIDTH_STYLE,
      margin: isStartScreen
        ? `12px auto ${CHAT_COMPOSER_BOTTOM_INSET} auto`
        : `0 auto ${CHAT_COMPOSER_BOTTOM_INSET} auto`,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <ChatComposerCard
        edgeTone={isDropTarget ? 'accent' : 'default'}
        style={{
        minHeight: CHAT_COMPOSER_MIN_HEIGHT,
        border: 'none',
        borderRadius: CHAT_COMPOSER_RADIUS,
        background: isDropTarget ? theme.surface.accentSoft : composerBackground,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: isDropTarget
          ? `0 0 22px ${theme.accent.soft}`
          : theme.mode === 'light'
            ? '0 10px 28px rgba(0, 0, 0, 0.08)'
            : '0 10px 28px rgba(0, 0, 0, 0.18)',
        transition: 'background 120ms ease, box-shadow 120ms ease',
      }}>
        <ChatComposerAutocompletePopup
          popupRef={acRef}
          autocompleteType={acType}
          query={acQuery}
          items={acItems}
          activeIndex={acIndex}
          fontSans={fontSans}
          fontMono={fontMono}
          onHoverIndex={onAcHoverIndex}
          onSelect={onAcSelect}
        />

        <ChatComposerVoiceStatus
          isDictating={isDictating}
          dictationText={dictationText}
          dictationError={dictationError}
          ttsState={ttsState}
          onRetryDictation={onRetryDictation}
          onDismissDictationError={onDismissDictationError}
          onStopVoicePlayback={onStopVoicePlayback}
        />

        <ChatComposerSurfaceHost
          surfaces={openChatSurfaces}
          activeSurface={activeChatSurface}
          fontMono={fontMono}
          showBuilderEnhance={activeChatSurface?.extId === 'sketch' && chatSurfaceMenu.some(entry => entry.extId === 'builder' || entry.surfaceId === 'builder')}
          renderSurfaceIcon={renderChatSurfaceIcon}
          onActivateSurface={onActivateSurface}
          onCloseSurface={onCloseSurface}
          onOpenBuilderFromSketch={onOpenBuilderFromSketch}
          onSetSurfaceIframeRef={onSetSurfaceIframeRef}
        />

        <ChatComposerAttachments
          attachments={attachments}
          fontMono={fontMono}
          onRemoveAttachment={onRemoveAttachment}
        />

        <ChatComposerInput
          textareaRef={textareaRef}
          value={input}
          onChange={onInputChange}
          onKeyDown={onInputKeyDown}
          onKeyUp={onInputKeyUp}
          placeholder={isDictating ? 'Listening...' : 'Message the agent, or use /commands and /skills'}
          fontSize={fontSize}
          fontFamily={fontSans}
          lineHeight={fontLineHeight}
          minHeight={CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT}
          textColor={theme.chat.text}
        />

        <ChatComposerPrimaryToolbar>
          <div ref={insertMenuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              aria-label="Open attachments and tools menu"
              title="Open attachments and tools menu"
              onClick={() => onToggleMenu('insert')}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28,
                height: 28,
                minWidth: 28,
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                color: showInsertMenu ? theme.chat.text : theme.chat.muted,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                transition: 'background 0.15s, color 0.15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = theme.chat.text
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = showInsertMenu ? theme.chat.text : theme.chat.muted
              }}
            >
              <Plus size={16} strokeWidth={2.2} />
            </button>
            {showInsertMenu && (
              <MenuPortal anchorRef={insertMenuRef}>
                <ComposerInsertMenu
                  onAttachFiles={onAttachFiles}
                  mcpEnabled={mcpEnabled}
                  onToggleMcpEnabled={onToggleMcpEnabled}
                  mcpServers={mcpServers}
                  disabledServers={disabledServers}
                  setDisabledServers={setDisabledServers}
                  peerToolNames={peerToolNames}
                  chatSurfaces={chatSurfaceMenu}
                  activeChatSurfaceId={activeChatSurface ? `${activeChatSurface.extId}:${activeChatSurface.surfaceId}` : null}
                  onOpenChatSurface={onOpenChatSurface}
                  renderChatSurfaceIcon={renderChatSurfaceIcon}
                />
              </MenuPortal>
            )}
          </div>

          {showProviderPicker && (
            <div ref={providerMenuRef} style={{ position: 'relative' }}>
              <ToolbarPill
                prefix={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
                label={currentProviderEntry?.label ?? 'Provider'}
                active={showProviderMenu}
                onClick={() => onToggleMenu('provider')}
                disabled={modelLocked}
                title={modelLocked ? (lockReason ?? 'Model locked') : 'Choose the CLI agent (hidden once the conversation starts)'}
              />
              {showProviderMenu && (
                <MenuPortal anchorRef={providerMenuRef}>
                  <Dropdown>
                    {providerEntries.map(entry => (
                      <DropdownItem
                        key={entry.id}
                        icon={entry.icon}
                        label={entry.label}
                        sublabel={entry.description}
                        active={provider === entry.id}
                        onClick={() => onProviderChange(entry.id)}
                      />
                    ))}
                  </Dropdown>
                </MenuPortal>
              )}
            </div>
          )}

          <div ref={modelMenuRef} style={{ position: 'relative' }}>
            <ToolbarPill
              prefix={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
              label={currentModelLabel}
              active={showModelMenu}
              onClick={() => onToggleMenu('model')}
              disabled={modelLocked}
              title={modelLocked ? (lockReason ?? 'Model locked') : undefined}
            />
            {showModelMenu && (
              <MenuPortal anchorRef={modelMenuRef}>
                <ModelDropdown
                  models={currentProviderEntry?.models ?? []}
                  activeId={model}
                  filter={modelFilter}
                  onFilterChange={onModelFilterChange}
                  providerIcon={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
                  noun={optionNoun}
                  onSelect={onSelectModel}
                />
              </MenuPortal>
            )}
          </div>

          <div ref={thinkingMenuRef} style={{ position: 'relative' }}>
            <ToolbarBtn
              icon={<ThinkingIcon level={thinking} />}
              tooltip={`Thinking: ${thinkingOptions.find(t => t.id === thinking)?.label ?? 'Adaptive'}`}
              color={thinking === 'none' ? theme.chat.muted : theme.chat.textSecondary}
              onClick={() => onToggleMenu('thinking')}
            />
            {showThinkingMenu && (
              <MenuPortal anchorRef={thinkingMenuRef}>
                <Dropdown>
                  {thinkingOptions.map(t => (
                    <DropdownItem
                      key={t.id}
                      icon={<Brain size={11} />}
                      label={t.label}
                      sublabel={t.description}
                      active={thinking === t.id}
                      onClick={() => onSelectThinking(t.id)}
                    />
                  ))}
                </Dropdown>
              </MenuPortal>
            )}
          </div>

          <ChatComposerAgentMenu
            anchorRef={agentMenuRef}
            showMenu={showAgentMenu}
            agentId={agentId}
            agentModes={agentModes}
            onToggleMenu={() => onToggleMenu('agent')}
            onSelectAgent={onSelectAgent}
          />

          <ChatComposerModeMenu
            anchorRef={modeMenuRef}
            showMenu={showModeMenu}
            mode={mode}
            currentMode={currentMode}
            modeOptions={modeOptions}
            onToggleMenu={() => onToggleMenu('mode')}
            onSelectMode={onSelectMode}
          />

          <div style={{ marginLeft: 'auto' }}>
            <ToolbarBtn
              icon={<Maximize2 size={TOOLBAR_ICON_SIZE - 1} />}
              tooltip="Open this chat in a mini window"
              color={theme.chat.textSecondary}
              onClick={onOpenMiniChat}
            />
          </div>

          {isStreaming && <StreamingLivenessIndicator lastActivityAtMs={lastActivityAtRef.current} />}

          {!isStreaming && (
            <button
              onClick={onToggleDictation}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: isDictating ? theme.status.danger : theme.surface.panelMuted,
                border: 'none',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s, transform 0.15s', flexShrink: 0,
                transform: isDictating ? 'scale(1.05)' : 'scale(1)',
                animation: isDictating ? 'chat-pulse 1.4s ease-in-out infinite' : 'none',
              }}
              onMouseEnter={e => {
                if (!isDictating) e.currentTarget.style.background = theme.chat.inputBorder ?? theme.surface.panelMuted
              }}
              onMouseLeave={e => {
                if (!isDictating) e.currentTarget.style.background = theme.surface.panelMuted
              }}
              title={isDictating ? 'Stop recording (or release Space)' : 'Hold Space (empty composer) or click to dictate'}
            >
              <Mic
                size={14}
                color={isDictating ? theme.text.inverse : theme.chat.muted}
                strokeWidth={2.2}
              />
            </button>
          )}

          {isStreaming ? (
            <button
              onClick={onStopStreaming}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: theme.text.primary, border: 'none',
                cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'opacity 0.15s', flexShrink: 0,
                opacity: 0.92,
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.92')}
              title="Stop generation"
            >
              <Square size={10} fill={theme.chat.background} color={theme.chat.background} />
            </button>
          ) : (
            <button
              onClick={onSendMessage}
              onMouseDown={e => e.preventDefault()}
              disabled={!hasSendableDraft}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: hasSendableDraft ? theme.accent.base : theme.surface.panelMuted,
                border: 'none',
                cursor: hasSendableDraft ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => { if (hasSendableDraft) e.currentTarget.style.background = theme.accent.hover }}
              onMouseLeave={e => { if (hasSendableDraft) e.currentTarget.style.background = theme.accent.base }}
              title="Send message"
            >
              <ArrowUp size={16} color={theme.text.inverse} strokeWidth={2.5} style={{ opacity: hasSendableDraft ? 1 : 0.3 }} />
            </button>
          )}
        </ChatComposerPrimaryToolbar>
      </ChatComposerCard>

      <ChatComposerSecondaryToolbar>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <ChatComposerLocationMenu
            anchorRef={locationMenuRef}
            showMenu={showLocationMenu}
            executionTarget={executionTarget}
            locationLabel={locationLabel}
            localExecutionLabel={localExecutionLabel}
            normalizedRepoRoot={normalizedRepoRoot}
            remoteHosts={remoteHosts}
            activeCloudHost={activeCloudHost}
            fontSans={fontSans}
            onToggleMenu={() => onToggleMenu('location')}
            onSelectLocal={onSelectLocalExecution}
            onSelectCloud={onSelectCloudExecution}
            onSelectRemoteHost={onSelectRemoteHost}
          />

          <ChatComposerBranchMenu
            anchorRef={branchMenuRef}
            showMenu={showBranchMenu}
            isGitRepo={isGitRepo}
            branches={filteredBranches}
            branchFilter={branchFilter}
            branchCreateEnabled={branchMenuCreateEnabled}
            currentBranchLabel={currentBranchLabel}
            projectFolderName={projectFolderName}
            normalizedRepoRoot={normalizedRepoRoot}
            changedCount={changedCount}
            fontSans={fontSans}
            nonSelectableStyle={NON_SELECTABLE_UI_STYLE}
            onToggleMenu={() => onToggleMenu('branch')}
            onBranchFilterChange={onBranchFilterChange}
            onSelectBranch={onSelectBranch}
            onCreateBranch={onCreateBranch}
          />

          <ChatComposerProjectPathButton
            title={executionTarget === 'cloud' ? activeProjectPathLabel : `${activeProjectPathLabel} — click to switch folder`}
            disabled={executionTarget === 'cloud'}
            label={activeProjectPathLabel}
            fontSans={fontSans}
            onClick={onProjectFolderSwitch}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <ChatViewToggle
            activeView={activeView}
            onSelectView={onSelectView}
            theme={theme}
          />

          {planTodos && planTodos.length > 0 && (
            <PlanChip
              todos={planTodos}
              active={isPlanOpen}
              onClick={onTogglePlanOpen}
            />
          )}

          <ChatComposerContextUsageDial
            anchorRef={contextMenuRef}
            showMenu={showContextMenu}
            contextUsageRatio={contextUsageRatio}
            contextUsagePercent={contextUsagePercent}
            estimatedContextTokens={estimatedContextTokens}
            contextWindowLimit={contextWindowLimit}
            systemOverheadTokens={systemOverheadTokens}
            composerBackground={composerBackground}
            fontSans={fontSans}
            nonSelectableStyle={NON_SELECTABLE_UI_STYLE}
            onToggleMenu={() => onToggleMenu('context')}
          />
        </div>
      </ChatComposerSecondaryToolbar>
    </ChatComposerWrap>
  )
}