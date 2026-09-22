// Running-subagents footer indicator + drill-down (popup list → detail modal).
//
// Surfaces the agents currently running on behalf of the session: background
// `explore` delegations (DelegationManager) plus the single in-flight inline
// subagent (Agent.onSubagentStatus). The footer is a focusable row under the
// composer; DOWN from an empty composer focuses it, Enter opens the popup, and
// selecting a row opens a live-polled detail modal.
//
// LIVE-STREAM SEAM: there is no per-subagent token stream yet — delegations only
// write their output file on completion. The modal therefore shows the real
// available state (agent, task, status, elapsed, latest saved output) and
// exposes a typed `liveTranscript` prop wired to nothing. When streaming lands,
// the host populates `liveTranscript` (and may use `onSubscribeLive`) and the
// modal renders it in place of the polled output. See RunningAgentModalProps.

import type { DelegationStatus } from "../types/index";
import { type ParallelAgentStepStatus, ParallelAgents, type ParallelAgentsData } from "./ai-output/parallel-agents";
import type { Theme } from "./theme";

export interface RunningAgentRow {
  // Delegation id, or the "__inline__" sentinel for the in-flight inline subagent.
  id: string;
  kind: "inline" | "delegation";
  agent: string;
  description: string;
  status: DelegationStatus;
  title?: string;
  // Inline subagent scratch-pad line (kind === "inline" only).
  detail?: string;
  // ISO timestamp; delegations only — the inline subagent has no persisted start.
  startedAt?: string;
}

export const INLINE_AGENT_ID = "__inline__";

export function formatElapsed(startedAt: string | undefined, now: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${(secs % 60).toString().padStart(2, "0")}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${(mins % 60).toString().padStart(2, "0")}m`;
}

function rowLabel(row: RunningAgentRow): string {
  return row.title?.trim() || row.description?.trim() || row.id;
}

function statusColor(t: Theme, status: DelegationStatus): string {
  switch (status) {
    case "complete":
      return t.diffAddedFg;
    case "error":
      return t.diffRemovedFg;
    default:
      return t.accent;
  }
}

function statusGlyph(status: DelegationStatus): string {
  switch (status) {
    case "complete":
      return "✓";
    case "error":
      return "!";
    default:
      return "●";
  }
}

// ── Footer chip ────────────────────────────────────────────────────────────
// Focusable row rendered under the composer (mirrors QueueBanner). Hidden when
// there are no running agents.
export function RunningAgentsFooter({ t, rows, focused }: { t: Theme; rows: RunningAgentRow[]; focused: boolean }) {
  if (rows.length === 0) return null;
  const count = rows.length;
  const label = count === 1 ? "1 running subagent" : `${count} running subagents`;
  return (
    <box paddingLeft={2} paddingRight={2} marginLeft={1} marginRight={1} flexShrink={0}>
      <text fg={focused ? t.primary : t.accent} wrapMode="none">
        {focused ? "▸ " : "● "}
        {label}
      </text>
      {focused && (
        <text>
          <span style={{ fg: t.primary }}>{"enter "}</span>
          <span style={{ fg: t.textMuted }}>{"view"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"↑/esc "}</span>
          <span style={{ fg: t.textMuted }}>{"back to composer"}</span>
        </text>
      )}
    </box>
  );
}

// ── Popup list ─────────────────────────────────────────────────────────────
/**
 * Project live sub-agent rows onto the ParallelAgents showcase widget's shape.
 *
 * The popup previously hand-rolled its own row rendering while an equivalent,
 * richer widget already existed in the showcase (/showcase -> "Parallel
 * agents"). Mapping to it keeps the live view and the showcase example on one
 * component, so what users are shown in the tour is what they actually get.
 */
/**
 * Example rows for the showcase. Mirrors the two real sources: the single
 * in-flight inline sub-agent (`task`) and background `explore` delegations.
 */
export function makeExampleRunningAgentRows(): RunningAgentRow[] {
  const now = Date.now();
  return [
    {
      id: INLINE_AGENT_ID,
      kind: "inline",
      agent: "explore",
      description: "Trace how auth tokens are refreshed across the provider adapters",
      status: "running",
      title: "auth refresh research",
      detail: "grep: src/core/plugins/builtin/transports",
      startedAt: new Date(now - 42_000).toISOString(),
    },
    {
      id: "calm-blue-fox-9a3f2b71",
      kind: "delegation",
      agent: "explore",
      description: "Audit every registerTool() call site for missing mode gates",
      status: "running",
      title: "tool mode-gate audit",
      startedAt: new Date(now - 214_000).toISOString(),
    },
    {
      id: "swift-amber-hare-4c1d8e02",
      kind: "delegation",
      agent: "explore",
      description: "Collect prompt-cache read/write ratios from the last 20 turns",
      status: "complete",
      title: "cache ratio sweep",
      startedAt: new Date(now - 655_000).toISOString(),
    },
  ];
}

export function runningAgentRowsToParallelAgents(rows: RunningAgentRow[], now: number): ParallelAgentsData {
  const running = rows.filter((row) => row.status === "running").length;
  return {
    title: `subagent parallel (${rows.length})`,
    summary: rows.length > 0 ? `${running} running / ${rows.length} total` : undefined,
    progressLabel: `${running}/${rows.length} running`,
    steps: rows.map((row) => ({
      id: row.id,
      title: rowLabel(row),
      task: row.description?.trim() || rowLabel(row),
      agent: row.agent,
      model: row.kind === "inline" ? "inline" : "background",
      status: toStepStatus(row.status),
      duration: formatElapsed(row.startedAt, now) ?? undefined,
      // The inline sub-agent exposes a single scratch-pad line; delegations
      // write nothing until completion, so there is intentionally no detail.
      detailLines: row.detail ? [row.detail] : undefined,
    })),
  };
}

function toStepStatus(status: DelegationStatus): ParallelAgentStepStatus {
  switch (status) {
    case "complete":
      return "done";
    case "error":
      return "error";
    case "running":
      return "running";
    default:
      return "pending";
  }
}

export function RunningAgentsPopup({
  t,
  width,
  height,
  rows,
  selectedIndex,
  now,
}: {
  t: Theme;
  width: number;
  height: number;
  rows: RunningAgentRow[];
  selectedIndex: number;
  now: number;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(82, width - 6);
  const panelHeight = Math.min(Math.max(8, rows.length + 6), Math.max(8, height - 4));
  const top = Math.max(2, Math.floor((height - panelHeight) / 2));

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
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
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Running subagents"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
          {rows.length === 0 ? (
            <text fg={t.textMuted}>{"No running subagents."}</text>
          ) : (
            <ParallelAgents
              t={t}
              run={runningAgentRowsToParallelAgents(rows, now)}
              selectedId={rows[selectedIndex]?.id}
            />
          )}
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text>
            <span style={{ fg: t.primary }}>{"↑↓ "}</span>
            <span style={{ fg: t.textMuted }}>{"navigate  ·  "}</span>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"open  ·  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

// ── Detail modal ───────────────────────────────────────────────────────────
export interface RunningAgentModalProps {
  t: Theme;
  width: number;
  height: number;
  row: RunningAgentRow | null;
  // Latest saved output for a delegation (host polls Agent.getDelegationOutput).
  // While the agent is still running this is the "still running" sentinel, which
  // we render as a clean running state instead.
  output: string | null;
  loading: boolean;
  now: number;
  // FUTURE LIVE-STREAM SEAM — wired to nothing today. When per-subagent token
  // streaming exists, the host passes the live transcript here and (optionally)
  // a subscribe hook; the modal renders `liveTranscript` in place of `output`.
  liveTranscript?: string;
  onSubscribeLive?: (id: string) => () => void;
}

function isRunningSentinel(output: string | null): boolean {
  return output != null && /is still running/.test(output);
}

export function RunningAgentModal({
  t,
  width,
  height,
  row,
  output,
  loading,
  now,
  liveTranscript,
}: RunningAgentModalProps) {
  if (!row) return null;

  const panelWidth = Math.min(96, width - 6);
  const panelHeight = Math.min(Math.max(12, height - 4), Math.max(12, height - 2));
  const top = Math.max(1, Math.floor((height - panelHeight) / 2));
  const elapsed = formatElapsed(row.startedAt, now);

  // Body resolution order: future live transcript → inline scratch-pad → polled
  // delegation output. While running (or for the inline agent, which has no
  // persisted output) we show a clean running state, never fabricated text.
  const running = row.status === "running";
  let body: string;
  let bodyMuted = false;
  if (liveTranscript?.trim()) {
    body = liveTranscript;
  } else if (row.kind === "inline") {
    body = row.detail?.trim() || "running…";
    bodyMuted = true;
  } else if (loading && output == null) {
    body = "Loading…";
    bodyMuted = true;
  } else if (output == null || isRunningSentinel(output) || running) {
    body = "running… (output is saved when the subagent finishes)";
    bodyMuted = true;
  } else {
    body = output.trim() || "(No output)";
  }

  // Clamp the body to the visible region so a long result never breaks layout.
  const bodyRows = Math.max(3, panelHeight - 9);
  const bodyLines = body.split("\n");
  const shownLines = bodyLines.slice(0, bodyRows);
  const truncated = bodyLines.length > shownLines.length;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={"#000000cc" as string}
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
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary} wrapMode="none">
            <b>{rowLabel(row)}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} flexDirection="row" paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={statusColor(t, row.status)} wrapMode="none">
            {`${statusGlyph(row.status)} ${row.status}`}
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {`  ·  ${row.agent}`}
          </text>
          {elapsed && (
            <text fg={t.textMuted} wrapMode="none">
              {`  ·  ${elapsed}`}
            </text>
          )}
        </box>
        {row.description?.trim() && (
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.text}>
              <b>{"task: "}</b>
              <span style={{ fg: t.textMuted }}>{row.description.trim()}</span>
            </text>
          </box>
        )}
        <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
          {shownLines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: output lines are positional and stable per poll
            <text key={`body-${index}`} fg={bodyMuted ? t.textMuted : t.text}>
              {line}
            </text>
          ))}
          {truncated && <text fg={t.textDim}>{"…"}</text>}
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
