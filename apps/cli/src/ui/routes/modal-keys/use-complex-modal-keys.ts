import type { KeyEvent } from "@opentui/core";
import type { RefObject } from "react";
import { MODELS } from "../../../grok/models";
import type { PlanQuestion } from "../../../types/index";
import type { SandboxSettings } from "../../../utils/settings";
import { SUBAGENT_EDITOR_FIELDS } from "../../agents-modal.js";
import { MCP_REMOTE_FIELDS, MCP_STDIO_FIELDS } from "../../app-helpers.js";
import { useComposer } from "../../context/composer-context.js";
import { useConversationState } from "../../context/conversation-state-context.js";
import { useModal } from "../../context/modal-context.js";
import { useModel } from "../../context/model-context.js";
import type { useModalActions } from "../../hooks/use-modal-actions.js";
import { slashMenuIndexStore } from "../../menu-nav-store.js";
import { getSandboxVisibleRows } from "../../screens/sandbox-picker.js";
import { WALLET_ROWS } from "../../screens/wallet-picker.js";
import { filterVisibleSlashItems, type SlashMenuItem } from "../../slash-menu.js";
import { isEscapeKey } from "./shared.js";

interface ComplexModalKeysParams {
  modalActions: ReturnType<typeof useModalActions>;
  visibleSlashItems: SlashMenuItem[];
  processMessageRef: RefObject<(text: string, displayText?: string) => Promise<void> | void>;
  onDismissPlan: () => void;
  onSubmitPlanAnswers: () => void;
  onHandlePlanSelect: (
    q: PlanQuestion,
    idx: number,
    options: { id: string; label: string }[],
    showCustom: boolean,
  ) => void;
}

export function useComplexModalKeys(params: ComplexModalKeysParams) {
  const modal = useModal();
  const { pqs, setPqs, activePlan } = useConversationState();
  const { inputRef, commitComposer } = useComposer();
  const { sandboxMode, sandboxSettings, walletSettings, walletDisplayInfo } = useModel();

  const { modalActions, visibleSlashItems, processMessageRef, onDismissPlan, onSubmitPlanAnswers, onHandlePlanSelect } =
    params;

  // ── Plan panel derived values ──
  const planQuestions = activePlan?.questions ?? [];
  const isSinglePlan = planQuestions.length === 1 && planQuestions[0]?.type !== "multiselect";
  const planTabCount = isSinglePlan ? 1 : planQuestions.length + 1;
  const isPlanConfirmTab = !isSinglePlan && pqs.tab === planQuestions.length;
  const showPlanPanel = !!activePlan?.questions?.length;

  // ── MCP editor field list (depends on transport type) ──
  const mcpEditorFields = modalActions.mcpEditorDraft.transport === "stdio" ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;

  return (key: KeyEvent): boolean => {
    // ── Plan panel (questionnaire) ──
    if (showPlanPanel) {
      const q = planQuestions[pqs.tab];

      if (isEscapeKey(key)) {
        onDismissPlan();
        return true;
      }

      // When editing custom text input
      if (pqs.editing && !isPlanConfirmTab) {
        if (key.name === "return") {
          const qId = q?.id;
          if (qId) {
            const text = (pqs.customInputs[qId] ?? "").trim();
            if (text) {
              if (q.type === "multiselect") {
                const existing = (pqs.answers[qId] as string[] | undefined) ?? [];
                const next = existing.includes(text) ? existing : [...existing, text];
                setPqs((s) => ({
                  ...s,
                  editing: false,
                  answers: { ...s.answers, [qId]: next },
                }));
              } else if (q.type === "text") {
                setPqs((s) => ({
                  ...s,
                  editing: false,
                  answers: { ...s.answers, [qId]: text },
                }));
                if (isSinglePlan) {
                  onSubmitPlanAnswers();
                  return true;
                }
                setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
              } else {
                setPqs((s) => ({
                  ...s,
                  editing: false,
                  answers: { ...s.answers, [qId]: text },
                }));
                if (isSinglePlan) {
                  onSubmitPlanAnswers();
                  return true;
                }
                setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
              }
            } else {
              setPqs((s) => ({ ...s, editing: false }));
            }
          }
          return true;
        }
        if (key.name === "backspace") {
          const qId = q?.id;
          if (qId)
            setPqs((s) => ({
              ...s,
              customInputs: {
                ...s.customInputs,
                [qId]: (s.customInputs[qId] ?? "").slice(0, -1),
              },
            }));
          return true;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          const qId = q?.id;
          if (qId)
            setPqs((s) => ({
              ...s,
              customInputs: {
                ...s.customInputs,
                [qId]: (s.customInputs[qId] ?? "") + key.sequence,
              },
            }));
          return true;
        }
        return true;
      }

      // Tab / left / right — switch between question tabs
      if (key.name === "tab") {
        const dir = key.shift ? -1 : 1;
        setPqs((s) => ({
          ...s,
          tab: (s.tab + dir + planTabCount) % planTabCount,
          selected: 0,
        }));
        return true;
      }
      if (key.name === "left" || key.name === "h") {
        setPqs((s) => ({
          ...s,
          tab: (s.tab - 1 + planTabCount) % planTabCount,
          selected: 0,
        }));
        return true;
      }
      if (key.name === "right" || key.name === "l") {
        setPqs((s) => ({
          ...s,
          tab: (s.tab + 1) % planTabCount,
          selected: 0,
        }));
        return true;
      }

      // Confirm tab
      if (isPlanConfirmTab) {
        if (key.name === "return") {
          onSubmitPlanAnswers();
          return true;
        }
        return true;
      }

      if (!q) return true;

      // Text-only question (no options)
      if (q.type === "text") {
        setPqs((s) => ({ ...s, editing: true }));
        return true;
      }

      // Up/down — navigate options
      const options = q.options ?? [];
      const showCustom = true;
      const totalItems = options.length + 1;

      if (key.name === "up" || key.name === "k") {
        setPqs((s) => ({
          ...s,
          selected: (s.selected - 1 + totalItems) % totalItems,
        }));
        return true;
      }
      if (key.name === "down" || key.name === "j") {
        setPqs((s) => ({ ...s, selected: (s.selected + 1) % totalItems }));
        return true;
      }

      // Number keys 1-9 for quick selection
      const digit = Number(key.name);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= Math.min(totalItems, 9)) {
        const idx = digit - 1;
        setPqs((s) => ({ ...s, selected: idx }));
        onHandlePlanSelect(q, idx, options, showCustom);
        return true;
      }

      // Enter — select current option
      if (key.name === "return") {
        onHandlePlanSelect(q, pqs.selected, options, showCustom);
        return true;
      }

      return true;
    }

    // ── MCP editor ──
    if (modal.showMcpEditorRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowMcpEditor(false);
        modalActions.setMcpEditorError(null);
        modal.setMcpSearchQuery("");
        return true;
      }
      if (key.name === "return") {
        modalActions.submitMcpEditor();
        return true;
      }
      if (modalActions.mcpEditorField === "transport" && (key.name === "left" || key.name === "right")) {
        modalActions.cycleMcpEditorTransport(key.name === "left" ? -1 : 1);
        return true;
      }
      if (key.name === "tab") {
        const idx = mcpEditorFields.indexOf(modalActions.mcpEditorField);
        const nextIdx = (idx + (key.shift ? -1 : 1) + mcpEditorFields.length) % mcpEditorFields.length;
        modalActions.setMcpEditorField(mcpEditorFields[nextIdx]!);
        return true;
      }
      if (modalActions.mcpEditorField === "transport") {
        return true;
      }
      return true;
    }

    // ── Sub-agent editor ──
    if (modal.showAgentsEditorRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowAgentsEditor(false);
        modalActions.setAgentsEditorError(null);
        return true;
      }
      if (key.name === "x" && key.ctrl && modalActions.editingSubagent) {
        modalActions.removeEditingSubagent();
        return true;
      }
      if (key.name === "return") {
        modalActions.submitSubagentEditor();
        return true;
      }
      if (
        modalActions.agentsEditorField === "model" &&
        (key.name === "up" ||
          key.name === "down" ||
          key.name === "left" ||
          key.name === "right" ||
          key.name === "j" ||
          key.name === "k")
      ) {
        const decrement = key.name === "up" || key.name === "left" || key.name === "k";
        modalActions.setAgentsEditorModelIndex((index) =>
          decrement ? Math.max(0, index - 1) : Math.min(MODELS.length - 1, index + 1),
        );
        return true;
      }
      if (key.name === "tab") {
        const index = SUBAGENT_EDITOR_FIELDS.indexOf(modalActions.agentsEditorField);
        const nextIndex =
          (index + (key.shift ? -1 : 1) + SUBAGENT_EDITOR_FIELDS.length) % SUBAGENT_EDITOR_FIELDS.length;
        modalActions.setAgentsEditorField(SUBAGENT_EDITOR_FIELDS[nextIndex]!);
        return true;
      }
      if (modalActions.agentsEditorField === "model") {
        return true;
      }
      return true;
    }

    // ── Slash menu ──
    if (modal.showSlashMenu) {
      const slashDisplayItems = filterVisibleSlashItems(visibleSlashItems, modal.slashSearchQueryRef.current);
      if (isEscapeKey(key)) {
        modal.setShowSlashMenu(false);
        modal.setSlashSearchQuery("");
        commitComposer();
        return true;
      }
      if (key.name === "up") {
        slashMenuIndexStore.set((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        slashMenuIndexStore.set((i) => Math.min(slashDisplayItems.length - 1, i + 1));
        return true;
      }
      if (key.name === "tab") {
        const item = slashDisplayItems[slashMenuIndexStore.get()];
        if (item && item.id !== "__ask__") {
          modal.setShowSlashMenu(false);
          modal.setSlashSearchQuery("");
          commitComposer({ text: `/${item.id} ` });
        }
        return true;
      }
      if (key.name === "return") {
        const item = slashDisplayItems[slashMenuIndexStore.get()];
        if (item?.id === "__ask__") {
          const q = modal.slashSearchQueryRef.current.trim();
          modal.setShowSlashMenu(false);
          modal.setSlashSearchQuery("");
          commitComposer();
          if (q) {
            processMessageRef.current?.(q);
          }
        } else if (item) {
          modalActions.handleSlashMenuSelect(item);
        }
        modal.setSlashSearchQuery("");
        return true;
      }
      if (key.name === "backspace") {
        modal.setSlashSearchQuery((q) => q.slice(0, -1));
        slashMenuIndexStore.set(0);
        // Mirror into textarea
        {
          const ta = inputRef.current;
          if (ta) {
            const nextQuery = modal.slashSearchQueryRef.current.slice(0, -1);
            const desired = `/${nextQuery}`;
            if (ta.plainText !== desired) {
              ta.clear();
              ta.insertText(desired);
            }
          }
        }
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setSlashSearchQuery((q) => q + key.sequence);
        slashMenuIndexStore.set(0);
        // Mirror into textarea
        {
          const ta = inputRef.current;
          if (ta) {
            const nextQuery = modal.slashSearchQueryRef.current + key.sequence;
            const desired = `/${nextQuery}`;
            if (ta.plainText !== desired) {
              ta.clear();
              ta.insertText(desired);
            }
          }
        }
        return true;
      }
      return true;
    }

    // ── Wallet picker ──
    if (modal.showWalletPicker) {
      if (isEscapeKey(key)) {
        modal.setShowWalletPicker(false);
        return true;
      }
      if (key.name === "up") {
        modal.setWalletFocusIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setWalletFocusIndex((i) => Math.min(WALLET_ROWS.length - 1, i + 1));
        return true;
      }

      const focusedWalletRow = WALLET_ROWS[modal.walletFocusIndexRef.current];
      if (!focusedWalletRow || focusedWalletRow.type === "readonly") return true;

      if (key.name === "left" || key.name === "right") {
        const options = focusedWalletRow.getOptions!();
        const current = focusedWalletRow.getDisplay(walletSettings, walletDisplayInfo);
        const idx = options.indexOf(current);
        const next =
          key.name === "right" ? options[Math.min(options.length - 1, idx + 1)] : options[Math.max(0, idx - 1)];
        if (next && next !== current && focusedWalletRow.apply) {
          const patch = focusedWalletRow.apply(walletSettings, next);
          modalActions.applyWalletSettings({ ...walletSettings, ...patch });
        }
        return true;
      }

      if (key.name === "return") {
        const options = focusedWalletRow.getOptions!();
        const current = focusedWalletRow.getDisplay(walletSettings, walletDisplayInfo);
        const idx = options.indexOf(current);
        const next = options[(idx + 1) % options.length];
        if (next && focusedWalletRow.apply) {
          const patch = focusedWalletRow.apply(walletSettings, next);
          modalActions.applyWalletSettings({ ...walletSettings, ...patch });
        }
        return true;
      }
      return true;
    }

    // ── Sandbox picker ──
    if (modal.showSandboxPicker) {
      const visibleRows = getSandboxVisibleRows(sandboxMode);

      if (modal.sandboxSettingsEditing) {
        if (isEscapeKey(key)) {
          modal.setSandboxSettingsEditing(null);
          modal.setSandboxSettingsEditBuffer("");
          return true;
        }
        if (key.name === "return") {
          const row = visibleRows.find((r) => r.key === modal.sandboxSettingsEditing);
          if (row) {
            const result = row.apply(sandboxMode, sandboxSettings, modal.sandboxSettingsEditBuffer.trim());
            if (result.mode !== undefined) modalActions.applySandboxMode(result.mode);
            if (result.settings)
              modalActions.applySandboxSettings({
                ...sandboxSettings,
                ...result.settings,
              });
          }
          modal.setSandboxSettingsEditing(null);
          modal.setSandboxSettingsEditBuffer("");
          return true;
        }
        if (key.name === "backspace") {
          modal.setSandboxSettingsEditBuffer((b) => b.slice(0, -1));
          return true;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          modal.setSandboxSettingsEditBuffer((b) => b + key.sequence);
          return true;
        }
        return true;
      }

      if (isEscapeKey(key)) {
        modal.setShowSandboxPicker(false);
        return true;
      }
      if (key.name === "up") {
        modal.setSandboxSettingsFocusIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setSandboxSettingsFocusIndex((i) => Math.min(visibleRows.length - 1, i + 1));
        return true;
      }

      const focusedRow = visibleRows[modal.sandboxSettingsFocusIndexRef.current];
      if (!focusedRow) return true;

      if (focusedRow.type === "toggle" && (key.name === "left" || key.name === "right")) {
        const options = focusedRow.getOptions!();
        const current = focusedRow.getDisplay(sandboxMode, sandboxSettings);
        const idx = options.indexOf(current);
        const next =
          key.name === "right" ? options[Math.min(options.length - 1, idx + 1)] : options[Math.max(0, idx - 1)];
        if (next && next !== current) {
          const result = focusedRow.apply(sandboxMode, sandboxSettings, next);
          if (result.mode !== undefined) modalActions.applySandboxMode(result.mode);
          if (result.settings) modalActions.applySandboxSettings({ ...sandboxSettings, ...result.settings });
        }
        return true;
      }

      if (key.name === "return") {
        if (focusedRow.type === "toggle") {
          const options = focusedRow.getOptions!();
          const current = focusedRow.getDisplay(sandboxMode, sandboxSettings);
          const idx = options.indexOf(current);
          const next = options[(idx + 1) % options.length];
          const result = focusedRow.apply(sandboxMode, sandboxSettings, next);
          if (result.mode !== undefined) modalActions.applySandboxMode(result.mode);
          if (result.settings) modalActions.applySandboxSettings({ ...sandboxSettings, ...result.settings });
        } else {
          modal.setSandboxSettingsEditing(focusedRow.key);
          const current = sandboxSettings[focusedRow.key as keyof SandboxSettings];
          modal.setSandboxSettingsEditBuffer(
            Array.isArray(current) ? current.join(", ") : current != null ? String(current) : "",
          );
        }
        return true;
      }
      return true;
    }

    return false;
  };
}
