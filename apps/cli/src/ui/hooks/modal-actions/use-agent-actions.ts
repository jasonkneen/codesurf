import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useRef, useState } from "react";
import { getHostServices as kernelGetHostServices } from "../../../core/plugins";
import { applyPermissionMode } from "../../../core/plugins/permission-mode";
import { DEFAULT_MODEL, getModelIds, MODELS, normalizeModelId } from "../../../grok/models";
import type { ChatEntry } from "../../../types/index";
import {
  type CustomSubagentConfig,
  isReservedSubagentName,
  loadValidSubAgents,
  saveUserSettings,
} from "../../../utils/settings";
import type { SubagentEditorField } from "../../agents-modal";
import { CLAUDE_AGENT_SETTING_KEYS, CLAUDE_AGENT_SETTING_LABELS } from "../../app-helpers";
import {
  buildClaudeAgentRows,
  type ClaudeAgentGroup,
  type ClaudeAgentRow,
  firstSelectableIndex as firstClaudeAgentRowIndex,
  firstIndexForGroup,
} from "../../claude-agent-modal";
import { useConversationState } from "../../context/conversation-state-context.js";
import { useModalVisibility } from "../../context/modal-context.js";

export function useAgentActions() {
  const modal = useModalVisibility();
  const conv = useConversationState();

  const {
    setShowAgentsModal,
    setShowAgentsEditor,
    setAgentsSearchQuery,
    setAgentsModalIndex,
    setShowClaudeAgentModal,
    setClaudeAgentModalIndex,
  } = modal;
  const { setMessages } = conv;

  const [subAgents, setSubAgents] = useState<CustomSubagentConfig[]>(() => loadValidSubAgents());
  const [editingSubagent, setEditingSubagent] = useState<CustomSubagentConfig | null>(null);
  const [agentsEditorDraft, setAgentsEditorDraft] = useState({ name: "", instruction: "" });
  const [agentsEditorField, setAgentsEditorField] = useState<SubagentEditorField>("name");
  const [agentsEditorModelIndex, setAgentsEditorModelIndex] = useState(() =>
    Math.max(
      0,
      MODELS.findIndex((model) => model.id === DEFAULT_MODEL),
    ),
  );
  const [agentsEditorSyncKey, setAgentsEditorSyncKey] = useState(0);
  const [agentsEditorError, setAgentsEditorError] = useState<string | null>(null);
  const subagentNameRef = useRef<TextareaRenderable>(null);
  const subagentInstructionRef = useRef<TextareaRenderable>(null);

  const openAgentsModal = useCallback(() => {
    setSubAgents(loadValidSubAgents());
    setAgentsSearchQuery("");
    setAgentsModalIndex(0);
    setEditingSubagent(null);
    setAgentsEditorError(null);
    setShowAgentsEditor(false);
    setShowAgentsModal(true);
  }, [setShowAgentsModal, setAgentsSearchQuery, setAgentsModalIndex, setShowAgentsEditor]);

  const openSubagentEditor = useCallback(
    (agentConfig: CustomSubagentConfig | null) => {
      setEditingSubagent(agentConfig);
      if (agentConfig) {
        setAgentsEditorDraft({
          name: agentConfig.name,
          instruction: agentConfig.instruction,
        });
        setAgentsEditorModelIndex(
          Math.max(
            0,
            MODELS.findIndex((m) => m.id === normalizeModelId(agentConfig.model)),
          ),
        );
      } else {
        setAgentsEditorDraft({ name: "", instruction: "" });
        setAgentsEditorModelIndex(
          Math.max(
            0,
            MODELS.findIndex((m) => m.id === DEFAULT_MODEL),
          ),
        );
      }
      setAgentsEditorField("name");
      setAgentsEditorError(null);
      setAgentsEditorSyncKey((n) => n + 1);
      setShowAgentsEditor(true);
      setShowAgentsModal(true);
    },
    [setShowAgentsEditor, setShowAgentsModal],
  );

  const submitSubagentEditor = useCallback(() => {
    const name = (subagentNameRef.current?.plainText || "").trim();
    const instruction = subagentInstructionRef.current?.plainText || "";
    const modelId = MODELS[agentsEditorModelIndex]?.id;

    if (!name) {
      setAgentsEditorError("Name is required.");
      return;
    }
    if (isReservedSubagentName(name)) {
      setAgentsEditorError('Names "general" and "explore" are reserved.');
      return;
    }
    if (!modelId || !getModelIds().includes(modelId)) {
      setAgentsEditorError("Pick a valid model.");
      return;
    }

    const next = [...subAgents];
    const editing = editingSubagent;
    if (editing) {
      const index = next.findIndex((item) => item.name === editing.name);
      if (index >= 0) next.splice(index, 1);
    }

    if (next.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setAgentsEditorError("Another sub-agent already uses this name.");
      return;
    }

    next.push({ name, model: modelId, instruction });
    saveUserSettings({ subAgents: next });
    setSubAgents(loadValidSubAgents());
    setShowAgentsEditor(false);
    setEditingSubagent(null);
    setAgentsEditorError(null);
  }, [agentsEditorModelIndex, editingSubagent, subAgents, setShowAgentsEditor]);

  const removeEditingSubagent = useCallback(() => {
    const editing = editingSubagent;
    if (!editing) return;

    const next = subAgents.filter((item) => item.name !== editing.name);
    saveUserSettings({ subAgents: next });
    setSubAgents(loadValidSubAgents());
    setShowAgentsEditor(false);
    setEditingSubagent(null);
    setAgentsEditorError(null);
    setAgentsModalIndex(0);
  }, [editingSubagent, subAgents, setShowAgentsEditor, setAgentsModalIndex]);

  const handleResetAgentsEditor = useCallback(() => {
    setEditingSubagent(null);
    setAgentsEditorError(null);
  }, []);

  const applyClaudeAgentRow = useCallback(
    (row: ClaudeAgentRow): void => {
      if (row.kind !== "option") return;
      const services = kernelGetHostServices();
      if (row.group === "permission") {
        // Fan out to every registered `*.permissionMode` setting so Claude,
        // Codesurf daemon, Claude CLI, and Claude+Claude skills stay in sync.
        applyPermissionMode(services.settings, row.value);
      } else {
        const key = CLAUDE_AGENT_SETTING_KEYS[row.group];
        services.settings.set(key, row.value);
      }
      const label = CLAUDE_AGENT_SETTING_LABELS[row.group];
      setMessages((prev) => [
        ...prev,
        {
          type: "assistant",
          content: `${label} → ${row.value}`,
          timestamp: new Date(),
        } as ChatEntry,
      ]);
    },
    [setMessages],
  );

  /**
   * When non-null, the Claude-agent modal only renders these groups.
   * `/permissions` sets `["permission"]` so the dialog is provider-universal
   * instead of Claude thinking/effort chrome.
   */
  const [claudeAgentModalOnlyGroups, setClaudeAgentModalOnlyGroups] = useState<ClaudeAgentGroup[] | null>(null);

  const openClaudeAgentModal = useCallback(
    (focusGroup?: ClaudeAgentGroup) => {
      const onlyGroups: ClaudeAgentGroup[] | null = focusGroup === "permission" ? ["permission"] : null;
      setClaudeAgentModalOnlyGroups(onlyGroups);
      const rows = buildClaudeAgentRows(onlyGroups ? { onlyGroups } : undefined);
      const idx = focusGroup ? firstIndexForGroup(rows, focusGroup) : firstClaudeAgentRowIndex(rows);
      setClaudeAgentModalIndex(idx);
      setShowClaudeAgentModal(true);
    },
    [setShowClaudeAgentModal, setClaudeAgentModalIndex],
  );

  return {
    openAgentsModal,
    openSubagentEditor,
    submitSubagentEditor,
    removeEditingSubagent,
    handleResetAgentsEditor,
    applyClaudeAgentRow,
    openClaudeAgentModal,
    claudeAgentModalOnlyGroups,

    subAgents,
    editingSubagent,
    agentsEditorDraft,
    agentsEditorField,
    agentsEditorModelIndex,
    agentsEditorSyncKey,
    agentsEditorError,
    subagentNameRef,
    subagentInstructionRef,

    setAgentsEditorField,
    setAgentsEditorError,
    setAgentsEditorModelIndex,
  };
}
