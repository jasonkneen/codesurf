import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listPlugins as kernelListExtensions, type PluginListEntry } from "../../core/plugins";
import type { StoredSchedule } from "../../tools/schedule";
import type { SessionInfo } from "../../types/index";
import { loadMcpServers, type McpServerConfig } from "../../utils/settings";
import type { UpdateCheckResult } from "../../utils/update-checker";
import { type ModalNavCtx, NavCtx, useModalNav } from "./modal-nav-context.js";
import { type ModalVisibilityCtx, useModalVisibility, VisibilityCtx } from "./modal-visibility-context.js";

export type ModalCtx = ModalVisibilityCtx & ModalNavCtx;

export type { ModalNavCtx, ModalVisibilityCtx };
export { useModalNav, useModalVisibility };

export function useModal(): ModalCtx {
  const vis = useContext(VisibilityCtx);
  const nav = useContext(NavCtx);
  if (!vis || !nav) throw new Error("useModal must be used inside <ModalProvider>");
  return { ...vis, ...nav };
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [showClaudeAgentModal, setShowClaudeAgentModal] = useState(false);
  const [claudeAgentModalIndex, setClaudeAgentModalIndex] = useState(0);
  const showClaudeAgentModalRef = useRef(false);
  const claudeAgentModalIndexRef = useRef(0);

  const [showTerminalModal, setShowTerminalModal] = useState(false);
  const [terminalModalIndex, setTerminalModalIndex] = useState(0);
  const showTerminalModalRef = useRef(false);
  const terminalModalIndexRef = useRef(0);
  const [terminalInputMode, setTerminalInputMode] = useState(false);
  const terminalInputModeRef = useRef(false);

  const [showShowcaseModal, setShowShowcaseModal] = useState(false);
  const showShowcaseModalRef = useRef(false);

  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const showCommandPaletteRef = useRef(false);
  const commandPaletteIndexRef = useRef(0);
  const commandPaletteQueryRef = useRef("");

  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const showApiKeyModalRef = useRef(false);

  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashSearchQuery, setSlashSearchQuery] = useState("");
  const slashSearchQueryRef = useRef("");

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [expandedModelGroups, setExpandedModelGroups] = useState<Set<string>>(() => new Set());
  const modelPickerIndexRef = useRef(0);
  const modelSearchQueryRef = useRef("");

  const [showSandboxPicker, setShowSandboxPicker] = useState(false);
  const [sandboxSettingsFocusIndex, setSandboxSettingsFocusIndex] = useState(0);
  const [sandboxSettingsEditing, setSandboxSettingsEditing] = useState<string | null>(null);
  const [sandboxSettingsEditBuffer, setSandboxSettingsEditBuffer] = useState("");
  const sandboxSettingsFocusIndexRef = useRef(0);

  const [showRecapPicker, setShowRecapPicker] = useState(false);

  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [walletFocusIndex, setWalletFocusIndex] = useState(0);
  const walletFocusIndexRef = useRef(0);

  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const showQuitConfirmRef = useRef(false);

  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleModalIndex, setScheduleModalIndex] = useState(0);
  const [scheduleSearchQuery, setScheduleSearchQuery] = useState("");
  const showScheduleModalRef = useRef(false);
  const [schedules, setSchedules] = useState<StoredSchedule[]>([]);
  const scheduleModalIndexRef = useRef(0);
  const scheduleSearchQueryRef = useRef("");

  const [showExtensionsModal, setShowExtensionsModal] = useState(false);
  const [extensionsModalIndex, setExtensionsModalIndex] = useState(0);
  const [extensionsSearchQuery, setExtensionsSearchQuery] = useState("");
  const showExtensionsModalRef = useRef(false);
  const [extensionsList, setExtensionsList] = useState<PluginListEntry[]>(() => kernelListExtensions());
  const [expandedExtensionGroups, setExpandedExtensionGroups] = useState<Set<string>>(() => new Set());
  const extensionsModalIndexRef = useRef(0);
  const extensionsSearchQueryRef = useRef("");

  const [showFlagsModal, setShowFlagsModal] = useState(false);
  const [flagsModalIndex, setFlagsModalIndex] = useState(0);
  const [flagsSearchQuery, setFlagsSearchQuery] = useState("");
  const [flagsTick, setFlagsTick] = useState(0);
  const showFlagsModalRef = useRef(false);
  const flagsModalIndexRef = useRef(0);
  const flagsSearchQueryRef = useRef("");

  const [showSessionsModal, setShowSessionsModal] = useState(false);
  const [sessionsModalIndex, setSessionsModalIndex] = useState(0);
  const [sessionsSearchQuery, setSessionsSearchQuery] = useState("");
  const showSessionsModalRef = useRef(false);
  const [sessionsList, setSessionsList] = useState<SessionInfo[]>([]);
  const sessionsModalIndexRef = useRef(0);
  const sessionsSearchQueryRef = useRef("");

  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const showUpdateModalRef = useRef(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState<string | null>(null);

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectModalIndex, setConnectModalIndex] = useState(0);
  const showConnectModalRef = useRef(false);
  const connectModalIndexRef = useRef(0);

  const [showTelegramTokenModal, setShowTelegramTokenModal] = useState(false);
  const [telegramTokenError, setTelegramTokenError] = useState<string | null>(null);
  const showTelegramTokenModalRef = useRef(false);

  const [showTelegramPairModal, setShowTelegramPairModal] = useState(false);
  const [telegramPairError, setTelegramPairError] = useState<string | null>(null);
  const showTelegramPairModalRef = useRef(false);

  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpEditor, setShowMcpEditor] = useState(false);
  const [mcpSearchQuery, setMcpSearchQuery] = useState("");
  const [mcpModalIndex, setMcpModalIndex] = useState(0);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  const showMcpModalRef = useRef(false);
  const showMcpEditorRef = useRef(false);
  const mcpModalIndexRef = useRef(0);
  const mcpSearchQueryRef = useRef("");

  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [showAgentsEditor, setShowAgentsEditor] = useState(false);
  const [agentsSearchQuery, setAgentsSearchQuery] = useState("");
  const [agentsModalIndex, setAgentsModalIndex] = useState(0);
  const showAgentsModalRef = useRef(false);
  const showAgentsEditorRef = useRef(false);
  const agentsModalIndexRef = useRef(0);
  const agentsSearchQueryRef = useRef("");

  const [dynamicScreens, setDynamicScreens] = useState<Map<string, unknown>>(new Map());

  const showProviderAuthModalRef = useRef(false);
  const showProviderSettingsModalRef = useRef(false);
  const showProviderSettingEditModalRef = useRef(false);

  // Sync refs with hot-path state so visibility-only consumers can read
  // current index/query values without subscribing to nav changes.
  useEffect(() => {
    claudeAgentModalIndexRef.current = claudeAgentModalIndex;
  }, [claudeAgentModalIndex]);
  useEffect(() => {
    terminalModalIndexRef.current = terminalModalIndex;
  }, [terminalModalIndex]);
  useEffect(() => {
    commandPaletteIndexRef.current = commandPaletteIndex;
  }, [commandPaletteIndex]);
  useEffect(() => {
    commandPaletteQueryRef.current = commandPaletteQuery;
  }, [commandPaletteQuery]);
  useEffect(() => {
    slashSearchQueryRef.current = slashSearchQuery;
  }, [slashSearchQuery]);
  useEffect(() => {
    modelPickerIndexRef.current = modelPickerIndex;
  }, [modelPickerIndex]);
  useEffect(() => {
    modelSearchQueryRef.current = modelSearchQuery;
  }, [modelSearchQuery]);
  useEffect(() => {
    sandboxSettingsFocusIndexRef.current = sandboxSettingsFocusIndex;
  }, [sandboxSettingsFocusIndex]);
  useEffect(() => {
    walletFocusIndexRef.current = walletFocusIndex;
  }, [walletFocusIndex]);
  useEffect(() => {
    scheduleModalIndexRef.current = scheduleModalIndex;
  }, [scheduleModalIndex]);
  useEffect(() => {
    scheduleSearchQueryRef.current = scheduleSearchQuery;
  }, [scheduleSearchQuery]);
  useEffect(() => {
    extensionsModalIndexRef.current = extensionsModalIndex;
  }, [extensionsModalIndex]);
  useEffect(() => {
    extensionsSearchQueryRef.current = extensionsSearchQuery;
  }, [extensionsSearchQuery]);
  useEffect(() => {
    flagsModalIndexRef.current = flagsModalIndex;
  }, [flagsModalIndex]);
  useEffect(() => {
    flagsSearchQueryRef.current = flagsSearchQuery;
  }, [flagsSearchQuery]);
  useEffect(() => {
    sessionsModalIndexRef.current = sessionsModalIndex;
  }, [sessionsModalIndex]);
  useEffect(() => {
    sessionsSearchQueryRef.current = sessionsSearchQuery;
  }, [sessionsSearchQuery]);
  useEffect(() => {
    connectModalIndexRef.current = connectModalIndex;
  }, [connectModalIndex]);
  useEffect(() => {
    mcpModalIndexRef.current = mcpModalIndex;
  }, [mcpModalIndex]);
  useEffect(() => {
    mcpSearchQueryRef.current = mcpSearchQuery;
  }, [mcpSearchQuery]);
  useEffect(() => {
    agentsModalIndexRef.current = agentsModalIndex;
  }, [agentsModalIndex]);
  useEffect(() => {
    agentsSearchQueryRef.current = agentsSearchQuery;
  }, [agentsSearchQuery]);

  // Sync boolean visibility refs so hot-path consumers can check whether a
  // modal is open without subscribing to re-renders.
  useEffect(() => {
    showClaudeAgentModalRef.current = showClaudeAgentModal;
  }, [showClaudeAgentModal]);
  useEffect(() => {
    showTerminalModalRef.current = showTerminalModal;
  }, [showTerminalModal]);
  useEffect(() => {
    showShowcaseModalRef.current = showShowcaseModal;
  }, [showShowcaseModal]);
  useEffect(() => {
    showCommandPaletteRef.current = showCommandPalette;
  }, [showCommandPalette]);
  useEffect(() => {
    showApiKeyModalRef.current = showApiKeyModal;
  }, [showApiKeyModal]);
  useEffect(() => {
    showQuitConfirmRef.current = showQuitConfirm;
  }, [showQuitConfirm]);
  useEffect(() => {
    showScheduleModalRef.current = showScheduleModal;
  }, [showScheduleModal]);
  useEffect(() => {
    showExtensionsModalRef.current = showExtensionsModal;
  }, [showExtensionsModal]);
  useEffect(() => {
    showFlagsModalRef.current = showFlagsModal;
  }, [showFlagsModal]);
  useEffect(() => {
    showSessionsModalRef.current = showSessionsModal;
  }, [showSessionsModal]);
  useEffect(() => {
    showUpdateModalRef.current = showUpdateModal;
  }, [showUpdateModal]);
  useEffect(() => {
    showConnectModalRef.current = showConnectModal;
  }, [showConnectModal]);
  useEffect(() => {
    showTelegramTokenModalRef.current = showTelegramTokenModal;
  }, [showTelegramTokenModal]);
  useEffect(() => {
    showTelegramPairModalRef.current = showTelegramPairModal;
  }, [showTelegramPairModal]);
  useEffect(() => {
    showMcpModalRef.current = showMcpModal;
  }, [showMcpModal]);
  useEffect(() => {
    showMcpEditorRef.current = showMcpEditor;
  }, [showMcpEditor]);
  useEffect(() => {
    showAgentsModalRef.current = showAgentsModal;
  }, [showAgentsModal]);
  useEffect(() => {
    showAgentsEditorRef.current = showAgentsEditor;
  }, [showAgentsEditor]);
  useEffect(() => {
    terminalInputModeRef.current = terminalInputMode;
  }, [terminalInputMode]);

  const visibilityValue = useMemo<ModalVisibilityCtx>(
    () => ({
      showClaudeAgentModal,
      setShowClaudeAgentModal,
      showClaudeAgentModalRef,
      claudeAgentModalIndexRef,
      setClaudeAgentModalIndex,
      showTerminalModal,
      setShowTerminalModal,
      showTerminalModalRef,
      terminalInputMode,
      setTerminalInputMode,
      terminalInputModeRef,
      terminalModalIndexRef,
      setTerminalModalIndex,
      showShowcaseModal,
      setShowShowcaseModal,
      showShowcaseModalRef,
      showCommandPalette,
      setShowCommandPalette,
      showCommandPaletteRef,
      commandPaletteIndexRef,
      setCommandPaletteIndex,
      commandPaletteQueryRef,
      setCommandPaletteQuery,
      showApiKeyModal,
      setShowApiKeyModal,
      apiKeyError,
      setApiKeyError,
      showApiKeyModalRef,
      showSlashMenu,
      setShowSlashMenu,
      slashSearchQueryRef,
      setSlashSearchQuery,
      showModelPicker,
      setShowModelPicker,
      expandedModelGroups,
      setExpandedModelGroups,
      modelPickerIndexRef,
      setModelPickerIndex,
      modelSearchQueryRef,
      setModelSearchQuery,
      showSandboxPicker,
      setShowSandboxPicker,
      sandboxSettingsEditing,
      setSandboxSettingsEditing,
      sandboxSettingsEditBuffer,
      setSandboxSettingsEditBuffer,
      sandboxSettingsFocusIndexRef,
      setSandboxSettingsFocusIndex,
      showRecapPicker,
      setShowRecapPicker,
      showWalletPicker,
      setShowWalletPicker,
      walletFocusIndexRef,
      setWalletFocusIndex,
      showQuitConfirm,
      setShowQuitConfirm,
      showQuitConfirmRef,
      showScheduleModal,
      setShowScheduleModal,
      showScheduleModalRef,
      schedules,
      setSchedules,
      scheduleModalIndexRef,
      setScheduleModalIndex,
      scheduleSearchQueryRef,
      setScheduleSearchQuery,
      showExtensionsModal,
      setShowExtensionsModal,
      showExtensionsModalRef,
      extensionsList,
      setExtensionsList,
      expandedExtensionGroups,
      setExpandedExtensionGroups,
      extensionsModalIndexRef,
      setExtensionsModalIndex,
      extensionsSearchQueryRef,
      setExtensionsSearchQuery,
      showFlagsModal,
      setShowFlagsModal,
      flagsTick,
      setFlagsTick,
      showFlagsModalRef,
      flagsModalIndexRef,
      setFlagsModalIndex,
      flagsSearchQueryRef,
      setFlagsSearchQuery,
      showSessionsModal,
      setShowSessionsModal,
      showSessionsModalRef,
      sessionsList,
      setSessionsList,
      sessionsModalIndexRef,
      setSessionsModalIndex,
      sessionsSearchQueryRef,
      setSessionsSearchQuery,
      showUpdateModal,
      setShowUpdateModal,
      showUpdateModalRef,
      updateInfo,
      setUpdateInfo,
      isUpdating,
      setIsUpdating,
      updateOutput,
      setUpdateOutput,
      showConnectModal,
      setShowConnectModal,
      showConnectModalRef,
      connectModalIndexRef,
      setConnectModalIndex,
      showTelegramTokenModal,
      setShowTelegramTokenModal,
      telegramTokenError,
      setTelegramTokenError,
      showTelegramTokenModalRef,
      showTelegramPairModal,
      setShowTelegramPairModal,
      telegramPairError,
      setTelegramPairError,
      showTelegramPairModalRef,
      showMcpModal,
      setShowMcpModal,
      showMcpEditor,
      setShowMcpEditor,
      mcpServers,
      setMcpServers,
      showMcpModalRef,
      showMcpEditorRef,
      mcpModalIndexRef,
      setMcpModalIndex,
      mcpSearchQueryRef,
      setMcpSearchQuery,
      showAgentsModal,
      setShowAgentsModal,
      showAgentsEditor,
      setShowAgentsEditor,
      showAgentsModalRef,
      showAgentsEditorRef,
      agentsModalIndexRef,
      setAgentsModalIndex,
      agentsSearchQueryRef,
      setAgentsSearchQuery,
      dynamicScreens,
      setDynamicScreens,
      showProviderAuthModalRef,
      showProviderSettingsModalRef,
      showProviderSettingEditModalRef,
    }),
    [
      showClaudeAgentModal,
      showTerminalModal,
      terminalInputMode,
      showShowcaseModal,
      showCommandPalette,
      showApiKeyModal,
      apiKeyError,
      showSlashMenu,
      showModelPicker,
      expandedModelGroups,
      showSandboxPicker,
      sandboxSettingsEditing,
      sandboxSettingsEditBuffer,
      showRecapPicker,
      showWalletPicker,
      showQuitConfirm,
      showScheduleModal,
      schedules,
      showExtensionsModal,
      extensionsList,
      expandedExtensionGroups,
      showFlagsModal,
      flagsTick,
      showSessionsModal,
      sessionsList,
      showUpdateModal,
      updateInfo,
      isUpdating,
      updateOutput,
      showConnectModal,
      showTelegramTokenModal,
      telegramTokenError,
      showTelegramPairModal,
      telegramPairError,
      showMcpModal,
      showMcpEditor,
      mcpServers,
      showAgentsModal,
      showAgentsEditor,
      dynamicScreens,
    ],
  );

  const navValue = useMemo<ModalNavCtx>(
    () => ({
      claudeAgentModalIndex,
      setClaudeAgentModalIndex,
      terminalModalIndex,
      setTerminalModalIndex,
      commandPaletteIndex,
      setCommandPaletteIndex,
      commandPaletteQuery,
      setCommandPaletteQuery,
      slashSearchQuery,
      setSlashSearchQuery,
      modelPickerIndex,
      setModelPickerIndex,
      modelSearchQuery,
      setModelSearchQuery,
      sandboxSettingsFocusIndex,
      setSandboxSettingsFocusIndex,
      walletFocusIndex,
      setWalletFocusIndex,
      scheduleModalIndex,
      setScheduleModalIndex,
      scheduleSearchQuery,
      setScheduleSearchQuery,
      extensionsModalIndex,
      setExtensionsModalIndex,
      extensionsSearchQuery,
      setExtensionsSearchQuery,
      flagsModalIndex,
      setFlagsModalIndex,
      flagsSearchQuery,
      setFlagsSearchQuery,
      sessionsModalIndex,
      setSessionsModalIndex,
      sessionsSearchQuery,
      setSessionsSearchQuery,
      connectModalIndex,
      setConnectModalIndex,
      mcpModalIndex,
      setMcpModalIndex,
      mcpSearchQuery,
      setMcpSearchQuery,
      agentsModalIndex,
      setAgentsModalIndex,
      agentsSearchQuery,
      setAgentsSearchQuery,
    }),
    [
      claudeAgentModalIndex,
      terminalModalIndex,
      commandPaletteIndex,
      commandPaletteQuery,
      slashSearchQuery,
      modelPickerIndex,
      modelSearchQuery,
      sandboxSettingsFocusIndex,
      walletFocusIndex,
      scheduleModalIndex,
      scheduleSearchQuery,
      extensionsModalIndex,
      extensionsSearchQuery,
      flagsModalIndex,
      flagsSearchQuery,
      sessionsModalIndex,
      sessionsSearchQuery,
      connectModalIndex,
      mcpModalIndex,
      mcpSearchQuery,
      agentsModalIndex,
      agentsSearchQuery,
    ],
  );

  return (
    <VisibilityCtx.Provider value={visibilityValue}>
      <NavCtx.Provider value={navValue}>{children}</NavCtx.Provider>
    </VisibilityCtx.Provider>
  );
}
