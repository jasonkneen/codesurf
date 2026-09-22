// Renders a single terminal session's current viewport. Reads snapshots from
// the manager via `useTerminalSession` — the manager itself parses ANSI
// through @xterm/headless, so here we just paint the already-normalized
// plain-text lines.
//
// Two modes:
//   - inline: compact row count, trimmed chrome, used inside the chat feed
//     via /term
//   - modal:  larger, full border, footer with stop/restart buttons, used by
//     /term-modal and the /terms manager

import type { Theme } from "../theme";
import { useTerminalSession } from "./manager";

type Chrome = "inline" | "modal";

export function TerminalSessionView({
  sessionId,
  t,
  chrome = "inline",
  rows,
  cols,
}: {
  sessionId: string;
  t: Theme;
  chrome?: Chrome;
  rows?: number;
  cols?: number;
}) {
  const session = useTerminalSession(sessionId);
  if (!session) {
    return (
      <box paddingLeft={1} paddingRight={1}>
        <text fg={t.textMuted}>{`[terminal ${sessionId} not found]`}</text>
      </box>
    );
  }

  const statusFg = session.status === "running" ? t.accent : session.status === "done" ? t.mdCode : t.diffRemovedFg;

  // Viewport lines come from the manager pre-sized to `snapshot.rows`; honor
  // any caller-provided row cap so inline mode can shrink without resizing
  // the underlying PTY (that's a separate control action).
  const displayLines =
    typeof rows === "number" && rows < session.lines.length ? session.lines.slice(-rows) : session.lines;

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={t.border} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={t.primary} wrapMode="none">
          <b>{session.title || session.command}</b>
        </text>
        <text fg={statusFg} wrapMode="none">
          {session.status}
          {typeof session.exitCode === "number" && session.status !== "running" ? ` (${session.exitCode})` : ""}
        </text>
      </box>
      <box flexDirection="column" paddingTop={chrome === "modal" ? 1 : 0}>
        {displayLines.map((line, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: terminal output lines are append-only and never reorder
          <text key={`${sessionId}-line-${idx}`} fg={t.text} wrapMode="none" selectable>
            {line.length === 0 ? " " : line}
          </text>
        ))}
      </box>
      {chrome === "modal" && (
        <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
          <text fg={t.textMuted} wrapMode="none">
            {session.cwd}
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {`${session.cols}×${session.rows}`}
          </text>
        </box>
      )}
      {/* cols prop reserved for future resize wiring */}
      {cols !== undefined && cols < 0 ? null : null}
    </box>
  );
}
