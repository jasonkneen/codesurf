// Feature Flags browser modal — mirrors ExtensionsBrowserModal in look and
// keyboard surface. Each row renders the standard ToggleSwitch plus a
// "YES"/"NO" pill, so users can see the binary state at a glance.
//
// Wrapping discipline: every <text> inside a fixed-row layout uses
// `wrapMode="none"` so long strings clip instead of wrapping. Without
// this, a long description grows the row by 2–3 lines, the
// scrollbox-inside-panel height math under-allocates content space, and
// the modal silently shows only one row. Truncate before render — never
// rely on the renderer to "just figure it out".

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { truncate } from "../utils/text";
import { ToggleSwitch } from "./controls/toggle-switch";
import type { FeatureFlagRow } from "./feature-flags";
import type { Theme } from "./theme";

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function FeatureFlagsModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: FeatureFlagRow[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`flag-${selected.descriptor.id}`);
  }, [rows, selectedIndex]);

  // Panel sizing. Each row is exactly 2 lines because every <text> uses
  // wrapMode="none". Chrome breakdown: borders 2 + panel padding 2 +
  // header 1 + search 3 (with its own padding) + footer 3 (with its own
  // padding) = 11. Give it 12 for safety. We let the panel grow up to
  // 90% of the screen so all rows fit when there's room.
  const panelWidth = Math.min(96, width - 4);
  const innerWidth = Math.max(20, panelWidth - 4); // panel internal width (paddingLeft+paddingRight=4)
  const chromeLines = 12;
  const rowLines = 2;
  const itemCount = Math.max(rows.length, 1);
  const idealHeight = itemCount * rowLines + chromeLines;
  const maxHeight = Math.max(idealHeight, Math.floor(height * 0.9));
  const panelHeight = Math.min(idealHeight, maxHeight);

  // Row 1: [toggle 4] + space + label .................... id (gray)  YES/NO
  // Row 2: description (full width, clipped)
  // toggle = 4 chars + 1 gap. Reserve 8 chars right for " YES" or " NO " + id.
  const labelBudget = Math.max(8, innerWidth - 5 - 14); // 5 toggle+gap, 14 right-side
  const descBudget = Math.max(8, innerWidth);
  const idBudget = Math.max(6, Math.floor(innerWidth / 3));

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
            <b>{"Feature Flags"}</b>
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {"esc"}
          </text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text} wrapMode="none">
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search flags..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted} wrapMode="none">
                {searchQuery ? "No flags match your search." : "No feature flags registered."}
              </text>
            </box>
          ) : (
            rows.map((row, idx) => {
              const selected = idx === selectedIndex;
              const { descriptor, value } = row;
              const labelColor = value ? t.diffAddedFg : selected ? t.selected : t.text;
              return (
                <box
                  key={`flag-${descriptor.id}`}
                  id={`flag-${descriptor.id}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                  flexDirection="column"
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <box flexDirection="row" gap={1}>
                      <ToggleSwitch t={t} value={value} selected={selected} />
                      <text fg={labelColor} wrapMode="none">
                        {truncate(descriptor.label, labelBudget)}
                      </text>
                    </box>
                    <text fg={value ? t.diffAddedFg : t.textMuted} wrapMode="none">
                      {value ? " YES" : " NO "}
                    </text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.textMuted} wrapMode="none">
                      {truncate(descriptor.description, descBudget - idBudget - 3)}
                    </text>
                    <text fg={t.textMuted} wrapMode="none">
                      {truncate(descriptor.id, idBudget)}
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
            <span style={{ fg: t.textMuted }}>{"toggle  ·  "}</span>
            <span style={{ fg: t.primary }}>{"space "}</span>
            <span style={{ fg: t.textMuted }}>{"toggle  ·  "}</span>
            <span style={{ fg: t.primary }}>{"type "}</span>
            <span style={{ fg: t.textMuted }}>{"filter  ·  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
