// CommandPalette — ctrl+k palette restyled to match opencode's command
// palette: a quiet bold "Commands" title with an `esc` hint, a plain dim
// "Search" line (no heavy bordered input), magenta/purple section headers
// with a leading "Suggested" group, dim inline descriptions, right-aligned
// muted shortcut/source, and a warm peach/tan full-width selection bar with
// dark text. Renders inside an absolute overlay panel with a subtle border.
//
// Selection model: group headers are NON-selectable. `selectedIndex` and the
// confirm/select callbacks index into the FLAT list of selectable actions
// (`model.actions`), never the display rows. `buildCommandPaletteModel` is a
// pure function (actions + query -> ordered display rows + selectable actions)
// and is unit-tested in command-palette.test.ts.
//
// OpenTUI rendering: every row is a SINGLE <text> with an opaque `bg` and is
// padded to the full panel width (one <text> per row with spans, never
// sibling <text> in a flex row) — this prevents the transcript from bleeding
// through gaps in the overlay. Colors come from the Theme.

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { Theme } from "./theme";

export const SUGGESTED_PALETTE_IDS = new Set<string>([
  "models",
  "init",
  "agents",
  "extensions",
  "mcp",
  "sessions",
  "themes",
  "help",
]);

export interface CommandPaletteAction {
  id: string;
  label: string;
  description?: string;
  /** Right-aligned source label e.g. "Agent", "Extension", "UI". */
  source?: string;
  /** Keyboard shortcut shown right-aligned (preferred over `source`). */
  shortcut?: string;
  /** When true, grouped under the leading "Suggested" section (empty query). */
  suggested?: boolean;
}

/** A row in the rendered palette — either a non-selectable section header or a
 *  selectable action carrying its index into the flat `actions` array. */
export type CommandPaletteRow =
  | { kind: "header"; label: string }
  | { kind: "action"; action: CommandPaletteAction; actionIndex: number };

export interface CommandPaletteModel {
  /** Display rows in render order (headers interleaved with actions). */
  rows: CommandPaletteRow[];
  /** Selectable actions in display order; `selectedIndex` maps into this. */
  actions: CommandPaletteAction[];
}

export interface BuildCommandPaletteModelOptions {
  /** Virtual "ask the agent" row pinned to the top of the flat search list. */
  leadingAction?: CommandPaletteAction;
  /** Header for the suggested group (default "Suggested"). */
  suggestedHeader?: string;
  /** Header for the remaining commands group (default "Commands"). */
  commandsHeader?: string;
}

/** Filter primitive: empty/whitespace query => full list, else case-insensitive
 *  match against label, id, and description. */
export function buildCommandPaletteRows(
  actions: readonly CommandPaletteAction[],
  query: string,
): CommandPaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...actions];
  return actions.filter((a) => {
    return (
      a.label.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      (a.description?.toLowerCase().includes(q) ?? false)
    );
  });
}

/**
 * Pure builder for the palette display model.
 *
 * - Non-empty query => FLAT filtered list (no headers), with `leadingAction`
 *   (if provided) pinned at index 0. Matches opencode's search behaviour.
 * - Empty query => grouped/sectioned view: a leading "Suggested" group (tagged
 *   actions) followed by the remaining "Commands" group. Empty groups are
 *   omitted. Header rows are non-selectable; action rows carry an `actionIndex`
 *   that indexes into the returned `actions` array.
 *
 * Invariant: `actions` lists exactly the selectable rows in display order, so a
 * `selectedIndex` always resolves to an action and never a header.
 */
export function buildCommandPaletteModel(
  actions: readonly CommandPaletteAction[],
  query: string,
  options: BuildCommandPaletteModelOptions = {},
): CommandPaletteModel {
  const { leadingAction, suggestedHeader = "Suggested", commandsHeader = "Commands" } = options;
  const q = query.trim();

  // FLAT search mode — no section headers, leading "ask" row first.
  if (q !== "") {
    const filtered = buildCommandPaletteRows(actions, query);
    const selectable = leadingAction ? [leadingAction, ...filtered] : filtered;
    return {
      rows: selectable.map((action, actionIndex) => ({ kind: "action", action, actionIndex }) as const),
      actions: selectable,
    };
  }

  // GROUPED mode — Suggested first, then the rest.
  const suggested = actions.filter((a) => a.suggested);
  const rest = actions.filter((a) => !a.suggested);
  const ordered: CommandPaletteAction[] = [...suggested, ...rest];

  const rows: CommandPaletteRow[] = [];
  let actionIndex = 0;
  for (const group of [
    { header: suggestedHeader, items: suggested },
    { header: commandsHeader, items: rest },
  ]) {
    if (group.items.length === 0) continue;
    rows.push({ kind: "header", label: group.header });
    for (const action of group.items) {
      rows.push({ kind: "action", action, actionIndex });
      actionIndex += 1;
    }
  }

  return { rows, actions: ordered };
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

// ── Full-width single-<text> row helpers ────────────────────────────────────
// One <text> per row, opaque bg, padded to the full content width. Segments
// carry their own fg; the optional right segments are flush to the right edge.

interface Seg {
  text: string;
  fg: string;
  bold?: boolean;
}

function segLen(segs: Seg[]): number {
  let n = 0;
  for (const s of segs) n += s.text.length;
  return n;
}

/** Clip segments to a max visible width, ellipsising the overflow. */
function fitSegments(segs: Seg[], max: number): Seg[] {
  if (max <= 0) return [];
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= max) break;
    const room = max - used;
    if (s.text.length <= room) {
      out.push(s);
      used += s.text.length;
    } else {
      const cut = Math.max(0, room - 1);
      out.push({ ...s, text: `${s.text.slice(0, cut)}…` });
      used = max;
      break;
    }
  }
  return out;
}

// Thread the row `bg` into every span so each segment is opaque regardless of
// how the renderer inherits a parent <text bg> behind per-span `fg` overrides —
// this is what guarantees no transcript bleed through glyph cells in the bar.
function renderSegs(segs: Seg[], keyPrefix: string, bg: string) {
  return segs.map((s, i) =>
    s.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
      <span key={`${keyPrefix}-${i}`} style={{ fg: s.fg, bg }}>
        <b>{s.text}</b>
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
      <span key={`${keyPrefix}-${i}`} style={{ fg: s.fg, bg }}>
        {s.text}
      </span>
    ),
  );
}

/** A single full-width row: left segments, padding, then right segments flush
 *  right — all under one opaque-bg <text>. */
function FullWidthRow({
  width,
  bg,
  left,
  right = [],
  keyPrefix,
}: {
  width: number;
  bg: string;
  left: Seg[];
  right?: Seg[];
  keyPrefix: string;
}) {
  const rightLen = segLen(right);
  const leftBudget = Math.max(0, width - rightLen - (right.length ? 1 : 0));
  const fittedLeft = fitSegments(left, leftBudget);
  const usedLeft = segLen(fittedLeft);
  const pad = Math.max(right.length ? 1 : 0, width - usedLeft - rightLen);
  return (
    <text bg={bg} wrapMode="none">
      {renderSegs(fittedLeft, `${keyPrefix}-l`, bg)}
      <span style={{ bg }}>{" ".repeat(pad)}</span>
      {renderSegs(right, `${keyPrefix}-r`, bg)}
    </text>
  );
}

function BlankRow({ width, bg }: { width: number; bg: string }) {
  return (
    <text bg={bg} wrapMode="none">
      {" ".repeat(width)}
    </text>
  );
}

export function CommandPaletteModal({
  t,
  width,
  height,
  searchQuery,
  model,
  selectedIndex,
  onSelectIndex,
  onConfirm,
}: {
  t: Theme;
  width: number;
  height: number;
  searchQuery: string;
  model: CommandPaletteModel;
  /** Index into model.actions (selectable rows only). */
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onConfirm: (index: number) => void;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const { rows, actions } = model;

  useEffect(() => {
    const action = actions[selectedIndex];
    if (!action) return;
    listRef.current?.scrollChildIntoView(`action-${action.id}`);
  }, [actions, selectedIndex]);

  const panelWidth = Math.min(96, width - 4);
  // Inside the panel: border (1 each side) + padding (1 each side).
  const contentWidth = Math.max(8, panelWidth - 4);
  // Visual lines = display rows + a blank line before every header after the
  // first row + title + search + a blank gap.
  const extraBlanks = rows.reduce((n, r, i) => (r.kind === "header" && i > 0 ? n + 1 : n), 0);
  const visualRows = rows.length + extraBlanks;
  const panelHeight = Math.min(Math.max(12, visualRows + 5), Math.floor(height * 0.68));
  const top = bottomAlignedModalTop(height, panelHeight);
  const panelBg = t.backgroundPanel;

  return (
    <box position="absolute" left={0} top={0} width={width} height={height} alignItems="center" paddingTop={top}>
      <box
        flexDirection="column"
        width={panelWidth}
        height={panelHeight}
        border
        borderStyle="rounded"
        borderColor={t.border}
        backgroundColor={panelBg}
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Title: bold "Commands" left, muted esc hint right */}
        <box flexShrink={0} height={1}>
          <FullWidthRow
            width={contentWidth}
            bg={panelBg}
            left={[{ text: "Commands", fg: t.text, bold: true }]}
            right={[{ text: "esc", fg: t.textMuted }]}
            keyPrefix="title"
          />
        </box>
        {/* Quiet search line — dim placeholder, no bordered input box */}
        <box flexShrink={0} height={1} marginBottom={1}>
          <FullWidthRow
            width={contentWidth}
            bg={panelBg}
            left={[searchQuery ? { text: searchQuery, fg: t.text } : { text: "Search", fg: t.textMuted }]}
            keyPrefix="search"
          />
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
          {rows.length === 0 ? (
            <FullWidthRow
              width={contentWidth}
              bg={panelBg}
              left={[{ text: "No matches.", fg: t.textMuted }]}
              keyPrefix="empty"
            />
          ) : (
            rows.map((row, idx) => {
              if (row.kind === "header") {
                return (
                  <box key={`header-${row.label}`} flexDirection="column" flexShrink={0}>
                    {idx > 0 && <BlankRow width={contentWidth} bg={panelBg} />}
                    <FullWidthRow
                      width={contentWidth}
                      bg={panelBg}
                      left={[{ text: row.label, fg: t.commandPaletteHeader, bold: true }]}
                      keyPrefix={`header-${row.label}`}
                    />
                  </box>
                );
              }
              const { action, actionIndex } = row;
              const selected = actionIndex === selectedIndex;
              const rowBg = selected ? t.commandPaletteSelectedBg : panelBg;
              const labelFg = selected ? t.commandPaletteSelectedFg : action.id === "__ask__" ? t.primary : t.text;
              const descFg = selected ? t.commandPaletteSelectedFg : t.textMuted;
              const rightFg = selected ? t.commandPaletteSelectedFg : t.textMuted;
              const left: Seg[] = [{ text: ` ${action.label}`, fg: labelFg, bold: selected }];
              if (action.description) left.push({ text: `  ${action.description}`, fg: descFg });
              const rightText = action.shortcut ?? action.source ?? "";
              const right: Seg[] = rightText ? [{ text: rightText, fg: rightFg }] : [];
              return (
                <box
                  key={`action-${action.id}`}
                  id={`action-${action.id}`}
                  flexShrink={0}
                  onMouseMove={() => onSelectIndex(actionIndex)}
                  onMouseDown={() => onConfirm(actionIndex)}
                >
                  <FullWidthRow
                    width={contentWidth}
                    bg={rowBg}
                    left={left}
                    right={right}
                    keyPrefix={`action-${action.id}`}
                  />
                </box>
              );
            })
          )}
        </scrollbox>
      </box>
    </box>
  );
}
