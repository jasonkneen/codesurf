import { useCallback } from "react";
import type { Agent } from "../../../agent/agent";
import {
  loadPaymentSettings,
  type PaymentSettings,
  type SandboxMode,
  type SandboxSettings,
  savePaymentSettings,
  saveProjectSettings,
  saveRecapsEnabled,
  saveUserSettings,
} from "../../../utils/settings";
import { useConversationState } from "../../context/conversation-state-context.js";
import { useModalVisibility } from "../../context/modal-context.js";
import { useModel } from "../../context/model-context.js";
import { useTelegram } from "../../context/telegram-context.js";

export function useSandboxWalletActions({ agent }: { agent: Agent }) {
  const modal = useModalVisibility();
  const model = useModel();
  const conv = useConversationState();
  const telegram = useTelegram();

  const {
    setShowSandboxPicker,
    setSandboxSettingsFocusIndex,
    setSandboxSettingsEditing,
    setSandboxSettingsEditBuffer,
    setShowRecapPicker,
    setShowWalletPicker,
    setWalletFocusIndex,
  } = modal;
  const {
    setSandboxModeState,
    setSandboxSettingsState,
    setRecapsEnabledState,
    setWalletSettings,
    setWalletDisplayInfo,
  } = model;
  const { setSessionRecap, setMessages } = conv;
  const { telegramAgentsRef } = telegram;

  // Settings writes throw on a malformed existing file. The user-level write
  // goes first so the choice survives a broken project file, and each failure
  // is surfaced in the transcript instead of throwing out of the handler.
  const reportSettingsError = useCallback(
    (scope: "user" | "project", err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        {
          type: "assistant",
          content: `Sandbox setting applied, but ${scope} settings could not be saved: ${message}`,
          timestamp: new Date(),
        },
      ]);
    },
    [setMessages],
  );
  const saveSandboxSettings = useCallback(
    (patch: Parameters<typeof saveProjectSettings>[0] & Parameters<typeof saveUserSettings>[0]) => {
      try {
        saveUserSettings(patch);
      } catch (err: unknown) {
        reportSettingsError("user", err);
      }
      try {
        saveProjectSettings(patch);
      } catch (err: unknown) {
        reportSettingsError("project", err);
      }
    },
    [reportSettingsError],
  );

  const applySandboxMode = useCallback(
    (next: SandboxMode) => {
      agent.setSandboxMode(next);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setSandboxMode(next);
      }
      setSandboxModeState(next);
      saveSandboxSettings({ sandboxMode: next });
    },
    [agent, setSandboxModeState, telegramAgentsRef.current.values, saveSandboxSettings],
  );

  const applySandboxSettings = useCallback(
    (next: SandboxSettings) => {
      agent.setSandboxSettings(next);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setSandboxSettings(next);
      }
      setSandboxSettingsState(next);
      saveSandboxSettings({ sandbox: next });
    },
    [agent, setSandboxSettingsState, telegramAgentsRef.current.values, saveSandboxSettings],
  );

  const openSandboxPicker = useCallback(() => {
    setSandboxSettingsFocusIndex(0);
    setSandboxSettingsEditing(null);
    setSandboxSettingsEditBuffer("");
    setShowSandboxPicker(true);
  }, [setSandboxSettingsEditing, setSandboxSettingsFocusIndex, setShowSandboxPicker, setSandboxSettingsEditBuffer]);

  const applyRecapsEnabled = useCallback(
    (enabled: boolean) => {
      agent.setRecapsEnabled(enabled);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setRecapsEnabled(enabled);
      }
      setRecapsEnabledState(enabled);
      saveRecapsEnabled(enabled);
      setSessionRecap(agent.getSessionRecap());
    },
    [agent, setRecapsEnabledState, setSessionRecap, telegramAgentsRef.current.values],
  );

  const openRecapPicker = useCallback(() => {
    setShowRecapPicker(true);
  }, [setShowRecapPicker]);

  const applyWalletSettings = useCallback(
    (next: Required<PaymentSettings>) => {
      setWalletSettings(next);
      savePaymentSettings(next);
    },
    [setWalletSettings],
  );

  const openWalletPicker = useCallback(() => {
    setWalletFocusIndex(0);
    setWalletSettings(loadPaymentSettings());
    setShowWalletPicker(true);
    setWalletDisplayInfo({
      address: null,
      ethBalance: null,
      usdcBalance: null,
    });
    import("../../../wallet/manager")
      .then(async ({ WalletManager }) => {
        if (!WalletManager.exists()) {
          setWalletDisplayInfo({
            address: null,
            ethBalance: null,
            usdcBalance: null,
          });
          return;
        }
        const wm = new WalletManager();
        const data = wm.getWalletData();
        setWalletDisplayInfo({
          address: data.address,
          ethBalance: null,
          usdcBalance: null,
        });
        const balance = await wm.getBalance();
        setWalletDisplayInfo({
          address: balance.address,
          ethBalance: balance.nativeBalance,
          usdcBalance: balance.usdcBalance,
        });
      })
      .catch(() => {});
  }, [setWalletFocusIndex, setShowWalletPicker, setWalletSettings, setWalletDisplayInfo]);

  return {
    applySandboxMode,
    applySandboxSettings,
    openSandboxPicker,
    applyRecapsEnabled,
    openRecapPicker,
    applyWalletSettings,
    openWalletPicker,
  };
}
