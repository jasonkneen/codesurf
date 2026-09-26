// ServerPicker — `/server`. Lists the running servers (ranked: this folder's
// project server, the default user server, then the rest; other folders'
// project servers last), each labelled with its scope, plus "serverless (run
// locally)". ↑/↓ + enter (or click) connects, esc closes. Choosing a server
// marks it used so later launches attach to it without asking.

import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { isEligible, type ServerCandidate, scopeLabel } from "../../server/scope";
import { useServerMode } from "../context/server-mode-context.js";
import { useFlushedKeyboard } from "../hooks/use-flushed-keyboard.js";
import type { Theme } from "../theme";

export function serverRowLabel(server: ServerCandidate, cwd: string, current: boolean): string {
  const name = server.name ?? "(unnamed)";
  const notes = [
    current ? "current" : null,
    isEligible(server, cwd) ? null : "other folder",
    server.known ? null : "new",
  ].filter(Boolean);
  return `${current ? "●" : " "} ${name}  ${server.url}  ${scopeLabel(server)}${notes.length ? `  · ${notes.join(" · ")}` : ""}`;
}

function padCell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

export function ServerPicker({
  t,
  onResumed,
}: {
  t: Theme;
  /** Called with the node session id after a successful resume, so the screen can load it. */
  onResumed?: (sessionId: string) => void;
}) {
  const { remoteFront, connect, detach, candidates, cwd, sessions, resume, closePicker } = useServerMode();
  const { width: termWidth } = useTerminalDimensions();
  const rowCount = candidates.length + 1;
  const currentIndex = candidates.findIndex((c) => c.url === remoteFront?.url);
  const [index, setIndex] = useState(currentIndex >= 0 ? currentIndex : 0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIndex((i) => Math.min(i, rowCount - 1));
  }, [rowCount]);

  const choose = (i: number) => {
    if (busy) return;
    if (i >= candidates.length) {
      if (remoteFront) detach();
      closePicker();
      return;
    }
    setBusy(true);
    void connect(candidates[i]).then((ok) => {
      setBusy(false);
      if (ok) closePicker();
    });
  };

  useFlushedKeyboard((key: KeyEvent) => {
    if (key.name === "escape") closePicker();
    else if (key.name === "up" || key.name === "k") setIndex((i) => (i - 1 + rowCount) % rowCount);
    else if (key.name === "down" || key.name === "j") setIndex((i) => (i + 1) % rowCount);
    else if (key.name === "return") choose(index);
  });

  const width = Math.max(40, Math.min(termWidth - 4, 100));
  const inner = width - 4;
  const bg = t.backgroundPanel;
  const rowText = (i: number) =>
    i < candidates.length
      ? serverRowLabel(candidates[i], cwd, candidates[i].url === remoteFront?.url)
      : `${remoteFront ? " " : "●"} serverless (run locally)${remoteFront ? "  · detach" : "  · current"}`;

  return (
    <box
      position="absolute"
      top={2}
      left={Math.max(0, Math.floor((termWidth - width) / 2))}
      width={width}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t.accent}
      backgroundColor={bg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={t.primary} bg={bg}>
        {padCell("Servers", inner)}
      </text>
      {candidates.length === 0 ? (
        <text fg={t.textDim} bg={bg}>
          {padCell("No servers running. Start one with `codesurf server start`.", inner)}
        </text>
      ) : null}
      {Array.from({ length: rowCount }, (_, i) => {
        const selected = i === index;
        const dim = i < candidates.length && !isEligible(candidates[i], cwd);
        return (
          <box key={i < candidates.length ? candidates[i].url : "serverless"} onMouseDown={() => choose(i)}>
            <text fg={selected ? t.selected : dim ? t.textDim : t.text} bg={selected ? t.selectedBg : bg}>
              {padCell(rowText(i), inner)}
            </text>
          </box>
        );
      })}
      {remoteFront && sessions.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={t.primary} bg={bg}>
            {padCell(`Sessions on this server (${sessions.length}) — click to resume`, inner)}
          </text>
          {sessions.map((s) => (
            <box
              key={s.id}
              onMouseDown={() =>
                void resume(remoteFront.url, s.id).then((front) => {
                  if (front) onResumed?.(s.id);
                })
              }
            >
              <text fg={s.finished ? t.textMuted : t.text} bg={bg}>
                {padCell(`${s.finished ? "● finished" : "○ active"} ${s.id.slice(0, 28)}  ${s.cwd ?? ""}`, inner)}
              </text>
            </box>
          ))}
        </box>
      ) : null}
      <text fg={t.textDim} bg={bg}>
        {padCell(busy ? "connecting…" : "↑/↓ select · enter connect · esc close", inner)}
      </text>
    </box>
  );
}
