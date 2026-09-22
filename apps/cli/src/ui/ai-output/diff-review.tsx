// DiffReview — per-file accept/reject triage panel with inline hunk view.
// Ported from termcast's diff-review.tsx. Unlike the original this port
// holds its own decision state (accept/reject per file) because triage
// selection is inherently stateful and embedding it would otherwise demand
// a matching reducer from every caller.

import { useEffect, useState } from "react";
import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export type DiffLineType = "context" | "add" | "remove" | "header";
export type DiffDecision = "pending" | "accepted" | "rejected";
export type DiffActionTone = "default" | "safe" | "warning" | "danger";
export type DiffActionKind = "accept" | "reject" | "apply" | "inspect";

export interface DiffAction {
  id: string;
  label: string;
  shortcut?: string;
  tone?: DiffActionTone;
  kind: DiffActionKind;
}

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffFile {
  path: string;
  summary?: string;
  lines: DiffLine[];
  decision?: DiffDecision;
  actions?: DiffAction[];
}

interface DiffReviewProps {
  t: Theme;
  files: DiffFile[];
  title?: string;
  actions?: DiffAction[];
  summary?: string;
  statusLabel?: string;
  /** When true, hides all per-file and review action pills. Use for
   *  post-execution display where edits are already applied. */
  readOnly?: boolean;
}

function lineColor(t: Theme, type: DiffLineType): string {
  switch (type) {
    case "add":
      return t.diffAddedFg;
    case "remove":
      return t.diffRemovedFg;
    case "header":
      return t.accent;
    default:
      return t.textMuted;
  }
}

function actionColors(t: Theme, tone: DiffActionTone): { fg: string; bg: string } {
  switch (tone) {
    case "safe":
      return { fg: t.background, bg: t.diffAddedFg };
    case "warning":
      return { fg: t.background, bg: t.accent };
    case "danger":
      return { fg: t.background, bg: t.diffRemovedFg };
    default:
      return { fg: t.text, bg: t.backgroundPanel };
  }
}

function decisionColor(t: Theme, decision: DiffDecision): string {
  switch (decision) {
    case "accepted":
      return t.diffAddedFg;
    case "rejected":
      return t.diffRemovedFg;
    default:
      return t.accent;
  }
}

function summarizeFile(file: DiffFile): { added: number; removed: number } {
  const added = file.lines.filter((line) => line.type === "add").length;
  const removed = file.lines.filter((line) => line.type === "remove").length;
  return { added, removed };
}

function buildDecisionMap(files: DiffFile[]): Record<string, DiffDecision> {
  return Object.fromEntries(files.map((file) => [file.path, file.decision ?? "pending"]));
}

function defaultFileActions(): DiffAction[] {
  return [
    { id: "accept", label: "Accept", shortcut: "a", tone: "safe", kind: "accept" },
    { id: "reject", label: "Reject", shortcut: "r", tone: "danger", kind: "reject" },
    {
      id: "inspect",
      label: "Inspect",
      shortcut: "i",
      tone: "warning",
      kind: "inspect",
    },
  ];
}

function defaultReviewActions(): DiffAction[] {
  return [
    {
      id: "apply",
      label: "Apply accepted",
      shortcut: "enter",
      tone: "safe",
      kind: "apply",
    },
    {
      id: "inspect",
      label: "Inspect selection",
      shortcut: "space",
      tone: "warning",
      kind: "inspect",
    },
  ];
}

export function DiffReview({
  t,
  files,
  title = "diff review",
  actions,
  summary,
  statusLabel,
  readOnly = false,
}: DiffReviewProps) {
  const [decisions, setDecisions] = useState<Record<string, DiffDecision>>(() => buildDecisionMap(files));
  const [lastAction, setLastAction] = useState<string | undefined>();

  useEffect(() => {
    setDecisions(buildDecisionMap(files));
    setLastAction(undefined);
  }, [files]);

  if (files.length === 0) return null;

  const acceptedCount = Object.values(decisions).filter((decision) => decision === "accepted").length;
  const rejectedCount = Object.values(decisions).filter((decision) => decision === "rejected").length;
  const reviewActions = actions ?? defaultReviewActions();

  function handleFileAction(file: DiffFile, action: DiffAction): void {
    if (action.kind === "accept" || action.kind === "reject") {
      const decision = action.kind === "accept" ? "accepted" : "rejected";
      setDecisions((current) => ({ ...current, [file.path]: decision }));
      setLastAction(`${file.path} marked ${decision}`);
    } else if (action.kind === "inspect") {
      setLastAction(`Inspecting ${file.path}`);
    } else {
      setLastAction(`Queued ${file.path} for apply review`);
    }
  }

  function handleReviewAction(action: DiffAction): void {
    if (action.kind === "apply") {
      setLastAction(`Queued ${acceptedCount} accepted file${acceptedCount === 1 ? "" : "s"} for apply`);
    } else {
      setLastAction(`Inspecting ${acceptedCount} accepted and ${rejectedCount} rejected selections`);
    }
  }

  return (
    <AgentPanel
      t={t}
      title={title}
      meta={`${files.length} file${files.length > 1 ? "s" : ""}  ${acceptedCount} accepted  ${rejectedCount} rejected`}
      statusLabel={statusLabel}
      statusColor={t.accent}
    >
      <box flexDirection="column">
        {summary && <text fg={t.textMuted}>{summary}</text>}
        {files.map((file) => {
          const sum = summarizeFile(file);
          const decision = decisions[file.path] ?? "pending";
          const fileActions = file.actions ?? defaultFileActions();
          return (
            <box key={file.path} flexDirection="column" marginBottom={1}>
              <box flexDirection="row" height={1}>
                <text fg={t.text} wrapMode="none">
                  <b>{file.path}</b>
                </text>
                <box flexGrow={1} />
                <box flexDirection="row" gap={1}>
                  <PanelPill t={t} label={`+${sum.added}`} fg={t.background} bg={t.diffAddedFg} />
                  <PanelPill t={t} label={`-${sum.removed}`} fg={t.background} bg={t.diffRemovedFg} />
                  <PanelPill t={t} label={decision} fg={decisionColor(t, decision)} />
                </box>
              </box>
              {file.summary && <text fg={t.textMuted}>{file.summary}</text>}
              {!readOnly && (
                <box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
                  {fileActions.map((action) => {
                    const colors = actionColors(t, action.tone ?? "default");
                    const label = action.shortcut ? `${action.label} (${action.shortcut})` : action.label;
                    return (
                      <PanelPill
                        key={`${file.path}-${action.id}`}
                        t={t}
                        label={label}
                        fg={colors.fg}
                        bg={colors.bg}
                        bold
                        onSelect={() => handleFileAction(file, action)}
                      />
                    );
                  })}
                </box>
              )}
              <box marginTop={1} flexDirection="column">
                {file.lines.map((line, index) => (
                  // Wrap rather than clip: an approval card must show every
                  // character of the change the user is approving.
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and never reorder
                  <text key={`${file.path}-${index}`} fg={lineColor(t, line.type)} wrapMode="char">
                    {line.text}
                  </text>
                ))}
              </box>
            </box>
          );
        })}
        {!readOnly && (
          <box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
            {reviewActions.map((action) => {
              const colors = actionColors(t, action.tone ?? "default");
              const label = action.shortcut ? `${action.label} (${action.shortcut})` : action.label;
              return (
                <PanelPill
                  key={action.id}
                  t={t}
                  label={label}
                  fg={colors.fg}
                  bg={colors.bg}
                  bold
                  onSelect={() => handleReviewAction(action)}
                />
              );
            })}
          </box>
        )}
        {lastAction && (
          <box marginTop={1}>
            <text fg={t.textMuted}>{lastAction}</text>
          </box>
        )}
      </box>
    </AgentPanel>
  );
}

export function makeExampleDiffFiles(): DiffFile[] {
  return [
    {
      path: "src/core/store.tsx",
      summary: "Cancel pending turns before cross-session resets.",
      lines: [
        { type: "header", text: "@@ -121,6 +131,10 @@" },
        { type: "context", text: " const clearHistory = useCallback(() => {" },
        { type: "add", text: "+  cancelPendingTurn()" },
        { type: "add", text: "+  clearAttachments()" },
        { type: "context", text: "   setMessages(initialMessages())" },
        { type: "remove", text: "-  setTokensUsed(0)" },
        { type: "add", text: "+  setTokensUsed(0)" },
      ],
      decision: "accepted",
    },
    {
      path: "src/modules/input/area.tsx",
      summary: "Restore input focus after popup and inline completion interactions.",
      lines: [
        { type: "header", text: "@@ -179,6 +216,8 @@" },
        { type: "context", text: ' if (triggerMode === "slash") {' },
        { type: "add", text: "+  requestInputFocus()" },
        {
          type: "add",
          text: "+  completionScrollRef.current?.scrollTo?.(...)",
        },
      ],
      decision: "pending",
    },
  ];
}

export function makeExampleDiffActions(): DiffAction[] {
  return [
    {
      id: "apply",
      label: "Apply patch",
      shortcut: "a",
      tone: "safe",
      kind: "apply",
    },
    {
      id: "reject",
      label: "Request changes",
      shortcut: "r",
      tone: "danger",
      kind: "reject",
    },
    {
      id: "inspect",
      label: "Split hunks",
      shortcut: "s",
      tone: "warning",
      kind: "inspect",
    },
    {
      id: "open",
      label: "Open file",
      shortcut: "o",
      tone: "default",
      kind: "inspect",
    },
  ];
}
