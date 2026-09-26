import type { Agent } from "../../agent/agent";
import { getHostServices as kernelGetHostServices } from "../../core/plugins";
import { refreshDynamicModelListings } from "../../core/plugins/native/host";
import { permissionModeKeyForAdapter } from "../../core/plugins/permission-mode";
import { getModelInfo } from "../../grok/models";
import { MODES } from "../../types/index";
import { useEffect, useState } from "react";
import { useModalVisibility } from "../context/modal-visibility-context.js";
import { preferredAdapterIdForModel, useModel } from "../context/model-context.js";
import type { ProviderMeta } from "../model-picker-rows.js";
import type { ProviderSettingRow } from "../provider-settings-modal.js";
import { getStreamContent } from "../stream-store.js";

export interface ModelPickerData {
  modeInfo: NonNullable<ReturnType<typeof MODES.find>>;
  modelInfo: ReturnType<typeof getModelInfo>;
  contextWindow: number;
  contextStats: ReturnType<Agent["getContextBreakdown"]>;
  kernelModels: ReturnType<ReturnType<typeof kernelGetHostServices>["models"]["list"]>;
  uniqueLogicalProviders: ProviderMeta[];
  kernelAdapterMeta: Array<{
    id: string;
    label: string;
    transport?: string;
    connectionMode?: string;
    sessionStrategy?: string;
    authMode: string;
  }>;
  activeModelAdapterId: string | null;
  credentialsByAdapter: Record<string, boolean>;
  activeModelCredentialsReady: boolean;
  activeModelCanRun: boolean;
  modelPickerReasoningEffortControls: Array<{
    adapterId: string;
    settingKey: string;
    values: readonly string[];
    currentValue?: string;
    defaultValue?: string;
  }>;
  providerSettingsRows: ProviderSettingRow[];
  footerPermissionMode: string | null;
}

export function useModelPickerData(
  agent: Agent,
  hasApiKey: boolean,
  providerSettingsState: { adapterId: string; title: string } | null,
  providerSettingsSearchQuery: string,
): ModelPickerData {
  const {
    model,
    modelAdapterId,
    mode,
    permissionModeSnapshot,
    modeInfoRef,
    contextStatsRef,
    contextBreakdownRef,
    activeModelAdapterIdRef,
  } = useModel();

  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  modeInfoRef.current = modeInfo;
  const modelInfo = getModelInfo(model);
  const contextWindow = modelInfo?.contextWindow ?? kernelGetHostServices().models.get(model)?.contextWindow ?? 200_000;
  const contextStats = agent.getContextBreakdown(contextWindow, getStreamContent());
  contextStatsRef.current = contextStats;
  contextBreakdownRef.current = contextStats;

  // Opening the picker re-lists dynamic providers (daemon catalog, codex…) so
  // new releases show up without a restart; re-render once they land.
  const { showModelPicker } = useModalVisibility();
  const [, setListingsVersion] = useState(0);
  useEffect(() => {
    if (!showModelPicker) return;
    let live = true;
    void refreshDynamicModelListings().then(() => {
      if (live) setListingsVersion((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [showModelPicker]);

  const kernelServices = kernelGetHostServices();
  const kernelModels = kernelServices.models.list();
  const kernelProviders = kernelServices.models.listProviders();

  const uniqueLogicalProviders: ProviderMeta[] = (() => {
    const byProvider = new Map<string, string[]>();
    for (const provider of kernelProviders) {
      const list = byProvider.get(provider.providerId) ?? [];
      list.push(provider.label);
      byProvider.set(provider.providerId, list);
    }
    const result: ProviderMeta[] = [];
    for (const [providerId, labels] of byProvider) {
      if (labels.length === 1) {
        result.push({ id: providerId, label: labels[0]! });
      } else {
        const pretty = providerId
          .split(/[-_.]/)
          .map((p) => (p ? p[0]?.toUpperCase() + p.slice(1) : ""))
          .join(" ");
        result.push({ id: providerId, label: pretty });
      }
    }
    return result;
  })();

  const kernelAdapterMeta = kernelProviders.map((p) => ({
    id: p.id,
    label: p.label,
    transport: p.transport,
    connectionMode: p.connectionMode,
    sessionStrategy: p.sessionStrategy,
    authMode: p.auth.mode,
  }));

  const activeModelAdapterId = modelAdapterId ?? preferredAdapterIdForModel(model, kernelModels, kernelProviders);
  activeModelAdapterIdRef.current = activeModelAdapterId ?? null;

  // Any adapter that registered a `*.permissionMode` setting surfaces it in
  // the footer. API-only providers (xAI HTTP, Anthropic messages, …) leave
  // this null so the agent-mode chip stays the primary status.
  const footerPermissionMode = (() => {
    if (!activeModelAdapterId) return null;
    const key = permissionModeKeyForAdapter(activeModelAdapterId);
    const fromMap = permissionModeSnapshot.byKey?.[key];
    if (typeof fromMap === "string" && fromMap.length > 0) return fromMap;
    // Legacy aliases for older snapshots that only carried claude/codesurf.
    if (activeModelAdapterId === "codesurf.daemon" || model.toLowerCase().startsWith("codesurf:")) {
      return permissionModeSnapshot.codesurf;
    }
    if (activeModelAdapterId === "anthropic.agent-sdk") return permissionModeSnapshot.claude;
    return null;
  })();

  const credentialsByAdapter: Record<string, boolean> = (() => {
    const result: Record<string, boolean> = {};
    for (const provider of kernelProviders) {
      try {
        const status = provider.auth.check({
          conversationId: agent.getSessionId() ?? "ephemeral",
          adapterId: provider.id,
          providerId: provider.providerId,
          settings: kernelServices.settings,
        });
        if (status && typeof (status as { then?: unknown }).then === "function") {
          result[provider.id] = false;
        } else {
          result[provider.id] = (status as { ok?: boolean }).ok === true;
        }
      } catch {
        result[provider.id] = false;
      }
    }
    return result;
  })();

  const activeModelCredentialsReady = activeModelAdapterId
    ? credentialsByAdapter[activeModelAdapterId] === true
    : false;
  const activeModelCanRun = hasApiKey || activeModelCredentialsReady;

  const modelPickerReasoningEffortControls = kernelServices.settings
    .list()
    .filter((setting) => setting.type === "select" && setting.key.endsWith(".effort"))
    .map((setting) => {
      const values = (setting.options ?? []).map((option) => option.value).filter((v) => v.trim().length > 0);
      const defaultValue = typeof setting.default === "string" ? setting.default : undefined;
      const currentValue = kernelServices.settings.get<string>(setting.key, defaultValue);
      return {
        adapterId: setting.key.slice(0, -".effort".length),
        settingKey: setting.key,
        values,
        currentValue: typeof currentValue === "string" ? currentValue : defaultValue,
        defaultValue,
      };
    })
    .filter((entry) => entry.values.length > 0);

  const providerSettingsProvider = providerSettingsState
    ? kernelServices.models.getProvider(providerSettingsState.adapterId)
    : undefined;
  const providerSettingsRows: ProviderSettingRow[] = providerSettingsProvider
    ? kernelServices.settings
        .list()
        .filter((setting) => setting.pluginId === providerSettingsProvider.pluginId)
        .filter((setting) => {
          const q = providerSettingsSearchQuery.trim().toLowerCase();
          if (!q) return true;
          return (
            setting.key.toLowerCase().includes(q) ||
            setting.title.toLowerCase().includes(q) ||
            (setting.description?.toLowerCase().includes(q) ?? false)
          );
        })
        .map((setting) => ({
          setting,
          value: kernelServices.settings.get(setting.key, setting.default),
        }))
    : [];

  return {
    modeInfo,
    modelInfo,
    contextWindow,
    contextStats,
    kernelModels,
    uniqueLogicalProviders,
    kernelAdapterMeta,
    activeModelAdapterId: activeModelAdapterId ?? null,
    credentialsByAdapter,
    activeModelCredentialsReady,
    activeModelCanRun,
    modelPickerReasoningEffortControls,
    providerSettingsRows,
    footerPermissionMode,
  };
}
