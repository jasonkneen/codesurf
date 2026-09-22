import type { Theme } from "./theme";

interface UpdateModalProps {
  t: Theme;
  width: number;
  height: number;
  currentVersion: string;
  latestVersion: string;
}

export function UpdateModal({ t, width, height, currentVersion, latestVersion }: UpdateModalProps) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(60, width - 6);
  const panelHeight = 9;
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
          <text fg="#f59e0b">
            <b>{"Update Available"}</b>
          </text>
          <text fg={t.textMuted}>{"esc to dismiss"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>
            {"A new version of grok is available: "}
            <span style={{ fg: t.textMuted }}>
              {"v"}
              {currentVersion}
            </span>
            {" → "}
            <span style={{ fg: "#22c55e" }}>
              {"v"}
              {latestVersion}
            </span>
          </text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>{"Press enter to update now, or esc to dismiss"}</text>
        </box>
      </box>
    </box>
  );
}
