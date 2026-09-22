import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { Fragment, memo, type RefObject, useEffect, useMemo, useRef } from "react";
import type { Agent } from "../../agent/agent";
import { getHostServices as kernelGetHostServices, type ScreenContext, useScreens } from "../../core/plugins";
import { permissionModeKeyForAdapter } from "../../core/plugins/permission-mode.js";
import { POPULAR_MCP_CATALOG } from "../../mcp/catalog";
import type { McpResourceSummary } from "../../mcp/runtime";
import type { PlanQuestion } from "../../types/index";
import { formatSubagentName } from "../../utils/subagent-display";
import { buildSubagentBrowseRows, SubagentEditorModal, SubagentsBrowserModal } from "../agents-modal.js";
import { ShowcaseModal } from "../ai-output/showcase.js";
import { ApiKeyModal } from "../api-key-modal.js";
import {
  type AppStartupConfig,
  CLAUDE_AGENT_SETTING_DEFAULTS,
  CLAUDE_AGENT_SETTING_KEYS,
  CONNECT_CHANNELS,
} from "../app-helpers";
import { buildClaudeAgentRows, ClaudeAgentModal } from "../claude-agent-modal.js";
import {
  buildCommandPaletteModel,
  type CommandPaletteAction,
  CommandPaletteModal,
  SUGGESTED_PALETTE_IDS,
} from "../command-palette.js";
import { FpsOverlay } from "../components/fps-overlay.js";
import { ConnectModal } from "../connect-modal.js";
import { useModal } from "../context/modal-context.js";
import { useModel } from "../context/model-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";
import { useTheme } from "../context/theme-context.js";
import { buildFeatureFlagRows, getFeatureFlag } from "../feature-flags.js";
import { FeatureFlagsModal } from "../feature-flags-modal.js";
import { useFlushedKeyboard } from "../hooks/use-flushed-keyboard.js";
import type { useModalActions } from "../hooks/use-modal-actions.js";
import {
  buildMcpBrowseRows,
  McpBrowserModal,
  McpEditorModal,
  McpResourcesModal,
  McpResourceViewerModal,
} from "../mcp-modal.js";
import { ModelPickerModal } from "../model-picker-modal.js";
import { buildExtensionsRows, ExtensionsBrowserModal } from "../plugins-modal.js";
import { ProviderAuthModal } from "../provider-auth-modal.js";
import {
  ProviderSettingEditModal,
  type ProviderSettingRow,
  ProviderSettingsModal,
} from "../provider-settings-modal.js";
import { RunningAgentModal, type RunningAgentRow, RunningAgentsPopup } from "../running-agents.js";
import { buildScheduleBrowseRows, ScheduleBrowserModal } from "../schedule-modal.js";
import { buildSessionsRows, SessionsBrowserModal } from "../sessions-modal.js";
import type { SlashMenuItem } from "../slash-menu.js";
import { TelegramPairModal } from "../telegram-pair-modal.js";
import { TelegramTokenModal } from "../telegram-token-modal.js";
import type { TerminalSessionSnapshot } from "../terminal/manager";
import { TerminalManagerModal } from "../terminal/panel.js";
import { buildThemeRows, ThemePickerModal } from "../theme-modal.js";
import { THEMES } from "../themes/catalog.js";
import { UpdateModal } from "../update-modal.js";
import { shouldStopModalKey } from "./modal-keys/shared.js";
import { useComplexModalKeys } from "./modal-keys/use-complex-modal-keys.js";
import { useListModalKeys } from "./modal-keys/use-list-modal-keys.js";
import { useSimpleModalKeys } from "./modal-keys/use-simple-modal-keys.js";

export type McpDrillState =
  | { mode: "list" }
  | { mode: "resources"; serverId: string; serverLabel: string }
  | {
      mode: "viewer";
      serverId: string;
      serverLabel: string;
      resource: McpResourceSummary;
    };

interface ModalLayerProps {
  agent: Agent;
  startupConfig: AppStartupConfig;
  modalScrimOpen: boolean;
  modalActions: ReturnType<typeof useModalActions>;

  // Refs (not in modalActions)
  apiKeyInputRef: RefObject<TextareaRenderable | null>;
  processMessageRef: RefObject<(text: string, displayText?: string) => Promise<void> | void>;
  telegramTokenInputRef: RefObject<TextareaRenderable | null>;
  telegramPairInputRef: RefObject<TextareaRenderable | null>;

  // Running agents derived values
  runningAgentRows: RunningAgentRow[];
  agentModalRow: RunningAgentRow | null;

  // Provider settings rows (computed in app.tsx, not in modalActions)
  providerSettingsRows: ProviderSettingRow[];

  // Model picker raw inputs (not in modalActions)
  activeModelAdapterId: string | null;
  modelPickerKernelModels: ReturnType<ReturnType<typeof kernelGetHostServices>["models"]["list"]>;
  modelPickerProviders: Array<{ id: string; label: string }>;
  modelPickerAdapters: Array<{
    id: string;
    label: string;
    transport?: string;
    connectionMode?: string;
    sessionStrategy?: string;
    authMode?: string;
  }>;
  modelPickerCredentials: Record<string, boolean>;
  modelPickerReasoningEffortControls: Array<{
    adapterId: string;
    settingKey: string;
    values: readonly string[];
    currentValue?: string;
    defaultValue?: string;
  }>;

  // Command palette raw inputs
  visibleSlashItems: SlashMenuItem[];

  // Terminal
  terminalSessions: readonly TerminalSessionSnapshot[];

  // Screens
  openScreens: Map<string, unknown>;

  // Callbacks NOT in modalActions
  submitTelegramPair: () => Promise<void>;
  onExit: () => void;
  onCommitComposer: () => void;
  onToggleFeatureFlag: (id: string) => void;
  onResumeSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onWriteTerminalSession: (sessionId: string, data: string) => void;
  onRemoveTerminalSession: (sessionId: string) => void;
  onStopTerminalSession: (sessionId: string) => void;
  onDismissPlan: () => void;
  onSubmitPlanAnswers: () => void;
  onHandlePlanSelect: (
    q: PlanQuestion,
    idx: number,
    options: { id: string; label: string }[],
    showCustom: boolean,
  ) => void;
}

function ScreenSlot({ openScreens }: { openScreens: Map<string, unknown> }) {
  const screens = useScreens();
  const services = kernelGetHostServices();
  const items = screens
    .filter((screen) => openScreens.has(screen.id))
    .map((screen) => {
      const ctx: ScreenContext = {
        props: openScreens.get(screen.id),
        close: () => services.ui.action({ type: "close-screen", id: screen.id }),
        services,
      };
      return <Fragment key={screen.id}>{screen.render(ctx)}</Fragment>;
    });
  return <>{items}</>;
}

function ModalLayerImpl(props: ModalLayerProps) {
  const { t, themeId, showThemeModal, themeSearchQuery, themeModalIndex } = useTheme();
  const { width, height } = useTerminalDimensions();
  const modal = useModal();
  const { model, reasoningEffortByModel, permissionModeSnapshot } = useModel();
  const { showAgentsPopup, agentsPopupIndex, agentsNow, agentModalId, agentModalOutput, agentModalLoading } =
    useRunningAgents();

  const kernelServices = kernelGetHostServices();

  // ── Row computations (moved from app.tsx) ──────────────────────────────
  // These depend on nav search queries from useModal(), so they recompute
  // here in ModalLayer — not in app.tsx — to avoid re-rendering the entire
  // god component on every keystroke.

  const mcpRows = useMemo(
    () => buildMcpBrowseRows(modal.mcpServers, POPULAR_MCP_CATALOG, modal.mcpSearchQuery),
    [modal.mcpServers, modal.mcpSearchQuery],
  );

  const scheduleRows = useMemo(
    () => buildScheduleBrowseRows(modal.schedules, modal.scheduleSearchQuery),
    [modal.schedules, modal.scheduleSearchQuery],
  );

  const agentRows = useMemo(
    () => buildSubagentBrowseRows(props.modalActions.subAgents, modal.agentsSearchQuery),
    [props.modalActions.subAgents, modal.agentsSearchQuery],
  );

  // Command palette — built from visibleSlashItems + live query
  const commandPaletteBaseActions = useMemo(
    () =>
      props.visibleSlashItems.map<CommandPaletteAction>((item) => ({
        id: item.id,
        label: `/${item.label}`,
        description: item.description,
        source: "Agent",
        suggested: SUGGESTED_PALETTE_IDS.has(item.id),
      })),
    [props.visibleSlashItems],
  );

  const commandPaletteTrimmedQuery = modal.commandPaletteQuery.trim();
  const commandPaletteModel = useMemo(
    () =>
      buildCommandPaletteModel(commandPaletteBaseActions, modal.commandPaletteQuery, {
        leadingAction: commandPaletteTrimmedQuery
          ? {
              id: "__ask__",
              label: commandPaletteTrimmedQuery,
              description: "Ask the agent",
              source: "Ask",
            }
          : undefined,
      }),
    [commandPaletteBaseActions, modal.commandPaletteQuery, commandPaletteTrimmedQuery],
  );
  const commandPaletteActions = commandPaletteModel.actions;

  // ── Index clamping effects (moved from app.tsx) ────────────────────────
  // Keep the selected index in bounds when the search query shrinks the row
  // count. These fire on row-length change, which happens when the query
  // changes (recomputing the rows above).
  useEffect(() => {
    modal.setMcpModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, mcpRows.length - 1))));
  }, [mcpRows.length, modal.setMcpModalIndex]);

  useEffect(() => {
    modal.setScheduleModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, scheduleRows.length - 1))));
  }, [scheduleRows.length, modal.setScheduleModalIndex]);

  // ── Modal key handling (split into per-domain hooks) ───────────────────
  // Each hook returns a (key: KeyEvent) => boolean handler that returns true
  // if it consumed the key, false to fall through. Hooks are called in priority
  // order: simple (quit/btw/agents) → list (browsers) → complex (editors).
  const simpleKeys = useSimpleModalKeys({
    onExit: props.onExit,
    modalActions: props.modalActions,
    submitTelegramPair: props.submitTelegramPair,
  });
  const listKeys = useListModalKeys({
    modalActions: props.modalActions,
    agent: props.agent,
    mcpRows,
    scheduleRows,
    agentRows,
    commandPaletteActions,
    visibleSlashItems: props.visibleSlashItems,
    terminalSessions: props.terminalSessions,
    providerSettingsRows: props.providerSettingsRows,
    processMessageRef: props.processMessageRef,
    onToggleFeatureFlag: props.onToggleFeatureFlag,
    onCommitComposer: props.onCommitComposer,
    onResumeSession: props.onResumeSession,
    onDeleteSession: props.onDeleteSession,
    onWriteTerminalSession: props.onWriteTerminalSession,
    onRemoveTerminalSession: props.onRemoveTerminalSession,
    onStopTerminalSession: props.onStopTerminalSession,
  });
  const complexKeys = useComplexModalKeys({
    modalActions: props.modalActions,
    visibleSlashItems: props.visibleSlashItems,
    processMessageRef: props.processMessageRef,
    onDismissPlan: props.onDismissPlan,
    onSubmitPlanAnswers: props.onSubmitPlanAnswers,
    onHandlePlanSelect: props.onHandlePlanSelect,
  });

  // Uses a ref so useKeyboard registers once with a stable callback; the
  // ref is updated on every render with fresh closures.
  const keyHandlerRef = useRef<(key: KeyEvent) => void>(() => {});
  keyHandlerRef.current = (key: KeyEvent) => {
    // Dynamic screen owns keyboard — surrender entirely.
    if (modal.dynamicScreens.size > 0) return;
    const consumed = simpleKeys(key) || listKeys(key) || complexKeys(key);
    if (!consumed) return;
    // Stop consumed keys here so no hidden handler (inline approval cards,
    // composer) also acts on them.
    const textEntryOpen =
      modal.showApiKeyModalRef.current ||
      modal.showTelegramTokenModalRef.current ||
      modal.showTelegramPairModalRef.current ||
      modal.showMcpEditorRef.current ||
      modal.showAgentsEditorRef.current ||
      props.modalActions.providerAuthState !== null ||
      props.modalActions.providerSettingEditState !== null;
    if (shouldStopModalKey(key, textEntryOpen)) {
      key.preventDefault?.();
      key.stopPropagation?.();
    }
  };
  useFlushedKeyboard((key: KeyEvent) => keyHandlerRef.current(key));

  return (
    <>
      {props.modalScrimOpen && (
        <box position="absolute" left={0} top={0} width={width} height={height} backgroundColor="#000000cc" />
      )}
      {modal.showQuitConfirm && (
        <box
          position="absolute"
          left={0}
          top={0}
          width={width}
          height={height}
          alignItems="center"
          justifyContent="center"
        >
          <box
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={t.accent}
            backgroundColor={t.backgroundPanel}
            paddingLeft={3}
            paddingRight={3}
            paddingTop={1}
            paddingBottom={1}
          >
            <text fg={t.text}>Quit codesurf?</text>
            <text fg={t.textMuted}>enter / y quit · esc / n cancel</text>
          </box>
        </box>
      )}
      {showAgentsPopup && (
        <RunningAgentsPopup
          t={t}
          width={width}
          height={height}
          rows={props.runningAgentRows}
          selectedIndex={agentsPopupIndex}
          now={agentsNow}
        />
      )}
      {agentModalId !== null && (
        <RunningAgentModal
          t={t}
          width={width}
          height={height}
          row={props.agentModalRow}
          output={agentModalOutput}
          loading={agentModalLoading}
          now={agentsNow}
        />
      )}
      {modal.showApiKeyModal && (
        <ApiKeyModal
          t={t}
          width={width}
          height={height}
          inputRef={props.apiKeyInputRef}
          error={modal.apiKeyError}
          onSubmit={props.modalActions.submitApiKey}
        />
      )}
      {modal.showUpdateModal && modal.updateInfo && (
        <UpdateModal
          t={t}
          width={width}
          height={height}
          currentVersion={props.startupConfig.version}
          latestVersion={modal.updateInfo.latestVersion}
        />
      )}
      {modal.showMcpModal && !modal.showMcpEditor && props.modalActions.mcpDrillState.mode === "list" && (
        <McpBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.mcpModalIndex}
          searchQuery={modal.mcpSearchQuery}
          rows={mcpRows}
          serverStats={props.modalActions.mcpServerStats}
          statsLoading={props.modalActions.mcpStatsLoading}
        />
      )}
      {modal.showMcpModal && !modal.showMcpEditor && props.modalActions.mcpDrillState.mode === "resources" && (
        <McpResourcesModal
          t={t}
          width={width}
          height={height}
          serverLabel={props.modalActions.mcpDrillState.serverLabel}
          resources={props.modalActions.mcpDrillResources}
          loading={props.modalActions.mcpDrillResourcesLoading}
          selectedIndex={props.modalActions.mcpDrillResourceIndex}
        />
      )}
      {modal.showMcpModal && !modal.showMcpEditor && props.modalActions.mcpDrillState.mode === "viewer" && (
        <McpResourceViewerModal
          t={t}
          width={width}
          height={height}
          serverLabel={props.modalActions.mcpDrillState.serverLabel}
          resource={props.modalActions.mcpDrillState.resource}
          contents={props.modalActions.mcpDrillContent}
          loading={props.modalActions.mcpDrillContentLoading}
        />
      )}
      {modal.showMcpEditor && (
        <McpEditorModal
          t={t}
          width={width}
          height={height}
          draft={props.modalActions.mcpEditorDraft}
          focusedField={props.modalActions.mcpEditorField}
          syncKey={props.modalActions.mcpEditorSyncKey}
          error={props.modalActions.mcpEditorError}
          title={props.modalActions.editingMcpId ? "Edit MCP Server" : "Add MCP Server"}
          labelRef={props.modalActions.mcpLabelRef}
          urlRef={props.modalActions.mcpUrlRef}
          headersRef={props.modalActions.mcpHeadersRef}
          commandRef={props.modalActions.mcpCommandRef}
          argsRef={props.modalActions.mcpArgsRef}
          cwdRef={props.modalActions.mcpCwdRef}
          envRef={props.modalActions.mcpEnvRef}
          onSubmit={props.modalActions.submitMcpEditor}
        />
      )}
      {modal.showScheduleModal && (
        <ScheduleBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.scheduleModalIndex}
          searchQuery={modal.scheduleSearchQuery}
          rows={scheduleRows}
        />
      )}
      {modal.showExtensionsModal && (
        <ExtensionsBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.extensionsModalIndex}
          searchQuery={modal.extensionsSearchQuery}
          rows={buildExtensionsRows(modal.extensionsList, modal.extensionsSearchQuery, modal.expandedExtensionGroups)}
        />
      )}
      {modal.showFlagsModal && (
        <FeatureFlagsModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.flagsModalIndex}
          searchQuery={modal.flagsSearchQuery}
          rows={buildFeatureFlagRows(modal.flagsSearchQuery)}
          key={`flags-${modal.flagsTick}`}
        />
      )}
      {modal.showSessionsModal && (
        <SessionsBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.sessionsModalIndex}
          searchQuery={modal.sessionsSearchQuery}
          rows={buildSessionsRows(modal.sessionsList, props.agent.getSessionId(), modal.sessionsSearchQuery)}
          scope={getFeatureFlag("sessions.scope.global") ? "global" : "local"}
        />
      )}
      {showThemeModal && (
        <ThemePickerModal
          t={t}
          width={width}
          height={height}
          selectedIndex={themeModalIndex}
          searchQuery={themeSearchQuery}
          rows={buildThemeRows(THEMES, themeSearchQuery)}
          currentThemeId={themeId}
        />
      )}
      {modal.showCommandPalette && (
        <CommandPaletteModal
          t={t}
          width={width}
          height={height}
          searchQuery={modal.commandPaletteQuery}
          model={commandPaletteModel}
          selectedIndex={modal.commandPaletteIndex}
          onSelectIndex={modal.setCommandPaletteIndex}
          onConfirm={(idx) => {
            const row = commandPaletteActions[idx];
            if (!row) return;
            modal.setShowCommandPalette(false);
            modal.setCommandPaletteQuery("");
            if (row.id === "__ask__") {
              const q = modal.commandPaletteQuery.trim();
              if (q) props.processMessageRef.current?.(q);
              return;
            }
            const menuItem = props.visibleSlashItems.find((m) => m.id === row.id);
            if (menuItem) props.modalActions.handleSlashMenuSelect(menuItem);
          }}
        />
      )}
      {modal.showShowcaseModal && <ShowcaseModal t={t} width={width} height={height} />}
      {modal.showTerminalModal && (
        <TerminalManagerModal
          t={t}
          width={width}
          height={height}
          sessions={props.terminalSessions}
          selectedIndex={modal.terminalModalIndex}
          inputMode={modal.terminalInputMode}
        />
      )}
      {modal.showClaudeAgentModal &&
        (() => {
          const onlyGroups = props.modalActions.claudeAgentModalOnlyGroups ?? undefined;
          const rows = buildClaudeAgentRows(onlyGroups ? { onlyGroups } : undefined);
          const permissionOnly = onlyGroups?.length === 1 && onlyGroups[0] === "permission";
          // Prefer the active adapter's live value so the radio marker matches
          // what the footer shows when /permissions opens on Codesurf CLI / daemon.
          const activeAdapter = kernelServices.models.getActiveAdapterId?.() ?? null;
          const activePermKey = activeAdapter ? permissionModeKeyForAdapter(activeAdapter) : null;
          const activePermission =
            (activePermKey && permissionModeSnapshot.byKey?.[activePermKey]) ||
            permissionModeSnapshot.claude ||
            CLAUDE_AGENT_SETTING_DEFAULTS.permission;
          return (
            <ClaudeAgentModal
              t={t}
              width={width}
              height={height}
              rows={rows}
              selectedIndex={modal.claudeAgentModalIndex}
              title={permissionOnly ? "Permission mode" : "Claude Agent SDK"}
              currentValues={{
                thinking:
                  kernelServices.settings.get<string>(
                    CLAUDE_AGENT_SETTING_KEYS.thinking,
                    CLAUDE_AGENT_SETTING_DEFAULTS.thinking,
                  ) ?? CLAUDE_AGENT_SETTING_DEFAULTS.thinking,
                effort:
                  kernelServices.settings.get<string>(
                    CLAUDE_AGENT_SETTING_KEYS.effort,
                    CLAUDE_AGENT_SETTING_DEFAULTS.effort,
                  ) ?? CLAUDE_AGENT_SETTING_DEFAULTS.effort,
                permission: activePermission,
              }}
            />
          );
        })()}
      {props.modalActions.providerAuthState !== null && (
        <ProviderAuthModal
          t={t}
          width={width}
          height={height}
          adapterId={props.modalActions.providerAuthState.adapterId}
          title={props.modalActions.providerAuthState.title}
          subtitle={props.modalActions.providerAuthState.subtitle}
          reason={props.modalActions.providerAuthState.reason}
          envVarHint={props.modalActions.providerAuthState.envVarHint}
          syncKey={props.modalActions.providerAuthSyncKey}
          error={props.modalActions.providerAuthError}
          inputRef={props.modalActions.providerAuthInputRef}
          onSubmit={props.modalActions.submitProviderAuthModal}
        />
      )}
      {props.modalActions.providerSettingsState !== null && (
        <ProviderSettingsModal
          t={t}
          width={width}
          height={height}
          title={props.modalActions.providerSettingsState.title}
          rows={props.providerSettingsRows}
          selectedIndex={props.modalActions.providerSettingsIndex}
          searchQuery={props.modalActions.providerSettingsSearchQuery}
        />
      )}
      {props.modalActions.providerSettingEditState !== null && (
        <ProviderSettingEditModal
          t={t}
          width={width}
          height={height}
          setting={props.modalActions.providerSettingEditState}
          inputRef={props.modalActions.providerSettingEditInputRef}
          syncKey={props.modalActions.providerSettingEditSyncKey}
          error={props.modalActions.providerSettingEditError}
          onSubmit={props.modalActions.submitProviderSettingEditModal}
        />
      )}
      {modal.showAgentsModal && !modal.showAgentsEditor && (
        <SubagentsBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.agentsModalIndex}
          searchQuery={modal.agentsSearchQuery}
          rows={agentRows}
        />
      )}
      {modal.showAgentsEditor && (
        <SubagentEditorModal
          key={`subagent-editor-${props.modalActions.agentsEditorSyncKey}`}
          t={t}
          width={width}
          height={height}
          draft={props.modalActions.agentsEditorDraft}
          focusedField={props.modalActions.agentsEditorField}
          modelIndex={props.modalActions.agentsEditorModelIndex}
          error={props.modalActions.agentsEditorError}
          title={
            props.modalActions.editingSubagent
              ? `Edit sub-agent: ${formatSubagentName(props.modalActions.editingSubagent.name)}`
              : "Add sub-agent"
          }
          nameRef={props.modalActions.subagentNameRef}
          instructionRef={props.modalActions.subagentInstructionRef}
          onSubmit={props.modalActions.submitSubagentEditor}
          showRemoveHint={!!props.modalActions.editingSubagent}
        />
      )}
      {modal.showModelPicker && (
        <ModelPickerModal
          t={t}
          width={width}
          height={height}
          currentModel={model}
          currentAdapterId={props.activeModelAdapterId}
          model={model}
          activeModelAdapterId={props.activeModelAdapterId ?? ""}
          onClose={props.modalActions.handleModelPickerClose}
          onSelect={props.modalActions.handleModelPickerSelect}
          onOpenProviderAuth={props.modalActions.handleModelPickerOpenAuth}
          onAdjustReasoningEffort={props.modalActions.adjustModelReasoningEffort}
          onOpenProviderSettings={props.modalActions.openProviderSettingsModal}
          kernelModels={props.modelPickerKernelModels}
          providers={props.modelPickerProviders}
          adapters={props.modelPickerAdapters}
          credentials={props.modelPickerCredentials}
          reasoningEffortControls={props.modelPickerReasoningEffortControls}
          reasoningEffortByModel={reasoningEffortByModel}
        />
      )}
      <ScreenSlot openScreens={props.openScreens} />

      {modal.showConnectModal && (
        <ConnectModal
          t={t}
          width={width}
          height={height}
          selectedIndex={modal.connectModalIndex}
          channels={CONNECT_CHANNELS}
        />
      )}
      {modal.showTelegramTokenModal && (
        <TelegramTokenModal
          t={t}
          width={width}
          height={height}
          inputRef={props.telegramTokenInputRef}
          error={modal.telegramTokenError}
          onSubmit={props.modalActions.submitTelegramToken}
        />
      )}
      {modal.showTelegramPairModal && (
        <TelegramPairModal
          t={t}
          width={width}
          height={height}
          inputRef={props.telegramPairInputRef}
          error={modal.telegramPairError}
          onSubmit={() => void props.submitTelegramPair()}
        />
      )}
      {getFeatureFlag("render.fpsOverlay") && <FpsOverlay t={t} />}
    </>
  );
}

export const ModalLayer = memo(ModalLayerImpl);
