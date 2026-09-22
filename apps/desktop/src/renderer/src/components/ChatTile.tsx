import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react'
import type { AppSettings } from '../../../shared/types'
import { resolvePersonaModelSeed, resolveSkillModelLock } from '../hooks/personaModelBinding'
import { MONO_DEFAULT } from '../FontContext'

const LazyTerminalTile = React.lazy(() => import('./TerminalTile').then(m => ({ default: m.TerminalTile })))

import { bargeIn } from '../hooks/useAutoSpeak'
import { useChatTileThemeFonts } from '../hooks/useChatTileThemeFonts'
import { useChatTileSessionCore } from '../hooks/useChatTileSessionCore'
import { useChatTileShellModel } from '../hooks/useChatTileShellModel'
import { useChatTileSendPath } from '../hooks/useChatTileSendPath'

import { ChatTileTranscriptColumn } from './chat/ChatTileTranscriptColumn'
import { PlanPane } from './chat/PlanPane'
import { ChatTileComposer } from './chat/ChatTileComposer'
import { resolveChatTerminalLaunch } from './chat/chatTerminalLaunch'
import { ToolPermissionProvider } from './ai-elements/ToolPermission'
import {
  AskUserQuestionContext,
  AskUserQuestionFontsContext,
} from './chat/AskUserQuestionForm'
import {
  FontCtx,
  CheckpointRestoreContext,
  ChatDispatchProvider,
  type ChatDispatchValue,
} from './chat/chatTileContexts'
import { type DiscoveryPeer } from './chat/chatTileUtils'

export {
  hasVisibleFileChangeStats,
  hasRenderableFileChangeDiff,
  getToolDisplayName,
} from './chat/chatTileUtils'

// --- Types -----------------------------------------------------------------------

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  reloadToken?: number
  settings?: AppSettings
  onChatModePreferenceChange?: (providerId: string, modeId: string) => void
  isConnected?: boolean
  isAutoConnected?: boolean
  connectedPeers?: DiscoveryPeer[]
}

export type { CheckpointRestoreContextValue } from './chat/chatTileTypes'
export {
  CheckpointRestoreContext,
  TOOL_BLOCK_MAX_WIDTH,
  NON_SELECTABLE_UI_STYLE,
} from './chat/chatTileContexts'

// --- Component -------------------------------------------------------------------

export function ChatTile({ tileId, workspaceId, workspaceDir: _workspaceDir, width, height, reloadToken = 0, settings, onChatModePreferenceChange, isConnected, isAutoConnected, connectedPeers = [] }: Props): JSX.Element {
  const {
    theme,
    fontSans,
    fontMono,
    fontSize,
    fontLineHeight,
    fontWeight,
    monoSize,
    chatViewportBackground,
    composerBackground,
    composerBorder,
    chatSurfaceThemeColors,
    chatSurfaceThemeVars,
    fontCtxValue,
  } = useChatTileThemeFonts(settings)
  const {
    initialRuntimeStateRef, initialMode,
    messages, setMessages, input, setInput, isStreaming, setIsStreaming,
    executionTarget, setExecutionTarget, cloudHostId, setCloudHostId,
    provider, setProvider, model, setModel, mcpEnabled, setMcpEnabled,
    mode, setMode, thinking, setThinking, agentId, setAgentId, autoAgentMode, setAutoAgentMode,
    attachments, setAttachments, queuedTurns, setQueuedTurns,
    openChatSurfaces, setOpenChatSurfaces, activeChatSurfaceId, setActiveChatSurfaceId,
    sessionId, setSessionId, sessionIdsByProvider, setSessionIdsByProvider, swapProviderSession,
    jobId, setJobId, jobSequence, setJobSequence,
    linkedSessionEntryId, setLinkedSessionEntryId, linkedSessionHint, setLinkedSessionHint,
    preserveSessionSummary, setPreserveSessionSummary, hasEarlierMessages, setHasEarlierMessages,
    activeView, setActiveView,
    lastActivityAtRef, toolCollapseTick, setToolCollapseTick, explodedChipGroups, toggleExplodedChipGroup,
    pendingToolPermissions, resolvedToolPermissions,
    handleToolPermissionDecision, toolCompletedAtRef,
    pagedLinkedHistoryEnabled,
    hasStreamingContent,
    isStreamingRef,
    setMessagesSafe,
    lastJobSequenceRef,
    resumedJobKeyRef,
    messagesRef,
    stickToBottomRef,
    historicalMessages,
    setHistoricalMessages,
    allMessages,
    renderedMessages,
    hiddenMessageCount,
    loadingEarlier,
    earlierLoadError,
    showScrollToLatest,
    scrollToLatest,
    reviewLatestChanges,
    handleMessagesScroll,
    handleMessagesWheel,
    handleMessagesKeyDown,
    setAnnotationComposerActive,
  } = useChatTileSessionCore({ tileId, workspaceId, settings })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acRef = useRef<HTMLDivElement>(null)

  const shell = useChatTileShellModel({
    tileId,
    workspaceId,
    workspaceDir: _workspaceDir,
    reloadToken,
    settings,
    connectedPeers,
    isConnected,
    isAutoConnected,
    initialRuntimeStateRef,
    initialMode,
    messages,
    setMessages,
    input,
    setInput,
    isStreaming,
    setIsStreaming,
    executionTarget,
    setExecutionTarget,
    cloudHostId,
    setCloudHostId,
    provider,
    setProvider,
    model,
    setModel,
    mcpEnabled,
    setMcpEnabled,
    mode,
    setMode,
    thinking,
    setThinking,
    agentId,
    setAgentId,
    autoAgentMode,
    setAutoAgentMode,
    attachments,
    setAttachments,
    queuedTurns,
    setQueuedTurns,
    openChatSurfaces,
    setOpenChatSurfaces,
    activeChatSurfaceId,
    setActiveChatSurfaceId,
    sessionId,
    setSessionId,
    sessionIdsByProvider,
    setSessionIdsByProvider,
    swapProviderSession,
    jobId,
    setJobId,
    jobSequence,
    setJobSequence,
    linkedSessionEntryId,
    setLinkedSessionEntryId,
    linkedSessionHint,
    setLinkedSessionHint,
    preserveSessionSummary,
    setPreserveSessionSummary,
    hasEarlierMessages,
    setHasEarlierMessages,
    activeView,
    setActiveView,
    lastActivityAtRef,
    toolCollapseTick,
    setToolCollapseTick,
    toolCompletedAtRef,
    pagedLinkedHistoryEnabled,
    hasStreamingContent,
    isStreamingRef,
    setMessagesSafe,
    lastJobSequenceRef,
    resumedJobKeyRef,
    historicalMessages,
    setHistoricalMessages,
    allMessages,
    renderedMessages,
    chatSurfaceThemeColors,
    chatSurfaceThemeVars,
    textareaRef,
    acRef,
  })

  const {
    workspaceSkills,
    peerContextRef,
    implicitPeerImageAttachments,
    mcpServers,
    peerToolNames,
    disabledServers,
    setDisabledServers,
    effectiveAgentMode,
    providerEntries,
    providerEntryById,
    currentProviderEntry,
    modeOptions,
    currentMode,
    optionNoun,
    currentModel,
    thinkingOptions,
    handleProviderChange,
    showModelMenu,
    setShowModelMenu,
    showProviderMenu,
    showInsertMenu,
    setShowInsertMenu,
    showModeMenu,
    setShowModeMenu,
    showThinkingMenu,
    setShowThinkingMenu,
    showLocationMenu,
    setShowLocationMenu,
    showBranchMenu,
    showContextMenu,
    showAgentMenu,
    setShowAgentMenu,
    modelFilter,
    setModelFilter,
    branchFilter,
    setBranchFilter,
    modelMenuRef,
    providerMenuRef,
    insertMenuRef,
    modeMenuRef,
    thinkingMenuRef,
    locationMenuRef,
    branchMenuRef,
    contextMenuRef,
    agentMenuRef,
    toggleMenu,
    agentModes,
    agentModesLoaded,
    resolvedAgentMode,
    modelLock,
    chatSurfaceMenu,
    activeChatSurface,
    activeChatSurfaceRef,
    openChatSurfacesRef,
    setChatSurfaceIframeRef,
    getChatSurfaceIframe,
    postToChatSurface,
    openChatSurface,
    openBuilderFromSketch,
    closeChatSurface,
    localExecutionLabel,
    remoteHosts,
    activeCloudHost,
    hasSendableDraft,
    draggingTurnId,
    setDraggingTurnId,
    dragOverTurn,
    setDragOverTurn,
    queueCollapsed,
    setQueueCollapsed,
    gitStatus,
    latestStateRef,
    persistLatestState,
    updateBlockNote,
    exportNotesToClipboard,
    voiceSettings,
    isDictating,
    dictationText,
    dictationError,
    toggleDictation,
    clearDictationError,
    ttsState,
    planTodos,
    isPlanOpen,
    setIsPlanOpen,
    planUpdatedAt,
    pluginCommands,
    acType,
    setAcType,
    acQuery,
    setAcQuery,
    acIndex,
    setAcIndex,
    acItems,
    handleComposerInputChange,
    latestChangeDrawer,
    latestChangeDrawerHasStats,
    latestChangeDrawerExpanded,
    setLatestChangeDrawerExpanded,
    latestChangeDrawerExpandedFiles,
    latestCheckpointId,
    isRestoringLatestCheckpoint,
    toggleLatestChangeDrawerFile,
    restoreLatestCheckpoint,
    checkpointRestoreContextValue,
    liveComposerActivityChip,
    contextWindowLimit,
    systemOverheadTokens,
    readAttachmentPaths,
    estimatedContextTokens,
    contextUsageRatio,
    contextUsagePercent,
    locationLabel,
    isGitRepo,
    branchMenuCreateEnabled,
    normalizedRepoRoot,
    projectFolderName,
    currentBranchLabel,
    activeProjectPathLabel,
    filteredBranches,
    handleProjectFolderSwitch,
    handleBranchSelect,
    handleCreateBranch,
  } = shell

  // Stream listener lives in useChatTileSessionCore (chatStreamHub demux).

  const {
    dispatchMessageContent,
    sendMessage,
    reorderQueuedTurn,
    flushQueueStateNow,
    logQueueEvent,
    stopStreaming,
    handleQueuedTurnSteer,
    isDropTarget,
    openAttachmentPicker,
    removeAttachment,
    handleTileDragOver,
    handleTileDragLeave,
    handleTileDrop,
    selectAcItem,
    handleKeyDown,
    handleKeyUp,
    handleInputChange,
  } = useChatTileSendPath({
    tileId,
    workspaceId,
    workspaceDir: _workspaceDir,
    settings,
    isStreaming,
    input,
    attachments,
    implicitPeerImageAttachments,
    queuedTurns,
    messages,
    provider,
    model,
    mode,
    thinking,
    agentId,
    resolvedAgentMode,
    agentModesLoaded,
    sessionId,
    mcpEnabled,
    executionTarget,
    cloudHostId,
    effectiveAgentMode,
    autoAgentMode,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    connectedPeers,
    peerContextRef,
    peerToolNames,
    providerEntryById,
    currentProviderEntry,
    activeCloudHost,
    latestStateRef,
    persistLatestState,
    lastJobSequenceRef,
    resumedJobKeyRef,
    stickToBottomRef,
    activeChatSurfaceRef,
    openChatSurfacesRef,
    textareaRef,
    setMessagesSafe,
    setInput,
    setAttachments,
    setQueuedTurns,
    setOpenChatSurfaces,
    setActiveChatSurfaceId,
    setIsStreaming,
    setJobId,
    setJobSequence,
    setPreserveSessionSummary,
    setAcType,
    setAcQuery,
    getChatSurfaceIframe,
    postToChatSurface,
    exportNotesToClipboard,
    pluginCommands,
    acType,
    acItems,
    acIndex,
    setAcIndex,
    isDictating,
    toggleDictation,
    handleComposerInputChange,
    setShowInsertMenu,
  })

  const isStartScreen = messages.length === 0 && !isStreaming

  // Embedded terminal: mount it the first time the Terminal tab is opened and
  // keep it mounted thereafter. A last-instance detach still drops the PTY
  // attachment, so we never unmount on tab switch; the transcript column hides
  // it with layout-preserving CSS instead. The PTY backend is keyed by tileId,
  // so we derive a deterministic embedded id from the chat id.
  const [terminalMounted, setTerminalMounted] = useState(activeView === 'terminal')
  useEffect(() => {
    if (activeView === 'terminal') setTerminalMounted(true)
  }, [activeView])
  // Resolve terminal fonts from settings exactly like App.tsx does for canvas
  // terminal tiles, so the embedded terminal matches the standalone one.
  const terminalFontFamily = settings?.terminalFontFamily || settings?.fonts?.mono?.family || MONO_DEFAULT
  const terminalFontSize = settings?.terminalFontSize || settings?.fonts?.mono?.size || 13
  const terminalSessionId = sessionIdsByProvider[provider] ?? sessionId
  const terminalLaunch = useMemo(
    () => resolveChatTerminalLaunch(provider, terminalSessionId),
    [provider, terminalSessionId],
  )
  const embeddedTerminal = terminalMounted ? (
    terminalLaunch.supported ? (
      <Suspense fallback={null}>
        <LazyTerminalTile
          tileId={`${tileId}-terminal`}
          workspaceId={workspaceId ?? ''}
          workspaceDir={_workspaceDir}
          width={width}
          height={height}
          fontSize={terminalFontSize}
          fontFamily={terminalFontFamily}
          launchBin={terminalLaunch.launchBin}
          launchArgs={terminalLaunch.launchArgs}
        />
      </Suspense>
    ) : (
      <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        color: theme.chat.muted,
        fontSize: 12,
        textAlign: 'center',
      }}>
        This provider has no local terminal CLI that can resume this conversation.
      </div>
    )
  ) : null

  const openMiniChat = useCallback(() => {
    if (!workspaceId) return
    void window.electron?.window?.openMiniChat?.({
      workspaceId,
      tileId,
      title: messages[0]?.content?.trim().slice(0, 80) || 'CodeSurf chat',
    }).catch(error => {
      console.warn('[ChatTile] failed to open mini chat window:', error)
    })
  }, [messages, tileId, workspaceId])

  const chatDispatchValue = useMemo<ChatDispatchValue>(() => ({
    sendAnswer: async (text: string) => {
      await dispatchMessageContent(text)
    },
  }), [dispatchMessageContent])

  return (
    <ChatDispatchProvider value={chatDispatchValue}>
    <FontCtx.Provider value={fontCtxValue}>
    <AskUserQuestionFontsContext.Provider value={fontCtxValue}>
    <AskUserQuestionContext.Provider value={{ workspaceId, cardId: tileId }}>
    <CheckpointRestoreContext.Provider value={checkpointRestoreContextValue}>
    <ToolPermissionProvider
      cardId={tileId}
      pending={pendingToolPermissions}
      resolved={resolvedToolPermissions}
      onDecide={handleToolPermissionDecision}
    >
    <div
      className="cs-chat-shell"
      onDragOver={handleTileDragOver}
      onDragLeave={handleTileDragLeave}
      onDrop={handleTileDrop}
      style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        background: chatViewportBackground, color: theme.chat.text,
        fontFamily: fontSans, fontSize, lineHeight: fontLineHeight, fontWeight,
        position: 'relative',
      }}
    >


      {/* Horizontal split: [transcript + composer column] | [plan pane] */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        minHeight: 0,
        minWidth: 0,
      }}>
      <ChatTileTranscriptColumn
        workspaceId={workspaceId}
        tileId={tileId}
        isStartScreen={isStartScreen}
        messagesRef={messagesRef}
        stickToBottomRef={stickToBottomRef}
        handleMessagesScroll={handleMessagesScroll}
        handleMessagesWheel={handleMessagesWheel}
        handleMessagesKeyDown={handleMessagesKeyDown}
        hiddenMessageCount={hiddenMessageCount}
        renderedMessages={renderedMessages}
        pagedLinkedHistoryEnabled={pagedLinkedHistoryEnabled}
        loadingEarlier={loadingEarlier}
        earlierLoadError={earlierLoadError}
        isStreaming={isStreaming}
        toolCollapseTick={toolCollapseTick}
        explodedChipGroups={explodedChipGroups}
        toggleExplodedChipGroup={toggleExplodedChipGroup}
        updateBlockNote={updateBlockNote}
        setAnnotationComposerActive={setAnnotationComposerActive}
        readAttachmentPaths={readAttachmentPaths}
        fontSize={fontSize}
        fontLineHeight={fontLineHeight}
        fontMono={fontMono}
        monoSize={monoSize}
        ttsState={ttsState}
        voiceSettings={voiceSettings}
        showScrollToLatest={showScrollToLatest}
        scrollToLatest={scrollToLatest}
        liveComposerActivityChip={liveComposerActivityChip}
        latestChangeDrawer={latestChangeDrawer}
        latestChangeDrawerHasStats={latestChangeDrawerHasStats}
        latestChangeDrawerExpanded={latestChangeDrawerExpanded}
        latestChangeDrawerExpandedFiles={latestChangeDrawerExpandedFiles}
        latestCheckpointId={latestCheckpointId}
        isRestoringLatestCheckpoint={isRestoringLatestCheckpoint}
        fontSans={fontSans}
        onToggleLatestChangeDrawerExpanded={() => setLatestChangeDrawerExpanded(v => !v)}
        onToggleLatestChangeDrawerFile={toggleLatestChangeDrawerFile}
        onRestoreLatestCheckpoint={() => { void restoreLatestCheckpoint() }}
        onReviewLatestChanges={reviewLatestChanges}
        queuedTurns={queuedTurns}
        queueCollapsed={queueCollapsed}
        draggingTurnId={draggingTurnId}
        dragOverTurn={dragOverTurn}
        onToggleQueueCollapsed={() => setQueueCollapsed(v => !v)}
        onSetDraggingTurnId={setDraggingTurnId}
        onSetDragOverTurn={setDragOverTurn}
        onReorderQueuedTurn={reorderQueuedTurn}
        onSteerQueuedTurn={handleQueuedTurnSteer}
        onDeleteQueuedTurn={(turnId) => {
          const remaining = queuedTurns.filter(item => item.id !== turnId)
          setQueuedTurns(remaining)
          flushQueueStateNow(remaining)
          logQueueEvent('delete', { queueId: turnId })
        }}
        activeView={activeView}
        embeddedTerminal={embeddedTerminal}
        personas={agentModes}
        fallbackProvider={provider}
      >
        <ChatTileComposer
          isStartScreen={isStartScreen}
          isDropTarget={isDropTarget}
          composerBackground={composerBackground}
          composerBorder={composerBorder}
          acRef={acRef}
          acType={acType}
          acQuery={acQuery}
          acItems={acItems}
          acIndex={acIndex}
          fontSans={fontSans}
          fontMono={fontMono}
          onAcHoverIndex={setAcIndex}
          onAcSelect={selectAcItem}
          isDictating={isDictating}
          dictationText={dictationText}
          dictationError={dictationError}
          ttsState={ttsState}
          onRetryDictation={toggleDictation}
          onDismissDictationError={clearDictationError}
          onStopVoicePlayback={() => bargeIn()}
          openChatSurfaces={openChatSurfaces}
          activeChatSurface={activeChatSurface}
          chatSurfaceMenu={chatSurfaceMenu}
          onActivateSurface={setActiveChatSurfaceId}
          onCloseSurface={closeChatSurface}
          onOpenBuilderFromSketch={() => { void openBuilderFromSketch() }}
          onSetSurfaceIframeRef={setChatSurfaceIframeRef}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          textareaRef={textareaRef}
          input={input}
          fontSize={fontSize}
          fontLineHeight={fontLineHeight}
          onInputChange={handleInputChange}
          onInputKeyDown={handleKeyDown}
          onInputKeyUp={handleKeyUp}
          insertMenuRef={insertMenuRef}
          showInsertMenu={showInsertMenu}
          onToggleMenu={toggleMenu}
          onAttachFiles={openAttachmentPicker}
          mcpEnabled={mcpEnabled}
          onToggleMcpEnabled={() => setMcpEnabled(v => !v)}
          mcpServers={mcpServers}
          disabledServers={disabledServers}
          setDisabledServers={setDisabledServers}
          peerToolNames={peerToolNames}
          onOpenChatSurface={openChatSurface}
          showProviderPicker={messages.length === 0}
          providerMenuRef={providerMenuRef}
          showProviderMenu={showProviderMenu}
          providerEntries={providerEntries}
          provider={provider}
          onProviderChange={handleProviderChange}
          modelMenuRef={modelMenuRef}
          showModelMenu={showModelMenu}
          currentProviderEntry={currentProviderEntry}
          currentModelLabel={currentModel.label}
          modelLocked={Boolean(modelLock)}
          lockReason={modelLock?.reason}
          model={model}
          modelFilter={modelFilter}
          onModelFilterChange={setModelFilter}
          optionNoun={optionNoun}
          onSelectModel={(id) => { setModel(id); setShowModelMenu(false); setModelFilter('') }}
          thinkingMenuRef={thinkingMenuRef}
          showThinkingMenu={showThinkingMenu}
          thinking={thinking}
          thinkingOptions={thinkingOptions}
          onSelectThinking={(id) => { setThinking(id); setShowThinkingMenu(false) }}
          onOpenMiniChat={openMiniChat}
          isStreaming={isStreaming}
          lastActivityAtRef={lastActivityAtRef}
          onToggleDictation={toggleDictation}
          hasSendableDraft={hasSendableDraft}
          onStopStreaming={stopStreaming}
          onSendMessage={sendMessage}
          locationMenuRef={locationMenuRef}
          showLocationMenu={showLocationMenu}
          executionTarget={executionTarget}
          locationLabel={locationLabel}
          localExecutionLabel={localExecutionLabel}
          normalizedRepoRoot={normalizedRepoRoot}
          remoteHosts={remoteHosts}
          activeCloudHost={activeCloudHost}
          onSelectLocalExecution={() => {
            setExecutionTarget('local')
            setShowLocationMenu(false)
          }}
          onSelectCloudExecution={() => {
            if (remoteHosts.length > 0) {
              setExecutionTarget('cloud')
              setCloudHostId(activeCloudHost?.id ?? remoteHosts[0].id)
            }
            setShowLocationMenu(false)
          }}
          onSelectRemoteHost={hostId => {
            setExecutionTarget('cloud')
            setCloudHostId(hostId)
            setShowLocationMenu(false)
          }}
          branchMenuRef={branchMenuRef}
          showBranchMenu={showBranchMenu}
          isGitRepo={isGitRepo}
          filteredBranches={filteredBranches}
          branchFilter={branchFilter}
          branchMenuCreateEnabled={branchMenuCreateEnabled}
          currentBranchLabel={currentBranchLabel}
          projectFolderName={projectFolderName}
          changedCount={gitStatus.changedCount}
          onBranchFilterChange={setBranchFilter}
          onSelectBranch={handleBranchSelect}
          onCreateBranch={handleCreateBranch}
          activeProjectPathLabel={activeProjectPathLabel}
          onProjectFolderSwitch={handleProjectFolderSwitch}
          modeMenuRef={modeMenuRef}
          showModeMenu={showModeMenu}
          mode={mode}
          currentMode={currentMode}
          modeOptions={modeOptions}
          onSelectMode={modeId => {
            setMode(modeId)
            onChatModePreferenceChange?.(provider, modeId)
            setShowModeMenu(false)
          }}
          agentMenuRef={agentMenuRef}
          showAgentMenu={showAgentMenu}
          agentId={agentId}
          agentModes={agentModes}
          onSelectAgent={nextAgentId => {
            setAgentId(nextAgentId)
            const nextPersona = agentModes.find(a => a.id === nextAgentId) ?? null
            // Precedence LAYER 1 (P1b-2): if a linked skill imposes a HARD model lock,
            // it PINS provider/model and SHORT-CIRCUITS the soft seed below. The picker
            // is disabled in the composer; the live-state effect keeps the pin honoured.
            const skillLock = resolveSkillModelLock(nextPersona, workspaceSkills)
            if (skillLock) {
              if (skillLock.provider) setProvider(skillLock.provider)
              if (skillLock.model) setModel(skillLock.model)
            } else {
              // Precedence layer 2: a selected persona's SOFT defaultBinding seeds the
              // composer's provider/model. Seed once here (NOT in an effect — an effect
              // keyed on agentId would re-clobber the user's pick on restore/re-render).
              // The user can freely change it afterward; the live composer state flows
              // to req.model/provider, so the user pick (layer 3) always wins.
              const modelSeed = resolvePersonaModelSeed(nextPersona)
              if (modelSeed?.provider) setProvider(modelSeed.provider)
              if (modelSeed?.model) setModel(modelSeed.model)
            }
            setShowAgentMenu(false)
          }}
          planTodos={planTodos}
          isPlanOpen={isPlanOpen}
          onTogglePlanOpen={() => setIsPlanOpen(v => !v)}
          contextMenuRef={contextMenuRef}
          showContextMenu={showContextMenu}
          contextUsageRatio={contextUsageRatio}
          contextUsagePercent={contextUsagePercent}
          estimatedContextTokens={estimatedContextTokens}
          contextWindowLimit={contextWindowLimit}
          systemOverheadTokens={systemOverheadTokens}
          activeView={activeView}
          onSelectView={setActiveView}
        />
      </ChatTileTranscriptColumn>
      {isPlanOpen && planTodos && planTodos.length > 0 && (
        <PlanPane
          todos={planTodos}
          updatedAt={planUpdatedAt}
          onClose={() => setIsPlanOpen(false)}
        />
      )}
      </div>
    </div>
    </ToolPermissionProvider>
    </CheckpointRestoreContext.Provider>
    </AskUserQuestionContext.Provider>
    </AskUserQuestionFontsContext.Provider>
    </FontCtx.Provider>
    </ChatDispatchProvider>
  )
}
