import { createContext, type Dispatch, type RefObject, type SetStateAction, useContext } from "react";
import type { PluginListEntry } from "../../core/plugins";
import type { StoredSchedule } from "../../tools/schedule";
import type { SessionInfo } from "../../types/index";
import type { McpServerConfig } from "../../utils/settings";
import type { UpdateCheckResult } from "../../utils/update-checker";

export interface ModalVisibilityCtx {
  showClaudeAgentModal: boolean;
  setShowClaudeAgentModal: Dispatch<SetStateAction<boolean>>;
  showClaudeAgentModalRef: RefObject<boolean>;
  claudeAgentModalIndexRef: RefObject<number>;
  setClaudeAgentModalIndex: Dispatch<SetStateAction<number>>;

  showTerminalModal: boolean;
  setShowTerminalModal: Dispatch<SetStateAction<boolean>>;
  showTerminalModalRef: RefObject<boolean>;
  terminalInputMode: boolean;
  setTerminalInputMode: Dispatch<SetStateAction<boolean>>;
  terminalInputModeRef: RefObject<boolean>;
  terminalModalIndexRef: RefObject<number>;
  setTerminalModalIndex: Dispatch<SetStateAction<number>>;

  showShowcaseModal: boolean;
  setShowShowcaseModal: Dispatch<SetStateAction<boolean>>;
  showShowcaseModalRef: RefObject<boolean>;

  showCommandPalette: boolean;
  setShowCommandPalette: Dispatch<SetStateAction<boolean>>;
  showCommandPaletteRef: RefObject<boolean>;
  commandPaletteIndexRef: RefObject<number>;
  setCommandPaletteIndex: Dispatch<SetStateAction<number>>;
  commandPaletteQueryRef: RefObject<string>;
  setCommandPaletteQuery: Dispatch<SetStateAction<string>>;

  showApiKeyModal: boolean;
  setShowApiKeyModal: Dispatch<SetStateAction<boolean>>;
  apiKeyError: string | null;
  setApiKeyError: Dispatch<SetStateAction<string | null>>;
  showApiKeyModalRef: RefObject<boolean>;

  showSlashMenu: boolean;
  setShowSlashMenu: Dispatch<SetStateAction<boolean>>;
  slashSearchQueryRef: RefObject<string>;
  setSlashSearchQuery: Dispatch<SetStateAction<string>>;

  showModelPicker: boolean;
  setShowModelPicker: Dispatch<SetStateAction<boolean>>;
  expandedModelGroups: Set<string>;
  setExpandedModelGroups: Dispatch<SetStateAction<Set<string>>>;
  modelPickerIndexRef: RefObject<number>;
  setModelPickerIndex: Dispatch<SetStateAction<number>>;
  modelSearchQueryRef: RefObject<string>;
  setModelSearchQuery: Dispatch<SetStateAction<string>>;

  showSandboxPicker: boolean;
  setShowSandboxPicker: Dispatch<SetStateAction<boolean>>;
  sandboxSettingsEditing: string | null;
  setSandboxSettingsEditing: Dispatch<SetStateAction<string | null>>;
  sandboxSettingsEditBuffer: string;
  setSandboxSettingsEditBuffer: Dispatch<SetStateAction<string>>;
  sandboxSettingsFocusIndexRef: RefObject<number>;
  setSandboxSettingsFocusIndex: Dispatch<SetStateAction<number>>;

  showRecapPicker: boolean;
  setShowRecapPicker: Dispatch<SetStateAction<boolean>>;

  showWalletPicker: boolean;
  setShowWalletPicker: Dispatch<SetStateAction<boolean>>;
  walletFocusIndexRef: RefObject<number>;
  setWalletFocusIndex: Dispatch<SetStateAction<number>>;

  showQuitConfirm: boolean;
  setShowQuitConfirm: Dispatch<SetStateAction<boolean>>;
  showQuitConfirmRef: RefObject<boolean>;

  showScheduleModal: boolean;
  setShowScheduleModal: Dispatch<SetStateAction<boolean>>;
  showScheduleModalRef: RefObject<boolean>;
  schedules: StoredSchedule[];
  setSchedules: Dispatch<SetStateAction<StoredSchedule[]>>;
  scheduleModalIndexRef: RefObject<number>;
  setScheduleModalIndex: Dispatch<SetStateAction<number>>;
  scheduleSearchQueryRef: RefObject<string>;
  setScheduleSearchQuery: Dispatch<SetStateAction<string>>;

  showExtensionsModal: boolean;
  setShowExtensionsModal: Dispatch<SetStateAction<boolean>>;
  showExtensionsModalRef: RefObject<boolean>;
  extensionsList: PluginListEntry[];
  setExtensionsList: Dispatch<SetStateAction<PluginListEntry[]>>;
  expandedExtensionGroups: Set<string>;
  setExpandedExtensionGroups: Dispatch<SetStateAction<Set<string>>>;
  extensionsModalIndexRef: RefObject<number>;
  setExtensionsModalIndex: Dispatch<SetStateAction<number>>;
  extensionsSearchQueryRef: RefObject<string>;
  setExtensionsSearchQuery: Dispatch<SetStateAction<string>>;

  showFlagsModal: boolean;
  setShowFlagsModal: Dispatch<SetStateAction<boolean>>;
  flagsTick: number;
  setFlagsTick: Dispatch<SetStateAction<number>>;
  showFlagsModalRef: RefObject<boolean>;
  flagsModalIndexRef: RefObject<number>;
  setFlagsModalIndex: Dispatch<SetStateAction<number>>;
  flagsSearchQueryRef: RefObject<string>;
  setFlagsSearchQuery: Dispatch<SetStateAction<string>>;

  showSessionsModal: boolean;
  setShowSessionsModal: Dispatch<SetStateAction<boolean>>;
  showSessionsModalRef: RefObject<boolean>;
  sessionsList: SessionInfo[];
  setSessionsList: Dispatch<SetStateAction<SessionInfo[]>>;
  sessionsModalIndexRef: RefObject<number>;
  setSessionsModalIndex: Dispatch<SetStateAction<number>>;
  sessionsSearchQueryRef: RefObject<string>;
  setSessionsSearchQuery: Dispatch<SetStateAction<string>>;

  showUpdateModal: boolean;
  setShowUpdateModal: Dispatch<SetStateAction<boolean>>;
  showUpdateModalRef: RefObject<boolean>;
  updateInfo: UpdateCheckResult | null;
  setUpdateInfo: Dispatch<SetStateAction<UpdateCheckResult | null>>;
  isUpdating: boolean;
  setIsUpdating: Dispatch<SetStateAction<boolean>>;
  updateOutput: string | null;
  setUpdateOutput: Dispatch<SetStateAction<string | null>>;

  showConnectModal: boolean;
  setShowConnectModal: Dispatch<SetStateAction<boolean>>;
  showConnectModalRef: RefObject<boolean>;
  connectModalIndexRef: RefObject<number>;
  setConnectModalIndex: Dispatch<SetStateAction<number>>;

  showTelegramTokenModal: boolean;
  setShowTelegramTokenModal: Dispatch<SetStateAction<boolean>>;
  telegramTokenError: string | null;
  setTelegramTokenError: Dispatch<SetStateAction<string | null>>;
  showTelegramTokenModalRef: RefObject<boolean>;

  showTelegramPairModal: boolean;
  setShowTelegramPairModal: Dispatch<SetStateAction<boolean>>;
  telegramPairError: string | null;
  setTelegramPairError: Dispatch<SetStateAction<string | null>>;
  showTelegramPairModalRef: RefObject<boolean>;

  showMcpModal: boolean;
  setShowMcpModal: Dispatch<SetStateAction<boolean>>;
  showMcpEditor: boolean;
  setShowMcpEditor: Dispatch<SetStateAction<boolean>>;
  mcpServers: McpServerConfig[];
  setMcpServers: Dispatch<SetStateAction<McpServerConfig[]>>;
  showMcpModalRef: RefObject<boolean>;
  showMcpEditorRef: RefObject<boolean>;
  mcpModalIndexRef: RefObject<number>;
  setMcpModalIndex: Dispatch<SetStateAction<number>>;
  mcpSearchQueryRef: RefObject<string>;
  setMcpSearchQuery: Dispatch<SetStateAction<string>>;

  showAgentsModal: boolean;
  setShowAgentsModal: Dispatch<SetStateAction<boolean>>;
  showAgentsEditor: boolean;
  setShowAgentsEditor: Dispatch<SetStateAction<boolean>>;
  showAgentsModalRef: RefObject<boolean>;
  showAgentsEditorRef: RefObject<boolean>;
  agentsModalIndexRef: RefObject<number>;
  setAgentsModalIndex: Dispatch<SetStateAction<number>>;
  agentsSearchQueryRef: RefObject<string>;
  setAgentsSearchQuery: Dispatch<SetStateAction<string>>;

  dynamicScreens: Map<string, unknown>;
  setDynamicScreens: Dispatch<SetStateAction<Map<string, unknown>>>;

  showProviderAuthModalRef: RefObject<boolean>;
  showProviderSettingsModalRef: RefObject<boolean>;
  showProviderSettingEditModalRef: RefObject<boolean>;
}

export const VisibilityCtx = createContext<ModalVisibilityCtx | null>(null);

export function useModalVisibility(): ModalVisibilityCtx {
  const ctx = useContext(VisibilityCtx);
  if (!ctx) throw new Error("useModalVisibility must be used inside <ModalProvider>");
  return ctx;
}
