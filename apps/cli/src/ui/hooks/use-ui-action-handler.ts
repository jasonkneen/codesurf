import { useCallback } from "react";
import type { Agent } from "../../agent/agent";
import type { HostAction } from "../../core/plugins";
import type { UiMode } from "../../utils/settings";
import { runUpdate } from "../../utils/update-checker";
import type { ClaudeAgentGroup } from "../claude-agent-modal";
import { useBtw } from "../context/btw-context.js";
import { useModalVisibility } from "../context/modal-context.js";
import type { McpEditorDraft } from "../mcp-modal-types";
import { SANDBOX_SCREEN_ID } from "../screens/sandbox-screen";
import { WALLET_SCREEN_ID } from "../screens/wallet-screen";
import { spawnTerminalSession } from "../terminal/manager";

export interface UseUiActionHandlerParams {
  agent: Agent;
  version: string;

  openApiKeyModal: () => void;
  openSandboxPicker: () => void;
  openWalletPicker: () => void;
  openMcpEditor: (draft: McpEditorDraft, editingId: string | null) => void;
  openMcpModal: () => void;
  openAgentsModal: () => void;
  openScheduleModal: () => void;
  openExtensionsModal: () => void;
  openSessionsModal: () => void;
  openTerminalManager: (sessionId?: string) => void;
  openClaudeAgentModal: (focusGroup?: ClaudeAgentGroup) => void;
  openThemeModal: () => void;
  openFlagsModal: () => void;

  beginTelegramFromConnect: () => void;
  spawnInlineTerminal: (command: string) => void;
  resetToNewSession: () => void;
  setUiMode: (mode: UiMode) => void;
  toggleUiMode: () => void;
}

export function useUiActionHandler(params: UseUiActionHandlerParams): (action: HostAction) => void {
  const modal = useModalVisibility();
  const { setBtwStateSync, btwAbortRef } = useBtw();

  return useCallback(
    (action: HostAction) => {
      switch (action.type) {
        case "model":
          modal.setShowModelPicker(true);
          modal.setModelSearchQuery("");
          modal.setModelPickerIndex(0);
          break;
        case "api-key":
          params.openApiKeyModal();
          break;
        case "sandbox":
          params.openSandboxPicker();
          break;
        case "wallet":
          params.openWalletPicker();
          break;
        case "remote-control":
          modal.setConnectModalIndex(0);
          modal.setShowConnectModal(true);
          break;
        case "telegram":
          if (action.openTokenModal) {
            modal.setShowConnectModal(false);
            modal.setShowTelegramPairModal(false);
            modal.setTelegramPairError(null);
            modal.setTelegramTokenError(null);
            modal.setShowTelegramTokenModal(true);
          } else {
            params.beginTelegramFromConnect();
          }
          break;
        case "mcp":
          if (action.openEditor) {
            params.openMcpEditor(action.openEditor, action.editingId ?? null);
          } else {
            params.openMcpModal();
          }
          break;
        case "agents":
          params.openAgentsModal();
          break;
        case "schedule":
          params.openScheduleModal();
          break;
        case "extensions":
          params.openExtensionsModal();
          break;
        case "sessions":
          params.openSessionsModal();
          break;
        case "theme":
          params.openThemeModal();
          break;
        case "flags":
          params.openFlagsModal();
          break;
        case "showcase":
          modal.setShowShowcaseModal(true);
          break;
        case "update":
          modal.setIsUpdating(true);
          modal.setUpdateOutput(null);
          runUpdate(params.version).then((result) => {
            modal.setIsUpdating(false);
            modal.setUpdateOutput(result.success ? result.output : `Update failed: ${result.output}`);
          });
          break;
        case "terms":
          params.openTerminalManager();
          break;
        case "term":
          params.spawnInlineTerminal(action.command);
          break;
        case "term-modal":
          if (action.command) {
            const sessionId = spawnTerminalSession({ command: action.command });
            params.openTerminalManager(sessionId);
            break;
          }
          params.openTerminalManager();
          break;
        case "claude-agent":
          params.openClaudeAgentModal(action.focusGroup);
          break;
        case "btw": {
          setBtwStateSync({ status: "loading", question: action.question });
          btwAbortRef.current?.abort();
          const sideQuestionAbort = new AbortController();
          btwAbortRef.current = sideQuestionAbort;
          (async () => {
            try {
              const result = await params.agent.askSideQuestion(action.question, sideQuestionAbort.signal);
              if (btwAbortRef.current !== sideQuestionAbort || sideQuestionAbort.signal.aborted) return;
              setBtwStateSync({
                status: "done",
                question: action.question,
                answer: result.response,
              });
            } catch (error: unknown) {
              if (btwAbortRef.current !== sideQuestionAbort || sideQuestionAbort.signal.aborted) return;
              const message = error instanceof Error ? error.message : String(error);
              setBtwStateSync({
                status: "error",
                question: action.question,
                error: `Failed to answer side question: ${message}`,
              });
            }
          })();
          break;
        }
        case "clear":
          params.resetToNewSession();
          break;
        case "quit":
          modal.setShowQuitConfirm(true);
          break;
        case "set-ui-mode":
          params.setUiMode(action.mode);
          break;
        case "toggle-ui-mode":
          params.toggleUiMode();
          break;
        case "open-screen":
          if (action.id === WALLET_SCREEN_ID) {
            params.openWalletPicker();
          } else if (action.id === SANDBOX_SCREEN_ID) {
            params.openSandboxPicker();
          } else {
            modal.setDynamicScreens((prev) => {
              const next = new Map(prev);
              next.set(action.id, action.props);
              return next;
            });
          }
          break;
        case "close-screen":
          if (action.id === WALLET_SCREEN_ID) {
            modal.setShowWalletPicker(false);
          } else if (action.id === SANDBOX_SCREEN_ID) {
            modal.setShowSandboxPicker(false);
          }
          modal.setDynamicScreens((prev) => {
            if (!prev.has(action.id)) return prev;
            const next = new Map(prev);
            next.delete(action.id);
            return next;
          });
          break;
        default: {
          const _exhaustive: never = action;
          void _exhaustive;
        }
      }
    },
    [
      params.agent.askSideQuestion,
      params.version,
      params.openApiKeyModal,
      params.openSandboxPicker,
      params.openWalletPicker,
      params.openMcpEditor,
      params.openMcpModal,
      params.openAgentsModal,
      params.openScheduleModal,
      params.openExtensionsModal,
      params.openSessionsModal,
      params.openTerminalManager,
      params.openClaudeAgentModal,
      params.openThemeModal,
      params.openFlagsModal,
      modal.setShowModelPicker,
      modal.setModelSearchQuery,
      modal.setModelPickerIndex,
      modal.setShowConnectModal,
      modal.setConnectModalIndex,
      modal.setShowTelegramTokenModal,
      modal.setShowTelegramPairModal,
      modal.setTelegramTokenError,
      modal.setTelegramPairError,
      modal.setShowShowcaseModal,
      modal.setShowQuitConfirm,
      modal.setIsUpdating,
      modal.setUpdateOutput,
      modal.setShowWalletPicker,
      modal.setShowSandboxPicker,
      modal.setDynamicScreens,
      params.beginTelegramFromConnect,
      params.spawnInlineTerminal,
      params.resetToNewSession,
      params.setUiMode,
      params.toggleUiMode,
      setBtwStateSync,
      btwAbortRef,
    ],
  );
}
