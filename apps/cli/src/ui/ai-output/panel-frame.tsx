// AgentPanel + PanelPill — shared chrome for the agent-output widgets.
// Ported from termcast's modules/agent-output/panel-frame.tsx with the
// theme-via-hook replaced by a Theme prop so callers can pass it through
// without needing a global provider.

import type { ReactNode } from "react";
import type { Theme } from "../theme";

interface AgentPanelProps {
  t: Theme;
  title: string;
  meta?: string;
  statusLabel?: string;
  statusColor?: string;
  children: ReactNode;
}

export function AgentPanel({ t, title, meta, statusLabel, statusColor, children }: AgentPanelProps) {
  return (
    <box flexDirection="column" border borderColor={t.border} marginLeft={1} marginRight={1} marginBottom={1}>
      <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1} backgroundColor={t.backgroundPanel}>
        <text fg={t.primary} wrapMode="none">
          <b>{title}</b>
        </text>
        {meta && (
          <text fg={t.textMuted} wrapMode="none">
            {`  ${meta}`}
          </text>
        )}
        <box flexGrow={1} />
        {statusLabel && (
          <text fg={statusColor ?? t.textMuted} wrapMode="none">
            <b>{statusLabel}</b>
          </text>
        )}
      </box>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        {children}
      </box>
    </box>
  );
}

interface PanelPillProps {
  t: Theme;
  label: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  /** When provided, the pill becomes clickable. Called on mouse down. */
  onSelect?: () => void;
}

export function PanelPill({ t, label, fg, bg, bold = false, onSelect }: PanelPillProps) {
  return (
    <box paddingLeft={1} paddingRight={1} backgroundColor={bg ?? t.backgroundPanel} onMouseDown={onSelect}>
      <text fg={fg ?? t.text} wrapMode="none">
        {bold ? <b>{label}</b> : label}
      </text>
    </box>
  );
}
