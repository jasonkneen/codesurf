import type { KeyEvent } from "@opentui/core";
import type { RefObject } from "react";
import type { Agent } from "../../../agent/agent";
import {
  disablePlugin as kernelDisableExtension,
  enablePlugin as kernelEnableExtension,
  listPlugins as kernelListExtensions,
} from "../../../core/plugins";
import type { SubagentBrowseRow } from "../../agents-modal.js";
import {
  buildClaudeAgentRows,
  CLAUDE_AGENT_GROUP_ORDER,
  type ClaudeAgentGroup,
  firstIndexForGroup,
  stepIndex as stepClaudeAgentRow,
} from "../../claude-agent-modal.js";
import type { CommandPaletteAction } from "../../command-palette.js";
import { useModal } from "../../context/modal-context.js";
import { useTheme } from "../../context/theme-context.js";
import { buildFeatureFlagRows, type FeatureFlagRow, getFeatureFlag, setFeatureFlag } from "../../feature-flags.js";
import type { useModalActions } from "../../hooks/use-modal-actions.js";
import type { McpBrowserRow } from "../../mcp-modal-types.js";
import { buildExtensionsRows, type PluginsRow } from "../../plugins-modal.js";
import type { ProviderSettingRow } from "../../provider-settings-modal.js";
import type { ScheduleBrowseRow } from "../../schedule-modal.js";
import { buildSessionsRows, type SessionsRow } from "../../sessions-modal.js";
import type { SlashMenuItem } from "../../slash-menu.js";
import type { TerminalSessionSnapshot } from "../../terminal/manager";
import { buildThemeRows } from "../../theme-modal.js";
import { THEMES } from "../../themes/catalog.js";
import { isEscapeKey } from "./shared.js";

interface ListModalKeysParams {
  modalActions: ReturnType<typeof useModalActions>;
  agent: Agent;
  mcpRows: McpBrowserRow[];
  scheduleRows: ScheduleBrowseRow[];
  agentRows: SubagentBrowseRow[];
  commandPaletteActions: CommandPaletteAction[];
  visibleSlashItems: SlashMenuItem[];
  terminalSessions: readonly TerminalSessionSnapshot[];
  providerSettingsRows: ProviderSettingRow[];
  processMessageRef: RefObject<(text: string, displayText?: string) => Promise<void> | void>;
  onToggleFeatureFlag: (id: string) => void;
  onCommitComposer: () => void;
  onResumeSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onWriteTerminalSession: (sessionId: string, data: string) => void;
  onRemoveTerminalSession: (sessionId: string) => void;
  onStopTerminalSession: (sessionId: string) => void;
}

export function useListModalKeys(params: ListModalKeysParams) {
  const modal = useModal();
  const {
    t: _t,
    themeId: _themeId,
    showThemeModal,
    themeSearchQuery,
    themeModalIndex,
    setShowThemeModal,
    setThemeSearchQuery,
    setThemeModalIndex,
    previewTheme,
    applyTheme,
    revertThemePreview,
  } = useTheme();
  void _t;
  void _themeId;

  const {
    modalActions,
    agent,
    mcpRows,
    scheduleRows,
    agentRows,
    commandPaletteActions,
    visibleSlashItems,
    terminalSessions,
    providerSettingsRows,
    processMessageRef,
    onToggleFeatureFlag,
    onCommitComposer,
    onResumeSession,
    onDeleteSession,
    onWriteTerminalSession,
    onRemoveTerminalSession,
    onStopTerminalSession,
  } = params;

  return (key: KeyEvent): boolean => {
    // ── MCP browser modal (list / resources / viewer drill-down) ──
    // Exclude editor mode — the complex hook handles MCP editor keys.
    if (modal.showMcpModalRef.current && !modal.showMcpEditorRef.current) {
      const drill = modalActions.mcpDrillState;
      if (drill.mode === "viewer") {
        if (isEscapeKey(key) || key.name === "left") modalActions.handleMcpDrillBackToResources();
        return true;
      }
      if (drill.mode === "resources") {
        if (isEscapeKey(key) || key.name === "left") {
          modalActions.handleMcpDrillBackToList();
          return true;
        }
        if (key.name === "up") {
          modalActions.setMcpDrillResourceIndex((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.name === "down") {
          modalActions.setMcpDrillResourceIndex((i) =>
            Math.min(Math.max(0, modalActions.mcpDrillResources.length - 1), i + 1),
          );
          return true;
        }
        if (key.name === "return") {
          const resource = modalActions.mcpDrillResources[modalActions.mcpDrillResourceIndex];
          const server = modal.mcpServers.find((s) => s.id === drill.serverId);
          if (resource && server) modalActions.openMcpResourceViewer(server, resource);
          return true;
        }
        return true;
      }
      // list mode
      const row: McpBrowserRow | undefined = mcpRows[modal.mcpModalIndex];
      if (isEscapeKey(key)) {
        modalActions.handleMcpListEscape();
        return true;
      }
      if (key.name === "up") {
        modal.setMcpModalIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setMcpModalIndex((i) => Math.min(mcpRows.length - 1, i + 1));
        return true;
      }
      if (key.name === "right" && row?.kind === "server" && row.server.enabled) {
        const stats = modalActions.mcpServerStats.get(row.server.id);
        if (stats && stats.resources > 0) modalActions.openMcpResourceDrill(row.server);
        return true;
      }
      if (key.name === "return") {
        if (row?.kind === "server") modalActions.toggleSavedMcp(row.server);
        else if (row?.kind === "catalog") modalActions.openCatalogMcp(row.entry);
        else modalActions.handleMcpAddNew();
        return true;
      }
      if (key.name === "a" && key.ctrl) {
        modalActions.handleMcpAddNew();
        return true;
      }
      if (key.name === "e" && key.ctrl && row?.kind === "server") {
        modalActions.editSavedMcp(row.server);
        return true;
      }
      if (key.name === "x" && key.ctrl && row?.kind === "server") {
        modalActions.deleteSavedMcp(row.server);
        return true;
      }
      if (key.name === "backspace") {
        modal.setMcpSearchQuery((q) => q.slice(0, -1));
        modal.setMcpModalIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setMcpSearchQuery((q) => q + key.sequence);
        modal.setMcpModalIndex(0);
        return true;
      }
      return true;
    }

    // ── Feature flags modal ──
    if (modal.showFlagsModalRef.current) {
      const flagRows = buildFeatureFlagRows(modal.flagsSearchQuery);
      const row: FeatureFlagRow | undefined = flagRows[modal.flagsModalIndex];
      if (isEscapeKey(key)) {
        modal.setShowFlagsModal(false);
        modal.setFlagsSearchQuery("");
        return true;
      }
      if (key.name === "up") {
        modal.setFlagsModalIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setFlagsModalIndex((i) => Math.min(Math.max(0, flagRows.length - 1), i + 1));
        return true;
      }
      if (key.name === "return" || key.name === "space") {
        if (row) {
          onToggleFeatureFlag(row.descriptor.id);
          modal.setFlagsTick((n) => n + 1);
        }
        key.preventDefault?.();
        key.stopPropagation?.();
        return true;
      }
      if (key.name === "backspace") {
        modal.setFlagsSearchQuery((q) => q.slice(0, -1));
        modal.setFlagsModalIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setFlagsSearchQuery((q) => q + key.sequence);
        modal.setFlagsModalIndex(0);
        return true;
      }
      return true;
    }

    // ── Extensions modal ──
    if (modal.showExtensionsModalRef.current) {
      const extensionRows = buildExtensionsRows(
        modal.extensionsList,
        modal.extensionsSearchQuery,
        modal.expandedExtensionGroups,
      );
      const row: PluginsRow | undefined = extensionRows[modal.extensionsModalIndex];
      if (isEscapeKey(key)) {
        modal.setShowExtensionsModal(false);
        modal.setExtensionsSearchQuery("");
        return true;
      }
      if (key.name === "up") {
        modal.setExtensionsModalIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setExtensionsModalIndex((i) => Math.min(Math.max(0, extensionRows.length - 1), i + 1));
        return true;
      }
      if (key.name === "right" && row?.kind === "group") {
        modal.setExpandedExtensionGroups((groups) => new Set(groups).add(row.extension.id));
        return true;
      }
      if (key.name === "left") {
        const groupId = row?.kind === "group" ? row.extension.id : row?.parentGroupId;
        if (groupId) {
          modal.setExpandedExtensionGroups((groups) => {
            const next = new Set(groups);
            next.delete(groupId);
            return next;
          });
          modal.setExtensionsModalIndex((i) => Math.max(0, i - 1));
        }
        return true;
      }
      if (key.name === "return") {
        if (row) {
          if (row.kind === "group" && row.members) {
            const toggleable = row.members.filter((ext) => !ext.protected);
            const shouldEnable = toggleable.some((ext) => !ext.enabled);
            for (const ext of toggleable) {
              if (shouldEnable) {
                void kernelEnableExtension(ext.id);
                void modalActions.maybePromptProviderAuth(ext.id);
              } else {
                void kernelDisableExtension(ext.id);
              }
            }
            modal.setExtensionsList(kernelListExtensions());
          } else {
            const ext = row.extension;
            if (!ext.protected) {
              const wasEnabled = ext.enabled;
              if (wasEnabled) kernelDisableExtension(ext.id);
              else kernelEnableExtension(ext.id);
              modal.setExtensionsList(kernelListExtensions());
              if (!wasEnabled) void modalActions.maybePromptProviderAuth(ext.id);
            }
          }
        }
        return true;
      }
      if (key.name === "backspace") {
        modal.setExtensionsSearchQuery((q) => q.slice(0, -1));
        modal.setExtensionsModalIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setExtensionsSearchQuery((q) => q + key.sequence);
        modal.setExtensionsModalIndex(0);
        return true;
      }
      return true;
    }

    // ── Command palette ──
    if (modal.showCommandPaletteRef.current) {
      if (isEscapeKey(key)) {
        modal.setShowCommandPalette(false);
        return true;
      }
      if (key.name === "up") {
        modal.setCommandPaletteIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setCommandPaletteIndex((i) => Math.min(Math.max(0, commandPaletteActions.length - 1), i + 1));
        return true;
      }
      if (key.name === "return") {
        const row = commandPaletteActions[modal.commandPaletteIndex];
        if (row?.id === "__ask__") {
          const q = modal.commandPaletteQuery.trim();
          modal.setShowCommandPalette(false);
          modal.setCommandPaletteQuery("");
          onCommitComposer();
          if (q) processMessageRef.current?.(q);
        } else if (row) {
          modal.setShowCommandPalette(false);
          const menuItem = visibleSlashItems.find((m) => m.id === row.id);
          if (menuItem) modalActions.handleSlashMenuSelect(menuItem);
        } else {
          const q = modal.commandPaletteQuery.trim();
          modal.setShowCommandPalette(false);
          modal.setCommandPaletteQuery("");
          onCommitComposer();
          if (q) processMessageRef.current?.(q);
        }
        return true;
      }
      if (key.name === "backspace") {
        modal.setCommandPaletteQuery((q) => q.slice(0, -1));
        modal.setCommandPaletteIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setCommandPaletteQuery((q) => q + key.sequence);
        modal.setCommandPaletteIndex(0);
        return true;
      }
      return true;
    }

    // ── Terminal modal (input mode + command mode) ──
    if (modal.showTerminalModalRef.current) {
      const selected = terminalSessions[modal.terminalModalIndex];
      if (modal.terminalInputModeRef.current) {
        if (key.ctrl && (key.name === "]" || key.sequence === "\u001d")) {
          modal.terminalInputModeRef.current = false;
          modal.setTerminalInputMode(false);
          return true;
        }
        if (selected && selected.status === "running" && key.sequence) {
          onWriteTerminalSession(selected.id, key.sequence);
        }
        return true;
      }
      if (isEscapeKey(key)) {
        modal.setShowTerminalModal(false);
        return true;
      }
      if (key.name === "tab") {
        if (terminalSessions.length === 0) return true;
        modal.setTerminalModalIndex((i) => {
          const dir = key.shift ? -1 : 1;
          return (i + dir + terminalSessions.length) % terminalSessions.length;
        });
        return true;
      }
      if (key.name === "i" && !key.ctrl && !key.meta) {
        if (selected && selected.status === "running") {
          modal.terminalInputModeRef.current = true;
          modal.setTerminalInputMode(true);
        }
        return true;
      }
      if (key.name === "x") {
        if (selected) onRemoveTerminalSession(selected.id);
        return true;
      }
      if (key.name === "s") {
        if (selected) onStopTerminalSession(selected.id);
        return true;
      }
      return true;
    }

    // ── Claude agent settings modal (also /permissions when onlyGroups=["permission"]) ──
    if (modal.showClaudeAgentModalRef.current) {
      const onlyGroups = modalActions.claudeAgentModalOnlyGroups ?? undefined;
      const claudeAgentRows = buildClaudeAgentRows(onlyGroups ? { onlyGroups } : undefined);
      const groups: ClaudeAgentGroup[] = onlyGroups?.length
        ? onlyGroups.filter((g, i, arr) => arr.indexOf(g) === i)
        : [...CLAUDE_AGENT_GROUP_ORDER];
      if (isEscapeKey(key)) {
        modal.setShowClaudeAgentModal(false);
        return true;
      }
      if (key.name === "up") {
        modal.setClaudeAgentModalIndex((i) => stepClaudeAgentRow(claudeAgentRows, i, -1));
        return true;
      }
      if (key.name === "down") {
        modal.setClaudeAgentModalIndex((i) => stepClaudeAgentRow(claudeAgentRows, i, 1));
        return true;
      }
      if (key.name === "tab" && groups.length > 1) {
        modal.setClaudeAgentModalIndex((i) => {
          const currentRow = claudeAgentRows[i];
          const currentGroup = currentRow?.group ?? groups[0] ?? "thinking";
          const gIdx = groups.indexOf(currentGroup);
          const nextGroup = groups[(gIdx + (key.shift ? -1 : 1) + groups.length) % groups.length];
          return firstIndexForGroup(claudeAgentRows, nextGroup);
        });
        return true;
      }
      if (key.name === "space") {
        key.preventDefault?.();
        key.stopPropagation?.();
        const row = claudeAgentRows[modal.claudeAgentModalIndex];
        if (row && row.kind === "option") modalActions.applyClaudeAgentRow(row);
        return true;
      }
      if (key.name === "return") {
        const row = claudeAgentRows[modal.claudeAgentModalIndex];
        if (row && row.kind === "option") {
          modalActions.applyClaudeAgentRow(row);
          modal.setShowClaudeAgentModal(false);
        }
        return true;
      }
      return true;
    }

    // ── Theme picker modal ──
    if (showThemeModal) {
      const themeRows = buildThemeRows(THEMES, themeSearchQuery);
      const row = themeRows[themeModalIndex];
      if (isEscapeKey(key)) {
        revertThemePreview();
        setShowThemeModal(false);
        setThemeSearchQuery("");
        return true;
      }
      if (key.name === "up") {
        const nextIdx = Math.max(0, themeModalIndex - 1);
        setThemeModalIndex(nextIdx);
        const nextRow = themeRows[nextIdx];
        if (nextRow) previewTheme(nextRow.descriptor.id);
        return true;
      }
      if (key.name === "down") {
        const nextIdx = Math.min(Math.max(0, themeRows.length - 1), themeModalIndex + 1);
        setThemeModalIndex(nextIdx);
        const nextRow = themeRows[nextIdx];
        if (nextRow) previewTheme(nextRow.descriptor.id);
        return true;
      }
      if (key.name === "return") {
        if (row) {
          applyTheme(row.descriptor.id);
          setShowThemeModal(false);
          setThemeSearchQuery("");
        }
        return true;
      }
      if (key.name === "backspace") {
        setThemeSearchQuery((q) => q.slice(0, -1));
        setThemeModalIndex(0);
        const firstRow = buildThemeRows(THEMES, themeSearchQuery.slice(0, -1))[0];
        if (firstRow) previewTheme(firstRow.descriptor.id);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        const nextQuery = themeSearchQuery + key.sequence;
        setThemeSearchQuery(nextQuery);
        setThemeModalIndex(0);
        const firstRow = buildThemeRows(THEMES, nextQuery)[0];
        if (firstRow) previewTheme(firstRow.descriptor.id);
        return true;
      }
      return true;
    }

    // ── Sessions modal ──
    if (modal.showSessionsModalRef.current) {
      const sessionRows = buildSessionsRows(modal.sessionsList, agent.getSessionId(), modal.sessionsSearchQuery);
      const row: SessionsRow | undefined = sessionRows[modal.sessionsModalIndex];
      if (isEscapeKey(key)) {
        modal.setShowSessionsModal(false);
        modal.setSessionsSearchQuery("");
        return true;
      }
      if (key.name === "tab") {
        const nextGlobal = !getFeatureFlag("sessions.scope.global");
        setFeatureFlag("sessions.scope.global", nextGlobal);
        const nextScope: "local" | "global" = nextGlobal ? "global" : "local";
        modal.setSessionsList(agent.listSessions({ limit: 200, scope: nextScope }));
        modal.setSessionsModalIndex(0);
        return true;
      }
      if (key.name === "up") {
        modal.setSessionsModalIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setSessionsModalIndex((i) => Math.min(Math.max(0, sessionRows.length - 1), i + 1));
        return true;
      }
      if (key.name === "return") {
        if (row) onResumeSession(row.session.id);
        return true;
      }
      if (key.name === "x" && key.ctrl) {
        if (row) onDeleteSession(row.session.id);
        return true;
      }
      if (key.name === "backspace") {
        modal.setSessionsSearchQuery((q) => q.slice(0, -1));
        modal.setSessionsModalIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setSessionsSearchQuery((q) => q + key.sequence);
        modal.setSessionsModalIndex(0);
        return true;
      }
      return true;
    }

    // ── Schedule modal ──
    if (modal.showScheduleModalRef.current) {
      const row: ScheduleBrowseRow | undefined = scheduleRows[modal.scheduleModalIndex];
      if (isEscapeKey(key)) {
        modal.setShowScheduleModal(false);
        modal.setScheduleSearchQuery("");
        return true;
      }
      if (key.name === "up") {
        modal.setScheduleModalIndex((index) => Math.max(0, index - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setScheduleModalIndex((index) => Math.min(Math.max(0, scheduleRows.length - 1), index + 1));
        return true;
      }
      if (key.name === "return") {
        if (row?.kind === "schedule") modalActions.showScheduleDetails(row.schedule);
        return true;
      }
      if (key.name === "x" && key.ctrl && row?.kind === "schedule") {
        modalActions.removeSchedule(row.schedule);
        return true;
      }
      if (key.name === "backspace") {
        modal.setScheduleSearchQuery((query) => query.slice(0, -1));
        modal.setScheduleModalIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setScheduleSearchQuery((query) => query + key.sequence);
        modal.setScheduleModalIndex(0);
        return true;
      }
      return true;
    }

    // ── Sub-agents modal (list browser, not editor) ──
    if (modal.showAgentsModalRef.current && !modal.showAgentsEditorRef.current) {
      const row: SubagentBrowseRow | undefined = agentRows[modal.agentsModalIndex];
      if (isEscapeKey(key)) {
        modal.setShowAgentsModal(false);
        modal.setShowAgentsEditor(false);
        modal.setAgentsSearchQuery("");
        modalActions.handleResetAgentsEditor();
        return true;
      }
      if (key.name === "up") {
        modal.setAgentsModalIndex((index) => Math.max(0, index - 1));
        return true;
      }
      if (key.name === "down") {
        modal.setAgentsModalIndex((index) => Math.min(Math.max(0, agentRows.length - 1), index + 1));
        return true;
      }
      if (key.name === "return") {
        if (row?.kind === "agent") modalActions.openSubagentEditor(row.agent);
        return true;
      }
      if (key.name === "a" && key.ctrl) {
        modalActions.openSubagentEditor(null);
        return true;
      }
      if (key.name === "backspace") {
        modal.setAgentsSearchQuery((query) => query.slice(0, -1));
        modal.setAgentsModalIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modal.setAgentsSearchQuery((query) => query + key.sequence);
        modal.setAgentsModalIndex(0);
        return true;
      }
      return true;
    }

    // ── Provider settings modal ──
    if (modalActions.providerSettingsState !== null) {
      const row: ProviderSettingRow | undefined = providerSettingsRows[modalActions.providerSettingsIndex];
      if (isEscapeKey(key)) {
        modalActions.closeProviderSettingsModal();
        return true;
      }
      if (key.name === "up") {
        modalActions.setProviderSettingsIndex((index) => Math.max(0, index - 1));
        return true;
      }
      if (key.name === "down") {
        modalActions.setProviderSettingsIndex((index) =>
          Math.min(Math.max(0, providerSettingsRows.length - 1), index + 1),
        );
        return true;
      }
      if (key.name === "left" || key.name === "right") {
        if (row?.setting.type === "select") {
          modalActions.applyProviderSettingRowAction(row, key.name === "right" ? 1 : -1);
        }
        return true;
      }
      if (key.name === "return") {
        if (row) modalActions.applyProviderSettingRowAction(row);
        return true;
      }
      if (key.name === "backspace") {
        modalActions.setProviderSettingsSearchQuery((query) => query.slice(0, -1));
        modalActions.setProviderSettingsIndex(0);
        return true;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        modalActions.setProviderSettingsSearchQuery((query) => query + key.sequence);
        modalActions.setProviderSettingsIndex(0);
        return true;
      }
      return true;
    }

    return false;
  };
}
