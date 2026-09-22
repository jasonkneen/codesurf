import type { KeyEvent } from "@opentui/core";
import { CONNECT_CHANNELS } from "../../app-helpers.js";
import { useBtw } from "../../context/btw-context.js";
import { useModal } from "../../context/modal-context.js";
import { useRunningAgents } from "../../context/running-agents-context.js";
import type { useModalActions } from "../../hooks/use-modal-actions.js";
import { isEscapeKey } from "./shared.js";

interface SimpleModalKeysParams {
  onExit: () => void;
  modalActions: ReturnType<typeof useModalActions>;
  submitTelegramPair: () => Promise<void>;
}

export function useSimpleModalKeys({ onExit, modalActions, submitTelegramPair }: SimpleModalKeysParams) {
  const modal = useModal();
  const { btwStateRef, dismissBtw } = useBtw();
  const {
    showAgentsPopup,
    setShowAgentsPopup,
    setAgentsPopupIndex,
    agentsPopupIndexRef,
    runningAgentRowsRef,
    agentModalId,
  } = useRunningAgents();

  return (key: KeyEvent): boolean => {
    // ── Quit confirmation ──
    if (modal.showQuitConfirm) {
      if (key.name === "return" || key.name === "y") {
        onExit();
        return true;
      }
      if (isEscapeKey(key) || key.name === "n") {
        modal.setShowQuitConfirm(false);
        return true;
      }
      return true;
    }

    // BTW overlay: esc/return dismisses
    if (btwStateRef.current) {
      if (isEscapeKey(key) || key.name === "return") {
        dismissBtw();
      }
      return true;
    }

    // ── Running-subagents drill-down modal ──
    if (agentModalId !== null) {
      if (isEscapeKey(key)) modalActions.closeAgentModal();
      key.preventDefault?.();
      key.stopPropagation?.();
      return true;
    }

    // ── Running-subagents popup ──
    if (showAgentsPopup) {
      const count = runningAgentRowsRef.current.length;
      if (isEscapeKey(key)) {
        setShowAgentsPopup(false);
      } else if (key.name === "up") {
        setAgentsPopupIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down") {
        setAgentsPopupIndex((i) => Math.min(Math.max(0, count - 1), i + 1));
      } else if (key.name === "return") {
        modalActions.openAgentModalAtIndex(agentsPopupIndexRef.current);
      }
      key.preventDefault?.();
      key.stopPropagation?.();
      return true;
    }

    // ── Showcase modal (esc-only; scrollbox handles up/down) ──
    if (modal.showShowcaseModalRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowShowcaseModal(false);
        return true;
      }
      return true;
    }

    // ── Provider auth modal ──
    if (modalActions.providerAuthState !== null) {
      if (isEscapeKey(key)) {
        modalActions.closeProviderAuthModal();
        return true;
      }
      if (key.name === "return") {
        modalActions.submitProviderAuthModal();
        return true;
      }
      return true;
    }

    // ── Provider setting edit modal ──
    if (modalActions.providerSettingEditState !== null) {
      if (isEscapeKey(key)) {
        modalActions.closeProviderSettingEditModal();
        return true;
      }
      if (key.name === "return") {
        modalActions.submitProviderSettingEditModal();
        return true;
      }
      return true;
    }

    // ── Telegram token modal ──
    if (modal.showTelegramTokenModalRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowTelegramTokenModal(false);
        modal.setTelegramTokenError(null);
        return true;
      }
      if (key.name === "return") {
        modalActions.submitTelegramToken();
      }
      return true;
    }

    // ── Telegram pair modal ──
    if (modal.showTelegramPairModalRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowTelegramPairModal(false);
        modal.setTelegramPairError(null);
        return true;
      }
      if (key.name === "return") {
        void submitTelegramPair();
      }
      return true;
    }

    // ── Connect modal ──
    if (modal.showConnectModalRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowConnectModal(false);
        return true;
      }
      if (key.name === "up") {
        modal.setConnectModalIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setConnectModalIndex((i) => Math.min(CONNECT_CHANNELS.length - 1, i + 1));
        return true;
      }
      if (key.name === "return") {
        const ch = CONNECT_CHANNELS[modal.connectModalIndex];
        if (ch?.id === "telegram") modalActions.beginTelegramFromConnect();
        return true;
      }
      return true;
    }

    // ── API key modal ──
    if (modal.showApiKeyModalRef.current) {
      if (isEscapeKey(key)) {
        modalActions.closeApiKeyModal();
        return true;
      }
      if (key.name === "return") {
        modalActions.submitApiKey();
      }
      return true;
    }

    // ── Update modal ──
    if (modal.showUpdateModalRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowUpdateModal(false);
        return true;
      }
      if (key.name === "return") {
        modalActions.handleRunUpdate();
        return true;
      }
      return true;
    }

    return false;
  };
}
