// Pets picker screen — single-pane selection list. Mirrors codex-rs's
// build_pet_picker_params at a smaller scope: a synthetic "Disable" entry
// pinned to the top, then all discovered custom pets sorted alphabetically.
// No side preview pane for MVP.

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createElement, useEffect, useMemo, useState } from "react";
import { getTheme } from "../../../../ui/themes/catalog";
import { loadUserSettings } from "../../../../utils/settings";
import type { ScreenContext } from "../../api";
import { DISABLED_PET_ID, listPetManifests, type PetManifest } from "./manifest";

export const PETS_PICKER_SCREEN_ID = "screen.pets-picker";

export interface PetsPickerProps {
  currentPetId?: string;
  /** Fired with the selected pet id, or DISABLED_PET_ID for the disable row. */
  onSelect: (petId: string) => void;
  /** Fired when the picker is dismissed without a selection (Esc). */
  onCancel?: () => void;
  /** Optional warning text shown above the list (e.g. unsupported terminal). */
  warning?: string;
}

interface Row {
  id: string;
  label: string;
  description?: string;
  /** Suffix shown next to the label, e.g. "(needs PNG)". */
  badge?: string;
}

/** Clip-or-pad a string to an exact column width. CRITICAL for overlays: every
 *  cell must be painted (opaque) so the transcript behind the panel can't bleed
 *  through transparent tail cells, and so long lines clip instead of wrapping.
 *  See memory: opentui overlay text bleed-through. */
function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function isPetsPickerProps(value: unknown): value is PetsPickerProps {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.onSelect === "function";
}

function buildRows(pets: PetManifest[]): Row[] {
  const rows: Row[] = [
    { id: DISABLED_PET_ID, label: "Disable terminal pet", description: "Hide the ambient pet for this session" },
  ];
  for (const pet of pets) {
    rows.push({
      id: pet.id,
      label: pet.displayName,
      description: pet.description,
      // WebP sources are sliced on first selection by pets/frames.ts —
      // brief one-time delay, then cached for re-use.
      badge: pet.spritesheetMime === "image/webp" ? "webp" : undefined,
    });
  }
  return rows;
}

function PetsPickerScreen({ ctx }: { ctx: ScreenContext }) {
  const { width, height } = useTerminalDimensions();
  const themeId = loadUserSettings().theme;
  const t = getTheme(themeId);
  const props = isPetsPickerProps(ctx.props) ? ctx.props : null;

  const rows = useMemo<Row[]>(() => buildRows(listPetManifests()), []);
  const initialIndex = useMemo(() => {
    if (!props?.currentPetId) return 0;
    const idx = rows.findIndex((r) => r.id === props.currentPetId);
    return idx >= 0 ? idx : 0;
  }, [props?.currentPetId, rows]);
  const [selected, setSelected] = useState(initialIndex);

  useEffect(() => {
    setSelected(initialIndex);
  }, [initialIndex]);

  useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "") {
      props?.onCancel?.();
      ctx.close();
      return;
    }
    if (rows.length === 0) return;
    if (key.name === "down" || key.sequence === "j") {
      setSelected((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (key.name === "up" || key.sequence === "k") {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "return" || key.sequence === "\r" || key.sequence === "\n") {
      const row = rows[selected];
      if (row) {
        props?.onSelect(row.id);
        ctx.close();
      }
    }
  });

  if (!props) return null;

  const overlayBg = "#000000cc";
  const panelWidth = Math.min(70, width - 4);
  const panelHeight = Math.min(20, height - 4);
  // Interior width inside the panel: border (1 each side) + padding (2 each
  // side) = 6. Every text line below is padded/clipped to this so all cells are
  // painted and nothing wraps. See memory: opentui overlay text bleed-through.
  const contentWidth = Math.max(20, panelWidth - 6);

  // Window the list around the selected row. opentui paints every flex
  // child even when the column overflows, causing previous rows' cells
  // to bleed through subsequent rows — so we slice to fit.
  //
  // Panel interior accounts (lines):
  //   header (1) + header marginBottom (1) = 2
  //   footer marginTop (1) + description (1) + roots (1) = 3
  //   paddingTop + paddingBottom = 2
  //   window-hint placeholders (2, even when empty so the layout doesn't
  //   shift as the cursor moves through the list) = 2
  // -> rows available = panelHeight - 9
  const visibleRowCount = Math.max(3, panelHeight - 9);
  const half = Math.floor(visibleRowCount / 2);
  const windowStart = Math.min(Math.max(0, rows.length - visibleRowCount), Math.max(0, selected - half));
  const windowEnd = Math.min(rows.length, windowStart + visibleRowCount);
  const visibleRows = rows.slice(windowStart, windowEnd);
  const above = windowStart;
  const below = rows.length - windowEnd;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
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
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <text fg={t.primary}>
            <b>{"Select Pet"}</b>
          </text>
          <text fg={t.textMuted}>{"j/k move · enter select · esc cancel"}</text>
        </box>
        {props.warning ? (
          <box flexShrink={0} marginBottom={1}>
            <text fg={t.textMuted} wrapMode="word">
              {props.warning}
            </text>
          </box>
        ) : null}
        <box flexDirection="column" flexGrow={1}>
          {/* Top scroll hint — always rendered (as a blank full-width line when
              no rows above) so the layout doesn't reflow as the user moves.
              Opaque bg + full-width pad so nothing bleeds/wraps. */}
          <text bg={t.backgroundPanel} fg={t.textMuted} wrapMode="none">
            {pad(above > 0 ? `  ↑ ${above} more` : "", contentWidth)}
          </text>
          {visibleRows.map((row) => {
            const absIdx = windowStart + visibleRows.indexOf(row);
            const active = absIdx === selected;
            const isCurrent = props.currentPetId === row.id;
            const suffix = `${row.badge ? `  (${row.badge})` : ""}${isCurrent ? "  (current)" : ""}`;
            // One <text> per row: opaque bg + clip/pad to contentWidth so the
            // row never wraps and the tail can't bleed the transcript through.
            const rowBg = active ? t.backgroundElement : t.backgroundPanel;
            const rowText = `${active ? "> " : "  "}${row.label}${suffix}`;
            return (
              <box key={row.id} flexDirection="row" overflow="hidden">
                <text bg={rowBg} fg={active ? t.accent : t.text} wrapMode="none">
                  {pad(rowText, contentWidth)}
                </text>
              </box>
            );
          })}
          <text bg={t.backgroundPanel} fg={t.textMuted} wrapMode="none">
            {pad(below > 0 ? `  ↓ ${below} more` : "", contentWidth)}
          </text>
        </box>
        <box flexShrink={0} flexDirection="column" marginTop={1}>
          <text bg={t.backgroundPanel} fg={t.textMuted} wrapMode="none">
            {pad(rows[selected]?.description ?? "", contentWidth)}
          </text>
          <text bg={t.backgroundPanel} fg={t.textMuted} wrapMode="none">
            {pad(
              `${rows.length} pet${rows.length === 1 ? "" : "s"} · $CODEX_HOME/pets · ~/.grok/pets · ~/.codesurf/pets`,
              contentWidth,
            )}
          </text>
        </box>
      </box>
    </box>
  );
}

export function renderPetsPickerScreen(ctx: ScreenContext) {
  return createElement(PetsPickerScreen, { ctx });
}
