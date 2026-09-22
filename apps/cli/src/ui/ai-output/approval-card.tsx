// ApprovalCard — approval panel with risk pill, detail, and action buttons.
// Ported from termcast's agent-output/approval-card.tsx. The buttons here
// are display-only; wiring the shortcuts to callbacks is the caller's job
// (keeps the widget stateless for embedding in chat feeds).

import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalTone = "default" | "safe" | "warning" | "danger";

export interface ApprovalAction {
  label: string;
  shortcut?: string;
  tone?: ApprovalTone;
}

export interface ApprovalRequest {
  title: string;
  summary?: string;
  detail?: string;
  riskLabel?: string;
  status?: ApprovalStatus;
  actions?: ApprovalAction[];
}

function statusColor(t: Theme, status: ApprovalStatus): string {
  switch (status) {
    case "approved":
      return t.diffAddedFg;
    case "rejected":
      return t.diffRemovedFg;
    default:
      return t.accent;
  }
}

function actionColors(t: Theme, tone: ApprovalTone): { bg: string; fg: string } {
  switch (tone) {
    case "safe":
      return { bg: t.diffAddedFg, fg: t.background };
    case "warning":
      return { bg: t.accent, fg: t.background };
    case "danger":
      return { bg: t.diffRemovedFg, fg: t.background };
    default:
      return { bg: t.backgroundPanel, fg: t.text };
  }
}

export function ApprovalCard({
  t,
  request,
  onAction,
}: {
  t: Theme;
  request: ApprovalRequest;
  /** Called with the action's label when its pill is clicked. */
  onAction?: (label: string) => void;
}) {
  const status = request.status ?? "pending";
  const actions = request.actions ?? [];
  return (
    <AgentPanel t={t} title="approval" statusLabel={status} statusColor={statusColor(t, status)}>
      <box flexDirection="column">
        <text fg={t.text}>
          <b>{request.title}</b>
        </text>
        {request.summary && <text fg={t.textMuted}>{request.summary}</text>}
        {request.riskLabel && (
          <box marginTop={1}>
            <PanelPill t={t} label={`risk: ${request.riskLabel}`} fg={t.accent} />
          </box>
        )}
        {request.detail && (
          <box marginTop={1}>
            <text fg={t.textMuted}>{request.detail}</text>
          </box>
        )}
        {actions.length > 0 && (
          <box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            {actions.map((action) => {
              const colors = actionColors(t, action.tone ?? "default");
              return (
                <PanelPill
                  key={action.label}
                  t={t}
                  label={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
                  fg={colors.fg}
                  bg={colors.bg}
                  bold
                  onSelect={onAction ? () => onAction(action.label) : undefined}
                />
              );
            })}
          </box>
        )}
      </box>
    </AgentPanel>
  );
}

export function makeExampleApproval(): ApprovalRequest {
  return {
    title: "Allow the agent to run a destructive file operation",
    summary: "This step would delete generated cache directories before rebuilding the workspace.",
    detail: "Requested command: `rm -rf dist .cache`",
    riskLabel: "destructive filesystem write",
    status: "pending",
    actions: [
      { label: "Approve", shortcut: "a", tone: "safe" },
      { label: "Deny", shortcut: "d", tone: "danger" },
      { label: "Inspect", shortcut: "i", tone: "warning" },
    ],
  };
}
