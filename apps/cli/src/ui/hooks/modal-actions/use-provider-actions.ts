import type { TextareaRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../../../agent/agent";
import { saveCredential } from "../../../core/persistence/credentials";
import {
  getHostServices as kernelGetHostServices,
  listPlugins as kernelListExtensions,
  type RegisteredSetting,
  subscribeToRegistry,
} from "../../../core/plugins";
import { getTelegramBotToken, saveUserSettings } from "../../../utils/settings";
import { useModalVisibility } from "../../context/modal-context.js";
import { useModel } from "../../context/model-context.js";
import { coerceSettingInput, nextSelectValue, type ProviderSettingRow } from "../../provider-settings-modal";

export function useProviderActions({
  agent,
  apiKeyInputRef,
  hasApiKeyRef,
  startTelegramBridge,
  setRegistryVersion,
}: {
  agent: Agent;
  apiKeyInputRef: RefObject<TextareaRenderable | null>;
  hasApiKeyRef: RefObject<boolean>;
  startTelegramBridge: () => void;
  setRegistryVersion: (fn: (version: number) => number) => void;
}) {
  const modal = useModalVisibility();
  const model = useModel();

  const {
    setExtensionsList,
    setShowApiKeyModal,
    setApiKeyError,
    showApiKeyModalRef,
    showProviderAuthModalRef,
    showProviderSettingsModalRef,
    showProviderSettingEditModalRef,
  } = modal;
  const { setHasApiKey } = model;

  const kernelServices = kernelGetHostServices();

  const [providerAuthState, setProviderAuthState] = useState<null | {
    adapterId: string;
    title: string;
    subtitle?: string;
    reason?: string;
    envVarHint?: string;
    onSuccess?: () => void;
  }>(null);
  const [providerAuthSyncKey, setProviderAuthSyncKey] = useState(0);
  const [providerAuthError, setProviderAuthError] = useState<string | null>(null);
  const providerAuthInputRef = useRef<TextareaRenderable>(null);

  const [providerSettingsState, setProviderSettingsState] = useState<null | {
    adapterId: string;
    title: string;
  }>(null);
  const [providerSettingsSearchQuery, setProviderSettingsSearchQuery] = useState("");
  const [providerSettingsIndex, setProviderSettingsIndex] = useState(0);
  const [providerSettingEditState, setProviderSettingEditState] = useState<null | RegisteredSetting>(null);
  const [providerSettingEditSyncKey, setProviderSettingEditSyncKey] = useState(0);
  const [providerSettingEditError, setProviderSettingEditError] = useState<string | null>(null);
  const providerSettingEditInputRef = useRef<TextareaRenderable>(null);

  // ── Provider auth / settings callbacks ─────────────────────────────────

  const closeProviderAuthModal = useCallback(() => {
    setProviderAuthState(null);
    setProviderAuthError(null);
  }, []);

  const openProviderAuthModal = useCallback(
    (config: {
      adapterId: string;
      title: string;
      subtitle?: string;
      reason?: string;
      envVarHint?: string;
      onSuccess?: () => void;
    }) => {
      setProviderAuthError(null);
      setProviderAuthState(config);
      setProviderAuthSyncKey((n) => n + 1);
    },
    [],
  );

  const submitProviderAuthModal = useCallback(() => {
    const state = providerAuthState;
    if (!state) return;
    const raw = providerAuthInputRef.current?.plainText ?? "";
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) {
      setProviderAuthError("Enter an API key.");
      return;
    }
    try {
      saveCredential(state.adapterId, { type: "api-key", value: key });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setProviderAuthError(`Failed to save credential: ${message}`);
      return;
    }
    const onSuccess = state.onSuccess;
    setProviderAuthState(null);
    setProviderAuthError(null);
    setExtensionsList(kernelListExtensions());
    if (onSuccess) onSuccess();
  }, [providerAuthState, setExtensionsList]);

  const maybePromptProviderAuth = useCallback(
    async (pluginId: string) => {
      const services = kernelGetHostServices();
      const providers = services.models.listProviders();
      const owned = providers.filter((p) => p.pluginId === pluginId && p.auth.mode === "api-key");
      if (owned.length === 0) return;
      for (const provider of owned) {
        const status = await Promise.resolve(
          provider.auth.check({
            conversationId: agent.getSessionId() ?? "ephemeral",
            adapterId: provider.id,
            providerId: provider.providerId,
            settings: services.settings,
          }),
        );
        if (status.ok) continue;
        if (status.needsUserAction !== "paste-api-key") continue;
        const envVarHint = (() => {
          const match = status.reason?.match(/([A-Z][A-Z0-9_]{3,})/);
          return match?.[1];
        })();
        openProviderAuthModal({
          adapterId: provider.id,
          title: provider.label,
          subtitle: provider.description,
          reason: status.reason,
          envVarHint,
        });
        return;
      }
    },
    [agent, openProviderAuthModal],
  );

  const openProviderSettingsModal = useCallback((adapterId: string, title: string) => {
    setProviderSettingEditState(null);
    setProviderSettingEditError(null);
    setProviderSettingsState({ adapterId, title });
    setProviderSettingsSearchQuery("");
    setProviderSettingsIndex(0);
  }, []);

  const closeProviderSettingsModal = useCallback(() => {
    setProviderSettingsState(null);
    setProviderSettingsSearchQuery("");
    setProviderSettingsIndex(0);
  }, []);

  const openProviderSettingEditModal = useCallback((setting: RegisteredSetting) => {
    setProviderSettingEditError(null);
    setProviderSettingEditState(setting);
    setProviderSettingEditSyncKey((n) => n + 1);
  }, []);

  const closeProviderSettingEditModal = useCallback(() => {
    setProviderSettingEditState(null);
    setProviderSettingEditError(null);
  }, []);

  const submitProviderSettingEditModal = useCallback(() => {
    const setting = providerSettingEditState;
    if (!setting) return;
    const raw = providerSettingEditInputRef.current?.plainText ?? "";
    try {
      const value = coerceSettingInput(setting, raw);
      kernelServices.settings.set(setting.key, value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProviderSettingEditError(message);
      return;
    }
    setProviderSettingEditState(null);
    setProviderSettingEditError(null);
  }, [kernelServices.settings, providerSettingEditState]);

  const applyProviderSettingRowAction = useCallback(
    (row: ProviderSettingRow, direction: 1 | -1 = 1) => {
      const { setting, value } = row;
      if (setting.type === "boolean") {
        kernelServices.settings.set(setting.key, value !== true);
        return;
      }
      if (setting.type === "select") {
        const next = nextSelectValue(setting, value, direction);
        if (next !== undefined) kernelServices.settings.set(setting.key, next);
        return;
      }
      openProviderSettingEditModal(setting);
    },
    [kernelServices.settings, openProviderSettingEditModal],
  );

  // ── API key callbacks ──────────────────────────────────────────────────

  const openApiKeyModal = useCallback(() => {
    showApiKeyModalRef.current = true;
    setApiKeyError(null);
    setShowApiKeyModal(true);
  }, [showApiKeyModalRef, setShowApiKeyModal, setApiKeyError]);

  const closeApiKeyModal = useCallback(() => {
    showApiKeyModalRef.current = false;
    setApiKeyError(null);
    setShowApiKeyModal(false);
  }, [setApiKeyError, setShowApiKeyModal, showApiKeyModalRef]);

  const submitApiKey = useCallback(() => {
    const apiKey = (apiKeyInputRef.current?.plainText || "").trim();
    if (!apiKey) {
      setApiKeyError("Enter an API key to continue.");
      return;
    }
    saveUserSettings({ apiKey });
    agent.setApiKey(apiKey);
    hasApiKeyRef.current = true;
    showApiKeyModalRef.current = false;
    setHasApiKey(true);
    setApiKeyError(null);
    setShowApiKeyModal(false);
    apiKeyInputRef.current?.clear();
    if (getTelegramBotToken()) {
      startTelegramBridge();
    }
  }, [
    agent,
    startTelegramBridge,
    apiKeyInputRef,
    hasApiKeyRef,
    showApiKeyModalRef,
    setShowApiKeyModal,
    setApiKeyError,
    setHasApiKey,
  ]);

  // ── Provider effects ───────────────────────────────────────────────────

  useEffect(() => {
    showProviderAuthModalRef.current = providerAuthState !== null;
  }, [providerAuthState, showProviderAuthModalRef]);

  useEffect(() => {
    showProviderSettingsModalRef.current = providerSettingsState !== null;
    if (providerSettingsState === null) {
      setProviderSettingsSearchQuery("");
      setProviderSettingsIndex(0);
    }
  }, [providerSettingsState, showProviderSettingsModalRef]);

  useEffect(() => {
    showProviderSettingEditModalRef.current = providerSettingEditState !== null;
  }, [providerSettingEditState, showProviderSettingEditModalRef]);

  useEffect(() => {
    if (!providerSettingsState) return;
    const unsubscribe = subscribeToRegistry(() => {
      setRegistryVersion((version) => version + 1);
    });
    return unsubscribe;
  }, [providerSettingsState, setRegistryVersion]);

  return {
    closeProviderAuthModal,
    openProviderAuthModal,
    submitProviderAuthModal,
    maybePromptProviderAuth,
    openProviderSettingsModal,
    closeProviderSettingsModal,
    openProviderSettingEditModal,
    closeProviderSettingEditModal,
    submitProviderSettingEditModal,
    applyProviderSettingRowAction,
    openApiKeyModal,
    closeApiKeyModal,
    submitApiKey,

    providerAuthState,
    providerAuthSyncKey,
    providerAuthError,
    providerAuthInputRef,
    providerSettingsState,
    providerSettingsSearchQuery,
    providerSettingsIndex,
    providerSettingEditState,
    providerSettingEditSyncKey,
    providerSettingEditError,
    providerSettingEditInputRef,

    setProviderSettingsIndex,
    setProviderSettingsSearchQuery,
  };
}
