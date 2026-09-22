import type { KeyEvent } from "@opentui/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getHostServices as kernelGetHostServices, type RegisteredModel, useIcon } from "../core/plugins";
import { getEffectiveReasoningEffort, normalizeModelId } from "../grok/models";
import type { ReasoningEffort } from "../types/index";
import { ListPicker } from "./controls/list-picker";
import { useFlushedKeyboard } from "./hooks/use-flushed-keyboard.js";
import {
  buildFlatModelRows,
  currentFlatModelIndex,
  flatModelPickerRowKey,
  isCurrentFlatModelRow,
  type ModelPickerModelRow,
  nextFlatModelRowIndex,
  type ProviderMeta,
} from "./model-picker-rows";
import type { Theme } from "./theme";

interface ModelPickerModalProps {
  t: Theme;
  width: number;
  height: number;
  currentModel: string;
  currentAdapterId?: string | null;
  onClose: () => void;
  onSelect: (modelId: string, adapterId: string) => void;
  onOpenProviderAuth: (params: { adapterId: string; modelId: string; modelName: string }) => void;
  onAdjustReasoningEffort: (row: ModelPickerModelRow, direction: -1 | 1) => void;
  onOpenProviderSettings: (adapterId: string, title: string) => void;
  kernelModels: readonly RegisteredModel[];
  providers: readonly ProviderMeta[];
  adapters?: ReadonlyArray<{
    id: string;
    label: string;
    transport?: string;
    connectionMode?: string;
    sessionStrategy?: string;
    authMode?: string;
  }>;
  credentials: Record<string, boolean>;
  reasoningEffortControls?: ReadonlyArray<{
    adapterId: string;
    settingKey: string;
    values: readonly string[];
    currentValue?: string;
    defaultValue?: string;
  }>;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  model: string;
  activeModelAdapterId: string;
}

function isEscapeKey(key: KeyEvent): boolean {
  return (
    key.name === "escape" ||
    key.code === "Escape" ||
    key.baseCode === 27 ||
    key.sequence === "\u001b" ||
    key.raw === "\u001b"
  );
}

function formatContextWindow(contextWindow?: number): string | null {
  if (!contextWindow) return null;
  if (contextWindow >= 1_000_000) return `${contextWindow / 1_000_000}M ctx`;
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K ctx`;
  return `${contextWindow} ctx`;
}

function formatCapabilities(row: ModelPickerModelRow): string {
  const parts: string[] = [];
  const context = formatContextWindow(row.contextWindow);
  if (context) parts.push(context);
  if (row.capabilities?.tools) parts.push("tools");
  if (row.capabilities?.images) parts.push("vision");
  if (row.capabilities?.reasoning) parts.push("reasoning");
  if (row.adapterConnectionMode === "persistent") parts.push("persistent");
  return parts.join(" · ");
}

function formatAdapterDetails(row: ModelPickerModelRow): string {
  const parts = [row.adapterTransport, row.adapterSessionStrategy, row.authMode].filter(
    (part): part is string => !!part,
  );
  return parts.join(" · ");
}

export function ModelPickerModal(props: ModelPickerModalProps) {
  const {
    t,
    width,
    height,
    currentModel,
    currentAdapterId,
    onClose,
    onSelect,
    onOpenProviderAuth,
    onAdjustReasoningEffort,
    onOpenProviderSettings,
    kernelModels,
    providers,
    adapters,
    credentials,
    reasoningEffortControls,
    reasoningEffortByModel,
    model,
    activeModelAdapterId,
  } = props;

  const modelsIcon = useIcon("models");
  const searchIcon = useIcon("search");

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;
  const searchQueryRef = useRef("");
  searchQueryRef.current = searchQuery;

  const rows = useMemo(
    () =>
      buildFlatModelRows({
        kernelModels,
        providers,
        adapters,
        credentials,
        reasoningEffortControls,
        query: searchQuery,
      }),
    [kernelModels, providers, adapters, credentials, reasoningEffortControls, searchQuery],
  );

  // Set initial index to current model on mount
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const idx = currentFlatModelIndex(rows, { modelId: model, adapterId: activeModelAdapterId });
    setSelectedIndex(idx);
  }, [rows, model, activeModelAdapterId]);

  // Clamp / adjust index when rows change (e.g. search filtering)
  useEffect(() => {
    setSelectedIndex((idx) => {
      if (rows[idx]?.kind === "model") return idx;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].kind === "model") return i;
      }
      return 0;
    });
  }, [rows]);

  const selectedRow = rows[selectedIndex];
  const selectedModel: ModelPickerModelRow | undefined = selectedRow?.kind === "model" ? selectedRow : undefined;
  const selectedSupportsReasoning = !!selectedModel && selectedModel.supportedReasoningEfforts.length > 0;
  const selectedNeedsAuth = !!selectedModel && !selectedModel.credentialsReady;

  const selectedAdapterHasSettings = useMemo(() => {
    if (!selectedModel?.adapterId) return false;
    const ks = kernelGetHostServices();
    const provider = ks.models.getProvider(selectedModel.adapterId);
    if (!provider) return false;
    return ks.settings.list().some((s) => s.pluginId === provider.pluginId);
  }, [selectedModel?.adapterId]);

  const handleKey = useCallback(
    (key: KeyEvent) => {
      key.preventDefault?.();
      key.stopPropagation?.();

      if (isEscapeKey(key)) {
        onClose();
        return;
      }
      if (key.name === "up") {
        setSelectedIndex((i) => nextFlatModelRowIndex(rows, i, -1));
        return;
      }
      if (key.name === "down") {
        setSelectedIndex((i) => nextFlatModelRowIndex(rows, i, 1));
        return;
      }
      if (key.name === "left" || key.name === "right") {
        if (selectedModel) {
          onAdjustReasoningEffort(selectedModel, key.name === "left" ? -1 : 1);
        }
        return;
      }
      if (key.name === "tab") {
        if (selectedModel?.adapterId && selectedAdapterHasSettings) {
          const ks = kernelGetHostServices();
          const provider = ks.models.getProvider(selectedModel.adapterId);
          if (provider) {
            onOpenProviderSettings(selectedModel.adapterId, `${provider.label} settings`);
          }
        }
        return;
      }
      if (key.name === "return") {
        if (!selectedModel) return;
        if (!selectedModel.credentialsReady && selectedModel.adapterId) {
          onOpenProviderAuth({
            adapterId: selectedModel.adapterId,
            modelId: selectedModel.id,
            modelName: selectedModel.name,
          });
        } else {
          onSelect(selectedModel.id, selectedModel.adapterId ?? "");
        }
        onClose();
        return;
      }
      if (key.name === "backspace") {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + key.sequence);
        return;
      }
    },
    [
      rows,
      selectedModel,
      selectedAdapterHasSettings,
      onClose,
      onSelect,
      onOpenProviderAuth,
      onAdjustReasoningEffort,
      onOpenProviderSettings,
    ],
  );

  useFlushedKeyboard(handleKey);

  const itemCount = Math.max(rows.length, 1);
  const chromeRows = 10;
  const maxH = Math.max(chromeRows + 1, Math.floor(height * 0.8));
  const rowHeight = 2;
  const availableListRows = Math.max(1, Math.floor((maxH - chromeRows) / rowHeight));
  const visibleListRows = Math.max(1, Math.min(itemCount, availableListRows));
  const panelHeight = Math.min(visibleListRows * rowHeight + chromeRows, maxH);
  const top = Math.max(2, Math.floor((height - panelHeight) / 2));
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(60, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={t.accent}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>
              {modelsIcon ? `${modelsIcon} ` : ""}
              {"Select model"}
            </b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>
            {searchIcon ? `${searchIcon} ` : ""}
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search..."}</span>}
          </text>
        </box>
        <ListPicker
          t={t}
          items={rows}
          selectedIndex={selectedIndex}
          onSelectIndex={() => {
            /* selection driven by host key handler */
          }}
          getKey={flatModelPickerRowKey}
          bordered={false}
          marginBottom={0}
          rowHeight={rowHeight}
          maxVisibleItems={visibleListRows}
          emptyLabel="No models match your search"
          renderItem={({ item: row, selected }) => {
            if (row.kind === "header") {
              return (
                <box paddingLeft={2} paddingRight={2} paddingTop={0}>
                  <text fg={t.primary}>
                    <b>{row.label}</b>
                  </text>
                </box>
              );
            }
            const current = isCurrentFlatModelRow(row, {
              modelId: currentModel,
              adapterId: currentAdapterId,
            });
            const supportedReasoningEfforts = row.supportedReasoningEfforts;
            const reasoningEffort =
              row.reasoningEffortValue ??
              getEffectiveReasoningEffort(row.id, reasoningEffortByModel[normalizeModelId(row.id)]) ??
              row.reasoningEffortDefault ??
              "auto";
            const needsAuth = !row.credentialsReady;
            const adapterTag = row.adapterLabel;
            const capabilities = formatCapabilities(row);
            const adapterDetails = formatAdapterDetails(row);
            return (
              <box
                id={`model-${row.adapterId ?? ""}-${row.id}`}
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={4}
                paddingRight={2}
                width="100%"
                flexDirection="column"
              >
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={current ? t.accent : selected ? t.selected : needsAuth ? t.textMuted : t.text}>
                    {current ? "● " : needsAuth ? "□ " : "  "}
                    {row.name}
                    {adapterTag ? <span style={{ fg: t.textMuted }}>{` · ${adapterTag}`}</span> : null}
                  </text>
                  <box flexDirection="row">
                    {needsAuth ? (
                      <text fg={selected ? t.primary : t.textMuted}>{"auth needed"}</text>
                    ) : supportedReasoningEfforts.length > 0 ? (
                      <text fg={selected ? t.primary : t.textMuted}>{`[${reasoningEffort}]`}</text>
                    ) : null}
                  </box>
                </box>
                {selected && (capabilities || adapterDetails || row.description) ? (
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.textMuted} wrapMode="none">
                      {capabilities || row.description || ""}
                    </text>
                    <text fg={t.textMuted} wrapMode="none">
                      {adapterDetails}
                    </text>
                  </box>
                ) : null}
              </box>
            );
          }}
        />
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>
            {selectedNeedsAuth
              ? "enter configure  esc close"
              : selectedSupportsReasoning
                ? `left/right reasoning  enter select${selectedAdapterHasSettings ? "  tab settings" : ""}  esc close`
                : `enter select${selectedAdapterHasSettings ? "  tab settings" : ""}  esc close`}
          </text>
        </box>
      </box>
    </box>
  );
}
