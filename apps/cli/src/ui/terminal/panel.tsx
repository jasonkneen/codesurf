// Terminal manager modal. Lists all live sessions as tabs; the focused tab
// gets a full-size TerminalSessionView below. Keyboard nav is owned by the
// caller (app.tsx handles shift+tab mode cycling and esc close).

import type { Theme } from "../theme";
import type { TerminalSessionSnapshot } from "./manager";
import { TerminalSessionView } from "./session-view";

function trimLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(8, max - 1))}…`;
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function TerminalManagerModal({
  t,
  width,
  height,
  sessions,
  selectedIndex,
  inputMode = false,
}: {
  t: Theme;
  width: number;
  height: number;
  sessions: readonly TerminalSessionSnapshot[];
  selectedIndex: number;
  inputMode?: boolean;
}) {
  const panelWidth = Math.min(Math.max(60, width - 4), width);
  const panelHeight = Math.min(Math.max(20, height - 4), height);
  const overlayBg = "#000000cc" as string;
  const selected = sessions[selectedIndex] ?? sessions[0] ?? null;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
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
          <text fg={t.primary} wrapMode="none">
            <b>{"Terminals"}</b>
            <span style={{ fg: t.textMuted }}>{`  ${sessions.length}`}</span>
            {inputMode ? <span style={{ fg: t.accent }}>{"  ● INPUT"}</span> : null}
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {inputMode ? "ctrl+]" : "esc"}
          </text>
        </box>
        <box flexShrink={0} flexDirection="row" flexWrap="wrap" paddingLeft={2} paddingRight={2} paddingTop={1}>
          {sessions.length === 0 ? (
            <text fg={t.textMuted} wrapMode="none">
              {"No terminal sessions yet. Run /term <command> or /term-modal <command>."}
            </text>
          ) : (
            sessions.map((session, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <box
                  key={session.id}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isSelected ? t.accent : t.backgroundPanel}
                >
                  <text fg={isSelected ? t.background : t.text} wrapMode="none">
                    {isSelected ? (
                      <b>{trimLabel(session.title || session.command, 18)}</b>
                    ) : (
                      trimLabel(session.title || session.command, 18)
                    )}
                  </text>
                </box>
              );
            })
          )}
        </box>
        <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          {selected ? (
            <TerminalSessionView sessionId={selected.id} t={t} chrome="modal" rows={Math.max(4, panelHeight - 10)} />
          ) : (
            <box
              flexDirection="column"
              border
              borderStyle="rounded"
              borderColor={t.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={t.textMuted} wrapMode="none">
                {"The manager keeps sessions alive between conversations."}
              </text>
            </box>
          )}
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          {inputMode ? (
            <text>
              <span style={{ fg: t.accent }}>{"keystrokes → session  "}</span>
              <span style={{ fg: t.primary }}>{"ctrl+] "}</span>
              <span style={{ fg: t.textMuted }}>{"exit input mode"}</span>
            </text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{"tab "}</span>
              <span style={{ fg: t.textMuted }}>{"switch  \u00b7  "}</span>
              <span style={{ fg: t.primary }}>{"i "}</span>
              <span style={{ fg: t.textMuted }}>{"type into session  \u00b7  "}</span>
              <span style={{ fg: t.primary }}>{"x "}</span>
              <span style={{ fg: t.textMuted }}>{"remove  \u00b7  "}</span>
              <span style={{ fg: t.primary }}>{"s "}</span>
              <span style={{ fg: t.textMuted }}>{"stop  \u00b7  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"close"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
