import type { Theme } from "../theme";

export function CopyFlashBanner({ t, width }: { t: Theme; width: number }) {
  return (
    <box
      position="absolute"
      left={0}
      top={1}
      width={width}
      zIndex={500}
      alignItems="center"
      flexShrink={0}
      backgroundColor={t.background}
      shouldFill={false}
    >
      <box
        height={3}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={t.queueBg}
        justifyContent="center"
        alignItems="center"
      >
        <text>
          <span style={{ fg: t.accent }}>{"✓ "}</span>
          <span style={{ fg: t.text }}>{"Copied to clipboard"}</span>
        </text>
      </box>
    </box>
  );
}
