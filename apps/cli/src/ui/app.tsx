import { decodePasteBytes, type KeyEvent, type TextareaRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { dispatchInputInterceptors, useIcon } from "../core/plugins";
import { markAcceptAllThisSession, markPathApprovedThisSession } from "../core/plugins/builtin/file-tools-approval";
import { getApiKey } from "../utils/settings";
import { type AppProps, extractFileDropPaths } from "./app-helpers";
import { buildComposerShortcutHints } from "./components/composer-shortcut-hints.js";
import { CopyFlashBanner } from "./components/copy-flash-banner.js";
import { formatComposerChromeLabel, permissionModeComposerLabel } from "./components/prompt-bar.js";
import { ToastStack } from "./components/toast-stack.js";
import { ApprovalProvider } from "./context/approval-context.js";
import { BtwProvider, useBtw } from "./context/btw-context.js";
import { ComposerProvider, useComposer } from "./context/composer-context.js";
import { ConversationStateProvider, useConversationState } from "./context/conversation-state-context.js";
import { ModalProvider, useModalVisibility } from "./context/modal-context.js";
import { ModelProvider, useModel } from "./context/model-context.js";
import { QueueProvider, useQueue } from "./context/queue-context.js";
import { RunningAgentsProvider } from "./context/running-agents-context.js";
import { useServerMode } from "./context/server-mode-context.js";
import { TelegramProvider, useTelegram } from "./context/telegram-context.js";
import { ThemeProvider, useTheme } from "./context/theme-context.js";
import { ToastProvider, useToast } from "./context/toast-context.js";
import { getFeatureFlag, toggleFeatureFlag } from "./feature-flags";
import { useComposerActions } from "./hooks/use-composer-actions.js";
import { useComposerKeys } from "./hooks/use-composer-keys.js";
import { useFlushedKeyboard } from "./hooks/use-flushed-keyboard.js";
import { useKernelBridge } from "./hooks/use-kernel-bridge.js";
import { useModalActions } from "./hooks/use-modal-actions.js";
import { useModalGuardState } from "./hooks/use-modal-guard-state.js";
import { useModelPickerData } from "./hooks/use-model-picker-data.js";
import { useOverlayActions } from "./hooks/use-overlay-actions.js";
import { usePlanActions } from "./hooks/use-plan-actions.js";
import { useQueueActions } from "./hooks/use-queue-actions.js";
import { useRunningAgentRows } from "./hooks/use-running-agent-rows.js";
import { useSlashItems } from "./hooks/use-slash-items.js";
import { useTelegramBridge } from "./hooks/use-telegram-bridge.js";
import { useTurnEngine } from "./hooks/use-turn-engine.js";
import { useUiActionHandler } from "./hooks/use-ui-action-handler.js";
import { useUiModeRestore } from "./hooks/use-ui-mode-restore.js";
import { useInputRouter } from "./input/useInputRouter.js";
import { slashMenuIndexStore } from "./menu-nav-store.js";
import { keyPerfEnabled, notePerfKeyEnd, notePerfKeyStart, notePerfRender } from "./perf/key-latency.js";
import { HomeRoute } from "./routes/home-route.js";
import { ModalLayer } from "./routes/modal-layer.js";
import { SessionRoute } from "./routes/session-route.js";
import type { SandboxPickerProps } from "./screens/sandbox-picker";
import { SANDBOX_SCREEN_ID } from "./screens/sandbox-screen";
import type { WalletPickerProps } from "./screens/wallet-picker";
import { WALLET_SCREEN_ID } from "./screens/wallet-screen";
import { getStreamContent } from "./stream-store.js";
import { buildAssistantEntry } from "./telegram-turn-ui";
import {
  removeTerminalSession,
  stopTerminalSession,
  useTerminalSessions,
  writeTerminalSession,
} from "./terminal/manager";

export function App(props: AppProps) {
  useServerMode();
  return (
    <ThemeProvider>
      <BtwProvider>
        <ToastProvider>
          <ModelProvider agent={props.agent} initialHasApiKey={props.agent.hasApiKey()}>
            <ApprovalProvider>
              <RunningAgentsProvider>
                <QueueProvider>
                  <ModalProvider>
                    <ConversationStateProvider agent={props.agent}>
                      <TelegramProvider>
                        <ComposerProvider agent={props.agent}>
                          <AppInner {...props} />
                        </ComposerProvider>
                      </TelegramProvider>
                    </ConversationStateProvider>
                  </ModalProvider>
                </QueueProvider>
              </RunningAgentsProvider>
            </ApprovalProvider>
          </ModelProvider>
        </ToastProvider>
      </BtwProvider>
    </ThemeProvider>
  );
}

function AppInner({ agent, startupConfig, initialMessage, onExit }: AppProps) {
  const { toasts, pushToast, copyFlashId, copyTuiSelectionToHost, handleRootMouseUp } = useToast();
  const { t, uiMode, setUiMode: setUiModeCtx, toggleUiMode: toggleUiModeCtx, openThemeModal } = useTheme();
  const {
    setShowSlashMenu,
    setSlashSearchQuery,
    setShowCommandPalette,
    setCommandPaletteQuery,
    setCommandPaletteIndex,
    dynamicScreens,
    sandboxSettingsFocusIndexRef,
    sandboxSettingsEditing,
    sandboxSettingsEditBuffer,
    walletFocusIndexRef,
    updateInfo,
    isUpdating,
    updateOutput,
  } = useModalVisibility();

  const { inputRef, commitComposer, typeahead, insertDroppedFilePaths } = useComposer();

  const { setUiMode, toggleUiMode } = useUiModeRestore(uiMode, setUiModeCtx, toggleUiModeCtx, inputRef);

  const terminalSessions = useTerminalSessions();
  const renderer = useRenderer();
  notePerfRender();
  const {
    model,
    sandboxMode,
    sandboxSettings,
    walletSettings,
    walletDisplayInfo,
    hasApiKey,
    activeModelAdapterIdRef,
    contextStatsRef,
    contextBreakdownRef,
  } = useModel();
  const {
    messages,
    setMessages,
    isProcessing,
    shellMode,
    activePlan,
    processedInitial,
    isProcessingRef,
    shellModeRef,
  } = useConversationState();
  const { setBtwStateSync, btwStateRef, btwAbortRef } = useBtw();
  const apiKeyInputRef = useRef<TextareaRenderable>(null);
  const { width, height } = useTerminalDimensions();
  const hasApiKeyRef = useRef(hasApiKey);
  const { queuedMessages, setQueuedMessages, queueFocusId, setQueueFocusId, queuedMessagesRef, nextQueueIdRef } =
    useQueue();
  const { telegramTokenInputRef, telegramPairInputRef, submitTelegramPair } = useTelegram();
  const {
    processMessage,
    abortActiveRun,
    resetToNewSession,
    resumeSessionFromModal,
    deleteSessionFromModal,
    clearLiveTurnUi,
    scrollToBottom,
    beginLiveTurn,
    finalizeActiveTurn,
    showLiveToolCalls,
    appendLiveToolResult,
    processMessageRef,
  } = useTurnEngine(agent);

  const { startTelegramBridgeRef } = useTelegramBridge({
    agent,
    beginLiveTurn,
    scrollToBottom,
    finalizeActiveTurn,
    showLiveToolCalls,
    appendLiveToolResult,
    startupConfig,
    getApiKey,
    sandboxMode,
    sandboxSettings,
  });

  const modalActions = useModalActions({
    agent,
    startupConfig,
    onExit,
    apiKeyInputRef,
    hasApiKeyRef,
    terminalSessions,
    startTelegramBridge: () => startTelegramBridgeRef.current(),
  });
  const {
    openMcpModal,
    openMcpEditor,
    openSandboxPicker,
    openWalletPicker,
    openAgentsModal,
    openScheduleModal,
    openExtensionsModal,
    openSessionsModal,
    openTerminalManager,
    openClaudeAgentModal,
    openFlagsModal,
    openApiKeyModal,
    beginTelegramFromConnect,
    spawnInlineTerminal,
    closeAgentModal,
    closeAgentsPopup,
    openAgentsPopup,
    dispatchExtensionCommand,
    handleCommand,
    handleExit,
    openFileLinkInNavigator,
    handleTranscriptAutoFollowChange,
    cycleMode,
    providerAuthState,
    providerSettingsState,
    providerSettingEditState,
    providerSettingsSearchQuery,
  } = modalActions;

  const guardState = useModalGuardState(
    startupConfig.version,
    providerAuthState,
    providerSettingsState,
    providerSettingEditState,
  );

  const modelPickerData = useModelPickerData(agent, hasApiKey, providerSettingsState, providerSettingsSearchQuery);
  const {
    modeInfo,
    modelInfo,
    kernelModels,
    uniqueLogicalProviders,
    kernelAdapterMeta,
    activeModelAdapterId,
    credentialsByAdapter,
    activeModelCanRun,
    modelPickerReasoningEffortControls,
    providerSettingsRows,
    footerPermissionMode,
  } = modelPickerData;

  const shellIcon = useIcon("shell");
  const cwdIcon = useIcon("cwd");
  const sandboxIcon = useIcon("sandbox");
  const visibleSlashItems = useSlashItems();

  const { dispatchQueueAt, dispatchQueueHead } = useQueueActions({
    agent,
    clearLiveTurnUi,
    processMessageRef,
  });

  useEffect(() => {
    hasApiKeyRef.current = hasApiKey;
  }, [hasApiKey]);

  const dismissActiveOverlay = useOverlayActions(closeAgentModal, closeAgentsPopup);

  useEffect(() => {
    if (initialMessage && activeModelCanRun && !processedInitial.current) {
      processedInitial.current = true;
      processMessage(initialMessage);
    }
  }, [activeModelCanRun, initialMessage, processMessage, processedInitial.current, processedInitial]);
  const handleUiAction = useUiActionHandler({
    agent,
    version: startupConfig.version,
    openApiKeyModal,
    openSandboxPicker,
    openWalletPicker,
    openMcpEditor,
    openMcpModal,
    openAgentsModal,
    openScheduleModal,
    openExtensionsModal,
    openSessionsModal,
    openTerminalManager,
    openClaudeAgentModal,
    openThemeModal,
    openFlagsModal,
    beginTelegramFromConnect,
    spawnInlineTerminal,
    resetToNewSession,
    setUiMode,
    toggleUiMode,
  });
  const appendAssistantMessage = useCallback(
    (content: string) => {
      setMessages((prev) => [...prev, buildAssistantEntry(content)]);
    },
    [setMessages],
  );
  useKernelBridge({
    agent,
    pushToast,
    handleUiAction,
    isProcessingRef,
    queuedMessagesRef,
    nextQueueIdRef,
    setQueuedMessages,
    scrollToBottom,
    processMessageRef,
    appendAssistantMessage,
    contextStatsRef,
    contextBreakdownRef,
    activeModelAdapterIdRef,
    inputRef,
  });
  const { runningAgentRows, agentModalRow } = useRunningAgentRows(agent, scrollToBottom);

  const { dismissPlan, submitPlanAnswers, handlePlanSelect } = usePlanActions({
    processMessage,
  });

  const planQuestions = activePlan?.questions ?? [];

  const handleComposerKey = useComposerKeys({
    agent,
    handleExit,
    abortActiveRun,
    dismissActiveOverlay,
    dispatchQueueHead,
    cycleMode,
    copyTuiSelectionToHost,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref and stable fn deps are intentional
  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (guardState.dynamicScreenOpenRef.current) return;
      if (guardState.captureOpen) return;
      if (inputRouter.handleKey(key)) return;
      handleComposerKey(key);
    },
    [guardState.captureOpen, handleComposerKey],
  );

  const inputRouter = useInputRouter({
    renderer,
    queueFocusId,
    setQueueFocusId,
    btwStateRef,
    btwAbortRef,
    setBtwState: setBtwStateSync,
    dispatchInputInterceptors,
    shellModeRef,
    isCaptureOpenRef: guardState.isCaptureOpenRef,
    getInputValue: () => inputRef.current?.plainText ?? "",

    onOpenSlashMenu: (initialQuery = "") => {
      setShowSlashMenu(true);
      slashMenuIndexStore.set(0);
      setSlashSearchQuery(initialQuery);
      const ta = inputRef.current;
      if (ta) {
        const desired = `/${initialQuery}`;
        if (ta.plainText !== desired) {
          ta.clear();
          ta.insertText(desired);
        }
      }
    },
    onOpenCommandPalette: (initialQuery = "") => {
      setShowCommandPalette(true);
      setCommandPaletteQuery(initialQuery);
      setCommandPaletteIndex(0);
    },
    onGlobalPaste: (event) => {
      const text = decodePasteBytes(event.bytes);
      const paths = extractFileDropPaths(text, agent.getCwd());
      return insertDroppedFilePaths(paths);
    },
  });

  useFlushedKeyboard(
    keyPerfEnabled
      ? (key: KeyEvent) => {
          notePerfKeyStart(key?.name ?? "?");
          try {
            handleKey(key);
          } finally {
            notePerfKeyEnd();
          }
        }
      : handleKey,
  );

  const { handleSubmit, handlePaste } = useComposerActions(
    agent,
    processMessage,
    handleCommand,
    dispatchExtensionCommand,
    {
      dispatchQueueHead,
      dispatchQueueAt,
      openAgentsPopup,
      openApiKeyModal,
      scrollToBottom,
      spawnInlineTerminal,
      activeModelAdapterId,
      activeModelCanRun,
    },
  );

  const hasMessages = uiMode === "claude-code" || messages.length > 0 || !!getStreamContent() || isProcessing;

  const composerShortcutHints = useMemo(
    () =>
      buildComposerShortcutHints({
        isProcessing,
        shellMode,
        queuedCount: queuedMessages.length,
        queueFocused: queueFocusId !== null,
        typeaheadVisible: typeahead.visible,
        runningAgentsCount: runningAgentRows.length,
      }),
    [isProcessing, shellMode, queuedMessages.length, queueFocusId, typeahead.visible, runningAgentRows.length],
  );

  const composerChromeBottomTitle = useMemo(() => {
    const modeLabel = footerPermissionMode ? permissionModeComposerLabel(footerPermissionMode) : modeInfo.label;
    return formatComposerChromeLabel(modelInfo?.name || model, modeLabel);
  }, [footerPermissionMode, modeInfo.label, model, modelInfo?.name]);
  const footerRightMaxWidth = Math.max(24, Math.min(width - 4, Math.floor(width * 0.58)));
  const compactFooterHints = uiMode === "claude-code" && (isProcessing || width < 160);

  const openScreens = useMemo<Map<string, unknown>>(() => {
    const merged = new Map<string, unknown>(dynamicScreens);
    if (guardState.showWalletPicker) {
      const props: WalletPickerProps = {
        t,
        settings: walletSettings,
        walletInfo: walletDisplayInfo,
        focusIndex: walletFocusIndexRef.current,
        width,
        height,
      };
      merged.set(WALLET_SCREEN_ID, props);
    }
    if (guardState.showSandboxPicker) {
      const props: SandboxPickerProps = {
        t,
        currentMode: sandboxMode,
        settings: sandboxSettings,
        focusIndex: sandboxSettingsFocusIndexRef.current,
        editing: sandboxSettingsEditing,
        editBuffer: sandboxSettingsEditBuffer,
        width,
        height,
      };
      merged.set(SANDBOX_SCREEN_ID, props);
    }
    return merged;
  }, [
    dynamicScreens,
    guardState.showWalletPicker,
    t,
    walletSettings,
    walletDisplayInfo,
    guardState.showSandboxPicker,
    sandboxMode,
    sandboxSettings,
    sandboxSettingsEditing,
    sandboxSettingsEditBuffer,
    width,
    height,
    walletFocusIndexRef.current,
    sandboxSettingsFocusIndexRef.current,
  ]);

  return (
    <box
      width={width}
      height={height}
      backgroundColor={t.background}
      flexDirection="column"
      onMouseUp={handleRootMouseUp}
    >
      {copyFlashId > 0 ? <CopyFlashBanner t={t} width={width} /> : null}
      <ToastStack t={t} width={width} toasts={toasts} />
      {hasMessages ? (
        <SessionRoute
          agent={agent}
          processMessage={processMessage}
          dispatchExtensionCommand={dispatchExtensionCommand}
          openTerminalManager={openTerminalManager}
          openFileLinkInNavigator={openFileLinkInNavigator}
          handleTranscriptAutoFollowChange={handleTranscriptAutoFollowChange}
          abortActiveRun={abortActiveRun}
          markPathApprovedThisSession={markPathApprovedThisSession}
          markAcceptAllThisSession={markAcceptAllThisSession}
          getFeatureFlag={getFeatureFlag}
          inputRef={inputRef}
          typeahead={typeahead}
          captureOpen={guardState.captureOpen}
          modalOpen={guardState.modalOpen}
          handleSubmit={handleSubmit}
          handlePaste={handlePaste}
          runningAgentRows={runningAgentRows}
          footerPermissionMode={footerPermissionMode}
          runtimeMode={startupConfig.runtimeMode}
          composerShortcutHints={composerShortcutHints}
          composerChromeBottomTitle={composerChromeBottomTitle}
          compactFooterHints={compactFooterHints}
          footerRightMaxWidth={footerRightMaxWidth}
          cwdIcon={cwdIcon}
          shellIcon={shellIcon}
          sandboxIcon={sandboxIcon}
          showPlanPanel={guardState.showPlanPanel}
          planQuestions={planQuestions}
          visibleSlashItems={visibleSlashItems}
        />
      ) : (
        <HomeRoute
          agent={agent}
          processMessage={processMessage}
          dispatchExtensionCommand={dispatchExtensionCommand}
          inputRef={inputRef}
          typeahead={typeahead}
          captureOpen={guardState.captureOpen}
          handleSubmit={handleSubmit}
          handlePaste={handlePaste}
          startupConfig={startupConfig}
          updateInfo={updateInfo}
          isUpdating={isUpdating}
          updateOutput={updateOutput}
          cwdIcon={cwdIcon}
          shellIcon={shellIcon}
          sandboxIcon={sandboxIcon}
          footerPermissionMode={footerPermissionMode}
          visibleSlashItems={visibleSlashItems}
        />
      )}
      <ModalLayer
        agent={agent}
        startupConfig={startupConfig}
        modalScrimOpen={guardState.modalScrimOpen}
        modalActions={modalActions}
        apiKeyInputRef={apiKeyInputRef}
        processMessageRef={processMessageRef}
        telegramTokenInputRef={telegramTokenInputRef}
        telegramPairInputRef={telegramPairInputRef}
        runningAgentRows={runningAgentRows}
        agentModalRow={agentModalRow}
        providerSettingsRows={providerSettingsRows}
        activeModelAdapterId={activeModelAdapterId}
        modelPickerKernelModels={kernelModels}
        modelPickerProviders={uniqueLogicalProviders}
        modelPickerAdapters={kernelAdapterMeta}
        modelPickerCredentials={credentialsByAdapter}
        modelPickerReasoningEffortControls={modelPickerReasoningEffortControls}
        visibleSlashItems={visibleSlashItems}
        terminalSessions={terminalSessions}
        openScreens={openScreens}
        submitTelegramPair={submitTelegramPair}
        onExit={handleExit}
        onCommitComposer={commitComposer}
        onToggleFeatureFlag={toggleFeatureFlag}
        onResumeSession={resumeSessionFromModal}
        onDeleteSession={deleteSessionFromModal}
        onWriteTerminalSession={writeTerminalSession}
        onRemoveTerminalSession={removeTerminalSession}
        onStopTerminalSession={stopTerminalSession}
        onDismissPlan={dismissPlan}
        onSubmitPlanAnswers={submitPlanAnswers}
        onHandlePlanSelect={handlePlanSelect}
      />
    </box>
  );
}
