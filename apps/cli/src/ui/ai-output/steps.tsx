// Steps — task list with live status icons + overall progress. Ported from
// termcast's agent-output/steps.tsx. The @raycast/api Spinner is replaced
// with the ◌ glyph (static) since codesurf renders at video-card frame
// cadence and doesn't need per-widget spinner animation.
//
// Controlled + uncontrolled: pass `expandedId`+`onToggle` for caller-owned
// state, or omit both for internal state.

import { useState } from "react";
import type { Theme } from "../theme";

export type StepStatus = "pending" | "running" | "done" | "error";

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  durationMs?: number;
}

interface StepsProps {
  t: Theme;
  steps: Step[];
  title?: string;
  showProgress?: boolean;
  /** When set, this row's detail is expanded. Caller owns the state so the
   *  widget stays stateless (easier to embed in the showcase and in live
   *  agent output alike). */
  expandedId?: string | null;
  /** Click handler for rows that have `detail` — caller toggles expandedId. */
  onToggle?: (id: string) => void;
}

const STEP_ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "◌",
  done: "✓",
  error: "✗",
};

interface ProgressBarProps {
  t: Theme;
  value: number;
  width?: number;
  color?: string;
  label?: string;
}

function ProgressBar({ t, value, width = 28, color, label }: ProgressBarProps) {
  const fillCol = color ?? t.accent;
  const emptyCol = t.border;
  const pct = Math.max(0, Math.min(1, value));
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return (
    <box flexDirection="row" height={1}>
      <text fg={fillCol} wrapMode="none">
        {"█".repeat(filled)}
      </text>
      <text fg={emptyCol} wrapMode="none">
        {"░".repeat(empty)}
      </text>
      {label !== undefined && <text fg={t.textMuted} wrapMode="none">{`  ${label}`}</text>}
    </box>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export function Steps({
  t,
  steps,
  title = "Tasks",
  showProgress = true,
  expandedId: controlledExpandedId,
  onToggle,
}: StepsProps) {
  // Controlled when caller passes onToggle; otherwise keep local state.
  const [internalExpandedId, setInternalExpandedId] = useState<string | null>(null);
  const expandedId = controlledExpandedId ?? internalExpandedId;
  const effectiveToggle = onToggle
    ? onToggle
    : (id: string) => setInternalExpandedId((prev) => (prev === id ? null : id));

  const doneCount = steps.filter((s) => s.status === "done").length;
  const errCount = steps.filter((s) => s.status === "error").length;
  const progress = steps.length > 0 ? doneCount / steps.length : 0;

  const statusColor = (s: StepStatus): string => {
    switch (s) {
      case "done":
        return t.diffAddedFg;
      case "running":
        return t.accent;
      case "error":
        return t.diffRemovedFg;
      default:
        return t.textMuted;
    }
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <box flexDirection="row" height={1} marginBottom={1}>
        <text fg={t.primary} wrapMode="none">
          <b>{title}</b>
        </text>
        <text fg={t.textMuted} wrapMode="none">
          {`  ${doneCount}/${steps.length}`}
          {errCount > 0 ? `  ${errCount} failed` : ""}
        </text>
      </box>
      {steps.map((step) => {
        const col = statusColor(step.status);
        const expanded = expandedId === step.id;
        return (
          <box
            key={step.id}
            flexDirection="column"
            onMouseDown={step.detail ? () => effectiveToggle(step.id) : undefined}
          >
            <box flexDirection="row" height={1}>
              <box width={3} flexShrink={0}>
                <text fg={col} wrapMode="none">
                  {STEP_ICON[step.status]}
                </text>
              </box>
              <text fg={step.status === "pending" ? t.textMuted : t.text} wrapMode="none">
                {step.status === "running" ? <b>{step.label}</b> : step.label}
              </text>
              {step.durationMs !== undefined && step.status === "done" && (
                <text fg={t.textMuted} wrapMode="none">
                  {`  ${fmtMs(step.durationMs)}`}
                </text>
              )}
              {step.detail && (
                <text fg={t.textMuted} wrapMode="none">
                  {expanded ? "  [-]" : "  [+]"}
                </text>
              )}
            </box>
            {expanded && step.detail && (
              <box paddingLeft={3} marginBottom={1}>
                <text fg={t.textMuted} wrapMode="none">
                  {step.detail}
                </text>
              </box>
            )}
          </box>
        );
      })}
      {showProgress && steps.length > 0 && (
        <box marginTop={1}>
          <ProgressBar
            t={t}
            value={progress}
            width={40}
            color={errCount > 0 ? t.diffRemovedFg : undefined}
            label={`${Math.round(progress * 100)}%`}
          />
        </box>
      )}
    </box>
  );
}

export function makeExampleSteps(): Step[] {
  return [
    {
      id: "s1",
      label: "Analyse repository structure",
      status: "done",
      durationMs: 842,
      detail: "Found 47 TypeScript files across src/, tests/, and scripts/.",
    },
    { id: "s2", label: "Read package.json and tsconfig", status: "done", durationMs: 112 },
    { id: "s3", label: "Identify test framework (vitest)", status: "done", durationMs: 67 },
    {
      id: "s4",
      label: "Run existing test suite",
      status: "running",
      detail: "bun test — 23 passing, 2 failing...",
    },
    {
      id: "s5",
      label: "Fix failing tests",
      status: "pending",
      detail: "Will patch src/core/store.test.tsx and src/lib/utils.test.tsx.",
    },
    { id: "s6", label: "Add coverage for new modules", status: "pending" },
    { id: "s7", label: "Update CI workflow", status: "pending" },
  ];
}
