import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { listPlugins as kernelListExtensions, subscribeToRegistry } from "../../core/plugins";
import { checkForUpdate } from "../../utils/update-checker";
import { setInlineImageSuppressed } from "../ai-output/inline-image";
import { useApproval } from "../context/approval-context.js";
import { useBtw } from "../context/btw-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModalVisibility } from "../context/modal-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";
import { useTheme } from "../context/theme-context.js";
import { FEATURE_FLAGS, subscribeFeatureFlag } from "../feature-flags";

export interface ModalGuardState {
  blockPrompt: boolean;
  captureOpen: boolean;
  /** A modal/overlay that sits above the inline approval + questionnaire
   *  cards is open. Those cards must not act on keys while this is true. */
  modalOpen: boolean;
  isCaptureOpenRef: React.RefObject<boolean>;
  dynamicScreenOpenRef: React.RefObject<boolean>;
  modalScrimOpen: boolean;
  showPlanPanel: boolean;
  showSlashMenu: boolean;
  showModelPicker: boolean;
  showQuitConfirm: boolean;
  showThemeModal: boolean;
  showSandboxPicker: boolean;
  showWalletPicker: boolean;
  setRegistryVersion: Dispatch<SetStateAction<number>>;
}

export function useModalGuardState(
  startupConfigVersion: string,
  providerAuthState: unknown,
  providerSettingsState: unknown,
  providerSettingEditState: unknown,
): ModalGuardState {
  const modal = useModalVisibility();
  const theme = useTheme();
  const { pendingPaymentApproval, pendingToolApproval, pendingEditApproval } = useApproval();
  const { btwState } = useBtw();
  const { activePlan, pendingQuestionnaire } = useConversationState();
  const { agentsFooterFocused, showAgentsPopup, agentModalId } = useRunningAgents();
  const [, setRegistryVersion] = useState(0);

  const blockPrompt =
    modal.showConnectModal ||
    modal.showTelegramTokenModal ||
    modal.showTelegramPairModal ||
    modal.showMcpModal ||
    modal.showSandboxPicker ||
    modal.showRecapPicker ||
    modal.showWalletPicker ||
    modal.showScheduleModal ||
    modal.showAgentsModal ||
    modal.showAgentsEditor ||
    modal.showExtensionsModal ||
    modal.showSessionsModal ||
    theme.showThemeModal ||
    modal.showClaudeAgentModal ||
    modal.showTerminalModal ||
    modal.showShowcaseModal ||
    modal.showCommandPalette ||
    modal.dynamicScreens.size > 0 ||
    providerAuthState !== null ||
    providerSettingsState !== null ||
    providerSettingEditState !== null ||
    modal.showUpdateModal;

  const showPlanPanel = !!activePlan?.questions?.length;
  const inlinePromptCaptureOpen =
    !!pendingPaymentApproval || !!pendingToolApproval || !!pendingEditApproval || !!pendingQuestionnaire;

  // NOTE: agentsFooterFocused is intentionally NOT part of captureOpen.
  // Footer Esc/↑/↓ live in useComposerKeys; if captureOpen includes the
  // footer, app.tsx early-returns before those handlers run and the user
  // gets stuck with a blurred textarea. Scrim already excludes the footer.
  const modalOpen =
    blockPrompt ||
    modal.showSlashMenu ||
    modal.showModelPicker ||
    modal.showApiKeyModal ||
    modal.terminalInputMode ||
    !!btwState ||
    modal.showQuitConfirm ||
    showAgentsPopup ||
    agentModalId !== null ||
    modal.showMcpEditor ||
    modal.showFlagsModal;
  const captureOpen = modalOpen || inlinePromptCaptureOpen || showPlanPanel;

  const isCaptureOpenRef = useRef(false);
  isCaptureOpenRef.current = captureOpen;

  const dynamicScreenOpenRef = useRef(false);
  dynamicScreenOpenRef.current = modal.dynamicScreens.size > 0;

  const modalScrimOpen =
    captureOpen &&
    !inlinePromptCaptureOpen &&
    !modal.showSlashMenu &&
    !showPlanPanel &&
    !agentsFooterFocused &&
    modal.dynamicScreens.size === 0;

  useEffect(() => {
    setInlineImageSuppressed(modalScrimOpen || modal.dynamicScreens.size > 0);
    return () => setInlineImageSuppressed(false);
  }, [modalScrimOpen, modal.dynamicScreens.size]);

  useEffect(() => {
    const unsubs = FEATURE_FLAGS.map((flag) => subscribeFeatureFlag(flag.id, () => modal.setFlagsTick((n) => n + 1)));
    return () => {
      for (const u of unsubs) u();
    };
  }, [modal.setFlagsTick]);

  useEffect(() => {
    if (!modal.showTerminalModal && modal.terminalInputModeRef.current) {
      modal.terminalInputModeRef.current = false;
      modal.setTerminalInputMode(false);
    }
  }, [modal.showTerminalModal, modal.terminalInputModeRef, modal.setTerminalInputMode]);

  useEffect(() => {
    if (!modal.showCommandPalette) {
      modal.setCommandPaletteQuery("");
      modal.setCommandPaletteIndex(0);
    }
  }, [modal.showCommandPalette, modal.setCommandPaletteIndex, modal.setCommandPaletteQuery]);

  useEffect(() => {
    if (!modal.showModelPicker) return;
    return subscribeToRegistry(() => setRegistryVersion((v) => v + 1));
  }, [modal.showModelPicker]);

  useEffect(() => {
    if (!modal.showExtensionsModal) return;
    modal.setExtensionsList(kernelListExtensions());
    return subscribeToRegistry(() => modal.setExtensionsList(kernelListExtensions()));
  }, [modal.showExtensionsModal, modal.setExtensionsList]);

  useEffect(() => {
    let cancelled = false;
    checkForUpdate(startupConfigVersion).then((result) => {
      if (cancelled || !result?.hasUpdate) return;
      modal.setUpdateInfo(result);
      modal.setShowUpdateModal(true);
    });
    return () => {
      cancelled = true;
    };
  }, [startupConfigVersion, modal.setShowUpdateModal, modal.setUpdateInfo]);

  return {
    blockPrompt,
    captureOpen,
    modalOpen,
    isCaptureOpenRef,
    dynamicScreenOpenRef,
    modalScrimOpen,
    showPlanPanel,
    showSlashMenu: modal.showSlashMenu,
    showModelPicker: modal.showModelPicker,
    showQuitConfirm: modal.showQuitConfirm,
    showThemeModal: theme.showThemeModal,
    showSandboxPicker: modal.showSandboxPicker,
    showWalletPicker: modal.showWalletPicker,
    setRegistryVersion,
  };
}
