import { createContext, type Dispatch, type SetStateAction, useContext } from "react";

export interface ModalNavCtx {
  claudeAgentModalIndex: number;
  setClaudeAgentModalIndex: Dispatch<SetStateAction<number>>;
  terminalModalIndex: number;
  setTerminalModalIndex: Dispatch<SetStateAction<number>>;
  commandPaletteIndex: number;
  setCommandPaletteIndex: Dispatch<SetStateAction<number>>;
  commandPaletteQuery: string;
  setCommandPaletteQuery: Dispatch<SetStateAction<string>>;
  slashSearchQuery: string;
  setSlashSearchQuery: Dispatch<SetStateAction<string>>;
  modelPickerIndex: number;
  setModelPickerIndex: Dispatch<SetStateAction<number>>;
  modelSearchQuery: string;
  setModelSearchQuery: Dispatch<SetStateAction<string>>;
  sandboxSettingsFocusIndex: number;
  setSandboxSettingsFocusIndex: Dispatch<SetStateAction<number>>;
  walletFocusIndex: number;
  setWalletFocusIndex: Dispatch<SetStateAction<number>>;
  scheduleModalIndex: number;
  setScheduleModalIndex: Dispatch<SetStateAction<number>>;
  scheduleSearchQuery: string;
  setScheduleSearchQuery: Dispatch<SetStateAction<string>>;
  extensionsModalIndex: number;
  setExtensionsModalIndex: Dispatch<SetStateAction<number>>;
  extensionsSearchQuery: string;
  setExtensionsSearchQuery: Dispatch<SetStateAction<string>>;
  flagsModalIndex: number;
  setFlagsModalIndex: Dispatch<SetStateAction<number>>;
  flagsSearchQuery: string;
  setFlagsSearchQuery: Dispatch<SetStateAction<string>>;
  sessionsModalIndex: number;
  setSessionsModalIndex: Dispatch<SetStateAction<number>>;
  sessionsSearchQuery: string;
  setSessionsSearchQuery: Dispatch<SetStateAction<string>>;
  connectModalIndex: number;
  setConnectModalIndex: Dispatch<SetStateAction<number>>;
  mcpModalIndex: number;
  setMcpModalIndex: Dispatch<SetStateAction<number>>;
  mcpSearchQuery: string;
  setMcpSearchQuery: Dispatch<SetStateAction<string>>;
  agentsModalIndex: number;
  setAgentsModalIndex: Dispatch<SetStateAction<number>>;
  agentsSearchQuery: string;
  setAgentsSearchQuery: Dispatch<SetStateAction<string>>;
}

export const NavCtx = createContext<ModalNavCtx | null>(null);

export function useModalNav(): ModalNavCtx {
  const ctx = useContext(NavCtx);
  if (!ctx) throw new Error("useModalNav must be used inside <ModalProvider>");
  return ctx;
}
