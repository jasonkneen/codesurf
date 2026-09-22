import { useCallback } from "react";
import type { Agent } from "../../../agent/agent";
import { getHostServices as kernelGetHostServices } from "../../../core/plugins";
import { getEffectiveReasoningEffort, normalizeModelId } from "../../../grok/models";
import type { AgentMode, ReasoningEffort } from "../../../types/index";
import { MODES } from "../../../types/index";
import { saveProjectSettings, saveUserSettings } from "../../../utils/settings";
import { isUserReasoningEffort } from "../../app-helpers";
import { useConversationState } from "../../context/conversation-state-context.js";
import { useModalVisibility } from "../../context/modal-context.js";
import { useModel } from "../../context/model-context.js";
import type { ModelPickerModelRow } from "../../model-picker-rows";

export function useModelActions({
  agent,
  setRegistryVersion,
  openProviderAuthModal,
}: {
  agent: Agent;
  setRegistryVersion: (fn: (version: number) => number) => void;
  openProviderAuthModal: (config: {
    adapterId: string;
    title: string;
    subtitle?: string;
    reason?: string;
    envVarHint?: string;
    onSuccess?: () => void;
  }) => void;
}) {
  const modal = useModalVisibility();
  const model = useModel();
  const conv = useConversationState();

  const { setShowModelPicker, setModelSearchQuery } = modal;
  const { reasoningEffortByModel, setReasoningEffortByModel, setModel, setModelAdapterId, mode, setModeState } = model;
  const { activePlan } = conv;

  const kernelServices = kernelGetHostServices();

  const setReasoningEfforts = useCallback(
    (next: Record<string, ReasoningEffort>) => {
      setReasoningEffortByModel(next);
      saveUserSettings({ reasoningEffortByModel: next });
    },
    [setReasoningEffortByModel],
  );

  const getModelReasoningEffort = useCallback(
    (modelId: string): ReasoningEffort | undefined => {
      const normalizedModelId = normalizeModelId(modelId);
      return getEffectiveReasoningEffort(normalizedModelId, reasoningEffortByModel[normalizedModelId]);
    },
    [reasoningEffortByModel],
  );

  const adjustModelReasoningEffort = useCallback(
    (row: ModelPickerModelRow, direction: -1 | 1) => {
      const supported = row.supportedReasoningEfforts;
      if (supported.length === 0) return;

      if (row.reasoningEffortSettingKey) {
        const current =
          kernelServices.settings.get<string>(row.reasoningEffortSettingKey, row.reasoningEffortDefault) ??
          row.reasoningEffortDefault;
        const currentIndex = Math.max(0, supported.indexOf(typeof current === "string" ? current : ""));
        const nextIndex =
          direction < 0 ? Math.max(0, currentIndex - 1) : Math.min(supported.length - 1, currentIndex + 1);
        kernelServices.settings.set(row.reasoningEffortSettingKey, supported[nextIndex]);
        setRegistryVersion((version) => version + 1);
        return;
      }

      const normalizedModelId = normalizeModelId(row.id);
      const userSupported = supported.filter(isUserReasoningEffort);
      if (userSupported.length === 0) return;

      const current = getModelReasoningEffort(normalizedModelId);

      if (!current) {
        if (direction > 0) {
          setReasoningEfforts({
            ...reasoningEffortByModel,
            [normalizedModelId]: userSupported[0],
          });
        }
        return;
      }

      const currentIndex = userSupported.indexOf(current);
      if (direction < 0 && currentIndex <= 0) {
        const { [normalizedModelId]: _, ...rest } = reasoningEffortByModel;
        setReasoningEfforts(rest);
      } else {
        const nextIndex = direction < 0 ? currentIndex - 1 : Math.min(userSupported.length - 1, currentIndex + 1);
        setReasoningEfforts({
          ...reasoningEffortByModel,
          [normalizedModelId]: userSupported[nextIndex],
        });
      }
    },
    [getModelReasoningEffort, kernelServices.settings, reasoningEffortByModel, setReasoningEfforts, setRegistryVersion],
  );

  const handleModelPickerClose = useCallback(() => {
    setShowModelPicker(false);
    setModelSearchQuery("");
  }, [setShowModelPicker, setModelSearchQuery]);

  const handleModelPickerSelect = useCallback(
    (modelId: string, adapterId: string) => {
      agent.setModel(modelId, adapterId);
      setModel(modelId);
      setModelAdapterId(adapterId);
      saveProjectSettings({ model: modelId, modelAdapterId: adapterId });
      saveUserSettings({ defaultModel: modelId, defaultModelAdapterId: adapterId });
    },
    [agent, setModel, setModelAdapterId],
  );

  const handleModelPickerOpenAuth = useCallback(
    ({ adapterId, modelId, modelName }: { adapterId: string; modelId: string; modelName: string }) => {
      const provider = kernelServices.models.getProvider(adapterId);
      if (!provider) return;
      if (provider.auth.mode === "oauth" && provider.auth.startAuth) {
        void Promise.resolve(
          provider.auth.startAuth({
            conversationId: agent.getSessionId() ?? "ephemeral",
            adapterId: provider.id,
            providerId: provider.providerId,
            settings: kernelServices.settings,
          }),
        );
        kernelServices.toast.show({
          title: `${provider.label}: sign-in started`,
          message: "Complete the browser sign-in, then re-select the model.",
          style: "info",
        });
        return;
      }
      openProviderAuthModal({
        adapterId: provider.id,
        title: provider.label,
        subtitle: `Required to use ${modelName}`,
        onSuccess: () => {
          agent.setModel(modelId, adapterId);
          setModel(modelId);
          setModelAdapterId(adapterId);
          saveProjectSettings({ model: modelId, modelAdapterId: adapterId });
          saveUserSettings({ defaultModel: modelId, defaultModelAdapterId: adapterId });
        },
      });
    },
    [agent, kernelServices, openProviderAuthModal, setModel, setModelAdapterId],
  );

  const setMode = useCallback(
    (m: AgentMode) => {
      if (m === "agent" && mode === "plan" && activePlan) {
        const planText = [
          `# ${activePlan.title}`,
          activePlan.summary,
          "",
          ...activePlan.steps.map(
            (s, i) =>
              `${i + 1}. ${s.title}: ${s.description}${s.filePaths?.length ? ` (${s.filePaths.join(", ")})` : ""}`,
          ),
        ].join("\n");
        agent.setPlanContext(planText);
      }
      agent.setMode(m);
      setModeState(m);
      setModel(agent.getModel());
      setModelAdapterId(agent.getModelAdapterId());
    },
    [agent, mode, activePlan, setModel, setModelAdapterId, setModeState],
  );

  const cycleMode = useCallback(
    (direction: 1 | -1 = 1) => {
      const idx = MODES.findIndex((m) => m.id === mode);
      const next = (idx + direction + MODES.length) % MODES.length;
      setMode(MODES[next].id);
    },
    [mode, setMode],
  );

  return {
    setReasoningEfforts,
    getModelReasoningEffort,
    adjustModelReasoningEffort,
    handleModelPickerClose,
    handleModelPickerSelect,
    handleModelPickerOpenAuth,
    setMode,
    cycleMode,
  };
}
