// TuiDialog — termcast/claude-code style dialog primitive.
//
// Every termcast dialog follows the same chrome:
//   ╭───────────────────────────────────────────────────────╮
//   │ <Title>  <count/meta>                            esc │   <TuiDialogTitle>
//   │ [row]                                                │   <TuiDialogRow>
//   │ [selected row — full-width accent bg]                │
//   │ [row]                                                │
//   │ ...                                                   │
//   │ j/k move · enter toggle · esc close        clean    │   <TuiDialogFooter>
//   ╰───────────────────────────────────────────────────────╯
//
// Key deltas from grok's existing modal pattern:
//   - No full-screen dim backdrop. The dialog renders inline where the
//     host places it, framed only by an accent-colored rounded border.
//   - Selected rows get a full-width solid accent background; unselected
//     rows render on the default terminal background.
//   - Title row has the meta count aligned right; the `esc` hint lives
//     outside the right of the meta.
//   - Footer hints sit inside the border at the bottom.
//
// Callers own selection state + keyboard handling. This primitive is
// display-only — hand it rows + a selectedIndex and it paints them.

import type { ReactNode } from "react";
import type { Theme } from "../theme";

export function TuiDialog({
  t,
  children,
  width,
  height,
  flexGrow,
}: {
  t: Theme;
  children: ReactNode;
  width?: number | "auto" | `${number}%`;
  height?: number | "auto" | `${number}%`;
  flexGrow?: number;
}) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t.accent}
      backgroundColor={t.backgroundPanel}
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={height}
      flexGrow={flexGrow}
      flexShrink={0}
    >
      {children}
    </box>
  );
}

export function TuiDialogTitle({
  t,
  title,
  meta,
  hint = "esc",
}: {
  t: Theme;
  title: string;
  /** Right-aligned meta counter e.g. "18 total  18 on" or "4 items". */
  meta?: string;
  /** Escape hint shown at the far right. Defaults to "esc"; pass "" to hide. */
  hint?: string;
}) {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={t.accent} wrapMode="none">
        <b>{title}</b>
      </text>
      {meta && (
        <text fg={t.textMuted} wrapMode="none">
          {`  ${meta}`}
        </text>
      )}
      <box flexGrow={1} />
      {hint && (
        <text fg={t.textMuted} wrapMode="none">
          {hint}
        </text>
      )}
    </box>
  );
}

export function TuiDialogRow({
  t,
  selected,
  onSelect,
  onConfirm,
  children,
  paddingY = 0,
}: {
  t: Theme;
  selected?: boolean;
  onSelect?: () => void;
  onConfirm?: () => void;
  children: ReactNode;
  paddingY?: number;
}) {
  // Selected rows get a solid accent background across the full row width.
  // Text colors need to flip when selected so content remains readable on
  // the yellow/accent bg — callers render their text with the appropriate
  // color (pass t.background for selected foreground).
  return (
    <box
      flexDirection="column"
      backgroundColor={selected ? t.accent : undefined}
      paddingTop={paddingY}
      paddingBottom={paddingY}
      onMouseMove={onSelect}
      onMouseDown={() => {
        onSelect?.();
        onConfirm?.();
      }}
    >
      {children}
    </box>
  );
}

export function TuiDialogFooter({
  t,
  hints,
  rightSlot,
}: {
  t: Theme;
  /** Array of `[key, label]` pairs rendered as `key label · key label`. */
  hints: Array<[string, string]>;
  /** Optional right-aligned action label e.g. "clean". */
  rightSlot?: string;
}) {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={t.textMuted} wrapMode="none">
        {hints.map(([key, label], i) => (
          <span key={`${key}-${label}`}>
            {i > 0 ? "  \u00b7  " : ""}
            <span style={{ fg: t.text }}>{`${key} `}</span>
            {label}
          </span>
        ))}
      </text>
      <box flexGrow={1} />
      {rightSlot && (
        <text fg={t.textMuted} wrapMode="none">
          {rightSlot}
        </text>
      )}
    </box>
  );
}
