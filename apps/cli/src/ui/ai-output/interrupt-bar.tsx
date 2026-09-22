// InterruptBar — flat single-line status row shown while a long-running task
// is interruptible. Renders as dim label text plus chip-style action buttons
// (filled block, theme-black on `textDim` background) so it sits quietly in
// the live-chrome region and matches the tool-chip aesthetic — no bordered
// card competing with the transcript or the composer.
//
// Originally a bordered termcast-port; collapsed to a row + chip on
// 2026-05-16 per UX request: "dimmer like the chips, stop is like a chip,
// more subtle". The action-fg/bg override props remain so load-bearing
// callers can still opt out (e.g. a red `Stop` if a future surface wants
// it).

import type { Theme } from "../theme";
import { PanelPill } from "./panel-frame";

export type InterruptTone = "active" | "warning" | "blocked";
export type InterruptActionTone = "default" | "safe" | "warning" | "danger" | "accent";

export interface InterruptAction {
  label: string;
  shortcut?: string;
  tone?: InterruptActionTone;
  /** Optional glyph prefix (e.g. Nerd Font icon) shown before the label. */
  icon?: string;
  /** Override the fg color from the tone palette. */
  fg?: string;
  /** Override the bg color from the tone palette. */
  bg?: string;
}

export interface InterruptBarData {
  label: string;
  elapsed?: string;
  hint?: string;
  detail?: string;
  tone?: InterruptTone;
  actions?: InterruptAction[];
  /** Optional inline hint rendered just before the actions (right side).
   *  Used for transient indicators like "↓ new messages" that should sit
   *  next to the Stop chip rather than under the transcript. */
  hintRight?: {
    label: string;
    onSelect?: () => void;
    /** Override fg color. Defaults to theme primary. */
    fg?: string;
  };
}

function actionColors(t: Theme, tone: InterruptActionTone): { fg: string; bg: string } {
  // Default tone matches `ToolChip`: theme-black text on dim grey block. The
  // saturated tones are kept for callers that explicitly want a load-bearing
  // accent/safe/warning/danger color via `tone: "..."`.
  switch (tone) {
    case "accent":
      return { fg: t.background, bg: t.accent };
    case "safe":
      return { fg: t.background, bg: t.diffAddedFg };
    case "warning":
      return { fg: t.background, bg: t.accent };
    case "danger":
      return { fg: t.background, bg: t.diffRemovedFg };
    default:
      return { fg: t.background, bg: t.textDim };
  }
}

export function InterruptBar({
  t,
  bar,
  onAction,
}: {
  t: Theme;
  bar: InterruptBarData;
  /** Called with the action label when its pill is clicked. */
  onAction?: (label: string) => void;
}) {
  const meta = [bar.elapsed, bar.hint].filter(Boolean).join(" • ");
  return (
    <box flexDirection="column" marginLeft={1} marginRight={1}>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={t.textMuted} wrapMode="none">
          {bar.label}
        </text>
        {meta && (
          <text fg={t.textDim} wrapMode="none">
            {`(${meta})`}
          </text>
        )}
        <box flexGrow={1} />
        {bar.hintRight && (
          <box paddingRight={1} onMouseDown={bar.hintRight.onSelect}>
            <text fg={bar.hintRight.fg ?? t.primary} wrapMode="none">
              {bar.hintRight.label}
            </text>
          </box>
        )}
        <box flexDirection="row" gap={1}>
          {(bar.actions ?? []).map((action) => {
            const baseColors = actionColors(t, action.tone ?? "default");
            const colors = { fg: action.fg ?? baseColors.fg, bg: action.bg ?? baseColors.bg };
            const labelWithIcon = action.icon ? `${action.icon} ${action.label}` : action.label;
            const label = action.shortcut ? `${labelWithIcon} (${action.shortcut})` : labelWithIcon;
            return (
              <PanelPill
                key={label}
                t={t}
                label={label}
                fg={colors.fg}
                bg={colors.bg}
                bold
                onSelect={onAction ? () => onAction(action.label) : undefined}
              />
            );
          })}
        </box>
      </box>
      {bar.detail && (
        <box marginTop={0}>
          <text fg={t.textDim}>{bar.detail}</text>
        </box>
      )}
    </box>
  );
}

export function makeExampleInterruptBar(): InterruptBarData {
  return {
    label: "Long-running agent task is active",
    elapsed: "3m 18s",
    hint: "esc to interrupt",
    detail:
      "The main run is editing files and waiting on verification. Use an interrupt action if you want to stop or change direction.",
    tone: "active",
    actions: [
      { label: "Stop", shortcut: "esc" },
      { label: "Retry", shortcut: "r" },
      { label: "Continue", shortcut: "c" },
    ],
  };
}
