import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { type RefObject, useEffect, useRef } from "react";
import type { RegisteredSetting } from "../core/plugins";
import { truncate } from "../utils/text";
import { ToggleSwitch } from "./controls/toggle-switch";
import type { Theme } from "./theme";

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export interface ProviderSettingRow {
  setting: RegisteredSetting;
  value: unknown;
}

export function settingDisplayValue(setting: RegisteredSetting, value: unknown): string {
  const resolved = value ?? setting.default;
  if (setting.type === "boolean") return resolved === true ? "on" : "off";
  if (setting.type === "secret") return typeof resolved === "string" && resolved.length > 0 ? "******" : "(empty)";
  if (setting.type === "select") {
    const raw = String(resolved ?? "");
    return setting.options?.find((option) => option.value === raw)?.label ?? raw;
  }
  return String(resolved ?? "");
}

export function coerceSettingInput(setting: RegisteredSetting, raw: string): string | number {
  const trimmed = raw.trim();
  if (setting.type === "number") {
    const value = Number(trimmed);
    if (!Number.isFinite(value)) throw new Error("Enter a valid number.");
    return value;
  }
  return trimmed;
}

export function nextSelectValue(setting: RegisteredSetting, current: unknown, direction: 1 | -1): string | undefined {
  if (setting.type !== "select" || !setting.options || setting.options.length === 0) return undefined;
  const currentValue = String(current ?? setting.default ?? setting.options[0]?.value ?? "");
  const currentIndex = Math.max(
    0,
    setting.options.findIndex((option) => option.value === currentValue),
  );
  const nextIndex = (currentIndex + direction + setting.options.length) % setting.options.length;
  return setting.options[nextIndex]?.value;
}

export function ProviderSettingsModal({
  t,
  width,
  height,
  title,
  rows,
  selectedIndex,
  searchQuery,
}: {
  t: Theme;
  width: number;
  height: number;
  title: string;
  rows: ProviderSettingRow[];
  selectedIndex: number;
  searchQuery: string;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`provider-setting-${selected.setting.key}`);
  }, [rows, selectedIndex]);

  const panelWidth = Math.min(96, width - 4);
  const innerWidth = Math.max(20, panelWidth - 4);
  const chromeLines = 12;
  const rowLines = 2;
  const itemCount = Math.max(rows.length, 1);
  const idealHeight = itemCount * rowLines + chromeLines;
  const panelHeight = Math.min(idealHeight, Math.max(18, Math.floor(height * 0.82)));
  const labelBudget = Math.max(12, Math.floor(innerWidth * 0.44));
  const valueBudget = Math.max(12, Math.floor(innerWidth * 0.28));
  const descBudget = Math.max(12, innerWidth - 4);
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
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
          <text fg={t.primary} wrapMode="none">
            <b>{title}</b>
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {"esc"}
          </text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text} wrapMode="none">
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search settings..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted} wrapMode="none">
                {searchQuery ? "No settings match your search." : "No settings registered for this provider."}
              </text>
            </box>
          ) : (
            rows.map((row, idx) => {
              const selected = idx === selectedIndex;
              const { setting, value } = row;
              const canInlineToggle = setting.type === "boolean";
              return (
                <box
                  key={setting.key}
                  id={`provider-setting-${setting.key}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                  flexDirection="column"
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <box flexDirection="row" gap={1}>
                      {canInlineToggle ? <ToggleSwitch t={t} value={value === true} selected={selected} /> : null}
                      <text fg={selected ? t.selected : t.text} wrapMode="none">
                        {truncate(setting.title, labelBudget)}
                      </text>
                    </box>
                    <text fg={selected ? t.primary : t.textMuted} wrapMode="none">
                      {truncate(settingDisplayValue(setting, value), valueBudget)}
                    </text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.textMuted} wrapMode="none">
                      {truncate(setting.description ?? setting.key, descBudget)}
                    </text>
                    <text fg={t.textMuted} wrapMode="none">
                      {setting.type}
                    </text>
                  </box>
                </box>
              );
            })
          )}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text wrapMode="none">
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"edit/toggle  |  "}</span>
            <span style={{ fg: t.primary }}>{"left/right "}</span>
            <span style={{ fg: t.textMuted }}>{"select option  |  "}</span>
            <span style={{ fg: t.primary }}>{"type "}</span>
            <span style={{ fg: t.textMuted }}>{"filter  |  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

export function ProviderSettingEditModal({
  t,
  width,
  height,
  setting,
  inputRef,
  syncKey,
  error,
  onSubmit,
}: {
  t: Theme;
  width: number;
  height: number;
  setting: RegisteredSetting;
  inputRef: RefObject<TextareaRenderable | null>;
  syncKey: number;
  error: string | null;
  onSubmit: () => void;
}) {
  const panelHeight = Math.min(15, Math.floor(height * 0.55));
  const overlayBg = "#000000cc" as string;

  // biome-ignore lint/correctness/useExhaustiveDependencies: syncKey intentionally clears stale modal input
  useEffect(() => {
    inputRef.current?.clear();
  }, [syncKey, inputRef]);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(76, width - 6)}
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
          <text fg={t.primary} wrapMode="none">
            <b>{`Edit ${setting.title}`}</b>
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {"esc"}
          </text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.textMuted} wrapMode="none">
            {setting.description ?? setting.key}
          </text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text fg={t.primary} wrapMode="none">
            {setting.type === "secret" ? "Secret value" : "Value"}
          </text>
          <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
            <textarea
              ref={inputRef}
              focused={true}
              placeholder={setting.type === "number" ? String(setting.default ?? 0) : String(setting.default ?? "")}
              textColor={t.text}
              backgroundColor={t.backgroundElement}
              placeholderColor={t.textMuted}
              minHeight={1}
              maxHeight={2}
              wrapMode="word"
              keyBindings={[{ name: "return", action: "submit" }]}
              onSubmit={onSubmit as unknown as () => void}
            />
          </box>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg} wrapMode="none">
              {error}
            </text>
          ) : (
            <text wrapMode="none">
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"save  |  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"cancel"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
