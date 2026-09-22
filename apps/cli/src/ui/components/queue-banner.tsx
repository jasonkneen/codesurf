// Queue (pending follow-up) banner. Extracted from app.tsx so both session
// layouts can render it without importing the god file.

import type { QueuedMessage } from "../app-helpers";
import type { Theme } from "../theme";

export function QueueBanner({
  t,
  queuedMessages,
  focusId,
}: {
  t: Theme;
  queuedMessages: QueuedMessage[];
  focusId: string | null;
}) {
  if (queuedMessages.length === 0) return null;
  const focused = focusId !== null && queuedMessages.some((m) => m.id === focusId);
  const single = queuedMessages.length === 1;
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      marginLeft={1}
      marginRight={1}
      backgroundColor={t.queueBg}
      flexShrink={0}
    >
      {queuedMessages.map((msg) => {
        const isFocused = msg.id === focusId;
        return (
          <text key={msg.id} fg={isFocused ? t.primary : t.text}>
            {isFocused ? "▸ " : "→ "}
            {msg.displayText}
          </text>
        );
      })}
      <box height={1} />
      {/* Hint row varies with mode:
          - focused: arrow keys navigate, enter dispatches the focused row
          - unfocused + single: legacy Tier 2 hint
          - unfocused + multi: ↑ enters focus, enter dispatches head */}
      {focused ? (
        <text>
          <span style={{ fg: t.primary }}>{"enter "}</span>
          <span style={{ fg: t.textMuted }}>{"send this"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"↑↓ "}</span>
          <span style={{ fg: t.textMuted }}>{"navigate"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"esc "}</span>
          <span style={{ fg: t.textMuted }}>{"unfocus"}</span>
        </text>
      ) : single ? (
        <text>
          <span style={{ fg: t.primary }}>{"enter "}</span>
          <span style={{ fg: t.textMuted }}>{"send now"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"↑ "}</span>
          <span style={{ fg: t.textMuted }}>{"send"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"esc "}</span>
          <span style={{ fg: t.textMuted }}>{"cancel"}</span>
        </text>
      ) : (
        <text>
          <span style={{ fg: t.primary }}>{"enter "}</span>
          <span style={{ fg: t.textMuted }}>{"send next"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"↑ "}</span>
          <span style={{ fg: t.textMuted }}>{"select"}</span>
          <span style={{ fg: t.textDim }}>{" · "}</span>
          <span style={{ fg: t.primary }}>{"esc "}</span>
          <span style={{ fg: t.textMuted }}>{"cancel"}</span>
        </text>
      )}
    </box>
  );
}
