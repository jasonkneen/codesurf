import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { Theme } from "./theme";
import type { ThemeDescriptor } from "./themes/catalog";

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export interface ThemeRow {
  descriptor: ThemeDescriptor;
}

export function buildThemeRows(themes: readonly ThemeDescriptor[], query: string): ThemeRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? themes.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.kind.includes(q),
      )
    : themes;
  return filtered.map((descriptor) => ({ descriptor }));
}

export function ThemePickerModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
  currentThemeId,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: ThemeRow[];
  currentThemeId: string;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`theme-${selected.descriptor.id}`);
  }, [rows, selectedIndex]);

  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount * 2 + 7;
  const maxHeight = Math.floor(height * 0.68);
  const panelHeight = Math.min(contentHeight, maxHeight);
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
        width={Math.min(96, width - 4)}
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
            <b>{"Theme"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>{searchQuery || <span style={{ fg: t.textMuted }}>{"Search themes..."}</span>}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>{"No themes match your search."}</text>
            </box>
          ) : (
            rows.map((row, idx) => {
              const selected = idx === selectedIndex;
              const descriptor = row.descriptor;
              const isCurrent = descriptor.id === currentThemeId;
              const name = descriptor.name;
              const fg = isCurrent ? t.accent : selected ? t.selected : t.text;
              // Preview swatches: use the candidate theme's own colors to
              // give an at-a-glance look-feel.
              const preview = descriptor.theme;
              return (
                <box
                  key={`theme-${descriptor.id}`}
                  id={`theme-${descriptor.id}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={fg}>
                      {isCurrent ? "\u25cf " : "  "}
                      {name}
                    </text>
                    <box flexDirection="row">
                      <text fg={preview.accent}>{"\u2588"}</text>
                      <text fg={preview.diffAddedFg}>{"\u2588"}</text>
                      <text fg={preview.diffRemovedFg}>{"\u2588"}</text>
                      <text fg={preview.mdBold}>{"\u2588"}</text>
                      <text fg={preview.textMuted}>{"  "}</text>
                      <text fg={t.textMuted}>{descriptor.kind}</text>
                    </box>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.textMuted}>{descriptor.description}</text>
                    <text fg={t.textMuted}>{descriptor.id}</text>
                  </box>
                </box>
              );
            })
          )}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"apply  \u00b7  "}</span>
            <span style={{ fg: t.primary }}>{"type "}</span>
            <span style={{ fg: t.textMuted }}>{"filter  \u00b7  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
