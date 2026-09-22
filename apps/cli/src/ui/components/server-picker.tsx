// ServerPicker — "super simple" server selector. Lists discovered
// `codesurf node` servers plus Serverless (local). Click a row to attach the
// TUI as a wire front (teleport); the streaming plane + turn routing follow.

import { useServerMode } from "../context/server-mode-context.js";
import type { Theme } from "../theme";

export function ServerPicker({ t }: { t: Theme }) {
  const { remoteFront, attach, detach, detected, sessions, resume, closePicker } = useServerMode();

  const select = (url: string | null) => {
    if (url === null) {
      detach();
      closePicker();
      return;
    }
    void attach(url).then((f) => f && closePicker());
  };

  return (
    <box
      position="absolute"
      top={2}
      right={2}
      width={46}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={t.accent}
      backgroundColor="#1a1f2a"
      padding={1}
      alignSelf="flex-end"
    >
      <text fg={t.primary}>
        <b>{"Servers"}</b>
      </text>
      <box flexDirection="column" marginTop={1}>
        <box
          onMouseDown={() => select(null)}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={remoteFront ? undefined : "#2a3350"}
        >
          <text fg={remoteFront ? t.textDim : t.text}>{remoteFront ? "• serverless" : "● serverless"}</text>
        </box>
        {detected.map((s) => {
          const active = remoteFront?.url === s.url;
          return (
            <box
              key={s.url}
              onMouseDown={() => select(s.url)}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active ? "#2a3350" : undefined}
            >
              <text fg={active ? t.text : t.textMuted}>
                {active ? "●" : "•"} {`ws://${s.host}:${s.port}`}
              </text>
            </box>
          );
        })}
      </box>
      {remoteFront && sessions.length > 0 ? (
        <box flexDirection="column" marginTop={1} borderStyle="rounded" borderColor={t.textMuted} padding={1}>
          <text fg={t.primary}>
            <b>{"Sessions on node (" + sessions.length + ")"}</b>
          </text>
          {sessions.map((s) => (
            <box key={s.id} onMouseDown={() => void resume(remoteFront.url, s.id)} paddingLeft={1} paddingTop={1}>
              <text fg={s.finished ? t.textMuted : t.text}>
                {s.finished ? "● finished" : "○ active"} {s.id.slice(0, 28)}
              </text>
            </box>
          ))}
          <text fg={t.textDim} marginTop={1}>
            {"Click a session to resume it here."}
          </text>
        </box>
      ) : null}
      <text fg={t.textDim} marginTop={1}>
        {"Click a server to attach (or Serverless to detach). Close: "}
      </text>
    </box>
  );
}
