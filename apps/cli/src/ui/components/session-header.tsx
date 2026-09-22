import { useIcon } from "../../core/plugins";
import type { Theme } from "../theme";

export interface ModeInfo {
  id: string;
  label: string;
  color: string;
}

export function SessionHeader({
  t,
  modeInfo,
  sessionTitle,
  sessionId,
}: {
  t: Theme;
  modeInfo: ModeInfo;
  sessionTitle: string | null;
  sessionId: string | null;
}) {
  const sessionIcon = useIcon("session");
  return (
    <box flexShrink={0} width="100%">
      <box flexDirection="row" width="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <text>
          <span style={{ fg: modeInfo.color }}>
            <b>{modeInfo.label}</b>
          </span>
          {sessionTitle ? (
            <span style={{ fg: t.text }}>
              <b>
                {": "}
                {sessionIcon ? `${sessionIcon} ` : ""}
                {sessionTitle}
              </b>
            </span>
          ) : null}
        </text>
        <box flexGrow={1} />
        {sessionId ? <text fg={t.textDim}>{sessionId}</text> : null}
      </box>
    </box>
  );
}
