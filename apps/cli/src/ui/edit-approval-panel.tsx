// EditApprovalPanel — inline approval card rendered when the agent calls
// write_file or edit_file under editApproval="ask-always" (or when the user
// has not yet flagged the path / session as auto-accept).
//
// Rendering: reuses the DiffReview component in readOnly mode to show the
// prospective diff, then appends a dedicated action row with four options
// keyed to keyboard shortcuts. The keyboard handler lives in app.tsx so it
// can interact with the rest of the global key-routing pipeline (Esc, ↑/↓,
// Enter), and onAction dispatches the user's decision back up.
//
// Decisions:
//   - "accept"       — approve THIS edit only (one-shot)
//   - "accept-path"  — approve this edit and every future edit to the same
//                       absolute path for the remainder of the session
//   - "accept-session" — approve this edit and every subsequent file edit
//                       in this session (one-shot equivalent of /edits auto
//                       but only until session-reset)
//   - "reject"       — reject this edit; agent receives a tool result
//                       indicating user denial and decides what to do next

import type { EditPrecheck } from "../types/index";
import { type DiffFile, type DiffLine, type DiffLineType, DiffReview } from "./ai-output/diff-review";
import { AgentPanel, PanelPill } from "./ai-output/panel-frame";
import type { Theme } from "./theme";

export type EditApprovalDecision = "accept" | "accept-path" | "accept-session" | "reject";

interface EditApprovalPanelProps {
  t: Theme;
  toolName: "write_file" | "edit_file";
  precheck?: EditPrecheck;
  fallbackPath?: string;
  /** 0 = accept, 1 = accept-path, 2 = accept-session, 3 = reject. */
  selected: number;
  onAction: (decision: EditApprovalDecision) => void;
}

const OPTIONS: {
  id: EditApprovalDecision;
  label: string;
  shortcut: string;
  tone: "default" | "safe" | "warning" | "danger";
}[] = [
  { id: "accept", label: "Accept", shortcut: "enter", tone: "safe" },
  { id: "accept-path", label: "Accept this path", shortcut: "p", tone: "warning" },
  { id: "accept-session", label: "Accept all this session", shortcut: "a", tone: "warning" },
  { id: "reject", label: "Reject", shortcut: "esc", tone: "danger" },
];

export function patchToDiffFile(precheck: EditPrecheck): DiffFile {
  const lines: DiffLine[] = [];
  // `---`/`+++` are file headers only before the first hunk. Inside a hunk a
  // line such as `+++counter` is an added line whose content is `++counter`.
  let inHunk = false;
  for (const raw of precheck.patch.split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      lines.push({ type: "header" as DiffLineType, text: raw });
    } else if (!inHunk && (raw.startsWith("+++") || raw.startsWith("---"))) continue;
    else if (raw.startsWith("+")) lines.push({ type: "add", text: raw });
    else if (raw.startsWith("-")) lines.push({ type: "remove", text: raw });
    else lines.push({ type: "context", text: raw });
  }
  return {
    path: precheck.filePath,
    summary: precheck.isNew ? "new file" : `+${precheck.additions} −${precheck.removals}`,
    lines,
  };
}

function actionColors(t: Theme, tone: "default" | "safe" | "warning" | "danger"): { fg: string; bg: string } {
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

export function EditApprovalPanel({ t, toolName, precheck, fallbackPath, selected, onAction }: EditApprovalPanelProps) {
  const title = toolName === "write_file" ? "Approve write" : "Approve edit";
  const filePath = precheck?.filePath ?? fallbackPath ?? "(unknown path)";

  // Header summary line — surfaces the most important fact about the change.
  let summary: string;
  if (!precheck) {
    summary = `Agent wants to ${toolName === "write_file" ? "write" : "edit"} ${filePath}. (Diff preview unavailable.)`;
  } else if (precheck.isNew) {
    summary = `Agent wants to CREATE ${filePath} (+${precheck.additions} lines).`;
  } else if (precheck.noop) {
    summary = `Agent wants to ${toolName === "write_file" ? "rewrite" : "edit"} ${filePath} with NO net change.`;
  } else {
    summary = `Agent wants to ${toolName === "write_file" ? "rewrite" : "edit"} ${filePath} (+${precheck.additions} −${precheck.removals}).`;
  }

  return (
    <AgentPanel t={t} title={title} statusLabel="pending" statusColor={t.accent}>
      <box flexDirection="column" gap={1}>
        <text fg={t.text}>{summary}</text>
        {precheck && <DiffReview t={t} files={[patchToDiffFile(precheck)]} title="proposed change" readOnly />}
        <box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
          {OPTIONS.map((opt, idx) => {
            const isSelected = idx === selected;
            const colors = actionColors(t, isSelected ? opt.tone : "default");
            return (
              <PanelPill
                key={opt.id}
                t={t}
                label={`${opt.label} (${opt.shortcut})`}
                fg={colors.fg}
                bg={colors.bg}
                bold={isSelected}
                onSelect={() => onAction(opt.id)}
              />
            );
          })}
        </box>
        <text fg={t.textMuted}>↑/↓ move · enter approve · p path · a session · esc reject</text>
      </box>
    </AgentPanel>
  );
}

export const EDIT_APPROVAL_OPTIONS = OPTIONS;
