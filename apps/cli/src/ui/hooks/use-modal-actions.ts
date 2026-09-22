import type { TextareaRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { useState } from "react";
import type { Agent } from "../../agent/agent";
import type { AppStartupConfig } from "../app-helpers";
import type { TerminalSessionSnapshot } from "../terminal/manager";
import { useAgentActions } from "./modal-actions/use-agent-actions.js";
import { type McpDrillState, useMcpActions } from "./modal-actions/use-mcp-actions.js";
import { useModelActions } from "./modal-actions/use-model-actions.js";
import { useProviderActions } from "./modal-actions/use-provider-actions.js";
import { useSandboxWalletActions } from "./modal-actions/use-sandbox-wallet-actions.js";
import { useTelegramMiscActions } from "./modal-actions/use-telegram-misc-actions.js";

export type { McpDrillState };

export interface UseModalActionsParams {
  agent: Agent;
  startupConfig: AppStartupConfig;
  onExit?: () => void;

  // API key refs (local to app.tsx)
  apiKeyInputRef: RefObject<TextareaRenderable | null>;
  hasApiKeyRef: RefObject<boolean>;

  // Terminal
  terminalSessions: readonly TerminalSessionSnapshot[];

  // Functions from app.tsx that the hook needs
  startTelegramBridge: () => boolean;
}

export function useModalActions(params: UseModalActionsParams) {
  const { agent, startupConfig, onExit } = params;
  const [, setRegistryVersion] = useState(0);

  const mcp = useMcpActions();
  const sandbox = useSandboxWalletActions({ agent });
  const providers = useProviderActions({
    agent,
    apiKeyInputRef: params.apiKeyInputRef,
    hasApiKeyRef: params.hasApiKeyRef,
    startTelegramBridge: params.startTelegramBridge,
    setRegistryVersion,
  });
  const model = useModelActions({
    agent,
    setRegistryVersion,
    openProviderAuthModal: providers.openProviderAuthModal,
  });
  const agents = useAgentActions();
  const misc = useTelegramMiscActions({
    agent,
    startupConfig,
    onExit,
    terminalSessions: params.terminalSessions,
    startTelegramBridge: params.startTelegramBridge,
    openRecapPicker: sandbox.openRecapPicker,
  });

  return {
    ...mcp,
    ...sandbox,
    ...model,
    ...agents,
    ...providers,
    ...misc,
  };
}
